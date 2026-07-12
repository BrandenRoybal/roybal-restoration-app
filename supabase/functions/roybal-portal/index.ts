/**
 * Supabase Edge Function: roybal-portal
 *
 * The customer portal's read gateway (Phase A2). Customers hold no login —
 * they present the share token from their link, and this function returns
 * ONLY that job's curated slice from `portal_jobs`, with short-lived signed
 * URLs for the shared photos.
 *
 * Why the service role: customers have no JWT, so RLS (authenticated-only)
 * can't serve them. This function uses the auto-injected SERVICE_ROLE key
 * STRICTLY to (a) read the single row whose share_token matches, and (b)
 * sign that row's media. It never runs arbitrary queries and returns only
 * the already-customer-safe projection — the unguessable token is the
 * credential. Deployed `--no-verify-jwt` (public endpoint).
 *
 * Action:  view — { token } -> { ok, job:{customerName,address,status,
 *          milestones}, photos:[{url,caption,stage}], documents:[] }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MEDIA_BUCKET = "field-media";
const SIGN_TTL = 3600;   // signed photo URL lifetime (seconds)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

/* the single enabled portal_jobs row for this token (service role; token-gated) */
async function jobByToken(token: string) {
  const q = `portal_jobs?share_token=eq.${encodeURIComponent(token)}&enabled=eq.true` +
    `&select=customer_name,property_address,status,milestones,photos,documents&limit=1`;
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

async function view(token: string) {
  if (!/^[0-9a-f]{16,}$/.test(token)) throw new Error("bad_token");
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
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (String(body.action ?? "view") !== "view") return json({ ok: false, error: "Unknown action" }, 400);
    const result = await view(String(body.token ?? "").trim());
    if (!result) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 400);
  }
});
