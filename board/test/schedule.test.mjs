/* Engine tests for the Job Board scheduler (pure module, no DOM).
   Run: node apps/board/test/schedule.test.mjs   (or: npm test --workspace=apps/board)

   Calendar reference (so the date math below is readable):
     2026-06-12 Fri · 13 Sat · 14 Sun · 15 Mon · 16 Tue · 17 Wed · 18 Thu · 19 Fri · 22 Mon */
import assert from "node:assert/strict";
import {
  isWorkDay, addWorkDays, workDaysBetween, durationOf, durationFracOf,
  layoutSubtasks, computeSchedule, effCrew, crewDayLoad, findOverAllocations,
  wouldCreateCycle, computeCriticalPath, linkComponents, computeCfoSnapshot, DEFAULT_SETTINGS,
  listDays, dayCrewPull, dayCrewPush,
  spanActive, spanCrew, spanCrewPull, spanCrewPush, spanCrewClear,
  phaseActuals, layoutSubtasksLive,
} from "../js/schedule.js";

const S = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [] };
const job = (o) => ({ deps: [], crewIds: [], ...o });

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); console.log("  ✓ " + name); pass++; } catch (e) { console.log("  ✗ " + name + "\n    " + (e && e.message)); fail++; } }
function group(name) { console.log("\n" + name); }

group("work calendar");
test("isWorkDay: weekday yes, weekend no", () => {
  assert.equal(isWorkDay("2026-06-15", S), true);   // Mon
  assert.equal(isWorkDay("2026-06-13", S), false);  // Sat
  assert.equal(isWorkDay("2026-06-14", S), false);  // Sun
});
test("isWorkDay: holiday is not a work day", () => {
  assert.equal(isWorkDay("2026-06-16", { ...S, holidays: ["2026-06-16"] }), false);
});
test("addWorkDays skips the weekend", () => {
  assert.equal(addWorkDays("2026-06-19", 1, S), "2026-06-22");   // Fri +1 -> Mon
  assert.equal(addWorkDays("2026-06-15", 5, S), "2026-06-22");   // Mon +5 -> next Mon
});
test("addWorkDays(0) snaps a weekend forward to the next work day", () => {
  assert.equal(addWorkDays("2026-06-13", 0, S), "2026-06-15");   // Sat -> Mon
});
test("addWorkDays skips a holiday mid-span", () => {
  assert.equal(addWorkDays("2026-06-16", 1, { ...S, holidays: ["2026-06-17"] }), "2026-06-18"); // skip Wed
});
test("workDaysBetween is an inclusive work-day count", () => {
  assert.equal(workDaysBetween("2026-06-15", "2026-06-19", S), 5);   // Mon..Fri
  assert.equal(workDaysBetween("2026-06-15", "2026-06-22", S), 6);   // weekend excluded
  assert.equal(workDaysBetween("2026-06-12", "2026-06-12", S), 1);
});

group("durations");
test("durationOf: manual override wins", () => assert.equal(durationOf(job({ durationDays: 3 }), S), 3));
test("durationOf: from hours / (crew x hpd), min 1", () => {
  assert.equal(durationOf(job({ estimatedHours: 80, crewIds: ["a", "b"] }), S), 4); // 80/(2*10)
  assert.equal(durationOf(job({ estimatedHours: 5, crewIds: ["a"] }), S), 1);       // rounds up, min 1
});
test("durationOf: falls back to existing span, else 1", () => {
  assert.equal(durationOf(job({ startDate: "2026-06-15", targetDate: "2026-06-19" }), S), 5);
  assert.equal(durationOf(job({}), S), 1);
});
test("durationFracOf: fractional, no rounding", () => {
  assert.equal(durationFracOf({ estimatedHours: 5, crewIds: ["a"] }, S), 0.5);
  assert.equal(durationFracOf({ durationDays: 2 }, S), 2);
  assert.equal(durationFracOf({}, S), 1);
});

group("computeSchedule — dependencies cascade");
test("Finish-to-Start: successor starts the next work day", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "A", type: "FS", lagDays: 0 }] });
  computeSchedule([A, B], S);
  assert.equal(A.targetDate, "2026-06-15");
  assert.equal(B.startDate, "2026-06-16");   // day after A
});
test("FS + lag adds calendar days", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "A", type: "FS", lagDays: 2 }] });
  computeSchedule([A, B], S);
  assert.equal(B.startDate, "2026-06-18");   // 6/15 +1 +2 = 6/18 (Thu)
});
test("a dependency landing on a weekend rolls to Monday", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-19", durationDays: 1 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "A", type: "FS", lagDays: 0 }] });
  computeSchedule([A, B], S);
  assert.equal(B.startDate, "2026-06-22");   // Fri finish -> Mon start
});
test("multiple predecessors: start after the latest finishes", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const C = job({ id: "C", scheduleMode: "manual", pinnedStart: "2026-06-17", durationDays: 1 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "A", type: "FS" }, { predId: "C", type: "FS" }] });
  computeSchedule([A, C, B], S);
  assert.equal(B.startDate, "2026-06-18");   // after C (the later one)
});
test("moving a pinned predecessor re-flows its successor", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "A", type: "FS" }] });
  computeSchedule([A, B], S);
  assert.equal(B.startDate, "2026-06-16");
  A.pinnedStart = "2026-06-22";              // slip A a week
  computeSchedule([A, B], S);
  assert.equal(B.startDate, "2026-06-23");   // B followed
});
test("cycles don't hang and are reported", () => {
  const A = job({ id: "A", scheduleMode: "auto", durationDays: 1, startDate: "2026-06-15", deps: [{ predId: "B", type: "FS" }] });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 1, startDate: "2026-06-15", deps: [{ predId: "A", type: "FS" }] });
  const res = computeSchedule([A, B], S);
  assert.ok(Array.isArray(res.cyclic) && res.cyclic.length >= 1);
});
test("a milestone is zero-duration (start === finish)", () => {
  const M = job({ id: "M", isMilestone: true, scheduleMode: "manual", pinnedStart: "2026-06-16" });
  computeSchedule([M], S);
  assert.equal(M.startDate, "2026-06-16");
  assert.equal(M.targetDate, "2026-06-16");
});

group("crew — overrides, load, conflicts");
test("effCrew applies an add/remove override with no duplicates", () => {
  assert.deepEqual(effCrew(["a", "b"], null), ["a", "b"]);
  assert.deepEqual(effCrew(["a", "b"], { remove: ["a"] }), ["b"]);
  assert.deepEqual(effCrew(["a", "b"], { add: ["c"] }), ["a", "b", "c"]);
  assert.deepEqual(effCrew(["a", "b"], { add: ["b"] }), ["a", "b"]);
  assert.deepEqual(effCrew(["a", "b"], { remove: ["a"], add: ["c"] }), ["b", "c"]);
});
test("crewDayLoad spreads hours across the job's work days", () => {
  const A = job({ id: "A", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 });
  const { load } = crewDayLoad([A], S);
  assert.equal(Math.round(load.get("m").get("2026-06-17")), 10);  // 50h / 5 days
});
test("two concurrent jobs over the same shift flag an over-allocation", () => {
  const a = job({ id: "A", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 });
  const b = job({ id: "B", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 });
  const { load } = crewDayLoad([a, b], S);
  assert.equal(Math.round(load.get("m").get("2026-06-17")), 20);  // double-booked
  const over = findOverAllocations([a, b], S);
  assert.ok(over.overloads.length > 0);
  assert.equal(over.overloads[0].pct, 200);
});
test("a per-day crew override changes only that day's load", () => {
  const a = job({ id: "A", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 });
  const b = job({ id: "B", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50, dayCrew: { "2026-06-17": { add: [], remove: ["m"] } } });
  const { load } = crewDayLoad([a, b], S);
  assert.equal(Math.round(load.get("m").get("2026-06-17")), 10);  // off job B just that day
  assert.equal(Math.round(load.get("m").get("2026-06-16")), 20);  // other days unchanged
});

group("phases");
test("layoutSubtasks packs small phases into the same day", () => {
  const subs = [{ estimatedHours: 5, crewIds: ["a"] }, { estimatedHours: 5, crewIds: ["a"] }];
  const L = layoutSubtasks(subs, "2026-06-15", S);
  assert.equal(L[0].start, "2026-06-15");
  assert.equal(L[1].start, "2026-06-15");   // packed, not pushed to the next day
  assert.equal(L[0].durFrac, 0.5);
  assert.equal(L[1].offFrac, 0.5);
});
test("a phase lag pushes it to a later whole day", () => {
  const subs = [{ estimatedHours: 5, crewIds: ["a"] }, { estimatedHours: 5, crewIds: ["a"], lagDays: 1 }];
  const L = layoutSubtasks(subs, "2026-06-15", S);
  assert.equal(L[1].start, "2026-06-17");   // finish day 1, +1 lag day
});

group("cycle guard");
test("wouldCreateCycle catches a back-edge and self-link", () => {
  const A = job({ id: "A", deps: [{ predId: "B", type: "FS" }] });
  const B = job({ id: "B", deps: [] });
  assert.equal(wouldCreateCycle("B", "A", [A, B]), true);   // A already depends on B
  assert.equal(wouldCreateCycle("A", "A", [A, B]), true);   // self
  assert.equal(wouldCreateCycle("A", "B", [job({ id: "A" }), job({ id: "B" })]), false);
});

group("critical path — per project");
test("linkComponents groups linked jobs and isolates standalone ones", () => {
  const A = job({ id: "A" }), B = job({ id: "B", deps: [{ predId: "A", type: "FS" }] }), C = job({ id: "C" });
  const comp = linkComponents([A, B, C]);
  assert.equal(comp.get("A"), comp.get("B"));   // linked → same project
  assert.notEqual(comp.get("A"), comp.get("C")); // standalone → its own project
});
test("each independent chain lights up its own critical path", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 2 });
  const B = job({ id: "B", scheduleMode: "auto", durationDays: 2, deps: [{ predId: "A", type: "FS" }] });
  const C = job({ id: "C", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const D = job({ id: "D", scheduleMode: "auto", durationDays: 1, deps: [{ predId: "C", type: "FS" }] });
  const E = job({ id: "E", scheduleMode: "manual", pinnedStart: "2026-06-15", durationDays: 1 });
  const jobs = [A, B, C, D, E];
  computeSchedule(jobs, S);
  const crit = computeCriticalPath(jobs, S);
  assert.ok(crit.has("A") && crit.has("B"));   // chain 1
  assert.ok(crit.has("C") && crit.has("D"));   // chain 2 (earlier finish) still lights up
  assert.ok(!crit.has("E"));                    // a lone job is no critical path
});

group("CFO snapshot — the daily report read");
test("Block A: starts/ends inside the horizon, done jobs excluded", () => {
  const today = "2026-06-15";
  const jobs = [
    job({ id: "S", title: "Birch Ln", stage: "scheduled", startDate: "2026-06-17", targetDate: "2026-06-19", crewIds: ["m"] }),
    job({ id: "E", title: "Honeybee", stage: "in_progress", startDate: "2026-06-10", targetDate: "2026-06-18" }),
    job({ id: "F", title: "Old Job", stage: "done", startDate: "2026-06-16", targetDate: "2026-06-16" }),
    job({ id: "L", title: "Far Off", stage: "scheduled", startDate: "2026-08-01", targetDate: "2026-08-10" }),
  ];
  const snap = computeCfoSnapshot(jobs, [], S, today, 7);
  assert.deepEqual(snap.startingSoon.map((x) => x.id), ["S"]);   // E started already, L too far, F done
  assert.deepEqual(snap.endingSoon.map((x) => x.id), ["E", "S"]); // sorted by finish date: E 6/18 before S 6/19
});
test("Block B: idle vs booked crew + over-allocation in window", () => {
  const today = "2026-06-15";
  const roster = [{ id: "m", name: "Mike", active: true, hourlyRate: 45 }, { id: "z", name: "Zoe", active: true }];
  const jobs = [
    job({ id: "A", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 }),
    job({ id: "B", startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["m"], estimatedHours: 50 }),
  ];
  const snap = computeCfoSnapshot(jobs, roster, S, today, 7);
  assert.deepEqual(snap.crew.idle.map((c) => c.id), ["z"]);      // Zoe unbooked
  assert.deepEqual(snap.crew.booked.map((c) => c.id), ["m"]);    // Mike booked
  assert.ok(snap.crew.overAllocations.length > 0);               // Mike double-booked
  assert.ok(snap.crew.laborCostWindow > 0);                      // rate present → run-rate computed
});
test("Block C: overdue + material-blocked near-start", () => {
  const today = "2026-06-15";
  const jobs = [
    job({ id: "O", title: "Late Job", stage: "in_progress", targetDate: "2026-06-10" }),   // 3 work? -> overdue
    job({ id: "H", title: "Paused", stage: "on_hold", targetDate: "2026-06-30" }),
    job({ id: "M", title: "Shop", stage: "scheduled", startDate: "2026-06-17", materials: "ordered" }),
  ];
  const snap = computeCfoSnapshot(jobs, [], S, today, 7);
  assert.deepEqual(snap.atRisk.overdue.map((x) => x.id), ["O"]);
  assert.deepEqual(snap.atRisk.onHold.map((x) => x.id), ["H"]);
  assert.deepEqual(snap.atRisk.materialBlocked.map((x) => x.id), ["M"]);
});
test("Block D: draw triggers carry uninvoiced dollars, sorted high→low", () => {
  const today = "2026-06-15";
  const jobs = [
    job({ id: "D1", title: "Birch Ln", customer: "Smith", stage: "done", contractValue: 42000, billedToDate: 15000 }),
    job({ id: "D2", title: "Honeybee P2", customer: "Pollen", stage: "final", contractValue: 80000, billedToDate: 80000 }), // fully billed
    job({ id: "D3", title: "Shop", customer: "Jones", stage: "final", contractValue: 30000, billedToDate: 10000 }),
    job({ id: "X", title: "Active", stage: "in_progress", contractValue: 10000 }), // not final/done → ignored
  ];
  const snap = computeCfoSnapshot(jobs, [], S, today, 7);
  assert.deepEqual(snap.drawTriggers.map((x) => x.id), ["D1", "D3"]); // D2 final+fully-billed excluded; X not final/done
  assert.equal(snap.drawTriggers.find((x) => x.id === "D1").uninvoiced, 27000);
  assert.equal(snap.uninvoicedTotal, 47000); // 27k + 20k
});

group("day lists (assistant availability writes)");
test("listDays: inclusive calendar range, order-tolerant", () => {
  assert.deepEqual(listDays("2026-06-13", "2026-06-15"), ["2026-06-13", "2026-06-14", "2026-06-15"]); // weekend included — outDays are calendar days
  assert.deepEqual(listDays("2026-06-15", "2026-06-13"), ["2026-06-13", "2026-06-14", "2026-06-15"]); // swapped bounds
  assert.deepEqual(listDays("2026-06-15", "2026-06-15"), ["2026-06-15"]);
});
test("listDays: malformed dates → empty; runaway ranges are capped", () => {
  assert.deepEqual(listDays("June 15", "2026-06-16"), []);
  assert.deepEqual(listDays("", ""), []);
  assert.equal(listDays("2026-01-01", "2036-01-01").length, 92);   // cap, not a 3650-day array
  assert.equal(listDays("2026-01-01", "2026-01-10", 5).length, 5); // explicit cap wins
});

group("per-day crew override edits (assistant chip core)");
test("dayCrewPull removes a base member for one day; effCrew agrees", () => {
  const j = { id: "J", crewIds: ["a", "b"] };
  dayCrewPull(j, "2026-06-15", "a", ["a", "b"]);
  assert.deepEqual(j.dayCrew["2026-06-15"], { add: [], remove: ["a"] });
  assert.deepEqual(effCrew(["a", "b"], j.dayCrew["2026-06-15"]), ["b"]);
  dayCrewPull(j, "2026-06-15", "a", ["a", "b"]);                   // idempotent
  assert.deepEqual(j.dayCrew["2026-06-15"].remove, ["a"]);
});
test("dayCrewPush adds a non-base member; pushing a base member only clears their remove", () => {
  const j = { id: "J", crewIds: ["a"] };
  dayCrewPush(j, "2026-06-15", "c", ["a"]);
  assert.deepEqual(effCrew(["a"], j.dayCrew["2026-06-15"]), ["a", "c"]);
  dayCrewPull(j, "2026-06-15", "a", ["a"]);
  dayCrewPush(j, "2026-06-15", "a", ["a"]);                        // back on → no add entry, no remove entry
  assert.deepEqual(j.dayCrew["2026-06-15"], { add: ["c"], remove: [] });
  assert.deepEqual(effCrew(["a"], j.dayCrew["2026-06-15"]), ["a", "c"]);
});
test("an undone move leaves no residue (empty deltas are cleaned away)", () => {
  const j = { id: "J", crewIds: ["a"] };
  dayCrewPull(j, "2026-06-15", "a", ["a"]);   // off for the day
  dayCrewPush(j, "2026-06-15", "a", ["a"]);   // changed your mind
  assert.equal(j.dayCrew, undefined);
});
test("a swap day composes: pulled from one job, pushed onto another", () => {
  const from = { id: "F", crewIds: ["m"] }, to = { id: "T", crewIds: [] };
  dayCrewPull(from, "2026-06-16", "m", ["m"]);
  dayCrewPush(to, "2026-06-16", "m", []);
  assert.deepEqual(effCrew(["m"], from.dayCrew["2026-06-16"]), []);
  assert.deepEqual(effCrew([], to.dayCrew["2026-06-16"]), ["m"]);
  assert.equal(from.dayCrew["2026-06-17"], undefined);             // other days untouched
});

group("crew assignment spans (cycling guys through long jobs)");
test("spanActive: no spans = whole run; from/to bound each stint", () => {
  assert.equal(spanActive(null, "2026-06-15"), true);
  assert.equal(spanActive([{ to: "2026-06-16" }], "2026-06-16"), true);
  assert.equal(spanActive([{ to: "2026-06-16" }], "2026-06-17"), false);
  assert.equal(spanActive([{ from: "2026-06-17" }], "2026-06-16"), false);
  assert.equal(spanActive([{ to: "2026-06-15" }, { from: "2026-06-18" }], "2026-06-16"), false);
  assert.equal(spanActive([{ to: "2026-06-15" }, { from: "2026-06-18" }], "2026-06-18"), true);
});
test("spanCrew filters the roster by each member's spans", () => {
  const spans = { a: [{ to: "2026-06-16" }] };
  assert.deepEqual(spanCrew(["a", "b"], spans, "2026-06-16"), ["a", "b"]);
  assert.deepEqual(spanCrew(["a", "b"], spans, "2026-06-17"), ["b"]);
  assert.deepEqual(spanCrew(["a", "b"], null, "2026-06-17"), ["a", "b"]);
});
test("spanCrewPull mid-job: on until the day before, off after", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a", "b"] });
  spanCrewPull(j, "2026-06-17", "a");
  assert.deepEqual(j.crewSpans.a, [{ to: "2026-06-16" }]);
  assert.deepEqual(spanCrew(j.crewIds, j.crewSpans, "2026-06-16"), ["a", "b"]);
  assert.deepEqual(spanCrew(j.crewIds, j.crewSpans, "2026-06-17"), ["b"]);
});
test("spanCrewPush cycles a member back in after a gap", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-22", crewIds: ["a"] });
  spanCrewPull(j, "2026-06-16", "a");                 // off Tue onward
  spanCrewPush(j, "2026-06-18", "a", S);              // back Thu onward
  assert.deepEqual(j.crewSpans.a, [{ to: "2026-06-15" }, { from: "2026-06-18" }]);
  assert.equal(spanActive(j.crewSpans.a, "2026-06-17"), false);
  assert.equal(spanActive(j.crewSpans.a, "2026-06-19"), true);
});
test("push right back onto a pulled day heals to the whole run", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a"] });
  spanCrewPull(j, "2026-06-17", "a");
  spanCrewPush(j, "2026-06-17", "a", S);
  assert.equal(j.crewSpans, undefined);
});
test("spanCrewPush on a NEW member mid-job joins from that day only", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a"] });
  spanCrewPush(j, "2026-06-17", "b", S);
  assert.deepEqual(j.crewIds, ["a", "b"]);
  assert.deepEqual(j.crewSpans.b, [{ from: "2026-06-17" }]);
  assert.deepEqual(spanCrew(j.crewIds, j.crewSpans, "2026-06-16"), ["a"]);
});
test("spanCrewPush on day one keeps the plain whole-run default (no span noise)", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a"] });
  spanCrewPush(j, "2026-06-15", "b", S);
  assert.deepEqual(j.crewIds, ["a", "b"]);
  assert.equal(j.crewSpans, undefined);
});
test("spanCrewPull before the start removes them from the roster cleanly", () => {
  const j = job({ startDate: "2026-06-17", targetDate: "2026-06-19", crewIds: ["a", "b"] });
  spanCrewPull(j, "2026-06-15", "b");
  assert.deepEqual(j.crewIds, ["a"]);
  assert.equal(j.crewSpans, undefined);
});
test("span moves scrub leftover one-day overrides in their window", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a"] });
  dayCrewPush(j, "2026-06-18", "b", []);              // one-day guest Thu
  spanCrewPull(j, "2026-06-17", "b");                 // …then off from Wed on
  assert.equal(j.dayCrew, undefined);
  assert.equal(j.crewSpans, undefined);               // never on the roster → nothing to span
});
test("spanCrewClear returns a member to the whole run", () => {
  const j = job({ startDate: "2026-06-15", targetDate: "2026-06-19", crewIds: ["a"] });
  spanCrewPull(j, "2026-06-17", "a");
  spanCrewClear(j, "a");
  assert.equal(j.crewSpans, undefined);
  assert.deepEqual(spanCrew(j.crewIds, j.crewSpans, "2026-06-18"), ["a"]);
});
test("crewDayLoad splits hours among the crew actually on each day", () => {
  const j = job({ id: "J", startDate: "2026-06-15", targetDate: "2026-06-16", crewIds: ["a", "b"], estimatedHours: 40 });
  spanCrewPull(j, "2026-06-16", "b");                 // b off Tue
  const { load } = crewDayLoad([j], S);
  assert.equal(load.get("a").get("2026-06-15"), 10);  // Mon: 20h split two ways
  assert.equal(load.get("a").get("2026-06-16"), 20);  // Tue: a alone carries it
  assert.equal(load.get("b").get("2026-06-16"), undefined);
});
test("spanCrewPush on a phase-staffed job joins only the phases still running", () => {
  const j = job({
    startDate: "2026-06-15",
    subtasks: [
      { id: "p1", name: "Demo", durationDays: 2, lagDays: 0, crewIds: ["a"] },
      { id: "p2", name: "Build", durationDays: 3, lagDays: 0, crewIds: ["a"] },
    ],
  });
  spanCrewPush(j, "2026-06-17", "b", S);              // Wed = Build's first day
  assert.deepEqual(j.subtasks[0].crewIds, ["a"]);     // finished Demo untouched
  assert.deepEqual(j.subtasks[1].crewIds, ["a", "b"]);
  assert.deepEqual(j.crewSpans.b, [{ from: "2026-06-17" }]);
});

group("phase progress — QB Time actuals drive the schedule");
const ph = (id, o) => ({ id, name: id, lagDays: 0, crewIds: ["a"], ...o });
test("phaseActuals: an explicit entry.phaseId always wins", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [ph("p1", { durationDays: 2 }), ph("p2", { durationDays: 3 })] });
  const hrs = phaseActuals(j, [{ date: "2026-06-15", hours: 6, phaseId: "p2" }], S);
  assert.equal(hrs.get("p1"), 0);
  assert.equal(hrs.get("p2"), 6);
});
test("phaseActuals: completion marks partition history", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [
    ph("p1", { durationDays: 2, done: true, completedOn: "2026-06-16" }), ph("p2", { durationDays: 3 })] });
  const hrs = phaseActuals(j, [
    { date: "2026-06-15", hours: 8 }, { date: "2026-06-16", hours: 8 }, { date: "2026-06-17", hours: 5 }], S);
  assert.equal(hrs.get("p1"), 16);
  assert.equal(hrs.get("p2"), 5);
});
test("phaseActuals: unmarked phases date-match their scheduled windows", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [ph("p1", { durationDays: 2 }), ph("p2", { durationDays: 3 })] });
  const hrs = phaseActuals(j, [
    { date: "2026-06-15", hours: 4 },        // Mon → p1's window
    { date: "2026-06-18", hours: 6 },        // Thu → p2's window
    { date: "2026-06-25", hours: 2 }], S);   // past every window → last open phase started
  assert.equal(hrs.get("p1"), 4);
  assert.equal(hrs.get("p2"), 8);
});
test("layoutSubtasksLive: a phase done EARLY pulls the chain in", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [
    ph("p1", { durationDays: 3, done: true, completedOn: "2026-06-15" }), ph("p2", { durationDays: 2 })] });
  const L = layoutSubtasksLive(j, "2026-06-15", S, new Map(), "2026-06-15");
  assert.equal(L[0].finish, "2026-06-15");
  assert.equal(L[1].start, "2026-06-16");          // plan said Thu; reality says Tue
  assert.equal(L[1].finish, "2026-06-17");
});
test("layoutSubtasksLive: an unfinished phase slides to today and goes late", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [ph("p1", { estimatedHours: 20 }), ph("p2", { estimatedHours: 10 })] });
  const L = layoutSubtasksLive(j, "2026-06-15", S, new Map(), "2026-06-18");   // nobody touched it by Thu
  assert.equal(L[0].start, "2026-06-18");
  assert.equal(L[0].finish, "2026-06-19");
  assert.equal(L[0].late, true);
  assert.equal(L[0].lateDays, 3);                  // planned finish was Tue Jun 16
  assert.equal(L[1].start, "2026-06-22");          // successor pushed past the weekend
});
test("layoutSubtasksLive: remaining hours size an in-progress phase", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [ph("p1", { estimatedHours: 40, crewIds: ["a", "b"] })] });
  const L = layoutSubtasksLive(j, "2026-06-15", S, new Map([["p1", 30]]), "2026-06-17");
  assert.equal(L[0].pct, 75);
  assert.equal(L[0].finish, "2026-06-17");         // 10h left / 2 guys = half a day from today
  assert.equal(L[0].late, true);                   // plan said done Tue
  assert.equal(L[0].lateDays, 1);
});
test("all phases done → the job's real finish is the last completion", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [
    ph("p1", { durationDays: 2, done: true, completedOn: "2026-06-15" }),
    ph("p2", { durationDays: 3, done: true, completedOn: "2026-06-17" })] });
  const L = layoutSubtasksLive(j, "2026-06-15", S, new Map(), "2026-06-22");
  assert.equal(L[1].finish, "2026-06-17");
});
test("computeSchedule(opts): a phase delay cascades into linked jobs", () => {
  const A = job({ id: "A", scheduleMode: "manual", pinnedStart: "2026-06-15",
    subtasks: [ph("p1", { estimatedHours: 20 })] });
  const B = job({ id: "B", scheduleMode: "auto", deps: [{ predId: "A", lagDays: 0 }], durationDays: 2 });
  computeSchedule([A, B], S);                       // pure plan first
  assert.equal(A.targetDate, "2026-06-16");
  assert.equal(B.startDate, "2026-06-17");
  computeSchedule([A, B], S, { today: "2026-06-18", phaseHours: new Map([["A", new Map()]]) });
  assert.equal(A.targetDate, "2026-06-19");         // p1 never started → slid to Thu–Fri
  assert.equal(B.startDate, "2026-06-22");          // linked job pushed past the weekend
});
test("crewDayLoad(live): done phases book nothing; only remaining hours load", () => {
  const j = job({ id: "J", startDate: "2026-06-15", targetDate: "2026-06-19", subtasks: [
    ph("p1", { estimatedHours: 20, done: true, completedOn: "2026-06-16" }),
    ph("p2", { estimatedHours: 30 })] });
  const hours = new Map([["p1", 20], ["p2", 10]]);
  const { load } = crewDayLoad([j], S, { today: "2026-06-17", phaseHours: new Map([["J", hours]]) });
  const a = load.get("a") || new Map();
  assert.equal(a.get("2026-06-15"), undefined);     // done phase: no booked work
  assert.equal(a.get("2026-06-17"), 10);            // 20h remaining over 2 days
  assert.equal(a.get("2026-06-18"), 10);
  assert.equal([...a.values()].reduce((s, x) => s + x, 0), 20);
});

group("integration-review regressions");
test("spanCrewPush with LIVE rows joins a behind-schedule job's phases", () => {
  const j = job({ startDate: "2026-06-01", subtasks: [
    ph("p1", { estimatedHours: 20 }), ph("p2", { estimatedHours: 20 })] });
  // plan says both phases ended weeks ago; reality says p1 is still running —
  // the crew board passes its live rows so the fwd move lands, not no-ops
  const rows = layoutSubtasksLive(j, "2026-06-01", S, new Map([["p1", 5]]), "2026-06-22");
  spanCrewPush(j, "2026-06-22", "b", S, rows);
  assert.ok(j.subtasks[0].crewIds.includes("b"));
  assert.ok(j.subtasks[1].crewIds.includes("b"));
  assert.deepEqual(j.crewSpans.b, [{ from: "2026-06-22" }]);
});
test("layoutSubtasksLive honors a manual durationDays pin over the hours math", () => {
  const j = job({ startDate: "2026-06-15", subtasks: [ph("p1", { durationDays: 5, estimatedHours: 20 })] });
  const L = layoutSubtasksLive(j, "2026-06-15", S, new Map([["p1", 10]]), "2026-06-15");
  assert.equal(L[0].finish, "2026-06-17");    // half the hours logged → half the PINNED 5d remain
});
test("crewDayLoad(live): a no-estimate slid phase books its PLAN workload, from today", () => {
  const j = job({ id: "J", startDate: "2026-06-01", targetDate: "2026-06-30", subtasks: [
    ph("p1", { durationDays: 2, estimatedHours: "" })] });
  const { load } = crewDayLoad([j], S, { today: "2026-06-22", phaseHours: new Map([["J", new Map([["p1", 3]])]]) });
  const a = load.get("a") || new Map();
  assert.ok(Math.abs([...a.values()].reduce((s, x) => s + x, 0) - 20) < 1e-6);  // 2 plan days × 10h, not the slid window
  assert.equal(a.get("2026-06-01"), undefined);   // nothing booked in the past
  assert.ok(a.get("2026-06-22") != null);          // remaining work starts today
});
test("crewDayLoad(live): remaining hours never book onto days already gone", () => {
  const j = job({ id: "J", startDate: "2026-06-15", targetDate: "2026-06-19", subtasks: [
    ph("p1", { estimatedHours: 40, crewIds: ["a", "b"] })] });
  const { load } = crewDayLoad([j], S, { today: "2026-06-18", phaseHours: new Map([["J", new Map([["p1", 20]])]]) });
  const a = load.get("a") || new Map();
  assert.equal(a.get("2026-06-15"), undefined);   // the in-progress window reaches back; the booking must not
  assert.equal([...a.values()].reduce((s, x) => s + x, 0), 10);   // 20h remaining / 2 guys
});
test("computeCfoSnapshot(opts): a spanned-off member shows idle, not booked", () => {
  const j = job({ id: "J", startDate: "2026-06-15", targetDate: "2026-06-19", estimatedHours: 40, crewIds: ["a", "b"] });
  spanCrewPull(j, "2026-06-16", "b");             // b worked Monday, cycled off Tuesday onward
  const crew = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const snap = computeCfoSnapshot([j], crew, S, "2026-06-16", 7, { today: "2026-06-16", phaseHours: new Map() });
  assert.deepEqual(snap.crew.booked.map((c) => c.id), ["a"]);
  assert.deepEqual(snap.crew.idle.map((c) => c.id), ["b"]);
});

group("defaults");
test("DEFAULT_SETTINGS are Mon–Fri / 10h", () => {
  assert.deepEqual(DEFAULT_SETTINGS.workDays, [1, 2, 3, 4, 5]);
  assert.equal(DEFAULT_SETTINGS.hoursPerDay, 10);
});

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
