/**
 * AI Proxy — Supabase Edge Function
 *
 * All Claude API calls happen server-side so the ANTHROPIC_API_KEY is
 * never exposed to the browser or mobile app.
 *
 * Actions:
 *   analyzePhotos     — vision analysis of job photos → captions + structured
 *                       analysis saved to photos.ai_caption / ai_analysis
 *   generateNarrative — insurance-ready job narrative from all job data,
 *                       saved to jobs.narrative (editable by the user)
 *   generateInvoice   — Xactimate-style invoice line-item draft from all job
 *                       data + the price catalog; returned to the client for
 *                       review/editing before saving
 *
 * Required secrets (supabase secrets set):
 *   ANTHROPIC_API_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "claude-opus-4-8";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const ok = (data: unknown) => json({ ok: true, data });
const err = (message: string, status = 400) => json({ ok: false, error: message }, status);

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

function anthropicClient() {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured. Run: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...");
  return new Anthropic({ apiKey });
}

/** Extract the text content from a Messages API response */
function responseText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Get a signed URL for a photo, trying both bucket names used by the apps */
async function signedPhotoUrl(
  supabase: ReturnType<typeof createClient>,
  storagePath: string
): Promise<string | null> {
  for (const bucket of ["photos", "job-photos"]) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, 600);
    if (!error && data?.signedUrl) {
      // Verify the object actually exists in this bucket
      const head = await fetch(data.signedUrl, { method: "HEAD" });
      if (head.ok) return data.signedUrl;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared job-data loader
// ---------------------------------------------------------------------------
async function loadJobData(supabase: ReturnType<typeof createClient>, jobId: string) {
  const [job, rooms, moisture, equipment, lineItems, photos] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", jobId).single(),
    supabase.from("rooms").select("*").eq("job_id", jobId).order("name"),
    supabase.from("moisture_readings").select("*").eq("job_id", jobId).order("reading_date"),
    supabase.from("equipment_logs").select("*").eq("job_id", jobId).order("date_placed"),
    supabase.from("line_items").select("*").eq("job_id", jobId).order("sort_order"),
    supabase.from("photos").select("*").eq("job_id", jobId).order("taken_at"),
  ]);
  if (job.error || !job.data) throw new Error("Job not found");
  return {
    job: job.data as Record<string, unknown>,
    rooms: (rooms.data ?? []) as Record<string, unknown>[],
    moisture: (moisture.data ?? []) as Record<string, unknown>[],
    equipment: (equipment.data ?? []) as Record<string, unknown>[],
    lineItems: (lineItems.data ?? []) as Record<string, unknown>[],
    photos: (photos.data ?? []) as Record<string, unknown>[],
  };
}

/** Compact, prompt-friendly summary of all documented job data */
function jobDataSummary(d: Awaited<ReturnType<typeof loadJobData>>, roomAreas?: Record<string, { floor_area: number; perimeter: number; net_wall_area: number; height: number }>) {
  const roomName = (id: unknown) => d.rooms.find((r) => r.id === id)?.name ?? "Unassigned";
  const lines: string[] = [];
  const j = d.job;

  lines.push(`JOB ${j.job_number} — ${j.property_address}`);
  lines.push(`Loss type: ${j.loss_type ?? "unknown"} | Category: ${j.loss_category ?? "unknown"} | Date of loss: ${j.date_of_loss ?? "unknown"} | Status: ${j.status}`);
  if (j.owner_name) lines.push(`Owner: ${j.owner_name}`);
  if (j.insurance_carrier) lines.push(`Insurance: ${j.insurance_carrier} | Claim #: ${j.claim_number ?? "n/a"} | Adjuster: ${j.adjuster_name ?? "n/a"}`);
  if (j.notes) lines.push(`Job notes: ${j.notes}`);

  lines.push(`\nROOMS (${d.rooms.length}):`);
  for (const r of d.rooms) {
    const area = roomAreas?.[String(r.name)];
    lines.push(
      `- ${r.name} (${r.floor_level} floor) — ${r.affected ? "AFFECTED" : "not affected"}` +
      (area ? ` | floor area ~${Math.round(area.floor_area)} SF, perimeter ~${Math.round(area.perimeter)} LF, wall area ~${Math.round(area.net_wall_area)} SF, ceiling height ${area.height} ft` : "")
    );
  }

  lines.push(`\nMOISTURE READINGS (${d.moisture.length}):`);
  for (const m of d.moisture) {
    lines.push(`- ${m.reading_date} | ${roomName(m.room_id)} | ${m.location_description} | ${m.material_type}: ${m.moisture_pct}% ${m.is_dry ? "(dry)" : "(WET)"}`);
  }

  lines.push(`\nEQUIPMENT (${d.equipment.length}):`);
  for (const e of d.equipment) {
    const days = e.date_removed
      ? Math.max(1, Math.round((new Date(String(e.date_removed)).getTime() - new Date(String(e.date_placed)).getTime()) / 86400000) + 1)
      : Math.max(1, Math.round((Date.now() - new Date(String(e.date_placed)).getTime()) / 86400000) + 1);
    lines.push(`- ${e.equipment_name} (${e.equipment_type}) in ${e.room_id ? roomName(e.room_id) : "general area"} | placed ${e.date_placed}${e.date_removed ? `, removed ${e.date_removed}` : ", STILL ON SITE"} | ~${days} day(s)`);
  }

  if (d.lineItems.length) {
    lines.push(`\nEXISTING SCOPE LINE ITEMS (${d.lineItems.length}):`);
    for (const li of d.lineItems) {
      lines.push(`- [${li.category}] ${li.description} | ${li.quantity} ${li.unit} @ $${(Number(li.unit_price) / 100).toFixed(2)} | room: ${li.room_id ? roomName(li.room_id) : "general"}`);
    }
  }

  const analyzed = d.photos.filter((p) => p.ai_analysis || p.caption);
  lines.push(`\nPHOTO DOCUMENTATION (${d.photos.length} photos, ${analyzed.length} with captions/analysis):`);
  for (const p of analyzed) {
    const a = p.ai_analysis as Record<string, unknown> | null;
    const parts = [
      `- [${p.category}] ${roomName(p.room_id)} @ ${p.taken_at}: ${p.caption ?? p.ai_caption ?? ""}`,
    ];
    if (a) {
      if (Array.isArray(a.damage_observed) && a.damage_observed.length) parts.push(`  damage: ${(a.damage_observed as string[]).join("; ")}`);
      if (Array.isArray(a.materials_affected) && a.materials_affected.length) parts.push(`  materials: ${(a.materials_affected as string[]).join("; ")}`);
      if (Array.isArray(a.safety_concerns) && a.safety_concerns.length) parts.push(`  safety: ${(a.safety_concerns as string[]).join("; ")}`);
    }
    lines.push(...parts);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Action: analyzePhotos
// ---------------------------------------------------------------------------
const PHOTO_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "caption",
    "room_type",
    "damage_observed",
    "materials_affected",
    "equipment_visible",
    "safety_concerns",
    "suggested_category",
    "restoration_notes",
  ],
  properties: {
    caption: {
      type: "string",
      description: "One-sentence professional caption suitable for an insurance photo report, e.g. 'Standing water and saturated carpet along the north wall of the living room.'",
    },
    room_type: { type: ["string", "null"], description: "Room type if identifiable (kitchen, bathroom, basement...)" },
    damage_observed: { type: "array", items: { type: "string" }, description: "Specific visible damage (water staining, swollen baseboard, mold growth, char, etc.)" },
    materials_affected: { type: "array", items: { type: "string" }, description: "Building materials visibly affected (drywall, carpet, hardwood, insulation...)" },
    equipment_visible: { type: "array", items: { type: "string" }, description: "Restoration equipment visible (air movers, dehumidifiers, air scrubbers, moisture meters...)" },
    safety_concerns: { type: "array", items: { type: "string" }, description: "Visible safety/health concerns (suspected mold, sewage, electrical hazards, structural issues)" },
    suggested_category: {
      type: ["string", "null"],
      enum: ["before", "during", "after", "moisture", "equipment", "general", null],
      description: "Best-fit photo category for this app",
    },
    restoration_notes: { type: ["string", "null"], description: "Brief note on restoration work implied by this photo (what should be/was done)" },
  },
} as const;

async function analyzePhotos(body: Record<string, unknown>) {
  const photoIds = body.photoIds as string[] | undefined;
  if (!photoIds?.length) return err("photoIds is required");
  if (photoIds.length > 25) return err("Analyze at most 25 photos per request");

  const supabase = serviceClient();
  const anthropic = anthropicClient();

  const { data: photoRows, error: pErr } = await supabase
    .from("photos")
    .select("*")
    .in("id", photoIds);
  if (pErr) return err(pErr.message, 500);
  if (!photoRows?.length) return err("No photos found");

  // Job + room context (all photos belong to the same job in practice)
  const jobId = photoRows[0].job_id as string;
  const [{ data: job }, { data: rooms }] = await Promise.all([
    supabase.from("jobs").select("job_number, loss_type, loss_category, property_address").eq("id", jobId).single(),
    supabase.from("rooms").select("id, name").eq("job_id", jobId),
  ]);
  const roomMap = Object.fromEntries((rooms ?? []).map((r) => [r.id, r.name]));

  const analyzeOne = async (photo: Record<string, unknown>) => {
    const url = await signedPhotoUrl(supabase, String(photo.storage_path));
    if (!url) return { id: photo.id, ok: false, error: "Photo file not found in storage" };

    const context = [
      `This photo is from a ${job?.loss_type ?? "property damage"} restoration job (${job?.loss_category ?? "category unknown"}).`,
      photo.room_id && roomMap[String(photo.room_id)] ? `Room: ${roomMap[String(photo.room_id)]}.` : "",
      `Current photo category: ${photo.category}.`,
      photo.caption ? `Technician's caption: "${photo.caption}".` : "",
    ].filter(Boolean).join(" ");

    try {
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: PHOTO_ANALYSIS_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url } },
              {
                type: "text",
                text:
                  `You are a senior water/fire/mold restoration estimator documenting a loss for an insurance claim. ${context}\n\n` +
                  `Analyze this job-site photo and return the structured analysis. Be specific and factual — only describe what is actually visible. ` +
                  `The caption must be professional, concise, and adjuster-ready.`,
              },
            ],
          },
        ],
      });

      if (msg.stop_reason === "refusal") {
        return { id: photo.id, ok: false, error: "Analysis was declined for this image" };
      }

      const analysis = JSON.parse(responseText(msg));
      const update: Record<string, unknown> = {
        ai_caption: analysis.caption,
        ai_analysis: analysis,
        ai_analyzed_at: new Date().toISOString(),
      };
      // Fill the display caption only if the tech hasn't written one
      if (!photo.caption) update.caption = analysis.caption;

      const { error: uErr } = await supabase.from("photos").update(update).eq("id", photo.id);
      if (uErr) return { id: photo.id, ok: false, error: uErr.message };
      return { id: photo.id, ok: true, analysis };
    } catch (e) {
      return { id: photo.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Run with limited concurrency
  const results: unknown[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < photoRows.length; i += CONCURRENCY) {
    const chunk = photoRows.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(analyzeOne))));
  }
  return ok({ results });
}

// ---------------------------------------------------------------------------
// Action: generateNarrative
// ---------------------------------------------------------------------------
async function generateNarrative(body: Record<string, unknown>) {
  const jobId = body.jobId as string | undefined;
  if (!jobId) return err("jobId is required");

  const supabase = serviceClient();
  const anthropic = anthropicClient();
  const data = await loadJobData(supabase, jobId);
  const summary = jobDataSummary(data);

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      "You are a senior project manager at Roybal Restoration, a water/fire/mold damage restoration company in Fairbanks, Alaska. " +
      "You write professional loss narratives that accompany insurance claims. Your narratives are factual, chronological, written in " +
      "third person past tense, and reference IICRC S500/S520 standards where applicable. You never invent facts that are not in the " +
      "documentation provided — if something is undocumented, you omit it rather than guessing.",
    messages: [
      {
        role: "user",
        content:
          `Write a complete job narrative for the following restoration job, ready to submit to the insurance adjuster.\n\n` +
          `Structure it as flowing paragraphs (no markdown, no headers, no bullet lists) covering, in order: ` +
          `(1) the loss and initial conditions found on arrival, (2) emergency mitigation performed, ` +
          `(3) drying strategy — equipment placed per room and why, (4) drying progress and moisture monitoring results, ` +
          `(5) demolition/removal performed if any, and (6) current status and completion/verification. ` +
          `Keep it under 600 words. Base it strictly on this documentation:\n\n${summary}`,
      },
    ],
  });

  if (msg.stop_reason === "refusal") return err("Narrative generation was declined", 500);
  const narrative = responseText(msg).trim();

  const { error: uErr } = await supabase
    .from("jobs")
    .update({ narrative, narrative_updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (uErr) return err(uErr.message, 500);

  return ok({ narrative });
}

// ---------------------------------------------------------------------------
// Action: generateInvoice
// ---------------------------------------------------------------------------
const INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "notes", "items"],
  properties: {
    title: { type: "string", description: "Short invoice title, e.g. 'Water Mitigation — 123 Main St'" },
    notes: { type: ["string", "null"], description: "Any assumptions or notes for the adjuster (1-3 sentences), or null" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["room_name", "code", "category", "description", "quantity", "unit", "unit_price", "notes"],
        properties: {
          room_name: { type: ["string", "null"], description: "Room this line applies to, or null for site-wide items" },
          code: { type: ["string", "null"], description: "Catalog code if the line comes from the catalog, else null" },
          category: { type: "string", description: "Category code: WTR, EQU, DMO, CLN, TRT, HMR, CON, LAB, DSP, or OTH" },
          description: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string", description: "EA, SF, LF, HR, Day, LS, CY, SY or CF" },
          unit_price: { type: "integer", description: "Unit price in CENTS (e.g. $12.50 = 1250)" },
          notes: { type: ["string", "null"], description: "Brief justification/measurement basis for this line, or null" },
        },
      },
    },
  },
} as const;

async function generateInvoice(body: Record<string, unknown>) {
  const jobId = body.jobId as string | undefined;
  if (!jobId) return err("jobId is required");
  const catalog = (body.catalog ?? []) as { code: string; category: string; description: string; unit: string; unit_price: number }[];
  const roomAreas = body.roomAreas as Record<string, { floor_area: number; perimeter: number; net_wall_area: number; height: number }> | undefined;

  const supabase = serviceClient();
  const anthropic = anthropicClient();
  const data = await loadJobData(supabase, jobId);
  const summary = jobDataSummary(data, roomAreas);

  const catalogText = catalog
    .map((c) => `${c.code} | ${c.category} | ${c.description} | ${c.unit} | $${(c.unit_price / 100).toFixed(2)}`)
    .join("\n");

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: { type: "json_schema", schema: INVOICE_SCHEMA } },
    system:
      "You are a senior restoration estimator at Roybal Restoration (Fairbanks, Alaska) who writes Xactimate-style invoices for " +
      "insurance claims. You produce complete, defensible line-item invoices: every line traces back to documented conditions " +
      "(moisture readings, equipment logs, photos, room measurements). You never bill for work that is not supported by the documentation.",
    messages: [
      {
        role: "user",
        content:
          `Create a complete line-item invoice draft for this job.\n\n` +
          `PRICE CATALOG (code | category | description | unit | default price) — prefer these codes and prices when a line matches:\n${catalogText}\n\n` +
          `RULES:\n` +
          `- Group lines by room using the documented room names; use null room_name for site-wide items (e.g. monitoring visits, disposal loads).\n` +
          `- Equipment rental: one line per equipment TYPE per room, quantity = total unit-days (units × days on site) from the equipment log.\n` +
          `- Use room floor areas / perimeters for SF and LF quantities when provided; otherwise make a conservative estimate and state the basis in the line's notes.\n` +
          `- Include monitoring visits based on the distinct moisture-reading dates.\n` +
          `- Include demolition/removal lines only where documentation (photos, scope items, notes) supports them.\n` +
          `- Include existing scope line items (they were entered manually by the crew) — carry them over, cleaned up, at their documented prices.\n` +
          `- Do not include overhead, profit, markup or tax lines — those are applied separately.\n` +
          `- unit_price is in CENTS.\n\n` +
          `JOB DOCUMENTATION:\n\n${summary}`,
      },
    ],
  });

  if (msg.stop_reason === "refusal") return err("Invoice generation was declined", 500);
  const draft = JSON.parse(responseText(msg));
  return ok({ draft });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const action = body.action as string;
    switch (action) {
      case "analyzePhotos":
        return await analyzePhotos(body);
      case "generateNarrative":
        return await generateNarrative(body);
      case "generateInvoice":
        return await generateInvoice(body);
      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (e) {
    console.error("ai-proxy error:", e);
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
