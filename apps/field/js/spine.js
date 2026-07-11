/* ============================================================
   Roybal Field Forms — Job Spine sync (backbone crosswalk)
   ------------------------------------------------------------
   Keeps a typed `unified_jobs` row in step with each field job, and
   links it to the matching Board job (`coordination_jobs`) by claim #.
   This is the "single source of truth" crosswalk from the architecture
   doc: one spine row per field job, carrying the IDs that tie the
   field app, the Board, and (later) QBO together.

   DESIGN RULES
   - FAIL-SAFE: never throws into the app, never blocks the offline UI.
     If offline / not signed in / table missing, it quietly no-ops.
   - Requires migration 200_ai_backbone.sql to be applied (the
     unified_jobs table + unique(field_project_id) upsert key).
   - The network paths can only be verified against a live Supabase;
     the pure mapping/matching functions below are unit-tested.
   ============================================================ */
import { rest, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";
import { jobType } from "./model.js";

/* Map a field project (blob) onto the typed unified_jobs columns. Pure. */
export function toUnifiedRow(project, coordinationJobId = null) {
  const s = (v) => (v == null || v === "" ? null : String(v));
  return {
    field_project_id:    project.id,
    coordination_job_id: coordinationJobId || null,
    claim_number:        s(project.claimNo),
    insurance_carrier:   s(project.carrier),
    adjuster_name:       s(project.adjuster),
    property_address:    s(project.address),
    owner_name:          s(project.customer),
    owner_phone:         s(project.phone),
    owner_email:         s(project.email),
    date_of_loss:        s(project.dateOfLoss),
    loss_type:           jobType(project) === "construction" ? "construction" : "water",
    water_category:      s(project.waterCategory),
    water_class:         s(project.waterClass),
  };
}

/* Normalize a claim number for tolerant matching: drop spaces/dashes, upper. Pure. */
export function normClaim(v) {
  return String(v || "").replace(/[\s\-_.]/g, "").toUpperCase();
}

/* Given coordination_jobs rows ({id, data}), find the one whose claim #
   matches `claimNo`. Returns the row id or null. Pure. */
export function matchCoordinationId(coordRows, claimNo) {
  const target = normClaim(claimNo);
  if (!target) return null;
  for (const r of coordRows || []) {
    const d = (r && r.data) || {};
    const c = d.claimNo || d.claimNumber || d.claim;
    if (c && normClaim(c) === target) return r.id;
  }
  return null;
}

/* Cache of field_project_id -> unified_jobs.id, populated on a successful
   upsert. Lets the voice-capture path tag capture_events with the spine row
   without re-querying. Best-effort: null when the spine hasn't synced yet
   (the Edge Function tolerates a null unified_job_id). */
const _unifiedIds = new Map();
export function getUnifiedJobId(projectId) {
  return _unifiedIds.get(projectId) || null;
}

/* Upsert the spine row for a field project, linking the Board job when a
   claim # matches. Fire-and-forget safe: always resolves, never throws. */
export async function syncSpine(project) {
  if (!SYNC_ENABLED || !isSignedIn() || !project || !project.id) return { skipped: true };
  try {
    // 1. try to find a Board job with the same claim number
    let coordId = null;
    if (project.claimNo) {
      const res = await rest(`coordination_jobs?select=id,data&deleted=is.false`, { method: "GET" });
      if (res.ok) coordId = matchCoordinationId(await res.json(), project.claimNo);
    }
    // 2. upsert the spine row keyed by field_project_id
    const spineRow = toUnifiedRow(project, coordId);
    // No claim match ≠ no link: the board push (boardpush.linkSpine) may have
    // set coordination_job_id already — omit the column so the merge-duplicates
    // upsert leaves an existing link alone instead of nulling it every render.
    if (!coordId) delete spineRow.coordination_job_id;
    const res2 = await rest(`unified_jobs?on_conflict=field_project_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([spineRow]),
    });
    if (!res2.ok) return { ok: false, status: res2.status };
    const rows = await res2.json().catch(() => []);
    const row = rows[0] || null;
    if (row && row.id) _unifiedIds.set(project.id, row.id);
    return { ok: true, row, coordinationLinked: !!coordId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
