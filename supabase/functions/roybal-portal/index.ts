/**
 * Supabase Edge Function: roybal-portal
 *
 * The customer portal's read + messaging gateway. Customers hold no login —
 * they present the share token from their link, and this function returns
 * ONLY that job's curated slice from `portal_jobs`, with short-lived signed
 * URLs for the shared photos, and lets them read/post messages on that job's
 * thread (`portal_messages`).
 *
 * Why the service role: customers have no JWT, so RLS (authenticated-only)
 * can't serve them. This function uses the auto-injected SERVICE_ROLE key
 * STRICTLY to (a) read the single row whose share_token matches, (b) sign
 * that row's media, and (c) read/insert messages for THAT job only. It never
 * runs arbitrary queries and returns only customer-safe data — the
 * unguessable token is the credential. Deployed `--no-verify-jwt` (public).
 *
 * Actions:
 *   view     — { token } -> { ok, job, photos, documents, unread }
 *   messages — { token } -> { ok, messages:[{id,from,body,at,channel}] }
 *              (also marks outbound messages as seen by the customer)
 *   send     — { token, body } -> { ok, message:{id,from,body,at} }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MEDIA_BUCKET = "field-media";
const SIGN_TTL = 3600;   // signed photo URL lifetime (seconds)
const MSG_MAX = 2000;    // max characters a customer may send in one message
const MSG_LIMIT = 200;   // most-recent messages returned per thread
const FLOOD_WINDOW_MS = 60_000;  // inbound-message rate window
const FLOOD_MAX = 8;             // max inbound messages per window per job

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const goodToken = (t: string) => /^[0-9a-f]{16,}$/.test(t);

/* the single enabled portal_jobs row for this token (service role; token-gated) */
async function jobByToken(token: string) {
  const q = `portal_jobs?share_token=eq.${encodeURIComponent(token)}&enabled=eq.true` +
    `&select=id,customer_name,property_address,status,milestones,photos,documents&limit=1`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

/* short-lived signed URL for one field-media object (by content hash = path) */
async function signMedia(hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(String(hash || ""))) return null;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${MEDIA_BUCKET}/${hash}`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: SIGN_TTL }),
  });
  if (!res.ok) return null;
  const b = await res.json().catch(() => ({}));
  return b.signedURL ? `${SUPABASE_URL}/storage/v1${b.signedURL}` : null;
}

/* count of inbound messages the customer hasn't-yet been the concern of —
   here we surface the count of office replies the customer hasn't read, for
   a subtle "new reply" hint on the portal. */
async function unreadForCustomer(jobId: string): Promise<number> {
  const q = `portal_messages?portal_job_id=eq.${jobId}&direction=eq.out&read_by_customer=eq.false&select=id`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = res.headers.get("content-range") || "";
  const n = Number(cr.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

async function view(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  const photos: Array<{ url: string; caption: string; stage: string }> = [];
  for (const p of (Array.isArray(row.photos) ? row.photos : [])) {
    const url = await signMedia(p.mediaHash);
    if (url) photos.push({ url, caption: p.caption || "", stage: p.stage || "" });
  }
  return {
    job: {
      customerName: row.customer_name || "",
      address: row.property_address || "",
      status: row.status || "",
      milestones: Array.isArray(row.milestones) ? row.milestones : [],
    },
    photos,
    documents: [],
    unread: await unreadForCustomer(row.id),
  };
}

/* the job's thread, oldest-first, mapped to customer-safe shape. Reading the
   thread marks the office's outbound messages as seen by the customer. */
async function messages(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  const q = `portal_messages?portal_job_id=eq.${row.id}` +
    `&select=id,direction,author,body,channel,created_at&order=created_at.asc&limit=${MSG_LIMIT}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) throw new Error(`thread failed (${res.status})`);
  const rows = await res.json();

  // mark office->customer messages as read now that the customer is viewing them
  await fetch(
    `${SUPABASE_URL}/rest/v1/portal_messages?portal_job_id=eq.${row.id}&direction=eq.out&read_by_customer=eq.false`,
    { method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ read_by_customer: true }) },
  ).catch(() => {});

  return {
    messages: (Array.isArray(rows) ? rows : []).map((m: Record<string, unknown>) => ({
      id: m.id,
      from: m.direction === "in" ? "you" : "office",   // customer's point of view
      body: String(m.body ?? ""),
      at: m.created_at,
      channel: m.channel,
    })),
  };
}

/* the customer posts a message onto their job's thread (inbound). */
async function send(token: string, bodyText: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const text = (bodyText || "").trim();
  if (!text) throw new Error("empty");
  if (text.length > MSG_MAX) throw new Error("too_long");
  const row = await jobByToken(token);
  if (!row) return null;

  // simple flood guard: cap inbound messages per job per minute
  const sinceIso = new Date(Date.now() - FLOOD_WINDOW_MS).toISOString();
  const fq = `portal_messages?portal_job_id=eq.${row.id}&direction=eq.in` +
    `&created_at=gt.${encodeURIComponent(sinceIso)}&select=id`;
  const fres = await fetch(`${SUPABASE_URL}/rest/v1/${fq}`, {
    headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
  });
  const recent = Number((fres.headers.get("content-range") || "").split("/")[1]);
  if (Number.isFinite(recent) && recent >= FLOOD_MAX) throw new Error("rate_limited");

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/portal_messages`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify([{
      portal_job_id: row.id,
      direction: "in",
      channel: "portal",
      author: "customer",
      body: text,
      read_by_office: false,
      read_by_customer: true,
    }]),
  });
  if (!ins.ok) throw new Error(`send failed (${ins.status})`);
  const saved = (await ins.json())[0] || {};
  return { message: { id: saved.id, from: "you", body: text, at: saved.created_at } };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "view");
    const token = String(body.token ?? "").trim();

    let result: unknown = null;
    if (action === "view") result = await view(token);
    else if (action === "messages") result = await messages(token);
    else if (action === "send") result = await send(token, String(body.body ?? ""));
    else return json({ ok: false, error: "Unknown action" }, 400);

    if (result === null) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const code = msg === "rate_limited" ? 429 : msg === "too_long" || msg === "empty" ? 422 : 400;
    return json({ ok: false, error: msg }, code);
  }
});
