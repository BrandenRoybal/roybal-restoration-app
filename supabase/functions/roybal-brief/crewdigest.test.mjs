/* Crew schedule digest — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/roybal-brief/crewdigest.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCrewDigest, memberText, schedulableJobs, entriesCutoff, APP_URL } from "./crewdigest.ts";
import { entriesCutoff as clientCutoff } from "../../../apps/field/js/myweekcalc.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

/* ---------- engine drift guard ----------
   ./schedule.js is a committed COPY of the board's engine (Supabase deploys
   bundle only the function directory). If the board's copy changes, this
   digest silently computes a different schedule than the board shows — so
   the suite fails until the copy is refreshed:
     cp apps/board/js/schedule.js supabase/functions/roybal-brief/schedule.js */
test("schedule.js copy matches apps/board/js/schedule.js byte-for-byte", () => {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const ours = readFileSync(here("./schedule.js"), "utf8");
  const board = readFileSync(here("../../../apps/board/js/schedule.js"), "utf8");
  assert.equal(ours, board,
    "drifted — re-copy: cp apps/board/js/schedule.js supabase/functions/roybal-brief/schedule.js");
});

/* ---------- fixtures: a tiny live board ----------
   2026-08-17 is a Monday. */
const TODAY = "2026-08-17";
const PRETTY = "Mon, Aug 17";
const SETTINGS = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [] };
const CREW = [
  { id: "c1", name: "Joel Hess", phone: "907-555-0101", active: true },
  { id: "c2", name: "Jimmy Soland", phone: "907-555-0102", active: true },
  { id: "c3", name: "Matt Gross", phone: "907-555-0103", active: true },
  { id: "c4", name: "Old Timer", phone: "907-555-0104", active: false },
];
const JOBS = [
  { id: "j1", title: "Henderson", customer: "Henderson", address: "123 Main St", stage: "in_progress",
    startDate: "2026-08-14", targetDate: "2026-08-19", crewIds: ["c1"] },
  { id: "j2", title: "Dental office", address: "456 Badger Rd", stage: "scheduled",
    startDate: TODAY, targetDate: "2026-08-18", crewIds: ["c2"] },
  { id: "j3", title: "Filed job", address: "1 Done Ln", stage: "done",
    startDate: TODAY, targetDate: TODAY, crewIds: ["c3"] },
];
const base = { jobs: JOBS, crew: CREW, entries: [], settings: SETTINGS, today: TODAY, pretty: PRETTY };

test("schedulableJobs drops leads, done, archived, milestones", () => {
  const kept = schedulableJobs([
    { id: "a", stage: "lead" }, { id: "b", stage: "done" }, { id: "c", archived: true, stage: "in_progress" },
    { id: "d", isMilestone: true, stage: "scheduled" }, { id: "e", stage: "scheduled" },
  ]);
  assert.deepEqual(kept.map((j) => j.id), ["e"]);
});

test("each working member gets one text with today's job + address", () => {
  const d = buildCrewDigest(base);
  assert.equal(d.workday, true);
  assert.deepEqual(d.messages.map((m) => m.name).sort(), ["Jimmy Soland", "Joel Hess"]);
  const joel = d.messages.find((m) => m.name === "Joel Hess");
  assert.match(joel.text, /Roybal schedule Mon, Aug 17:/);
  assert.match(joel.text, /• Henderson — 123 Main St/);
  assert.ok(joel.text.includes(APP_URL));
});

test("done jobs never text anyone; the idle member lands in the roll-up", () => {
  const d = buildCrewDigest(base);
  assert.ok(!d.messages.some((m) => m.jobs.includes("Filed job")));
  assert.deepEqual(d.skipped.filter((s) => s.reason === "nothing scheduled").map((s) => s.name), ["Matt Gross"]);
  assert.match(d.ownerText, /not scheduled: Matt/);
  assert.doesNotMatch(d.ownerText, /Old Timer/);   // inactive: not texted, not counted
});

test("outDays suppress the text and show in the roll-up", () => {
  const crew = CREW.map((c) => (c.id === "c1" ? { ...c, outDays: [TODAY] } : c));
  const d = buildCrewDigest({ ...base, crew });
  assert.ok(!d.messages.some((m) => m.name === "Joel Hess"));
  assert.match(d.ownerText, /out: Joel/);
});

test("a dayCrew override moves the text to the substitute", () => {
  const jobs = JOBS.map((j) => (j.id === "j1"
    ? { ...j, dayCrew: { [TODAY]: { add: ["c3"], remove: ["c1"] } } } : j));
  const d = buildCrewDigest({ ...base, jobs });
  const matt = d.messages.find((m) => m.name === "Matt Gross");
  assert.ok(matt && matt.jobs.includes("Henderson"), "substitute texted");
  assert.ok(!d.messages.some((m) => m.name === "Joel Hess"), "pulled member not texted");
});

test("an off-app member is never texted, but the owner is told what to relay", () => {
  const crew = CREW.map((c) => (c.id === "c1" ? { ...c, digestOptOut: true } : c));
  const d = buildCrewDigest({ ...base, crew });
  assert.ok(!d.messages.some((m) => m.name === "Joel Hess"), "opted-out member not texted");
  assert.match(d.ownerText, /📞 you tell: Joel→Henderson/);
  assert.deepEqual(d.skipped.find((s) => s.name === "Joel Hess"),
    { name: "Joel Hess", reason: "off-app", jobs: ["Henderson"] });
});

test("an off-app member with nothing scheduled is just idle, not a relay chore", () => {
  const crew = CREW.map((c) => (c.id === "c3" ? { ...c, digestOptOut: true } : c));   // Matt has no live job
  const d = buildCrewDigest({ ...base, crew });
  assert.doesNotMatch(d.ownerText, /you tell/);
  assert.match(d.ownerText, /not scheduled: Matt/);
});

test("an off-app member who is OUT reads as out, not as a call to make", () => {
  const crew = CREW.map((c) => (c.id === "c1" ? { ...c, digestOptOut: true, outDays: [TODAY] } : c));
  const d = buildCrewDigest({ ...base, crew });
  assert.match(d.ownerText, /out: Joel/);
  assert.doesNotMatch(d.ownerText, /you tell/);
});

test("no phone on the roster = skipped loudly, never a throw", () => {
  const crew = CREW.map((c) => (c.id === "c2" ? { ...c, phone: "" } : c));
  const d = buildCrewDigest({ ...base, crew });
  assert.ok(!d.messages.some((m) => m.name === "Jimmy Soland"));
  assert.match(d.ownerText, /no phone on the roster: Jimmy→Dental office/);
});

test("weekend: nothing sends at all", () => {
  const d = buildCrewDigest({ ...base, today: "2026-08-16", pretty: "Sun, Aug 16" });   // Sunday
  assert.equal(d.workday, false);
  assert.equal(d.messages.length, 0);
});

test("board holiday: nothing sends", () => {
  const d = buildCrewDigest({ ...base, settings: { ...SETTINGS, holidays: [TODAY] } });
  assert.equal(d.workday, false);
});

test("two jobs in one day = two bullets in one text", () => {
  const jobs = [...JOBS, { id: "j4", title: "Afternoon board-up", address: "789 Peger Rd",
    stage: "scheduled", startDate: TODAY, targetDate: TODAY, crewIds: ["c1"] }];
  const d = buildCrewDigest({ ...base, jobs });
  const joel = d.messages.find((m) => m.name === "Joel Hess");
  assert.deepEqual(joel.jobs, ["Afternoon board-up", "Henderson"]);
  assert.equal((joel.text.match(/^• /gm) || []).length, 2);
});

test("memberText marks on-hold jobs", () => {
  const t = memberText(PRETTY, [{ title: "Henderson", address: "123 Main St", stage: "on_hold" }]);
  assert.match(t, /\(on hold\)/);
});

/* ---------- dispatch filter: the text means "go here today" ----------
   The live engine slides a phase's unfinished hours onto this morning until
   someone marks it done — right for the Gantt, wrong for a dispatch text.
   A phased job whose PLAN ended last Tue (8/10 start, 20h ≈ 2 days) but was
   never marked done keeps landing on live "today" forever. */
const leftoverJob = (over = {}) => ({
  id: "j9", title: "Leftover kitchen", address: "9 Slid Ct", stage: "in_progress",
  startDate: "2026-08-10", targetDate: "2026-08-11",
  subtasks: [{ id: "p1", name: "Paint", estimatedHours: 20, crewIds: ["c3"] }],
  ...over,
});

test("a phase that slid past its plan window doesn't text anyone", () => {
  const d = buildCrewDigest({ ...base, jobs: [...JOBS, leftoverJob()] });
  assert.ok(!d.messages.some((m) => m.jobs.includes("Leftover kitchen")), "slid leftover never texts");
  assert.deepEqual(d.skipped.find((s) => s.name === "Matt Gross"),
    { name: "Matt Gross", reason: "leftover only", jobs: ["Leftover kitchen"] });
  assert.match(d.ownerText, /leftover only \(no text\): Matt→Leftover kitchen/);
  assert.doesNotMatch(d.ownerText, /not scheduled: Matt/);   // held ≠ idle
});

test("a phase whose plan includes today still texts, with the address", () => {
  const jobs = [...JOBS, leftoverJob({ startDate: TODAY, targetDate: "2026-08-18" })];
  const d = buildCrewDigest({ ...base, jobs });
  const matt = d.messages.find((m) => m.name === "Matt Gross");
  assert.ok(matt && matt.jobs.includes("Leftover kitchen"), "planned-today job texts");
  assert.match(matt.text, /• Leftover kitchen — 9 Slid Ct/);
});

test("hours logged yesterday keep a slid job in the text", () => {
  const entries = [{ id: "e1", jobId: "j9", crewId: "c3", date: "2026-08-16", hours: 4 }];
  const d = buildCrewDigest({ ...base, jobs: [...JOBS, leftoverJob()], entries });
  const matt = d.messages.find((m) => m.name === "Matt Gross");
  assert.ok(matt && matt.jobs.includes("Leftover kitchen"), "fresh hours = still dispatched");
});

test("the evidence join is entriesOfJob's: QB Time jobcode rows count", () => {
  const jobs = [...JOBS, leftoverJob({ qbJobcodeId: "77" })];
  const entries = [{ id: "e2", source: "qbtime", qbJobcodeId: "77", date: TODAY, hours: 2 }];
  const d = buildCrewDigest({ ...base, jobs, entries });
  const matt = d.messages.find((m) => m.name === "Matt Gross");
  assert.ok(matt && matt.jobs.includes("Leftover kitchen"), "jobcode-joined hours = still dispatched");
});

test("a dayCrew add for today keeps a slid job in the substitute's text", () => {
  const jobs = [...JOBS, leftoverJob({ dayCrew: { [TODAY]: { add: ["c2"] } } })];
  const d = buildCrewDigest({ ...base, jobs });
  const jimmy = d.messages.find((m) => m.name === "Jimmy Soland");
  assert.ok(jimmy && jimmy.jobs.includes("Leftover kitchen"), "override guest texted");
  assert.ok(!d.messages.some((m) => m.name === "Matt Gross"), "leftover-only base crew still held");
});

test("owner roll-up still fires when every member was leftover-only", () => {
  const jobs = [leftoverJob({ subtasks: [{ id: "p1", name: "Paint", estimatedHours: 20, crewIds: ["c1", "c2", "c3"] }] })];
  const d = buildCrewDigest({ ...base, jobs });
  assert.equal(d.workday, true);
  assert.equal(d.messages.length, 0);
  assert.match(d.ownerText, /texting 0/);
  assert.match(d.ownerText,
    /leftover only \(no text\): Joel→Leftover kitchen; Jimmy→Leftover kitchen; Matt→Leftover kitchen/);
});

test("an off-app member whose only job is leftover reads as held, not a relay chore", () => {
  const crew = CREW.map((c) => (c.id === "c3" ? { ...c, digestOptOut: true } : c));
  const d = buildCrewDigest({ ...base, jobs: [...JOBS, leftoverJob()], crew });
  assert.doesNotMatch(d.ownerText, /you tell/);
  assert.match(d.ownerText, /leftover only \(no text\): Matt→Leftover kitchen/);
});

/* The digest and the field app's My Week must window time_entries identically,
   or the morning text and the app show the same crew member different days. */
test("entriesCutoff agrees with the field app's copy on every case", () => {
  const cases = [
    JOBS,
    [{ id: "j", stage: "in_progress", startDate: "2026-07-13", hoursFrom: "2026-06-01" }],
    [{ id: "j", stage: "done", startDate: "2020-01-01" }],
    [{ id: "j", stage: "scheduled" }],
    [{ id: "j", stage: "scheduled", startDate: "1999-01-01" }],
    [{ id: "j", stage: "scheduled", startDate: "not-a-date" }],
    [],
  ];
  for (const jobs of cases) {
    assert.equal(entriesCutoff(jobs, TODAY), clientCutoff(jobs, TODAY),
      "server/client cutoff drifted for " + JSON.stringify(jobs));
  }
});

console.log(`crewdigest: ${pass} passed`);
