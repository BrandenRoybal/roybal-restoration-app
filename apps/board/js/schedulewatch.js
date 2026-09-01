/* ============================================================
   Roybal Job Board — Schedule Watch (pure, no DOM)
   ------------------------------------------------------------
   Rule-based "is the schedule telling the truth?" flags for live
   jobs, mirroring the field app's dryingwatch.js. The engine's
   live overlay only works when logged hours actually reach a job —
   these flags say, loudly, when they can't or didn't:
     • no-jobcode     — no QuickBooks Time link, so QB hours can
                        NEVER attach; the schedule runs blind
     • no-hours       — started before today, zero scoped hours;
                        the engine still thinks remaining = full
                        estimate
     • unmarked-done  — a phase at/over its hour estimate that
                        nobody marked done; its leftover estimate
                        keeps sliding the whole chain right
   tone: 'bad' (needs action today) | 'warn' (watch it).
   Hours resolve through THE one join rule (scopedEntriesOfJob) and
   the same per-phase attribution the engine uses (phaseActuals) —
   never a second path. Pure + import-only-from-schedule.js so Node
   can unit-test it and the field app can share it.
   ============================================================ */
import { scopedEntriesOfJob, phaseActuals, DEFAULT_SETTINGS } from "./schedule.js";

/* Same live-tile filter as My Week's schedulableJobs (myweekcalc.js):
   not the pipeline (lead), not filed history (done/archived), not a
   milestone. Legacy hand-dated jobs still count — "no hours ever landed
   here" is true and actionable whether or not the engine moves them. */
export function watchable(job) {
  return !!(job && !job.archived && !job.isMilestone && job.stage !== "lead" && job.stage !== "done");
}

/**
 * scheduleFlags(job, entries, today, settings?) -> [{ kind, tone, short, label, subId?, subName? }]
 *  - `entries` is the FULL time_entries list; scoping (jobId / qbJobcodeId
 *    join + hoursFrom) happens in here so no caller can get it wrong.
 *  - `today` is an ISO "YYYY-MM-DD".
 */
export function scheduleFlags(job, entries, today, settings) {
  if (!watchable(job)) return [];
  const s = settings || DEFAULT_SETTINGS;
  const scoped = scopedEntriesOfJob(job, entries || []);
  const logged = scoped.reduce((t, e) => t + (Number(e.hours) || 0), 0);
  const flags = [];

  if (!job.qbJobcodeId) {
    flags.push({
      kind: "no-jobcode", tone: "bad", short: "No QB link",
      label: "No QuickBooks job linked — hours will not move this schedule. Link a QuickBooks Time jobcode in the job editor.",
    });
  } else if (job.startDate && job.startDate < today && logged <= 0) {
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
  if (subs.length && logged > 0) {
    const hours = phaseActuals(job, scoped, s);
    for (const st of subs) {
      if (!st || st.done) continue;
      const est = Number(st.estimatedHours) || 0;
      const act = hours.get(st.id) || 0;
      if (est > 0 && act >= est) {
        const name = st.name || "Phase";
        flags.push({
          kind: "unmarked-done", tone: "warn", subId: st.id, subName: name,
          short: `“${name}” done?`,
          label: `“${name}” looks finished (${Math.round(act * 10) / 10}h of ${est}h logged) but isn't marked done — it keeps getting scheduled and pushes everything after it.`,
        });
      }
    }
  }
  return flags;
}
