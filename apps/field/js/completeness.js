/* ============================================================
   Roybal Field Forms — Completeness Engine (read-only, no AI)
   ------------------------------------------------------------
   Pure logic. No DOM, no network, no cost. Given a field project
   (the same object model.js builds), it checks the job against the
   standard IICRC water-mitigation required-form matrix and returns
   exactly what's still missing.

   This is the executable mirror of the rules seeded in
   supabase/migrations/200_ai_backbone.sql. The database holds the
   canonical copy (so the Board + billing agree); the field app
   carries this cached copy so the check also works fully offline.

   gate: 'hard' = blocks billing (a real gap)
         'soft' = warn only (good practice, not a blocker)
   when: null = always required
         'cat3' | 'contents' | 'cleaning' = conditional add-on

   Construction jobs check against CONSTRUCTION_REQUIREMENTS instead
   (contract → permits → inspections → punch list → cert of completion).
   ============================================================ */
import { jobType, PRECON_CONTRACT, PRECON_PERMITS } from "./model.js";

/* ---------- small helpers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const filled = (v) => v != null && String(v).trim() !== "";
const anyRow = (rows, test) => arr(rows).some(test);
// at least one instance (e.g. one drying log) has at least one row passing `test`
const anyInstanceRow = (instances, rowsKey, test) =>
  arr(instances).some((inst) => anyRow(inst && inst[rowsKey], test));

/* Which conditional add-ons apply to this job. Auto-derived, but callers
   can override (e.g. a "this job has cleaning" toggle in the UI). */
export function activeConditions(p, override = {}) {
  return {
    cat3: override.cat3 ?? (String(p.waterCategory) === "3"),
    contents: override.contents ?? (arr(p.contents).length > 0),
    cleaning: override.cleaning ?? false,
  };
}

/* ---------- the required matrix (mirrors the seeded DB rules) ---------- */
export const REQUIREMENTS = [
  // ----- Work Authorization -----
  { id: "wa_sig", form: "workAuth", label: "Owner signature (signed or uploaded)", gate: "hard",
    present: (p) => !!p.workAuth && (filled(p.workAuth.ownerSig) || arr(p.workAuth.uploadedPages).length > 0 || filled(p.workAuth.uploadedDoc)) },
  { id: "wa_owner", form: "workAuth", label: "Owner name", gate: "hard",
    // The form's "Owner Name" field binds to the shared job customer; the sig
    // block's typed name lands in ownerName. Either documents the owner — as
    // does an uploaded signed authorization (the name is in the scan).
    present: (p) => !!p.workAuth && (filled(p.workAuth.ownerName) || filled(p.customer)
      || arr(p.workAuth.uploadedPages).length > 0 || filled(p.workAuth.uploadedDoc)) },
  { id: "wa_date", form: "workAuth", label: "Authorization date", gate: "hard",
    present: (p) => !!p.workAuth && filled(p.workAuth.ownerDate || p.workAuth.date) },

  // ----- Floor plan (lives inside a Moisture Map in the field app) -----
  { id: "fp_present", form: "floorPlan", label: "At least one floor plan / job map", gate: "hard",
    present: (p) => arr(p.moistureMaps).some((m) => filled(m.floorPlan) || filled(m.sketch)) },

  // ----- Moisture Map -----
  { id: "mm_material", form: "moistureMaps", label: "Material on each moisture map", gate: "hard",
    present: (p) => arr(p.moistureMaps).length > 0 && arr(p.moistureMaps).every((m) => filled(m.material)) },
  { id: "mm_drygoal", form: "moistureMaps", label: "Dry goal (auto-fills from material)", gate: "hard",
    present: (p) => arr(p.moistureMaps).length > 0 && arr(p.moistureMaps).every((m) => filled(m.dryGoal)) },
  { id: "mm_readings", form: "moistureMaps", label: "At least one dated MC% reading", gate: "hard",
    present: (p) => anyInstanceRow(p.moistureMaps, "readings", (r) => arr(r.values).some(filled)) },

  // ----- Drying Log -> Psychrometric (split #1) -----
  { id: "dl_affT", form: "dryingLogs", label: "Affected-area temp (psychrometric)", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "readings", (r) => filled(r.affT)) },
  { id: "dl_affRH", form: "dryingLogs", label: "Affected-area RH (psychrometric)", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "readings", (r) => filled(r.affRH)) },
  { id: "dl_outT", form: "dryingLogs", label: "Outside temp (psychrometric)", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "readings", (r) => filled(r.outT)) },
  { id: "dl_outRH", form: "dryingLogs", label: "Outside RH (psychrometric)", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "readings", (r) => filled(r.outRH)) },
  { id: "dl_gd", form: "dryingLogs", label: "Grain depression (auto-calc)", gate: "soft",
    present: (p) => anyInstanceRow(p.dryingLogs, "readings", (r) => filled(r.gd)) },

  // ----- Drying Log -> Equipment (split #2) -----
  { id: "eq_type", form: "dryingLogs", label: "Equipment type", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "equipment", (e) => filled(e.type)) },
  { id: "eq_loc", form: "dryingLogs", label: "Equipment location", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "equipment", (e) => filled(e.location)) },
  { id: "eq_placed", form: "dryingLogs", label: "Equipment date placed", gate: "hard",
    present: (p) => anyInstanceRow(p.dryingLogs, "equipment", (e) => filled(e.placed)) },
  { id: "eq_removed", form: "dryingLogs", label: "Equipment date removed (to close phase)", gate: "soft",
    present: (p) => anyInstanceRow(p.dryingLogs, "equipment", (e) => filled(e.removed)) },

  // ----- Photo Log -----
  { id: "ph_before", form: "photos", label: "At least one 'before' photo", gate: "hard",
    present: (p) => anyRow(p.photos, (ph) => ph.stage === "before") },
  { id: "ph_after", form: "photos", label: "At least one 'after' photo", gate: "hard",
    present: (p) => anyRow(p.photos, (ph) => ph.stage === "after") },
  { id: "ph_during", form: "photos", label: "At least one 'during' photo", gate: "soft",
    present: (p) => anyRow(p.photos, (ph) => ph.stage === "during") },
  { id: "ph_caption", form: "photos", label: "Caption on every photo", gate: "hard",
    present: (p) => arr(p.photos).length === 0 || arr(p.photos).every((ph) => filled(ph.caption)) },

  // ----- Certificate of Drying -----
  { id: "cd_final", form: "certDrying", label: "Final reading per material", gate: "hard",
    present: (p) => !!p.certDrying && anyRow(p.certDrying.verification, (v) => filled(v.final)) },
  { id: "cd_goal", form: "certDrying", label: "Dry goal per material", gate: "hard",
    present: (p) => !!p.certDrying && anyRow(p.certDrying.verification, (v) => filled(v.goal)) },
  { id: "cd_sig", form: "certDrying", label: "Tech sign-off", gate: "hard",
    present: (p) => !!p.certDrying && (filled(p.certDrying.sigTech) || arr(p.certDrying.uploadedPages).length > 0) },

  // ----- Labor Log (QuickBooks Time) -----
  // Billing labor comes from the QuickBooks Time pull, not the Daily
  // Construction Log (that one is internal crew notes, not in the packet).
  { id: "ll_emp", form: "laborLog", label: "Crew member on each entry", gate: "hard",
    present: (p) => !!p.laborLog && anyRow(p.laborLog.entries, (r) => filled(r.employee)) },
  { id: "ll_hours", form: "laborLog", label: "Hours synced from QuickBooks Time (feeds Board + QBO)", gate: "hard",
    present: (p) => !!p.laborLog && anyRow(p.laborLog.entries, (r) => filled(r.hours)) },

  // ----- Conditional: Contents moving -----
  { id: "ct_room", form: "contents", label: "Room on each contents item", gate: "hard", when: "contents",
    present: (p) => arr(p.contents).length > 0 && arr(p.contents).every((c) => filled(c.room)) },
  { id: "ct_disp", form: "contents", label: "Disposition on each contents item", gate: "hard", when: "contents",
    present: (p) => arr(p.contents).length > 0 && arr(p.contents).every((c) => filled(c.disposition)) },

  // ----- Conditional: Cleaning -----
  { id: "cl_just", form: "changeOrders", label: "Cleaning / antimicrobial scope documented", gate: "hard", when: "cleaning",
    present: (p) => anyRow(p.changeOrders, (co) => filled(co.description)) },

  // ----- Conditional: Cat 3 specifics -----
  { id: "c3_just", form: "moistureMaps", label: "Cat 3 flood-cut / containment / HEPA justification", gate: "hard", when: "cat3",
    present: (p) => filled(p.cat3Justification) || anyRow(p.changeOrders, (co) => /flood cut|containment|hepa|antimicrob/i.test(co.description || "")) },
];

/* ---------- construction / remodel matrix ----------
   The closeout gate for construction jobs: isBillable here means
   "ready to invoice the final draw / close the job". */
export const CONSTRUCTION_REQUIREMENTS = [
  // ----- Pre-construction gates -----
  { id: "pc_contract", form: "preConChecklist", label: "Contract signed (pre-con checklist)", gate: "hard",
    present: (p) => !!p.preConChecklist && !!p.preConChecklist.items[PRECON_CONTRACT] },
  { id: "pc_permits", form: "preConChecklist", label: "Permits pulled (or checked off as not required)", gate: "hard",
    present: (p) => !!p.preConChecklist && (!!p.preConChecklist.items[PRECON_PERMITS]
      || anyRow(p.preConChecklist.permits, (r) => filled(r.number))) },

  // ----- Scope of Work -----
  { id: "sc_items", form: "scopeOfWork", label: "At least one scoped line item", gate: "hard",
    present: (p) => !!p.scopeOfWork && arr(p.scopeOfWork.areas).some((a) => anyRow(a.items, (it) => filled(it.desc))) },

  // ----- Photos -----
  { id: "cph_before", form: "photos", label: "Pre-construction photos", gate: "soft",
    present: (p) => anyRow(p.photos, (ph) => ph.stage === "before") },
  { id: "cph_after", form: "photos", label: "Completion photos", gate: "soft",
    present: (p) => anyRow(p.photos, (ph) => ph.stage === "after") },

  // ----- Inspections -----
  { id: "in_fail", form: "inspections", label: "No failed inspection without a reinspection scheduled", gate: "hard",
    present: (p) => !arr(p.inspections).some((i) => i.result === "fail" && !filled(i.reinspection)) },
  { id: "in_final", form: "inspections", label: "Final inspection passed (if required)", gate: "soft",
    present: (p) => arr(p.inspections).some((i) => /final/i.test(i.type || "") && i.result === "pass") },

  // ----- Selections -----
  { id: "se_decided", form: "selections", label: "No pending owner selections", gate: "soft",
    present: (p) => !p.selections || !anyRow(p.selections.rows, (r) => r.status === "pending") },

  // ----- Punch list -----
  { id: "pu_clear", form: "punchList", label: "Punch list cleared (all items done / verified)", gate: "hard",
    present: (p) => !!p.punchList && arr(p.punchList.rows).length > 0
      && arr(p.punchList.rows).every((r) => r.status === "done" || r.status === "verified") },

  // ----- Certificate of Completion -----
  { id: "cc_sig", form: "certCompletion", label: "Contractor sign-off (signed or uploaded)", gate: "hard",
    present: (p) => !!p.certCompletion && (filled(p.certCompletion.sigContractor) || arr(p.certCompletion.uploadedPages).length > 0) },
  { id: "cc_owner", form: "certCompletion", label: "Owner acceptance signature", gate: "soft",
    present: (p) => !!p.certCompletion && (filled(p.certCompletion.sigOwner) || arr(p.certCompletion.uploadedPages).length > 0) },

  // ----- Draws -----
  { id: "dr_paid", form: "drawSchedule", label: "Every invoiced draw marked paid", gate: "soft",
    present: (p) => !p.drawSchedule || !anyRow(p.drawSchedule.rows, (r) => filled(r.invoicedDate) && !filled(r.paidDate)) },
];

const FORM_LABELS = {
  workAuth: "Work Authorization", floorPlan: "Floor Plan", moistureMaps: "Moisture Map",
  dryingLogs: "Drying Log", photos: "Photo Log", certDrying: "Certificate of Drying",
  constructionLogs: "Daily Construction Log", laborLog: "Labor Log",
  contents: "Contents", changeOrders: "Change Order",
  scopeOfWork: "Scope of Work", preConChecklist: "Pre-Construction Checklist",
  selections: "Selections", subSchedule: "Sub Schedule", inspections: "Inspection Log",
  punchList: "Punch List", drawSchedule: "Draw Schedule", certCompletion: "Certificate of Completion",
};

/* ============================================================
   evaluateProject(project, conditionOverride?)
   Returns:
   {
     requiredCount, presentCount,
     hardGaps: [{id, form, formLabel, label}],
     softGaps: [...],
     isBillable: boolean,          // true only when there are NO hard gaps
     conditions: {cat3, contents, cleaning}
   }
   ============================================================ */
export function evaluateProject(project, conditionOverride = {}) {
  const p = project || {};
  const conditions = activeConditions(p, conditionOverride);

  // construction jobs use their own gate matrix (no cat3/contents add-ons)
  const matrix = jobType(p) === "construction" ? CONSTRUCTION_REQUIREMENTS : REQUIREMENTS;
  const applicable = matrix.filter((req) => !req.when || conditions[req.when]);

  const hardGaps = [], softGaps = [];
  let presentCount = 0;
  for (const req of applicable) {
    let ok = false;
    try { ok = !!req.present(p); } catch { ok = false; }
    if (ok) { presentCount++; continue; }
    const gap = { id: req.id, form: req.form, formLabel: FORM_LABELS[req.form] || req.form, label: req.label };
    (req.gate === "hard" ? hardGaps : softGaps).push(gap);
  }

  return {
    requiredCount: applicable.length,
    presentCount,
    hardGaps,
    softGaps,
    isBillable: hardGaps.length === 0,
    conditions,
  };
}

/* Convenience: a short human summary line for a panel/badge. */
export function summaryLine(result) {
  if (result.isBillable) {
    return result.softGaps.length
      ? `Ready to bill — ${result.softGaps.length} optional item(s) still open.`
      : "Complete — ready to bill.";
  }
  return `Not yet billable — ${result.hardGaps.length} required item(s) missing.`;
}

/* ============================================================
   panelModel(project) — DOM-free display model for the UI panel.
   Kept here (not in app.js) so it's unit-testable without a browser.
   The view layer just maps this to elements.
   ============================================================ */
export function panelModel(project) {
  const r = evaluateProject(project);
  const tone = !r.isBillable ? "blocked" : (r.softGaps.length ? "warn" : "ok");
  const icon = tone === "ok" ? "✅" : tone === "warn" ? "✅" : "⚠️";
  const groups = [];
  if (r.hardGaps.length)
    groups.push({ tone: "hard", title: "Required — blocks billing",
      items: r.hardGaps.map((g) => `${g.formLabel}: ${g.label}`) });
  if (r.softGaps.length)
    groups.push({ tone: "soft", title: "Recommended",
      items: r.softGaps.map((g) => `${g.formLabel}: ${g.label}`) });
  return {
    tone, icon,
    summary: summaryLine(r),
    progress: `${r.presentCount}/${r.requiredCount}`,
    isBillable: r.isBillable,
    groups,
    result: r,
  };
}
