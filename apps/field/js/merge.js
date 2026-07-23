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
     — a filled form always beats an empty slot, either direction.
   • ROOMS (plain strings) union by value.
   • SCALARS (customer, dates, contract amount, …) — the newer
     blob wins wholesale; conflicts are counted so the UI can say
     a merge happened.

   Sync bookkeeping (rev, updatedAt) is the CALLER's job — this
   module only reconciles content.
   ============================================================ */

/* every multi-instance collection whose elements carry a stable `id`
   (see model.js factories) — safe to union */
export const ID_COLLECTIONS = [
  "photos", "moistureMaps", "dryingLogs", "constructionLogs",
  "invoices", "reconEstimates", "changeOrders", "receipts",
  "inspections", "contents", "boxes",
];

/* single-instance form objects: filled beats empty */
export const FORM_SLOTS = [
  "workAuth", "certDrying", "laborLog", "scopeOfWork", "preConChecklist",
  "selections", "subSchedule", "punchList", "drawSchedule", "certCompletion",
  "portalShare",
];

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

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

  // a filled form beats an empty slot, whichever side filled it
  for (const key of FORM_SLOTS) {
    if (merged[key] == null && older[key] != null) {
      merged[key] = clone(older[key]);
      filledForms++;
      notes.push(key);
    }
  }

  return { merged, added, filledForms, notes };
}
