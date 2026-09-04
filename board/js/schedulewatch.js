/* ============================================================
   Roybal Job Board — Schedule Watch (pure, no DOM)
   ------------------------------------------------------------
   Rule-based "is the schedule telling the truth?" flags for live
   jobs, mirroring the field app's dryingwatch.js. The engine's
   live overlay only works when logged hours actually reach a job —
   these flags say, loudly, when they can't or didn't:
     • no-jobcode     — no QuickBooks Time link AND nothing logged
                        since start, so the schedule runs blind
     • no-hours       — started before today, zero hours since the
                        start; the engine still thinks remaining =
                        full estimate
     • unmarked-done  — a phase at/over its hour estimate that
                        nobody marked done; its leftover estimate
                        keeps sliding the whole chain right
   tone: 'bad' (needs action today) | 'warn' (watch it).
   Hours resolve through THE one join rule (scopedEntriesOfJob) and
   the same per-phase attribution the engine uses (phaseActuals) —
   never a second path. Callers that already ran the engine should
   pass its own attribution (`hoursBySub` from buildLiveOpts'
   phaseHours) so a flag can never disagree with the Gantt bars.
   Pure + import-only-from-schedule.js so Node can unit-test it and
   the field app can share it.
   ============================================================ */
import { scopedEntriesOfJob, phaseActuals, DEFAULT_SETTINGS } from "./schedule.js";

/* Same live-tile filter as My Week's schedulableJobs (myweekcalc.js) —
   not the pipeline (lead), not filed history (done/archived), not a
   milestone — MINUS On Hold: a held job's silence is deliberate (waiting
   on insurance / materials / the customer), and a permanently red On Hold
   column is exactly the noise that teaches the office to ignore the
   chips. The flags come back the moment the hold lifts. */
export function watchable(job) {
  return !!(job && !job.archived && !job.isMilestone
    && job.stage !== "lead" && job.stage !== "done" && job.stage !== "on_hold");
}

/**
 * scheduleFlags(job, entries, today, settings?, hoursBySub?) ->
 *   [{ kind, tone, short, label, subId?, subName?, lastHoursOn? }]
 *  - `entries` is the FULL time_entries list; scoping (jobId / qbJobcodeId
 *    join + hoursFrom) happens in here so no caller can get it wrong.
 *    Pass null/undefined when the entries COULD NOT BE READ (offline,
 *    HTTP error): the hours-dependent flags stay quiet instead of
 *    false-alarming off an empty list; only no-jobcode can be judged.
 *  - `today` is an ISO "YYYY-MM-DD".
 *  - `hoursBySub` (optional Map(subId → hours)): the engine's own phase
 *    attribution for this job (opts.phaseHours.get(job.id) from
 *    buildLiveOpts). Pass it wherever the engine already ran so the
 *    unmarked-done flag uses the exact numbers the bars display.
 */
export function scheduleFlags(job, entries, today, settings, hoursBySub) {
  if (!watchable(job)) return [];
  const s = settings || DEFAULT_SETTINGS;
  const known = Array.isArray(entries);          // null/undefined = "couldn't look"
  const scoped = known ? scopedEntriesOfJob(job, entries) : [];
  // "hours landed since start": a rebuild sharing its jobcode with the
  // mitigation tile (and no hoursFrom set) sees months of OLD hours — those
  // must not silence the flags, and must not fake phase progress either.
  const start = String(job.startDate || "");
  const sinceStart = scoped.reduce((t, e) =>
    t + ((!start || String(e.date || "") >= start) ? (Number(e.hours) || 0) : 0), 0);
  const flags = [];

  if (!job.qbJobcodeId && (!known || sinceStart <= 0)) {
    // a job deliberately run on manual entries (the jobId half of the join
    // rule) IS moving its schedule — no red chip for it while hours flow
    flags.push({
      kind: "no-jobcode", tone: "bad", short: "No QB link",
      label: "No QuickBooks job linked — hours will not move this schedule. Link a QuickBooks Time jobcode in the job editor.",
    });
  } else if (known && start && start < today && sinceStart <= 0) {
    // strict `<` on purpose: QuickBooks hours land on the nightly pull, so a
    // job that STARTED today having none yet is normal (the Day view ghosts
    // cover today), and a future start can't have missed anything. An
    // unlinked job is skipped too — no-jobcode above is the root cause, and
    // two flags for one fix is noise.
    flags.push({
      kind: "no-hours", tone: "bad", short: "0h since start",
      label: "No hours landed since this job started — the schedule is still just the estimate. Check QuickBooks Time (or log hours) so the board tracks reality.",
    });
  }

  const subs = Array.isArray(job.subtasks) ? job.subtasks : [];
  if (known && subs.length && sinceStart > 0) {
    const hours = hoursBySub || phaseActuals(job, scoped, s);
    // last day hours landed on each phase — the honest completedOn for the
    // one-tap "mark done" (stamping TODAY would retroactively swallow the
    // successor phase's window-attributed hours). phaseActuals resolves each
    // entry independently, so per-entry calls reuse THE attribution rather
    // than growing a second one. Built lazily: only flagged jobs pay for it.
    let lastBySub = null;
    const lastFor = (sid) => {
      if (!lastBySub) {
        lastBySub = new Map();
        for (const e of scoped) {
          const d = String(e.date || "");
          if (!d) continue;
          for (const [id, h] of phaseActuals(job, [e], s)) {
            if (h > 0 && d > (lastBySub.get(id) || "")) lastBySub.set(id, d);
          }
        }
      }
      return lastBySub.get(sid) || "";
    };
    for (const st of subs) {
      if (!st || st.done) continue;
      const est = Number(st.estimatedHours) || 0;
      const act = hours.get(st.id) || 0;
      if (est > 0 && act >= est) {
        const name = st.name || "Phase";
        flags.push({
          kind: "unmarked-done", tone: "warn", subId: st.id, subName: name,
          lastHoursOn: lastFor(st.id),
          short: `“${name}” done?`,
          label: `“${name}” looks finished (${Math.round(act * 10) / 10}h of ${est}h logged) but isn't marked done — it keeps getting scheduled and pushes everything after it.`,
        });
      }
    }
  }
  return flags;
}
