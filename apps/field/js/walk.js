/* ============================================================
   Roybal Field Forms — narrated walk clips, the pure half
   ------------------------------------------------------------
   docs/Narrated_Walkthrough_Design.md §3 steps 3–6, §4.1, §7.

   A walk clip (kind:'walk') is one thing: a phone video the owner narrates,
   one per room, a minute or three long. From it the packet gets stills
   (pulled in the browser, like the silent Magicplan clips) AND a
   timestamped transcript (Deepgram, via roybal-ai-office). Everything that
   joins the two lives here, with no DOM and no network, so it is Node-tested
   (test/walk.test.mjs):

     - how many stills a clip yields and when they are taken;
     - the room, read from whatever was said in the first five seconds —
       matched against the job's rooms, then the Magicplan room names, then
       a short lexicon; never guessed;
     - the quote a still carries: the words spoken within ±6 s of it;
     - the flat transcript the estimate draft reads (sv.transcript), rebuilt
       from every clip in capture order under a "— Clip n · Room · m:ss —"
       header, so the draft can cite `walk Kitchen 02:14`.

   sitevisit.js re-exports the frame helpers that moved here so its callers
   and tests are unchanged.
   ============================================================ */
import { dedupeRoomNames } from "./magicplancalc.js";

const arr = (v) => (Array.isArray(v) ? v : []);

/* ---------- stills: when to take them ----------
   Magicplan room videos are short and silent, and the model reads images,
   not video. Each clip becomes a handful of evenly spaced still frames
   (never the first or last instant, which are often blurred). */
export const FRAMES_PER_VIDEO = 8;
export function frameTimes(duration, max = FRAMES_PER_VIDEO) {
  const d = Number(duration);
  if (!(d > 0) || !isFinite(d)) return [];
  const n = Math.max(1, Math.min(max, Math.ceil(d / 2)));   // at most one frame every ~2 s
  return Array.from({ length: n }, (_, i) => Math.round((d * (i + 0.5) / n) * 100) / 100);
}
export const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export function frameCaption(videoName, t, source = "Magicplan video") {
  return `still at ${mmss(t)} from ${source} ${videoName || "clip"}`;
}

/* A narrated clip is longer and every ten seconds or so shows something
   new: 8 stills up to 80 s, then one per 10 s, never more than 24. */
export function stillCount(duration) {
  const d = Number(duration);
  if (!(d > 0) || !isFinite(d)) return 0;
  return Math.max(8, Math.min(24, Math.floor(d / 10)));
}
export function stillTimes(duration) {
  const d = Number(duration);
  const n = stillCount(d);
  return Array.from({ length: n }, (_, i) => Math.round((d * (i + 0.5) / n) * 100) / 100);
}

/* ---------- size rule (V1: queued, resumable uploads) ----------
   The hard limits are what the queue will carry; the soft one is what
   makes good scope notes — one room, one to three minutes. */
export const WALK_MAX_SECONDS = 900;      // 15 minutes
export const WALK_MAX_BYTES = 1e9;        // 1 GB (the Storage project limit was raised to match)
export const OVERSIZE_MSG = "That clip is over the limit (15 minutes / 1 GB). Split it by room — one room per clip.";
export const LONG_CLIP_SECONDS = 180;
export const LONG_CLIP_NOTE = "Shorter clips make better scope notes — under 3 minutes per room is the sweet spot.";
/** An unknown duration is not a refusal (the still puller decides then). */
export function clipTooBig(duration, size) {
  const d = Number(duration);
  return (isFinite(d) && d > WALK_MAX_SECONDS) || Number(size) > WALK_MAX_BYTES;
}

/* ---------- the room, from the opening words (§7 rule 1) ---------- */
export const ROOM_LEXICON = [
  { room: "Kitchen", say: ["kitchen"] },
  { room: "Bathroom", say: ["bathroom", "bath"] },
  { room: "Bedroom", say: ["bedroom"] },
  { room: "Living room", say: ["living room", "living"] },
  { room: "Dining room", say: ["dining room", "dining"] },
  { room: "Hallway", say: ["hallway", "hall"] },
  { room: "Utility", say: ["utility room", "utility"] },
  { room: "Laundry", say: ["laundry room", "laundry"] },
  { room: "Garage", say: ["garage"] },
  { room: "Basement", say: ["basement"] },
  { room: "Crawlspace", say: ["crawlspace", "crawl space"] },
  { room: "Attic", say: ["attic"] },
  { room: "Arctic entry", say: ["arctic entry"] },
  { room: "Entry", say: ["entry", "entryway"] },
  { room: "Mudroom", say: ["mudroom", "mud room"] },
  { room: "Office", say: ["office"] },
  { room: "Closet", say: ["closet"] },
  { room: "Stairs", say: ["stairs", "stairway", "stairwell"] },
  { room: "Exterior", say: ["exterior", "outside"] },
  { room: "Roof", say: ["roof"] },
];
export const normalizeSpeech = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

/** What was said in the first `seconds` of the clip — or, when nothing
    started that early (a second of silence, a long first sentence), the
    first utterance alone. */
export function openingText(utterances, seconds = 5) {
  const us = arr(utterances).filter((u) => u && String(u.text || "").trim());
  if (!us.length) return "";
  const early = us.filter((u) => (Number(u.start) || 0) < seconds);
  return (early.length ? early : [us[0]]).map((u) => String(u.text).trim()).join(" ");
}

/* One pass over a list of names: the one spoken EARLIEST wins, a longer
   name wins a tie ("bedroom 2" over "bedroom"). `wholeWord` keeps "office"
   from matching "officer" in the lexicon; the job's own room names match
   as substrings ("bath" finds "bathroom"), as the brief rules. */
function firstSpoken(text, names, wholeWord) {
  let best = null;
  for (const n of names) {
    const key = normalizeSpeech(n.say);
    if (!key) continue;
    const re = new RegExp((wholeWord ? "\\b" : "") + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (wholeWord ? "\\b" : ""));
    const m = re.exec(text);
    if (!m) continue;
    if (!best || m.index < best.at || (m.index === best.at && key.length > best.len)) best = { at: m.index, len: key.length, room: n.room };
  }
  return best ? best.room : null;
}

/** The room a clip belongs to, or null when the speaker didn't name one
    (the UI then shows "Clip n" with an editable Room field). Never guesses. */
export function roomFromOpening(utterances, { rooms = [], magicplanRooms = [], lexicon = ROOM_LEXICON } = {}) {
  const text = normalizeSpeech(openingText(utterances));
  if (!text) return null;
  const named = (xs) => arr(xs).filter((r) => typeof r === "string" && r.trim()).map((r) => ({ room: r, say: r }));
  return firstSpoken(text, named(rooms), false)
    || firstSpoken(text, named(magicplanRooms), false)
    || firstSpoken(text, arr(lexicon).flatMap((l) => arr(l.say).map((s) => ({ room: l.room, say: s }))), true)
    || null;
}

/** Room labels from an adopted Magicplan scan, when the visit has one. */
export function magicplanRoomNames(sv) {
  const stats = sv && sv.magicplan && sv.magicplan.statistics;
  return stats && typeof stats === "object" ? dedupeRoomNames(stats.floors).map((r) => r.label) : [];
}

/* ---------- stills carry the words spoken around them (§3 step 6) ---------- */
const QUOTE_MAX = 200;
/** The utterances overlapping [t−w, t+w], joined and bounded; "" when none. */
export function captionForStill(t, utterances, windowSec = 6) {
  const at = Number(t);
  if (!isFinite(at)) return "";
  const hit = arr(utterances).filter((u) => {
    if (!u || !String(u.text || "").trim()) return false;
    const s = Number(u.start) || 0;
    const e = isFinite(Number(u.end)) ? Math.max(s, Number(u.end)) : s;
    return s <= at + windowSec && e >= at - windowSec;
  });
  let q = hit.map((u) => String(u.text).trim()).join(" ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  if (q.length > QUOTE_MAX) {
    const cut = q.slice(0, QUOTE_MAX);
    const sp = cut.lastIndexOf(" ");
    q = (sp > QUOTE_MAX / 2 ? cut.slice(0, sp) : cut).trim() + "…";
  }
  return q;
}
/** `caption · "quote"` — replacing any quote already there, so re-running
    after a transcript arrives (or is edited) is idempotent. */
export function withQuote(caption, quote) {
  const base = String(caption || "").replace(/ · "[^"]*"$/, "");
  return quote ? `${base} · "${quote}"` : base;
}
/** The second a still was taken, from its row name ("Kitchen.mov @ 12s"). */
export function stillSecond(f) {
  const m = /@ (\d+)s$/.exec(String((f && f.name) || ""));
  return m ? Number(m[1]) : null;
}
const shortName = (s) => { const n = String(s || "").trim(); return n.length > 40 ? n.slice(0, 39) + "…" : n; };
/** What a walk still is captioned from: the room when known, else the clip name. */
export const clipLabel = (row) => shortName(row && row.room) || shortName(row && row.name) || "clip";
/** Rewrite the captions of one clip's stills from its transcript. Returns
    how many were written; idempotent; other clips' stills are untouched. */
export function captionStills(sv, row) {
  if (!sv || !row) return 0;
  const utts = row.transcript && arr(row.transcript.utterances);
  let n = 0;
  for (const f of arr(sv.files)) {
    if (!f || f.kind !== "frames" || f.videoId !== row.id) continue;
    const t = stillSecond(f);
    if (t == null) continue;
    f.caption = withQuote(frameCaption(clipLabel(row), t, "walk clip"), captionForStill(t, utts));
    n++;
  }
  return n;
}

/* ---------- the flat transcript the draft reads (§3 step 5) ---------- */
const TRANSCRIBED = ["walk", "audio", "meeting"];
const byAt = (a, b) => (String(a.at || "") < String(b.at || "") ? -1 : String(a.at || "") > String(b.at || "") ? 1 : 0);
export const clipHeader = (n, room, seconds) => `— Clip ${n} · ${room || "Clip " + n} · ${mmss(Number(seconds) || 0)} —`;

/** Every transcribed recording in capture order, each under its header. */
export function transcriptFromFiles(files) {
  const rows = arr(files)
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f && TRANSCRIBED.includes(f.kind) && f.transcript && String(f.transcript.text || "").trim())
    .sort((a, b) => byAt(a.f, b.f) || a.i - b.i)
    .map(({ f }) => f);
  const clips = rows.map((r, i) => ({ id: r.id, n: i + 1, room: r.room || "", seconds: Number(r.transcript.seconds) || 0 }));
  const transcript = rows.map((r, i) => clipHeader(i + 1, r.room, r.transcript.seconds) + "\n" + String(r.transcript.text).trim()).join("\n\n");
  return { transcript, seconds: clips.reduce((t, c) => t + c.seconds, 0), clips };
}

/** A visit transcribed before walk clips existed holds its text only on
    sv.transcript. Move it onto the recording's row once, so the flat text
    can be derived from rows from then on. True when it did something. */
export function adoptLegacyTranscript(sv) {
  if (!sv || !arr(sv.files).length || sv.transcriptDerived) return false;   // derived text is never legacy
  const text = String(sv.transcript || "").trim();
  if (!text || sv.files.some((f) => f && f.transcript)) return false;
  const rec = sv.files.find((f) => f && f.kind === "audio");
  if (!rec) return false;
  rec.transcript = { utterances: [], text, seconds: Number(sv.transcriptSeconds) || 0, model: "", at: rec.at || "" };
  sv.transcriptDerived = true;
  return true;
}

/** sv.transcript / sv.transcriptSeconds := derived from the rows. From the
    first rebuild on, sv.transcriptDerived marks the text as a copy of the
    rows, so replacing a recording or deleting the last transcribed clip can
    never graft stale text onto an untranscribed row. */
export function rebuildTranscript(sv) {
  adoptLegacyTranscript(sv);
  const r = transcriptFromFiles(sv && sv.files);
  sv.transcript = r.transcript;
  sv.transcriptSeconds = r.seconds;
  sv.transcriptDerived = true;
  return r;
}

/** Walk rows in capture order — the "Clip n" numbering the panel shows,
    which counts every clip, transcribed or not. */
export function walkRows(files) {
  return arr(files).map((f, i) => ({ f, i })).filter(({ f }) => f && f.kind === "walk").sort((a, b) => byAt(a.f, b.f) || a.i - b.i).map(({ f }) => f);
}
export function clipNumber(files, row) {
  return walkRows(files).findIndex((f) => f === row || (row && f.id === row.id)) + 1;
}

/** "4 clips · 11 min" — the Bid card's Packet line and the slot header. */
export function walkSummary(files) {
  const rows = walkRows(files);
  return {
    clips: rows.length,
    seconds: rows.reduce((t, f) => t + (Number(f.duration) || 0), 0),
    stills: rows.reduce((t, f) => t + (Number(f.frames) || 0), 0),
  };
}

/* ============================================================
   V2 — scope notes: the reviewable middle layer (design §4.2, §3 steps 7–10)
   ------------------------------------------------------------
   walkExtract runs once per clip on the server and returns that clip's
   notes (rooms[] + jobWide, every item {text, clip, at, …}). Everything
   below is pure: what to send for a clip, the cache key that says a clip's
   notes are current, the merge into siteVisit.scopeNotes, the review state
   (accepted / edited / used / verified, keyed per item), the typed-scope
   text a room turns into, the block the draft reads, and the conservative
   "not in estimate" comparison.
   ============================================================ */
export const NOTE_BUCKETS = ["observations", "materials", "damage", "quantities", "instructions", "preExisting", "homeownerSaid", "verify", "safety", "trades"];
export const BUCKET_LABEL = {
  observations: "Observed", materials: "Materials", damage: "Damage", quantities: "Quantities (spoken)", instructions: "Instructions",
  preExisting: "Pre-existing", homeownerSaid: "Homeowner said", verify: "Verify", safety: "Safety", trades: "Trades needed",
};
export const MAX_EXTRACT_STILLS = 24;

/** djb2 of the transcript text — the "is this clip's extraction current" half of the cache key. */
export function textHash(s) {
  let h = 5381;
  const t = String(s || "");
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** id + transcript hash: re-running after a clip is added extracts one clip, not four. */
export const clipKey = (row) => `${row && row.id}:${textHash(row && row.transcript && row.transcript.text)}`;

/** Clips that have a transcript and whose notes are missing or stale. */
export function clipsToExtract(sv) {
  const done = new Set(arr(sv && sv.scopeNotes && sv.scopeNotes.fromClips));
  return walkRows(sv && sv.files).filter((f) => f.transcript && String(f.transcript.text || "").trim() && !done.has(clipKey(f)));
}

/** The walkExtract input for one clip (design §6): its utterances, its
    uploaded stills with the caption and second, the room names, the job kind. */
export function extractInputFor(sv, row, { rooms = [], jobKind = "claim" } = {}) {
  const stills = arr(sv && sv.files)
    .filter((f) => f && f.kind === "frames" && f.videoId === row.id && f.path && !f.queued)
    .map((f) => ({ path: f.path, caption: String(f.caption || ""), t: stillSecond(f), mime: f.mime || "image/jpeg" }))
    .filter((s) => s.t != null)
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_EXTRACT_STILLS);
  return {
    clip: { id: row.id, room: String(row.room || ""), utterances: arr(row.transcript && row.transcript.utterances) },
    stills, rooms: arr(rooms), magicplanRooms: magicplanRoomNames(sv), jobKind,
  };
}

/* ---------- keys: one per item, stable across re-runs ---------- */
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export const itemKey = (it, bucket) => `${it.clip}:${bucket}:${Math.round((Number(it.at) || 0) * 10) / 10}:${slug(it.text)}`;

const emptyRoom = (room) => { const r = { room }; for (const b of NOTE_BUCKETS) r[b] = []; return r; };
const normRoom = (s) => String(s || "").trim().toLowerCase();

/** Merge per-clip notes into siteVisit.scopeNotes. Rooms merge by name
    (case-insensitive); items keep their clip citation; the review state
    (accepted / edited / used / verified) survives a re-run because it is
    keyed by item, and stale clips' items fall away with their key. */
export function mergeScopeNotes(perClip, { prior = null, at = new Date().toISOString(), model = "" } = {}) {
  const rooms = new Map();
  const jobWide = emptyRoom("");
  const keys = new Set();
  const fromClips = [];
  for (const c of arr(perClip)) {
    if (!c || !c.notes) continue;
    fromClips.push(c.key);
    const put = (target, r) => { for (const b of NOTE_BUCKETS) for (const it of arr(r[b])) { if (!it || !it.text || !it.clip || !Number.isFinite(Number(it.at))) continue; target[b].push({ ...it }); keys.add(itemKey(it, b)); } };
    for (const r of arr(c.notes.rooms)) {
      const k = normRoom(r.room);
      if (!k) { put(jobWide, r); continue; }
      if (!rooms.has(k)) rooms.set(k, emptyRoom(String(r.room).trim()));
      put(rooms.get(k), r);
    }
    if (c.notes.jobWide) put(jobWide, c.notes.jobWide);
  }
  const keep = (m) => { const out = {}; for (const [k, v] of Object.entries(m || {})) if (keys.has(k)) out[k] = v; return out; };
  const p = prior && typeof prior === "object" ? prior : {};
  return {
    status: "draft", generatedAt: at, model, fromClips,
    rooms: [...rooms.values()], jobWide,
    accepted: keep(p.accepted), edited: keep(p.edited), used: keep(p.used), verified: keep(p.verified),
  };
}

/** Every item with its room, bucket and key — the review surface's flat list. */
export function noteItems(sn) {
  const out = [];
  if (!sn) return out;
  const one = (r) => { for (const b of NOTE_BUCKETS) for (const it of arr(r[b])) out.push({ ...it, room: r.room || "", bucket: b, key: itemKey(it, b) }); };
  for (const r of arr(sn.rooms)) one(r);
  if (sn.jobWide) one(sn.jobWide);
  return out.map((it) => ({ ...it, text: (sn.edited && sn.edited[it.key]) || it.text }));
}
export const isAccepted = (sn, key) => !!(sn && sn.accepted && sn.accepted[key] === true);
export const isDropped = (sn, key) => !!(sn && sn.accepted && sn.accepted[key] === false);

/** "3 clips · 14 notes · 5 accepted · 2 to verify" for the panel and the Bid card. */
export function scopeNotesSummary(sn) {
  const items = noteItems(sn);
  const accepted = items.filter((it) => isAccepted(sn, it.key)).length;
  const toVerify = openVerify(sn).length;
  return { items: items.length, accepted, toVerify, clips: arr(sn && sn.fromClips).length, reviewed: !!sn && items.length > 0 && items.every((it) => isAccepted(sn, it.key) || isDropped(sn, it.key)) };
}

/** Verify items still open — not dropped, not checked off — the Bid card's
    Verify line (an amber, unreviewed one still needs looking at). */
export function openVerify(sn) {
  return noteItems(sn).filter((it) => it.bucket === "verify" && !isDropped(sn, it.key) && !(sn.verified && sn.verified[it.key]));
}

/** "walk Kitchen 2:14" — how a note is cited everywhere (matches the transcript header the draft sees). */
export const cite = (it) => `walk ${it.room || "job-wide"} ${mmss(Number(it.at) || 0)}`;
const lineFor = (it) => {
  const t = it.bucket === "homeownerSaid" && !/^homeowner/i.test(it.text) ? "Homeowner: " + it.text : it.bucket === "verify" ? "Verify: " + it.text : it.bucket === "trades" && it.trade ? `${it.trade}: ${it.text}` : it.text;
  return `- ${t} [${cite(it)}]`;
};

/** The accepted, not-yet-used items of one room as typed-scope Markdown
    under a "## Room" heading; the keys it used, so the caller can mark them. */
export function typedScopeFromRoom(sn, room) {
  const items = noteItems(sn).filter((it) => normRoom(it.room) === normRoom(room) && isAccepted(sn, it.key) && !(sn.used && sn.used[it.key]));
  if (!items.length) return { text: "", keys: [] };
  return { text: `## ${room || "Job-wide"}\n` + items.map(lineFor).join("\n"), keys: items.map((it) => it.key) };
}

/** The WALK SCOPE NOTES block the draft reads: accepted items not already
    carried into the typed scope, room by room, each cited. "" when none. */
export function walkScopeNotesText(sn) {
  const items = noteItems(sn).filter((it) => isAccepted(sn, it.key) && !(sn.used && sn.used[it.key]));
  if (!items.length) return "";
  const byRoom = new Map();
  for (const it of items) { const k = it.room || ""; if (!byRoom.has(k)) byRoom.set(k, []); byRoom.get(k).push(it); }
  return [...byRoom.entries()].map(([room, xs]) => `## ${room || "Job-wide"}\n` + xs.map(lineFor).join("\n")).join("\n\n");
}

/* ---------- "Not in estimate": accepted instructions and trades with no matching line ----------
   Conservative on purpose: a line matches when it is in the same room (or
   the note is job-wide) and shares at least two meaningful words with the
   note (three-letter stopwords and shorter dropped), or the trade name
   appears in the line. Anything that matches is left alone. */
const STOP = new Set(["the", "and", "that", "this", "with", "from", "into", "over", "under", "them", "then", "take", "goes", "get", "put", "back", "out", "off", "its", "it's", "there", "here", "have", "has", "some", "just", "also", "will", "should", "about", "around", "need", "needs", "make", "sure", "want", "going", "gonna", "everything", "anything", "whole", "entire"]);
const NUMBERS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
const words = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").split(" ")
  .map((w) => NUMBERS[w] || w)
  .filter((w) => (w.length >= 4 || /^\d+$/.test(w)) && !STOP.has(w))
  .map((w) => w.replace(/(ing|ed|es|s)$/, "")));
/** True when the estimate line plausibly covers the note: the trade is named
    in the line, or the two share meaningful words — one is enough for a short
    note, two for a longer one. Lenient by design: a doubtful case is "covered". */
export function lineMatches(note, line) {
  const desc = `${line.desc || ""} ${line.notes || ""}`;
  if (note.trade && desc.toLowerCase().includes(String(note.trade).toLowerCase())) return true;
  const a = words(note.text), b = words(desc);
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits >= (a.size <= 3 ? 1 : 2);
}
export function missingLines(sn, estimateItems) {
  const lines = arr(estimateItems).filter((li) => li && String(li.desc || "").trim());
  return noteItems(sn)
    .filter((it) => (it.bucket === "instructions" || it.bucket === "trades") && isAccepted(sn, it.key))
    .filter((it) => !lines.some((li) => (!it.room || normRoom(li.room) === normRoom(it.room) || !String(li.room || "").trim()) && lineMatches(it, li)));
}
