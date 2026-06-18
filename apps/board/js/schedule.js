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

/* Lay out a job's phases (sub-tasks) sequentially from startISO. Each phase
   runs for durationOf(phase) work days; phase i>0 starts after the previous
   one finishes, plus an optional lag (calendar days). Returns
   [{ sub, start, finish }] in order. */
export function layoutSubtasks(subs, startISO, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (!subs || !subs.length || !startISO) return [];
  const out = [];
  let prevFinish = null;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const start = i === 0
      ? addWorkDays(startISO, 0, s)
      : addWorkDays(addDaysISO(prevFinish, 1 + (Number(sub.lagDays) || 0)), 0, s);
    const finish = addWorkDays(start, durationOf(sub, s) - 1, s);
    out.push({ sub, start, finish });
    prevFinish = finish;
  }
  return out;
}

/* A job is engine-managed only once it opts in (has deps, an explicit mode,
   or a duration override). Legacy jobs with hand-typed dates stay untouched
   until the user engages scheduling on them. */
function participates(job) {
  return (Array.isArray(job.deps) && job.deps.length > 0)
    || job.scheduleMode === "auto" || job.scheduleMode === "manual"
    || job.durationDays != null
    || !!job.notBefore
    || (Array.isArray(job.subtasks) && job.subtasks.length > 0)
    || !!job.isMilestone;
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
    // "start no earlier than" constraint (materials / permit) is a hard floor
    if (job.notBefore && (!baseStart || job.notBefore > baseStart)) baseStart = job.notBefore;

    if (!baseStart) { finishById.set(id, job.targetDate || null); continue; }
    const newStart = addWorkDays(baseStart, 0, s);
    // milestones are zero-duration markers; phased jobs roll up to their last phase
    const subL = (!job.isMilestone && job.subtasks && job.subtasks.length) ? layoutSubtasks(job.subtasks, newStart, s) : null;
    const newFinish = job.isMilestone ? newStart : (subL && subL.length ? subL[subL.length - 1].finish : finishOf(newStart, dur, s));
    finishById.set(id, newFinish);
    if (job.startDate !== newStart || job.targetDate !== newFinish) {
      job.startDate = newStart; job.targetDate = newFinish; changed.push(job);
    }
  }
  return { changed, cyclic };
}

/* Critical path: the chain of linked jobs that drives the latest finish.
   Walks back from the latest-finishing job(s) along "binding" predecessors —
   those whose finish (+ lag) actually determines a job's start. Returns a Set
   of critical job ids; empty when there's no real chain (fewer than 2 jobs). */
export function computeCriticalPath(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const scheduled = jobs.filter((j) => j.startDate && j.targetDate);
  if (scheduled.length < 2) return new Set();
  let end = scheduled[0].targetDate;
  for (const j of scheduled) if (j.targetDate > end) end = j.targetDate;
  const critical = new Set();
  const stack = scheduled.filter((j) => j.targetDate === end).map((j) => j.id);
  while (stack.length) {
    const id = stack.pop();
    if (critical.has(id)) continue;
    critical.add(id);
    const j = byId.get(id);
    for (const d of (j.deps || [])) {
      const p = byId.get(d.predId);
      if (!p || !p.targetDate) continue;
      const driven = addWorkDays(addDaysISO(p.targetDate, 1 + (Number(d.lagDays) || 0)), 0, s);
      if (driven === j.startDate) stack.push(p.id);   // this predecessor binds j's start
    }
  }
  // a "path" needs at least one real link; a lone latest job isn't a critical path
  return critical.size >= 2 ? critical : new Set();
}

/* Crew over-allocation: a crew member booked on two jobs whose scheduled
   date ranges overlap. Returns:
     byJob: Map(jobId -> [{ crewId, otherId }])  (per-job conflicts, both sides)
     pairs: [{ crewId, aId, bId, from, to }]      (unique clashes + overlap range) */
export function findOverAllocations(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const byJob = new Map(), pairs = [];
  const seenJob = new Set(), seenPair = new Set();
  const add = (id, crewId, otherId) => {
    const k = id + "|" + crewId + "|" + otherId;
    if (seenJob.has(k)) return; seenJob.add(k);
    (byJob.get(id) || byJob.set(id, []).get(id)).push({ crewId, otherId });
  };
  // crew assignments: phase-level when a job's phases carry crew, else job-level
  const asg = [];
  for (const j of jobs) {
    if (j.isMilestone || !j.startDate) continue;
    const phases = j.subtasks || [];
    if (phases.some((st) => (st.crewIds || []).length)) {
      for (const { sub, start, finish } of layoutSubtasks(phases, j.startDate, s))
        for (const cid of (sub.crewIds || [])) asg.push({ crewId: cid, jobId: j.id, start, finish });
    } else if (j.targetDate) {
      for (const cid of (j.crewIds || [])) asg.push({ crewId: cid, jobId: j.id, start: j.startDate, finish: j.targetDate });
    }
  }
  const byCrew = new Map();
  for (const a of asg) (byCrew.get(a.crewId) || byCrew.set(a.crewId, []).get(a.crewId)).push(a);
  for (const [cid, list] of byCrew) {
    for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) {
      const A = list[i], B = list[k];
      if (A.jobId === B.jobId) continue;                 // same job — sequential, not a clash
      if (A.start <= B.finish && B.start <= A.finish) {
        add(A.jobId, cid, B.jobId); add(B.jobId, cid, A.jobId);
        const lo = A.jobId < B.jobId ? A.jobId : B.jobId, hi = A.jobId < B.jobId ? B.jobId : A.jobId;
        const pk = cid + "|" + lo + "|" + hi;
        if (!seenPair.has(pk)) {
          seenPair.add(pk);
          pairs.push({ crewId: cid, aId: A.jobId, bId: B.jobId,
            from: A.start > B.start ? A.start : B.start, to: A.finish < B.finish ? A.finish : B.finish });
        }
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
