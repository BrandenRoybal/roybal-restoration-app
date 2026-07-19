/* ============================================================
   Job Board — assistant action executors (Phase 5)
   ------------------------------------------------------------
   Runs the confirm chips the dispatcher persona proposes: move a
   job's start, log crew hours, text from the company number.
   Every job write goes through data.js saveJob — the GUARDED rev
   write — never a raw server update, so a chip on a stale board
   can't clobber newer office edits. moveJob mirrors the drag
   interaction: pin the start (scheduleMode 'manual'), let the
   engine reflow dependents, persist every job it moved.
   ============================================================ */
import { uid, todayISO } from "../../js/core.js";
import { assistSend } from "../../js/sms.js";
import { cachedJobs, cachedCrew, cachedSettings, saveJob, saveTimeEntry, currentEmail } from "./data.js";
import { computeSchedule } from "./schedule.js";

const jobName = (j) => String(j.title || j.customer || "Job");

/* match exactly one item by name fragment; an exact hit on any single
   name field (title OR customer) beats fragment ambiguity */
function matchOne(list, q, namesOf, what) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return { err: `which ${what}? none named` };
  const hits = list.filter((x) => namesOf(x).some((n) => n.toLowerCase().includes(needle)));
  if (!hits.length) return { err: `no ${what} matches “${q}”` };
  if (hits.length > 1) {
    const exact = hits.filter((x) => namesOf(x).some((n) => n.toLowerCase() === needle));
    if (exact.length === 1) return { hit: exact[0] };
    return { err: `${hits.length} ${what}s match “${q}” — be more specific` };
  }
  return { hit: hits[0] };
}
const findJob = (jobs, q) =>
  matchOne(jobs.filter((j) => j && !j.isMilestone), q, (j) => [j.title || "", j.customer || ""].filter(Boolean), "job");
const findCrew = (crew, q) => matchOne(crew, q, (c) => [String(c.name || "")], "crew member");

/* pin the job's start and persist everything the engine reflowed */
async function moveJob(params, refresh) {
  const date = String(params.newStart || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, detail: "newStart must be a YYYY-MM-DD date" };
  const jobs = cachedJobs();                       // fresh throwaway copies (last-synced revs)
  const m = findJob(jobs, params.job);
  if (m.err) return { ok: false, detail: m.err };
  const j = m.hit;
  const before = new Map(jobs.map((x) => [x.id, `${x.startDate || ""}|${x.endDate || ""}`]));
  j.scheduleMode = "manual";
  j.pinnedStart = date;
  try { computeSchedule(jobs, cachedSettings()); } catch (_) { j.startDate = date; }
  const changed = jobs.filter((x) => x.id === j.id || before.get(x.id) !== `${x.startDate || ""}|${x.endDate || ""}`);
  for (const c of changed) {
    const r = await saveJob(c);
    if (r && r.conflict && c.id === j.id)
      return { ok: false, detail: "the board changed on another device — reopen the job and try again" };
  }
  if (refresh) refresh();
  const moved = changed.length - 1;
  return { ok: true, detail: `${jobName(j)} now starts ${j.startDate || date}${moved > 0 ? ` (+${moved} linked job${moved === 1 ? "" : "s"} reflowed)` : ""}` };
}

async function logHours(params) {
  const hours = Number(params.hours);
  if (!(hours > 0 && hours <= 24)) return { ok: false, detail: "hours must be between 0 and 24" };
  const jm = findJob(cachedJobs(), params.job);
  if (jm.err) return { ok: false, detail: jm.err };
  const cm = findCrew(cachedCrew(), params.crew);
  if (cm.err) return { ok: false, detail: cm.err };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date || "")) ? String(params.date) : todayISO();
  await saveTimeEntry({
    id: uid(), jobId: jm.hit.id, crewId: cm.hit.id, date, hours,
    note: String(params.note || "").slice(0, 200), enteredBy: currentEmail(),
  });
  return { ok: true, detail: `${hours}h — ${cm.hit.name} on ${jobName(jm.hit)} (${date})` };
}

/** The board provider's executeAction — see mountAssistProvider(). */
export function runBoardAction(a, refresh) {
  const p = (a && a.params) || {};
  switch (a && a.type) {
    case "sendText": return assistSend({ to: p.to, message: p.message, audience: p.audience, by: "board" });
    case "moveJob": return moveJob(p, refresh);
    case "logHours": return logHours(p);
    default: return { ok: false, detail: "not available on the board" };
  }
}
