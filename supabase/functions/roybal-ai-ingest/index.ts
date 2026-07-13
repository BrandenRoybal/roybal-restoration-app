/**
 * Supabase Edge Function: roybal-ai-ingest
 *
 * The online-only "brain" for voice capture (handoff Step C). A field tech
 * records a spoken log; the app POSTs it here. This function:
 *   1. writes a capture_events row (status='pending'),
 *   2. checks the monthly AI spend cap (sum of ai_usage for this month),
 *   3. runs speech-to-text (Deepgram) -> transcript,
 *   4. runs LLM extraction (Anthropic, forced tool-call) -> structured
 *      candidate fields scoped to the target form,
 *   5. saves the result (status='extracted'), writes an ai_usage ledger row,
 *   6. returns { capture_event_id, transcript, candidates }.
 *
 * NO API KEYS LIVE IN THE CLIENT. They are Supabase function secrets
 * (STT_API_KEY, LLM_API_KEY). Mirrors the existing magicplan-proxy /
 * qb-time-proxy pattern (raw fetch, CORS, { ok, ... } envelope).
 *
 * Deploy:  supabase functions deploy roybal-ai-ingest
 * Secrets: see ./README.md
 *
 * Request body (JSON):
 *   {
 *     unified_job_id?:    string | null,   // spine row id (Step B); tolerated null
 *     phase_instance_id?: string | null,
 *     form_key:           "moistureMaps"|"dryingLogs"|"photos"|"constructionLogs"
 *                         |"punchList"|"subSchedule"|"inspections"|"selections"|"changeOrders",
 *     captured_by?:       string,          // which tech (Step E) — recommended for attribution
 *     water_category?:    string,          // "1"|"2"|"3" — prompt context
 *     audio?:             string,          // base64 (raw or data: URL); OR pass transcript
 *     audio_mime?:        string,          // e.g. "audio/webm" (when audio present)
 *     transcript?:        string           // skip STT (testing / retry / no signal for audio)
 *   }
 *
 * Success (HTTP 200):
 *   { ok:true, capped:false, capture_event_id, transcript, candidates, spend }
 * Capped (HTTP 200):
 *   { ok:true, capped:true, capture_event_id, spend }
 * Error (HTTP 400):
 *   { ok:false, error, capture_event_id }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/* ---------- config (function secrets + Supabase-injected env) ---------- */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const STT_API_KEY = Deno.env.get("STT_API_KEY") ?? "";        // Deepgram
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";        // Anthropic
const STT_MODEL = Deno.env.get("STT_MODEL") ?? "nova-3";
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "claude-opus-4-8";
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");
const STT_PRICE_PER_MIN = Number(Deno.env.get("STT_PRICE_PER_MIN") ?? "0.0043"); // Deepgram nova-3 PAYG

// LLM price per 1M tokens (input/output). Defaults cover the common models;
// override via LLM_PRICE_IN / LLM_PRICE_OUT if you change LLM_MODEL or pricing shifts.
const LLM_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};
const LLM_PRICE_IN = Number(Deno.env.get("LLM_PRICE_IN") ?? (LLM_PRICES[LLM_MODEL]?.in ?? 1.0));
const LLM_PRICE_OUT = Number(Deno.env.get("LLM_PRICE_OUT") ?? (LLM_PRICES[LLM_MODEL]?.out ?? 5.0));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/* ============================================================
   Per-form extraction schemas (the LLM is forced to call `extract`
   with input matching the target form). Keys mirror the candidate
   shapes in apps/field/js/ai.js, which maps them to model.js fields.
   ============================================================ */
const CONF = { type: "number", minimum: 0, maximum: 1, description: "0-1 confidence the tech actually said this" };
const UNMAPPED = { type: "array", items: { type: "string" }, description: "Things the tech said that don't fit a field — never drop them silently" };

const FORM_SCHEMAS: Record<string, { label: string; schema: Record<string, unknown> }> = {
  dryingLogs: {
    label: "Drying Log (psychrometric readings + drying equipment)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        psychrometric: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              location: { type: "string", enum: ["affected", "outside", "reference"] },
              temp: { type: "number", description: "temperature °F" },
              rh: { type: "number", description: "relative humidity %" },
              confidence: CONF,
            },
            required: ["location"],
          },
        },
        equipment: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              type: { type: "string", description: "e.g. air_mover, lgr_dehumidifier, air_scrubber, heater" },
              count: { type: "number" },
              location: { type: "string" },
              placed: { type: "string", description: "date placed if stated" },
              removed: { type: "string", description: "date removed if stated" },
              confidence: CONF,
            },
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  moistureMaps: {
    label: "Moisture Map (affected material + dated MC% readings)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        label: { type: "string", description: "room / area name" },
        material: { type: "string", description: "e.g. drywall, subfloor, carpet" },
        dryGoal: { type: "number", description: "dry standard / goal if stated" },
        readings: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              location: { type: "string", description: "where the reading was taken" },
              mc_pct: { type: "number", description: "moisture content %" },
              confidence: CONF,
            },
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  photos: {
    label: "Photo Log (stage + room + caption per photo)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        photos: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              stage: { type: "string", enum: ["before", "during", "after"] },
              room: { type: "string" },
              caption: { type: "string", description: "concise description of what the photo shows" },
              confidence: CONF,
            },
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  constructionLogs: {
    label: "Daily Construction Log (crew, task, hours per row)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              employee: { type: "string" },
              task: { type: "string" },
              start: { type: "string", description: "start time if stated" },
              finish: { type: "string", description: "finish time if stated" },
              hours: { type: "number" },
              confidence: CONF,
            },
          },
        },
        notes: { type: "string" },
        unmapped: UNMAPPED,
      },
    },
  },
  // ---------- construction / remodel forms (Phase 4) ----------
  punchList: {
    label: "Punch List (walkthrough items: area, item, responsible trade, priority)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              area: { type: "string", description: "room / area, e.g. Master Bath" },
              item: { type: "string", description: "the defect / task, e.g. 'door casing scratched'" },
              trade: { type: "string", enum: ["Demo", "Framing", "Electrical", "Plumbing", "HVAC", "Insulation", "Drywall", "Paint", "Flooring", "Trim / Doors", "Cabinets / Counters", "Roofing", "Other"], description: "who fixes it" },
              priority: { type: "string", enum: ["low", "normal", "high"] },
              confidence: CONF,
            },
            required: ["item"],
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  subSchedule: {
    label: "Subcontractor Schedule (trade, company, scheduled dates, status)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              trade: { type: "string", enum: ["Demo", "Framing", "Electrical", "Plumbing", "HVAC", "Insulation", "Drywall", "Paint", "Flooring", "Trim / Doors", "Cabinets / Counters", "Roofing", "Other"] },
              company: { type: "string" },
              schedStart: { type: "string", description: "ISO date if stated (resolve 'Tuesday' etc. only when unambiguous)" },
              schedEnd: { type: "string", description: "ISO date if stated" },
              status: { type: "string", enum: ["scheduled", "on-site", "done", "no-show"] },
              confidence: CONF,
            },
            required: ["trade"],
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  inspections: {
    label: "Inspection Record (type, date, inspector, result, corrections)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["Footing / Foundation", "Framing", "Rough Electrical", "Rough Plumbing", "Rough Mechanical", "Insulation", "Drywall / Nailing", "Final Electrical", "Final Plumbing", "Final Mechanical", "Final / CO"] },
        scheduled: { type: "string", description: "ISO date if stated" },
        inspector: { type: "string" },
        result: { type: "string", enum: ["pass", "fail", "partial"] },
        corrections: { type: "string", description: "required corrections, verbatim gist" },
        reinspection: { type: "string", description: "ISO reinspection date if stated" },
        confidence: CONF,
        unmapped: UNMAPPED,
      },
    },
  },
  selections: {
    label: "Selections Sheet (owner finish/fixture choices: area, item, spec, allowance)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              area: { type: "string" },
              item: { type: "string", description: "what the owner must choose, e.g. 'kitchen faucet'" },
              spec: { type: "string", description: "model / color / spec detail if stated" },
              allowance: { type: "number", description: "allowance dollars if stated" },
              confidence: CONF,
            },
            required: ["item"],
          },
        },
        unmapped: UNMAPPED,
      },
    },
  },
  changeOrders: {
    label: "Change Order (scope change description, added days, priced line items)",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        description: { type: "string", description: "what changed and why, e.g. 'found rot in the subfloor behind the tub'" },
        daysAdded: { type: "number", description: "schedule days added if stated" },
        items: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              desc: { type: "string", description: "scope line, e.g. 'Sister two floor joists'" },
              qty: { type: "number" },
              unit: { type: "string", description: "EA, SF, LF, HR or LS" },
              price: { type: "number", description: "unit price in dollars; a spoken lump sum goes on one LS line" },
              confidence: CONF,
            },
            required: ["desc"],
          },
        },
        confidence: CONF,
        unmapped: UNMAPPED,
      },
    },
  },
};

/* ============================================================
   Supabase REST (forward the caller's JWT so RLS applies as the
   signed-in company user — no service-role secret needed).
   ============================================================ */
function db(path: string, jwt: string, opts: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function insertRow(table: string, row: Record<string, unknown>, jwt: string) {
  const res = await db(table, jwt, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`insert ${table} failed (${res.status}): ${await res.text().catch(() => "")}`);
  const rows = await res.json().catch(() => []);
  return rows[0] ?? null;
}

async function patchCaptureEvent(id: string, patch: Record<string, unknown>, jwt: string) {
  // best-effort: never let a status update mask the real result/error
  try {
    await db(`capture_events?id=eq.${id}`, jwt, { method: "PATCH", body: JSON.stringify(patch) });
  } catch (_) { /* ignore */ }
}

function billingMonth(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM' (UTC) — matches ai_usage.billing_month
}

async function monthSpend(jwt: string): Promise<number> {
  const res = await db(`ai_usage?select=cost_usd&billing_month=eq.${billingMonth()}`, jwt, { method: "GET" });
  if (!res.ok) throw new Error(`spend read failed (${res.status}): ${await res.text().catch(() => "")}`);
  const rows = (await res.json().catch(() => [])) as Array<{ cost_usd: number }>;
  return rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
}

/* ============================================================
   Providers
   ============================================================ */
function decodeBase64Audio(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64; // strip data: URL prefix
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Deepgram pre-recorded STT. Returns { transcript, seconds }. */
async function transcribe(audio: Uint8Array, mime: string): Promise<{ transcript: string; seconds: number }> {
  if (!STT_API_KEY) throw new Error("stt_key_missing: set the STT_API_KEY function secret (Deepgram) to transcribe audio");
  const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(STT_MODEL)}&smart_format=true&punctuate=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${STT_API_KEY}`, "Content-Type": mime || "audio/webm" },
    body: audio,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`stt_failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  const seconds = Number(data?.metadata?.duration ?? 0) || 0;
  return { transcript, seconds };
}

/** Anthropic extraction via a forced tool-call. Returns { candidates, inputTokens, outputTokens }. */
async function extract(transcript: string, formKey: string, waterCategory?: string) {
  if (!LLM_API_KEY) throw new Error("llm_key_missing: set the LLM_API_KEY function secret (Anthropic)");
  const form = FORM_SCHEMAS[formKey];
  const catLine = waterCategory ? ` This is a Category ${waterCategory} water loss.` : "";
  const system =
    `You extract structured field data from a field technician's spoken ${form.label} on a restoration or construction job.${catLine} ` +
    `Call the \`extract\` tool with only the fields the tech actually stated. Use the exact enum values. ` +
    `Give every value a confidence from 0 to 1. Put anything you can't confidently map into \`unmapped\`. Never invent values that weren't spoken.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: `Technician's spoken ${form.label}:\n\n"${transcript}"` }],
      tools: [{ name: "extract", description: `Return the structured ${form.label}.`, input_schema: form.schema }],
      tool_choice: { type: "tool", name: "extract" },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`llm_failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  // a long dictation (50+ punch rows) can exhaust the budget mid-JSON — fail
  // loudly instead of silently dropping the tail rows
  if (data.stop_reason === "max_tokens") {
    throw new Error("dictation_too_long: that recording has more items than one pass can return — split it into a couple of shorter recordings");
  }
  const block = (data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "extract");
  if (!block) throw new Error("extraction_failed: model returned no structured candidates");
  const candidates = { form_key: formKey, ...(block.input ?? {}) };
  const usage = data.usage ?? {};
  return { candidates, inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 };
}

/* Cost formula — same arithmetic as estimateCost() in apps/field/js/ai.js. */
function estimateCost(audioSeconds: number, inputTokens: number, outputTokens: number) {
  const sttCost = Math.max(0, (audioSeconds / 60) * STT_PRICE_PER_MIN);
  const llmCost = Math.max(0, (inputTokens / 1e6) * LLM_PRICE_IN + (outputTokens / 1e6) * LLM_PRICE_OUT);
  return { sttCost, llmCost, total: sttCost + llmCost };
}

/* ============================================================
   Handler
   ------------------------------------------------------------
   SECURITY INVARIANT — deployed with `--no-verify-jwt` (required: a
   browser CORS preflight carries no token, so the platform JWT gate
   would reject it). That is SAFE only because this function is
   self-protecting, and it STAYS safe ONLY while all of these hold:
     1. No service_role key is ever used here (env is ANON_KEY only),
        so the function physically cannot bypass RLS.
     2. Every DB op uses the CALLER's forwarded JWT — db(path, jwt, …).
     3. The first action is the RLS-gated capture_events insert below,
        and NO paid call (Deepgram STT / Anthropic LLM) runs before it.
   A forged/garbage token is rejected by PostgREST at that first insert,
   so it can never reach the paid pipeline. If you add a service_role
   client, or move an STT/LLM call ahead of the capture_events insert,
   this guarantee breaks — re-enable verify_jwt or restore the ordering.
   ============================================================ */
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  // Forward the signed-in tech's JWT for all DB work (RLS = authenticated).
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);

  let captureEventId: string | null = null;
  try {
    const body = await req.json();
    const {
      unified_job_id = null,
      phase_instance_id = null,
      form_key,
      captured_by = null,
      water_category = null,
      audio = null,
      audio_mime = "audio/webm",
      transcript: transcriptIn = null,
    } = body ?? {};

    if (!form_key || !FORM_SCHEMAS[form_key]) {
      return json({ ok: false, error: `Unknown or missing form_key. Expected one of: ${Object.keys(FORM_SCHEMAS).join(", ")}` }, 400);
    }
    if (!audio && !transcriptIn) {
      return json({ ok: false, error: "Provide `audio` (base64) or `transcript`." }, 400);
    }
    // Validate before we persist or build the prompt: keep arbitrary text out of capture_events + the LLM system prompt.
    if (water_category != null && !["1", "2", "3"].includes(String(water_category))) {
      return json({ ok: false, error: "water_category must be '1', '2', or '3'." }, 400);
    }

    // 1. Envelope — every input lands in capture_events first.
    const ev = await insertRow("capture_events", {
      unified_job_id,
      phase_instance_id,
      source_type: "voice",
      form_key,
      captured_by,
      raw_payload: { audio_mime: audio ? audio_mime : null, has_audio: !!audio, water_category, stt_model: STT_MODEL, llm_model: LLM_MODEL },
      status: "pending",
    }, jwt);
    captureEventId = ev?.id ?? null;

    // 2. Spend cap — sum this month's ai_usage; refuse new AI spend at/over the cap.
    const spent = await monthSpend(jwt);
    if (SPEND_CAP_USD > 0 && spent >= SPEND_CAP_USD) {
      await patchCaptureEvent(captureEventId!, { status: "discarded", error: "spend_cap_reached", processed_at: new Date().toISOString() }, jwt);
      await insertRow("ai_usage", {
        capture_event_id: captureEventId, unified_job_id, captured_by, form_key,
        provider: "none", capped: true, cost_usd: 0, note: "monthly spend cap reached",
      }, jwt);
      return json({ ok: true, capped: true, capture_event_id: captureEventId, spend: { month_to_date_usd: spent, cap_usd: SPEND_CAP_USD } });
    }

    // 3. Speech-to-text (skip when a transcript was passed directly).
    let transcript = String(transcriptIn ?? "");
    let audioSeconds = 0;
    let usedStt = false;
    if (!transcriptIn && audio) {
      const out = await transcribe(decodeBase64Audio(String(audio)), String(audio_mime));
      transcript = out.transcript;
      audioSeconds = out.seconds;
      usedStt = true;
      await patchCaptureEvent(captureEventId!, { transcript }, jwt);
    }
    if (!transcript.trim()) throw new Error("empty_transcript: nothing to extract from");

    // 4. LLM extraction (forced tool-call -> structured candidates).
    const { candidates, inputTokens, outputTokens } = await extract(transcript, form_key, water_category ?? undefined);

    // 5. Cost + persist result + ledger row.
    const cost = estimateCost(audioSeconds, inputTokens, outputTokens);
    await patchCaptureEvent(captureEventId!, {
      transcript,
      result: candidates,
      status: "extracted",
      processed_at: new Date().toISOString(),
      raw_payload: {
        audio_mime: audio ? audio_mime : null, has_audio: !!audio, water_category,
        stt_model: usedStt ? STT_MODEL : null, llm_model: LLM_MODEL,
        audio_seconds: audioSeconds, input_tokens: inputTokens, output_tokens: outputTokens,
        cost_usd: cost.total,
      },
    }, jwt);

    await insertRow("ai_usage", {
      capture_event_id: captureEventId, unified_job_id, captured_by, form_key,
      provider: usedStt ? "deepgram+anthropic" : "anthropic",
      stt_model: usedStt ? STT_MODEL : null, llm_model: LLM_MODEL,
      audio_seconds: audioSeconds, input_tokens: inputTokens, output_tokens: outputTokens,
      stt_cost_usd: cost.sttCost, llm_cost_usd: cost.llmCost, cost_usd: cost.total, capped: false,
    }, jwt);

    return json({
      ok: true,
      capped: false,
      capture_event_id: captureEventId,
      transcript,
      candidates,
      spend: { month_to_date_usd: spent + cost.total, cap_usd: SPEND_CAP_USD, this_call_usd: cost.total },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (captureEventId) await patchCaptureEvent(captureEventId, { error: message }, jwt);
    return json({ ok: false, error: message, capture_event_id: captureEventId }, 400);
  }
});
