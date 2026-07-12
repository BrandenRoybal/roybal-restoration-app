/* ============================================================
   Roybal Field Forms — restoration → construction conversion (pure)
   ------------------------------------------------------------
   convertToConstruction(rest) builds a NEW construction (rebuild)
   project from a restoration job — a copy, never a mutation. The
   caller (app.js) saves both sides and sets the back-link
   (linkedConstructionId) on the original.

   Carried over:
   - customer/contact/insurance header (rebuilds are usually the same
     claim, so carrier/adjuster/claim # stay relevant)
   - photos — the mitigation record becomes the rebuild's "before"
     context (stage forced to "before", original stage kept in the caption)
   - the Floor Plan form's dimensioned pages → Scope of Work reference
     plans (moisture-map sketches only when no floor plan was uploaded)
   - the AI narrative + change-order summaries → mitigationRef, a small
     read-only reference block (offline context + the AI fact pack)

   rebuildFacts(rest) digests the restoration job into the compact fact
   pack the roybal-ai-office `rebuildDraft` action writes the rebuild
   plan from. Pure + Node-testable (no DOM, no network).
   ============================================================ */
import { uid } from "./core.js";
import { newProject, newScopeOfWork } from "./model.js";
import { narrativeFacts } from "./narrative.js";

const arr = (v) => (Array.isArray(v) ? v : []);

/* Header fields that carry over verbatim. */
const HEADER_FIELDS = [
  "customer", "address", "phone", "email",
  "carrier", "adjuster", "claimNo", "lossCause", "dateOfLoss",
];

/* Byte budgets on copied media. The blob syncs whole to coordination_jobs
   and sync.js silently skips rows over 5MB (MAX_ROW) — a rebuild job born
   multi-MB would never leave the device. The copy is CONTEXT, not archive:
   the full set stays one tap away on the linked mitigation job. */
export const PHOTO_BUDGET = 2_500_000;
export const PLAN_BUDGET = 1_500_000;
const STAGE_RANK = { after: 0, during: 1, before: 2 };   // end-state photos matter most to a rebuild

function pickPhotos(photos) {
  const usable = arr(photos).filter((ph) => ph && ph.src);
  const ranked = usable.slice().sort((a, b) =>
    (STAGE_RANK[a.stage] ?? 3) - (STAGE_RANK[b.stage] ?? 3) ||
    String(b.ts || "").localeCompare(String(a.ts || "")));
  const picked = new Set();
  let bytes = 0;
  for (const ph of ranked) {
    const size = String(ph.src).length;
    if (bytes + size > PHOTO_BUDGET) continue;
    bytes += size;
    picked.add(ph);
  }
  return { picked: usable.filter((ph) => picked.has(ph)), leftBehind: usable.length - picked.size };
}

/* Reference-plan sources, in preference order: the Floor Plan form's
   uploaded dimensioned pages (drawn for the adjuster — readable SF/LF),
   then moisture-map sketches/photos for older jobs without one. */
function planSources(r) {
  const fp = r.floorPlan || {};
  const pages = (fp.uploadedPages && fp.uploadedPages.length ? fp.uploadedPages
    : fp.uploadedDoc ? [fp.uploadedDoc] : []).filter(Boolean);
  if (pages.length) return pages;
  return arr(r.moistureMaps).map((m) => m.sketch || m.floorPlan).filter(Boolean);
}

function pickPlans(all) {
  const picked = [];
  let bytes = 0;
  for (const src of all) {
    const size = String(src).length;
    if (bytes + size > PLAN_BUDGET) continue;
    bytes += size;
    picked.push(src);
  }
  return { picked, leftBehind: all.length - picked.length };
}

export function convertToConstruction(rest) {
  const r = rest || {};
  const p = newProject();
  p.jobType = "construction";
  p.constructionType = "reconstruction";
  p.linkedRestorationId = r.id || "";
  for (const k of HEADER_FIELDS) p[k] = r[k] || "";
  p.rooms = arr(r.rooms).slice();

  // photos: the mitigation record becomes rebuild "before" context (budgeted)
  const photos = pickPhotos(r.photos);
  p.photos = photos.picked.map((ph) => ({
    id: uid(),
    src: ph.src,
    room: ph.room || "",
    stage: "before",
    caption: ["Mitigation" + (ph.stage ? " (" + ph.stage + ")" : ""), ph.caption || ""]
      .filter(Boolean).join(": "),
    ts: ph.ts || new Date().toISOString(),
  }));

  // floor-plan pages (fallback: moisture-map sketches) → Scope of Work
  // reference plans (budgeted)
  const plans = pickPlans(planSources(r));
  if (plans.picked.length) {
    p.scopeOfWork = newScopeOfWork();
    p.scopeOfWork.referencePlans = plans.picked;
  }

  // the plan takeoff (room SF/LF — small, no images) rides along so the
  // rebuild's own fact digests keep planDimensions without a re-run
  if (r.floorPlan && r.floorPlan.dimensions && arr(r.floorPlan.dimensions.rooms).length) {
    p.floorPlan = {
      createdAt: new Date().toISOString(),
      mode: "upload",
      uploadedPages: [],
      dimensions: JSON.parse(JSON.stringify(r.floorPlan.dimensions)),
    };
  }

  // read-only mitigation reference (kept small — no images)
  p.mitigationRef = {
    fromProjectId: r.id || "",
    convertedAt: new Date().toISOString(),
    narrative: r.narrative || "",
    changeOrders: arr(r.changeOrders)
      .map((c) => ({ no: c.coNo || "", date: c.coDate || "", description: c.description || "" }))
      .filter((c) => c.no || c.description),
    photosLeftBehind: photos.leftBehind,
    plansLeftBehind: plans.leftBehind,
  };

  return p;
}

/* ---------- fact pack for the AI rebuild draft ---------- */

/* Non-salvageable contents grouped by room — tells the estimator what
   was lost (e.g. carpet, furniture) and therefore what the rebuild
   likely replaces or the owner re-selects. */
function contentsLoss(rest) {
  const byRoom = new Map();
  for (const it of arr(rest.contents)) {
    if (it.disposition !== "non-salvageable") continue;
    const room = (it.room || "Unspecified").trim();
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push([it.qty && it.qty !== "1" ? it.qty + "× " : "", it.name || "item",
      it.category ? ` (${it.category})` : ""].join(""));
  }
  return [...byRoom.entries()].map(([room, items]) => ({ room, items: items.slice(0, 20) }));
}

/* Demo extent from moisture-map row notes + drying-log / construction-log
   task text — flood cuts, tear-outs, what came off the structure. */
function demoNotes(rest) {
  const notes = new Set();
  for (const m of arr(rest.moistureMaps)) {
    for (const row of arr(m.readings)) if (row.notes) notes.add(String(row.notes).trim());
  }
  for (const c of arr(rest.constructionLogs)) {
    for (const row of arr(c.rows)) if (row.task) notes.add(String(row.task).trim());
  }
  return [...notes].filter(Boolean).slice(0, 40);
}

export function rebuildFacts(rest) {
  const r = rest || {};
  const f = narrativeFacts(r);
  return {
    job: f.job,
    affectedAreas: f.affectedAreas,   // material, dry goal, wet→dry per area
    drying: f.drying,
    changeOrders: f.changeOrders,     // supplements often describe the demo scope
    planDimensions: f.planDimensions, // room SF/LF off the uploaded dimensioned plan
    supportingDocs: f.supportingDocs, // engineer's reports etc. — digests the estimator can cite
    demoNotes: demoNotes(r),
    contentsLoss: contentsLoss(r),
    rooms: arr(r.rooms),
    narrative: String(r.narrative || "").slice(0, 4000),
  };
}
