/* Engine tests for the Job Board scheduler (pure module, no DOM).
   Run: node apps/board/test/schedule.test.mjs   (or: npm test --workspace=apps/board)

   Calendar reference (so the date math below is readable):
     2026-06-12 Fri · 13 Sat · 14 Sun · 15 Mon · 16 Tue · 17 Wed · 18 Thu · 19 Fri · 22 Mon */
import assert from "node:assert/strict";
import {
  isWorkDay, addWorkDays, workDaysBetween, durationOf, durationFracOf,
  layoutSubtasks, computeSchedule, effCrew, crewDayLoad, findOverAllocations,
  wouldCreateCycle, DEFAULT_SETTINGS,
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

group("defaults");
test("DEFAULT_SETTINGS are Mon–Fri / 10h", () => {
  assert.deepEqual(DEFAULT_SETTINGS.workDays, [1, 2, 3, 4, 5]);
  assert.equal(DEFAULT_SETTINGS.hoursPerDay, 10);
});

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
