/**
 * Supabase Edge Function: roybal-notify
 *
 * Company-number texting (Twilio) for the field app + job board.
 * Same self-protection invariants as roybal-ai-office: anon key only,
 * the caller's JWT on every DB op, and the RLS-gated sms_messages
 * insert BEFORE the paid Twilio call. Monthly send cap.
 *
 * Actions (body.action):
 *   sendSms — { to, body, kind?, unified_job_id?, captured_by?, mediaUrls?[] }
 *             sends from TWILIO_FROM, records the row, returns { sid, status }.
 *
 * Secrets:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (+1XXXXXXXXXX)
 *           SMS_MONTHLY_CAP (optional, default 500 messages / month)
 * Deploy:   supabase functions deploy roybal-notify --no-verify-jwt
 *   (--no-verify-jwt required for browser CORS preflight; the function
 *    self-protects — the sms_messages insert runs under the caller's JWT,
 *    so an unauthenticated caller can never reach the Twilio call.)
 *
 * Success (200): { ok:true, sid, status, month_count }
 * Error   (400): { ok:false, error }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_FROM = Deno.env.get("TWILIO_FROM") ?? "";
// A non-numeric SMS_MONTHLY_CAP secret (e.g. "500 texts") must NOT silently
// disable the cap — fall back to the 500 default when it isn't a finite number.
const CAP_RAW = Number(Deno.env.get("SMS_MONTHLY_CAP") ?? "500");
const SMS_MONTHLY_CAP = Number.isFinite(CAP_RAW) ? CAP_RAW : 500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/* ---------- Supabase REST via the caller's JWT (RLS applies) ---------- */
function db(path: string, jwt: string, opts: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

/* +1XXXXXXXXXX for a US / North-American number; empty for anything else.
   We intentionally reject international and malformed input (including a bare
   "+" with the wrong digit count) so a fat-fingered or foreign number can
   never be dialed and billed — every branch here yields a US number or "". */
export function toE164(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 10) return "+1" + digits;                          // 907-371-9868
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits; // 1-907-371-9868 / +1 907...
  return "";                                                               // international / malformed -> rejected
}

/* Truncate by CODE POINT, never mid-surrogate — slicing a UTF-16 string at a
   fixed unit index can split an emoji and corrupt the send. */
const clip = (t: string, n = 1600) => Array.from(t).slice(0, n).join("");

async function monthCount(jwt: string): Promise<number> {
  const from = new Date();
  from.setUTCDate(1); from.setUTCHours(0, 0, 0, 0);
  const res = await db(
    `sms_messages?select=id&direction=eq.outbound&created_at=gte.${encodeURIComponent(from.toISOString())}`,
    jwt, { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } });
  if (!res.ok) throw new Error(`send-count read failed (${res.status})`);
  const range = res.headers.get("content-range") || "";           // e.g. "0-0/37"
  return Number(range.split("/")[1]) || 0;
}

async function sendSms(body: Record<string, unknown>, jwt: string) {
  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM)
    throw new Error("texting_not_configured: set the TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM function secrets");
  const to = toE164(body.to);
  if (!to) throw new Error("Provide `to` as a valid US phone number.");
  const text = String(body.body ?? "").trim();
  if (!text) throw new Error("Provide `body` — the message text.");
  const media = (Array.isArray(body.mediaUrls) ? body.mediaUrls : [])
    .map((u) => String(u)).filter((u) => /^https:\/\//.test(u)).slice(0, 5);

  // spend guard first — a runaway loop can't burn the account
  const used = await monthCount(jwt);
  if (SMS_MONTHLY_CAP > 0 && used >= SMS_MONTHLY_CAP)
    throw new Error(`sms_cap_reached: ${used} of ${SMS_MONTHLY_CAP} texts this month — raise SMS_MONTHLY_CAP if intended.`);

  // RLS-gated insert BEFORE the paid call — unauthenticated callers stop here
  const ins = await db("sms_messages", jwt, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      unified_job_id: body.unified_job_id ?? null,
      direction: "outbound", to_number: to, from_number: TWILIO_FROM,
      body: clip(text), kind: String(body.kind ?? "text"),
      sent_by: body.captured_by ?? null, status: "pending",
    }]),
  });
  if (!ins.ok) throw new Error(`log insert failed (${ins.status}): ${await ins.text().catch(() => "")}`);
  const row = (await ins.json())[0];

  // mark the row's outcome and never leave it orphaned at "pending"
  const settle = (patch: Record<string, unknown>) =>
    db(`sms_messages?id=eq.${row.id}`, jwt, { method: "PATCH", body: JSON.stringify(patch) }).catch(() => {});

  // Twilio REST send
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: clip(text) });
  for (const u of media) form.append("MediaUrl", u);
  let tw: Response;
  let twBody: Record<string, unknown>;
  try {
    tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_AUTH}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    twBody = await tw.json().catch(() => ({}));
  } catch (netErr) {
    // the fetch itself rejected (DNS/TLS/reset) — record the failure so the
    // row isn't stranded at "pending", then surface it to the caller
    await settle({ status: "failed", error: ("network: " + String((netErr as Error)?.message ?? netErr)).slice(0, 500), updated_at: new Date().toISOString() });
    throw new Error("send_failed: could not reach Twilio — the message was not sent");
  }
  const patch = tw.ok
    ? { twilio_sid: twBody.sid ?? null, status: twBody.status ?? "sent", updated_at: new Date().toISOString() }
    : { status: "failed", error: String(twBody.message ?? `twilio ${tw.status}`).slice(0, 500), updated_at: new Date().toISOString() };
  await settle(patch);
  if (!tw.ok) throw new Error(`send_failed: ${patch.error}`);

  return { sid: twBody.sid ?? "", status: twBody.status ?? "sent", month_count: used + 1 };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);
  try {
    const body = (await req.json()) ?? {};
    const action = String(body.action ?? "");
    if (action !== "sendSms") return json({ ok: false, error: "Unknown action. Expected one of: sendSms" }, 400);
    const result = await sendSms(body as Record<string, unknown>, jwt);
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 400);
  }
});
