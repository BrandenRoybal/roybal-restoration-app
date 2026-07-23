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

/* ============================================================
   phase progress — actual hours vs plan, completion, delays
   ============================================================ */

/* Attribute a job's logged hours (QuickBooks Time + manual entries) to its
   sequential phases. Resolution per entry:
     1. an explicit entry.phaseId always wins (manual log picked a phase)
     2. phase completion marks partition history: an entry dated on/before a
        done phase's completedOn (and after the previous one's) belongs to it
     3. anything after the last mark date-matches the unfinished phases'
        scheduled windows; a miss lands on the last open phase already started,
        else the first open phase.
   Returns Map(subId → hours). Pure — pass the job's entries in. */
export function phaseActuals(job, jobEntries, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const subs = job.subtasks || [];
  const hours = new Map(subs.map((st) => [st.id, 0]));
  if (!subs.length || !jobEntries || !jobEntries.length) return hours;
  const byId = new Map(subs.map((st) => [st.id, st]));
  const bounds = [];                      // done phases with a date, in sequence order
  for (const st of subs) if (st.done && st.completedOn) bounds.push({ id: st.id, until: st.completedOn });
  const win = new Map((job.startDate ? layoutSubtasks(subs, job.startDate, s) : []).map((x) => [x.sub.id, x]));
  const open = subs.filter((st) => !st.done);
  for (const e of jobEntries) {
    const hrs = Number(e.hours) || 0; if (!hrs) continue;
    let target = e.phaseId && byId.has(e.phaseId) ? e.phaseId : null;
    const d = String(e.date || "");
    if (!target && d) for (const b of bounds) if (d <= b.until) { target = b.id; break; }
    if (!target) {
      for (const st of open) { const w = win.get(st.id); if (w && d >= w.start && d <= w.finish) { target = st.id; break; } }
      if (!target) {
        let lastStarted = null;
        for (const st of open) { const w = win.get(st.id); if (w && d && w.start <= d) lastStarted = st.id; }
        target = lastStarted || (open[0] && open[0].id) || subs[subs.length - 1].id;
      }
    }
    hours.set(target, (hours.get(target) || 0) + hrs);
  }
  return hours;
}

/* A job's entries = manual rows (matched by jobId) + QuickBooks Time rows for
   its linked jobcode. THE one join rule — board.js, actions.js, assistctx.js,
   and the phone agent must all resolve hours identically or their schedules
   drift apart. */
export function entriesOfJob(job, entries) {
  const jc = job && job.qbJobcodeId;
  return (entries || []).filter((e) =>
    e && (e.jobId === job.id || (jc && e.source === "qbtime" && e.qbJobcodeId === jc)));
}
/* …and scoped by the job's "count hours from" date (a rebuild sharing its
   jobcode with the mitigation phase ignores the mitigation hours) */
export function scopedEntriesOfJob(job, entries) {
  const from = job && job.hoursFrom;
  return entriesOfJob(job, entries).filter((e) => !from || String(e.date || "") >= from);
}
/* The opts blob that makes the engine run on REALITY: per-phased-job hour
   attribution + today. Every consumer (board applySchedule, assistant
   executors, assistant context, phone agent) builds it through here. */
export function buildLiveOpts(jobs, entries, settings, today) {
  const s = settings || DEFAULT_SETTINGS;
  const phaseHours = new Map(jobs
    .filter((j) => j && (j.subtasks || []).length)
    .map((j) => [j.id, phaseActuals(j, scopedEntriesOfJob(j, entries), s)]));
  return { today, phaseHours };
}

/* Lay a job's phases out against REALITY, not just the plan:
     · a done phase ends at its completedOn (early finishes pull the chain in,
       late ones push it out)
     · an unfinished phase's REMAINING hours (estimate − logged) size what's
       left, and that work can't be scheduled before `today` — so a phase
       nobody finished keeps sliding right (and delaying successors) until
       it's marked done
     · phases with no hour estimate fall back to their planned length.
   Same row shape as layoutSubtasks ({sub, start, finish, offFrac, durFrac})
   plus progress: {done, act, est, pct, late, lateDays, planStart, planFinish}.
   The last row's finish is the job's real projected completion — feed it to
   computeSchedule (via opts) and delays cascade into every linked job. */
export function layoutSubtasksLive(job, startISO, settings, hoursBySub, today) {
  const s = settings || DEFAULT_SETTINGS;
  const subs = job.subtasks || [];
  if (!subs.length || !startISO) return [];
  const plan = layoutSubtasks(subs, startISO, s);
  const hpd = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
  const tIdx = today && today > startISO ? workDaysBetween(startISO, today, s) - 1 : 0;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < subs.length; i++) {
    const st = subs[i], p = plan[i];
    const lag = i === 0 ? 0 : Math.max(0, Number(st.lagDays) || 0);
    if (lag > 0) cursor = Math.ceil(cursor - 1e-9) + lag;
    const est = Number(st.estimatedHours) || 0;
    const act = (hoursBySub && hoursBySub.get(st.id)) || 0;
    let startFrac, endFrac;
    if (st.done) {
      const startIdx = Math.floor(cursor + 1e-9);
      const startDay = addWorkDays(startISO, startIdx, s);
      startFrac = startIdx;
      if (st.completedOn && st.completedOn >= startDay) {
        endFrac = startIdx + workDaysBetween(startDay, st.completedOn, s);   // whole days, inclusive
      } else if (st.completedOn) {
        endFrac = startFrac;                                 // completed before it began (skipped)
      } else {
        endFrac = startFrac + p.durFrac;                     // legacy done-flag with no date
      }
    } else {
      const crewN = Math.max(1, (st.crewIds || []).length);
      const pinned = st.durationDays != null && Number(st.durationDays) > 0;
      // a manual day-pin outranks the hours math (same rule as the plan);
      // hours still shrink a pinned phase proportionally as work gets logged
      const remDur = pinned
        ? p.durFrac * (est > 0 ? Math.max(0, 1 - act / est) : 1)
        : (est > 0 ? Math.max(0, est - act) / (crewN * hpd) : p.durFrac);
      startFrac = act > 0 ? cursor : Math.max(cursor, tIdx); // untouched work can't start in the past
      endFrac = Math.max(startFrac, tIdx) + remDur;          // remaining work runs from today at best
    }
    const dur = Math.max(endFrac - startFrac, 0.1);
    const startIdx = Math.floor(startFrac + 1e-9);
    const finishIdx = Math.max(startIdx, Math.ceil(startFrac + dur - 1e-9) - 1);
    const finish = addWorkDays(startISO, finishIdx, s);
    const late = finish > p.finish;
    out.push({
      sub: st,
      start: addWorkDays(startISO, startIdx, s), finish,
      offFrac: startFrac, durFrac: dur,
      done: !!st.done, act, est,
      pct: st.done ? 100 : (est > 0 ? Math.round((act / est) * 100) : 0),
      late, lateDays: late ? Math.max(0, workDaysBetween(p.finish, finish, s) - 1) : 0,
      planStart: p.start, planFinish: p.finish,
    });
    cursor = startFrac + dur;
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
     { changed: [jobs whose dates moved], cyclic: [ids in a dependency cycle] }
   opts (optional) = { today, phaseHours: Map(jobId → Map(subId → hours)) } —
   when given, phased jobs roll up from layoutSubtasksLive instead of the pure
   plan, so real phase progress/delays drive targetDate and cascade to every
   linked job. Without opts (e.g. the phone agent) it's the pure plan. */
export function computeSchedule(jobs, settings, opts) {
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
    const subL = (!job.isMilestone && job.subtasks && job.subtasks.length)
      ? (opts && opts.today
        ? layoutSubtasksLive(job, newStart, s, opts.phaseHours && opts.phaseHours.get(job.id), opts.today)
        : layoutSubtasks(job.subtasks, newStart, s))
      : null;
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

/* Inclusive calendar-day list [startISO, endISO] — the granularity outDays and
   dayCrew keys use. Order-tolerant; capped so a typo'd year can't build a
   10,000-day array. Returns [] on malformed dates. */
export function listDays(startISO, endISO, cap = 92) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO.test(String(startISO || "")) || !ISO.test(String(endISO || ""))) return [];
  let lo = startISO <= endISO ? startISO : endISO;
  const hi = startISO <= endISO ? endISO : startISO;
  const out = [];
  while (lo <= hi && out.length < cap) { out.push(lo); lo = addDaysISO(lo, 1); }
  return out;
}

/* Per-day crew override edits — the pure core of the Crew board's drag moves
   (dayPull/dayPush there), exported so the assistant's confirm-chip executors
   write byte-identical dayCrew deltas. `base` is the roster the override
   applies against (the job's or active phase's crewIds); empty deltas are
   cleaned away so an undone move leaves no residue. */
function dayCrewDelta(job, day) {
  job.dayCrew = job.dayCrew || {};
  return (job.dayCrew[day] = job.dayCrew[day] || { add: [], remove: [] });
}
function dayCrewClean(job, day) {
  const m = job.dayCrew; if (!m) return;
  const d = m[day]; if (d && !(d.add || []).length && !(d.remove || []).length) delete m[day];
  if (!Object.keys(m).length) delete job.dayCrew;
}
export function dayCrewPull(job, day, cid, base) {      // off this job, this day only
  base = base || [];
  const d = dayCrewDelta(job, day);
  d.add = (d.add || []).filter((x) => x !== cid);
  if (base.includes(cid) && !(d.remove || []).includes(cid)) d.remove.push(cid);
  dayCrewClean(job, day);
}
export function dayCrewPush(job, day, cid, base) {      // onto this job, this day only
  base = base || [];
  const d = dayCrewDelta(job, day);
  d.remove = (d.remove || []).filter((x) => x !== cid);
  if (!base.includes(cid) && !(d.add || []).includes(cid)) d.add.push(cid);
  dayCrewClean(job, day);
}

/* ---- crew assignment spans: job.crewSpans[cid] = [{ from?, to? }] ----
   By default a crew member rides a job for its WHOLE run (no entry here).
   A span list limits them to those date windows so guys can cycle in and
   out of a long job without rewriting history: `{to}` = on until that day,
   `{from}` = on from that day, both = a bounded stint. Per-day resolution
   order everywhere: roster (job/phase crewIds) → span filter → dayCrew
   delta. Spans are job-level, so they also bound phase rosters. */
export function spanActive(spans, day) {
  if (!spans || !spans.length) return true;
  return spans.some((sp) => (!sp.from || day >= sp.from) && (!sp.to || day <= sp.to));
}
export function spanCrew(base, crewSpans, day) {
  if (!crewSpans) return base || [];
  return (base || []).filter((cid) => spanActive(crewSpans[cid], day));
}
export function spanCrewClear(job, cid) {               // back to the whole-run default
  if (!job.crewSpans) return;
  delete job.crewSpans[cid];
  if (!Object.keys(job.crewSpans).length) delete job.crewSpans;
}

/* drop cid from every dayCrew `list` entry on/after `day` — a span move
   supersedes leftover one-day overrides inside its window */
function scrubDayCrew(job, day, cid, list) {
  const m = job.dayCrew; if (!m) return;
  for (const d of Object.keys(m)) {
    if (d < day) continue;
    m[d][list] = (m[d][list] || []).filter((x) => x !== cid);
    dayCrewClean(job, d);
  }
}
const onRosterOf = (job, cid) =>
  (job.crewIds || []).includes(cid) || (job.subtasks || []).some((st) => (st.crewIds || []).includes(cid));

/* off this job from `day` onward — days already worked stay as worked */
export function spanCrewPull(job, day, cid) {
  scrubDayCrew(job, day, cid, "add");
  if (!onRosterOf(job, cid)) return spanCrewClear(job, cid);   // day-override guest: scrub was enough
  const prev = addDaysISO(day, -1);
  const cur = (job.crewSpans || {})[cid];
  const next = (cur && cur.length ? cur : [{}])                 // no spans yet = whole run
    .filter((sp) => !sp.from || sp.from <= prev)                // stints starting at/after the cutoff vanish
    .map((sp) => (!sp.to || sp.to > prev) ? { ...sp, to: prev } : { ...sp });
  if (!next.length || (job.startDate && next.every((sp) => sp.to < job.startDate))) {
    // they never actually work this job → clean removal from the roster
    job.crewIds = (job.crewIds || []).filter((x) => x !== cid);
    for (const st of (job.subtasks || [])) if (st.crewIds) st.crewIds = st.crewIds.filter((x) => x !== cid);
    return spanCrewClear(job, cid);
  }
  job.crewSpans = job.crewSpans || {};
  job.crewSpans[cid] = next;
}

/* on this job from `day` onward. Ensures roster membership (job-level, or
   every phase still running on/after `day` for phase-staffed jobs) and
   merges [day → end] into their spans; a fresh mid-job joiner gets
   `{from: day}` so they are NOT retroactively on earlier days.
   `rows` (optional) = the phase layout to judge "still running" by — pass the
   LIVE layout (layoutSubtasksLive) so a behind-schedule job's active phase
   counts as running even though its PLANNED finish is in the past; defaults
   to the pure plan for opts-less callers. */
export function spanCrewPush(job, day, cid, settings, rows) {
  const s = settings || DEFAULT_SETTINGS;
  const phases = job.subtasks || [];
  const phased = phases.some((st) => (st.crewIds || []).length) && job.startDate;
  const wasOn = onRosterOf(job, cid);
  if (phased) {
    for (const { sub, finish } of (rows || layoutSubtasks(phases, job.startDate, s)))
      if (!finish || finish >= day) { sub.crewIds = sub.crewIds || []; if (!sub.crewIds.includes(cid)) sub.crewIds.push(cid); }
  } else if (!(job.crewIds || []).includes(cid)) {
    job.crewIds = [...(job.crewIds || []), cid];
  }
  scrubDayCrew(job, day, cid, "remove");
  const cur = (job.crewSpans || {})[cid];
  if (!cur || !cur.length) {
    if (!wasOn && job.startDate && day > job.startDate) {       // joining mid-job, not day one
      job.crewSpans = job.crewSpans || {};
      job.crewSpans[cid] = [{ from: day }];
    }
    return;
  }
  const prev = addDaysISO(day, -1);
  const before = [];
  let from = day, sinceStart = false;
  for (const sp of cur) {
    if (sp.to && sp.to < prev) before.push({ ...sp });          // clear of the new window
    else if (!sp.from) sinceStart = true;                       // absorb into [day → end]
    else if (sp.from < from) from = sp.from;
  }
  if (sinceStart) return spanCrewClear(job, cid);               // start → end = whole run again
  job.crewSpans[cid] = [...before, { from }];
}

export function crewDayLoad(jobs, settings, opts) {
  const s = settings || DEFAULT_SETTINGS;
  const hpd = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
  const live = !!(opts && opts.today);
  const load = new Map(), jobsOn = new Map();
  const bump = (cid, day, hrs, jid) => {
    let m = load.get(cid); if (!m) load.set(cid, (m = new Map()));
    m.set(day, (m.get(day) || 0) + hrs);
    let jm = jobsOn.get(cid); if (!jm) jobsOn.set(cid, (jm = new Map()));
    let set = jm.get(day); if (!set) jm.set(day, (set = new Set())); set.add(jid);
  };
  // distribute totalHours across the days a phase/job touches; per-day crew can
  // differ when a day has an override, so the hours that day re-split among them.
  const spread = (jobStart, offFrac, durFrac, baseCrew, totalHours, jid, dayOv, spans) => {
    const startIdx = Math.floor(offFrac + 1e-9);
    const endIdx = Math.max(startIdx, Math.ceil(offFrac + durFrac - 1e-9) - 1);
    for (let k = startIdx; k <= endIdx; k++) {
      const ov = Math.max(0, Math.min(offFrac + durFrac, k + 1) - Math.max(offFrac, k));
      if (ov <= 0) continue;
      const day = addWorkDays(jobStart, k, s);
      const eff = effCrew(spanCrew(baseCrew, spans, day), dayOv && dayOv[day]);
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
      const rows = live
        ? layoutSubtasksLive(j, j.startDate, s, opts.phaseHours && opts.phaseHours.get(j.id), opts.today)
        : layoutSubtasks(phases, j.startDate, s);
      // live mode books remaining work from TODAY forward, never onto days
      // that already happened (an in-progress phase's live window can reach
      // back to when it started)
      const tIdx = live && opts.today > j.startDate ? workDaysBetween(j.startDate, opts.today, s) - 1 : 0;
      for (const row of rows) {
        const { sub, offFrac, durFrac } = row;
        if (live && row.done) continue;         // finished phases book no future work
        const base = sub.crewIds || [];
        if (!base.length && !dayOv) continue;   // crewless phase only matters on override days
        const hrs = live
          ? (row.est > 0
            ? Math.max(0, row.est - row.act)    // only the REMAINING hours load the crew
            : durationFracOf(sub, s) * Math.max(1, base.length) * hpd)  // no estimate: the PLAN-length workload, not the slid live window
          : (Number(sub.estimatedHours) || durFrac * Math.max(1, base.length) * hpd);
        if (hrs <= 0) continue;
        const bookOff = live ? Math.max(offFrac, tIdx) : offFrac;
        const bookDur = Math.max(offFrac + durFrac - bookOff, 0.05);
        spread(j.startDate, bookOff, bookDur, base, hrs, j.id, dayOv, j.crewSpans || null);
      }
    } else if (j.targetDate && ((j.crewIds || []).length || dayOv)) {
      const span = workDaysBetween(j.startDate, j.targetDate, s);
      const base = j.crewIds || [];
      const hrs = Number(j.estimatedHours) || span * Math.max(1, base.length) * hpd;
      spread(j.startDate, 0, span, base, hrs, j.id, dayOv, j.crewSpans || null);
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
export function findOverAllocations(jobs, settings, opts) {
  const s = settings || DEFAULT_SETTINGS;
  const cap = Math.max(1, Number(s.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay);
  const { load, jobsOn } = crewDayLoad(jobs, s, opts);
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
export function computeCfoSnapshot(jobs, crew, settings, today, horizonDays = 7, opts) {
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

  /* Block B — crew allocation this window. Booked/idle come from the LOAD
     map (with opts: live remaining-work booking, span- and override-aware),
     so a guy cycled off a job via crewSpans really shows as free. */
  const over = findOverAllocations(J, s, opts);
  const bookedIds = new Set();
  for (const [cid, days] of over.load) {
    for (const [day] of days) { const d = dayDiff(today, day); if (d >= 0 && d <= horizonDays) { bookedIds.add(cid); break; } }
  }
  const idle = roster.filter((c) => !bookedIds.has(c.id)).map((c) => ({ id: c.id, name: c.name || "—" }));
  const booked = roster.filter((c) => bookedIds.has(c.id)).map((c) => ({ id: c.id, name: c.name || "—" }));
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
