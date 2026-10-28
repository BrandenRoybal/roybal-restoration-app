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
import { jobType, portalMilestoneTrack, portalMilestoneLabel, portalMilestoneNudge, portalStatusFor } from "./model.js";

const arr = (v) => (Array.isArray(v) ? v : []);

/* the milestone timeline with the office-chosen current one marked, on the
   job kind's own track (restoration unless `kind` says construction) */
export function portalMilestones(status, kind) {
  const track = portalMilestoneTrack(kind);
  const order = track.map((m) => m.key);
  const cur = order.indexOf(portalStatusFor(status, kind));
  return track.map((m, i) => ({
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
  const kind = jobType(p);
  const status = share.status ? portalStatusFor(share.status, kind) : "";
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
  // closeout (CF-4): the permanent record, projected only once the job is
  // complete. Office-curated rows only — label/value strings, nothing read
  // from internal data.
  const co = share.closeout || null;
  const closeout = status === "complete" && co ? {
    completedAt: String(co.completedAt || "").slice(0, 10),
    warrantyMonths: Number(co.warrantyMonths) || 0,
    homeFile: arr(co.homeFile)
      .filter((r) => r && (r.label || r.value))
      .slice(0, 40)
      .map((r) => ({ label: String(r.label || "").slice(0, 80), value: String(r.value || "").slice(0, 200) })),
  } : null;
  // claim panel: OFF unless the office turned it on. Carrier, claim number
  // and date of loss come from the job; where the claim stands and the
  // deductible are what the office sets on the form. The adjuster, our
  // estimate and every amount but the customer's own deductible stay out.
  const cl = share.claim || null;
  const deductible = cl ? parseFloat(cl.deductible) : NaN;
  const claim = cl && cl.show ? {
    carrier: String(p.carrier || "").slice(0, 80),
    claimNo: String(p.claimNo || "").slice(0, 60),
    dateOfLoss: /^\d{4}-\d{2}-\d{2}$/.test(String(p.dateOfLoss || "")) ? String(p.dateOfLoss) : "",
    stage: String(cl.stage || ""),
    deductible: Number.isFinite(deductible) && deductible > 0 ? deductible : 0,
    deductibleState: ["due", "paid"].includes(cl.deductibleState) ? cl.deductibleState : "",
  } : null;
  return {
    customer_name: p.customer || "",
    property_address: p.address || "",
    status,
    statusLabel: portalMilestoneLabel(status, kind),
    milestones: portalMilestones(status, kind),
    photos,   // still carries the data URL here; publishPortal swaps to media hashes
    documents, // page data URLs here; publishPortal swaps to media hashes
    drying: share.shareDrying ? dryingSummary(p) : null,
    closeout,
    claim,
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
    closeout: proj.closeout,
    notify_crew: share.notifyCrew !== false,   // the who's-coming-today toggle (default on)
    published_at: new Date().toISOString(),
    // only once the office has touched the panel, so turning it off clears it
    ...(share.claim ? { claim: proj.claim } : {}),
  };
  const post = (r) => rest("portal_jobs", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([r]),
  });
  let res = await post(row);
  // Before migration 0009 applies, the column doesn't exist and PostgREST
  // refuses the whole row. Publish everything else rather than nothing; the
  // panel appears on the next publish after the column lands.
  if (!res.ok && "claim" in row && res.status === 400) {
    const { claim: _skip, ...rest0 } = row;
    res = await post(rest0);
  }
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
/* `ping` (optional) replaces the generic update text for a post the customer
   must act on — a document waiting on their signature — and goes out even if
   an update text went out earlier in the window. */
export async function sendOfficeReply(portalJobId, body, author = "office", { ping = "" } = {}) {
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
  mirrorReplyToSms(portalJobId, text, ping).catch(() => {});   // bridge: best-effort, never blocks the thread post
  return row;
}

/* Customers who use the web page, not texts, heard nothing when we posted:
   13 of the first 40 office updates were never opened. So every office post
   now reaches the phone on file one of two ways:
     - the customer's LATEST inbound message came by text → they're
       conversing over SMS, so the reply itself is texted (the bridge);
     - otherwise → a short "new update, here's your link" text, at most one
       per job per UPDATE_PING_HOURS, so a busy day is one text, not five.
   Both ride kind 'portal', so roybal-notify's 7am–8pm Alaska window applies:
   an evening post texts nothing and the next daytime post carries the ping.
   PURE + TESTABLE: the decision; mirrorReplyToSms does the I/O. */
export const UPDATE_PING_HOURS = 20;
export function portalSmsPlan({ lastInboundChannel, phone, shareToken, pingedRecently, text, ping }) {
  if (String(phone || "").length !== 10) return null;
  if (lastInboundChannel === "sms") {
    return { captured_by: "portal-bridge",
      body: "Roybal Construction: " + String(text || "").slice(0, 280) + " — reply to this text or see your project page." };
  }
  const link = portalShareLink(/^[0-9a-f]{16,}$/i.test(String(shareToken || "")) ? shareToken : "");
  if (!link) return null;
  if (ping) return { captured_by: "portal-update", body: "Roybal Construction: " + String(ping).slice(0, 200) + " " + link };
  if (pingedRecently) return null;
  return { captured_by: "portal-update",
    body: "Roybal Construction: there's a new update on your project. See it here: " + link };
}

async function mirrorReplyToSms(portalJobId, text, ping = "") {
  const { rest, callFunction } = await import("./supa.js");
  const last = await rest(`portal_messages?portal_job_id=eq.${portalJobId}&direction=eq.in&select=channel&order=created_at.desc&limit=1`, { method: "GET" });
  if (!last.ok) return;
  const m = (await last.json())[0] || null;
  const pj = await rest(`portal_jobs?id=eq.${portalJobId}&enabled=eq.true&select=contact_id,share_token&limit=1`, { method: "GET" });
  const job = pj.ok ? ((await pj.json())[0] || null) : null;
  if (!job || !job.contact_id) return;
  const cr = await rest(`contacts?id=eq.${job.contact_id}&select=phone_norm&limit=1`, { method: "GET" });
  const phone = cr.ok ? String(((await cr.json())[0] || {}).phone_norm || "") : "";
  let pingedRecently = false;
  if (!(m && m.channel === "sms") && phone.length === 10 && !ping) {
    // failed rows don't count: a send the window refused may go on the next post
    const since = new Date(Date.now() - UPDATE_PING_HOURS * 3600_000).toISOString();
    const r = await rest(`sms_messages?direction=eq.outbound&sent_by=eq.portal-update` +
      `&to_number=eq.${encodeURIComponent("+1" + phone)}&status=neq.failed` +
      `&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`, { method: "GET" });
    // an unreadable log means we can't prove it's quiet — skip rather than risk repeats
    pingedRecently = !r.ok || ((await r.json()) || []).length > 0;
  }
  const plan = portalSmsPlan({ lastInboundChannel: m && m.channel, phone, shareToken: job.share_token, pingedRecently, text, ping });
  if (!plan) return;
  await callFunction("roybal-notify", { action: "sendSms", to: phone, kind: "portal", ...plan });
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
export async function postMilestoneNudge(portalJobId, status, kind) {
  const text = portalMilestoneNudge(status, kind);
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
