/**
 * Supabase Edge Function: roybal-ai-office
 *
 * The office-side AI helpers, one action-routed function (mirrors
 * roybal-ai-ingest / roybal-ai-narrative: CORS, forwarded JWT, RLS-gated
 * capture_events envelope BEFORE any paid call, monthly spend cap, and an
 * ai_usage ledger row per call). Reuses the same LLM_API_KEY secret.
 *
 * Actions (body.action):
 *   photoAnalysis — vision analysis of job photos → per-photo caption +
 *                   damage/materials/equipment/safety candidates. The client
 *                   applies them into the project blob (photos stay ≤1600px
 *                   JPEG data URLs from fileToDataURL, so they are small).
 *   invoiceDraft  — Xactimate-style invoice line items drafted from the
 *                   narrativeFacts() digest + the price catalog.
 *   invoiceAudit  — compares the current invoice items against the digest
 *                   and returns documented-but-unbilled suggestions.
 *   adjusterEmail — claim-submission email (subject + body) from the digest
 *                   + the saved narrative.
 *
 * Deploy:  supabase functions deploy roybal-ai-office --no-verify-jwt
 *   (--no-verify-jwt required — browser CORS preflight carries no token; the
 *    function self-protects: every DB op uses the caller's JWT under RLS, and
 *    the paid LLM call runs only after the RLS-gated capture_events insert.)
 *
 * Success (200): { ok:true, capped:false, ...result, spend }
 * Capped  (200): { ok:true, capped:true, spend }
 * Error   (400): { ok:false, error }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";                        // Anthropic (shared)
// Photos are many + cheap; documents (invoice/email) want better reasoning/prose.
const PHOTO_MODEL = Deno.env.get("OFFICE_PHOTO_MODEL") ?? "claude-haiku-4-5";
const DOC_MODEL = Deno.env.get("OFFICE_DOC_MODEL") ?? "claude-sonnet-4-6";
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");

// $/1M tokens (override via env if pricing shifts) — same table as roybal-ai-ingest.
const LLM_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};
const priceFor = (model: string) => LLM_PRICES[model] ?? { in: 3.0, out: 15.0 };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/* ---------- Supabase REST via the caller's JWT (RLS applies) ---------- */
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

/* ---------- Anthropic (raw fetch, forced tool-call) ---------- */
type Usage = { inTok: number; outTok: number };
async function forcedTool(opts: {
  model: string;
  system: string;
  content: unknown;                 // string OR content-block array (vision)
  toolName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<{ input: Record<string, unknown>; usage: Usage }> {
  if (!LLM_API_KEY) throw new Error("llm_key_missing: set the LLM_API_KEY function secret (Anthropic)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
      tools: [{ name: opts.toolName, description: `Return the structured result.`, input_schema: opts.schema }],
      tool_choice: { type: "tool", name: opts.toolName },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`llm_failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  const block = (data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === opts.toolName);
  if (!block) throw new Error("extraction_failed: model returned no structured result");
  const usage = data.usage ?? {};
  return { input: block.input ?? {}, usage: { inTok: Number(usage.input_tokens) || 0, outTok: Number(usage.output_tokens) || 0 } };
}

/* Split a data: URL into { mediaType, data } for the Anthropic image block. */
function dataUrlToImage(src: string): { mediaType: string; data: string } | null {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/i.exec(String(src || ""));
  return m ? { mediaType: m[1].toLowerCase(), data: m[2] } : null;
}

/* ============================================================
   Action: photoAnalysis
   ============================================================ */
const PHOTO_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["caption", "damage", "materials", "equipment", "safety", "confidence"],
  properties: {
    caption: { type: "string", description: "One-sentence adjuster-ready caption of what is actually visible, e.g. 'Standing water and saturated carpet along the north wall.'" },
    damage: { type: "array", items: { type: "string" }, description: "Specific visible damage (water staining, swollen baseboard, microbial growth, char...)" },
    materials: { type: "array", items: { type: "string" }, description: "Building materials visibly affected (drywall, carpet, subfloor, insulation...)" },
    equipment: { type: "array", items: { type: "string" }, description: "Restoration equipment visible (air movers, LGR dehumidifier, air scrubber, heater...)" },
    safety: { type: "array", items: { type: "string" }, description: "Visible safety/health concerns (suspected microbial growth, sewage, electrical, structural)" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

async function photoAnalysis(body: Record<string, unknown>) {
  const photos = body.photos as Array<{ id: string; image: string; room?: string; stage?: string; caption?: string }> | undefined;
  if (!photos?.length) throw new Error("Provide `photos` [{id, image (data URL), room?, stage?, caption?}].");
  if (photos.length > 10) throw new Error("Analyze at most 10 photos per request.");
  const ctx = (body.context ?? {}) as { lossCause?: string; waterCategory?: string; address?: string };

  const ctxLine = [
    "This photo documents a water/fire/mold restoration job",
    ctx.lossCause ? `(loss cause: ${String(ctx.lossCause).slice(0, 200)})` : "",
    ctx.waterCategory ? `— IICRC Category ${ctx.waterCategory} water loss` : "",
    "in Interior Alaska.",
  ].filter(Boolean).join(" ");

  const system =
    `You are a senior IICRC WRT-certified restoration estimator documenting a loss for an insurance claim. ` +
    `Analyze the job-site photo and call \`analyze\` with what is ACTUALLY VISIBLE — never invent damage or equipment you cannot see. ` +
    `The caption must be professional, concise, and adjuster-ready.`;

  const results: Array<Record<string, unknown>> = [];
  const usage: Usage = { inTok: 0, outTok: 0 };
  for (const p of photos) {
    const img = dataUrlToImage(p.image);
    if (!img) { results.push({ id: p.id, ok: false, error: "not_an_image_data_url" }); continue; }
    try {
      const hint = [
        ctxLine,
        p.room ? `The tech tagged the room/location as "${String(p.room).slice(0, 80)}".` : "",
        p.stage ? `Photo stage: ${p.stage}.` : "",
        p.caption ? `Tech's existing caption: "${String(p.caption).slice(0, 160)}".` : "",
      ].filter(Boolean).join(" ");
      const { input, usage: u } = await forcedTool({
        model: PHOTO_MODEL,
        system,
        content: [
          { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
          { type: "text", text: hint },
        ],
        toolName: "analyze",
        schema: PHOTO_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 1024,
      });
      usage.inTok += u.inTok; usage.outTok += u.outTok;
      results.push({ id: p.id, ok: true, analysis: input });
    } catch (e) {
      results.push({ id: p.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { result: { results }, usage, model: PHOTO_MODEL, summary: { photos: photos.length, analyzed: results.filter((r) => r.ok).length } };
}

/* ============================================================
   Action: invoiceDraft
   ============================================================ */
const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["lossSummary", "items"],
  properties: {
    lossSummary: { type: "string", description: "2-3 sentence loss description / scope summary for the invoice header" },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["room", "desc", "qty", "unit", "price", "basis"],
        properties: {
          room: { type: "string", description: "Room / area this line belongs to, exactly as documented (e.g. 'Living Room', 'Bathroom'). Use 'Main Level' for job-wide lines (haul-off, service call, whole-structure treatment)." },
          desc: { type: "string", description: "Plain-English scope description as it reads in an Xactimate estimate, e.g. 'Tear out wet drywall, cleanup, bag, per LF - up to 2 ft tall'. NO catalog code abbreviations, NO room name in the description." },
          qty: { type: "number" },
          unit: { type: "string", description: "EA, SF, LF, HR, Day or LS" },
          price: { type: "number", description: "Unit price in DOLLARS" },
          basis: { type: "string", description: "The documentation this line traces to (equipment log, moisture map, hours...)" },
        },
      },
    },
  },
} as const;

function catalogText(catalog: unknown): string {
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.map((c: { code: string; description: string; unit: string; price: number }) =>
    `${c.code} | ${c.description} | ${c.unit} | $${Number(c.price).toFixed(2)}`).join("\n");
}

async function invoiceDraft(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior restoration estimator at Roybal Construction, LLC (North Pole / Fairbanks, Alaska) writing an Xactimate-style " +
      "mitigation invoice for an insurance claim. Every line must trace to the documented facts — never bill undocumented work. " +
      "Call `draft_invoice` with the complete line-item draft.",
    content:
      `Draft the mitigation invoice line items for this job.\n\n` +
      `PRICE CATALOG (code | description | unit | default price) — prefer these codes and prices when a line matches:\n${catalogText(body.catalog)}\n\n` +
      `RULES:\n` +
      `- Group every line into its documented room/area via the room field (Xactimate style: each room carries its own scope). Job-wide lines (haul-off, service call, whole-structure disinfection) go under 'Main Level'.\n` +
      `- Descriptions are plain English exactly as Xactimate reads — never include catalog code abbreviations and never repeat the room name inside the description.\n` +
      `- Equipment rental: one line per equipment type PER ROOM where documented, phrased 'Air mover (per 24 hour period) - N units x D days', qty = N*D, unit EA.\n` +
      `- Monitoring visits: one line, qty = the documented reading-date count.\n` +
      `- Labor: use the documented crew hours at $125.00/HR ('Equipment setup, take down, and monitoring (hourly charge)' or task-specific labor lines).\n` +
      `- Include extraction/removal/treatment lines only where the facts support them; state the basis on every line.\n` +
      `- Match tear-out phrasing to the documented water category: on Cat 3 jobs removal lines carry the qualifier (e.g. 'Tear out wet non-salvageable carpet, cut/bag - Cat 3 water', 'Tear out wet drywall, cleanup, bag, per LF - to 2 ft - Cat 3'); Cat 1/2 jobs omit Cat-3 qualifiers.\n` +
      `- No overhead/profit/tax lines (applied separately). Prices in DOLLARS.\n\n` +
      `DOCUMENTED FACTS (use ONLY these):\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "draft_invoice",
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4096,
  });
  return { result: { draft: input }, usage, model: DOC_MODEL, summary: { items: Array.isArray((input as { items?: unknown[] }).items) ? (input as { items: unknown[] }).items.length : 0 } };
}

/* ============================================================
   Action: invoiceAudit (supplement detection)
   ============================================================ */
const AUDIT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["room", "desc", "qty", "unit", "price", "reason"],
        properties: {
          room: { type: "string", description: "Room / area the missed line belongs to ('Main Level' for job-wide)" },
          desc: { type: "string", description: "Plain-English Xactimate-style description — no catalog code abbreviations" },
          qty: { type: "number" },
          unit: { type: "string" },
          price: { type: "number", description: "Unit price in DOLLARS" },
          reason: { type: "string", description: "The specific documentation supporting this missed line" },
        },
      },
    },
  },
} as const;

async function invoiceAudit(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const items = Array.isArray(body.items) ? body.items as Array<{ room?: string; desc: string; qty: string; unit: string; price: string }> : [];
  const itemsText = items.length
    ? items.map((it) => `- [${it.room || "Main Level"}] ${it.desc} | ${it.qty} ${it.unit} @ $${it.price}`).join("\n")
    : "(the invoice is currently empty)";
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a supplement auditor for Roybal Construction, LLC. Find DOCUMENTED work missing from an invoice — billable items " +
      "clearly supported by the job facts but absent from the current line items. Never suggest speculative work: every suggestion " +
      "must cite its supporting documentation. If nothing is missing, call `audit` with an empty suggestions array.",
    content:
      `Audit this invoice against the documented job facts and list missed billable items.\n\n` +
      `CURRENT INVOICE LINE ITEMS:\n${itemsText}\n\n` +
      `PRICE CATALOG (prefer these codes/prices when a suggestion matches):\n${catalogText(body.catalog)}\n\n` +
      `Do not duplicate or re-price items already on the invoice. No overhead/profit/tax lines. Prices in DOLLARS.\n\n` +
      `DOCUMENTED FACTS:\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "audit",
    schema: AUDIT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4096,
  });
  return { result: input, usage, model: DOC_MODEL, summary: { suggestions: Array.isArray((input as { suggestions?: unknown[] }).suggestions) ? (input as { suggestions: unknown[] }).suggestions.length : 0 } };
}

/* ============================================================
   Action: adjusterEmail
   ============================================================ */
const EMAIL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string", description: "Subject line including the claim number when available" },
    body: { type: "string", description: "Plain-text email body — no markdown" },
  },
} as const;

async function adjusterEmail(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const narrative = typeof body.narrative === "string" ? body.narrative : "";
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You write professional claim-submission emails on behalf of Roybal Construction, LLC (North Pole / Fairbanks, Alaska) to " +
      "insurance adjusters. Courteous, factual, brief — under 200 words, plain text only. Sign off from Branden Roybal, " +
      "Roybal Construction, LLC, 907-371-9868. Call `email` with the draft.",
    content:
      `Draft the email submitting our documentation packet for this claim. Greet the adjuster by name if known, reference the ` +
      `claim number and property address, summarize the loss and completed mitigation in 2-4 sentences, list the attached ` +
      `documentation packet (narrative, moisture maps, drying logs, photo report, certificate of drying, invoice), and offer ` +
      `to answer questions or walk the scope on site.\n\n` +
      (narrative ? `SAVED NARRATIVE (source of truth for the summary):\n${narrative.slice(0, 6000)}\n\n` : "") +
      `DOCUMENTED FACTS:\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "email",
    schema: EMAIL_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
  });
  return { result: { draft: input }, usage, model: DOC_MODEL, summary: { chars: String((input as { body?: string }).body ?? "").length } };
}

/* ============================================================
   Handler — same self-protection invariants as roybal-ai-ingest:
   anon key only (RLS always applies), the caller's JWT on every DB op,
   and the RLS-gated capture_events insert BEFORE any paid LLM call.
   ============================================================ */
const ACTIONS: Record<string, (body: Record<string, unknown>) => Promise<{ result: Record<string, unknown>; usage: Usage; model: string; summary: Record<string, unknown> }>> = {
  photoAnalysis, invoiceDraft, invoiceAudit, adjusterEmail,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);

  let captureEventId: string | null = null;
  try {
    const body = (await req.json()) ?? {};
    const action = String(body.action ?? "");
    const run = ACTIONS[action];
    if (!run) return json({ ok: false, error: `Unknown action. Expected one of: ${Object.keys(ACTIONS).join(", ")}` }, 400);
    const unified_job_id = body.unified_job_id ?? null;
    const captured_by = body.captured_by ?? null;

    // Envelope (RLS-gated insert before any paid call — see deploy note).
    const ev = await insertRow("capture_events", {
      unified_job_id, source_type: "office_ai", form_key: action, captured_by,
      raw_payload: { action }, status: "pending",
    }, jwt);
    captureEventId = ev?.id ?? null;

    // Spend cap.
    const spent = await monthSpend(jwt);
    if (SPEND_CAP_USD > 0 && spent >= SPEND_CAP_USD) {
      await patchCaptureEvent(captureEventId!, { status: "discarded", error: "spend_cap_reached", processed_at: new Date().toISOString() }, jwt);
      await insertRow("ai_usage", { capture_event_id: captureEventId, unified_job_id, captured_by, form_key: action, provider: "none", capped: true, cost_usd: 0, note: "monthly spend cap reached" }, jwt);
      return json({ ok: true, capped: true, spend: { month_to_date_usd: spent, cap_usd: SPEND_CAP_USD } });
    }

    const { result, usage, model, summary } = await run(body as Record<string, unknown>);
    const price = priceFor(model);
    const cost = Math.max(0, (usage.inTok / 1e6) * price.in + (usage.outTok / 1e6) * price.out);

    await patchCaptureEvent(captureEventId!, {
      result: summary, status: "extracted", processed_at: new Date().toISOString(),
      raw_payload: { action, llm_model: model, input_tokens: usage.inTok, output_tokens: usage.outTok, cost_usd: cost },
    }, jwt);
    await insertRow("ai_usage", {
      capture_event_id: captureEventId, unified_job_id, captured_by, form_key: action,
      provider: "anthropic", llm_model: model, input_tokens: usage.inTok, output_tokens: usage.outTok,
      llm_cost_usd: cost, cost_usd: cost, capped: false,
    }, jwt);

    return json({ ok: true, capped: false, ...result, spend: { month_to_date_usd: spent + cost, cap_usd: SPEND_CAP_USD, this_call_usd: cost } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (captureEventId) await patchCaptureEvent(captureEventId, { error: message }, jwt);
    return json({ ok: false, error: message, capture_event_id: captureEventId }, 400);
  }
});
