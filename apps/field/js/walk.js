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

/* ---------- size rule (V0: no queue, no resumable upload yet) ---------- */
export const WALK_MAX_SECONDS = 180;
export const WALK_MAX_BYTES = 250e6;
export const OVERSIZE_MSG = "Split it by room — under 3 minutes per clip. Bigger clips come in V1.";
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
export const clipLabel = (row) => (row && row.room) || shortName(row && row.name) || "clip";
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
  if (!sv || !arr(sv.files).length) return false;
  const text = String(sv.transcript || "").trim();
  if (!text || sv.files.some((f) => f && f.transcript)) return false;
  const rec = sv.files.find((f) => f && f.kind === "audio");
  if (!rec) return false;
  rec.transcript = { utterances: [], text, seconds: Number(sv.transcriptSeconds) || 0, model: "", at: rec.at || "" };
  return true;
}

/** sv.transcript / sv.transcriptSeconds := derived from the rows. */
export function rebuildTranscript(sv) {
  adoptLegacyTranscript(sv);
  const r = transcriptFromFiles(sv && sv.files);
  sv.transcript = r.transcript;
  sv.transcriptSeconds = r.seconds;
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
