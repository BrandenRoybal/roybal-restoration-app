/**
 * QuickBooks Online (Accounting) Proxy — Supabase Edge Function
 *
 * Pushes field-app invoices into QuickBooks Online. Mirrors qb-time-proxy
 * (CORS, { ok, ... } envelope, service-role client ONLY for the token
 * table). NOTE: this is a separate Intuit connection from QuickBooks Time —
 * QB Time authenticates on the legacy TSheets OAuth server whose tokens
 * cannot call the QBO Accounting API, so invoicing connects through
 * Intuit's appcenter with the accounting scope (tokens in qbo_tokens).
 *
 * Actions:
 *   getStatus    — is a QBO company connected?
 *   exchangeCode — swap the appcenter auth code (+realmId) for tokens
 *   disconnect   — revoke + delete stored tokens
 *   pushInvoice  — create/update the QBO copy of a field-app invoice.
 *                  Stateless w.r.t. app data: the client sends the invoice
 *                  + customer + job reference, and stores the returned QBO
 *                  ids back into the project blob (offline-first source of
 *                  truth stays on the device / field_projects sync).
 *   pullPayments — THE PAYMENT LOOP (cron-only: x-cron-secret, never the
 *                  browser). Reads the Balance of every pushed invoice from
 *                  QuickBooks, records new payments on the app's copy
 *                  (payments[] + previousPayments + status forward to
 *                  partially_paid/paid — rules in ./payments.ts, pure +
 *                  unit-tested), and writes the project back REV-GUARDED so
 *                  a concurrent crew edit is never clobbered (a conflict
 *                  just retries the next night). One capture_events row per
 *                  run; the morning brief reads the recorded payments.
 *
 * Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI
 * Optional: QBO_BASE_URL (default production; sandbox:
 *           https://sandbox-quickbooks.api.intuit.com)
 * pullPayments also needs: CRON_SECRET (already set for the other crons)
 *
 * Deploy: supabase functions deploy qbo-proxy
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyBalanceToInvoice, trackedInvoices, type Inv } from "./payments.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const QBO_BASE = Deno.env.get("QBO_BASE_URL") ?? "https://quickbooks.api.intuit.com";
const MINOR_VERSION = "70";
/** Generic service item used for all invoice lines */
const SERVICE_ITEM_NAME = "Restoration Services";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const ok = (data: unknown) => json({ ok: true, data });
const err = (message: string, status = 400) => json({ ok: false, error: message }, status);

function basicAuth() {
  const id = Deno.env.get("QBO_CLIENT_ID"), secret = Deno.env.get("QBO_CLIENT_SECRET");
  if (!id || !secret) throw new Error("QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured");
  return "Basic " + btoa(`${id}:${secret}`);
}

function serviceDb() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/* ---------- token management (qbo_tokens, service role only) ---------- */
async function getConnection(supabase: ReturnType<typeof serviceDb>) {
  const { data: row, error } = await supabase
    .from("qbo_tokens").select("*").order("created_at", { ascending: false }).limit(1).single();
  if (error || !row) throw new Error("QuickBooks Online is not connected — connect it from the office admin first.");

  const realmId = row.realm_id as string;
  if (new Date(row.expires_at as string).getTime() > Date.now() + 5 * 60 * 1000) {
    return { accessToken: row.access_token as string, realmId };
  }

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token as string }).toString(),
  });
  if (!res.ok) throw new Error(`QuickBooks token refresh failed: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  await supabase.from("qbo_tokens").update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return { accessToken: t.access_token, realmId };
}

/* ---------- QBO REST ---------- */
async function qboFetch(realmId: string, accessToken: string, path: string, opts: RequestInit = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${QBO_BASE}/v3/company/${realmId}${path}${sep}minorversion=${MINOR_VERSION}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
const qboQuery = (realmId: string, tok: string, q: string) =>
  qboFetch(realmId, tok, `/query?query=${encodeURIComponent(q)}`);
const escapeQ = (s: string) => String(s).replace(/'/g, "\\'");

/** Find-or-create the customer by display name. Returns the customer Id. */
async function ensureCustomer(realmId: string, tok: string, customer: { name: string; email?: string; phone?: string; address?: string }) {
  const displayName = String(customer.name || "Customer").slice(0, 100);
  const found = await qboQuery(realmId, tok, `select Id from Customer where DisplayName = '${escapeQ(displayName)}'`);
  const existing = (found.QueryResponse as { Customer?: { Id: string }[] })?.Customer?.[0];
  if (existing) return existing.Id;

  const payload: Record<string, unknown> = { DisplayName: displayName };
  if (customer.address) payload.BillAddr = { Line1: customer.address };
  if (customer.email) payload.PrimaryEmailAddr = { Address: customer.email };
  if (customer.phone) payload.PrimaryPhone = { FreeFormNumber: customer.phone };
  const created = await qboFetch(realmId, tok, "/customer", { method: "POST", body: JSON.stringify(payload) });
  return String((created.Customer as { Id: string }).Id);
}

/** Find-or-create the generic service item. Returns the item Id. */
async function ensureServiceItem(realmId: string, tok: string) {
  const found = await qboQuery(realmId, tok, `select Id from Item where Name = '${escapeQ(SERVICE_ITEM_NAME)}'`);
  const existing = (found.QueryResponse as { Item?: { Id: string }[] })?.Item?.[0];
  if (existing) return existing.Id;

  const accounts = await qboQuery(realmId, tok, `select Id from Account where AccountType = 'Income' maxresults 1`);
  const income = (accounts.QueryResponse as { Account?: { Id: string }[] })?.Account?.[0];
  if (!income) throw new Error("No income account found in QuickBooks — create one in QBO first.");
  const created = await qboFetch(realmId, tok, "/item", {
    method: "POST",
    body: JSON.stringify({ Name: SERVICE_ITEM_NAME, Type: "Service", IncomeAccountRef: { value: income.Id } }),
  });
  return String((created.Item as { Id: string }).Id);
}

/* ============================================================
   Main handler
   ============================================================ */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = serviceDb();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const action = body.action as string;

  try {
    // ── getStatus ─────────────────────────────────────────────────────────
    if (action === "getStatus") {
      const { data } = await supabase
        .from("qbo_tokens").select("realm_id, updated_at").order("created_at", { ascending: false }).limit(1).single();
      return ok({ connected: !!data, realmId: data?.realm_id ?? null, updatedAt: data?.updated_at ?? null });
    }

    // ── exchangeCode ──────────────────────────────────────────────────────
    if (action === "exchangeCode") {
      const code = body.code as string, realmId = body.realmId as string;
      if (!code || !realmId) return err("Missing code or realmId");
      const redirectUri = Deno.env.get("QBO_REDIRECT_URI");
      if (!redirectUri) return err("QBO_REDIRECT_URI not configured");
      const res = await fetch(QB_TOKEN_URL, {
        method: "POST",
        headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
      });
      if (!res.ok) return err(`Token exchange failed: ${await res.text()}`);
      const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      await supabase.from("qbo_tokens").upsert({
        realm_id: realmId,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        connected_by: (body.connectedBy as string) ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "realm_id" });
      return ok({ realmId, connected: true });
    }

    // ── disconnect ────────────────────────────────────────────────────────
    if (action === "disconnect") {
      try {
        const { accessToken } = await getConnection(supabase);
        await fetch(QB_REVOKE_URL, {
          method: "POST",
          headers: { Authorization: basicAuth(), "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token: accessToken }),
        }).catch(() => {});
      } catch { /* ok even if no valid token */ }
      await supabase.from("qbo_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return ok({ disconnected: true });
    }

    // ── pushInvoice ───────────────────────────────────────────────────────
    if (action === "pushInvoice") {
      const inv = body.invoice as {
        qboInvoiceId?: string; invoiceNo?: string; invoiceDate?: string; dueDate?: string;
        items: { desc: string; qty: number; unit: string; price: number }[];
        taxRate?: number; notes?: string; lossSummary?: string;
      };
      const customer = body.customer as { name: string; email?: string; phone?: string; address?: string };
      const jobRef = (body.jobRef ?? {}) as { claimNo?: string; workOrderNo?: string; address?: string };
      if (!inv || !Array.isArray(inv.items) || !inv.items.length) return err("Invoice has no line items — add items before pushing.");
      if (!customer?.name) return err("Missing customer name (set the job's Customer field first).");

      const { accessToken, realmId } = await getConnection(supabase);
      const customerId = await ensureCustomer(realmId, accessToken, customer);
      const itemId = await ensureServiceItem(realmId, accessToken);

      const lines: Record<string, unknown>[] = inv.items.map((it) => ({
        DetailType: "SalesItemLineDetail",
        Amount: Math.round((Number(it.qty) || 0) * (Number(it.price) || 0) * 100) / 100,
        Description: String(it.desc || "").slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: Number(it.qty) || 0, UnitPrice: Number(it.price) || 0 },
      }));
      const subtotal = lines.reduce((a, l) => a + (l.Amount as number), 0);
      const taxPct = Number(inv.taxRate) || 0;
      if (taxPct > 0) {
        const tax = Math.round(subtotal * taxPct) / 100;
        lines.push({
          DetailType: "SalesItemLineDetail", Amount: tax, Description: `Sales tax (${taxPct}%)`,
          SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: tax },
        });
      }

      const payload: Record<string, unknown> = {
        CustomerRef: { value: customerId },
        TxnDate: inv.invoiceDate || undefined,
        DueDate: inv.dueDate || undefined,
        DocNumber: inv.invoiceNo ? String(inv.invoiceNo).slice(0, 21) : undefined,
        PrivateNote: [jobRef.workOrderNo && `WO ${jobRef.workOrderNo}`, jobRef.claimNo && `Claim ${jobRef.claimNo}`, jobRef.address]
          .filter(Boolean).join(" | ").slice(0, 4000) || undefined,
        CustomerMemo: inv.lossSummary || inv.notes ? { value: String(inv.lossSummary || inv.notes).slice(0, 1000) } : undefined,
        BillEmail: customer.email ? { Address: customer.email } : undefined,
        Line: lines,
      };

      // Update in place when this invoice was pushed before (no duplicates).
      if (inv.qboInvoiceId) {
        try {
          const current = await qboFetch(realmId, accessToken, `/invoice/${inv.qboInvoiceId}`);
          const q = current.Invoice as { Id: string; SyncToken: string };
          payload.Id = q.Id;
          payload.SyncToken = q.SyncToken;
        } catch { /* QBO copy was deleted — create fresh */ }
      }

      const result = await qboFetch(realmId, accessToken, "/invoice", { method: "POST", body: JSON.stringify(payload) });
      const q = result.Invoice as { Id: string; DocNumber: string; TotalAmt: number };
      return ok({ qboInvoiceId: String(q.Id), docNumber: q.DocNumber, total: q.TotalAmt, updated: !!payload.Id });
    }

    // ── pullPayments (cron only) ──────────────────────────────────────────
    if (action === "pullPayments") {
      const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
      if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret)
        return err("pullPayments is cron-only", 401);

      const akToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Anchorage" });
      const { data: rows, error: readErr } = await supabase
        .from("field_projects").select("id, data").eq("deleted", false).limit(500);
      if (readErr) return err(`read field_projects failed: ${readErr.message}`, 500);

      // which invoices are worth asking about, and where they live
      type Slot = { rowId: string; data: Inv; inv: Inv };
      const slots: Slot[] = [];
      for (const row of rows ?? []) {
        if (!row?.data) continue;
        for (const inv of trackedInvoices(row.data as Inv)) slots.push({ rowId: row.id as string, data: row.data as Inv, inv });
      }
      if (!slots.length) return ok({ checked: 0, updated: 0, payments: [] });

      const { accessToken, realmId } = await getConnection(supabase);
      const balances = new Map<string, { totalAmt: number; balance: number }>();
      const ids = [...new Set(slots.map((s) => String(s.inv.qboInvoiceId)))];
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40).map((id) => `'${escapeQ(id)}'`).join(",");
        const res = await qboQuery(realmId, accessToken, `select Id, TotalAmt, Balance from Invoice where Id in (${chunk})`);
        for (const q of ((res.QueryResponse as { Invoice?: { Id: string; TotalAmt: number; Balance: number }[] })?.Invoice ?? []))
          balances.set(String(q.Id), { totalAmt: Number(q.TotalAmt) || 0, balance: Number(q.Balance) || 0 });
        // deleted in QBO → no row comes back; we simply leave the app copy alone
      }

      // apply per project, then write back rev-guarded (the field sync idiom:
      // a stale write matches 0 rows and we just try again the next night)
      const events: { job: string; invoiceNo: string; amount: number; paidInFull: boolean }[] = [];
      let updated = 0, conflicts = 0;
      const byRow = new Map<string, Slot[]>();
      for (const s of slots) byRow.set(s.rowId, [...(byRow.get(s.rowId) ?? []), s]);

      for (const [rowId, rowSlots] of byRow) {
        const data = rowSlots[0].data;
        let rowChanged = false;
        const nextInvoices = (data.invoices as Inv[]).map((inv: Inv) => {
          const qbo = inv?.qboInvoiceId ? balances.get(String(inv.qboInvoiceId)) : undefined;
          if (!qbo) return inv;
          const r = applyBalanceToInvoice(inv, qbo, akToday);
          if (!r || !r.changed) return inv;
          rowChanged = true;
          if (r.event) events.push({
            job: String(data.customer || data.address || "job"),
            invoiceNo: String(inv.invoiceNo || inv.qboDocNumber || "invoice"),
            amount: r.event.amount, paidInFull: r.event.paidInFull,
          });
          return r.inv;
        });
        if (!rowChanged) continue;
        const base = Number((data as Inv).rev) || 0;
        const next = { ...data, invoices: nextInvoices, rev: base + 1, updatedAt: new Date().toISOString() };
        const guard = base > 0 ? `data->>rev=eq.${base}` : `or=(data->>rev.is.null,data->>rev.eq.0)`;
        const patch = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/rest/v1/field_projects?id=eq.${encodeURIComponent(rowId)}&${guard}`, {
            method: "PATCH",
            headers: {
              apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({ data: next }),
          });
        const landed = patch.ok && ((await patch.json().catch(() => [])) as unknown[]).length > 0;
        if (landed) updated++; else conflicts++;
      }

      // audit envelope — same ledger as every other automated organ
      await supabase.from("capture_events").insert([{
        source_type: "qbo_payments", form_key: "paymentPull", captured_by: "qbo-payment-loop",
        status: "extracted", processed_at: new Date().toISOString(),
        raw_payload: { checked: slots.length, updated, conflicts },
        result: { payments: events.slice(0, 50) },
      }]).then(() => {}, () => { /* the sync itself matters more than its receipt */ });

      return ok({ checked: slots.length, updated, conflicts, payments: events });
    }

    return err(`Unknown action: ${action}`, 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
