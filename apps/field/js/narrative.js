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
  // signature or uploaded copy ONLY — the factory prefills issueDate, so a
  // merely-opened cert form must never read as certified in the narrative
  const certified = !!(cd.sigTech || (cd.uploadedPages && cd.uploadedPages.length));
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
/* Supporting documents (engineer's reports, estimates…) — the tech-verified
   AI digests, citable by the narrative, invoice, rebuild scope and assistant. */
function supportingDocsSummary(p) {
  const docs = arr(p.supportDocs)
    .filter((d) => d && String(d.aiDigest || "").trim())
    .map((d) => ({
      title: d.title || d.docType || "Supporting document",
      type: d.docType || "",
      digest: String(d.aiDigest).slice(0, 2500),
    }))
    .slice(0, 10);
  return docs.length ? docs : null;
}

/* Dimensions read off the uploaded floor plan (AI takeoff, tech-verified) —
   SF/LF quantities for scope + invoice lines and any dimension question. */
function planDimensionsSummary(p) {
  const d = p.floorPlan && p.floorPlan.dimensions;
  const rooms = arr(d && d.rooms).filter((r) => r && (r.name || r.dims));
  if (!rooms.length) return null;
  const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
  return {
    source: "dimensioned floor plan (AI-read, tech-verified)",
    rooms: rooms.slice(0, 40).map((r) => ({
      room: r.name || "", dimensions: r.dims || "",
      floorSF: num(r.floorSF), perimeterLF: num(r.perimLF),
      ...(r.ceiling ? { ceiling: r.ceiling } : {}),
      ...(r.notes ? { notes: r.notes } : {}),
    })),
    totals: {
      floorSF: Math.round(rooms.reduce((t, r) => t + (parseFloat(r.floorSF) || 0), 0)),
      perimeterLF: Math.round(rooms.reduce((t, r) => t + (parseFloat(r.perimLF) || 0), 0)),
    },
  };
}

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
    planDimensions: planDimensionsSummary(p),
    supportingDocs: supportingDocsSummary(p),
    // texts composed from the app — proof of customer/office notification
    notifications: arr(p.smsLog).slice(-20).map((e) => ({
      at: e.at || "", type: e.kind || "text", to: arr(e.to).join(", "), by: e.by || "",
    })),
  };
}

/* ============================================================
   constructionFacts(project) — the digest for CONSTRUCTION jobs:
   what the assistant and the progress narrative read from. Pure.
   ============================================================ */
export function constructionFacts(project, now = Date.now()) {
  const p = project || {};
  const scope = arr(p.scopeOfWork && p.scopeOfWork.areas).map((a) => ({
    area: a.name || "",
    items: arr(a.items).filter((it) => it.desc).map((it) =>
      [it.trade, it.desc, [it.qty, it.unit].filter(Boolean).join(" ")].filter(Boolean).join(" — ")),
  })).filter((a) => a.area || a.items.length);
  const schedule = arr(p.subSchedule && p.subSchedule.rows).filter((r) => r.trade).map((r) => ({
    trade: r.trade, company: r.company || "", status: r.status || "",
    schedStart: r.schedStart || "", schedEnd: r.schedEnd || "",
    actStart: r.actStart || "", actEnd: r.actEnd || "",
  }));
  const inspections = arr(p.inspections).filter((i) => i.type).map((i) => ({
    type: i.type, scheduled: i.scheduled || "", result: i.result || "",
    corrections: i.corrections || "", reinspection: i.reinspection || "",
  }));
  const selRows = arr(p.selections && p.selections.rows).filter((r) => r.item);
  // over/under only counts DECIDED rows (an actual price entered) — a pending
  // selection with a blank actual is an open decision, not money saved
  const decided = selRows.filter((r) => String(r.actual ?? "").trim() !== "");
  const selections = {
    pending: selRows.filter((r) => r.status === "pending").map((r) => [r.area, r.item].filter(Boolean).join(": ")),
    ordered: selRows.filter((r) => r.status === "ordered").length,
    installed: selRows.filter((r) => r.status === "installed" || r.status === "delivered").length,
    netOverAllowance: Math.round(decided.reduce((t, r) =>
      t + ((parseFloat(r.actual) || 0) - (parseFloat(r.allowance) || 0)), 0)),
  };
  const punchRows = arr(p.punchList && p.punchList.rows).filter((r) => r.item);
  const drawRows = arr(p.drawSchedule && p.drawSchedule.rows).filter((r) => r.desc);
  return {
    job: {
      owner: p.customer || "", property: p.address || "",
      carrier: p.carrier || "", claim: p.claimNo || "", adjuster: p.adjuster || "",
      jobId: p.workOrderNo || "",
      constructionType: p.constructionType || "",
      contractAmount: p.contractAmount || "",
      startDate: p.startDate || "", targetCompletion: p.targetCompletion || "",
      permits: p.permitNumbers || "", lender: p.lender || "",
    },
    scope,
    planDimensions: planDimensionsSummary(p),
    supportingDocs: supportingDocsSummary(p),
    schedule,
    inspections,
    selections,
    punch: {
      open: punchRows.filter((r) => r.status === "open" || r.status === "in-progress").length,
      total: punchRows.length,
    },
    draws: {
      rows: drawRows.map((r) => ({ desc: r.desc, pct: r.pct || "", amount: r.amount || "",
        invoiced: r.invoicedDate || "", paid: r.paidDate || "" })),
      invoicedUnpaid: drawRows.filter((r) => r.invoicedDate && !r.paidDate).length,
    },
    dailyWork: scopeSummary(p),          // all-time tasks, crew, hours, log-day count
    // DATED recent work so "this week" means something to the progress update —
    // the all-time digest above can't distinguish week one from this week
    recentWork: arr(p.constructionLogs)
      .filter((c) => { const t = c.date && new Date(c.date + "T12:00:00").getTime(); return t && now - t <= 14 * 86400000; })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-10)
      .map((c) => ({
        date: c.date,
        tasks: [...new Set(arr(c.rows).map((r) => (r.task || "").trim()).filter(Boolean))].slice(0, 12),
        hours: Math.round(arr(c.rows).reduce((t, r) => t + (parseFloat(r.hours) || 0), 0) * 10) / 10,
        // the Field Report's crew -> office channel: what the office should hear about
        ...(String(c.notes || "").trim() ? { notes: String(c.notes).slice(0, 300) } : {}),
        ...(String(c.issues || "").trim() ? { issues: String(c.issues).slice(0, 300) } : {}),
        ...(String(c.materials || "").trim() ? { materialsNeeded: String(c.materials).slice(0, 200) } : {}),
      })),
    changeOrders: arr(p.changeOrders)
      .map((c) => ({ no: c.coNo || "", date: c.coDate || "", description: c.description || "" }))
      .filter((c) => c.description || c.no),
    photos: photoSummary(p),
    convertedFrom: p.mitigationRef ? { claim: p.claimNo || "", lossCause: p.lossCause || "" } : null,
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
