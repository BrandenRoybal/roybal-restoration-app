/* ============================================================
   Roybal Field Forms — meter photos on moisture readings
   ------------------------------------------------------------
   The tech photographs the moisture meter's screen beside a reading on
   the Moisture Map. The photo is the evidence and is always kept; the
   number the reader (roybal-ai-office meterRead) sees on it is only ever
   a prefill a person confirms — the typed value is the reading (doc 03
   §6.15, "prefill, never commit").

   Where they live: project.meterPhotos[], a top-level id collection
   (merge.js ID_COLLECTIONS, and the server twin from migration 0024).
   NOT nested on the map: a moistureMaps element merges whole (the newer
   device's copy wins), so a photo inside it would vanish whenever another
   device's newer copy of the map won. A top-level element with its own id
   survives every merge. NOT in project.photos[] either: those feed the
   gallery, Photo Report, share link, AI captions and the caption gate.

     { id, by, ts,                 who took it, when (the device clock)
       dev,                        the install that took it: only it asks the
                                   reader, so two devices never read (and
                                   bill, and fill) the same photo
       mapId, rowKey, loc,         the cell: map id, the row's `rk`, 0-based column
       date,                       the row's date when taken (finds the row
                                   when its rk was lost, and labels a photo
                                   whose row is gone)
       src,                        data:image/jpeg — offloaded to field-media on push
       read,                       null until the reader answers, then
                                   { at, model, fill, device, readable, value,
                                     unit, mode, confidence, note }
       filled,                     the value the reader put in an EMPTY cell ("" if none)
       ok,                         ISO when the tech confirmed or typed over it
       fixed }                     the number the tech typed over a prefill

   `read` and `ok` only ever go from empty to set on one photo (a retake is
   a new photo), so the merge keeps whichever copy has them (merge.js, and
   the SQL twin in 0024): a newer copy of the job that was saved before the
   read landed can't undo it.

   The row key is `rk`, never `id`: merge.js unions arrays whose elements
   all carry an id, which would one day let deleted reading dates come back.
   New rows get one when they are made (model.js blankReadingRow); a row
   from before this feature gets one when its first photo is taken.

   Pure — no DOM, no network (meterui.js does both). Tested by
   test/meterphotos.test.mjs.
   ============================================================ */
import { uid } from "./core.js";
import { author } from "./model.js";
import { tombstoneItems, DELETED_IDS } from "./merge.js";

export const METER_KEY = "meterPhotos";
/* An LCD fills much of the frame when the tech holds the phone at the
   meter, so a much smaller image than a job photo (1600 px) still reads,
   and every device that syncs the job downloads every one of these in
   full (job photos get small previews; these don't). ~40-60 KB each. */
export const METER_MAX_DIM = 800;
export const METER_QUALITY = 0.5;
/* below this the reader's number is never offered as a prefill */
export const FILL_MIN = 0.7;

const LOCAL_IMG = /^data:image\/(jpeg|png|webp);base64,/;
const nowIso = () => new Date().toISOString();
const blank = (v) => v == null || String(v).trim() === "";

export function meterList(project) {
  return project && Array.isArray(project[METER_KEY]) ? project[METER_KEY] : [];
}
function ensureList(project) {
  if (!Array.isArray(project[METER_KEY])) project[METER_KEY] = [];
  return project[METER_KEY];
}

/** The row's stable key, assigned the first time a photo is attached. */
export function rowKeyOf(row) {
  if (!row.rk) row.rk = uid();
  return row.rk;
}

/** The photo bytes are on this device (not a media marker still to sync). */
export const isLocalImage = (src) => LOCAL_IMG.test(String(src || ""));

/** Two readings are the same number ("17.40" = "17.4", "17,4" = "17.4"). */
export function sameReading(a, b) {
  const s = (v) => String(v ?? "").trim().replace(",", ".");
  const x = s(a), y = s(b);
  if (x === "" || y === "") return x === y;
  const nx = Number(x), ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? nx === ny : x === y;
}

/** The reading row a photo belongs to: the row carrying its rk, else —
    when another device's copy of the map won without that rk (a row from
    before rk, keyed on two devices at once) — the one row on the map with
    the photo's date. null when there is no such row (or more than one). */
export function rowFor(map, ph) {
  const rows = (map && Array.isArray(map.readings)) ? map.readings : [];
  if (!ph) return null;
  const byKey = ph.rowKey ? rows.find((r) => r && r.rk === ph.rowKey) : null;
  if (byKey) return byKey;
  if (!ph.date) return null;
  const same = rows.filter((r) => r && r.date === ph.date);
  return same.length === 1 ? same[0] : null;
}

/** One map's photos by row OBJECT then location (the newest photo wins a
    cell), plus the photos whose row is gone. */
export function mapIndex(project, map) {
  const byRow = new Map(), orphans = [];
  for (const p of meterList(project)) {
    if (!p || !map || p.mapId !== map.id) continue;
    const row = rowFor(map, p);
    if (!row) { orphans.push(p); continue; }
    let cells = byRow.get(row);
    if (!cells) byRow.set(row, (cells = new Map()));
    const have = cells.get(p.loc);
    if (!have || String(p.ts || "") > String(have.ts || "")) cells.set(p.loc, p);
  }
  return { byRow, orphans };
}

/** The photo on this cell, or null. */
export function photoAt(project, map, row, loc) {
  if (!row) return null;
  const cells = mapIndex(project, map).byRow.get(row);
  return (cells && cells.get(loc)) || null;
}

function findRow(project, ph) {
  const map = (project.moistureMaps || []).find((m) => m && m.id === ph.mapId);
  return { map, row: map ? rowFor(map, ph) : null };
}

/* A photo removed while its prefill was never confirmed takes the number
   out with it — if the cell still holds exactly what the reader put there.
   Otherwise an unchecked AI number would stay behind looking typed. */
function dropPrefill(project, ph) {
  if (!ph || !ph.filled || ph.ok) return false;
  const { row } = findRow(project, ph);
  if (!row || !Array.isArray(row.values) || !sameReading(row.values[ph.loc], ph.filled)) return false;
  row.values[ph.loc] = "";
  return true;
}

/** Attach a photo to one cell. A photo already on that cell is replaced
    (a retake) and its delete recorded so it stays gone on every device;
    an unconfirmed number it filled in goes with it, so the new photo's
    read can fill the cell afresh. `dev` is this install's tag. */
export function addMeterPhoto(project, map, row, loc, src, dev = "") {
  const list = ensureList(project);
  const rowKey = rowKeyOf(row);
  const old = list.filter((p) => p && p.mapId === map.id && p.loc === loc && rowFor(map, p) === row).map((p) => p.id);
  if (old.length) {
    // Only the photo the cell shows may take its number out with it. An
    // older photo on the cell (two phones, offline) was superseded: the
    // number there now is someone else's, typed or read from the newer one.
    const shown = photoAt(project, map, row, loc);
    for (const p of list) if (p && p !== shown && old.includes(p.id)) p.filled = "";
    removeMeterPhotos(project, old);
  }
  const ph = { id: uid(), by: author(), ts: nowIso(), dev: String(dev || ""), mapId: map.id, rowKey, loc, date: row.date || "", src, read: null, filled: "", ok: "" };
  list.push(ph);
  return ph;
}

/** Waiting for the reader: no answer yet, the bytes are on this device,
    and (when `dev` is given) this install took it. */
export const needsRead = (ph, dev) => !!ph && !ph.read && isLocalImage(ph.src) && (dev == null || ph.dev === dev);

export const pendingReads = (project, dev) => meterList(project).filter((p) => needsRead(p, dev));

/** Land the reader's answer on the photo. reply is readMeter's
    { meter, fill } (an { off } or { capped } answer is never stamped: the
    photo stays waiting and is read once the reader is back). Only in fill
    mode, only a confident readable moisture-meter number, and only into an
    EMPTY cell: a typed value is never overwritten. Returns { filled }. */
export function applyMeterRead(project, ph, reply, at = nowIso()) {
  if (!ph || !reply || reply.off || reply.capped) return { filled: false };
  const m = reply.meter || {};
  const fill = !!reply.fill;
  ph.read = {
    at, model: String(m.model || ""), fill,
    device: String(m.device || "other"), readable: m.readable === true,
    value: String(m.value || ""), unit: String(m.unit || ""), mode: String(m.mode || ""),
    confidence: Number(m.confidence) || 0, note: String(m.note || ""),
  };
  if (!fill || m.fillable !== true || !(ph.read.confidence >= FILL_MIN) || !ph.read.value) return { filled: false };
  // a signed certificate never picks up a number nobody checked: the read is
  // kept on the photo, and the tech types the reading
  if (certSigned(project.certDrying)) return { filled: false };
  const { row } = findRow(project, ph);
  if (!row || !Array.isArray(row.values)) return { filled: false };
  if (!blank(row.values[ph.loc])) return { filled: false };
  row.values[ph.loc] = ph.read.value;
  ph.filled = ph.read.value;
  return { filled: true };
}

/* a read sure enough to offer as a number (and so to flag a difference with) */
const trusted = (r) => !!r && r.readable === true && r.device === "moisture_meter" && !!r.value && r.confidence >= FILL_MIN;

/** What a cell shows:
      none     no photo
      pending  photo kept, the reader hasn't answered (offline, or not yet)
      check    the reader filled this cell and nobody has confirmed it (amber);
               also when another device's copy of the map dropped that
               unconfirmed number (the cell is empty again: "Use" puts it back)
      differs  fill mode read a different number than the one typed (red ≠)
      photo    photo kept, nothing to do */
export function cellState(ph, value) {
  if (!ph) return "none";
  if (!ph.read) return "pending";
  if (ph.ok) return "photo";
  if (ph.filled && (sameReading(value, ph.filled) || blank(value))) return "check";
  const r = ph.read;
  if (r.fill && trusted(r) && !blank(value) && !sameReading(value, r.value)) return "differs";
  return "photo";
}

/** The tech typed in a cell that has a photo: a number typed over the
    reader's prefill is a correction, and the typed value is the reading. */
export function noteTyped(ph, value, at = nowIso()) {
  if (!ph || ph.ok || !ph.filled) return false;
  if (sameReading(value, ph.filled) || blank(value)) return false;
  ph.ok = at;
  ph.fixed = String(value ?? "");
  return true;
}

/** "That number is right." */
export function confirmMeterPhoto(ph, at = nowIso()) { if (ph) ph.ok = at; }

/** "Use the photo's number": put the read value in the cell, confirmed. */
export function useMeterRead(project, ph, at = nowIso()) {
  if (!ph || !ph.read || !ph.read.value) return false;
  const { row } = findRow(project, ph);
  if (!row || !Array.isArray(row.values)) return false;
  row.values[ph.loc] = ph.read.value;
  ph.ok = at;
  return true;
}

/** Remove photos by id, recording each delete (merge.js tombstones). An
    unconfirmed number a photo filled in comes out of its cell with it. */
export function removeMeterPhotos(project, ids) {
  const kill = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
  const list = meterList(project);
  if (!kill.size || !list.length) return 0;
  const gone = list.filter((p) => p && kill.has(p.id));
  if (!gone.length) return 0;
  for (const p of gone) dropPrefill(project, p);
  tombstoneItems(project, gone.map((p) => p.id));
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && kill.has(list[i].id)) list.splice(i, 1);
  return gone.length;
}

/** Would removing these photos take an unconfirmed number out of a cell?
    (The delete confirm says so.) */
export const dropsPrefill = (project, ph) => {
  if (!ph || !ph.filled || ph.ok) return false;
  const { row } = findRow(project, ph);
  return !!row && Array.isArray(row.values) && sameReading(row.values[ph.loc], ph.filled);
};

/** Ids of the photos on one reading date (row), on locations at or past
    `fromLoc`, or on a whole map — for the deletes that take them along. */
export function rowPhotoIds(project, map, row) {
  if (!row) return [];
  return meterList(project).filter((p) => p && p.mapId === map.id && rowFor(map, p) === row).map((p) => p.id);
}
export function locPhotoIds(project, map, fromLoc) {
  return meterList(project).filter((p) => p && p.mapId === map.id && p.loc >= fromLoc).map((p) => p.id);
}
export function mapPhotoIds(project, mapId) {
  return meterList(project).filter((p) => p && p.mapId === mapId).map((p) => p.id);
}

/** Photos left on a map that was deleted (another device's offline photo,
    taken after the delete, survives the union with its own new id): they
    are never shown, so they are dropped rather than synced forever. Used by
    sync.js settleMerged. Returns how many went. */
export function sweepDeletedMapPhotos(project) {
  const marks = project && project[DELETED_IDS];
  if (!marks || typeof marks !== "object") return 0;
  const ids = meterList(project).filter((p) => p && p.mapId && Object.prototype.hasOwnProperty.call(marks, p.mapId)).map((p) => p.id);
  return ids.length ? removeMeterPhotos(project, ids) : 0;
}

const LOC_BLOCK = 13;
/** How many locations the Moisture Map draws: whole blocks of 13, enough
    for every reading's values (forms.js moistureMap locCount). */
export function drawnLocs(map) {
  const widths = ((map && map.readings) || []).map((r) => (r && Array.isArray(r.values) ? r.values.length : 0));
  return Math.ceil(Math.max(LOC_BLOCK, Number(map && map.locCount) || 0, ...widths) / LOC_BLOCK) * LOC_BLOCK;
}

/** Every photo on a map in grid order (date rows top to bottom, then
    location), for the printed appendix. A photo whose row is gone (merged
    away on another device) is still listed, by the date it was taken.
    `shown`: the grid shows it (the newest photo on a cell it draws), and
    `unchecked`: it is an amber ? there, a number the reader filled that
    nobody has checked. An older photo on the same cell is never one. */
export function mapPhotoEntries(project, map) {
  const rows = map.readings || [];
  const order = new Map(rows.map((r, i) => [r, i]));
  const { byRow } = mapIndex(project, map);
  const width = drawnLocs(map);
  return meterList(project)
    .filter((p) => p && p.mapId === map.id)
    .map((p) => {
      const row = rowFor(map, p);
      const i = row ? order.get(row) : -1;
      const value = row ? String(row.values?.[p.loc] ?? "") : "";
      const state = row ? cellState(p, value) : "photo";
      const shown = !!row && p.loc < width && byRow.get(row)?.get(p.loc) === p;
      return { ph: p, row, loc: p.loc, date: (row && row.date) || p.date || "", value, orphan: !row, i,
        state, shown, unchecked: shown && state === "check" };
    })
    .sort((a, b) => (a.orphan - b.orphan) || (a.i - b.i) || String(a.date).localeCompare(String(b.date)) || (a.loc - b.loc) || String(a.ph.ts).localeCompare(String(b.ph.ts)));
}

/** Numbers the reader filled in that nobody has checked yet, on every map:
    the amber ?s the grid shows. The Certificate of Drying can't be signed
    or go out for signature while any wait. */
export function uncheckedFills(project) {
  const out = [];
  for (const map of project.moistureMaps || []) {
    if (!map) continue;
    for (const e of mapPhotoEntries(project, map)) if (e.unchecked) out.push({ map, ...e });
  }
  return out;
}

/** Photos the reader hasn't answered yet on an EMPTY cell: in fill mode
    their number could still land there. The certificate doesn't go out for
    signature until each is read, typed or deleted. */
export function unreadOnEmpty(project) {
  const out = [];
  for (const map of project.moistureMaps || []) {
    if (!map) continue;
    for (const e of mapPhotoEntries(project, map)) if (e.row && !e.ph.read && blank(e.value)) out.push({ map, ...e });
  }
  return out;
}

/** A Certificate of Drying (project.certDrying) carries a signature: drawn
    on the device, made in the portal, or an uploaded signed copy. */
export function certSigned(c) {
  if (!c || typeof c !== "object") return false;
  return !!(c.sigTech || c.sigOwner || c.sigAdjuster || c.portalSignedAt || c.uploadedDoc ||
    (Array.isArray(c.uploadedPages) && c.uploadedPages.length));
}

/** For the Certificate of Drying: each location's FINAL reading (the last
    dated row with a number in that column) when that cell has a photo.
    `unchecked` marks a final number the reader filled that nobody checked. */
export function finalReadingPhotos(project) {
  const out = [];
  for (const map of project.moistureMaps || []) {
    if (!map) continue;
    const { byRow } = mapIndex(project, map);
    if (!byRow.size) continue;
    const rows = (map.readings || []).map((r, i) => ({ r, i }))
      .sort((a, b) => String(a.r?.date || "").localeCompare(String(b.r?.date || "")) || a.i - b.i);
    const width = Math.max(0, ...rows.map(({ r }) => (r?.values || []).length));
    for (let loc = 0; loc < width; loc++) {
      let last = null;
      for (const { r } of rows) if (r && !blank(r.values?.[loc])) last = r;
      const ph = last ? byRow.get(last)?.get(loc) : null;
      if (ph) {
        const value = String(last.values[loc]);
        out.push({ map, ph, row: last, loc, date: last.date || "", value, unchecked: cellState(ph, value) === "check" });
      }
    }
  }
  return out;
}
