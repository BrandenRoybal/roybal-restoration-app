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

/* every multi-instance collection whose elements carry a stable `id`
   (see model.js factories) — safe to union. merge.test.mjs cross-checks
   this registry against model.js FORMS so a new form can't be forgotten. */
export const ID_COLLECTIONS = [
  "photos", "moistureMaps", "dryingLogs", "constructionLogs",
  "invoices", "reconEstimates", "changeOrders", "receipts",
  "inspections", "contents", "boxes", "supportDocs",
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

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

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
    { merged, added, filledForms, removed, notes } — `added` counts elements
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

  return { merged, added, filledForms, removed, notes };
}
