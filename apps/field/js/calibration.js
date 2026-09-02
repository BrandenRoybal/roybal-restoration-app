/* ============================================================
   Estimating calibration factors (docs/CRM_Design.md §14.2)
   ------------------------------------------------------------
   Turns completed-job history into the honest correction on our
   estimating: median actual÷estimate, hours (board estimatedHours
   vs QB Time actuals) and dollars (contract vs bid). OUR actuals
   only — nothing here touches price lists or Xactimate data.

   THE GATE, load-bearing: a factor is null below minN completed
   jobs (default 5) — the assistants surface nothing they can't
   back, and they only ever SUGGEST an adjustment, never apply one
   (the note in calibrationContext() says so to the model, in-band,
   so the rule travels with the data instead of living in a persona
   that needs a redeploy).

   Zero imports on purpose: pure functions + a fetcher that takes
   `rest` as a parameter, so node --test runs the math and both the
   admin and field assistants inject their own client. The human
   twin of these numbers is the admin Analytics tab (§14.1), which
   shows raw factors with n labels — the gate is for machines.
   ============================================================ */

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round2 = (x) => Math.round(x * 100) / 100;

/* completed = the job story is over and both sides of it exist
   (in-progress hours mislead; a lost lead never ran) */
const isCompleted = (d) => (d.stage === "done" || (d.archived && d.outcome !== "lost")) && !d.isMilestone;

/**
 * computeCalibration(jobs, hoursByJob, minN)
 *  jobs       — coordination_jobs data blobs
 *  hoursByJob — { [jobId]: summed actual hours } (QB Time + manual)
 * Returns { hours: { overall, byType: { mitigation, remodel } }, dollars },
 * each slot { factor, n } with factor NULL below the minN gate.
 */
export function computeCalibration(jobs, hoursByJob, minN = 5) {
  const hourRatios = { all: [], mitigation: [], remodel: [] };
  const dollarRatios = [];
  for (const d of jobs || []) {
    if (!d || d.isMilestone) continue;
    if (isCompleted(d)) {
      const est = Number(d.estimatedHours), act = Number((hoursByJob || {})[d.id]);
      if (est > 0 && act > 0) {
        hourRatios.all.push(act / est);
        hourRatios[d.type === "remodel" ? "remodel" : "mitigation"].push(act / est);
      }
    }
    if (d.outcome === "won" && Number(d.estValue) > 0 && Number(d.contractValue) > 0) {
      dollarRatios.push(Number(d.contractValue) / Number(d.estValue));
    }
  }
  const slot = (xs) => ({ factor: xs.length >= minN ? round2(median(xs)) : null, n: xs.length });
  return {
    hours: { overall: slot(hourRatios.all),
      byType: { mitigation: slot(hourRatios.mitigation), remodel: slot(hourRatios.remodel) } },
    dollars: slot(dollarRatios),
  };
}

/**
 * fetchCalibration(rest) — rest is the caller's authenticated client
 * (apps' supa.js rest). Cached 10 minutes; every failure → null so an
 * assistant ask is never blocked on this.
 */
let cache = { at: 0, val: null };
export async function fetchCalibration(rest, { minN = 5 } = {}) {
  if (Date.now() - cache.at < 10 * 60 * 1000) return cache.val;
  try {
    const jr = await rest("coordination_jobs?deleted=eq.false&select=id,data&limit=500", { method: "GET" });
    if (!jr.ok) throw new Error(String(jr.status));
    const jobs = (await jr.json()).map((r) => ({ id: r.id, ...(r.data || {}) }));
    const hoursByJob = {};
    for (let off = 0; off < 5000; off += 1000) {   // PostgREST pages at 1000 (the qb-time lesson)
      const tr = await rest(`time_entries?deleted=eq.false&select=data&limit=1000&offset=${off}`, { method: "GET" });
      if (!tr.ok) throw new Error(String(tr.status));
      const rows = await tr.json();
      for (const r of rows) {
        const e = r.data || {};
        if (e.jobId) hoursByJob[e.jobId] = (hoursByJob[e.jobId] || 0) + (Number(e.hours) || 0);
      }
      if (rows.length < 1000) break;
    }
    cache = { at: Date.now(), val: computeCalibration(jobs, hoursByJob, minN) };
  } catch (_) { cache = { at: Date.now(), val: null }; }
  return cache.val;
}

/**
 * calibrationContext(cal) — the assistant-context block. Only factors
 * that pass the gate appear; returns null when nothing does (the key
 * is then omitted from context entirely — the model never sees a
 * half-empty scaffold to hallucinate around).
 */
export function calibrationContext(cal) {
  if (!cal) return null;
  const out = {};
  const put = (key, s, label) => { if (s && s.factor != null) out[key] = { factor: s.factor, n: s.n, label }; };
  put("hoursMitigation", cal.hours.byType.mitigation, "mitigation actual÷estimated hours");
  put("hoursRemodel", cal.hours.byType.remodel, "remodel actual÷estimated hours");
  if (!out.hoursMitigation && !out.hoursRemodel) put("hoursOverall", cal.hours.overall, "actual÷estimated hours, all completed jobs");
  put("dollars", cal.dollars, "contract÷bid on won jobs");
  if (!Object.keys(out).length) return null;
  return {
    note: "Median actual÷estimate from OUR completed jobs (QuickBooks Time hours; signed contracts). " +
      "When drafting or reviewing an estimate, MENTION the relevant factor as a suggested adjustment " +
      "with its sample size (e.g. 'history says mitigation runs ×1.18, n=9 — consider padding hours'). " +
      "Never silently apply it to numbers, and never present it as anything but our own history.",
    ...out,
  };
}
