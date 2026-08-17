/* Crew schedule digest — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/roybal-brief/crewdigest.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCrewDigest, memberText, schedulableJobs, APP_URL } from "./crewdigest.ts";

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

test("no phone on the roster = skipped loudly, never a throw", () => {
  const crew = CREW.map((c) => (c.id === "c2" ? { ...c, phone: "" } : c));
  const d = buildCrewDigest({ ...base, crew });
  assert.ok(!d.messages.some((m) => m.name === "Jimmy Soland"));
  assert.match(d.ownerText, /no phone on the roster: Jimmy/);
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

console.log(`crewdigest: ${pass} passed`);
