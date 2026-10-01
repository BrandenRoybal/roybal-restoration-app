/* ============================================================
   Roybal Field Forms — walk scope notes, the pure half
   ------------------------------------------------------------
   docs/Narrated_Walkthrough_Design.md §3 steps 7–8, §4.2, §5 (V2).

   ✨ Draft scope notes reads every transcribed walk clip (and its stills)
   and returns cited items per room: what was seen, materials, damage,
   spoken quantities, instructions, pre-existing conditions, what the
   homeowner said, things to verify, safety, trades (roybal-ai-office
   walkExtract). They land amber on the Site Visit panel; the owner taps
   ✓ / ✎ / ✕ on each. Only accepted notes go to the estimate draft, as the
   WALK SCOPE NOTES block, each under an [N#] id the draft cites in its
   basis — so an accepted instruction the draft never cited is listed as
   "said on the walk, not in this estimate".

   Stored on the job: sv.scopeNotes = { status 'draft'|'reviewed',
   generatedAt, model, fromClips:[clip row ids], rooms:[{ room, items:[{
   id:'N4', bucket, text, clipId, at, value?, unit?, trade?, cause?,
   state?:'accepted'|'rejected', edited?:true, checked?:true }] }] }.
   An item points at its clip by row id (clip numbers shift when a clip is
   removed); `checked` is the Bid card's Verify checkbox.

   No DOM, no network — Node-tested (test/scopenotes.test.mjs).
   ============================================================ */
import { walkRows, clipNumber, clipLabel, stillSecond, mmss } from "./walk.js";

const arr = (v) => (Array.isArray(v) ? v : []);

export const BUCKETS = {
  instructions:  { label: "Do",           tag: "INSTRUCTION" },
  observations:  { label: "Seen",         tag: "OBSERVED" },
  materials:     { label: "Material",     tag: "MATERIAL" },
  damage:        { label: "Damage",       tag: "DAMAGE" },
  quantities:    { label: "Qty",          tag: "QUANTITY (spoken)" },
  preExisting:   { label: "Pre-existing", tag: "PRE-EXISTING" },
  homeownerSaid: { label: "Homeowner",    tag: "HOMEOWNER SAID" },
  verify:        { label: "Verify",       tag: "VERIFY" },
  safety:        { label: "Safety",       tag: "SAFETY" },
  trades:        { label: "Trade",        tag: "TRADE" },
};
export const BUCKET_ORDER = Object.keys(BUCKETS);
export const MAX_STILLS = 60;   // the server's cap (walkextract.ts MAX_STILLS)

/* ---------- what the server reads ---------- */
const transcribed = (f) => f && f.kind === "walk" && f.transcript && (String(f.transcript.text || "").trim() || arr(f.transcript.utterances).length);

/** A clip's text with [m:ss] stamps: from its utterances when it has them,
    else the transcript text as it was stored. */
export function clipText(row) {
  const us = arr(row && row.transcript && row.transcript.utterances).filter((u) => u && String(u.text || "").trim());
  if (us.length) return us.map((u) => `[${mmss(Number(u.start) || 0)}] ${String(u.text).trim()}`).join("\n");
  return String((row && row.transcript && row.transcript.text) || "").trim();
}

/** Evenly thin a list down to `max`, keeping the first and the spread. */
export function spread(xs, max) {
  const list = arr(xs);
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, i) => list[Math.floor((i * list.length) / max)]);
}

/** The walkExtract request: every transcribed clip (numbered as the panel
    numbers them) and up to MAX_STILLS of their uploaded stills. */
export function extractInput(sv, project) {
  const files = arr(sv && sv.files);
  const rows = walkRows(files).filter(transcribed);
  const ids = new Set(rows.map((r) => r.id));
  const nOf = new Map(rows.map((r) => [r.id, clipNumber(files, r)]));
  const clips = rows.map((r) => ({
    n: nOf.get(r.id), room: r.room || "",
    seconds: Number(r.duration) || Number(r.transcript && r.transcript.seconds) || 0,
    text: clipText(r),
  }));
  const stills = spread(files.filter((f) => f && f.kind === "frames" && ids.has(f.videoId) && f.path && !f.queued && stillSecond(f) != null), MAX_STILLS)
    .map((f) => ({ path: f.path, clip: nOf.get(f.videoId), at: stillSecond(f), caption: f.caption || "" }));
  const jobKind = project && project.jobType === "construction" ? "construction" : "claim";   // model.js jobType()
  return { jobKind, rooms: arr(project && project.rooms).filter((r) => typeof r === "string" && r.trim()), clips, stills };
}

/** True when ✨ Draft scope notes has something to read. */
export const canExtract = (sv) => walkRows(arr(sv && sv.files)).some(transcribed);
/** Clips that landed but aren't transcribed yet — the button waits for them. */
export const untranscribed = (sv) => walkRows(arr(sv && sv.files)).filter((f) => !transcribed(f)).length;

/* ---------- adopting the result ---------- */
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const sameItem = (a, b) => a.bucket === b.bucket && a.clipId === b.clipId && Math.abs((Number(a.at) || 0) - (Number(b.at) || 0)) < 1.5 && norm(a.origText || a.text) === norm(b.text);

/** Write a walkExtract result onto the visit. Clip numbers become row ids;
    an item the owner already reviewed on an earlier run keeps its id, its
    decision and his edit. Returns the counts for the toast. */
export function adoptScopeNotes(sv, result, at = new Date().toISOString()) {
  const files = arr(sv.files);
  const idOfN = new Map(walkRows(files).map((r) => [clipNumber(files, r), r.id]));
  const prev = allItems(sv);
  let nextN = Math.max(0, ...prev.map((it) => Number(String(it.id).slice(1)) || 0)) + 1;
  const rooms = [];
  let kept = 0, fresh = 0;
  for (const r of arr(result && result.rooms)) {
    const items = [];
    for (const it of arr(r && r.items)) {
      const clipId = idOfN.get(Number(it.clip));
      if (!clipId || !BUCKETS[it.bucket]) continue;
      const base = { bucket: it.bucket, text: String(it.text || ""), clipId, at: Number(it.at) || 0 };
      for (const k of ["value", "unit", "trade", "cause"]) if (it[k] != null && it[k] !== "") base[k] = it[k];
      const old = prev.find((p) => sameItem(p, base));
      if (old && old.state) {
        items.push({ ...base, id: old.id, state: old.state, ...(old.edited ? { edited: true, text: old.text, origText: old.origText || base.text } : {}), ...(old.checked ? { checked: true } : {}) });
        kept++;
      } else {
        items.push({ ...base, id: "N" + nextN++ });
        fresh++;
      }
    }
    if (items.length) rooms.push({ room: String((r && r.room) || "Main Level"), items });
  }
  sv.scopeNotes = {
    status: "draft", generatedAt: at, model: String((result && result.model) || ""),
    fromClips: arr(result && result.fromClips).map((n) => idOfN.get(Number(n))).filter(Boolean),
    rooms,
  };
  settleStatus(sv);
  return { items: kept + fresh, kept, fresh, rooms: rooms.length };
}

/* ---------- review ---------- */
export function allItems(sv) {
  return arr(sv && sv.scopeNotes && sv.scopeNotes.rooms).flatMap((r) => arr(r && r.items));
}
export const findItem = (sv, id) => allItems(sv).find((it) => it.id === id) || null;
function settleStatus(sv) {
  if (!sv.scopeNotes) return;
  const items = allItems(sv);
  sv.scopeNotes.status = items.length && items.every((it) => it.state) ? "reviewed" : "draft";
}
/** ✓ accepted, ✕ rejected, or null to put it back to unreviewed. */
export function setItemState(sv, id, state) {
  const it = findItem(sv, id);
  if (!it) return false;
  if (state) it.state = state; else delete it.state;
  settleStatus(sv);
  return true;
}
/** ✎ — the owner's wording replaces the note's, and editing accepts it. */
export function editItem(sv, id, text) {
  const it = findItem(sv, id);
  const t = String(text || "").trim();
  if (!it || !t) return false;
  if (t !== it.text) { if (!it.edited) it.origText = it.text; it.text = t; it.edited = true; }
  it.state = "accepted";
  settleStatus(sv);
  return true;
}
/** ✓ Accept the rest: every unreviewed item, accepted. */
export function acceptAll(sv) {
  let n = 0;
  for (const it of allItems(sv)) if (!it.state) { it.state = "accepted"; n++; }
  settleStatus(sv);
  return n;
}
/** The Bid card's Verify checkbox. */
export function checkVerify(sv, id, on) {
  const it = findItem(sv, id);
  if (!it || it.bucket !== "verify") return false;
  if (on) it.checked = true; else delete it.checked;
  return true;
}

/** Counts for the panel header and the Bid card's Packet line. */
export function scopeCounts(sv) {
  const items = allItems(sv);
  const verify = items.filter((it) => it.bucket === "verify" && it.state !== "rejected" && !it.checked);
  return {
    items: items.length,
    open: items.filter((it) => !it.state).length,
    accepted: items.filter((it) => it.state === "accepted").length,
    verify: verify.length,
    verifyItems: verify.map((it) => ({ id: it.id, text: it.text })),
  };
}

/* ---------- where an item came from ---------- */
/** "walk Kitchen 0:12" — the clip's room (or Clip n) and the second. */
export function citeOf(sv, it) {
  const files = arr(sv && sv.files);
  const row = files.find((f) => f && f.id === it.clipId);
  if (!row) return `walk ${mmss(Number(it.at) || 0)}`;
  const label = row.room ? clipLabel(row) : `Clip ${clipNumber(files, row)}`;
  return `walk ${label} ${mmss(Number(it.at) || 0)}`;
}

/** The WALK SCOPE NOTES block the draft reads: accepted notes only, by room,
    each under its [N#] id. "" when nothing is accepted. */
export function scopeNotesText(sv) {
  const out = [];
  for (const r of arr(sv && sv.scopeNotes && sv.scopeNotes.rooms)) {
    const items = arr(r.items).filter((it) => it.state === "accepted")
      .sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket));
    if (!items.length) continue;
    out.push(r.room);
    for (const it of items) {
      const qty = it.bucket === "quantities" && it.value != null ? ` = ${it.value}${it.unit ? " " + it.unit : ""}` : "";
      const extra = it.trade ? ` (${it.trade})` : it.cause ? ` (cause: ${it.cause})` : "";
      out.push(`[${it.id}] ${BUCKETS[it.bucket].tag}: ${it.text}${qty}${extra} (${citeOf(sv, it)})`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

/** "Use as typed scope": the accepted instructions, quantities and trades,
    as lines the owner can edit in the typed scope box. */
export function typedScopeFromNotes(sv) {
  const keep = ["instructions", "quantities", "trades"];
  const out = [];
  for (const r of arr(sv && sv.scopeNotes && sv.scopeNotes.rooms)) {
    const items = arr(r.items).filter((it) => it.state === "accepted" && keep.includes(it.bucket));
    if (!items.length) continue;
    out.push(r.room + ":");
    for (const it of items) out.push("- " + it.text + (it.bucket === "quantities" && it.value != null ? ` (${it.value}${it.unit ? " " + it.unit : ""})` : ""));
  }
  return out.join("\n");
}

/** Accepted instructions the draft never cited by id — "said on the walk,
    not in this estimate". `texts` is every basis and question of the draft. */
export function uncoveredInstructions(sv, texts) {
  const hay = arr(texts).map((t) => String(t || "")).join("\n");
  return allItems(sv)
    .filter((it) => it.bucket === "instructions" && it.state === "accepted")
    .filter((it) => !new RegExp(`\\[${it.id}\\]|\\b${it.id}\\b`).test(hay))
    .map((it) => ({ id: it.id, text: it.text, cite: citeOf(sv, it) }));
}
