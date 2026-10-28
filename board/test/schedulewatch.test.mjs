/* Schedule Watch — pure rule checks (no DOM, no network).
   Run: node apps/board/test/schedulewatch.test.mjs

   Calendar reference: 2026-06-15 Mon · 16 Tue · 17 Wed · 18 Thu · 19 Fri */
import assert from "node:assert/strict";
import { scheduleFlags, watchable } from "../js/schedulewatch.js";

const S = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [] };
const TODAY = "2026-06-17";
const job = (o) => ({ id: "j1", stage: "in_progress", deps: [], crewIds: [], subtasks: [], ...o });
const qb = (date, hours, jc = "77") => ({ source: "qbtime", qbJobcodeId: jc, date, hours });
const kinds = (flags) => flags.map((f) => f.kind);

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); console.log("  ✓ " + name); pass++; } catch (e) { console.log("  ✗ " + name + "\n    " + (e && e.message)); fail++; } }

test("unlinked live job -> no-jobcode (bad), and no-hours stays quiet (one flag per root cause)", () => {
  const f = scheduleFlags(job({ startDate: "2026-06-15", targetDate: "2026-06-19" }), [], TODAY, S);
  assert.deepEqual(kinds(f), ["no-jobcode"]);
  assert.equal(f[0].tone, "bad");
});

test("linked but silent: started before today, zero scoped entries -> no-hours (bad)", () => {
  const j = job({ qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19" });
  const f = scheduleFlags(j, [], TODAY, S);
  assert.deepEqual(kinds(f), ["no-hours"]);
  assert.equal(f[0].tone, "bad");
});

test("hours on ANOTHER jobcode don't count — the one join rule decides", () => {
  const j = job({ qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19" });
  const f = scheduleFlags(j, [qb("2026-06-15", 8, "88")], TODAY, S);
  assert.deepEqual(kinds(f), ["no-hours"]);
});

test("QB hours on the linked jobcode, or manual hours by jobId, silence no-hours", () => {
  const j = job({ qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19" });
  assert.deepEqual(scheduleFlags(j, [qb("2026-06-15", 8)], TODAY, S), []);
  assert.deepEqual(scheduleFlags(j, [{ jobId: "j1", date: "2026-06-15", hours: 4 }], TODAY, S), []);
});

test("hoursFrom scopes old hours OUT — a rebuild sharing its jobcode still flags", () => {
  const j = job({ qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19", hoursFrom: "2026-06-15" });
  const f = scheduleFlags(j, [qb("2026-06-01", 40)], TODAY, S);   // mitigation-era hours only
  assert.deepEqual(kinds(f), ["no-hours"]);
  assert.deepEqual(scheduleFlags(j, [qb("2026-06-01", 40), qb("2026-06-16", 6)], TODAY, S), []);
});

test("shared jobcode with NO hoursFrom: pre-start hours neither silence no-hours nor fake phase progress", () => {
  // the coordinator forgot hoursFrom — months of mitigation hours ride the jobcode
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19",
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 40 }],
  });
  const f = scheduleFlags(j, [qb("2026-04-01", 80), qb("2026-05-10", 70)], TODAY, S);
  assert.deepEqual(kinds(f), ["no-hours"]);   // the REAL gap — not a day-one "Demo looks finished"
});

test("started TODAY or in the future -> no no-hours (nightly QB pull hasn't run yet)", () => {
  assert.deepEqual(scheduleFlags(job({ qbJobcodeId: "77", startDate: TODAY }), [], TODAY, S), []);
  assert.deepEqual(scheduleFlags(job({ qbJobcodeId: "77", startDate: "2026-06-22" }), [], TODAY, S), []);
});

test("zero-hour entries are not 'hours landed'", () => {
  const j = job({ qbJobcodeId: "77", startDate: "2026-06-15" });
  assert.deepEqual(kinds(scheduleFlags(j, [qb("2026-06-15", 0)], TODAY, S)), ["no-hours"]);
});

test("phase at/over its estimate but still open -> unmarked-done (warn) carrying the phase id", () => {
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19",
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 10 }],
  });
  const f = scheduleFlags(j, [{ jobId: "j1", phaseId: "p1", date: "2026-06-15", hours: 11 }], TODAY, S);
  assert.deepEqual(kinds(f), ["unmarked-done"]);
  assert.equal(f[0].tone, "warn");
  assert.equal(f[0].subId, "p1");
  assert.equal(f[0].subName, "Demo");
});

test("unmarked-done carries lastHoursOn — the last day hours landed on THAT phase, not today", () => {
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19",
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 10 }, { id: "p2", name: "Paint", estimatedHours: 40 }],
  });
  const entries = [
    { jobId: "j1", phaseId: "p1", date: "2026-06-15", hours: 6 },
    { jobId: "j1", phaseId: "p1", date: "2026-06-16", hours: 6 },   // Demo's real last day
    { jobId: "j1", phaseId: "p2", date: "2026-06-17", hours: 8 },   // successor hours — must not move it
  ];
  const f = scheduleFlags(j, entries, "2026-06-19", S);
  assert.deepEqual(f.map((x) => [x.kind, x.subId, x.lastHoursOn]), [["unmarked-done", "p1", "2026-06-16"]]);
});

test("hoursBySub override: the engine's own attribution decides unmarked-done when provided", () => {
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15",
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 10 }, { id: "p2", name: "Paint", estimatedHours: 10 }],
  });
  const entries = [qb("2026-06-15", 12)];   // no phaseId — window-attributed
  const engineSays = new Map([["p1", 0], ["p2", 12]]);   // what the Gantt bars show
  const f = scheduleFlags(j, entries, TODAY, S, engineSays);
  assert.deepEqual(f.map((x) => [x.kind, x.subId]), [["unmarked-done", "p2"]]);
});

test("a DONE phase at/over estimate is never flagged; a later open one at estimate is", () => {
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15", targetDate: "2026-06-19",
    subtasks: [
      { id: "p1", name: "Demo", estimatedHours: 10, done: true, completedOn: "2026-06-15" },
      { id: "p2", name: "Dry", estimatedHours: 8 },
    ],
  });
  const entries = [
    { jobId: "j1", phaseId: "p1", date: "2026-06-15", hours: 12 },
    { jobId: "j1", phaseId: "p2", date: "2026-06-16", hours: 8 },
  ];
  const f = scheduleFlags(j, entries, TODAY, S);
  assert.deepEqual(f.map((x) => [x.kind, x.subId]), [["unmarked-done", "p2"]]);
});

test("a phase under estimate, or with no estimate, is never unmarked-done", () => {
  const j = job({
    qbJobcodeId: "77", startDate: "2026-06-15",
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 10 }, { id: "p2", name: "Punch" }],
  });
  const f = scheduleFlags(j, [{ jobId: "j1", phaseId: "p1", date: "2026-06-15", hours: 5 },
                              { jobId: "j1", phaseId: "p2", date: "2026-06-16", hours: 30 }], TODAY, S);
  assert.deepEqual(f, []);
});

test("lead / done / archived / milestone / on-hold jobs are ignored entirely", () => {
  for (const o of [{ stage: "lead" }, { stage: "done" }, { stage: "on_hold" }, { archived: true }, { isMilestone: true }]) {
    const j = job({ startDate: "2026-06-01", ...o });   // unlinked + started long ago
    assert.deepEqual(scheduleFlags(j, [], TODAY, S), [], JSON.stringify(o));
    assert.equal(watchable(j), false, "watchable " + JSON.stringify(o));
  }
  assert.equal(watchable(job({})), true);
  assert.equal(watchable(null), false);
});

test("manual-entry-only job (no QB link) with hours flowing: no red chip — its hours DO move the schedule", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19" });   // no qbJobcodeId
  assert.deepEqual(scheduleFlags(j, [{ jobId: "j1", date: "2026-06-15", hours: 6 }], TODAY, S), []);
  // …but an unlinked job whose only hours PREDATE the start is still blind
  assert.deepEqual(kinds(scheduleFlags(j, [{ jobId: "j1", date: "2026-06-01", hours: 6 }], TODAY, S)), ["no-jobcode"]);
});

test("null entries = 'couldn't look': hours-dependent flags stay quiet, no-jobcode still shows", () => {
  // unlinked job: no-jobcode is judgeable without hours
  assert.deepEqual(kinds(scheduleFlags(job({ startDate: "2026-06-15" }), null, TODAY, S)), ["no-jobcode"]);
  // linked, started job: with entries unreadable, NO false "0h since start"
  assert.deepEqual(scheduleFlags(job({ qbJobcodeId: "77", startDate: "2026-06-15" }), null, TODAY, S), []);
  const phased = job({ qbJobcodeId: "77", startDate: "2026-06-15", subtasks: [{ id: "p1", name: "Demo", estimatedHours: 1 }] });
  assert.deepEqual(scheduleFlags(phased, undefined, TODAY, S), []);
});

console.log(`\nschedulewatch: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
