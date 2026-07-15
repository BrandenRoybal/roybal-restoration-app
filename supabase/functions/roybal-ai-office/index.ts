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
 *   rebuildDraft  — reconstruction plan (scope per room, trade sequence,
 *                   owner selections, open questions) drafted from a
 *                   restoration job's fact pack when it converts to a
 *                   construction job.
 *   progressNarrative — weekly construction progress update (Markdown)
 *                   for the owner / adjuster / lender, from the
 *                   constructionFacts digest.
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
// Written deliverables run on Opus (quality wins; the office reviews them and a
// few seconds slower is fine). Photos and the live voice/chat assistant run on
// Sonnet — near-Opus quality but fast, since someone is waiting on those.
const PHOTO_MODEL = Deno.env.get("OFFICE_PHOTO_MODEL") ?? "claude-sonnet-4-6";
const DOC_MODEL = Deno.env.get("OFFICE_DOC_MODEL") ?? "claude-opus-4-8";
const ASSIST_MODEL = Deno.env.get("OFFICE_ASSIST_MODEL") ?? "claude-sonnet-4-6";  // interactive field assistant (voice/chat)
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");
const STT_API_KEY = Deno.env.get("STT_API_KEY") ?? "";        // Deepgram (shared with roybal-ai-ingest)
const STT_MODEL = Deno.env.get("STT_MODEL") ?? "nova-3";
const TTS_MODEL = Deno.env.get("TTS_MODEL") ?? "aura-2-thalia-en";  // Deepgram Aura voice

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
  // a forced tool call cut off by max_tokens parses as an EMPTY/partial input —
  // surface it as an error instead of silently returning a blank draft
  if (data.stop_reason === "max_tokens") throw new Error("llm_truncated: the response hit its output limit before finishing — try again");
  const block = (data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === opts.toolName);
  if (!block) throw new Error("extraction_failed: model returned no structured result");
  const usage = data.usage ?? {};
  return { input: block.input ?? {}, usage: { inTok: Number(usage.input_tokens) || 0, outTok: Number(usage.output_tokens) || 0 } };
}

/* Plain conversational call — no forced tool; returns the assistant's text. */
async function chatText(opts: {
  model: string; system: string; messages: unknown[]; maxTokens?: number;
}): Promise<{ text: string; usage: Usage }> {
  if (!LLM_API_KEY) throw new Error("llm_key_missing: set the LLM_API_KEY function secret (Anthropic)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1024, system: opts.system, messages: opts.messages }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`llm_failed (${res.status}): ${raw}`);
  const data = JSON.parse(raw);
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
  const usage = data.usage ?? {};
  return { text, usage: { inTok: Number(usage.input_tokens) || 0, outTok: Number(usage.output_tokens) || 0 } };
}

/* Deepgram pre-recorded STT (same account as voice capture). */
async function sttTranscribe(audio: Uint8Array, mime: string): Promise<string> {
  if (!STT_API_KEY) throw new Error("stt_key_missing: set the STT_API_KEY function secret (Deepgram)");
  const ct = String(mime || "audio/webm").split(";")[0].trim();   // iOS sends audio/mp4;codecs=… — params confuse STT
  const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(STT_MODEL)}&smart_format=true&punctuate=true`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Token ${STT_API_KEY}`, "Content-Type": ct }, body: audio as unknown as BodyInit });
  if (!res.ok) throw new Error(`stt_failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
}

/* Deepgram Aura TTS — returns base64 MP3 of the spoken reply (same API key).
   Cost is ~$0.03 per 1k characters — pennies per answer; not separately metered. */
async function ttsSpeak(text: string): Promise<string> {
  if (!STT_API_KEY) throw new Error("stt_key_missing: set the STT_API_KEY function secret (Deepgram)");
  const clean = text.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 1800);
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(TTS_MODEL)}&encoding=mp3`, {
    method: "POST",
    headers: { Authorization: `Token ${STT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean }),
  });
  if (!res.ok) throw new Error(`tts_failed (${res.status}): ${await res.text().catch(() => "")}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToBytes(src: string): Uint8Array {
  const b64 = String(src || "").replace(/^data:[^;]+;base64,/, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
        required: ["room", "desc", "qty", "unit", "price", "basis", "category", "code", "priceBasis"],
        properties: {
          room: { type: "string", description: "Room / area this line belongs to, exactly as documented (e.g. 'Living Room', 'Bathroom'). Use 'Main Level' for job-wide lines (haul-off, service call, whole-structure treatment)." },
          desc: { type: "string", description: "Plain-English scope description as it reads in an Xactimate estimate, e.g. 'Tear out wet drywall, cleanup, bag, per LF - up to 2 ft tall'. NO catalog code abbreviations, NO room name in the description." },
          qty: { type: "number" },
          unit: { type: "string", description: "EA, SF, LF, HR, Day or LS" },
          price: { type: "number", description: "Unit price in DOLLARS. Your best estimate — it is OVERRIDDEN by the catalog's authoritative price whenever category+code match a real line, so it only stands for lines you cannot map to a catalog code." },
          basis: { type: "string", description: "The documentation this line traces to (equipment log, moisture map, hours...)" },
          category: { type: "string", description: "The Xactimate CATEGORY code of the catalog line you are billing (e.g. 'DRY', 'PNT', 'LAB'). Empty string ONLY if no catalog line fits." },
          code: { type: "string", description: "The Xactimate SELECTOR/code from the price catalog you are billing (e.g. '1/2', 'AC', 'DMO'). Must be a code that appears in the provided catalog. Empty string ONLY if no catalog line fits." },
          priceBasis: { type: "string", enum: ["replace", "remove", "detach_reset", "labor", "estimate"], description: "Which catalog price this line uses: 'replace' = install/put-back unit price; 'remove' = tear-out/demo; 'detach_reset' = detach & reset; 'labor' = an hourly LAB trade rate (T&M); 'estimate' = no catalog match, price is your own estimate." },
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

/* ============================================================
   Fairbanks price_list — the pricing basis for ALL estimating.
   The model drafts scope and tags each line with the Xactimate
   category+code+priceBasis it is billing; resolvePrices() then stamps the
   AUTHORITATIVE unit price from public.price_list, so prices always come from
   the sheet, never the model. Two pricing modes:
     piecework — unit price carries labor+material: replace_price (put-back),
                 remove_price (demo/tear-out) or detach_reset_price (D&R).
     tm        — labor bills hourly at the trade's LAB rate (× hours); materials,
                 equipment and pass-throughs price per unit from their own rows.
   ============================================================ */
type CatalogRow = {
  category: string; code: string; description: string; unit: string | null;
  replace_price: number | null; remove_price: number | null; detach_reset_price: number | null;
};
type PricingMode = "piecework" | "tm";
// Categories offered to the model per mode (kept scoped so the prompt stays lean).
const RECON_CATS = ["DRY", "PNT", "INS", "FNC", "FRM", "ACT", "APP"]; // reconstruction put-back trades
const TM_CATS = ["LAB"];                                               // T&M prices labor from the sheet's LAB rates; materials are ESTIMATED, not piecework
const catsForMode = (mode: PricingMode) => (mode === "piecework" ? RECON_CATS : TM_CATS);

async function fetchCatalogRows(jwt: string, categories: string[]): Promise<CatalogRow[]> {
  if (!categories.length) return [];
  const inList = categories.map((c) => encodeURIComponent(c)).join(",");
  const res = await db(
    `price_list?select=category,code,description,unit,replace_price,remove_price,detach_reset_price&category=in.(${inList})&order=category,code&limit=5000`,
    jwt, { method: "GET" });
  if (!res.ok) return [];
  return ((await res.json().catch(() => [])) as CatalogRow[]) ?? [];
}

const money = (n: number | null) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** Compact catalog block for the prompt: CATEGORY CODE | description | unit | prices. */
function catalogTextFromRows(rows: CatalogRow[], mode: PricingMode): string {
  if (mode === "tm") {
    // T&M uses ONLY these hourly labor rates from the sheet. Materials are estimated
    // by the model (no piecework unit prices), so no material catalog is sent.
    const labor = rows.filter((r) => r.category === "LAB" && r.unit === "HR" && (r.replace_price ?? 0) > 0);
    const laborTxt = labor.map((r) => `LAB ${r.code} | ${r.description} | HR | ${money(r.replace_price)}`).join("\n");
    return `LABOR RATES — category LAB, billed HOURS × rate (the ONLY catalog prices in T&M):\n${laborTxt}`;
  }
  // piecework: drop $0 placeholders (Bid/Agreed) and material-only sheet rows (SH)
  const usable = rows.filter((r) => (r.replace_price ?? 0) > 0 || (r.remove_price ?? 0) > 0);
  return usable.map((r) =>
    `${r.category} ${r.code} | ${r.description} | ${r.unit} | replace ${money(r.replace_price)}`
    + (r.remove_price != null ? ` | tear-out ${money(r.remove_price)}` : "")
    + (r.detach_reset_price != null ? ` | D&R ${money(r.detach_reset_price)}` : "")
  ).join("\n");
}

/** Stamp authoritative prices from the catalog onto drafted/suggested lines. */
type DraftLine = {
  room?: string; desc?: string; qty?: number; unit?: string; price?: number; basis?: string; reason?: string;
  category?: string; code?: string; priceBasis?: string;
};
async function resolvePrices(items: DraftLine[], jwt: string, mode: PricingMode): Promise<DraftLine[]> {
  const list = Array.isArray(items) ? items : [];
  const cats = [...new Set(list.map((i) => i.category).filter((c): c is string => !!c))];
  const rows = cats.length ? await fetchCatalogRows(jwt, cats) : [];
  const byKey = new Map(rows.map((r) => [`${r.category}::${r.code}`, r] as const));
  return list.map((it) => {
    const { priceBasis: basis, ...rest } = it;
    const row = it.category && it.code ? byKey.get(`${it.category}::${it.code}`) : undefined;
    if (!row) return { ...rest, priced: "estimate" };
    // GUARDRAIL: an hourly LAB rate may ONLY bill an HR line. If the model tags a
    // line priceBasis='labor' but leaves an area/count unit (SF/LF/EA), applying the
    // hourly rate would multiply it by the AREA (e.g. $81.27/hr × 508 SF = $41k for a
    // 3-hour tear-out). Refuse to price it and flag for manual crew-hours instead.
    if (basis === "labor" && String(it.unit || "").toUpperCase() !== "HR") {
      return { ...rest, price: undefined, code: row.code, priced: "flag",
        priceFlag: `${row.code} is an hourly labor rate (${money(row.replace_price)}/HR) — bill this as HR × crew-hours, not per ${it.unit || "unit"}` };
    }
    const col = basis === "remove" ? row.remove_price
      : basis === "detach_reset" ? row.detach_reset_price
      : row.replace_price; // "replace" | "labor" both live in replace_price
    if (col == null || col <= 0) return { ...rest, priced: "estimate" };
    return { ...rest, price: col, code: row.code, catalogDesc: row.description, unit: it.unit || row.unit || "", priced: "catalog" };
  });
}

async function invoiceDraft(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const jwt = String((body as Record<string, unknown>)._jwt ?? "");
  // Two independent axes:
  //  - doc type: reconstruction ESTIMATE (future put-back) vs INVOICE (performed work)
  //  - pricing mode: PIECEWORK (unit-priced) vs T&M (hourly trade labor) — the toggle
  const estimate = body.mode === "reconEstimate";
  const pm: PricingMode =
    body.pricingMode === "tm" || body.pricingMode === "piecework"
      ? (body.pricingMode as PricingMode)
      : estimate ? "piecework" : "tm";
  const rows = await fetchCatalogRows(jwt, catsForMode(pm));
  const catText = catalogTextFromRows(rows, pm);

  const codeRule =
    "- EVERY line MUST be tagged with the catalog line it bills: set `category` + `code` to a real row from the PRICE CATALOG and `priceBasis` to how it is priced. The catalog's authoritative Fairbanks price OVERRIDES your `price`, so your number only stands when NO catalog code fits (then category=\"\" code=\"\" priceBasis=\"estimate\", and price it at a fair Fairbanks rate).\n";
  const pricingRules =
    pm === "piecework"
      ? "PRICING MODE — PIECEWORK (Xactimate unit-priced): each line's unit price carries BOTH labor and material.\n" +
        "- priceBasis: 'replace' for install / put-back, 'remove' for tear-out / demo, 'detach_reset' for detach & reset. The catalog lists replace / tear-out / D&R prices per row.\n" +
        codeRule
      : "PRICING MODE — TIME & MATERIALS: this bills LABOR HOURLY at the sheet's trade rates and MATERIALS at your ESTIMATED cost. It does NOT use Xactimate piecework unit prices — the only catalog prices are the LABOR RATES.\n" +
        "- LABOR lines: category='LAB', code = the trade doing the work (DMO demolition, CLN-R remediation cleaning, CLN cleaning, LBR general laborer, DRY drywall, PNT painter, INS insulation, FLR flooring, CARPFRM framer, CARPFNC finish carpenter, ELE electrician, PLM plumber, EQU equipment operator, SUPERR residential supervision), priceBasis='labor', unit MUST be 'HR', qty = ESTIMATED CREW-HOURS.\n" +
        "  · NEVER put an area/count (SF/LF/EA) on a labor line — convert the task to hours. E.g. tear out ~500 SF drywall ceiling ≈ 3-4 crew-hours (NOT qty 500); hang/finish ~500 SF drywall ≈ 16-20 hrs. A labor line with a non-HR unit is a hard error.\n" +
        "  · The sheet's LAB rate is stamped automatically — put the trade code and the hours; leave price 0.\n" +
        "- MATERIAL lines: category='' code='' priceBasis='estimate'. Estimate a fair MATERIAL-ONLY cost per unit (drywall board, mud/tape, insulation, paint, primer, trim, fasteners, poly) — unit = SF/LF/EA, qty = the material quantity. Materials-only, NO labor baked in (labor is the HR lines). These stay flagged for the office to true-up against receipts.\n" +
        "- Equipment / consumables / pass-through (dehumidifier & air-mover days, dumpster/haul, PPE) also go as priceBasis='estimate' at a fair cost.\n" +
        "- Do NOT emit a single per-SF assembly price that covers labor + material — that double-bills labor. Split every assembly into LABOR (hours) + MATERIAL (estimate).\n";
  const scopeFraming =
    estimate
      ? "Draft the RECONSTRUCTION ESTIMATE line items — the proposed scope to REBUILD the structure after mitigation (future work, not billing for performed work).\n" +
        "- VERIFIED SCOPE (HIGHEST PRIORITY): if facts.verifiedScope is present it is the estimator's CONFIRMED scope of work — their spoken narration (facts.verifiedScope.summary / .narration) plus their answers to scope questions (facts.verifiedScope.answers). Build the line items to fulfil it EXACTLY; it OVERRIDES any inference. Use the documented facts below only for quantities and support. If facts.verifiedScope is absent, infer scope from the documented demolition/damage as described next.\n" +
        "- SCOPE = PUT-BACK of the documented demolition/damage (facts.demoNotes, facts.affectedAreas): flood cuts to new drywall; removed flooring to underlayment, flooring, baseboard, paint. Include the full finish chain per assembly (hang, tape, texture, prime, paint).\n" +
        "- QUANTITIES from facts.planDimensions (tech-verified SF/LF) — cite the room's dimensions in the basis; where missing, derive conservatively and say so.\n" +
        "- Include trades the damage clearly requires (electrical/plumbing/HVAC disturbed by demo, insulation in opened walls, code items facts.supportingDocs cites).\n" +
        "- STRUCTURE ONLY: contents / personal property (facts.contentsLoss) are claimed separately — note that in lossSummary.\n"
      : "Draft the line items billing the DOCUMENTED PERFORMED work for this job.\n" +
        "- Bill only what the facts support; state the basis on every line.\n" +
        "- facts.receipts (when present) are AI-read receipts / sub invoices — bill each pass-through at its receipt total, citing vendor + date; never bill a receipt twice.\n";
  const hourRule =
    pm === "tm" && !estimate
      ? "- RECONCILE HOURS: HR quantities across ALL labor lines MUST sum to facts.labor.totalHours. Split facts.labor.entries into trade-specific labor lines by their work notes; bill any remainder as one 'General mitigation labor' (LAB / LBR) line so no logged hour goes unbilled. Moisture mapping / monitoring visits bill hourly, never as flat per-visit fees.\n"
      : "";
  const commonRules =
    "- Group every line into its room/area via the room field (Xactimate style); job-wide lines (debris, floor protection, final clean, permits) go under 'Main Level'.\n" +
    "- On Cat 3 jobs, removal/handling lines carry the qualifier (e.g. 'cut/bag - Cat 3 water'); Cat 1/2 jobs omit it.\n" +
    "- Descriptions are plain English as Xactimate reads — never include catalog code abbreviations, never repeat the room name in the description.\n" +
    "- lossSummary: 2-3 sentences. No overhead/profit/tax lines (applied separately). Prices in DOLLARS.\n";
  // Roybal company estimating standards — the "what to include" judgment distilled
  // from Branden's past estimates (see docs/Estimating_Rules_Draft.md).
  const inclusionUniversal =
    "ROYBAL INCLUSION RULES (company estimating standards — apply within the scope above):\n" +
    "- DETACH & RESET vs REMOVE & REPLACE: REPLACE (remove + install new) when an item is DAMAGED by the loss, OR the loss is Category 3 (facts.job.waterCategory = '3') AND the item is a POROUS material (plywood, particleboard, MDF, fiberboard). Otherwise an undamaged item detached only to dry the assembly behind it is DETACH & RESET. Apply to vanities, cabinets, toilets, trim, doors.\n" +
    "- LABOR MINIMUMS: never auto-add a trade labor minimum to pad a small quantity — carriers flag and cut them. At most note in lossSummary that one may apply; do not insert the line.\n";
  const inclusionMitigation =
    "- CATEGORY 3 PACKAGE: when facts.job.waterCategory is '3' (black / contaminated water), ALWAYS bill EVERY one of — containment barrier, negative-air / HEPA air scrubber (per 24 hr × days), floor protection over unaffected paths, HEPA vacuuming of affected surfaces, antimicrobial application, and PPE CONSUMABLES billed as equipment replacement (Tyvek / Type-X suits, HEPA / P100 respirator cartridges, gloves, boot covers). Never omit any of these on a Cat 3 job.\n" +
    "- HEPA FILTER REPLACEMENT: with any HEPA / negative-air scrubber on the job, add a filter-replacement line, qty = (# scrubbers) × (1.0 on Cat 3 or mold — filter contaminated, must be discarded; else 0.5 — proportional filter life). State the reason in the basis.\n" +
    "- DRYING EQUIPMENT — DO NOT GUESS QUANTITIES: bill from facts.equipmentSizing.recommended (IICRC S500 worksheet counts already computed on site: airMoversLow/High, dehumidifiers, dehuType, airScrubbers, auxiliaryHeat) × the DEPLOYED unit-days in facts.equipment (unitDays) — fallback facts.drying.days. Air movers & dehumidifiers bill per-24-hr period × unit-days. Dehumidifiers are LGR RENTALS in 70 / 110 / 130 PPD sizes. If facts.equipmentSizing is null, size conservatively and say so in the basis.\n";
  const inclusionRestoration =
    "- PUT-BACK COMPLETENESS: every tear-out / flood cut / removal in facts.demoNotes and facts.affectedAreas needs its FULL rebuild — removed flooring → floor prep + flooring + transitions; drywall → hang, tape, texture, prime, two coats paint; baseboard / trim / paneling → reinstall; detached fixtures → reset or replace per the rule above. Leave no demo line without its put-back.\n" +
    "- FINISH CHAIN: any new or patched drywall → mask & prep → PVA primer (one coat) → paint (two coats); any flooring install → a floor-prep line first. Always include a final construction cleaning line and floor / surface protection.\n";
  const inclusionRules = inclusionUniversal + (estimate ? inclusionRestoration : inclusionMitigation);
  const content =
    scopeFraming + "\n" + pricingRules + hourRule + commonRules + "\n" + inclusionRules + "\n" +
    "PRICE CATALOG (tag each line with a CATEGORY + CODE from here — Fairbanks Xactimate):\n" + catText + "\n\n" +
    "DOCUMENTED FACTS (use ONLY these):\n```json\n" + JSON.stringify(facts, null, 2) + "\n```";

  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior " + (estimate ? "reconstruction" : "restoration") + " estimator at Roybal Construction, LLC (North Pole / Fairbanks, Alaska) " +
      "writing an Xactimate-style " + (estimate ? "reconstruction estimate for insurance review" : "insurance-claim invoice") + " in " +
      (pm === "piecework" ? "PIECEWORK (unit-priced)" : "TIME & MATERIALS") + " format. Every line must trace to documented " +
      (estimate ? "damage" : "work") + " — never invent scope — and must be tagged with the catalog category+code it bills. " +
      "Call `draft_invoice` with the complete line-item draft.",
    content,
    toolName: "draft_invoice",
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    // reconstruction estimates run long (every room × the full finish chain,
    // verbose basis strings) — 4096 truncated them into empty drafts
    maxTokens: 16384,
  });
  const drafted = Array.isArray((input as { items?: DraftLine[] }).items) ? (input as { items: DraftLine[] }).items : [];
  const priced = await resolvePrices(drafted, jwt, pm);
  (input as Record<string, unknown>).items = priced;
  return {
    result: { draft: input },
    usage, model: DOC_MODEL,
    summary: { items: priced.length, mode: pm, catalog_priced: priced.filter((i) => (i as { priced?: string }).priced === "catalog").length },
  };
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
        required: ["room", "desc", "qty", "unit", "price", "reason", "category", "code", "priceBasis"],
        properties: {
          room: { type: "string", description: "Room / area the missed line belongs to ('Main Level' for job-wide)" },
          desc: { type: "string", description: "Plain-English Xactimate-style description — no catalog code abbreviations" },
          qty: { type: "number" },
          unit: { type: "string" },
          price: { type: "number", description: "Unit price in DOLLARS — overridden by the catalog price when category+code match." },
          reason: { type: "string", description: "The specific documentation supporting this missed line" },
          category: { type: "string", description: "Xactimate CATEGORY code of the catalog line billed (e.g. 'DRY','LAB'); empty only if none fits." },
          code: { type: "string", description: "Xactimate SELECTOR/code from the catalog (e.g. '1/2','DMO'); empty only if none fits." },
          priceBasis: { type: "string", enum: ["replace", "remove", "detach_reset", "labor", "estimate"], description: "Which catalog price this line uses: replace/remove/detach_reset unit price, hourly 'labor' LAB rate, or 'estimate' when uncataloged." },
        },
      },
    },
  },
} as const;

async function invoiceAudit(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const jwt = String((body as Record<string, unknown>)._jwt ?? "");
  const estimate = body.mode === "reconEstimate";
  const pm: PricingMode =
    body.pricingMode === "tm" || body.pricingMode === "piecework"
      ? (body.pricingMode as PricingMode)
      : estimate ? "piecework" : "tm";
  const rows = await fetchCatalogRows(jwt, catsForMode(pm));
  const catText = catalogTextFromRows(rows, pm);
  const items = Array.isArray(body.items) ? body.items as Array<{ room?: string; desc: string; qty: string; unit: string; price: string }> : [];
  const itemsText = items.length
    ? items.map((it) => `- [${it.room || "Main Level"}] ${it.desc} | ${it.qty} ${it.unit} @ $${it.price}`).join("\n")
    : (estimate ? "(the estimate is currently empty)" : "(the invoice is currently empty)");
  const codeRule =
    "- Tag every suggestion with the catalog line it bills: set category + code from the PRICE CATALOG and priceBasis (replace/remove/detach_reset/labor). The catalog price is authoritative and overrides your price; use category=\"\" code=\"\" priceBasis=\"estimate\" only when nothing fits.\n";
  const modeRule =
    pm === "piecework"
      ? "PRICING MODE — PIECEWORK: unit-priced lines (labor+material inside the unit price); priceBasis 'replace' for put-back, 'remove' for demo, 'detach_reset' for D&R. Never hourly T&M.\n"
      : "PRICING MODE — TIME & MATERIALS: labor bills HOURLY at the sheet's LAB rate — category='LAB', code=the trade, priceBasis='labor', unit MUST be 'HR', qty=crew-hours (NEVER an area on a labor line). Materials are ESTIMATED: category='' code='' priceBasis='estimate', material-only cost per unit, no labor baked in. No Xactimate piecework unit prices. Do not double-bill labor (a piecework assembly line PLUS labor hours for the same work).\n";
  const focus =
    estimate
      ? "MOST IMPORTANT CHECK — demo put-back reconciliation: walk facts.demoNotes and facts.affectedAreas; every flood cut, tear-out and removed finish must have corresponding rebuild lines (the finish chain: hang, tape, texture, prime, paint; underlayment, install, transitions). Also check trades disturbed by demo (electrical/plumbing/HVAC/insulation), code items facts.supportingDocs cites, and job-wide lines (debris, floor protection, final clean, permits). Quantities from facts.planDimensions where available.\n"
      : (pm === "tm"
          ? "MOST IMPORTANT CHECK — hour reconciliation: compare total HR billed across the current hourly lines to facts.labor.totalHours; if logged hours are unbilled, suggest labor line(s) at the appropriate trade rate that bill the gap, describing the work from the labor entries' notes. Unbilled logged hours are lost revenue. Also flag missing equipment-rental days, materials and pass-throughs — including facts.receipts not yet billed.\n"
          : "MOST IMPORTANT CHECK: flag documented scope, equipment days, materials and pass-throughs the facts support but the current lines omit — including facts.receipts not yet billed.\n");
  // Roybal inclusion checklist — mirror of the drafter's rules (docs/Estimating_Rules_Draft.md)
  const inclusionCheck = estimate
    ? "ROYBAL INCLUSION CHECKS — also flag when missing: any tear-out in facts.demoNotes without its put-back (floor prep + flooring + transitions; drywall hang / tape / texture / prime / two-coat paint; baseboard / trim reinstall); missing final construction cleaning; missing mask-&-prep or PVA primer before paint. Do NOT suggest trade labor minimums (carriers cut them).\n"
    : "ROYBAL INCLUSION CHECKS — also flag when missing: on Cat 3 (facts.job.waterCategory '3') any of containment barrier, negative-air / HEPA scrubber, floor protection, HEPA vacuuming, antimicrobial, PPE consumables (Tyvek suits, HEPA / P100 cartridges, gloves, boot covers), or the HEPA filter replacement; drying-equipment days that don't match facts.equipmentSizing.recommended × facts.equipment unit-days. Do NOT suggest trade labor minimums (carriers cut them).\n";
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system: estimate
      ? "You are a reconstruction scope auditor for Roybal Construction, LLC. Find DOCUMENTED rebuild scope missing from a " +
        "reconstruction estimate — put-back work the documented damage clearly requires but the current line items omit. " +
        "Never suggest speculative scope: every suggestion must cite its supporting documentation. If nothing is missing, " +
        "call `audit` with an empty suggestions array."
      : "You are a supplement auditor for Roybal Construction, LLC. Find DOCUMENTED work missing from an invoice — billable items " +
        "clearly supported by the job facts but absent from the current line items. Never suggest speculative work: every suggestion " +
        "must cite its supporting documentation. If nothing is missing, call `audit` with an empty suggestions array.",
    content:
      "Audit this " + (estimate ? "reconstruction estimate against the documented damage and list missed rebuild scope" : "invoice against the documented job facts and list missed billable items") + ".\n\n" +
      "CURRENT LINE ITEMS:\n" + itemsText + "\n\n" +
      modeRule + codeRule + "Do not duplicate or re-price items already present.\n" +
      focus + inclusionCheck +
      "No overhead/profit/tax lines. Prices in DOLLARS.\n\n" +
      "PRICE CATALOG (tag each suggestion with a CATEGORY + CODE — Fairbanks Xactimate):\n" + catText + "\n\n" +
      "DOCUMENTED FACTS:\n```json\n" + JSON.stringify(facts, null, 2) + "\n```",
    toolName: "audit",
    schema: AUDIT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8192,
  });
  const suggested = Array.isArray((input as { suggestions?: DraftLine[] }).suggestions) ? (input as { suggestions: DraftLine[] }).suggestions : [];
  const priced = await resolvePrices(suggested, jwt, pm);
  (input as Record<string, unknown>).suggestions = priced;
  return { result: input, usage, model: DOC_MODEL, summary: { suggestions: priced.length, mode: pm } };
}

/* ============================================================
   Action: scopeInterview — verify reconstruction scope BEFORE drafting.
   Reads the estimator's spoken scope narration + documented facts + the
   answers gathered so far, and either asks the SINGLE most important
   still-open question (with tap options + free text) or declares the scope
   complete with a consolidated summary. The client loops until done, then
   the draft prices FROM the verified scope — turning "AI guesses scope" into
   "AI asks, the estimator confirms, AI prices."
   ============================================================ */
const SCOPE_INTERVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["done", "question", "options", "why", "scopeSummary"],
  properties: {
    done: { type: "boolean", description: "true when the scope is determined enough to draft a tight estimate; false while a question still needs answering." },
    question: { type: "string", description: "The SINGLE most important still-open scope question for the estimator, plain English. Empty string when done=true." },
    options: { type: "array", items: { type: "string" }, description: "2-4 concrete tap-to-answer options for the question (the client always also offers a free-text answer). Empty when done=true." },
    why: { type: "string", description: "One short phrase — why this matters to the estimate (e.g. 'drives replace vs reset', 'sets paint extent'). Empty when done." },
    scopeSummary: { type: "string", description: "When done=true: a tight 2-5 sentence consolidated scope of work reflecting the narration + every answer, ready to seed the estimate's scope summary. Empty until done." },
  },
} as const;

async function scopeInterview(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const narration = typeof body.narration === "string" ? body.narration.trim() : "";
  const answers = Array.isArray(body.answers) ? body.answers as Array<{ question: string; answer: string }> : [];
  const asked = answers.length;
  const qaText = answers.length
    ? answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n")
    : "(no questions answered yet)";
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior reconstruction estimator at Roybal Construction, LLC (North Pole / Fairbanks, Alaska) INTERVIEWING the field tech to pin down " +
      "the rebuild scope BEFORE anything is priced — eliminating guesswork. Given the documented job facts, the tech's spoken scope narration, and the " +
      "answers gathered so far, either ask the SINGLE most important still-unresolved scope question, or declare the scope complete. Ask about what most " +
      "changes the estimate and is NOT already settled by the narration or facts: which rooms/areas are in the rebuild; replace vs detach-&-reset per " +
      "major item (rule: REPLACE if damaged by the loss OR Cat 3 + porous material, else detach & reset); flooring type and match-existing vs upgrade; " +
      "drywall extent (flood-cut ~2 ft vs full height); paint extent (full room vs spot/patch); trades disturbed (electrical / plumbing / HVAC / " +
      "insulation in opened walls); water category (drives the Cat 3 package); and whether a subcontractor is on the job (drives O&P). ONE question at a " +
      "time, plain English, with 2-4 concrete options the tech can tap (they can also free-type). NEVER ask about something already answered or already " +
      "clear from the narration/facts. Set done=true as soon as you could write a tight, unambiguous scope, and NEVER exceed 8 questions total (asked so " +
      "far: " + asked + " — if that is 7+, strongly prefer done). When done, return a consolidated scopeSummary. Call `scope_interview`.",
    content:
      "TECH'S SPOKEN SCOPE NARRATION:\n" + (narration || "(none provided yet)") + "\n\n" +
      "ANSWERS SO FAR:\n" + qaText + "\n\n" +
      "DOCUMENTED JOB FACTS:\n```json\n" + JSON.stringify(facts, null, 2) + "\n```",
    toolName: "scope_interview",
    schema: SCOPE_INTERVIEW_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
  });
  const done = !!(input as { done?: boolean }).done;
  return {
    result: {
      done,
      question: String((input as { question?: string }).question ?? ""),
      options: Array.isArray((input as { options?: string[] }).options) ? (input as { options: string[] }).options : [],
      why: String((input as { why?: string }).why ?? ""),
      scopeSummary: String((input as { scopeSummary?: string }).scopeSummary ?? ""),
    },
    usage, model: DOC_MODEL,
    summary: { done, asked: asked + 1 },
  };
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
   Action: progressNarrative — construction progress update
   (Phase 4: weekly owner / carrier / lender status summary)
   ============================================================ */
const PROGRESS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["narrative"],
  properties: {
    narrative: { type: "string", description: "The progress update in Markdown (## headings, - bullets, **bold**)" },
  },
} as const;

async function progressNarrative(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You write construction progress updates for Roybal Construction, LLC (North Pole / Fairbanks, Alaska) addressed to the " +
      "property owner and, when applicable, the insurance adjuster or construction lender. Factual, confident, plain language — " +
      "never promise dates the schedule doesn't support. Use ONLY the documented facts. Call `progress_update` with the Markdown.",
    content:
      `Write this week's progress update for the job below. Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `STRUCTURE (Markdown, ## headings; skip a section when there's nothing to say):\n` +
      `## Work Completed — from recentWork (DATED log entries; "this week" = the last 7 days). Older history is context only — never re-report it as new\n` +
      `## Inspections — results, corrections, what's scheduled\n` +
      `## Schedule — trades on deck vs the sub schedule; call out anything behind\n` +
      `## Decisions Needed — pending owner selections, with why timing matters\n` +
      `## Budget & Draws — draw/invoice status; change orders that moved the number\n` +
      `## Up Next — the coming week, from the schedule\n\n` +
      `Under 350 words. No greeting or signature — the letterhead and sign-off are added by the document.\n\n` +
      `DOCUMENTED FACTS (use ONLY these):\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "progress_update",
    schema: PROGRESS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2048,
  });
  const md = String((input as { narrative?: string }).narrative ?? "");
  return { result: { draft: { narrative: md } }, usage, model: DOC_MODEL, summary: { chars: md.length } };
}

/* ============================================================
   Action: timelineDraft — phase plan for the Job Board's Gantt
   (Phase 5: field proposes, the Board schedules)
   ============================================================ */
const TIMELINE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["phases", "notBefore", "notBeforeLabel", "assumptions"],
  properties: {
    phases: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "estimatedHours", "lagDays", "confidence"],
        properties: {
          name: { type: "string", description: "Short phase name as it reads on a Gantt bar, e.g. 'Demo & prep', 'Drywall', 'Insulation + inspection'" },
          estimatedHours: { type: "number", description: "Total crew hours for the phase (assume a 2-person crew unless the scope implies otherwise)" },
          lagDays: { type: "number", description: "Calendar days of WAIT before this phase starts — mud/concrete cure, inspection scheduling, material delivery. 0 when none." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    notBefore: { type: "string", pattern: "^(\\d{4}-\\d{2}-\\d{2})?$", description: "YYYY-MM-DD date the job can't start before (permit, long-lead selection), else empty string" },
    notBeforeLabel: { type: "string", description: "One word for the constraint, e.g. 'permit' or 'materials'; empty when notBefore is empty" },
    assumptions: { type: "array", items: { type: "string" }, description: "Assumptions the estimate rests on, e.g. '2-man crew', 'cabinets are 3-week lead'" },
  },
} as const;

async function timelineDraft(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const history = Array.isArray(body.history) ? body.history : [];
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior construction scheduler at Roybal Construction, LLC (North Pole / Fairbanks, Alaska) breaking a job into " +
      "sequenced phases for a Gantt schedule. Derive hours from the documented Scope of Work quantities; insert lag days for " +
      "real-world waits (mud/concrete cure, inspection scheduling, material lead times from the selections). Never invent scope. " +
      "Call `timeline` with the phase plan.",
    content:
      `Draft the phase plan for this job's Gantt schedule. Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `RULES:\n` +
      `- Phases in build order; one phase per stretch of related work (demo → rough-in → insulation → drywall → paint → flooring → trim → punch), skipping anything the scope doesn't include.\n` +
      `- estimatedHours from the scope quantities; keep phases between ~8 and ~80 hours — split or merge to fit.\n` +
      `- lagDays for waits BEFORE a phase (cure, inspection wait, delivery). Pending selections with lead times → notBefore or lag on the affected phase.\n` +
      `- Set confidence below 0.7 on any phase whose hours are inferred rather than derived from quantities.\n` +
      (history.length ? `- CALIBRATION — this company's history of estimate vs actual hours by phase (ratio >1 = they run over). Weight your hours accordingly:\n${JSON.stringify(history)}\n` : "") +
      `\nDOCUMENTED JOB FACTS (use ONLY these):\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "timeline",
    schema: TIMELINE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3072,
  });
  const d = input as { phases?: unknown[] };
  return { result: { draft: input }, usage, model: DOC_MODEL, summary: { phases: d.phases?.length ?? 0, calibrated: history.length > 0 } };
}

/* ============================================================
   Action: planDimensions — read room dimensions / SF / LF off the
   uploaded dimensioned floor plan (vision). The result is reviewed
   and edited by the tech, then feeds scope + invoice quantities.
   ============================================================ */
const PLAN_DIM_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["rooms", "totals", "notes"],
  properties: {
    rooms: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "dims", "floorSF", "perimLF", "ceiling", "notes", "confidence"],
        properties: {
          name: { type: "string", description: "Room / area label exactly as printed on the plan, e.g. 'Master Bedroom'" },
          dims: { type: "string", description: "The printed dimensions verbatim, e.g. 12' 4\" x 10' 6\"; empty when not printed" },
          floorSF: { type: "number", description: "Floor area in square feet — the printed value when shown, else length × width from the printed dimensions; 0 when unknown" },
          perimLF: { type: "number", description: "Wall perimeter in lineal feet computed from the printed dimensions (2×(L+W) for a simple rectangle, follow offsets when dimensioned); 0 when unknown" },
          ceiling: { type: "string", description: "Ceiling height if printed, else empty" },
          notes: { type: "string", description: "What's included/excluded (closets, offsets), unreadable text, or how a value was computed" },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "Below 0.7 when a value is computed or partially readable rather than printed outright" },
        },
      },
    },
    totals: {
      type: "object", additionalProperties: false,
      required: ["floorSF", "perimeterLF"],
      properties: {
        floorSF: { type: "number", description: "Sum of room floorSF values; 0 when unknown" },
        perimeterLF: { type: "number", description: "Sum of room perimeter LF values; 0 when unknown" },
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "Plan-level caveats — missing dimensions, pages that are not floor plans, scale warnings" },
  },
} as const;

async function planDimensions(body: Record<string, unknown>) {
  const pages = Array.isArray(body.pages) ? (body.pages as string[]).slice(0, 6) : [];
  if (!pages.length) throw new Error("Upload the floor plan first.");
  const content: unknown[] = [];
  for (const src of pages) {
    const img = dataUrlToImage(src);
    if (img) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  if (!content.length) throw new Error("Couldn't read those pages as images.");
  content.push({
    type: "text",
    text:
      "Read the room dimensions off this dimensioned floor plan for an insurance repair estimate.\n" +
      "RULES:\n" +
      "- Use ONLY dimensions printed on the plan — never scale or estimate off the drawing itself.\n" +
      "- One entry per labeled room/area. floorSF: the printed area when shown, else length × width. perimLF: wall perimeter from the printed dimensions.\n" +
      "- Anything computed rather than printed gets confidence below 0.7 and a note saying how it was derived.\n" +
      "- Unreadable or missing dimensions: leave the value 0/empty and say so in notes — never guess.",
  });
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior reconstruction estimator at Roybal Construction, LLC reading a dimensioned floor plan (Xactimate / magicplan style) " +
      "to take off room sizes, square footages and lineal footages for scope and invoice quantities. Precision over completeness: report " +
      "exactly what is printed, flag everything derived. Call `plan_dimensions` with the takeoff.",
    content,
    toolName: "plan_dimensions",
    schema: PLAN_DIM_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3072,
  });
  const d = input as { rooms?: unknown[] };
  return { result: { dimensions: input }, usage, model: DOC_MODEL, summary: { pages: content.length - 1, rooms: d.rooms?.length ?? 0 } };
}

/* ============================================================
   Action: docDigest — read an uploaded supporting document
   (engineer's report, hygienist report, adjuster estimate, permit
   letter) into a citable digest the facts digests carry. Tech
   reviews/edits the digest before anything relies on it.
   ============================================================ */
const DOC_DIGEST_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["docType", "suggestedTitle", "summary", "keyFindings"],
  properties: {
    docType: { type: "string", enum: ["Engineer's report", "Hygienist / lab report", "Adjuster estimate", "Permit / code letter", "Contract / legal", "Receipt", "Subcontractor invoice", "Supplier quote", "Other"] },
    suggestedTitle: { type: "string", description: "Short title, e.g. \"Structural engineer's report — J. Smith PE, 7/8/2026\" or \"Fairbanks Landfill dump receipt — 6/21/2026\"" },
    summary: { type: "string", description: "150-250 words (a few sentences suffice for receipts): what the document is, who authored it, what it concludes — stated facts only, no interpretation" },
    keyFindings: {
      type: "array",
      items: { type: "string", description: "One finding/requirement/number per entry, quoted or closely paraphrased, with its location in the doc when useful (e.g. 'p.3: sistered joists required at bays 2-4')" },
    },
    vendor: { type: "string", description: "Receipts / sub invoices / quotes: the vendor or subcontractor name printed on the document (empty otherwise)" },
    docDate: { type: "string", description: "The date printed on the document, ISO YYYY-MM-DD (empty if not printed)" },
    totalAmount: { type: ["number", "null"], description: "Receipts / sub invoices / quotes: the document's TOTAL in dollars; null when the document has no total" },
  },
} as const;

async function docDigest(body: Record<string, unknown>) {
  const pages = Array.isArray(body.pages) ? (body.pages as string[]).slice(0, 8) : [];
  if (!pages.length) throw new Error("Upload the document first.");
  const hint = (body.hint ?? {}) as { title?: string; docType?: string };
  const content: unknown[] = [];
  for (const src of pages) {
    const img = dataUrlToImage(src);
    if (img) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  if (!content.length) throw new Error("Couldn't read those pages as images.");
  content.push({
    type: "text",
    text:
      "Digest this supporting document for an insurance restoration/construction job file.\n" +
      (hint.title ? `The tech labeled it: "${hint.title}".\n` : "") +
      (hint.docType ? `The tech typed it as: ${hint.docType}.\n` : "") +
      "RULES:\n" +
      "- Report ONLY what the document states — author, date, conclusions, required repairs, code citations, dollar amounts, limits.\n" +
      "- keyFindings: every actionable requirement or number, one per entry. Quote or closely paraphrase; never editorialize.\n" +
      "- Receipts, subcontractor invoices and supplier quotes: fill vendor, docDate (ISO) and totalAmount (the printed TOTAL in dollars) — these become billable pass-throughs on the claim. Line-level charges go in keyFindings.\n" +
      "- Unreadable sections: say so rather than guessing.",
  });
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior restoration estimator at Roybal Construction, LLC digesting a third-party document (engineer's report, " +
      "hygienist report, adjuster estimate, permit letter) so its findings can be cited in the claim narrative and repair scope. " +
      "Accuracy over completeness: only what is printed. Call `doc_digest` with the digest.",
    content,
    toolName: "doc_digest",
    schema: DOC_DIGEST_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2048,
  });
  const d = input as { keyFindings?: unknown[] };
  return { result: { digest: input }, usage, model: DOC_MODEL, summary: { pages: content.length - 1, findings: d.keyFindings?.length ?? 0 } };
}

/* ============================================================
   Action: estimateImport — read an uploaded Xactimate / Symbility /
   carrier estimate PDF into structured line items + O&P/tax totals so
   the invoice or reconstruction estimate is built FROM the carrier's
   approved numbers, transcribed verbatim (never re-priced). Vision,
   multi-page. The tech reviews the imported lines before sending.
   ============================================================ */
const ESTIMATE_IMPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["source", "confidence", "lossSummary", "items", "summary", "notes"],
  properties: {
    source: { type: "string", description: "The estimating platform this document was produced with, judged from its layout/branding — 'Xactimate', 'Symbility', 'carrier estimate', or 'unknown'." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence the line items and totals were read correctly. Below 0.7 when the scan is faint, columns are ambiguous, or the totals don't reconcile." },
    lossSummary: { type: "string", description: "2-3 sentence scope / loss description from the estimate header or cover; empty string if none is printed." },
    estimateNo: { type: "string", description: "The estimate / claim number printed on the document, else empty." },
    estimateDate: { type: "string", description: "The estimate date printed on the document, ISO YYYY-MM-DD, else empty." },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["room", "desc", "qty", "unit", "price"],
        properties: {
          room: { type: "string", description: "The room / area heading this line falls beneath, verbatim (Xactimate lists line items under a room header). Use 'Main Level' for general / job-wide lines printed with no room heading." },
          desc: { type: "string", description: "The line item description EXACTLY as printed, expanding any Xactimate/Symbility item code to its printed plain-English description. Never leave a bare code; never repeat the room name inside the description." },
          qty: { type: "number", description: "The QUANTITY column value." },
          unit: { type: "string", description: "The unit column verbatim — SF, LF, EA, HR, DA, SY, CF, etc." },
          price: { type: "number", description: "The UNIT PRICE column in dollars (the per-unit rate) — NOT the extended/line-total column. This is the pre-O&P RCV unit price as printed." },
        },
      },
    },
    summary: {
      type: "object", additionalProperties: false,
      required: ["lineItemTotal", "overhead", "profit", "tax", "rcvTotal"],
      properties: {
        lineItemTotal: { type: ["number", "null"], description: "The printed 'Line Item Total' / net subtotal BEFORE overhead & profit, in DOLLARS; null if not printed." },
        overhead: { type: ["number", "null"], description: "The Overhead line from the Summary in DOLLARS (e.g. 944.24) — the actual dollar amount, NOT the percentage. Xactimate applies O&P only to eligible trades, so this is usually far less than 10% of the line item total. null when the estimate has no overhead line." },
        profit: { type: ["number", "null"], description: "The Profit line from the Summary in DOLLARS (e.g. 1038.66) — the actual dollar amount, NOT the percentage. null when none." },
        tax: { type: ["number", "null"], description: "Total sales tax from the Summary in DOLLARS; null when none (Alaska estimates usually have none)." },
        rcvTotal: { type: ["number", "null"], description: "The estimate's printed 'Replacement Cost Value' / grand total / Net Claim, in DOLLARS (e.g. 28421.93); null if not printed. Used to verify the import reconciles." },
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "Caveats — pages that were not estimate line-item pages (cover, recaps, area totals), unreadable lines, columns you had to infer, or totals that don't reconcile." },
  },
} as const;

async function estimateImport(body: Record<string, unknown>) {
  const pages = Array.isArray(body.pages) ? (body.pages as string[]).slice(0, 12) : [];
  if (!pages.length) throw new Error("Upload the estimate PDF or photos first.");
  const content: unknown[] = [];
  for (const src of pages) {
    const img = dataUrlToImage(src);
    if (img) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  if (!content.length) throw new Error("Couldn't read those pages as images.");
  content.push({
    type: "text",
    text:
      "Read EVERY line item off this insurance repair estimate (Xactimate, Symbility, or a carrier's own format) so it can be imported verbatim into our estimate.\n" +
      "LINE FORMAT — each printed line reads:  <line#>. <description>   <qty> <unit> @   <unitPrice> =   <extendedTotal>\n" +
      "  e.g.  '6. Air mover axial fan-up to 1/2 (per 24 hour period)-No monit.   70.00 EA @   32.25 =   2,257.50'  ->  desc='Air mover axial fan-up to 1/2 (per 24 hour period)-No monit.', qty=70, unit='EA', price=32.25\n" +
      "RULES:\n" +
      "- Import the numbers AS PRINTED — this is the carrier's approved pricing. Do NOT re-price, round, or add scope of your own.\n" +
      "- price = the UNIT PRICE column (the number right after '@', before '='). NEVER use the extended TOTAL column (the number after '='). qty = the quantity column; unit = the code between qty and '@' (SF, LF, EA, DA, HR, SY, CF...) verbatim.\n" +
      "- Strip the leading line number and period from the description. Line numbers may be out of sequence (Xactimate keeps original numbers when items are regrouped) — keep only the description text.\n" +
      "- ROOMS: line items are grouped beneath a room header printed as the room name with a right-aligned \"Height: 8'\" (e.g. 'Closet', 'Bathroom', 'kitchen/living room'). Put each line's room name verbatim in `room`. Lines printed BEFORE the first room header (directly under the estimate name — emergency service, dumpster, drying/air equipment, paid bills) have no room: put them under 'Main Level'.\n" +
      "- IGNORE non-line-item text inside room blocks: 'Missing Wall … Opens into X', 'Subroom:', dimension callouts and 'Height:' labels are NOT line items — never emit them as items.\n" +
      "- Expand any bare item code to its printed plain-English description; never put a raw code in desc, and never repeat the room name inside desc.\n" +
      "- Fill `summary` from the 'Summary' page in DOLLARS: Line Item Total, Overhead (dollars), Profit (dollars), sales tax (dollars — usually none in AK), and the Replacement Cost Value / Net Claim. Overhead & Profit are the DOLLAR figures, not the 10% labels. Leave a field null when not printed.\n" +
      "- SKIP pages that are not line-item pages: the cover/coversheet, 'Grand Total Areas', 'Summary' (except the totals above), 'Recap of Taxes, Overhead and Profit', 'Recap by Room', and 'Recap by Category'. Their subtotals are NOT line items. Never invent lines to fill gaps.",
  });
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior estimator at Roybal Construction, LLC (North Pole / Fairbanks, Alaska) importing an insurance repair estimate " +
      "(Xactimate / Symbility / carrier format) into the company's own estimate. Transcribe the printed line items and totals EXACTLY — " +
      "the carrier's approved numbers are the source of truth and you never re-price or add scope. Precision over completeness: flag anything " +
      "unreadable rather than guessing. Call `estimate_import` with the transcription.",
    content,
    toolName: "estimate_import",
    schema: ESTIMATE_IMPORT_SCHEMA as unknown as Record<string, unknown>,
    // full estimates run long (every room × many trades) — match the draft cap
    maxTokens: 16384,
  });
  const d = input as { items?: unknown[] };
  return { result: { estimate: input }, usage, model: DOC_MODEL, summary: { pages: content.length - 1, items: d.items?.length ?? 0 } };
}

/* ============================================================
   Action: rebuildDraft — reconstruction plan from a restoration job
   (Phase 3: mitigation job converts to a rebuild construction job)
   ============================================================ */
// Mirrors TRADES in apps/field/js/model.js — the form's trade <select> only
// renders these values, so the schema enforces the list rather than trusting prose.
const REBUILD_TRADES = [
  "Demo", "Framing", "Electrical", "Plumbing", "HVAC", "Insulation",
  "Drywall", "Paint", "Flooring", "Trim / Doors", "Cabinets / Counters", "Roofing", "Other",
];
const REBUILD_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["scopeAreas", "tradeSequence", "selections", "questions"],
  properties: {
    scopeAreas: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["area", "items"],
        properties: {
          area: { type: "string", description: "Room / area name exactly as documented (e.g. 'Living Room')" },
          items: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["trade", "desc", "qty", "unit", "confidence"],
              properties: {
                trade: { type: "string", enum: REBUILD_TRADES },
                desc: { type: "string", description: "Plain-English rebuild scope line, e.g. 'Hang, tape and finish drywall, lower 4 ft of walls'" },
                qty: { type: "number", description: "Quantity; 0 when unknown" },
                unit: { type: "string", description: "SF, LF, EA, HR or LS" },
                confidence: { type: "number", minimum: 0, maximum: 1, description: "Below 0.7 when inferred rather than documented" },
              },
            },
          },
        },
      },
    },
    tradeSequence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["trade", "note"],
        properties: {
          trade: { type: "string", enum: REBUILD_TRADES, description: "In build order" },
          note: { type: "string", description: "One-line reason / dependency (e.g. 'after insulation inspection')" },
        },
      },
    },
    selections: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["area", "item", "spec", "confidence"],
        properties: {
          area: { type: "string" },
          item: { type: "string", description: "What the owner must choose, e.g. 'Carpet + pad'" },
          spec: { type: "string", description: "Known spec/match detail, else empty" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    questions: {
      type: "array",
      items: { type: "string", description: "Open question for the estimator — something the documentation doesn't answer" },
    },
  },
} as const;

async function rebuildDraft(body: Record<string, unknown>) {
  const facts = body.facts;
  if (!facts || typeof facts !== "object") throw new Error("Missing `facts` digest.");
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are a senior reconstruction estimator at Roybal Construction, LLC (North Pole / Fairbanks, Alaska). A water-mitigation " +
      "job is converting to a rebuild: draft the reconstruction plan FROM THE DOCUMENTED MITIGATION FACTS ONLY — the rebuild " +
      "restores exactly what the mitigation removed (flood cuts, flooring, insulation, contents losses). Never invent scope the " +
      "documentation doesn't support; put anything uncertain in `questions` instead. Call `rebuild_plan` with the draft.",
    content:
      `Draft the reconstruction plan for this converted mitigation job.\n\n` +
      `RULES:\n` +
      `- Scope lines restore documented demo: drywall cut heights, removed flooring/insulation/trim, antimicrobial-treated areas needing repaint.\n` +
      `- Group lines by the documented room/area names. Use the trade list verbatim.\n` +
      `- qty/unit only when the documentation supports a number (e.g. cut height × wall length); otherwise qty 0 and a confidence below 0.7.\n` +
      `- facts.planDimensions (when present) are tech-verified measurements from the dimensioned floor plan — use them to fill SF/LF quantities with confidence.\n` +
      `- tradeSequence: the build order for THIS scope only (demo-complete → rough-in → insulation → drywall → paint → flooring → trim → punch), skipping trades with no scope.\n` +
      `- selections: every owner choice the rebuild needs (flooring, paint colors, trim profile, fixtures) based on what was removed.\n` +
      `- questions: what the estimator must confirm on site (hidden damage, matching, code upgrades).\n\n` +
      `DOCUMENTED MITIGATION FACTS (use ONLY these):\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``,
    toolName: "rebuild_plan",
    schema: REBUILD_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4096,
  });
  const d = input as { scopeAreas?: unknown[]; selections?: unknown[]; questions?: unknown[] };
  return {
    result: { draft: input }, usage, model: DOC_MODEL,
    summary: { areas: d.scopeAreas?.length ?? 0, selections: d.selections?.length ?? 0, questions: d.questions?.length ?? 0 },
  };
}

/* ============================================================
   Action: contentsVision — personal-property inventory from photos
   mode "item": identify ONE item in detail (claim fields + est. RCV)
   mode "scan": list EVERY distinct item visible (bulk room capture)
   ============================================================ */
const CONTENTS_ITEM_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "brand", "model", "category", "condition", "estimatedValue", "notes", "confidence"],
  properties: {
    name: { type: "string", description: "Short inventory name, e.g. '55\" Samsung TV' or 'Leather reclining sofa'" },
    brand: { type: "string", description: "Brand if identifiable from the photo, else empty" },
    model: { type: "string", description: "Model number if legible, else empty" },
    category: { type: "string", description: "Best fit from the provided category list, verbatim" },
    condition: { type: "string", description: "Best fit from the provided condition list based on what is visible" },
    estimatedValue: { type: "number", description: "Typical replacement cost NEW (RCV) in US dollars for a comparable item — a starting point the office verifies" },
    notes: { type: "string", description: "Visible damage or claim-relevant details, one sentence, else empty" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const CONTENTS_SCAN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "category", "qty", "condition", "estimatedValue", "confidence"],
        properties: {
          name: { type: "string", description: "Short inventory name for one distinct item" },
          category: { type: "string", description: "Best fit from the provided category list, verbatim" },
          qty: { type: "number", description: "Count of this identical item visible" },
          condition: { type: "string", description: "Best fit from the provided condition list" },
          estimatedValue: { type: "number", description: "Typical replacement cost NEW (RCV) per unit, US dollars" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

async function contentsVision(body: Record<string, unknown>) {
  const mode = body.mode === "scan" ? "scan" : "item";
  const image = dataUrlToImage(String(body.image || ""));
  if (!image) throw new Error("Provide `image` as a JPEG/PNG data URL.");
  const cats = Array.isArray(body.categories) ? (body.categories as string[]).join(", ") : "";
  const conds = Array.isArray(body.conditions) ? (body.conditions as string[]).join(", ") : "";
  const text = mode === "item"
    ? `Identify the single main personal-property item in this photo for an insurance contents inventory.\n` +
      `CATEGORIES (pick one verbatim): ${cats}\nCONDITIONS (pick one verbatim): ${conds}\n` +
      `estimatedValue = typical replacement cost NEW for a comparable item, US retail. Be conservative and round sensibly. ` +
      `If brand/model aren't visible, leave them empty — never guess specifics.`
    : `List EVERY distinct personal-property item visible in this photo for an insurance contents inventory (bulk room capture). ` +
      `One entry per distinct item; identical items get one entry with qty. Skip fixtures and building materials (cabinets, flooring, trim) — personal property only.\n` +
      `CATEGORIES (pick one verbatim): ${cats}\nCONDITIONS (pick one verbatim): ${conds}\n` +
      `estimatedValue = typical replacement cost NEW per unit, US retail, conservative.`;
  const { input, usage } = await forcedTool({
    model: PHOTO_MODEL,
    system:
      "You are a contents-inventory specialist at Roybal Construction, LLC (water/fire restoration, Fairbanks Alaska) cataloging a customer's " +
      "personal property for an insurance claim. Only describe what is actually visible. Call `contents` with the structured result.",
    content: [
      { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
      { type: "text", text },
    ],
    toolName: "contents",
    schema: (mode === "item" ? CONTENTS_ITEM_SCHEMA : CONTENTS_SCAN_SCHEMA) as unknown as Record<string, unknown>,
    maxTokens: 2048,
  });
  return {
    result: mode === "item" ? { item: input } : { items: (input as { items?: unknown[] }).items ?? [] },
    usage, model: PHOTO_MODEL,
    summary: { mode, items: mode === "item" ? 1 : ((input as { items?: unknown[] }).items ?? []).length },
  };
}

/* ============================================================
   Action: contentsJustify — one-line total-loss justifications
   ============================================================ */
const JUSTIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["justifications"],
  properties: {
    justifications: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "text"],
        properties: {
          id: { type: "string", description: "The item id, verbatim" },
          text: { type: "string", description: "ONE sentence, adjuster-facing, e.g. 'Porous upholstered furniture saturated by Category 3 water; per IICRC S500 it cannot be restored to a sanitary condition.'" },
        },
      },
    },
  },
} as const;

async function contentsJustify(body: Record<string, unknown>) {
  const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
  if (!items.length) throw new Error("Provide `items` to justify.");
  const ctx = (body.context ?? {}) as Record<string, unknown>;
  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You write total-loss justifications for a restoration contractor's contents loss schedule. One factual, professional sentence " +
      "per item explaining why it is non-salvageable — cite the water category, the material's porosity, and IICRC S500 where they apply. " +
      "Never exaggerate and never invent damage that isn't supported by the item's condition/notes. Call `justify` with one entry per item id.",
    content:
      `LOSS CONTEXT: water category ${ctx.waterCategory || "?"}, cause: ${ctx.lossCause || "?"}, date of loss: ${ctx.dateOfLoss || "?"}.\n\n` +
      `NON-SALVAGEABLE ITEMS:\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\``,
    toolName: "justify",
    schema: JUSTIFY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3000,
  });
  const out = (input as { justifications?: unknown[] }).justifications ?? [];
  return { result: { justifications: out }, usage, model: DOC_MODEL, summary: { items: items.length, written: out.length } };
}

/* ============================================================
   Action: fieldAssist — conversational, job-aware field Q&A
   Voice (Deepgram STT) + photos (vision) + short colleague answers.
   ============================================================ */
const ASSIST_SYSTEM =
  "You are the senior IICRC WRT-certified lead at Roybal Construction, LLC (water/fire restoration and reconstruction, Fairbanks Alaska), " +
  "taking a quick call from one of your techs in the field mid-job. Answer like a sharp, friendly colleague on the phone:\n" +
  "- Lead with what to DO. Two to four short sentences for a typical question — actionable and direct.\n" +
  "- Cite the standard when it backs the call (IICRC S500 water, S520 mold, S700/S740 fire) in plain terms, e.g. 'S500 puts that at Cat 3 — it touched sewage'.\n" +
  "- On rebuild/construction questions cite the code the same way: 2022 International Residential Code (IRC) for framing/structural/general residential work, " +
  "2021 International Mechanical Code (IMC) for mechanical/HVAC/venting, 2026 National Electrical Code (NEC, NFPA 70) for electrical — " +
  "e.g. 'IRC R302 wants that wall fire-blocked' or 'NEC 210.8 means GFCI within 6 ft of that sink'. Note when the local AHJ may have amended the adopted edition.\n" +
  "- Safety gates first: possible Cat 3, energized electrical, structural concerns, pre-1980s materials (asbestos/lead), or mold beyond ~10 sq ft mean STOP and say exactly what to check or who to call before proceeding.\n" +
  "- Use the JOB CONTEXT so the answer fits THIS job (category, class, cause, materials, equipment, readings). Never invent readings or facts.\n" +
  "- If you need one piece of information to answer safely, ask ONE pointed question back instead of guessing.\n" +
  "- Go deeper only when the tech asks (why / explain / walk me through it).\n" +
  "Tone: warm, plain language, zero fluff — a knowledgeable colleague, never a manual. No headings, no bullet lists unless listing steps the tech must do in order.";

async function fieldAssist(body: Record<string, unknown>) {
  const history = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; text: string }>).slice(-12) : [];
  const images = Array.isArray(body.images) ? (body.images as string[]).slice(0, 4) : [];
  let userText = String(body.text ?? "").trim();
  let transcript: string | null = null;

  if (body.audio) {
    transcript = await sttTranscribe(b64ToBytes(String(body.audio)), String(body.audioMime || "audio/webm"));
    if (!transcript) throw new Error("Didn't catch that — try again closer to the mic.");
    userText = transcript;
  }
  // dictation mode: STT only, no LLM turn — powers voice answers on the
  // estimator / timeline questionnaires (costs nothing on the token ledger)
  if (body.transcribeOnly) {
    if (!transcript) throw new Error("Dictation needs audio.");
    return { result: { reply: "", transcript, replyAudio: null }, usage: { inTok: 0, outTok: 0 }, model: "deepgram-stt", summary: { transcribeOnly: true } };
  }
  if (!userText && !images.length) throw new Error("Ask a question (text or voice), or attach a photo.");

  const msgs: unknown[] = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.text || "").trim())
    .map((m) => ({ role: m.role, content: String(m.text) }));
  const finalContent: unknown[] = [];
  for (const src of images) {
    const img = dataUrlToImage(src);
    if (img) finalContent.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  finalContent.push({ type: "text", text: userText || "Here's the situation in the photo — what should I do?" });
  msgs.push({ role: "user", content: finalContent });

  const context = body.context ? `\n\nJOB CONTEXT (current job):\n\`\`\`json\n${JSON.stringify(body.context)}\n\`\`\`` : "";
  const { text, usage } = await chatText({ model: ASSIST_MODEL, system: ASSIST_SYSTEM + context, messages: msgs, maxTokens: 1024 });
  // voice agent: speak the reply back (best-effort — a TTS hiccup never eats the answer)
  let replyAudio: string | null = null;
  if (body.speak && text) { try { replyAudio = await ttsSpeak(text); } catch (_) { replyAudio = null; } }
  return { result: { reply: text, transcript, replyAudio }, usage, model: ASSIST_MODEL, summary: { turns: history.length + 1, images: images.length, voice: !!transcript, spoken: !!replyAudio } };
}

/* ============================================================
   Action: portalDraft — customer-facing message drafts for the portal
   thread. mode "reply": answer the customer's latest message(s);
   mode "status": a proactive progress update. The office reviews and
   sends — nothing here reaches the customer unattended.

   PRIVACY: this action is given ONLY the customer-safe digest the client
   assembles from the curated projection + the portal thread (status,
   milestone labels, shared-photo captions, the messages both parties
   already exchanged). No costs, adjuster, claim, or Field Report data is
   ever passed in, so none can surface in a draft.
   ============================================================ */
const PORTAL_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", description: "The customer-facing message, plain text, ready to send as-is (the office may still edit)." },
  },
} as const;

async function portalDraft(body: Record<string, unknown>) {
  const mode = body.mode === "status" ? "status" : "reply";
  const digest = (body.digest ?? {}) as Record<string, unknown>;
  const thread = Array.isArray(body.thread) ? (body.thread as Array<{ from?: string; body?: string }>).slice(-20) : [];
  if (mode === "reply" && !thread.some((m) => m.from === "customer"))
    throw new Error("No customer message to reply to yet.");

  const threadText = thread.length
    ? thread.map((m) => `${m.from === "customer" ? "CUSTOMER" : "US"}: ${String(m.body || "").slice(0, 800)}`).join("\n")
    : "(no messages yet)";

  const ask = mode === "status"
    ? "Write a short, warm proactive update to send the customer about where their project stands right now — what's done, what's happening now, and what's next. 2-4 sentences. Don't promise specific dates unless a date is in the facts."
    : "Write a friendly, helpful reply to the customer's most recent message. Answer their question directly from the facts you have. 1-4 sentences. If they ask something the facts don't cover (a specific date, a price, an insurance detail), don't guess — say we'll check with the team and get right back to them.";

  const { input, usage } = await forcedTool({
    model: DOC_MODEL,
    system:
      "You are the office at Roybal Construction, LLC (a family water/fire restoration and reconstruction company in North Pole / Fairbanks, " +
      "Alaska) writing to a residential customer through their project portal. Warm, plain-spoken, reassuring, and concise — a real person " +
      "who knows their job, not a form letter. You know ONLY the customer-safe facts provided below (job status, milestones, shared photos, " +
      "and the message thread). NEVER invent completion dates, prices, insurance details, or anything not in the facts. Never mention internal " +
      "costs, adjusters, or claim specifics. No subject line, no signature (the portal adds our name). Call `portal_message` with the text.",
    content:
      `${ask}\n\n` +
      `CUSTOMER-SAFE JOB FACTS:\n\`\`\`json\n${JSON.stringify(digest, null, 2)}\n\`\`\`\n\n` +
      `MESSAGE THREAD SO FAR (oldest to newest):\n${threadText}`,
    toolName: "portal_message",
    schema: PORTAL_DRAFT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 800,
  });
  const msg = String((input as { message?: string }).message ?? "");
  return { result: { draft: { message: msg } }, usage, model: DOC_MODEL, summary: { mode, chars: msg.length } };
}

/* ============================================================
   Handler — same self-protection invariants as roybal-ai-ingest:
   anon key only (RLS always applies), the caller's JWT on every DB op,
   and the RLS-gated capture_events insert BEFORE any paid LLM call.
   ============================================================ */
const ACTIONS: Record<string, (body: Record<string, unknown>) => Promise<{ result: Record<string, unknown>; usage: Usage; model: string; summary: Record<string, unknown> }>> = {
  photoAnalysis, invoiceDraft, invoiceAudit, scopeInterview, adjusterEmail, contentsVision, contentsJustify, fieldAssist, rebuildDraft, progressNarrative, timelineDraft, planDimensions, docDigest, estimateImport, portalDraft,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);

  let captureEventId: string | null = null;
  try {
    const body = (await req.json()) ?? {};
    // Actions that price against public.price_list need the caller's JWT (RLS
    // lets any authenticated user READ the catalog). Thread it through the body.
    (body as Record<string, unknown>)._jwt = jwt;
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
