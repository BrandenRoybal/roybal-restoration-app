/* ============================================================
   Roybal Job Board — scheduling engine
   Pure functions: no DOM, no persistence, no imports. Computes job
   start/finish dates from Finish-to-Start dependencies, crew hours,
   and an editable work calendar, then writes the result back onto
   job.startDate / job.targetDate (which the Gantt + Calendar read).
   ============================================================ */

export const DEFAULT_SETTINGS = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [] };

/* ---- date helpers: ISO "YYYY-MM-DD" <-> local-midnight Date ---- */
const parseISO = (iso) => new Date(iso + "T00:00:00");
const toISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDaysISO = (iso, n) => { const x = parseISO(iso); x.setDate(x.getDate() + n); return toISO(x); };
export const dayDiff = (aISO, bISO) => Math.round((parseISO(bISO) - parseISO(aISO)) / 86400000);

/* ---- work calendar ---- */
export function isWorkDay(iso, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const days = s.workDays && s.workDays.length ? s.workDays : DEFAULT_SETTINGS.workDays;
  return days.includes(parseISO(iso).getDay()) && !(s.holidays || []).includes(iso);
}

/* Date that is `n` working days after iso. n=0 snaps forward to the next
   work day on/at iso. Guarded so a misconfigured calendar can't loop forever. */
export function addWorkDays(iso, n, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const live = !!(s.workDays && s.workDays.length); // false => treat every day as workable
  let cur = iso, guard = 0;
  while (live && !isWorkDay(cur, s) && guard++ < 3660) cur = addDaysISO(cur, 1);
  let count = 0;
  while (count < n && guard++ < 36600) {
    cur = addDaysISO(cur, 1);
    if (!live || isWorkDay(cur, s)) count++;
  }
  return cur;
}

/* inclusive count of work days in [a, b] */
export function workDaysBetween(aISO, bISO, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (!aISO || !bISO) return 1;
  const live = !!(s.workDays && s.workDays.length);
  let lo = aISO < bISO ? aISO : bISO, hi = aISO < bISO ? bISO : aISO, n = 0, cur = lo, guard = 0;
  while (cur <= hi && guard++ < 36600) { if (!live || isWorkDay(cur, s)) n++; cur = addDaysISO(cur, 1); }
  return Math.max(1, n);
}

/* ---- duration: manual override, else hours / (crew x hours-per-day),
   else the job's existing span so legacy jobs without hours don't shrink ---- */
export function durationOf(job, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (job.durationDays != null && Number(job.durationDays) > 0) return Math.ceil(Number(job.durationDays));
  const est = Number(job.estimatedHours) || 0;
  if (est > 0) {
    const crew = Math.max(1, (job.crewIds || []).length);
    const hpd = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
    return Math.max(1, Math.ceil(est / (crew * hpd)));
  }
  if (job.startDate && job.targetDate) return workDaysBetween(job.startDate, job.targetDate, s);
  return 1;
}

/* finish (inclusive) for a job of `dur` work days starting at startISO */
function finishOf(startISO, dur, settings) {
  const start = addWorkDays(startISO, 0, settings);
  return addWorkDays(start, Math.max(1, dur) - 1, settings);
}

/* A job is engine-managed only once it opts in (has deps, an explicit mode,
   or a duration override). Legacy jobs with hand-typed dates stay untouched
   until the user engages scheduling on them. */
function participates(job) {
  return (Array.isArray(job.deps) && job.deps.length > 0)
    || job.scheduleMode === "auto" || job.scheduleMode === "manual"
    || job.durationDays != null;
}

/* ---- main scheduler: cycle-safe topological forward pass (Kahn) ----
   Mutates job.startDate / job.targetDate in place. Returns:
     { changed: [jobs whose dates moved], cyclic: [ids in a dependency cycle] } */
export function computeSchedule(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const validDeps = (j) => (j.deps || []).filter((d) => d && d.predId && d.predId !== j.id && byId.has(d.predId));

  const succ = new Map(jobs.map((j) => [j.id, []]));
  const indeg = new Map(jobs.map((j) => [j.id, 0]));
  for (const j of jobs) for (const d of validDeps(j)) { succ.get(d.predId).push(j.id); indeg.set(j.id, indeg.get(j.id) + 1); }

  const queue = jobs.filter((j) => indeg.get(j.id) === 0).map((j) => j.id);
  const order = [], seen = new Set();
  while (queue.length) {
    const id = queue.shift(); if (seen.has(id)) continue; seen.add(id); order.push(id);
    for (const sid of succ.get(id)) { indeg.set(sid, indeg.get(sid) - 1); if (indeg.get(sid) === 0) queue.push(sid); }
  }
  const cyclic = jobs.filter((j) => !seen.has(j.id)).map((j) => j.id);
  for (const id of cyclic) { seen.add(id); order.push(id); } // schedule cyclic nodes dependency-free

  const finishById = new Map(), changed = [];
  for (const id of order) {
    const job = byId.get(id);
    const dur = durationOf(job, s);
    if (!participates(job)) { finishById.set(id, job.targetDate || job.startDate || null); continue; }

    let baseStart = null;
    if (job.scheduleMode === "manual") {
      baseStart = job.pinnedStart || job.startDate || null;
    } else { // auto
      const preds = cyclic.includes(id) ? [] : validDeps(job);
      const cands = [];
      for (const d of preds) {
        const pf = finishById.get(d.predId);
        if (pf) cands.push(addWorkDays(addDaysISO(pf, 1 + (Number(d.lagDays) || 0)), 0, s));
      }
      baseStart = cands.length ? cands.reduce((a, b) => (b > a ? b : a)) : (job.startDate || null);
    }

    if (!baseStart) { finishById.set(id, job.targetDate || null); continue; }
    const newStart = addWorkDays(baseStart, 0, s);
    const newFinish = finishOf(newStart, dur, s);
    finishById.set(id, newFinish);
    if (job.startDate !== newStart || job.targetDate !== newFinish) {
      job.startDate = newStart; job.targetDate = newFinish; changed.push(job);
    }
  }
  return { changed, cyclic };
}

/* Crew over-allocation: a crew member booked on two jobs whose scheduled
   date ranges overlap. Returns:
     byJob: Map(jobId -> [{ crewId, otherId }])  (per-job conflicts, both sides)
     pairs: [{ crewId, aId, bId, from, to }]      (unique clashes + overlap range) */
export function findOverAllocations(jobs) {
  const byJob = new Map(), pairs = [];
  const add = (id, crewId, otherId) => { (byJob.get(id) || byJob.set(id, []).get(id)).push({ crewId, otherId }); };
  const byCrew = new Map();
  for (const j of jobs) {
    if (!j.startDate || !j.targetDate) continue;
    for (const cid of (j.crewIds || [])) (byCrew.get(cid) || byCrew.set(cid, []).get(cid)).push(j);
  }
  for (const [cid, list] of byCrew) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const A = list[a], B = list[b];
      if (A.startDate <= B.targetDate && B.startDate <= A.targetDate) {
        add(A.id, cid, B.id); add(B.id, cid, A.id);
        pairs.push({ crewId: cid, aId: A.id, bId: B.id,
          from: A.startDate > B.startDate ? A.startDate : B.startDate,
          to: A.targetDate < B.targetDate ? A.targetDate : B.targetDate });
      }
    }
  }
  return { byJob, pairs };
}

/* UI guard: would making `candidatePredId` a predecessor of `jobId` create a
   cycle? True when jobId is already a (transitive) predecessor of the candidate. */
export function wouldCreateCycle(jobId, candidatePredId, jobs) {
  if (jobId === candidatePredId) return true;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const stack = [candidatePredId], seen = new Set();
  while (stack.length) {
    const id = stack.pop(); if (seen.has(id)) continue; seen.add(id);
    if (id === jobId) return true;
    const j = byId.get(id); if (!j) continue;
    for (const d of (j.deps || [])) if (d && d.predId) stack.push(d.predId);
  }
  return false;
}
