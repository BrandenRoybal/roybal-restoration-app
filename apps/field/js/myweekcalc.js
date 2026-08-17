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
const nextDay = (iso) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/* The live per-crew, per-day job map for EVERY crew member at once —
   shared by My Week (one member) and the crew digest (all of them).
   Mutates nothing the caller keeps: jobs are cloned before the engine
   writes computed dates onto them. Returns:
     { jobsOn: Map(crewId -> Map(dayISO -> Set(jobId))), byId: Map(jobId -> job), settings } */
export function liveCrewDays({ jobs, entries, settings, today }) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const live = schedulableJobs(jobs).map((j) => ({ ...j }));
  let opts;
  try { opts = buildLiveOpts(live, entries || [], s, today); } catch { /* plan fallback */ }
  try { computeSchedule(live, s, opts); } catch { /* saved dates still work */ }
  // an opts-less recompute would silently un-push every delayed job — see
  // services/phone-agent/tools.mjs; always pass opts through to the load
  const { jobsOn } = crewDayLoad(live, s, opts);
  return { jobsOn, byId: new Map(live.map((j) => [j.id, j])), settings: s };
}

/* One crew member's day-by-day view from `today` forward.
   Returns [{ day, isWork, out, jobs: [{ id, title, customer, address, stage }] }]
   — calendar days (weekends included so "nothing Saturday" is visible),
   `out` from the member's outDays (PTO/blocked; jobs suppressed those days). */
export function buildMyWeek({ jobs, crew, entries, settings, crewId, today, days = 14 }) {
  const member = (crew || []).find((c) => c && c.id === crewId) || null;
  const { jobsOn, byId, settings: s } = liveCrewDays({ jobs, entries, settings, today });
  const mine = jobsOn.get(crewId) || new Map();
  const outDays = (member && member.outDays) || [];
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
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    out.push({ day, isWork: isWorkDay(day, s), out: isOut, jobs: dayJobs });
    day = nextDay(day);
  }
  return { member: member ? { id: member.id, name: member.name || "" } : null, days: out };
}
