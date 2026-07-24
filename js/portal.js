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
import { PORTAL_MILESTONES, portalMilestoneLabel, portalMilestoneNudge } from "./model.js";

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

/* ---------- portal message thread (office side) ----------
   The customer <-> office conversation lives in portal_messages, keyed by
   the portal_jobs row id — which equals portalShare.id (the upsert key). The
   crew hits this table directly over the authenticated REST session; the
   customer reaches the same thread only through the roybal-portal gateway. */

/* the whole thread for a shared job, oldest first */
export async function fetchPortalThread(portalJobId) {
  if (!portalJobId) return [];
  const { rest } = await import("./supa.js");
  const q = `portal_messages?portal_job_id=eq.${portalJobId}` +
    `&select=id,direction,author,body,channel,read_by_office,created_at&order=created_at.asc`;
  const res = await rest(q, { method: "GET" });
  if (!res.ok) throw new Error("Thread load failed (" + res.status + ")");
  return res.json();
}

/* office (or an approved AI draft) replies to the customer */
export async function sendOfficeReply(portalJobId, body, author = "office") {
  const text = (body || "").trim();
  if (!portalJobId || !text) throw new Error("Nothing to send");
  const { rest } = await import("./supa.js");
  const res = await rest("portal_messages", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      portal_job_id: portalJobId,
      direction: "out",
      channel: "portal",
      author,
      body: text,
      read_by_office: true,
      read_by_customer: false,
    }]),
  });
  if (!res.ok) throw new Error("Send failed (" + res.status + ")");
  return (await res.json())[0];
}

/* PURE + customer-safe: the digest handed to portal AI drafts. Built from the
   curated projection only (status, milestone labels, shared-photo captions) —
   never internal facts — so an AI draft physically cannot reference anything
   the customer shouldn't see. The message thread is passed separately. */
export function portalDigest(project) {
  const proj = portalProjection(project);
  return {
    customerName: proj.customer_name,
    address: proj.property_address,
    statusLabel: proj.statusLabel,
    milestones: proj.milestones.map((m) => ({ label: m.label, state: m.state })),
    sharedPhotos: proj.photos.map((p) => ({ caption: p.caption, stage: p.stage })),
  };
}

/* map a stored thread (portal_messages rows) to the {from,body} shape the AI
   draft action reads — customer messages vs ours. */
export function threadForAi(messages) {
  return (messages || []).map((m) => ({ from: m.direction === "in" ? "customer" : "office", body: m.body || "" }));
}

/* proactive milestone nudge: post the friendly line for `status` to the thread
   as an office message (customer sees it as from the company). Returns the
   saved row, or null when there's no template for that status. */
export async function postMilestoneNudge(portalJobId, status) {
  const text = portalMilestoneNudge(status);
  if (!portalJobId || !text) return null;
  return sendOfficeReply(portalJobId, text, "office");
}

/* mark the customer's inbound messages as seen by the office */
export async function markThreadReadByOffice(portalJobId) {
  if (!portalJobId) return;
  const { rest } = await import("./supa.js");
  await rest(
    `portal_messages?portal_job_id=eq.${portalJobId}&direction=eq.in&read_by_office=eq.false`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read_by_office: true }) },
  ).catch(() => {});
}
