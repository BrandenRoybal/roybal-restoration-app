/**
 * QuickBooks Online (Accounting) Proxy — Supabase Edge Function
 *
 * Pushes app invoices into QuickBooks Online. Reuses the Intuit OAuth
 * connection stored by the QB Time integration (qb_time_tokens) — the
 * Settings page requests both the Time and Accounting scopes, so one
 * "Connect QuickBooks" covers both APIs.
 *
 * Actions:
 *   getStatus    — is a QuickBooks company connected?
 *   pushInvoice  — create/update the QBO copy of an app invoice
 *
 * Required secrets: QB_TIME_CLIENT_ID, QB_TIME_CLIENT_SECRET
 * Optional: QBO_BASE_URL (defaults to production; use
 *           https://sandbox-quickbooks.api.intuit.com for sandbox realms)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_BASE = Deno.env.get("QBO_BASE_URL") ?? "https://quickbooks.api.intuit.com";
const MINOR_VERSION = "70";
/** Generic service item used for all invoice lines */
const SERVICE_ITEM_NAME = "Restoration Services";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
const ok = (data: unknown) => json({ ok: true, data });
const err = (message: string, status = 400) => json({ ok: false, error: message }, status);

function serviceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function basicAuth() {
  const clientId = Deno.env.get("QB_TIME_CLIENT_ID");
  const clientSecret = Deno.env.get("QB_TIME_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("QB_TIME_CLIENT_ID / QB_TIME_CLIENT_SECRET not configured");
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

/** Get a valid access token + realm, refreshing if needed (shared row with QB Time) */
async function getConnection(supabase: ReturnType<typeof serviceClient>) {
  const { data: tokenRow, error } = await supabase
    .from("qb_time_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error || !tokenRow) throw new Error("QuickBooks is not connected. Connect it in Settings first.");

  const realmId = tokenRow.realm_id as string;
  const expiresAt = new Date(tokenRow.expires_at as string).getTime();
  if (expiresAt > Date.now() + 5 * 60 * 1000) {
    return { accessToken: tokenRow.access_token as string, realmId };
  }

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token as string,
    }).toString(),
  });
  if (!res.ok) throw new Error(`QuickBooks token refresh failed: ${await res.text()}`);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };

  await supabase
    .from("qb_time_tokens")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    })
    .eq("id", tokenRow.id);

  return { accessToken: tokens.access_token, realmId };
}

async function qboFetch(
  realmId: string,
  accessToken: string,
  path: string,
  options: RequestInit = {}
): Promise<Record<string, unknown>> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${QBO_BASE}/v3/company/${realmId}${path}${sep}minorversion=${MINOR_VERSION}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        `QuickBooks Online API access denied (${res.status}). If QuickBooks was connected before invoicing was added, ` +
        `disconnect and reconnect it in Settings to grant the accounting permission. Details: ${text.slice(0, 300)}`
      );
    }
    throw new Error(`QBO API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function qboQuery(realmId: string, accessToken: string, query: string) {
  return qboFetch(realmId, accessToken, `/query?query=${encodeURIComponent(query)}`);
}

const escapeQ = (s: string) => s.replace(/'/g, "\\'");

/** Find or create the QBO customer for a job's property owner. Returns the customer Id. */
async function ensureCustomer(
  supabase: ReturnType<typeof serviceClient>,
  realmId: string,
  accessToken: string,
  job: Record<string, unknown>
): Promise<string> {
  if (job.qbo_customer_id) {
    return String(job.qbo_customer_id);
  }

  const displayName = String(job.owner_name || job.property_address || job.job_number).slice(0, 100);
  const found = await qboQuery(
    realmId, accessToken,
    `select Id from Customer where DisplayName = '${escapeQ(displayName)}'`
  );
  const existing = (found.QueryResponse as { Customer?: { Id: string }[] })?.Customer?.[0];

  let customerId: string;
  if (existing) {
    customerId = existing.Id;
  } else {
    const payload: Record<string, unknown> = {
      DisplayName: displayName,
      BillAddr: { Line1: job.property_address },
    };
    if (job.owner_email) payload.PrimaryEmailAddr = { Address: job.owner_email };
    if (job.owner_phone) payload.PrimaryPhone = { FreeFormNumber: job.owner_phone };
    const created = await qboFetch(realmId, accessToken, "/customer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    customerId = String((created.Customer as { Id: string }).Id);
  }

  await supabase.from("jobs").update({ qbo_customer_id: customerId }).eq("id", job.id);
  return customerId;
}

/** Find or create the generic service item used for invoice lines. Returns the item Id. */
async function ensureServiceItem(realmId: string, accessToken: string): Promise<string> {
  const found = await qboQuery(
    realmId, accessToken,
    `select Id from Item where Name = '${escapeQ(SERVICE_ITEM_NAME)}'`
  );
  const existing = (found.QueryResponse as { Item?: { Id: string }[] })?.Item?.[0];
  if (existing) return existing.Id;

  const accounts = await qboQuery(
    realmId, accessToken,
    `select Id, Name from Account where AccountType = 'Income' maxresults 1`
  );
  const income = (accounts.QueryResponse as { Account?: { Id: string }[] })?.Account?.[0];
  if (!income) throw new Error("No income account found in QuickBooks — create one in QBO first.");

  const created = await qboFetch(realmId, accessToken, "/item", {
    method: "POST",
    body: JSON.stringify({
      Name: SERVICE_ITEM_NAME,
      Type: "Service",
      IncomeAccountRef: { value: income.Id },
    }),
  });
  return String((created.Item as { Id: string }).Id);
}

// ---------------------------------------------------------------------------
// Action: pushInvoice
// ---------------------------------------------------------------------------
async function pushInvoice(body: Record<string, unknown>) {
  const invoiceId = body.invoiceId as string | undefined;
  if (!invoiceId) return err("invoiceId is required");

  const supabase = serviceClient();
  const { accessToken, realmId } = await getConnection(supabase);

  const [{ data: invoice }, { data: items }] = await Promise.all([
    supabase.from("invoices").select("*").eq("id", invoiceId).single(),
    supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId).order("sort_order"),
  ]);
  if (!invoice) return err("Invoice not found");
  if (!items?.length) return err("Invoice has no line items — add items before pushing to QuickBooks");

  const { data: job } = await supabase.from("jobs").select("*").eq("id", invoice.job_id).single();
  if (!job) return err("Job not found");

  const customerId = await ensureCustomer(supabase, realmId, accessToken, job);
  const itemId = await ensureServiceItem(realmId, accessToken);

  // Build lines: one per invoice item, plus overhead / markup / tax lines
  const subtotal = items.reduce((sum, it) => sum + (it.total_cents as number), 0);
  const overhead = Math.round(subtotal * ((invoice.overhead_percent as number) / 100));
  const markup = Math.round((subtotal + overhead) * ((invoice.markup_percent as number) / 100));
  const tax = Math.round((subtotal + overhead + markup) * ((invoice.tax_percent as number) / 100));

  const lines: Record<string, unknown>[] = items.map((it) => ({
    DetailType: "SalesItemLineDetail",
    Amount: (it.total_cents as number) / 100,
    Description: [
      it.room_name ? `[${it.room_name}]` : null,
      it.code ? `${it.code} —` : null,
      it.description,
    ].filter(Boolean).join(" "),
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: it.quantity,
      UnitPrice: (it.unit_price as number) / 100,
    },
  }));
  for (const extra of [
    { label: `Overhead (${invoice.overhead_percent}%)`, cents: overhead },
    { label: `Profit / Markup (${invoice.markup_percent}%)`, cents: markup },
    { label: `Tax (${invoice.tax_percent}%)`, cents: tax },
  ]) {
    if (extra.cents > 0) {
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: extra.cents / 100,
        Description: extra.label,
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: extra.cents / 100 },
      });
    }
  }

  const payload: Record<string, unknown> = {
    CustomerRef: { value: customerId },
    DocNumber: String(invoice.invoice_number).slice(0, 21),
    TxnDate: invoice.invoice_date,
    PrivateNote: `${job.job_number} — ${job.property_address}${job.claim_number ? ` | Claim ${job.claim_number}` : ""}`.slice(0, 4000),
    CustomerMemo: invoice.notes ? { value: String(invoice.notes).slice(0, 1000) } : undefined,
    BillEmail: job.owner_email ? { Address: job.owner_email } : undefined,
    Line: lines,
  };

  // Update in place if this invoice was already pushed
  if (invoice.qbo_invoice_id) {
    try {
      const current = await qboFetch(realmId, accessToken, `/invoice/${invoice.qbo_invoice_id}`);
      const qboInv = current.Invoice as { Id: string; SyncToken: string };
      payload.Id = qboInv.Id;
      payload.SyncToken = qboInv.SyncToken;
    } catch {
      // The QBO copy was deleted — fall through and create a fresh one
    }
  }

  const result = await qboFetch(realmId, accessToken, "/invoice", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const qboInvoice = result.Invoice as { Id: string; DocNumber: string; TotalAmt: number };

  await supabase
    .from("invoices")
    .update({ qbo_invoice_id: String(qboInvoice.Id), qbo_synced_at: new Date().toISOString() })
    .eq("id", invoiceId);

  return ok({
    qboInvoiceId: qboInvoice.Id,
    docNumber: qboInvoice.DocNumber,
    total: qboInvoice.TotalAmt,
    updated: Boolean(payload.Id),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;

    if (action === "getStatus") {
      const supabase = serviceClient();
      const { data } = await supabase
        .from("qb_time_tokens")
        .select("realm_id")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      return ok({ connected: Boolean(data), realmId: data?.realm_id ?? null });
    }

    if (action === "pushInvoice") return await pushInvoice(body);

    return err(`Unknown action: ${action}`, 404);
  } catch (e) {
    console.error("qbo-proxy error:", e);
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
