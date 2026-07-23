/* ============================================================
   Job Board — assistant action executors (Phase 5 + 7)
   ------------------------------------------------------------
   Runs the confirm chips the dispatcher persona proposes: update
   or create board jobs, block out crew availability, per-day crew
   swaps, log hours, text from the company number.
   Every job write goes through data.js saveJob — the GUARDED rev
   write — never a raw server update, so a chip on a stale board
   can't clobber newer office edits. Date pins mirror the drag
   interaction (scheduleMode 'manual' + engine reflow); per-day
   crew edits write the same dayCrew deltas as the Crew board's
   drags; availability blocks pair outDays with freed day slots,
   exactly like dropping a guy on the "Out today" column.
   ============================================================ */
import { uid, todayISO } from "../../js/core.js";
import { assistSend } from "../../js/sms.js";
import {
  cachedJobs, cachedCrew, cachedEntries, cachedSettings,
  saveJob, saveCrewMember, saveTimeEntry, currentEmail,
} from "./data.js";
import {
  computeSchedule, workDaysBetween, layoutSubtasksLive, phaseActuals,
  scopedEntriesOfJob, entriesOfJob, buildLiveOpts,
  effCrew, spanCrew, spanCrewPull, spanCrewPush, listDays, dayCrewPull, dayCrewPush,
} from "./schedule.js";

const jobName = (j) => String(j.title || j.customer || "Job");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoOr = (v) => (ISO.test(String(v || "")) ? String(v) : "");

/* keep in sync with board.js STAGES / MATERIALS / TYPES ids */
const STAGE_IDS = ["lead", "scheduled", "in_progress", "on_hold", "final", "done"];
const MATERIAL_IDS = ["none", "ordered", "received"];
const TYPE_IDS = ["remodel", "new_build", "restoration", "water", "fire", "mold", "other"];

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
function findJob(jobs, q) {
  const byId = jobs.find((j) => j && !j.isMilestone && j.id === q);
  if (byId) return { hit: byId };
  return matchOne(jobs.filter((j) => j && !j.isMilestone), q, (j) => [j.title || "", j.customer || ""].filter(Boolean), "job");
}
function findCrew(crew, q) {
  const byId = crew.find((c) => c && c.id === q);
  if (byId) return { hit: byId };
  return matchOne(crew, q, (c) => [String(c.name || "")], "crew member");
}

/* names[] → unique crew ids, erroring on any miss/ambiguity (a confirmed
   chip must do exactly what its label said, or nothing) */
function resolveCrewNames(names) {
  const crew = cachedCrew();
  const ids = [], members = [];
  for (const n of Array.isArray(names) ? names : []) {
    const m = findCrew(crew, n);
    if (m.err) return { err: m.err };
    if (!ids.includes(m.hit.id)) { ids.push(m.hit.id); members.push(m.hit); }
  }
  return { ids, members };
}

/* ---- day-level helpers mirroring the Crew board's slot logic ---- */
function jobActiveOn(j, iso) {
  const s = j.startDate, t = j.targetDate;
  if (s && t) return iso >= s && iso <= t;
  if (s) return iso === s;
  if (t) return iso === t;
  return false;
}
/* live schedule opts: per-phase logged hours + today, so assistant writes
   reflow the SAME reality-aware schedule the board shows (shared join +
   hoursFrom scope live in schedule.js — one rule for every lane) */
const liveOpts = (jobs, settings) => buildLiveOpts(jobs, cachedEntries(), settings, todayISO());
/* a phased job's phases laid out against reality — same lens as the board */
function liveRowsOf(j, settings) {
  if (!(j.subtasks || []).some((st) => (st.crewIds || []).length || st.name) || !j.startDate) return null;
  return layoutSubtasksLive(j, j.startDate, settings,
    phaseActuals(j, scopedEntriesOfJob(j, cachedEntries()), settings), todayISO());
}
/* the roster a day's override applies against: the phase REALLY active that
   day for phase-staffed jobs (live layout — a delayed phase is still active),
   otherwise the job's own crew; assignment spans filter either way
   (mirrors board.js jobSlotOn + baseCrewOn) */
function baseCrewOn(j, day, settings) {
  let base = (j.crewIds || []).slice();
  const L = (j.subtasks || []).some((st) => (st.crewIds || []).length) ? liveRowsOf(j, settings) : null;
  if (L) {
    let act = L.find((x) => day >= x.start && day <= x.finish);
    if (!act) act = [...L].reverse().find((x) => x.start <= day) || L[L.length - 1];
    if (act) base = (act.sub.crewIds || []).slice();
  }
  return spanCrew(base, j.crewSpans, day);
}
const onJobThatDay = (j, day, cid, settings) =>
  effCrew(baseCrewOn(j, day, settings), (j.dayCrew || {})[day]).includes(cid);

const snap = (x) => `${x.startDate || ""}|${x.endDate || ""}|${x.targetDate || ""}`;

/* reflow the whole board and persist every job the engine moved; a conflict
   on the PRIMARY job aborts loudly, secondary reflow conflicts self-heal on
   the next pull (the server copy wins — guarded writes never clobber) */
async function reflowAndSave(jobs, before, primary, refresh) {
  const s = cachedSettings();
  try { computeSchedule(jobs, s, liveOpts(jobs, s)); } catch (_) { /* saved dates still work */ }
  const changed = jobs.filter((x) => x.id === primary.id || before.get(x.id) !== snap(x));
  for (const c of changed) {
    const r = await saveJob(c);
    if (r && r.conflict && c.id === primary.id) return { conflict: true };
  }
  if (refresh) refresh();
  return { reflowed: changed.length - 1 };
}
const CONFLICT_MSG = "the board changed on another device — reopen the job and try again";

/* ---- boardWrite: stage / dates / crew / materials / note on one job ---- */
async function boardWrite(params, refresh) {
  const jobs = cachedJobs();                        // fresh throwaway copies (last-synced revs)
  const m = findJob(jobs, params.job);
  if (m.err) return { ok: false, detail: m.err };
  const j = m.hit;
  const before = new Map(jobs.map((x) => [x.id, snap(x)]));
  const did = [];

  // unused optional fields sometimes arrive as "" — treat empty as absent
  if (params.stage) {
    const st = String(params.stage);
    if (!STAGE_IDS.includes(st)) return { ok: false, detail: `stage must be one of ${STAGE_IDS.join(" / ")}` };
    j.stage = st; did.push(`stage → ${st}`);
  }
  if (params.materialStatus) {
    const mt = String(params.materialStatus);
    if (!MATERIAL_IDS.includes(mt)) return { ok: false, detail: `materialStatus must be one of ${MATERIAL_IDS.join(" / ")}` };
    j.materials = mt; did.push(`materials → ${mt}`);
  }
  if (Array.isArray(params.assignedCrew)) {         // [] is legit: "take everyone off"
    const r = resolveCrewNames(params.assignedCrew);
    if (r.err) return { ok: false, detail: r.err };
    j.crewIds = r.ids;
    // drop spans only for members leaving the job — a continuing member's
    // deliberate date window (Crew board "This day on") survives a routine
    // crew edit; removed members' spans are dead keys
    if (j.crewSpans) {
      for (const k of Object.keys(j.crewSpans)) if (!r.ids.includes(k)) delete j.crewSpans[k];
      if (!Object.keys(j.crewSpans).length) delete j.crewSpans;
    }
    did.push(`crew → ${r.members.map((c) => c.name).join(", ") || "nobody"}`);
  }
  if (params.notes) {
    const line = `[${todayISO()}] ${String(params.notes).slice(0, 400)}`;
    j.notes = j.notes ? `${j.notes}\n${line}` : line;
    did.push("note added");
  }
  const start = params.startDate ? isoOr(params.startDate) : "";
  if (params.startDate && !start) return { ok: false, detail: "startDate must be a YYYY-MM-DD date" };
  const target = params.targetDate ? isoOr(params.targetDate) : "";
  if (params.targetDate && !target) return { ok: false, detail: "targetDate must be a YYYY-MM-DD date" };
  if (start) { j.scheduleMode = "manual"; j.pinnedStart = start; did.push(`starts ${start}`); }
  if (target) {
    const from = start || j.startDate;
    if (from && target < from) return { ok: false, detail: `targetDate ${target} is before the start ${from}` };
    if (from) j.durationDays = workDaysBetween(from, target, cachedSettings());
    j.targetDate = target;                          // sticks directly on undated leads
    did.push(`target ${target}`);
  }
  if (!did.length) return { ok: false, detail: "nothing to change — give at least one field" };

  const r = await reflowAndSave(jobs, before, j, refresh);
  if (r.conflict) return { ok: false, detail: CONFLICT_MSG };
  return {
    ok: true,
    detail: `${jobName(j)}: ${did.join("; ")}` +
      (r.reflowed > 0 ? ` (+${r.reflowed} linked job${r.reflowed === 1 ? "" : "s"} reflowed)` : ""),
  };
}

/* ---- jobCreate: stand up a new board job ---- */
async function jobCreate(params, refresh) {
  const insured = String(params.insured || "").trim().slice(0, 80);
  const address = String(params.address || "").trim().slice(0, 160);
  let type = String(params.lossType || "").trim().toLowerCase();
  if (type === "rebuild") type = "remodel";         // spec alias → board type id
  if (!insured || !address) return { ok: false, detail: "need at least the insured's name and the property address" };
  if (!TYPE_IDS.includes(type)) return { ok: false, detail: `lossType must be one of ${TYPE_IDS.join(" / ")}` };
  const start = params.startDate ? isoOr(params.startDate) : "";
  if (params.startDate && !start) return { ok: false, detail: "startDate must be a YYYY-MM-DD date" };
  const target = params.targetDate ? isoOr(params.targetDate) : "";
  if (params.targetDate && !target) return { ok: false, detail: "targetDate must be a YYYY-MM-DD date" };
  if (start && target && target < start) return { ok: false, detail: `targetDate ${target} is before startDate ${start}` };
  let crewIds = [], crewNames = [];
  if (Array.isArray(params.assignedCrew)) {
    const r = resolveCrewNames(params.assignedCrew);
    if (r.err) return { ok: false, detail: r.err };
    crewIds = r.ids; crewNames = r.members.map((c) => c.name);
  }

  const j = {                                       // mirrors the job modal's new-job template
    id: uid(), stage: start ? "scheduled" : "lead", type, priority: "normal", materials: "none",
    crewIds, title: `${insured} — ${type.replace("_", " ")}`, customer: insured, address, phone: "",
    startDate: "", targetDate: target, estimatedHours: "", fieldJobId: "",
    notes: String(params.notes || "").slice(0, 500),
    contractValue: "", billedToDate: "",
    deps: [], durationDays: null, scheduleMode: start ? "manual" : "auto", pinnedStart: start,
    notBefore: "", notBeforeLabel: "", subtasks: [], isMilestone: false,
  };
  if (start && target) j.durationDays = workDaysBetween(start, target, cachedSettings());

  if (start) {                                      // dated → let the engine place it + reflow
    const jobs = [...cachedJobs(), j];
    const before = new Map(jobs.map((x) => [x.id, snap(x)]));
    const r = await reflowAndSave(jobs, before, j, refresh);
    if (r.conflict) return { ok: false, detail: CONFLICT_MSG };
  } else {                                          // undated lead → save as-is, no reflow
    const r = await saveJob(j);
    if (r && r.conflict) return { ok: false, detail: CONFLICT_MSG };
    if (refresh) refresh();
  }
  return {
    ok: true,
    detail: `created ${jobName(j)} (${j.stage}${j.startDate ? `, starts ${j.startDate}` : ""}` +
      `${crewNames.length ? `, crew: ${crewNames.join(", ")}` : ""})`,
  };
}

/* ---- crewAvailabilityWrite: block/restore days, freeing job slots like the
   Crew board's "Out today" column (outDays flag + per-day dayCrew override) ---- */
async function crewAvailabilityWrite(params, refresh) {
  if (typeof params.available !== "boolean")
    return { ok: false, detail: "available must be true (restore) or false (block)" };
  const cm = findCrew(cachedCrew(), params.crewMember ?? params.crew);
  if (cm.err) return { ok: false, detail: cm.err };
  const c = cm.hit;
  const days = listDays(String(params.startDate || ""), String(params.endDate || ""));
  if (!days.length) return { ok: false, detail: "startDate and endDate must be YYYY-MM-DD dates (up to ~3 months)" };

  const settings = cachedSettings();
  const jobs = cachedJobs();
  const mark = new Map(jobs.map((x) => [x.id, JSON.stringify(x.dayCrew || null)]));
  const set = new Set(c.outDays || []);
  let slotDays = 0;
  for (const day of days) {
    if (!params.available) {
      set.add(day);
      for (const j of jobs) {                       // free every slot they held that day
        if (j.isMilestone || !jobActiveOn(j, day)) continue;
        if (onJobThatDay(j, day, c.id, settings)) { dayCrewPull(j, day, c.id, baseCrewOn(j, day, settings)); slotDays++; }
      }
    } else {
      set.delete(day);
      for (const j of jobs) {                       // undo only absences this flow recorded
        if ((((j.dayCrew || {})[day] || {}).remove || []).includes(c.id)) {
          dayCrewPush(j, day, c.id, baseCrewOn(j, day, settings)); slotDays++;
        }
      }
    }
  }
  c.outDays = [...set].sort();
  await saveCrewMember(c);
  const touched = jobs.filter((x) => mark.get(x.id) !== JSON.stringify(x.dayCrew || null));
  for (const t of touched) await saveJob(t);        // guarded; a stale copy never clobbers
  if (refresh) refresh();

  const span = days.length === 1 ? days[0] : `${days[0]} → ${days[days.length - 1]}`;
  return {
    ok: true,
    detail: `${c.name} ${params.available ? "available again" : "out"} ${span}` +
      `${params.reason ? ` (${String(params.reason).slice(0, 40)})` : ""}` +
      `${slotDays ? ` — ${slotDays} job-day slot${slotDays === 1 ? "" : "s"} ${params.available ? "restored" : "freed"}` : ""}`,
  };
}

/* ---- crewSwap: move guys between jobs for ONE day (dayCrew override) ---- */
async function crewSwap(params, refresh) {
  const date = isoOr(params.date);
  if (!date) return { ok: false, detail: "date must be a YYYY-MM-DD date" };
  const jobs = cachedJobs();
  const fm = findJob(jobs, params.fromJob);
  if (fm.err) return { ok: false, detail: fm.err };
  const tm = findJob(jobs, params.toJob);
  if (tm.err) return { ok: false, detail: tm.err };
  if (fm.hit.id === tm.hit.id) return { ok: false, detail: "fromJob and toJob match the same job" };
  const r = resolveCrewNames(params.crewMembers);
  if (r.err) return { ok: false, detail: r.err };
  if (!r.ids.length) return { ok: false, detail: "who's moving? crewMembers is empty" };

  const s = cachedSettings();
  const from = fm.hit, to = tm.hit;
  // "forward" = from this day through the end of each job (assignment spans —
  // the Crew board's "This day on" scope); default = that ONE day only
  const forward = params.scope === "forward" || params.scope === "fromDayOn";
  if (!forward) {
    // a day-scoped swap only means something while both jobs are running that day
    if (!jobActiveOn(from, date)) return { ok: false, detail: `${jobName(from)} isn't running on ${date}` };
    if (!jobActiveOn(to, date)) return { ok: false, detail: `${jobName(to)} isn't running on ${date} — pin its dates first (boardWrite)` };
  } else if (to.targetDate && to.targetDate < date) {
    return { ok: false, detail: `${jobName(to)} already ends ${to.targetDate} — nothing left to join from ${date}` };
  }
  const notOn = r.members.filter((c) => !onJobThatDay(from, date, c.id, s) && !(forward && (from.crewIds || []).includes(c.id)));
  if (notOn.length)
    return { ok: false, detail: `${notOn.map((c) => c.name).join(", ")} ${notOn.length === 1 ? "isn't" : "aren't"} on ${jobName(from)} that day` };

  const before = new Map(jobs.map((x) => [x.id, snap(x)]));
  for (const c of r.members) {
    if (forward) {
      spanCrewPull(from, date, c.id);
      spanCrewPush(to, date, c.id, s, liveRowsOf(to, s));
    } else {
      dayCrewPull(from, date, c.id, baseCrewOn(from, date, s));
      dayCrewPush(to, date, c.id, baseCrewOn(to, date, s));
    }
  }
  const r1 = await saveJob(from);
  if (r1 && r1.conflict) return { ok: false, detail: CONFLICT_MSG };
  const r2 = await saveJob(to);
  if (r2 && r2.conflict)
    return { ok: false, detail: `${jobName(from)} updated, but ${jobName(to)} changed on another device — redo the swap` };
  if (forward) await reflowAndSave(jobs, before, from, refresh);   // crew change re-sizes remaining work
  else if (refresh) refresh();
  return { ok: true, detail: `${r.members.map((c) => c.name).join(", ")} → ${jobName(to)} ${forward ? `from ${date} through the end (from ${jobName(from)}; their days already worked stay)` : `for ${date} (from ${jobName(from)}; that day only)`}` };
}

/* ---- hoursWrite: time entry + running job total ---- */
async function hoursWrite(params) {
  const hours = Number(params.hours);
  if (!(hours > 0 && hours <= 24)) return { ok: false, detail: "hours must be between 0 and 24" };
  const jm = findJob(cachedJobs(), params.job);
  if (jm.err) return { ok: false, detail: jm.err };
  const cm = findCrew(cachedCrew(), params.crewMember ?? params.crew);
  if (cm.err) return { ok: false, detail: cm.err };
  const date = isoOr(params.date) || todayISO();
  const trade = String(params.trade || "").slice(0, 40);
  // optionally pin the hours to a named phase (else the engine auto-places
  // them by date + phase completions, same as QuickBooks Time rows)
  let phaseId = "", phaseName = "";
  if (params.phase) {
    const pm = matchOne((jm.hit.subtasks || []).filter((st) => st && st.name), params.phase, (st) => [String(st.name || "")], "phase");
    if (pm.err) return { ok: false, detail: pm.err };
    phaseId = pm.hit.id; phaseName = pm.hit.name;
  }
  await saveTimeEntry({
    id: uid(), jobId: jm.hit.id, crewId: cm.hit.id, date, hours,
    ...(trade ? { trade } : {}),
    ...(phaseId ? { phaseId } : {}),
    note: String(params.notes ?? params.note ?? "").slice(0, 200), enteredBy: currentEmail(),
  });
  // the SAME hour join the board cards use (manual + linked QB, hoursFrom scoped)
  const total = scopedEntriesOfJob(jm.hit, cachedEntries())
    .reduce((a, e) => a + (Number(e.hours) || 0), 0);
  return {
    ok: true,
    detail: `${hours}h — ${cm.hit.name} on ${jobName(jm.hit)} (${date}${trade ? `, ${trade}` : ""}${phaseName ? `, phase: ${phaseName}` : ""})` +
      ` · job total ${Math.round(total * 10) / 10}h`,
  };
}

/* ---- phaseUpdate: mark a phase done / reopen it — THE write that moves the
   real schedule (a done phase stops sliding; successors and every linked
   job re-flow from its completion date) ---- */
async function phaseUpdate(params, refresh) {
  const jobs = cachedJobs();
  const m = findJob(jobs, params.job);
  if (m.err) return { ok: false, detail: m.err };
  const j = m.hit;
  const subs = (j.subtasks || []).filter((st) => st && st.name);
  if (!subs.length) return { ok: false, detail: `${jobName(j)} has no phases` };
  const pm = matchOne(subs, params.phase, (st) => [String(st.name || "")], "phase");
  if (pm.err) return { ok: false, detail: pm.err };
  const st = pm.hit;
  const done = params.done !== false;
  if (done && params.completedOn && !isoOr(params.completedOn))
    return { ok: false, detail: "completedOn must be a YYYY-MM-DD date" };
  const before = new Map(jobs.map((x) => [x.id, snap(x)]));
  if (done) { st.done = true; st.completedOn = isoOr(params.completedOn) || todayISO(); }
  else { st.done = false; delete st.completedOn; }
  const r = await reflowAndSave(jobs, before, j, refresh);
  if (r.conflict) return { ok: false, detail: CONFLICT_MSG };
  return {
    ok: true,
    detail: `${jobName(j)}: ${st.name} ${done ? `marked done (${st.completedOn})` : "reopened"} — projected finish now ${j.targetDate || "unset"}` +
      (r.reflowed > 0 ? ` (+${r.reflowed} linked job${r.reflowed === 1 ? "" : "s"} reflowed)` : ""),
  };
}

/** The board provider's executeAction — see mountAssistProvider(). */
export function runBoardAction(a, refresh) {
  const p = (a && a.params) || {};
  switch (a && a.type) {
    case "sendText": return assistSend({ to: p.to, message: p.message, audience: p.audience, by: "board" });
    case "boardWrite": return boardWrite(p, refresh);
    case "jobCreate": return jobCreate(p, refresh);
    case "crewAvailabilityWrite": return crewAvailabilityWrite(p, refresh);
    case "crewSwap": return crewSwap(p, refresh);
    case "hoursWrite": return hoursWrite(p);
    case "phaseUpdate": return phaseUpdate(p, refresh);
    // legacy chip names (proposals still sitting in open transcripts)
    case "moveJob": return boardWrite({ job: p.job, startDate: p.newStart }, refresh);
    case "logHours": return hoursWrite(p);
    default: return { ok: false, detail: "not available on the board" };
  }
}
