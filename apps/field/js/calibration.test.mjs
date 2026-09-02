/* node --test apps/field/js/calibration.test.mjs
   §14.2 calibration math: the completed-job filter, the medians, and
   above all THE GATE — no factor below minN, ever. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCalibration, calibrationContext } from "./calibration.js";

const done = (id, est, extra = {}) => ({ id, stage: "done", estimatedHours: est, ...extra });

test("median over completed jobs, odd and even counts", () => {
  const jobs = [done("a", 10), done("b", 10), done("c", 10)];
  const c = computeCalibration(jobs, { a: 11, b: 12, c: 16 }, 3);
  assert.equal(c.hours.overall.factor, 1.2);          // median of 1.1, 1.2, 1.6
  assert.equal(c.hours.overall.n, 3);
  const c2 = computeCalibration(jobs.slice(0, 2), { a: 10, b: 12 }, 2);
  assert.equal(c2.hours.overall.factor, 1.1);         // even: mean of 1.0, 1.2
});

test("THE GATE: factor is null below minN, n still reported", () => {
  const jobs = [done("a", 10), done("b", 10)];
  const c = computeCalibration(jobs, { a: 12, b: 12 }, 5);
  assert.equal(c.hours.overall.factor, null);
  assert.equal(c.hours.overall.n, 2);
});

test("only finished stories count: in-progress, lost, milestones, half-data excluded", () => {
  const jobs = [
    done("a", 10),                                        // counts
    { id: "b", stage: "in_progress", estimatedHours: 10 },// running — no
    { id: "c", stage: "lead", archived: true, outcome: "lost", estimatedHours: 10 }, // lost — no
    { id: "d", stage: "done", estimatedHours: 0 },        // no estimate — no
    done("e", 10),                                        // no actuals — no
    { id: "f", stage: "done", estimatedHours: 10, isMilestone: true }, // milestone — no
    { id: "g", stage: "lead", archived: true, outcome: "won", estimatedHours: 10 },  // archived won — counts
  ];
  const c = computeCalibration(jobs, { a: 12, b: 99, c: 99, d: 99, f: 99, g: 8 }, 1);
  assert.equal(c.hours.overall.n, 2);
  assert.equal(c.hours.overall.factor, 1.0);            // median of 1.2 and 0.8
});

test("type split: remodel vs mitigation (default)", () => {
  const jobs = [done("a", 10), done("b", 10, { type: "remodel" }), done("c", 10, { type: "mitigation" })];
  const c = computeCalibration(jobs, { a: 12, b: 15, c: 8 }, 1);
  assert.equal(c.hours.byType.remodel.n, 1);
  assert.equal(c.hours.byType.remodel.factor, 1.5);
  assert.equal(c.hours.byType.mitigation.n, 2);         // untyped counts as mitigation
});

test("dollars: won jobs with both numbers, independent of hours data", () => {
  const jobs = [
    { id: "a", stage: "lead", outcome: "won", estValue: 100, contractValue: 120 },
    { id: "b", stage: "done", outcome: "won", estValue: 100, contractValue: 90 },
    { id: "c", stage: "done", outcome: "won", estValue: 0, contractValue: 90 },   // no bid — no
    { id: "d", stage: "done", outcome: "lost", estValue: 100, contractValue: 90 },// lost — no
  ];
  const c = computeCalibration(jobs, {}, 2);
  assert.equal(c.dollars.n, 2);
  assert.equal(c.dollars.factor, 1.05);                 // mean of 1.2 and 0.9
});

test("context block: gated factors only; null when nothing passes", () => {
  const sparse = computeCalibration([done("a", 10)], { a: 12 }, 5);
  assert.equal(calibrationContext(sparse), null);
  assert.equal(calibrationContext(null), null);

  const jobs = Array.from({ length: 6 }, (_, i) => done("j" + i, 10));
  const hours = Object.fromEntries(jobs.map((j) => [j.id, 12]));
  const full = calibrationContext(computeCalibration(jobs, hours, 5));
  assert.ok(full.note.includes("Never silently apply"));
  assert.equal(full.hoursMitigation.factor, 1.2);
  assert.equal(full.hoursRemodel, undefined);           // remodel n=0 — absent, not null-scaffolded
  assert.equal(full.hoursOverall, undefined);           // typed factor present ⇒ overall omitted
  assert.equal(full.dollars, undefined);
});

test("overall appears only when no typed factor passes", () => {
  const jobs = [...Array.from({ length: 3 }, (_, i) => done("m" + i, 10)),
    ...Array.from({ length: 3 }, (_, i) => done("r" + i, 10, { type: "remodel" }))];
  const hours = Object.fromEntries(jobs.map((j) => [j.id, 13]));
  const ctx = calibrationContext(computeCalibration(jobs, hours, 5));
  assert.equal(ctx.hoursMitigation, undefined);         // n=3 each, gated
  assert.equal(ctx.hoursRemodel, undefined);
  assert.equal(ctx.hoursOverall.factor, 1.3);           // but 6 overall passes
  assert.equal(ctx.hoursOverall.n, 6);
});
