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
import { jobType, lossTypesOf } from "./model.js";
import { narrativeFacts } from "./narrative.js";
import { rebuildFacts } from "./convert.js";
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

/* project may be null (board/admin mounts have no field project) — the job
   link and tech identity then come from the payload, or stay null/default. */
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
      unified_job_id: project ? getUnifiedJobId(project.id) : null,
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
/* The analysis needs BOTH halves of the job's identity or it defaults to
   writing water-damage justification over everything: the loss classification
   (what to look for — freeze-ups ride in lossCause as a water loss) and the
   job kind (a remodel has no loss to justify at all). The per-photo stage
   carries the rest — an after photo documents finished work, not damage. */
/** Analyze the given project photos (≤10 per call). Returns [{id, ok, analysis?, error?}]. */
export function analyzePhotos(project, photos) {
  const build = jobType(project) === "construction";
  return callOffice(project, "photoAnalysis", {
    context: {
      jobType: jobType(project),
      constructionType: build ? (project.constructionType || "") : "",
      // a construction job has no loss classification to send — sending one
      // would put the "look for damage" lines back into the prompt
      lossTypes: build ? [] : lossTypesOf(project),
      lossCause: project.lossCause || "",
      waterCategory: build ? "" : (project.waterCategory || ""),
      waterClass: build ? "" : (project.waterClass || ""),
      smokeType: build ? "" : (project.smokeType || ""),
      fireDamage: build ? "" : (project.fireDamage || ""),
      moldCondition: build ? "" : (project.moldCondition || ""),
      moldExtent: build ? "" : (project.moldExtent || ""),
      stormCause: build ? "" : (project.stormCause || ""),
      envelopeBreached: build ? "" : (project.envelopeBreached || ""),
      address: project.address || "",
    },
    photos: photos.slice(0, 10).map((p) => ({
      id: p.id, image: p.src, room: p.room || "", stage: p.stage || "", caption: p.caption || "",
    })),
  }).then((b) => b.results ?? []);
}

/* The engine that wrote an analysis. BUMP THIS whenever the photo-analysis
   prompt or logic changes enough that older write-ups are worse than a re-run:
   every photo carrying an older stamp then shows up in the gallery's
   "Refresh AI captions (N)" button, so a job's captions can be brought up to
   the current engine in one tap. Analyses written before the stamp existed
   have no `v` and count as outdated — which is correct, they predate the
   stage-aware briefs. Bumping never auto-fires anything: an old job with 200
   photos costs nothing until someone taps the button.
   1 — stage briefs (before proves the loss / after documents finished work)
       + loss-type and job-kind context. */
export const PHOTO_AI_VERSION = 1;

/** True when this photo's analysis came from an older engine than we run now. */
export const photoAiOutdated = (photo) => !!photo.ai && (photo.ai.v || 0) < PHOTO_AI_VERSION;

/** Write an analysis onto its photo: fill the caption only if the tech left it
    blank (or the AI wrote the one that's there). Returns true if it wrote one. */
export function applyPhotoAnalysis(photo, analysis, stage) {
  /* Re-analysis after a re-tag must be able to REPLACE a caption the AI wrote
     — that stale caption IS the wrong-stage text we are fixing — but a caption
     the tech typed or edited is theirs and always stands. */
  const prev = photo.ai;
  const aiOwnsCaption = !!prev && String(photo.caption || "").trim() === String(prev.caption || "").trim();
  photo.ai = {
    caption: analysis.caption || "",
    v: PHOTO_AI_VERSION,
    // the stage this analysis was written FOR, so a later re-tag can spot that
    // the findings are stale and offer to re-run them
    stage: stage || photo.stage || "during",
    stageObserved: analysis.stageObserved || "",
    damage: analysis.damage || [],
    workDone: analysis.workDone || [],
    materials: analysis.materials || [],
    equipment: analysis.equipment || [],
    safety: analysis.safety || [],
    confidence: analysis.confidence ?? null,
    at: new Date().toISOString(),
  };
  if (analysis.caption && (!String(photo.caption || "").trim() || aiOwnsCaption)) {
    photo.caption = analysis.caption;
    return true;
  }
  return false;
}

/* ---------- invoice facts (digest for draft + audit) ---------- */
function laborSummary(project) {
  const start = project.laborLog?.startDate || "";
  const raw = Array.isArray(project.laborLog?.entries) ? project.laborLog.entries : [];
  // startDate separates reconstruction hours from mitigation on the same job
  const entries = raw.filter((e) => !start || String(e.date || "") >= start);
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
        : { damage: p.ai.damage || [], workDone: p.ai.workDone || [], materials: p.ai.materials || [] }),
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
/* Pricing pulls from the Supabase price_list (Fairbanks Xactimate) server-side;
   the client only passes the pricing MODE toggle:
     "piecework" — Xactimate unit-priced lines (labor+material in the unit price)
     "tm"        — hourly trade labor (LAB rates) + material/equipment lines
   Undefined lets the edge default (estimate→piecework, invoice→tm). */

/** Draft { lossSummary, items:[{room,desc,qty,unit,price,basis,code,priced}] } from the documented facts. */
export function draftInvoice(project, pricingMode, verifiedScope) {
  const facts = invoiceFacts(project);
  if (verifiedScope && (verifiedScope.summary || verifiedScope.narration || (Array.isArray(verifiedScope.answers) && verifiedScope.answers.length)))
    facts.verifiedScope = verifiedScope;
  return callOffice(project, "invoiceDraft", {
    facts,
    pricingMode,
  }).then((b) => b.draft);
}

/** Audit the current items; returns suggestions [{room,desc,qty,unit,price,reason,code,priced}]. */
export function auditInvoice(project, inv, pricingMode) {
  return callOffice(project, "invoiceAudit", {
    facts: invoiceFacts(project),
    items: (inv.items || []).filter((it) => String(it.desc || "").trim()),
    pricingMode,
  }).then((b) => b.suggestions ?? []);
}

/* ---------- reconstruction estimate (restoration jobs) ----------
   Same schema/editor as the invoice, but the fact pack is the REBUILD
   digest (demo extent, plan dimensions, contents loss) and the edge
   prompt writes proposed repair scope, not billing for performed work. */
function reconEstimateFacts(project) {
  return { ...rebuildFacts(project), labor: laborSummary(project), photoFindings: photoAiSummary(project) };
}
/* Scope interview — verify rebuild scope BEFORE drafting. One adaptive question
   at a time; returns { done, question, options, why, scopeSummary }. The client
   loops (passing the growing answers list) until done, then draftReconEstimate
   prices FROM the confirmed scope. */
export function runScopeInterview(project, { narration = "", answers = [], isEst = true } = {}) {
  return callOffice(project, "scopeInterview", {
    facts: isEst ? reconEstimateFacts(project) : invoiceFacts(project),
    narration,
    answers: Array.isArray(answers) ? answers : [],
    mode: isEst ? "reconEstimate" : "invoice",
  });
}
export function draftReconEstimate(project, pricingMode, verifiedScope) {
  const facts = reconEstimateFacts(project);
  if (verifiedScope && (verifiedScope.summary || verifiedScope.narration || (Array.isArray(verifiedScope.answers) && verifiedScope.answers.length)))
    facts.verifiedScope = verifiedScope;
  return callOffice(project, "invoiceDraft", {
    facts,
    mode: "reconEstimate",
    pricingMode,
  }).then((b) => b.draft);
}
export function auditReconEstimate(project, inv, pricingMode) {
  return callOffice(project, "invoiceAudit", {
    facts: reconEstimateFacts(project),
    items: (inv.items || []).filter((it) => String(it.desc || "").trim()),
    mode: "reconEstimate",
    pricingMode,
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

/* ---------- board timeline estimate ---------- */
/** Draft the phase plan for the Job Board's Gantt.
    Returns { phases, notBefore, notBeforeLabel, assumptions }. */
export function draftTimeline(project, facts, history) {
  return callOffice(project, "timelineDraft", { facts, history: history || [] }).then((b) => b.draft);
}

/* ---------- construction progress update ---------- */
/** Draft the weekly owner/carrier/lender progress summary (markdown). */
export function draftProgress(project, facts) {
  return callOffice(project, "progressNarrative", { facts }).then((b) => b.draft);
}

/* ---------- rebuild draft (restoration → construction conversion) ---------- */
/** Draft the reconstruction plan from the restoration job's fact pack.
    Returns { scopeAreas, tradeSequence, selections, questions }. */
export function draftRebuild(project, facts) {
  return callOffice(project, "rebuildDraft", { facts }).then((b) => b.draft);
}

/* ---------- supporting-document digest ---------- */
/** Read an uploaded third-party document (engineer's report, estimate…)
    into a citable digest: { summary, keyFindings[], docType, suggestedTitle }. */
export function digestSupportDoc(project, pages, hint) {
  return callOffice(project, "docDigest", { pages: pages.slice(0, 8), hint: hint || {} }).then((b) => b.digest);
}

/* ---------- Xactimate / carrier estimate import ----------
   Read an uploaded Xactimate (or Symbility / carrier) estimate PDF into
   structured line items + O&P/tax totals so the invoice or reconstruction
   estimate is built FROM the carrier's approved numbers, not re-priced from
   scratch. Returns { source, confidence, lossSummary, estimateNo,
   estimateDate, items:[{room,desc,qty,unit,price}], summary, notes }. */
export function importEstimate(project, pages) {
  return callOffice(project, "estimateImport", { pages: pages.slice(0, 12) }).then((b) => b.estimate);
}

/* ---------- floor plan dimension takeoff ---------- */
/** Read room dimensions / SF / LF off the uploaded plan pages.
    Returns { rooms:[{name,dims,floorSF,perimLF,ceiling,notes,confidence}], totals, notes }. */
export function extractPlanDimensions(project, pages) {
  return callOffice(project, "planDimensions", { pages: pages.slice(0, 6) }).then((b) => b.dimensions);
}

/** Conversational field assistant — returns { reply, transcript? }. */
export function fieldAssist(project, payload) {
  return callOffice(project, "fieldAssist", payload);
}

/* ---------- customer portal message drafts ----------
   mode "reply": answer the customer's latest message; mode "status": a
   proactive progress update. Grounded ONLY in the customer-safe digest +
   thread — office reviews before sending. Returns the drafted message text. */
export function draftPortalMessage(project, mode, digest, thread) {
  return callOffice(project, "portalDraft", { mode, digest, thread }).then((b) => b.draft?.message || "");
}
