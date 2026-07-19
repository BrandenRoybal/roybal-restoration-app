/* ============================================================
   Roybal Job Board — scheduling engine
   Pure functions: no DOM, no persistence, no imports. Computes job
   start/finish dates from Finish-to-Start dependencies, crew hours,
   and an editable work calendar, then writes the result back onto
   job.startDate / job.targetDate (which the Gantt + Calendar read).

   ⚠️ SERVER-SHARED: the phone agent (services/phone-agent) imports
   this file in Node for real availability answers — keep it pure
   ESM (no DOM, no browser globals, no imports) or the phone lane
   breaks at its next deploy.
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

/* Fractional phase duration in WORK DAYS (no rounding — a 3-hour tape is 0.4d,
   not a full day). Manual durationDays override wins; else hours / (crew x hpd). */
export function durationFracOf(sub, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (sub.durationDays != null && Number(sub.durationDays) > 0) return Number(sub.durationDays);
  const est = Number(sub.estimatedHours) || 0;
  if (est > 0) {
    const crew = Math.max(1, (sub.crewIds || []).length);
    const hpd = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
    return Math.max(0.1, est / (crew * hpd));
  }
  return 1;
}

/* Lay out a job's phases from startISO, PACKED in fractional work-days so small
   phases share a day instead of each eating a whole one. A phase with a lag
   waits to the next whole day + lag. Returns, per phase:
     { sub, start, finish }   — whole ISO days the phase touches (Gantt/Calendar)
     { offFrac, durFrac }     — fractional work-day offset + length (sub-day bars) */
export function layoutSubtasks(subs, startISO, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (!subs || !subs.length || !startISO) return [];
  const out = [];
  let cursor = 0;   // fractional work-days from startISO
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const lag = i === 0 ? 0 : Math.max(0, Number(sub.lagDays) || 0);
    if (lag > 0) cursor = Math.ceil(cursor - 1e-9) + lag;   // finish the prior day, then whole-day lag
    const dur = durationFracOf(sub, s);
    const startIdx = Math.floor(cursor + 1e-9);
    const finishIdx = Math.max(startIdx, Math.ceil(cursor + dur - 1e-9) - 1);
    out.push({
      sub,
      start: addWorkDays(startISO, startIdx, s),
      finish: addWorkDays(startISO, finishIdx, s),
      offFrac: cursor,
      durFrac: dur,
    });
    cursor += dur;
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
/* Group jobs into independent "projects" by their dependency links (undirected
   connected components). Unlinked jobs are their own one-member component.
   Returns Map(jobId -> componentRootId). */
export function linkComponents(jobs) {
  const parent = new Map(jobs.map((j) => [j.id, j.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const j of jobs) for (const d of (j.deps || [])) if (d && d.predId && parent.has(d.predId)) union(j.id, d.predId);
  const comp = new Map();
  for (const j of jobs) comp.set(j.id, find(j.id));
  return comp;
}

/* Critical path computed PER linked project (component), not once for the whole
   board — so each independent chain of jobs lights up its own driving path, not
   just the one chain ending on the board's single latest date. Returns the union
   of every project's critical jobs; a lone unlinked job has no path so isn't in it. */
export function computeCriticalPath(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const scheduled = jobs.filter((j) => j.startDate && j.targetDate);
  if (scheduled.length < 2) return new Set();
  const comp = linkComponents(jobs);
  const groups = new Map();
  for (const j of scheduled) { const c = comp.get(j.id); (groups.get(c) || groups.set(c, []).get(c)).push(j); }

  const critical = new Set();
  for (const [, members] of groups) {
    if (members.length < 2) continue;   // a single job is no critical *path*
    let end = members[0].targetDate;
    for (const j of members) if (j.targetDate > end) end = j.targetDate;
    const stack = members.filter((j) => j.targetDate === end).map((j) => j.id);
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const j = byId.get(id);
      for (const d of (j.deps || [])) {
        const p = byId.get(d.predId);
        if (!p || !p.targetDate) continue;
        const driven = addWorkDays(addDaysISO(p.targetDate, 1 + (Number(d.lagDays) || 0)), 0, s);
        if (driven === j.startDate) stack.push(p.id);   // this predecessor binds j's start
      }
    }
    if (seen.size >= 2) for (const id of seen) critical.add(id);
  }
  return critical;
}

/* Crew over-allocation: a crew member booked on two jobs whose scheduled
   date ranges overlap. Returns:
     byJob: Map(jobId -> [{ crewId, otherId }])  (per-job conflicts, both sides)
     pairs: [{ crewId, aId, bId, from, to }]      (unique clashes + overlap range) */
/* Every crew booking as { crewId, jobId, label, start, finish, phase } —
   phase-level when a job's phases carry crew, else job-level. Shared by the
   over-allocation check and the workload view. */
export function crewAssignments(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const out = [];
  for (const j of jobs) {
    if (j.isMilestone || !j.startDate) continue;
    const phases = j.subtasks || [];
    if (phases.some((st) => (st.crewIds || []).length)) {
      for (const { sub, start, finish } of layoutSubtasks(phases, j.startDate, s))
        for (const cid of (sub.crewIds || [])) out.push({ crewId: cid, jobId: j.id, label: sub.name || "Phase", start, finish, phase: true });
    } else if (j.targetDate) {
      for (const cid of (j.crewIds || [])) out.push({ crewId: cid, jobId: j.id, label: "", start: j.startDate, finish: j.targetDate, phase: false });
    }
  }
  return out;
}

/* Per-crew, per-day booked HOURS across all jobs/phases (fractional-aware), and
   which jobs each crew touches each day. The basis for capacity conflicts and
   the workload heat-map. Returns { load: Map(crewId->Map(dayISO->hours)),
   jobsOn: Map(crewId->Map(dayISO->Set(jobId))) }. */
/* Effective crew for a day given a base roster and an optional per-day override
   delta `{ add:[ids], remove:[ids] }`. base − remove ∪ add (no duplicates).
   Shared by the engine and the Crew board so both resolve overrides identically. */
export function effCrew(base, ov) {
  base = base || [];
  if (!ov) return base;
  const rem = ov.remove || [], add = ov.add || [];
  return base.filter((c) => !rem.includes(c)).concat(add.filter((c) => !base.includes(c)));
}

export function crewDayLoad(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const hpd = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
  const load = new Map(), jobsOn = new Map();
  const bump = (cid, day, hrs, jid) => {
    let m = load.get(cid); if (!m) load.set(cid, (m = new Map()));
    m.set(day, (m.get(day) || 0) + hrs);
    let jm = jobsOn.get(cid); if (!jm) jobsOn.set(cid, (jm = new Map()));
    let set = jm.get(day); if (!set) jm.set(day, (set = new Set())); set.add(jid);
  };
  // distribute totalHours across the days a phase/job touches; per-day crew can
  // differ when a day has an override, so the hours that day re-split among them.
  const spread = (jobStart, offFrac, durFrac, baseCrew, totalHours, jid, dayOv) => {
    const startIdx = Math.floor(offFrac + 1e-9);
    const endIdx = Math.max(startIdx, Math.ceil(offFrac + durFrac - 1e-9) - 1);
    for (let k = startIdx; k <= endIdx; k++) {
      const ov = Math.max(0, Math.min(offFrac + durFrac, k + 1) - Math.max(offFrac, k));
      if (ov <= 0) continue;
      const day = addWorkDays(jobStart, k, s);
      const eff = effCrew(baseCrew, dayOv && dayOv[day]);
      if (!eff.length) continue;
      const perCrew = (totalHours * (ov / durFrac)) / eff.length;
      for (const cid of eff) bump(cid, day, perCrew, jid);
    }
  };
  for (const j of jobs) {
    if (j.isMilestone || !j.startDate) continue;
    const dayOv = j.dayCrew || null;
    const phases = j.subtasks || [];
    if (phases.some((st) => (st.crewIds || []).length)) {
      for (const { sub, offFrac, durFrac } of layoutSubtasks(phases, j.startDate, s)) {
        const base = sub.crewIds || [];
        if (!base.length && !dayOv) continue;   // crewless phase only matters on override days
        const hrs = Number(sub.estimatedHours) || durFrac * Math.max(1, base.length) * hpd;
        spread(j.startDate, offFrac, durFrac, base, hrs, j.id, dayOv);
      }
    } else if (j.targetDate && ((j.crewIds || []).length || dayOv)) {
      const span = workDaysBetween(j.startDate, j.targetDate, s);
      const base = j.crewIds || [];
      const hrs = Number(j.estimatedHours) || span * Math.max(1, base.length) * hpd;
      spread(j.startDate, 0, span, base, hrs, j.id, dayOv);
    }
  }
  return { load, jobsOn };
}

/* Capacity-based over-allocation: a crew member is only "over" on a day when
   their booked HOURS exceed their shift — so AM-on-one-job / PM-on-another no
   longer false-alarms. Returns:
     byJob:     Map(jobId -> [{ crewId, day, hours }])   (jobs touching an over day)
     overloads: [{ crewId, day, hours, pct, jobIds }]    (every over-capacity crew-day)
     load:      Map(crewId -> Map(dayISO -> hours))      (full grid, for the heat-map)
     byCrew:    Map(crewId -> { bookedDays, totHrs, peak, overDays }) */
export function findOverAllocations(jobs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const cap = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
  const { load, jobsOn } = crewDayLoad(jobs, s);
  const byJob = new Map(), overloads = [], byCrew = new Map();
  for (const [cid, days] of load) {
    let bookedDays = 0, totHrs = 0, peak = 0, overDays = 0;
    for (const [day, hrs] of days) {
      bookedDays++; totHrs += hrs; if (hrs > peak) peak = hrs;
      if (hrs > cap + 1e-6) {
        overDays++;
        const jids = [...((jobsOn.get(cid) || new Map()).get(day) || [])];
        overloads.push({ crewId: cid, day, hours: hrs, pct: Math.round((hrs / cap) * 100), jobIds: jids });
        for (const jid of jids) (byJob.get(jid) || byJob.set(jid, []).get(jid)).push({ crewId: cid, day, hours: hrs });
      }
    }
    byCrew.set(cid, { bookedDays, totHrs, peak, overDays });
  }
  overloads.sort((a, b) => (b.hours - a.hours) || (a.day < b.day ? -1 : 1));
  return { byJob, overloads, load, byCrew };
}

/* ============================================================
   CFO snapshot — the one read the daily CFO report renders.
   Pure + read-only: assumes dates are already resolved (caller runs
   computeSchedule first) and never mutates jobs. Returns the four
   report blocks so the report just renders, never recalculates:
     A startingSoon / endingSoon / milestones  (next `horizonDays`)
     B crew: booked vs idle roster + over-allocations + labor $ in window
     C atRisk: overdue, on-hold, material-blocked near-starts, critical ids
     D drawTriggers: final/done jobs with uninvoiced $ (contract − billed)
   `today` is an ISO "YYYY-MM-DD"; dollars come from job.contractValue /
   job.billedToDate; crew.hourlyRate (optional) drives the labor run-rate.
   ============================================================ */
export function computeCfoSnapshot(jobs, crew, settings, today, horizonDays = 7) {
  const s = settings || DEFAULT_SETTINGS;
  const J = Array.isArray(jobs) ? jobs : [];
  const roster = (Array.isArray(crew) ? crew : []).filter((c) => c && c.active !== false);
  const nameOf = (j) => j.title || j.customer || "Job";
  const inWin = (iso) => { if (!iso) return null; const d = dayDiff(today, iso); return d >= 0 && d <= horizonDays ? d : null; };
  const num = (v) => (v === "" || v == null || isNaN(Number(v))) ? null : Number(v);

  /* Block A — starting / ending soon */
  const startingSoon = [], endingSoon = [], milestones = [];
  for (const j of J) {
    if (!j) continue;
    if (j.isMilestone) {
      const dm = inWin(j.startDate);
      if (dm != null) milestones.push({ id: j.id, title: nameOf(j), date: j.startDate, inDays: dm });
      continue;
    }
    if (j.stage === "done") continue;
    const ds = inWin(j.startDate);
    if (ds != null) startingSoon.push({ id: j.id, title: nameOf(j), customer: j.customer || "", startDate: j.startDate, inDays: ds, crewCount: (j.crewIds || []).length });
    const dt = inWin(j.targetDate);
    if (dt != null) endingSoon.push({ id: j.id, title: nameOf(j), customer: j.customer || "", targetDate: j.targetDate, inDays: dt, crewCount: (j.crewIds || []).length });
  }
  startingSoon.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  endingSoon.sort((a, b) => (a.targetDate < b.targetDate ? -1 : 1));
  milestones.sort((a, b) => (a.date < b.date ? -1 : 1));

  /* Block B — crew allocation this window */
  const assigns = crewAssignments(J, s);
  const bookedIds = new Set(
    assigns.filter((a) => dayDiff(today, a.finish) >= 0 && dayDiff(today, a.start) <= horizonDays).map((a) => a.crewId)
  );
  const idle = roster.filter((c) => !bookedIds.has(c.id)).map((c) => ({ id: c.id, name: c.name || "—" }));
  const booked = roster.filter((c) => bookedIds.has(c.id)).map((c) => ({ id: c.id, name: c.name || "—" }));
  const over = findOverAllocations(J, s);
  const overAllocations = over.overloads
    .filter((o) => { const d = dayDiff(today, o.day); return d >= 0 && d <= horizonDays; })
    .map((o) => ({ ...o, crewName: (roster.find((c) => c.id === o.crewId) || {}).name || o.crewId }));
  // labor run-rate in window: booked hours × hourly_rate, when rates exist
  const rateById = new Map(roster.map((c) => [c.id, num(c.hourlyRate ?? c.hourly_rate)]));
  let laborCostWindow = 0, haveRates = false;
  for (const [cid, days] of over.load) {
    const rate = rateById.get(cid);
    if (rate == null) continue;
    haveRates = true;
    for (const [day, hrs] of days) { const d = dayDiff(today, day); if (d >= 0 && d <= horizonDays) laborCostWindow += hrs * rate; }
  }

  /* Block C — at-risk */
  const critical = computeCriticalPath(J, s);
  const mk = (j, extra) => ({ id: j.id, title: nameOf(j), customer: j.customer || "", stage: j.stage, targetDate: j.targetDate || null, startDate: j.startDate || null, onCriticalPath: critical.has(j.id), ...extra });
  const overdue = J.filter((j) => j && !j.isMilestone && j.stage !== "done" && j.targetDate && dayDiff(today, j.targetDate) < 0)
    .map((j) => mk(j, { daysLate: -dayDiff(today, j.targetDate) }))
    .sort((a, b) => b.daysLate - a.daysLate);
  const onHold = J.filter((j) => j && j.stage === "on_hold").map((j) => mk(j, {}));
  const materialBlocked = J.filter((j) => j && !j.isMilestone && j.stage !== "done"
    && j.materials && j.materials !== "received" && inWin(j.startDate) != null)
    .map((j) => mk(j, { materials: j.materials, notBefore: j.notBefore || null }));

  /* Block D — draw / billing triggers (dollars) */
  const drawTriggers = [];
  for (const j of J) {
    if (!j || j.isMilestone) continue;
    if (j.stage !== "final" && j.stage !== "done") continue;
    const cv = num(j.contractValue), bd = num(j.billedToDate) || 0;
    const uninvoiced = cv != null ? Math.max(0, cv - bd) : null;
    // surface everything Complete, and any Final with money still on the table
    if (j.stage === "done" || uninvoiced == null || uninvoiced > 0)
      drawTriggers.push({ id: j.id, title: nameOf(j), customer: j.customer || "", stage: j.stage, fieldJobId: j.fieldJobId || null, contractValue: cv, billedToDate: bd, uninvoiced });
  }
  drawTriggers.sort((a, b) => (b.uninvoiced || 0) - (a.uninvoiced || 0));
  const uninvoicedTotal = drawTriggers.reduce((t, d) => t + (d.uninvoiced || 0), 0);

  return {
    today, horizonDays,
    startingSoon, endingSoon, milestones,
    crew: { total: roster.length, booked, idle, overAllocations, laborCostWindow: haveRates ? Math.round(laborCostWindow) : null },
    atRisk: { overdue, onHold, materialBlocked, criticalIds: [...critical] },
    drawTriggers, uninvoicedTotal,
  };
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
