/* ============================================================
   Field project merge — pure module (no DOM, no network)
   ------------------------------------------------------------
   When two devices edited the same job, losing either side's
   work is not an option. The merge rule set:

   • ID-KEYED COLLECTIONS (photos, drying logs, readings, receipts,
     invoices, …) UNION by element id — both devices' additions
     survive. On an id clash (same element edited on both sides)
     the newer blob's version wins. A deletion is NOT the absence
     of an element — it is a recorded fact (`deletedIds`) that
     travels with the job and beats the union; see below.
   • SINGLE-FORM SLOTS (work auth, drying cert, scope of work, …)
     — a filled form always beats an empty slot, and when BOTH
     sides hold the form it merges FIELD BY FIELD: a filled field
     never loses to an empty one, and id-keyed sub-arrays (labor
     entries, checklist rows) union. This matters because merely
     OPENING a form tile materializes a factory blank — a blank
     must never beat a signed original.
   • ROOMS (plain strings) union by value.
   • SCALARS (customer, dates, contract amount, …) — the newer
     blob wins wholesale; conflicts are counted so the UI can say
     a merge happened.

   Sync bookkeeping (rev, updatedAt) is the CALLER's job — this
   module only reconciles content.
   ============================================================ */

import { PREVIEW_OF, isPreviewEntry } from "./thumbs.js";

/* every multi-instance collection whose elements carry a stable `id`
   (see model.js factories) — safe to union. merge.test.mjs cross-checks
   this registry against model.js FORMS so a new form can't be forgotten,
   and merge-sql-parity.test.mjs against the server's two lists.
   `equipmentScans` is the append-only equipment scan log (scans.js): its
   events are never edited, so the union is the whole story. `meterPhotos`
   are the meter-screen photos on Moisture Map readings (meterphotos.js),
   kept out of the map element so a newer copy of the map can't drop one. */
export const ID_COLLECTIONS = [
  "photos", "moistureMaps", "dryingLogs", "constructionLogs",
  "invoices", "reconEstimates", "changeOrders", "receipts",
  "inspections", "contents", "boxes", "supportDocs", "equipmentScans",
  "meterPhotos",
];

/* ---------- per-item delete tombstones ----------
   The union above is purely additive, and that left one hole wide open: to a
   merge, "the desktop deleted this photo" and "the desktop never had this
   photo" look exactly the same, so any device still holding the element puts
   it back — forever, on every cycle. (Aug 2026: 163 photos deleted from the
   Fidler job on the desktop kept coming back from a phone, and no amount of
   re-syncing could ever have fixed it — the merge was doing its job.)

   A delete now leaves a MARK. `project.deletedIds` maps element id → the ISO
   stamp the delete was made, it rides along in the job blob like any other
   edit, and the merge honours it: a tombstoned id is dropped from the union
   no matter which side still carries the element.

   The tombstone wins UNCONDITIONALLY — no clock comparison. Element ids are
   uuids and are never reused, so "deleted" is a terminal state for an id and
   there is no later version of it to lose. That also means a device with a
   skewed clock cannot un-delete anything, which is the failure mode that
   matters in the field. Tombstones union too, so a delete survives a round
   trip through a device that never held the element in the first place.
   Recovery is unchanged: the on-device backups store and the server-side
   trash table still hold the deleted content. */
export const DELETED_IDS = "deletedIds";
/* Cap: a tombstone is ~50 bytes and photo deletes are rare, but an unbounded
   map inside a synced blob is a slow leak. Past the cap the OLDEST marks are
   dropped — the only device that could then resurrect an element is one that
   has been offline since before those deletes, which has bigger problems. */
const MAX_TOMBSTONES = 2000;

/** Record that these element ids were deleted, so the delete propagates
    instead of being merged away. Call it at every site that removes an
    element from an ID_COLLECTIONS array — removing the element itself stays
    the caller's job. Mutates and returns `project`. */
export function tombstoneItems(project, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!project || !list.length) return project;
  const marks = isObj(project[DELETED_IDS]) ? project[DELETED_IDS] : (project[DELETED_IDS] = {});
  const now = new Date().toISOString();
  for (const id of list) if (!marks[id]) marks[id] = now;
  project[DELETED_IDS] = capTombstones(marks);
  return project;
}

/* union of both sides' marks, keeping the EARLIER stamp for an id both sides
   deleted (the stamp is only ever read by humans and by the cap) */
function unionTombstones(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [id, ts] of Object.entries(isObj(b) ? b : {})) {
    if (!out[id] || String(ts) < String(out[id])) out[id] = ts;
  }
  return capTombstones(out);
}
function capTombstones(marks) {
  const ids = Object.keys(marks);
  if (ids.length <= MAX_TOMBSTONES) return marks;
  const keep = ids.sort((x, y) => String(marks[x]).localeCompare(String(marks[y]))).slice(-MAX_TOMBSTONES);
  const out = {};
  for (const id of keep) out[id] = marks[id];
  return out;
}

/* single-instance form objects: filled beats empty, field-wise merge */
export const FORM_SLOTS = [
  "workAuth", "certDrying", "laborLog", "scopeOfWork", "preConChecklist",
  "selections", "subSchedule", "punchList", "drawSchedule", "certCompletion",
  "portalShare", "floorPlan",
];

/* keys mergeProjects resolves with a rule of their own — everything else at the
   top level is a scalar, and scalars use filled-beats-empty (see the loop at the
   end of mergeProjects). `deleted`/`rev`/`updatedAt`/`id` are sync bookkeeping,
   never content. */
const SCALAR_SKIP = new Set([
  ...ID_COLLECTIONS, ...FORM_SLOTS, "rooms", "lossTypes",
  "id", "rev", "updatedAt", "deleted", DELETED_IDS,
]);

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/* A meter photo's reading row in one copy of its map: the row with its rk,
   else the one row with its date (meterphotos.js rowFor, kept here so the
   merge imports no screen code). */
function readingRow(map, ph) {
  const rows = isObj(map) && Array.isArray(map.readings) ? map.readings : [];
  if (typeof ph.rowKey === "string" && ph.rowKey !== "") {
    const r = rows.find((x) => isObj(x) && x.rk === ph.rowKey);
    if (r) return r;
  }
  if (typeof ph.date !== "string" || ph.date === "") return null;
  const same = rows.filter((x) => isObj(x) && x.date === ph.date);
  return same.length === 1 ? same[0] : null;
}
/* A reading cell still holds this number ("17.40" = "17.4", "17,4" = "17.4").
   Only a string is a typed number (a missing or null cell is ""); a number
   is compared as one when it is short (40 characters, a 2-digit exponent at
   most), so the server can compare it as a float8 and agree exactly. Twin:
   the same test in 0024's merge_project_blobs. */
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,2})?$/;
const EDGE_WS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
function sameNumber(a, b) {
  const s = (v) => (v == null ? "" : typeof v === "string" ? v.replace(",", ".").replace(EDGE_WS, "") : null);
  const x = s(a), y = s(b);
  if (x === null || y === null) return false;
  if (x === "" || y === "") return x === y;
  return NUM_RE.test(x) && NUM_RE.test(y) && x.length <= 40 && y.length <= 40 ? Number(x) === Number(y) : x === y;
}

/* "nothing here yet" — the values a factory blank / untouched field holds */
const isEmptyish = (v) => v == null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (isObj(v) && Object.keys(v).length === 0);

/* Field-level union of two copies of the same single form. The newer side's
   value wins EXCEPT an empty field never beats a filled one (so a factory
   blank materialized by just opening the form can't erase a signed original),
   and arrays whose elements carry ids union like the top-level collections.
   `stats.recovered` counts fields/elements taken from the older side. */
function mergeForm(newerV, olderV, stats) {
  if (olderV === undefined) return newerV;
  if (isEmptyish(newerV) && !isEmptyish(olderV)) { stats.recovered++; return clone(olderV); }
  if (Array.isArray(newerV) && Array.isArray(olderV)) {
    if (newerV.every((x) => isObj(x) && x.id) && olderV.every((x) => isObj(x) && x.id)) {
      const have = new Set(newerV.map((x) => x.id));
      const missing = olderV.filter((x) => !have.has(x.id));
      if (missing.length) { stats.recovered += missing.length; return [...newerV, ...missing.map(clone)]; }
    }
    return newerV;               // non-id rows (reading grids) — newer wins wholesale
  }
  if (isObj(newerV) && isObj(olderV)) {
    const out = { ...newerV };
    for (const k of Object.keys(olderV)) out[k] = mergeForm(newerV[k], olderV[k], stats);
    return out;
  }
  return newerV;
}

/** Merge two copies of the same project. Returns
    { merged, added, filledForms, removed, upgraded, notes } — `upgraded`
    counts previews replaced by the real photo, `added` counts elements
    recovered from the older copy, `removed` counts elements the tombstones
    kept out — both dropped from the newer copy and blocked from coming back
    off the older one — and `notes` is a short human list. */
export function mergeProjects(a, b) {
  const newer = String(a.updatedAt || "") >= String(b.updatedAt || "") ? a : b;
  const older = newer === a ? b : a;
  const merged = clone(newer);
  const notes = [];
  let added = 0, filledForms = 0, removed = 0;

  // Deletes are decided BEFORE the union, and they apply to both sides: an
  // element the older copy tombstoned is dropped from the newer copy too.
  const marks = unionTombstones(older[DELETED_IDS], newer[DELETED_IDS]);
  const gone = new Set(Object.keys(marks));
  if (gone.size) merged[DELETED_IDS] = marks;

  for (const key of ID_COLLECTIONS) {
    const ol = Array.isArray(older[key]) ? older[key] : [];
    const nl = Array.isArray(merged[key]) ? merged[key] : (ol.length ? (merged[key] = []) : null);
    if (!nl) continue;
    if (ol.length) {
      const have = new Set(nl.map((x) => x && x.id).filter(Boolean));
      const fresh = ol.filter((x) => x && x.id && !have.has(x.id));
      const missing = fresh.filter((x) => !gone.has(x.id));
      removed += fresh.length - missing.length;   // resurrections the tombstones blocked
      if (missing.length) {
        nl.push(...missing.map(clone));
        added += missing.length;
        notes.push(`${key} +${missing.length}`);
      }
    }
    if (gone.size) {
      const kept = nl.filter((x) => !(x && x.id && gone.has(x.id)));
      if (kept.length !== nl.length) {
        removed += nl.length - kept.length;
        notes.push(`${key} −${nl.length - kept.length}`);
        merged[key] = kept;
      }
    }
  }

  // ---------- a preview is never the photograph ----------
  // A photos[] entry carrying `previewOf` holds a ~320px stand-in plus the
  // hash of the real bytes, not the photograph (thumbs.js). When both copies
  // carry the same photo id and one of them holds the real thing, the real
  // thing wins — REGARDLESS of which copy is newer. "Newer" says when a device
  // last touched the job, not which copy of a photo is better, and a device
  // that pulled previews and then fixed a caption would otherwise push a 320px
  // stand-in over the only documentation of the inside of someone's house.
  //
  // Field-granular, like mergeForm: the newer copy keeps its caption, room and
  // stage edits and takes only the image from the older one. `cloud` moves
  // with `src` because they describe the same bytes — a preview's cloud hash
  // is sync's bookkeeping and must not outlive the preview it belonged to.
  let upgraded = 0;
  if (Array.isArray(merged.photos) && Array.isArray(older.photos)) {
    const real = new Map();
    for (const el of older.photos) {
      if (el && el.id && !isPreviewEntry(el) && !gone.has(el.id)) real.set(el.id, el);
    }
    if (real.size) {
      merged.photos = merged.photos.map((el) => {
        if (!isPreviewEntry(el) || !real.has(el.id)) return el;
        const full = real.get(el.id);
        const { [PREVIEW_OF]: _mark, cloud: _hash, ...rest } = el;
        const out = { ...rest, src: clone(full.src) };
        if (full.cloud) out.cloud = full.cloud;
        upgraded++;
        return out;
      });
      if (upgraded) notes.push(`photos ↑${upgraded}`);
    }
  }

  // ---------- a meter photo's read and check are never undone ----------
  // A meterPhotos element (meterphotos.js) only ever gains its `read` (the
  // number the reader saw, with the `filled` it put in an empty cell) and
  // its `ok` (the tech's check, with any `fixed` typed over it). A copy of
  // the job saved before either landed — the office opened it, a second
  // phone pulled it — can still be the NEWER copy, and its element would
  // otherwise win whole and drop them: the photo read (and billed) again,
  // the check asked again. So whichever copy has them keeps them, field by
  // field, like the preview rule above. Twin: 0024's merge_project_blobs.
  if (Array.isArray(merged.meterPhotos) && Array.isArray(older.meterPhotos)) {
    const isSet = (v) => typeof v === "string" && v !== "";
    const prev = new Map();
    for (const el of older.meterPhotos) {
      if (isObj(el) && isSet(el.id) && !gone.has(el.id) && !prev.has(el.id)) prev.set(el.id, el);
    }
    if (prev.size) {
      let kept = 0;
      merged.meterPhotos = merged.meterPhotos.map((el) => {
        const o = isObj(el) && isSet(el.id) ? prev.get(el.id) : null;
        if (!o) return el;
        let out = el;
        if (!isObj(el.read) && isObj(o.read)) {
          out = { ...out, read: clone(o.read), filled: "filled" in o ? clone(o.filled) : "" };
        }
        if (!isSet(el.ok) && isSet(o.ok)) {
          out = { ...out, ok: o.ok };
          if ("fixed" in o) out.fixed = clone(o.fixed);
        }
        if (out !== el) kept++;
        return out;
      });
      if (kept) notes.push(`meterPhotos ✓${kept}`);
    }
  }

  // ---------- a deleted photo's unchecked number goes with it ----------
  // Deleting or retaking a meter photo whose number the reader filled in,
  // unchecked, takes that number out of its cell (meterphotos.js
  // dropPrefill). A moisture map merges whole, so a newer copy of the map
  // saved before the delete would put the number back, looking typed. So for
  // a photo the tombstones drop here that carries an unchecked `filled` (no
  // copy of it has `ok`): when the merged map's cell still holds that number
  // and the other copy of the map has something else there, the merged cell
  // takes the other copy's value. Twin: 0024's merge_project_blobs.
  if (gone.size && Array.isArray(merged.moistureMaps)) {
    const isSet = (v) => typeof v === "string" && v !== "";
    const drops = new Map();                       // photo id → { ph, filled, ok }
    for (const side of [newer, older]) {
      for (const el of Array.isArray(side.meterPhotos) ? side.meterPhotos : []) {
        if (!isObj(el) || !isSet(el.id) || !gone.has(el.id)) continue;
        let d = drops.get(el.id);
        if (!d) drops.set(el.id, (d = { ph: el, filled: "", ok: false }));
        if (!d.filled && isSet(el.filled)) d.filled = el.filled;
        if (isSet(el.ok)) d.ok = true;
      }
    }
    const mapOf = (list, id) => (Array.isArray(list) ? list.find((m) => isObj(m) && m.id === id) : null) || null;
    for (const { ph, filled, ok } of drops.values()) {
      if (!filled || ok || !isSet(ph.mapId) || !Number.isInteger(ph.loc) || ph.loc < 0) continue;
      if (!mapOf(newer.moistureMaps, ph.mapId)) continue;   // the merged map is not the newer copy's
      const mm = mapOf(merged.moistureMaps, ph.mapId), om = mapOf(older.moistureMaps, ph.mapId);
      const mr = readingRow(mm, ph), or = readingRow(om, ph);
      if (!mr || !or || !Array.isArray(mr.values)) continue;
      const theirs = Array.isArray(or.values) ? or.values[ph.loc] : undefined;
      if (sameNumber(mr.values[ph.loc], filled) && !sameNumber(theirs, filled)) {
        mr.values[ph.loc] = theirs == null ? "" : clone(theirs);
        notes.push("meter number taken out");
      }
    }
  }

  // rooms: shared string list
  const oRooms = Array.isArray(older.rooms) ? older.rooms : [];
  if (oRooms.length) {
    const nRooms = Array.isArray(merged.rooms) ? merged.rooms : (merged.rooms = []);
    for (const r of oRooms) if (!nRooms.includes(r)) { nRooms.push(r); added++; }
  }

  // loss-type chips: union by value, like rooms — two devices classifying
  // concurrently are BOTH right (one taps Fire, one taps Storm → fire and
  // storm). The scalar details inside each block stay newer-wins like every
  // other header scalar.
  const oLoss = Array.isArray(older.lossTypes) ? older.lossTypes : [];
  if (oLoss.length) {
    const nLoss = Array.isArray(merged.lossTypes) ? merged.lossTypes : (merged.lossTypes = []);
    for (const t of oLoss) if (!nLoss.includes(t)) { nLoss.push(t); added++; }
  }

  // a filled form beats an empty slot; two filled copies merge field-wise
  for (const key of FORM_SLOTS) {
    if (merged[key] == null) {
      if (older[key] != null) {
        merged[key] = clone(older[key]);
        filledForms++;
        notes.push(key);
      }
      continue;
    }
    if (older[key] == null) continue;
    const stats = { recovered: 0 };
    merged[key] = mergeForm(merged[key], older[key], stats);
    if (stats.recovered) { filledForms++; notes.push(key); }
  }

  // TOP-LEVEL SCALARS: filled beats empty — the SAME rule mergeForm already
  // applies to every field inside every form (:120). Without it, `clone(newer)`
  // above hands every scalar to whichever blob carries the larger `updatedAt`,
  // and that stamp is not always an observed edit time: a server-side union is
  // stamped greatest(both inputs)+1ms and then FLOORED AT THE SERVER CLOCK
  // (218:258-260, 241:270-272). A tablet whose clock trails the server loses
  // text it genuinely typed later — notes, customer, address, claim number,
  // contract amount — and because the lossy union then equals the server copy,
  // sync's self-echo guard adopts it CLEAN and the edit is never re-pushed.
  // That is silent data loss on the one promise this engine exists to keep.
  //
  // Only a BLANK ever loses here, so this is not "older wins": a real edit on
  // the newer side still beats an older value, and two devices that both filled
  // the same field still resolve newer-wins. The accepted trade-off is the one
  // mergeForm already accepts — deliberately CLEARING a scalar can be undone by
  // a merge that carries the old text. Losing a clear is recoverable by
  // clearing again; losing typing is not.
  for (const key of Object.keys(older)) {
    if (SCALAR_SKIP.has(key)) continue;
    if (isEmptyish(merged[key]) && !isEmptyish(older[key])) {
      merged[key] = clone(older[key]);
      added++;
      notes.push(key);
    }
  }

  return { merged, added, filledForms, removed, upgraded, notes };
}
