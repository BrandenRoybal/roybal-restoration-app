/* ============================================================
   Roybal Field Forms — office AI helpers (photo analysis, invoice
   draft/audit, adjuster email)
   ------------------------------------------------------------
   Thin client for the roybal-ai-office Edge Function. Same rules as
   voice capture: ONLINE-ONLY enhancements layered over the always-
   available manual forms — with no signal they degrade to a toast and
   never block typed entry. No AI keys in the client; spend rides the
   same monthly cap + ai_usage ledger as voice/narrative.
   ============================================================ */
import { SUPABASE_URL, SUPABASE_KEY, SYNC_ENABLED } from "./config.js";
import { isSignedIn, accessToken } from "./supa.js";
import { getUnifiedJobId } from "./spine.js";
import { capturedBy } from "./tech.js";
import { narrativeFacts } from "./narrative.js";
import { PRICE_CATALOG } from "./pricing.js";
import { toast } from "./core.js";

const FN_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/roybal-ai-office` : "";

/** Silent readiness check — for auto-fired AI that must never nag offline. */
export function aiReady() {
  return !!(SYNC_ENABLED && FN_URL && isSignedIn() &&
    !(typeof navigator !== "undefined" && navigator.onLine === false));
}

/** True when the online-only AI path is usable right now (else toasts why). */
export function aiAvailable() {
  if (!SYNC_ENABLED || !FN_URL) { toast("AI needs the cloud backend configured."); return false; }
  if (!isSignedIn()) { toast("Sign in to use AI features."); return false; }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    toast("No connection — AI needs internet. Your typed entries are saved.");
    return false;
  }
  return true;
}

async function callOffice(project, action, payload) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + accessToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      unified_job_id: getUnifiedJobId(project.id),
      captured_by: capturedBy(),
      ...payload,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `${action} failed (${res.status})`);
  if (body.capped) throw new Error(`Monthly AI spend cap reached ($${body.spend?.cap_usd ?? "?"}) — resets next month.`);
  return body;
}

/* ---------- photo analysis ---------- */
/** Analyze the given project photos (≤10 per call). Returns [{id, ok, analysis?, error?}]. */
export function analyzePhotos(project, photos) {
  return callOffice(project, "photoAnalysis", {
    context: { lossCause: project.lossCause || "", waterCategory: project.waterCategory || "", address: project.address || "" },
    photos: photos.slice(0, 10).map((p) => ({
      id: p.id, image: p.src, room: p.room || "", stage: p.stage || "", caption: p.caption || "",
    })),
  }).then((b) => b.results ?? []);
}

/** Write an analysis onto its photo: fill the caption only if the tech left it blank. */
export function applyPhotoAnalysis(photo, analysis) {
  photo.ai = {
    caption: analysis.caption || "",
    damage: analysis.damage || [],
    materials: analysis.materials || [],
    equipment: analysis.equipment || [],
    safety: analysis.safety || [],
    confidence: analysis.confidence ?? null,
    at: new Date().toISOString(),
  };
  if (!String(photo.caption || "").trim() && analysis.caption) photo.caption = analysis.caption;
}

/* ---------- invoice facts (digest for draft + audit) ---------- */
function laborSummary(project) {
  const entries = Array.isArray(project.laborLog?.entries) ? project.laborLog.entries : [];
  const hours = entries.reduce((a, e) => a + (parseFloat(e.hours) || 0), 0);
  if (!entries.length) return null;
  return {
    source: "QuickBooks Time",
    totalHours: Math.round(hours * 100) / 100,
    // per-entry detail so hours can be divided into task-specific billable
    // lines — the crew's timesheet notes are the justification for each line
    entries: entries.slice(0, 150).map((e) => ({
      date: e.date || "", employee: e.employee || "",
      hours: parseFloat(e.hours) || 0,
      work: e.note || e.task || e.service || "",
    })),
  };
}
function photoAiSummary(project) {
  const out = [];
  for (const p of Array.isArray(project.photos) ? project.photos : []) {
    if (!p.ai) continue;
    out.push({
      room: p.room || "", stage: p.stage || "", caption: p.caption || p.ai.caption || "",
      // the tech's edited note overrides the raw analysis — deleted findings stay deleted
      ...(p.aiNote != null
        ? { findings: p.aiNote }
        : { damage: p.ai.damage || [], materials: p.ai.materials || [] }),
    });
  }
  return out.slice(0, 40);
}
export function invoiceFacts(project) {
  return {
    ...narrativeFacts(project),
    labor: laborSummary(project),
    photoFindings: photoAiSummary(project),
  };
}

/* ---------- invoice draft + audit ---------- */
/** Draft { lossSummary, items:[{room,desc,qty,unit,price,basis}] } from the documented facts. */
export function draftInvoice(project) {
  return callOffice(project, "invoiceDraft", {
    facts: invoiceFacts(project),
    catalog: PRICE_CATALOG,
  }).then((b) => b.draft);
}

/** Audit the current items; returns suggestions [{room,desc,qty,unit,price,reason}]. */
export function auditInvoice(project, inv) {
  return callOffice(project, "invoiceAudit", {
    facts: invoiceFacts(project),
    items: (inv.items || []).filter((it) => String(it.desc || "").trim()),
    catalog: PRICE_CATALOG,
  }).then((b) => b.suggestions ?? []);
}

/* ---------- adjuster email ---------- */
/** Draft { subject, body } for the claim-submission email. */
export function draftAdjusterEmail(project) {
  return callOffice(project, "adjusterEmail", {
    facts: narrativeFacts(project),
    narrative: project.narrative || "",
  }).then((b) => b.draft);
}

/* ---------- contents vision (personal property inventory) ---------- */
/** Identify ONE item from its photo → {name,brand,model,category,condition,estimatedValue,notes,confidence}. */
export function analyzeContentsItem(project, imageDataUrl, categories, conditions) {
  return callOffice(project, "contentsVision", {
    mode: "item", image: imageDataUrl, categories, conditions,
  }).then((b) => b.item);
}

/** Bulk room capture: list every item in a photo → [{name,category,qty,condition,estimatedValue,confidence}]. */
export function scanContentsPhoto(project, imageDataUrl, categories, conditions) {
  return callOffice(project, "contentsVision", {
    mode: "scan", image: imageDataUrl, categories, conditions,
  }).then((b) => b.items ?? []);
}

/** One-line total-loss justifications for the loss schedule; returns [{id, text}]. */
export function justifyContents(project, items) {
  return callOffice(project, "contentsJustify", {
    context: {
      waterCategory: project.waterCategory || "", lossCause: project.lossCause || "",
      dateOfLoss: project.dateOfLoss || "",
    },
    items: items.map((it) => ({
      id: it.id, name: it.name || "", category: it.category || "", condition: it.condition || "",
      age: it.age || "", room: it.room || "", notes: it.notes || "",
    })),
  }).then((b) => b.justifications ?? []);
}
