/* ============================================================
   Roybal Field Forms — "My Week" pure logic
   ------------------------------------------------------------
   Slices the Job Board's live schedule down to ONE crew member's
   next days — which jobs, where, and their out days — using the
   board's own engine so this view can never disagree with the
   whiteboard. Pure functions: no DOM, no fetch (myweek.js owns
   both), so Node can unit-test the slicing.

   The engine import is the same relative path in the repo AND in
   production: apps/field/js → apps/board/js in the tree, and
   /js → /board/js on app.roybalconstruction.com (deploy-field.yml
   copies field to the site root and board to /board).
   ============================================================ */
import {
  computeSchedule, crewDayLoad, buildLiveOpts, isWorkDay, DEFAULT_SETTINGS,
} from "../../board/js/schedule.js";
import { scheduleFlags } from "../../board/js/schedulewatch.js";

/* Match the signed-in email to a crew member. Case/space-insensitive; rows
   are the crew data objects. Null when no email or no match — the caller
   falls back to the device's tech pick. */
export function crewByEmail(crew, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return (crew || []).find((c) => c && String(c.email || "").trim().toLowerCase() === e) || null;
}

/* Board jobs that belong on a schedule: live tiles with dates, not the
   pipeline (lead), not filed history (done/archived), not milestones. */
export function schedulableJobs(jobs) {
  return (jobs || []).filter((j) =>
    j && !j.archived && !j.isMilestone && j.stage !== "lead" && j.stage !== "done");
}

/* addDaysISO, local-midnight safe (mirrors schedule.js's private helper) */
export const shiftDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const nextDay = (iso) => shiftDays(iso, 1);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* The oldest time entry that can still change a live schedule.
   buildLiveOpts only attributes hours to jobs that are still live (see
   liveCrewDays), so entries predating the oldest live job are dead weight —
   and time_entries outgrew Supabase's 1000-row page in Aug 2026, where an
   unbounded read silently dropped the NEWEST rows and the week drifted from
   the board. `buffer` covers hours logged a little before a job's start;
   `maxDays` stops a typo'd 1999 start date from widening the window forever.
   ⚠️ Mirrored server-side in supabase/functions/roybal-brief/crewdigest.ts —
   both are unit-tested on the same cases; change them together. */
export function entriesCutoff(jobs, today, buffer = 30, maxDays = 365) {
  const dates = [];
  for (const j of schedulableJobs(jobs)) {
    for (const v of [j.startDate, j.hoursFrom]) {
      const s = String(v || "").trim();
      if (ISO_DATE.test(s)) dates.push(s);
    }
  }
  const floor = shiftDays(today, -maxDays);
  if (!dates.length) return shiftDays(today, -90);
  const oldest = dates.sort()[0];
  const withBuffer = shiftDays(oldest, -buffer);
  return withBuffer < floor ? floor : withBuffer;
}

/* Clone + live-recompute core shared by the crew-day map and the flag map:
   the engine's attribution (opts.phaseHours) is built from the SAVED dates,
   then computeSchedule writes live dates onto the clones — exactly the
   sequence the board's applySchedule runs, so every consumer of this file
   judges jobs the same way the board does. Callers' jobs are never mutated. */
function liveScheduled({ jobs, entries, settings, today }) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const live = schedulableJobs(jobs).map((j) => ({ ...j }));
  let opts;
  try { opts = buildLiveOpts(live, entries || [], s, today); } catch { /* plan fallback */ }
  try { computeSchedule(live, s, opts); } catch { /* saved dates still work */ }
  return { live, opts, s };
}

/* The live per-crew, per-day job map for EVERY crew member at once —
   shared by My Week (one member) and the crew digest (all of them).
   Mutates nothing the caller keeps: jobs are cloned before the engine
   writes computed dates onto them. Returns:
     { jobsOn: Map(crewId -> Map(dayISO -> Set(jobId))), byId: Map(jobId -> job), settings, opts } */
export function liveCrewDays({ jobs, entries, settings, today }) {
  const { live, opts, s } = liveScheduled({ jobs, entries, settings, today });
  // an opts-less recompute would silently un-push every delayed job — see
  // services/phone-agent/tools.mjs; always pass opts through to the load
  const { jobsOn } = crewDayLoad(live, s, opts);
  return { jobsOn, byId: new Map(live.map((j) => [j.id, j])), settings: s, opts };
}

/* Schedule-truth flags for a whole board read, judged EXACTLY like the board
   judges them: engine-fresh dates (a dependent job pushed by its predecessor
   is not "silent since start" — it hasn't started) and the engine's own
   phase attribution. The field jobs list and job-home card go through here
   so no surface can disagree with the board or My Week.
   `entries` may be null ("couldn't read hours") — scheduleFlags then keeps
   the hours-dependent flags quiet. Returns Map(jobId -> flags). */
export function boardFlagsByJob({ jobs, entries, settings, today }) {
  const { live, opts, s } = liveScheduled({ jobs, entries, settings, today });
  const out = new Map();
  for (const j of live) {
    try {
      out.set(j.id, scheduleFlags(j, entries, today, s,
        opts && opts.phaseHours && opts.phaseHours.get(j.id)));
    } catch { out.set(j.id, []); }   // flags are an extra — never sink the caller
  }
  return out;
}

/* One crew member's day-by-day view from `today` forward.
   Returns [{ day, isWork, out, jobs: [{ id, title, customer, address, stage, flags }] }]
   — calendar days (weekends included so "nothing Saturday" is visible),
   `out` from the member's outDays (PTO/blocked; jobs suppressed those days).
   `flags` are the board's schedule-truth flags (schedulewatch.js) so a job
   whose hours can't reach the schedule is loud on the tech's own week too. */
export function buildMyWeek({ jobs, crew, entries, settings, crewId, today, days = 14 }) {
  const member = (crew || []).find((c) => c && c.id === crewId) || null;
  const { jobsOn, byId, settings: s, opts } = liveCrewDays({ jobs, entries, settings, today });
  const mine = jobsOn.get(crewId) || new Map();
  const outDays = (member && member.outDays) || [];
  const flagCache = new Map();   // jobId → flags, computed once per job
  const flagsOf = (j) => {
    if (!flagCache.has(j.id)) {
      // entries === null means the hours read failed — scheduleFlags then
      // keeps the hours-dependent flags quiet instead of crying "0h" at
      // every job. Attribution comes from the engine's own opts.phaseHours
      // so a flag never names a different phase than the schedule used.
      try {
        flagCache.set(j.id, scheduleFlags(j, entries, today, s,
          opts && opts.phaseHours && opts.phaseHours.get(j.id)));
      } catch { flagCache.set(j.id, []); }   // flags are an extra — never sink the week
    }
    return flagCache.get(j.id);
  };
  const out = [];
  let day = today;
  for (let i = 0; i < days; i++) {
    const isOut = outDays.includes(day);
    const dayJobs = isOut ? [] : [...(mine.get(day) || [])]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((j) => ({
        id: j.id,
        title: j.title || j.customer || "Job",
        customer: j.customer || "",
        address: j.address || "",
        stage: j.stage || "",
        flags: flagsOf(j),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    out.push({ day, isWork: isWorkDay(day, s), out: isOut, jobs: dayJobs });
    day = nextDay(day);
  }
  return { member: member ? { id: member.id, name: member.name || "" } : null, days: out };
}
