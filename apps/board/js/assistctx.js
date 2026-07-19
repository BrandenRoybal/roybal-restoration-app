/* ============================================================
   Job Board — 🗓️ assistant provider (dispatcher persona)
   ------------------------------------------------------------
   Board mount for the shared Ask-the-Office assistant
   (../../js/assist.js). buildContext() digests the CURRENT board
   caches into a compact snapshot at ask time — the CFO rollup
   (starting/ending soon, crew booked/idle, overloads, at-risk,
   draw triggers) plus one trimmed row per job — so v1 answers
   "who's free Thursday" / "what's slipping" with ZERO server
   tools. Runs the schedule engine on throwaway copies; never
   mutates or persists board state.
   ============================================================ */
import { todayISO } from "../../js/core.js";
import { cachedJobs, cachedCrew, cachedSettings, cachedEntries } from "./data.js";
import { computeSchedule, computeCfoSnapshot } from "./schedule.js";

/* One token-lean row per job — enough to answer scheduling questions,
   nothing the dispatcher persona doesn't need. Cap 50 (newest first). */
export function jobRows(jobs, crew, entries) {
  const nameById = new Map((crew || []).map((c) => [c.id, c.name || "—"]));
  const hoursByJob = new Map();
  for (const e of entries || []) {
    if (!e || !e.jobId) continue;
    hoursByJob.set(e.jobId, (hoursByJob.get(e.jobId) || 0) + (Number(e.hours) || 0));
  }
  return (jobs || [])
    .filter((j) => j && !j.isMilestone)
    .sort((a, b) => String(b.startDate || "") < String(a.startDate || "") ? -1 : 1)
    .slice(0, 50)
    .map((j) => ({
      title: j.title || j.customer || "Job",
      customer: j.customer || "",
      stage: j.stage || "",
      start: j.startDate || "",
      target: j.targetDate || "",
      crew: (j.crewIds || []).map((id) => nameById.get(id) || id),
      loggedHours: Math.round((hoursByJob.get(j.id) || 0) * 10) / 10 || undefined,
      materials: j.materials && j.materials !== "received" ? j.materials : undefined,
    }));
}

export function buildBoardContext() {
  // fresh throwaway copies — computeSchedule mutates derived dates in place,
  // and cachedJobs() re-parses localStorage per call, so board state is safe
  const jobs = cachedJobs();
  const crew = cachedCrew();
  const entries = cachedEntries();
  const settings = cachedSettings();
  const today = todayISO();
  try { computeSchedule(jobs, settings); } catch (_) { /* digest still works off saved dates */ }
  let snapshot = null;
  try { snapshot = computeCfoSnapshot(jobs, crew, settings, today, 7); } catch (_) { /* rows alone still help */ }
  return {
    today,
    workDays: settings.workDays,
    hoursPerDay: settings.hoursPerDay,
    week: snapshot,                 // starting/ending soon, crew booked+idle, overloads, at-risk, draws
    jobs: jobRows(jobs, crew, entries),
  };
}

/** The provider assist.js mounts — see mountAssistProvider(). */
export function boardAssistProvider() {
  return {
    key: "board",
    app: "board",
    title: "💬 Ask the board",
    sub: "Schedule-aware dispatcher · answers from the live board",
    greeting: () =>
      "Hey — ask me about the schedule: who's free this week, what's slipping, " +
      "what starts or wraps soon, who's overloaded. I answer from the board in front of you.",
    capturedBy: () => "board",
    buildContext: buildBoardContext,
  };
}
