/* My Week — pure slicing tests (no DOM, no network).
   Run: node apps/field/test/myweek.test.mjs */
import assert from "node:assert/strict";
import { crewByEmail, schedulableJobs, buildMyWeek } from "../js/myweekcalc.js";
import { mapsHref, resolveIdentity } from "../js/myweek.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const TODAY = "2026-08-17";   // a Monday
const SETTINGS = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [] };
const CREW = [
  { id: "c1", name: "Joel Hess", email: "JoelHessAlaska@gmail.com", active: true },
  { id: "c2", name: "Jimmy Soland", email: "jimmysoland94@gmail.com", active: true, outDays: ["2026-08-21"] },
];
const JOBS = [
  { id: "j1", title: "Henderson", address: "123 Main St", stage: "in_progress",
    startDate: TODAY, targetDate: "2026-08-19", crewIds: ["c1"] },
  { id: "j2", title: "Dental office", address: "456 Badger Rd", stage: "scheduled",
    startDate: "2026-08-20", targetDate: "2026-08-21", crewIds: ["c1", "c2"] },
];
const base = { jobs: JOBS, crew: CREW, entries: [], settings: SETTINGS, today: TODAY };

test("crewByEmail: case/space-insensitive; empty never matches", () => {
  assert.equal(crewByEmail(CREW, "  joelhessalaska@GMAIL.com ").id, "c1");
  assert.equal(crewByEmail(CREW, ""), null);
  assert.equal(crewByEmail([{ id: "x", email: "" }], ""), null);
});

test("resolveIdentity: email match beats the device tech pick", () => {
  const who = resolveIdentity(CREW, "joelhessalaska@gmail.com", { id: "c2", name: "Jimmy" });
  assert.deepEqual(who, { crewId: "c1", name: "Joel Hess", via: "email" });
});

test("resolveIdentity: tech pick works when the email isn't linked yet", () => {
  const who = resolveIdentity(CREW, "new-guy@gmail.com", { id: "c2", name: "Jimmy" });
  assert.equal(who.crewId, "c2");
  assert.equal(who.via, "tech");
  assert.equal(resolveIdentity(CREW, "new-guy@gmail.com", { id: null, name: "Typed Name" }), null);
});

test("a member's week: their jobs on their days, weekends visible but empty", () => {
  const w = buildMyWeek({ ...base, crewId: "c1", days: 7 });
  assert.equal(w.member.name, "Joel Hess");
  assert.equal(w.days.length, 7);
  const byDay = Object.fromEntries(w.days.map((d) => [d.day, d]));
  assert.deepEqual(byDay[TODAY].jobs.map((j) => j.title), ["Henderson"]);          // Mon
  assert.deepEqual(byDay["2026-08-20"].jobs.map((j) => j.title), ["Dental office"]); // Thu
  assert.equal(byDay["2026-08-22"].isWork, false);                                  // Sat
  assert.deepEqual(byDay["2026-08-22"].jobs, []);
});

test("out day: marked, and that day's jobs are suppressed", () => {
  const w = buildMyWeek({ ...base, crewId: "c2", days: 7 });
  const fri = w.days.find((d) => d.day === "2026-08-21");
  assert.equal(fri.out, true);
  assert.deepEqual(fri.jobs, []);
  const thu = w.days.find((d) => d.day === "2026-08-20");
  assert.deepEqual(thu.jobs.map((j) => j.title), ["Dental office"]);
});

test("lead/done/archived jobs never appear", () => {
  const jobs = [...JOBS,
    { id: "j3", title: "Lead", stage: "lead", startDate: TODAY, targetDate: TODAY, crewIds: ["c1"] },
    { id: "j4", title: "Done", stage: "done", startDate: TODAY, targetDate: TODAY, crewIds: ["c1"] },
    { id: "j5", title: "Filed", archived: true, stage: "in_progress", startDate: TODAY, targetDate: TODAY, crewIds: ["c1"] }];
  const w = buildMyWeek({ ...base, jobs, crewId: "c1", days: 1 });
  assert.deepEqual(w.days[0].jobs.map((j) => j.title), ["Henderson"]);
  assert.deepEqual(schedulableJobs(jobs).map((j) => j.id), ["j1", "j2"]);
});

test("buildMyWeek never mutates the caller's job objects", () => {
  const jobs = JOBS.map((j) => ({ ...j }));
  const before = JSON.stringify(jobs);
  buildMyWeek({ ...base, jobs, crewId: "c1" });
  assert.equal(JSON.stringify(jobs), before);
});

test("unknown crew id: empty week, null member, no throw", () => {
  const w = buildMyWeek({ ...base, crewId: "ghost", days: 3 });
  assert.equal(w.member, null);
  assert.ok(w.days.every((d) => !d.jobs.length));
});

test("mapsHref: Apple on iPhone, Google elsewhere, empty for no address", () => {
  assert.match(mapsHref("123 Main St", "iPhone OS 17"), /^https:\/\/maps\.apple\.com/);
  assert.match(mapsHref("123 Main St", "Android 15"), /^https:\/\/maps\.google\.com/);
  assert.equal(mapsHref("", "Android"), "");
});

console.log(`myweek: ${pass} passed`);
