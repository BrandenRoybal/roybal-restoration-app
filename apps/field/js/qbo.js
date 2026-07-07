/* ============================================================
   Roybal — QuickBooks ONLINE client (invoice push)
   ------------------------------------------------------------
   Thin wrapper over the `qbo-proxy` Edge Function. This is a separate
   Intuit connection from QuickBooks Time (TSheets tokens can't call
   the QBO Accounting API) — the office connects it once from the
   admin, then invoices push from the invoice form. No secrets here.
   ============================================================ */
import { callFunction, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";

async function proxy(action, payload = {}) {
  if (!SYNC_ENABLED) throw new Error("Offline — QuickBooks needs a connection");
  if (!isSignedIn()) throw new Error("Sign in first");
  const res = await callFunction("qbo-proxy", { action, ...payload });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `QuickBooks ${action} failed (${res.status})`);
  return body.data;
}

/* ---------- connection (admin panel) ---------- */
export function qboStatus() { return proxy("getStatus"); }
export function qboDisconnect() { return proxy("disconnect"); }
export function qboExchangeCode(code, realmId, connectedBy) {
  return proxy("exchangeCode", { code, realmId, connectedBy });
}

/* ---------- invoice push ---------- */
/**
 * Push (or re-push) a field-app invoice to QuickBooks Online.
 * Stores the returned QBO ids on the invoice instance:
 *   inv.qboInvoiceId / inv.qboDocNumber / inv.qboSyncedAt
 * Caller persists the project afterwards (commit / Store.put).
 */
export async function pushInvoiceToQbo(project, inv) {
  const items = (inv.items || [])
    .filter((it) => String(it.desc || "").trim())
    .map((it) => ({
      // QBO lines are flat, so the room/section prefixes the description
      desc: (String(it.room || "").trim() ? it.room.trim() + " — " : "") + it.desc,
      qty: parseFloat(it.qty) || 0, unit: it.unit || "", price: parseFloat(it.price) || 0,
    }));
  const data = await proxy("pushInvoice", {
    invoice: {
      qboInvoiceId: inv.qboInvoiceId || undefined,
      invoiceNo: inv.invoiceNo || "",
      invoiceDate: inv.invoiceDate || "",
      dueDate: inv.dueDate || "",
      items,
      taxRate: parseFloat(inv.taxRate) || 0,
      notes: inv.notes || "",
      lossSummary: inv.lossSummary || "",
    },
    customer: {
      name: project.customer || project.address || "Customer",
      email: project.email || "",
      phone: project.phone || "",
      address: project.address || "",
    },
    jobRef: { claimNo: project.claimNo || "", workOrderNo: project.workOrderNo || "", address: project.address || "" },
  });
  inv.qboInvoiceId = data.qboInvoiceId;
  inv.qboDocNumber = data.docNumber;
  inv.qboSyncedAt = new Date().toISOString();
  return data;
}
