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

/* PURE + TESTABLE — the readings-only drying summary (CF-2). Facts a meter
   measured, nothing predictive: per moisture-map area the LATEST row's
   wettest reading vs the dry goal, plus how many machines are still out.
   Deliberately NO trend and NO ETA — the portal's shipped discipline is
   that dates and commitments are human-only, and the concierge is grounded
   in this slice, so an auto-computed date here would become an AI-repeatable
   promise (docs/CRM_Design.md §8 CF-2). */
export function dryingSummary(project) {
  const p = project || {};
  const areas = [];
  let asOf = "";
  for (const m of arr(p.moistureMaps)) {
    const rows = arr(m && m.readings).filter((r) => r && r.date);
    if (!rows.length) continue;
    const latest = rows.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
    const vals = arr(latest.values).map((v) => parseFloat(v)).filter((n) => Number.isFinite(n));
    if (!vals.length) continue;
    const current = Math.round(Math.max(...vals) * 10) / 10;
    const goal = parseFloat(m.dryGoal);
    areas.push({
      area: m.label || "Affected area",
      material: m.material || "",
      current,
      goal: Number.isFinite(goal) ? goal : null,
      dry: Number.isFinite(goal) ? current <= goal : false,
    });
    if (String(latest.date) > asOf) asOf = String(latest.date);
  }
  let equipmentOut = 0;
  for (const d of arr(p.dryingLogs))
    for (const e of arr(d && d.equipment))
      if (e && e.placed && !e.removed) equipmentOut++;
  if (!areas.length && !equipmentOut) return null;
  return { asOf, areas, equipmentOut };
}

/* PURE + TESTABLE — the customer-safe projection. Only these fields ever
   reach the portal; nothing internal is read here. */
export function portalProjection(project) {
  const p = project || {};
  const share = p.portalShare || {};
  const sharedIds = new Set(arr(share.sharedPhotoIds));
  const photos = arr(p.photos)
    .filter((ph) => ph && ph.src && sharedIds.has(ph.id))
    .map((ph) => ({ id: ph.id, src: ph.src, cloud: ph.cloud || "", caption: ph.caption || "", stage: ph.stage || "" }));
  // documents: only the supportDocs the office ticked, and only their pages
  // (uploaded scans/PDF pages are stored as data:image strings, same as
  // photos). The aiDigest and any other internal field is never read.
  const sharedDocs = new Set(arr(share.sharedDocIds));
  const documents = arr(p.supportDocs)
    .filter((d) => d && sharedDocs.has(d.id) && arr(d.uploadedPages).length)
    .map((d) => ({
      id: d.id,
      label: d.title || d.docType || "Document",
      type: d.docType || "",
      pages: arr(d.uploadedPages).filter((pg) => typeof pg === "string" && pg.startsWith("data:image/")),
    }))
    .filter((d) => d.pages.length);
  return {
    customer_name: p.customer || "",
    property_address: p.address || "",
    status: share.status || "",
    statusLabel: portalMilestoneLabel(share.status),
    milestones: portalMilestones(share.status),
    photos,   // still carries the data URL here; publishPortal swaps to media hashes
    documents, // page data URLs here; publishPortal swaps to media hashes
    drying: share.shareDrying ? dryingSummary(p) : null,
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
    // an offloaded photo's bucket hash IS its full-res object — hashing the
    // inline src would point the portal at a 480px thumb that isn't uploaded
    photos.push({ mediaHash: ph.cloud || await sha256Hex(ph.src), caption: ph.caption, stage: ph.stage });
  }
  // documents: pages are content-addressed in the same media bucket the sync
  // offload writes (scanned pages exceed the 8KB offload floor in practice),
  // so their sha256 IS the bucket path — the same contract photos ride.
  const documents = [];
  for (const d of proj.documents || []) {
    const pages = [];
    for (const pg of d.pages) pages.push(await sha256Hex(pg));
    if (pages.length) documents.push({ label: d.label, type: d.type, pages });
  }
  // the spine link: this used to write unified_job_id: null — the portal row
  // now rides the crosswalk (and carries the person) when the spine has one.
  // Best-effort AND non-destructive: a failed/empty lookup must OMIT these
  // columns from the merge-duplicates upsert (the spine.js delete-key
  // precedent) so a transient GET can never null out a backfilled or
  // office-set link. Only a successful lookup writes them.
  let spineLink = null;
  try {
    const sr = await rest(`unified_jobs?field_project_id=eq.${project.id}&select=id,contact_id&limit=1`, { method: "GET" });
    if (sr.ok) {
      const s = (await sr.json())[0] || null;
      if (s && s.id) spineLink = { unified_job_id: s.id, contact_id: s.contact_id || null };
    }
  } catch { /* leave spineLink null → the columns are omitted, links untouched */ }
  const row = {
    id: share.id,
    field_project_id: project.id || null,
    ...(spineLink || {}),
    share_token: share.shareToken,
    enabled: !!share.enabled,
    customer_name: proj.customer_name,
    property_address: proj.property_address,
    status: proj.status,
    milestones: proj.milestones,
    photos,
    documents,
    drying: proj.drying,
    notify_crew: share.notifyCrew !== false,   // the who's-coming-today toggle (default on)
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
  const row = (await res.json())[0];
  mirrorReplyToSms(portalJobId, text).catch(() => {});   // bridge: best-effort, never blocks the thread post
  return row;
}

/* SMS bridge, outbound half (CF-2 / portal M2): when the customer's LATEST
   inbound message arrived by text, they're conversing over SMS — so the
   office reply is also texted to the phone on file (kind 'portal', the
   authenticated lane roybal-notify reserved for exactly this). Customers
   using the web thread get no duplicate texts. */
async function mirrorReplyToSms(portalJobId, text) {
  const { rest, callFunction } = await import("./supa.js");
  const last = await rest(`portal_messages?portal_job_id=eq.${portalJobId}&direction=eq.in&select=channel&order=created_at.desc&limit=1`, { method: "GET" });
  if (!last.ok) return;
  const m = (await last.json())[0];
  if (!m || m.channel !== "sms") return;
  const pj = await rest(`portal_jobs?id=eq.${portalJobId}&select=contact_id&limit=1`, { method: "GET" });
  const cid = pj.ok ? ((await pj.json())[0] || {}).contact_id : null;
  if (!cid) return;
  const cr = await rest(`contacts?id=eq.${cid}&select=phone_norm&limit=1`, { method: "GET" });
  const phone = cr.ok ? String(((await cr.json())[0] || {}).phone_norm || "") : "";
  if (phone.length !== 10) return;
  await callFunction("roybal-notify", {
    action: "sendSms", to: phone, kind: "portal", captured_by: "portal-bridge",
    body: "Roybal Construction: " + text.slice(0, 280) + " — reply to this text or see your project page.",
  });
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
