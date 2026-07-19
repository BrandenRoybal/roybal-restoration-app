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

/* mirrors admin.js jobAttention(): drying equipment on site ≥7 days */
const equipOut7 = (p) => (p.dryingLogs || []).some((d) =>
  (d.equipment || []).some((e) => e.placed && !e.removed && (daysSince(e.placed) ?? 0) >= 7));

function jobRow(p) {
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
  const attention = rows.filter((r) => r.equipmentOut7Days);
  const [qbo, unread] = await Promise.all([quickbooks(), portalUnread()]);
  return {
    today: todayISO(),
    kpis: {
      totalJobs: rows.length,
      activeLast7Days: active.length,
      dryingInProgress: rows.filter((r) => r.dryingLogs > 0).length,
      equipmentOut7Days: attention.length,
      staleOver14Days: stale.length,
    },
    needsAttention: attention.map((r) => r.customer),
    staleJobs: stale.slice(0, 15).map((r) => r.customer + (r.updated ? ` (last ${r.updated})` : " (never updated)")),
    quickbooks: qbo,                      // null = status unavailable right now
    portalMessagesWaiting: unread,        // null = portal unreachable right now
    jobs: rows.sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 50),
  };
}

/** The provider assist.js mounts — see mountAssistProvider(). */
export function adminAssistProvider() {
  return {
    key: "admin",
    app: "admin",
    title: "💬 Ask the office",
    sub: "Office manager · every job at a glance",
    greeting: () =>
      "Hey — ask me what needs attention: stale jobs, equipment out too long, " +
      "customer messages waiting, drying status, QuickBooks. I answer from the dashboard's live data.",
    capturedBy: () => "office",
    buildContext: buildAdminContext,
  };
}
