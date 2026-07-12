/* ============================================================
   Roybal Field Forms — customer portal projection (Phase A1)
   ------------------------------------------------------------
   portalProjection(project) is the PURE, customer-safe slice of a job —
   status, milestone timeline, and the photos the office chose to share.
   It contains ONLY curated fields; internal data (costs, adjuster, Field
   Reports, labor, narrative) is never read, so it cannot leak.

   publishPortal(project) writes that slice to the `portal_jobs` table,
   swapping each shared photo's data URL for its media-bucket hash — the
   roybal-portal gateway (Phase A2) signs short-lived URLs for those at
   view time, so the row stays tiny and the bucket stays private. supa.js
   and media.js are imported lazily so this module (and portalProjection's
   test) load under Node.
   ============================================================ */
import { PORTAL_MILESTONES, portalMilestoneLabel } from "./model.js";

const arr = (v) => (Array.isArray(v) ? v : []);

/* the milestone timeline with the office-chosen current one marked */
export function portalMilestones(status) {
  const order = PORTAL_MILESTONES.map((m) => m.key);
  const cur = order.indexOf(status);
  return PORTAL_MILESTONES.map((m, i) => ({
    key: m.key, label: m.label,
    state: cur < 0 ? "upcoming" : i < cur ? "done" : i === cur ? "current" : "upcoming",
  }));
}

/* PURE + TESTABLE — the customer-safe projection. Only these fields ever
   reach the portal; nothing internal is read here. */
export function portalProjection(project) {
  const p = project || {};
  const share = p.portalShare || {};
  const sharedIds = new Set(arr(share.sharedPhotoIds));
  const photos = arr(p.photos)
    .filter((ph) => ph && ph.src && sharedIds.has(ph.id))
    .map((ph) => ({ id: ph.id, src: ph.src, caption: ph.caption || "", stage: ph.stage || "" }));
  return {
    customer_name: p.customer || "",
    property_address: p.address || "",
    status: share.status || "",
    statusLabel: portalMilestoneLabel(share.status),
    milestones: portalMilestones(share.status),
    photos,   // still carries the data URL here; publishPortal swaps to media hashes
  };
}

/* the public link a customer opens (Phase A2 resolves it via the gateway) */
export function portalShareLink(token) {
  return token ? `https://portal.roybalconstruction.com/j/${token}` : "";
}

/* long, unguessable, URL-safe share token — the Phase-A bearer credential */
export function newShareToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* async: publish the curated slice to portal_jobs (upsert by the stable
   portalShare.id, so re-publishing updates in place). */
export async function publishPortal(project) {
  const { sha256Hex } = await import("./media.js");
  const { rest } = await import("./supa.js");
  const share = project.portalShare || {};
  const proj = portalProjection(project);
  const photos = [];
  for (const ph of proj.photos) {
    photos.push({ mediaHash: await sha256Hex(ph.src), caption: ph.caption, stage: ph.stage });
  }
  const row = {
    id: share.id,
    field_project_id: project.id || null,
    unified_job_id: null,
    share_token: share.shareToken,
    enabled: !!share.enabled,
    customer_name: proj.customer_name,
    property_address: proj.property_address,
    status: proj.status,
    milestones: proj.milestones,
    photos,
    documents: [],
    published_at: new Date().toISOString(),
  };
  const res = await rest("portal_jobs", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error("Publish failed (" + res.status + "): " + (await res.text().catch(() => "")));
  return row;
}
