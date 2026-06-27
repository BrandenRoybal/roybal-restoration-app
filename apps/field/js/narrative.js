/* ============================================================
   Roybal Field Forms — Construction narrative (AI)
   ------------------------------------------------------------
   The opening document of the job packet: an AI-written construction /
   mitigation narrative, generated ONLY once the job is billable (all
   hard billing-requirement gaps closed), reviewed + edited by the
   office, then printed as the packet cover.

   This module's pure core — narrativeFacts(project) — digests the
   DOCUMENTED job data into the structured facts the model writes from.
   The model is told to use ONLY these facts (no fabrication); the
   reconstruction scope + estimate $ are intentionally left out of v1
   (they come from Xactimate/ESX later) and stay an editable placeholder.

   The pure facts builder (narrativeFacts) is Node-testable. generateNarrative()
   is browser-only (network); its imports are all Node-safe so the test still
   loads this module.
   ============================================================ */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { accessToken } from "./supa.js";
import { getUnifiedJobId } from "./spine.js";
import { capturedBy } from "./tech.js";

const FN_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/roybal-ai-narrative` : "";

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };
const dayDiff = (a, b) => {
  if (!a || !b) return null;
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.round(Math.abs(d2 - d1) / 86400000);
};
const arr = (v) => (Array.isArray(v) ? v : []);
const maxMC = (values) => {
  const ns = arr(values).map(num).filter((n) => n != null);
  return ns.length ? Math.max(...ns) : null;
};

/* moistureMaps -> affected areas (material, dry goal, wet->dry trend) */
function affectedAreas(p) {
  return arr(p.moistureMaps).map((m) => {
    const rows = arr(m.readings).filter((r) => arr(r.values).some((v) => num(v) != null));
    const first = rows[0], last = rows[rows.length - 1];
    return {
      area: (m.label || m.material || "Affected area").trim(),
      material: m.material || "",
      dryGoal: m.dryGoal || "",
      readingDates: rows.length,
      firstReading: first ? { date: first.date, maxMC: maxMC(first.values) } : null,
      lastReading: last ? { date: last.date, maxMC: maxMC(last.values) } : null,
    };
  }).filter((a) => a.material || a.area !== "Affected area");
}

/* dryingLogs[].equipment -> per-type unit counts + unit-days + dates */
function equipmentSummary(p) {
  const byType = new Map();
  for (const d of arr(p.dryingLogs)) {
    for (const e of arr(d.equipment)) {
      const type = (e.type || "").trim();
      if (!type) continue;
      if (!byType.has(type)) byType.set(type, { type, units: 0, unitDays: 0, locations: new Set(), placed: [], removed: [] });
      const g = byType.get(type);
      g.units += 1;
      const days = dayDiff(e.placed, e.removed);
      if (days != null) g.unitDays += days;
      if (e.location) g.locations.add(e.location.trim());
      if (e.placed) g.placed.push(e.placed);
      if (e.removed) g.removed.push(e.removed);
    }
  }
  return [...byType.values()].map((g) => ({
    type: g.type, units: g.units, unitDays: g.unitDays || null,
    locations: [...g.locations],
    placed: g.placed.sort()[0] || "", removed: g.removed.sort().slice(-1)[0] || "",
  }));
}

/* drying window + psychrometric (grain-depression) trend */
function dryingSummary(p) {
  const dates = [], gds = [];
  for (const d of arr(p.dryingLogs)) {
    for (const r of arr(d.readings)) {
      if (r.date) dates.push(r.date);
      const gd = num(r.gd);
      if (gd != null && r.date) gds.push({ date: r.date, gd });
    }
  }
  const cd = p.certDrying || {};
  const start = cd.dryStart || dates.sort()[0] || arr(p.dryingLogs).map((d) => d.dryoutStart).filter(Boolean).sort()[0] || "";
  const finish = cd.dryComplete || dates.sort().slice(-1)[0] || arr(p.dryingLogs).map((d) => d.dryoutFinish).filter(Boolean).sort().slice(-1)[0] || "";
  gds.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    start, finish,
    days: num(cd.dryingDays) ?? dayDiff(start, finish),
    firstGrainDepression: gds[0]?.gd ?? null,
    lastGrainDepression: gds[gds.length - 1]?.gd ?? null,
  };
}

/* certificate of drying -> verification rows + certified flag/date */
function certSummary(p) {
  const cd = p.certDrying;
  if (!cd) return null;
  const verification = arr(cd.verification)
    .filter((v) => v.material || v.final || v.goal)
    .map((v) => ({ material: v.material || "", goal: v.goal || "", final: v.final || "", dry: !!v.dry }));
  const certified = !!(cd.sigTech || (cd.uploadedPages && cd.uploadedPages.length) || cd.issueDate);
  return { certified, certDate: cd.issueDate || cd.sigTechDate || "", verification, dryingDays: num(cd.dryingDays) };
}

/* constructionLogs -> tasks, crew, total hours */
function scopeSummary(p) {
  const tasks = new Set(), crew = new Set();
  let hours = 0, days = 0;
  for (const c of arr(p.constructionLogs)) {
    days += 1;
    for (const r of arr(c.rows)) {
      if (r.task) tasks.add(r.task.trim());
      if (r.employee) crew.add(r.employee.trim());
      hours += num(r.hours) || 0;
    }
  }
  return { tasks: [...tasks], crew: [...crew], totalHours: Math.round(hours * 10) / 10, logDays: days };
}

function photoSummary(p) {
  const c = { before: 0, during: 0, after: 0 };
  for (const ph of arr(p.photos)) if (ph.stage && c[ph.stage] != null) c[ph.stage] += 1;
  return c;
}

/* ---------- the digest the model writes from (pure) ---------- */
export function narrativeFacts(project) {
  const p = project || {};
  return {
    job: {
      insured: p.customer || "",
      property: p.address || "",
      carrier: p.carrier || "",
      claim: p.claimNo || "",
      adjuster: p.adjuster || "",
      dateOfLoss: p.dateOfLoss || "",
      lossCause: p.lossCause || "",
      waterCategory: p.waterCategory || "",
      waterClass: p.waterClass || "",
      dryingSystem: p.dryingSystem || "",
      jobId: p.workOrderNo || "",
    },
    affectedAreas: affectedAreas(p),
    equipment: equipmentSummary(p),
    drying: dryingSummary(p),
    certificate: certSummary(p),
    scope: scopeSummary(p),
    changeOrders: arr(p.changeOrders)
      .map((c) => ({ no: c.coNo || "", date: c.coDate || "", description: c.description || "" }))
      .filter((c) => c.description || c.no),
    photos: photoSummary(p),
  };
}

/* Info-table rows for the cover (pure). [label, value] pairs, blanks dropped. */
export function narrativeInfoRows(facts) {
  const j = facts.job;
  const lossType = [
    [j.waterCategory && `Cat ${j.waterCategory}`, j.waterClass && `Class ${j.waterClass}`].filter(Boolean).join(" / "),
    j.lossCause,
  ].filter(Boolean).join(" — ");
  return [
    ["INSURED", j.insured], ["PROPERTY", j.property],
    ["CARRIER", j.carrier], ["CLAIM #", j.claim],
    ["ADJUSTER", j.adjuster], ["DATE OF LOSS", j.dateOfLoss],
    ["LOSS TYPE", lossType], ["PROJECT / JOB ID", j.jobId],
  ].filter(([, v]) => v && String(v).trim());
}

/* Browser-only: ask the Edge Function to write the narrative from the facts. */
export async function generateNarrative(project) {
  if (!FN_URL) throw new Error("Voice/AI backend not configured");
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + accessToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ unified_job_id: getUnifiedJobId(project.id), captured_by: capturedBy(), facts: narrativeFacts(project) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `narrative failed (${res.status})`);
  return body; // { capped, narrative, spend }
}
