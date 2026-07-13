/**
 * Supabase Edge Function: roybal-ai-narrative
 *
 * Writes the construction / mitigation NARRATIVE — the opening document of
 * the job packet — from the DOCUMENTED job facts (built client-side by
 * narrativeFacts()). Online-only; the Anthropic key lives here, never in
 * the client. Mirrors roybal-ai-ingest (CORS, forwarded JWT, spend cap,
 * ai_usage ledger). Reuses the same LLM_API_KEY secret.
 *
 * Deploy:  supabase functions deploy roybal-ai-narrative --no-verify-jwt
 *   (--no-verify-jwt required — browser CORS preflight carries no token; the
 *    function self-protects: every DB op uses the caller's JWT under RLS, and
 *    the paid LLM call runs only after the RLS-gated capture_events insert.)
 *
 * Request (JSON): { unified_job_id?, facts, captured_by? }
 *   facts = the narrativeFacts() digest. NO reconstruction scope / estimate $
 *   in v1 — the model is told to insert a placeholder there.
 * Success (200): { ok:true, capped:false, narrative, spend }
 * Capped  (200): { ok:true, capped:true, spend }
 * Error   (400): { ok:false, error }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";                       // Anthropic (shared)
const LLM_MODEL = Deno.env.get("NARRATIVE_MODEL") ?? "claude-opus-4-8";       // top-tier prose for the packet cover
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");
// Sonnet 4.6 pricing $/1M tokens (override via env if it changes)
const LLM_PRICE_IN = Number(Deno.env.get("NARRATIVE_PRICE_IN") ?? "5.0");    // claude-opus-4-8 input $/1M
const LLM_PRICE_OUT = Number(Deno.env.get("NARRATIVE_PRICE_OUT") ?? "25.0"); // claude-opus-4-8 output $/1M

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SYSTEM = `You are a senior IICRC WRT-certified restoration estimator writing a professional CONSTRUCTION / MITIGATION NARRATIVE for an insurance carrier, on behalf of Roybal Construction, LLC (North Pole / Fairbanks, Interior Alaska — FNSB).

Write in the firm's established format: numbered "## N. HEADING" sections, formal but clear adjuster-facing prose, IICRC S500 terminology, like-kind-and-quality framing. Use ONLY the facts in the provided JSON — NEVER invent quantities, dates, equipment, materials, scope, or dollar figures. If a fact is missing, omit it rather than guessing.

Produce these sections in Markdown (paragraphs, and "- " bullets where helpful):
## 1. PURPOSE OF THIS NARRATIVE — what this documents; that emergency mitigation and structural drying are complete and certified; that the reconstruction line-item estimate is provided separately and read together with this narrative.
## 2. CAUSE OF LOSS & DAMAGE SUMMARY — the loss event and water path, the affected areas/materials, and the IICRC S500 classification (state the Category and Class explicitly); the drying window dates. End with a "Classification:" line.
## 3. MITIGATION SUMMARY (COMPLETED) — the equipment deployed, citing the unit counts and unit-days exactly from the facts; the drying approach (note the cold-structure / Interior-Alaska context if a furnace/heater was used); any documented removals/salvage; and Verification: meter readings reaching the documented dry standard, certified on the certificate date.

> [Reconstruction scope by area & line-item estimate — to be attached.]

## 4. ASSUMPTIONS, CLARIFICATIONS & EXCLUSIONS — standard, defensible caveats for this loss: hidden/concealed damage submitted as a supplement before that work proceeds; if microbial growth beyond incidental surface conditions is found, work stops and a separate IICRC S520 protocol/estimate is issued; if pre-1978 painted surfaces are disturbed, RRP lead-safe practices apply; plumbing/source repair performed under a separate licensed trade line; final quantities reconcile to the accompanying estimate.
## 5. CLOSING & NEXT STEPS — respectfully request review and approval of the accompanying estimate so reconstruction can be scheduled; offer to walk the field adjuster through the scope on site.

Insert the reconstruction placeholder line EXACTLY as shown, between sections 3 and 4. Do NOT write a reconstruction scope-by-area section and do NOT state any dollar amounts. Keep it factual, defensible, and concise. Return ONLY the Markdown narrative — no preamble, no info table, no signature (those are added separately).`;

function db(path: string, jwt: string, opts: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
}
async function insertRow(table: string, row: Record<string, unknown>, jwt: string) {
  const res = await db(table, jwt, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([row]) });
  if (!res.ok) throw new Error(`insert ${table} failed (${res.status}): ${await res.text().catch(() => "")}`);
  return (await res.json().catch(() => []))[0] ?? null;
}
async function patchCaptureEvent(id: string, patch: Record<string, unknown>, jwt: string) {
  try { await db(`capture_events?id=eq.${id}`, jwt, { method: "PATCH", body: JSON.stringify(patch) }); } catch (_) { /* ignore */ }
}
const billingMonth = () => new Date().toISOString().slice(0, 7);
async function monthSpend(jwt: string): Promise<number> {
  const res = await db(`ai_usage?select=cost_usd&billing_month=eq.${billingMonth()}`, jwt, { method: "GET" });
  if (!res.ok) throw new Error(`spend read failed (${res.status})`);
  return ((await res.json().catch(() => [])) as Array<{ cost_usd: number }>).reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);

  let captureEventId: string | null = null;
  try {
    const { unified_job_id = null, facts, captured_by = null } = (await req.json()) ?? {};
    if (!facts || typeof facts !== "object") return json({ ok: false, error: "Missing `facts` digest." }, 400);

    // Envelope (RLS-gated insert before any paid call — see deploy note).
    const ev = await insertRow("capture_events", {
      unified_job_id, source_type: "narrative", form_key: "narrative", captured_by,
      raw_payload: { llm_model: LLM_MODEL }, status: "pending",
    }, jwt);
    captureEventId = ev?.id ?? null;

    // Spend cap.
    const spent = await monthSpend(jwt);
    if (SPEND_CAP_USD > 0 && spent >= SPEND_CAP_USD) {
      await patchCaptureEvent(captureEventId!, { status: "discarded", error: "spend_cap_reached", processed_at: new Date().toISOString() }, jwt);
      await insertRow("ai_usage", { capture_event_id: captureEventId, unified_job_id, captured_by, form_key: "narrative", provider: "none", capped: true, cost_usd: 0, note: "monthly spend cap reached" }, jwt);
      return json({ ok: true, capped: true, spend: { month_to_date_usd: spent, cap_usd: SPEND_CAP_USD } });
    }

    // Sonnet writes the narrative from the facts (text, not a tool call).
    if (!LLM_API_KEY) throw new Error("llm_key_missing: set the LLM_API_KEY function secret (Anthropic)");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: "user", content: "Documented job facts (use ONLY these):\n\n```json\n" + JSON.stringify(facts, null, 2) + "\n```" }],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`llm_failed (${res.status}): ${text}`);
    const data = JSON.parse(text);
    const narrative = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
    if (!narrative) throw new Error("empty_narrative: model returned no text");

    const usage = data.usage ?? {};
    const inTok = Number(usage.input_tokens) || 0, outTok = Number(usage.output_tokens) || 0;
    const cost = Math.max(0, (inTok / 1e6) * LLM_PRICE_IN + (outTok / 1e6) * LLM_PRICE_OUT);

    await patchCaptureEvent(captureEventId!, {
      result: { narrative_chars: narrative.length }, status: "extracted", processed_at: new Date().toISOString(),
      raw_payload: { llm_model: LLM_MODEL, input_tokens: inTok, output_tokens: outTok, cost_usd: cost },
    }, jwt);
    await insertRow("ai_usage", {
      capture_event_id: captureEventId, unified_job_id, captured_by, form_key: "narrative",
      provider: "anthropic", llm_model: LLM_MODEL, input_tokens: inTok, output_tokens: outTok,
      llm_cost_usd: cost, cost_usd: cost, capped: false,
    }, jwt);

    return json({ ok: true, capped: false, narrative, spend: { month_to_date_usd: spent + cost, cap_usd: SPEND_CAP_USD, this_call_usd: cost } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (captureEventId) await patchCaptureEvent(captureEventId, { error: message }, jwt);
    return json({ ok: false, error: message, capture_event_id: captureEventId }, 400);
  }
});
