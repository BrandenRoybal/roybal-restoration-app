/* My Week — pure slicing tests (no DOM, no network).
   Run: node apps/field/test/myweek.test.mjs */
import assert from "node:assert/strict";
import { crewByEmail, schedulableJobs, buildMyWeek, entriesCutoff, shiftDays } from "../js/myweekcalc.js";
import { mapsHref, resolveIdentity, cacheUsable, identityNotice } from "../js/myweek.js";

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

test("identityNotice: a tech-pick identity WARNS (wrong-week risk); an email match never does", () => {
  assert.equal(identityNotice({ crewId: "c1", name: "Joel Hess", via: "email" }), null);
  assert.equal(identityNotice(null), null);
  const msg = identityNotice({ crewId: "c2", name: "Jimmy Soland", via: "tech" });
  assert.ok(msg && msg.includes("Jimmy Soland"));
  assert.ok(msg.includes("tech pick"));
  assert.ok(msg.includes("crew card"));       // tells the office what fixes it
  // a nameless pick still warns, readably
  assert.ok(identityNotice({ crewId: "c2", name: "", via: "tech" }).includes("the picked tech"));
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

/* ---------- schedule-truth flags on the week's cards ---------- */
test("an unlinked job and a linked-but-silent job carry their flags on the tech's cards", () => {
  const jobs = [
    { id: "j6", title: "Unlinked", stage: "in_progress", startDate: "2026-08-10", targetDate: "2026-08-18", crewIds: ["c1"] },
    { id: "j7", title: "Silent", stage: "in_progress", qbJobcodeId: "77", startDate: "2026-08-10", targetDate: "2026-08-18", crewIds: ["c1"] },
  ];
  const w = buildMyWeek({ ...base, jobs, crewId: "c1", days: 1 });
  const byTitle = Object.fromEntries(w.days[0].jobs.map((j) => [j.title, j]));
  assert.deepEqual(byTitle.Unlinked.flags.map((f) => f.kind), ["no-jobcode"]);
  assert.deepEqual(byTitle.Silent.flags.map((f) => f.kind), ["no-hours"]);
});

test("flags go quiet once hours land on the linked jobcode", () => {
  const jobs = [{ id: "j7", title: "Silent", stage: "in_progress", qbJobcodeId: "77",
    startDate: "2026-08-10", targetDate: "2026-08-18", crewIds: ["c1"] }];
  const entries = [{ source: "qbtime", qbJobcodeId: "77", date: "2026-08-12", hours: 8 }];
  const w = buildMyWeek({ ...base, jobs, entries, crewId: "c1", days: 1 });
  assert.deepEqual(w.days[0].jobs[0].flags, []);
});

test("an unmarked-done phase surfaces with its subId (what the one-tap needs)", () => {
  const jobs = [{ id: "j8", title: "Phased", stage: "in_progress", qbJobcodeId: "77",
    startDate: "2026-08-10", targetDate: "2026-08-18", crewIds: ["c1"],
    subtasks: [{ id: "p1", name: "Demo", estimatedHours: 10 }, { id: "p2", name: "Paint", estimatedHours: 20 }] }];
  const entries = [{ source: "qbtime", qbJobcodeId: "77", phaseId: "p1", date: "2026-08-11", hours: 12 }];
  const w = buildMyWeek({ ...base, jobs, entries, crewId: "c1", days: 1 });
  const flags = w.days[0].jobs[0].flags;
  assert.deepEqual(flags.map((f) => [f.kind, f.subId]), [["unmarked-done", "p1"]]);
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

/* ---------- the time_entries window (the 1000-row page bug) ---------- */
test("entriesCutoff reaches back to the oldest live job, minus a buffer", () => {
  // oldest live start 2026-08-17 → 30-day buffer → 2026-07-18
  assert.equal(entriesCutoff(JOBS, TODAY), "2026-07-18");
});

test("entriesCutoff honors hoursFrom when it predates the start date", () => {
  const jobs = [{ id: "j", stage: "in_progress", startDate: "2026-07-13", hoursFrom: "2026-06-01" }];
  assert.equal(entriesCutoff(jobs, TODAY), shiftDays("2026-06-01", -30));
});

test("entriesCutoff ignores archived/done/lead jobs — dead work can't widen the window", () => {
  const jobs = [...JOBS, { id: "old", stage: "done", startDate: "2020-01-01" },
    { id: "arch", archived: true, stage: "in_progress", startDate: "2020-01-01" }];
  assert.equal(entriesCutoff(jobs, TODAY), "2026-07-18");
});

test("entriesCutoff: no dated jobs → 90 days; a typo'd year clamps to maxDays", () => {
  assert.equal(entriesCutoff([{ id: "x", stage: "scheduled" }], TODAY), shiftDays(TODAY, -90));
  assert.equal(entriesCutoff([{ id: "x", stage: "scheduled", startDate: "1999-01-01" }], TODAY),
    shiftDays(TODAY, -365));
  assert.equal(entriesCutoff([{ id: "x", stage: "scheduled", startDate: "not-a-date" }], TODAY),
    shiftDays(TODAY, -90));
});

/* ---------- shared-tablet cache identity ---------- */
test("cacheUsable: only the same signed-in email may reuse a cached week", () => {
  const c = { week: { days: [] }, email: "joel@x.com" };
  assert.equal(cacheUsable(c, "joel@x.com"), true);
  assert.equal(cacheUsable(c, "jimmy@x.com"), false);   // shared tablet, next tech
  assert.equal(cacheUsable(c, ""), false);
  assert.equal(cacheUsable({ week: { days: [] } }, ""), false);   // legacy payload, no email
  assert.equal(cacheUsable(null, "joel@x.com"), false);
});

console.log(`myweek: ${pass} passed`);
