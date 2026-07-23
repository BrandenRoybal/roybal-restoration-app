/* ============================================================
   Field project merge — pure module (no DOM, no network)
   ------------------------------------------------------------
   When two devices edited the same job, losing either side's
   work is not an option. The merge rule set:

   • ID-KEYED COLLECTIONS (photos, drying logs, readings, receipts,
     invoices, …) UNION by element id — both devices' additions
     survive. On an id clash (same element edited on both sides)
     the newer blob's version wins. Trade-off made deliberately:
     an element deleted on only one side comes back (resurrection
     is recoverable; silent loss is not).
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
    { merged, added, filledForms, notes } — `added` counts elements
    recovered from the older copy, `notes` is a short human list. */
export function mergeProjects(a, b) {
  const newer = String(a.updatedAt || "") >= String(b.updatedAt || "") ? a : b;
  const older = newer === a ? b : a;
  const merged = clone(newer);
  const notes = [];
  let added = 0, filledForms = 0;

  for (const key of ID_COLLECTIONS) {
    const ol = Array.isArray(older[key]) ? older[key] : [];
    if (!ol.length) continue;
    const nl = Array.isArray(merged[key]) ? merged[key] : (merged[key] = []);
    const have = new Set(nl.map((x) => x && x.id).filter(Boolean));
    const missing = ol.filter((x) => x && x.id && !have.has(x.id));
    if (missing.length) {
      nl.push(...missing.map(clone));
      added += missing.length;
      notes.push(`${key} +${missing.length}`);
    }
  }

  // rooms: shared string list
  const oRooms = Array.isArray(older.rooms) ? older.rooms : [];
  if (oRooms.length) {
    const nRooms = Array.isArray(merged.rooms) ? merged.rooms : (merged.rooms = []);
    for (const r of oRooms) if (!nRooms.includes(r)) { nRooms.push(r); added++; }
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

  return { merged, added, filledForms, notes };
}
