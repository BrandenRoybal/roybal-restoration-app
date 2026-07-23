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
import { computeSchedule, computeCfoSnapshot, buildLiveOpts, layoutSubtasksLive, scopedEntriesOfJob, spanActive } from "./schedule.js";
import { runBoardAction } from "./actions.js";

/* One token-lean row per job — enough to answer scheduling questions,
   nothing the dispatcher persona doesn't need. Cap 50 (newest first).
   Hours use the SAME join the board cards do (manual + linked QuickBooks
   rows, hoursFrom-scoped); crew lists respect assignment spans; phased jobs
   carry a compact live phase readout so "is framing late?" is answerable. */
export function jobRows(jobs, crew, entries, settings, opts) {
  const nameById = new Map((crew || []).map((c) => [c.id, c.name || "—"]));
  const today = (opts && opts.today) || todayISO();
  return (jobs || [])
    .filter((j) => j && !j.isMilestone)
    .sort((a, b) => String(b.startDate || "") < String(a.startDate || "") ? -1 : 1)
    .slice(0, 50)
    .map((j) => {
      const logged = scopedEntriesOfJob(j, entries || []).reduce((s, e) => s + (Number(e.hours) || 0), 0);
      // crew names, annotated with their assignment window when span-limited
      const crewNames = (j.crewIds || []).map((id) => {
        const nm = nameById.get(id) || id;
        const spans = j.crewSpans && j.crewSpans[id];
        if (!spans || !spans.length) return nm;
        if (!spanActive(spans, today)) {
          const sp = spans[spans.length - 1];
          return `${nm} (off; ${sp.from ? "on from " + sp.from : "on until " + (sp.to || "?")})`;
        }
        const cur = spans.find((sp) => (!sp.from || today >= sp.from) && (!sp.to || today <= sp.to));
        return cur && cur.to ? `${nm} (until ${cur.to})` : nm;
      });
      const row = {
        title: j.title || j.customer || "Job",
        customer: j.customer || "",
        stage: j.stage || "",
        start: j.startDate || "",
        target: j.targetDate || "",
        crew: crewNames,
        loggedHours: Math.round(logged * 10) / 10 || undefined,
        materials: j.materials && j.materials !== "received" ? j.materials : undefined,
      };
      // live phase readout: done ✓, current phase %, behind-plan days
      if ((j.subtasks || []).length && j.startDate) {
        try {
          const L = layoutSubtasksLive(j, j.startDate, settings, opts && opts.phaseHours && opts.phaseHours.get(j.id), today);
          row.phases = L.map((r) => ({
            name: r.sub.name || "Phase",
            ...(r.done ? { done: true, completedOn: r.sub.completedOn || undefined } : {
              pct: r.est > 0 ? Math.min(999, r.pct) : undefined,
              hours: `${Math.round(r.act * 10) / 10}/${r.est || "?"}`,
              finish: r.finish,
              ...(r.late ? { behindPlanDays: r.lateDays } : {}),
            }),
          }));
          const cur = L.find((r) => !r.done);
          if (cur) row.currentPhase = cur.sub.name || "Phase";
        } catch (_) { /* row still useful without phases */ }
      }
      return row;
    });
}

export function buildBoardContext() {
  // fresh throwaway copies — computeSchedule mutates derived dates in place,
  // and cachedJobs() re-parses localStorage per call, so board state is safe
  const jobs = cachedJobs();
  const crew = cachedCrew();
  const entries = cachedEntries();
  const settings = cachedSettings();
  const today = todayISO();
  // the SAME live opts the board runs on — the assistant must answer from the
  // schedule the user is looking at, not the pre-actuals plan
  let opts = null;
  try { opts = buildLiveOpts(jobs, entries, settings, today); } catch (_) { /* plan fallback */ }
  try { computeSchedule(jobs, settings, opts || undefined); } catch (_) { /* digest still works off saved dates */ }
  let snapshot = null;
  try { snapshot = computeCfoSnapshot(jobs, crew, settings, today, 7, opts || undefined); } catch (_) { /* rows alone still help */ }
  return {
    today,
    workDays: settings.workDays,
    hoursPerDay: settings.hoursPerDay,
    week: snapshot,                 // starting/ending soon, crew booked+idle, overloads, at-risk, draws
    jobs: jobRows(jobs, crew, entries, settings, opts),
  };
}

/** The provider assist.js mounts — see mountAssistProvider(). `refresh` is
    board.js's pull-and-render, so an executed chip shows on the board at
    once instead of waiting out the 20s poll. */
export function boardAssistProvider(refresh) {
  return {
    key: "board",
    app: "board",
    title: "💬 Ask the board",
    sub: "Schedule-aware dispatcher · answers from the live board",
    greeting: () =>
      "Hey — ask me about the schedule: who's free this week, what's slipping, " +
      "what starts or wraps soon, who's overloaded. I answer from the board in front of you, " +
      "and I can queue up a move, logged hours, or a text — you confirm with a tap.",
    capturedBy: () => "board",
    buildContext: buildBoardContext,
    executeAction: (a) => runBoardAction(a, refresh),
  };
}
