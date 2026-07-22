/* ============================================================
   Office Admin — 💬 assistant provider (office-manager persona)
   ------------------------------------------------------------
   Admin mount for the shared Ask-the-Office assistant
   (../../js/assist.js). buildAdminContext() digests the shared
   local job store (same-origin IndexedDB the field app syncs)
   into the desk view: KPIs, an attention list, one compact row
   per job — plus QuickBooks connection state and how many
   customer portal messages are waiting. Async: assist.js awaits
   buildContext(), and every network lookup degrades to null
   rather than blocking an answer.
   ============================================================ */
import { Store, daysSince, todayISO } from "../../js/core.js";
import { rest, isSignedIn } from "../../js/supa.js";
import { qboStatus } from "../../js/qbo.js";
import { assistSend } from "../../js/sms.js";
import { draftAdjusterEmail, draftPortalMessage } from "../../js/officeai.js";
import { fetchPortalThread, portalDigest, threadForAi, sendOfficeReply } from "../../js/portal.js";
import { budgetStatus } from "../../js/fincalc.js";
import { runFinanceAction } from "./finactions.js";

/* mirrors admin.js jobAttention(): drying equipment on site ≥7 days */
const equipOut7 = (p) => (p.dryingLogs || []).some((d) =>
  (d.equipment || []).some((e) => e.placed && !e.removed && (daysSince(e.placed) ?? 0) >= 7));

function jobRow(p) {
  const budget = budgetStatus(p);   // null when no approved estimate / contract amount
  return {
    customer: p.customer || "Untitled job",
    address: p.address || "",
    claim: p.claimNo || "",
    cat: p.waterCategory ? "Cat " + p.waterCategory + (p.waterClass ? " / Cl " + p.waterClass : "") : "",
    updated: (p.updatedAt || "").slice(0, 10),
    moistureMaps: (p.moistureMaps || []).length,
    dryingLogs: (p.dryingLogs || []).length,
    photos: (p.photos || []).length,
    contents: (p.contents || []).length,
    equipmentOut7Days: equipOut7(p) || undefined,
    estimates: (p.reconEstimates || []).length || undefined,
    invoices: (p.invoices || []).length || undefined,
    ...(budget ? { budgetPct: budget.pct, overBudget: budget.over || undefined } : {}),
  };
}

/* QuickBooks state rarely changes — cache 5 minutes so asks stay snappy */
let qboCache = { at: 0, val: null };
async function quickbooks() {
  if (Date.now() - qboCache.at < 5 * 60 * 1000) return qboCache.val;
  try {
    const s = await qboStatus();
    qboCache = { at: Date.now(), val: { connected: !!(s && (s.connected ?? s.realmId)), ...(s && s.connectedBy ? { connectedBy: s.connectedBy } : {}) } };
  } catch (_) { qboCache = { at: Date.now(), val: null }; }
  return qboCache.val;
}

/* customer messages waiting in the portal (inbound, unread by the office).
   Signed-out the anon role "sees" zero rows — that must read as null
   (unknown), never as "no messages waiting". */
async function portalUnread() {
  if (!isSignedIn()) return null;
  try {
    const res = await rest("portal_messages?select=id&direction=eq.in&read_by_office=eq.false",
      { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } });
    if (!res.ok) return null;
    return Number((res.headers.get("content-range") || "").split("/")[1]) || 0;
  } catch (_) { return null; }
}

export async function buildAdminContext() {
  const projects = await Store.all().catch(() => []);
  const rows = projects.map(jobRow);
  const active = rows.filter((r) => r.updated && daysSince(r.updated) <= 7);
  const stale = rows.filter((r) => !r.updated || daysSince(r.updated) > 14);
  const equipFlags = rows.filter((r) => r.equipmentOut7Days);
  const budgetFlags = rows.filter((r) => r.overBudget);
  const [qbo, unread] = await Promise.all([quickbooks(), portalUnread()]);
  return {
    today: todayISO(),
    kpis: {
      totalJobs: rows.length,
      activeLast7Days: active.length,
      dryingInProgress: rows.filter((r) => r.dryingLogs > 0).length,
      equipmentOut7Days: equipFlags.length,
      overBudget: budgetFlags.length,
      staleOver14Days: stale.length,
    },
    needsAttention: [
      ...equipFlags.map((r) => r.customer + " (equipment out 7+ days)"),
      ...budgetFlags.map((r) => r.customer + ` (costs at ${r.budgetPct}% of budget)`),
    ],
    staleJobs: stale.slice(0, 15).map((r) => r.customer + (r.updated ? ` (last ${r.updated})` : " (never updated)")),
    quickbooks: qbo,                      // null = status unavailable right now
    portalMessagesWaiting: unread,        // null = portal unreachable right now
    jobs: rows.sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 50),
  };
}

/* ---------- assistant action executors (Phase 5 + Section 1 chips) ----------
   Drafting chips (adjuster email, portal reply) produce a DRAFT the owner
   reads in the thread — nothing is emailed, and a portal post takes a
   second confirm chip. Job-record writes from /admin happen ONLY through
   the financial chips in finactions.js — human-confirmed, one tap per
   write, never silent (the old "no mutations" invariant, upgraded). */

/* match exactly one shared-store project by customer/address fragment */
async function findProject(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return { err: "which job? none named" };
  const all = await Store.all().catch(() => []);
  const hits = all.filter((p) => `${p.customer || ""} ${p.address || ""}`.toLowerCase().includes(needle));
  if (!hits.length) return { err: `no job matches “${q}”` };
  if (hits.length > 1) {
    const exact = hits.filter((p) => String(p.customer || "").toLowerCase() === needle);
    if (exact.length === 1) return { hit: exact[0] };
    return { err: `${hits.length} jobs match “${q}” — be more specific` };
  }
  return { hit: hits[0] };
}

async function adjusterEmailChip(params) {
  const m = await findProject(params.job);
  if (m.err) return { ok: false, detail: m.err };
  const draft = await draftAdjusterEmail(m.hit);
  const text = `✉️ Draft adjuster email — ${m.hit.customer || "job"}\n\nSubject: ${draft.subject || ""}\n\n${draft.body || ""}`;
  try { await navigator.clipboard.writeText(`Subject: ${draft.subject || ""}\n\n${draft.body || ""}`); } catch (_) { /* clipboard is a bonus */ }
  return { ok: true, detail: "draft below — copied to the clipboard, nothing was emailed", message: text };
}

async function portalReplyChip(params) {
  const m = await findProject(params.job);
  if (m.err) return { ok: false, detail: m.err };
  const p = m.hit;
  const portalJobId = p.portalShare && p.portalShare.id;
  if (!portalJobId) return { ok: false, detail: `${p.customer || "that job"} isn't shared to the customer portal yet` };
  const mode = params.mode === "status" ? "status" : "reply";
  const thread = await fetchPortalThread(portalJobId);
  const draft = await draftPortalMessage(p, mode, portalDigest(p), threadForAi(thread));
  if (!draft) return { ok: false, detail: "the draft came back empty — try again" };
  return {
    ok: true, detail: "draft below — posts only if you confirm the next chip",
    message: `🧡 Portal ${mode === "status" ? "status update" : "reply"} draft — ${p.customer || "job"}\n\n${draft}`,
    // review → second confirm: the post itself is its own chip
    followup: { type: "portalPost", label: `Post to ${p.customer || "the customer"}'s portal thread`, params: { portalJobId, message: draft } },
  };
}

async function portalPostChip(params) {
  const text = String(params.message || "").trim();
  const id = params.portalJobId;
  if (!id || !text) return { ok: false, detail: "nothing to post" };
  await sendOfficeReply(id, text, "office");
  return { ok: true, detail: "posted to the portal thread" };
}

function runAdminAction(a) {
  const p = (a && a.params) || {};
  switch (a && a.type) {
    case "sendText": return assistSend({ to: p.to, message: p.message, audience: p.audience, by: "office" });
    case "adjusterEmail": return adjusterEmailChip(p);
    case "portalReply": return portalReplyChip(p);
    case "portalPost": return portalPostChip(p);
    default:
      return runFinanceAction(a) ?? { ok: false, detail: "not available in the office admin" };
  }
}

/** The provider assist.js mounts — see mountAssistProvider(). */
export function adminAssistProvider() {
  return {
    key: "admin",
    app: "admin",
    title: "💬 Ask the office",
    sub: "Office manager · every job at a glance",
    greeting: () =>
      "Hey — ask me what needs attention: stale jobs, equipment out too long, budgets running hot, " +
      "customer messages waiting, drying status, QuickBooks. I answer from the dashboard's live data, " +
      "and I can queue up estimates, invoices, change orders, receipts, texts, or drafts — you confirm every one with a tap.",
    capturedBy: () => "office",
    buildContext: buildAdminContext,
    executeAction: runAdminAction,
  };
}
