/* Settings-row sync — the reserved id, the doomed-write cleanup, and the
   pull-time reconcile. Run: node apps/board/test/settingsync.test.mjs

   Why this exists: coordination_jobs.id is a uuid column, and the settings
   row was keyed '__settings__' — so every settings save 400'd, sat in the
   offline queue retrying forever, and hoursPerDay/workDays/holidays (and
   the Gantt baseline) only ever existed per-browser. These helpers are the
   fix: a fixed reserved uuid, queue hygiene for the stranded legacy writes,
   and a one-time publish of each device's local cache. */
import assert from "node:assert/strict";
import {
  SETTINGS_UUID, LEGACY_SETTINGS_ID, settingsRow,
  isDoomedSettingsWrite, dropDoomedSettingsWrites, reconcileSettings,
} from "../js/settingsync.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

/* ---- the reserved id itself ---- */
test("the reserved id is a real uuid (the whole bug was an id the column rejects)", () => {
  assert.match(SETTINGS_UUID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
test("…and not a v4, so crypto.randomUUID() can never mint a colliding job id", () => {
  assert.notEqual(SETTINGS_UUID[14], "4");   // v4 ids always carry '4' in the version slot
});

/* ---- the row a save writes ---- */
test("settingsRow wraps the blob under the reserved id, undeleted", () => {
  const s = { hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: ["2026-11-26"] };
  const row = settingsRow(s);
  assert.equal(row.id, SETTINGS_UUID);
  assert.equal(row.deleted, false);
  assert.equal(row.data.hoursPerDay, 8);
  assert.deepEqual(row.data.holidays, ["2026-11-26"]);
});
test("settingsRow carries the archived shim (hides the row from stale pre-fix bundles)…", () => {
  assert.equal(settingsRow({ hoursPerDay: 8 }).data.archived, true);
});
test("…without mutating the caller's settings object", () => {
  const s = { hoursPerDay: 8 };
  settingsRow(s);
  assert.deepEqual(s, { hoursPerDay: 8 });
});

/* ---- queue hygiene: the stranded legacy writes ---- */
const legacy = { table: "coordination_jobs", row: { id: LEGACY_SETTINGS_ID, data: { hoursPerDay: 8 }, deleted: false } };
const fresh = { table: "coordination_jobs", row: settingsRow({ hoursPerDay: 8 }) };
const jobWrite = { guarded: true, id: "6f0f1f5e-1111-4222-8333-444455556666", base: 3, data: { rev: 3 } };
const crewWrite = { table: "crew_members", row: { id: "abc", data: { name: "Joel" }, deleted: false }, mergeCrew: true };

test("a legacy '__settings__' write is recognized as doomed", () => {
  assert.equal(isDoomedSettingsWrite(legacy), true);
});
test("new-id settings writes, guarded job writes, and crew writes are not", () => {
  assert.equal(isDoomedSettingsWrite(fresh), false);
  assert.equal(isDoomedSettingsWrite(jobWrite), false);   // guarded items carry no .row
  assert.equal(isDoomedSettingsWrite(crewWrite), false);
});
test("dropDoomedSettingsWrites sheds every stranded retry and keeps the rest, in order", () => {
  const q = dropDoomedSettingsWrites([legacy, jobWrite, legacy, crewWrite, fresh, legacy]);
  assert.deepEqual(q, [jobWrite, crewWrite, fresh]);
});
test("…and tolerates junk entries and a missing queue", () => {
  assert.deepEqual(dropDoomedSettingsWrites([null, undefined, {}]), [null, undefined, {}]);
  assert.deepEqual(dropDoomedSettingsWrites(undefined), []);
});

/* ---- pull-time reconcile ---- */
const serverRow = (data, deleted = false) => ({ id: SETTINGS_UUID, data, deleted, updated_at: "2026-09-01T00:00:00Z" });
const jobRow = { id: "6f0f1f5e-1111-4222-8333-444455556666", data: { name: "Smith Rebuild", stage: "in_progress" }, deleted: false };

test("server row present → adopt it (shim stripped, baseline kept), publish nothing", () => {
  const srv = { hoursPerDay: 8, baseline: { savedAt: "2026-08-20", jobs: { j1: { start: "2026-08-21" } } }, archived: true };
  const r = reconcileSettings([jobRow, serverRow(srv)], { hoursPerDay: 10 });
  assert.equal(r.publish, null);
  assert.equal(r.adopt.hoursPerDay, 8);                     // the server copy wins over local
  assert.equal(r.adopt.archived, undefined);                // shim is transport-only
  assert.equal(r.adopt.baseline.jobs.j1.start, "2026-08-21");
  assert.equal(serverRow(srv).data.archived, true);         // source row untouched
});
test("no server row + local settings → publish the local copy (the one-time migration)", () => {
  const r = reconcileSettings([jobRow], { hoursPerDay: 8, workDays: [1, 2, 3, 4, 5] });
  assert.equal(r.adopt, null);
  assert.equal(r.publish.hoursPerDay, 8);
});
test("a deleted server row counts as absent, so a local copy resurrects it", () => {
  const r = reconcileSettings([serverRow({ hoursPerDay: 10 }, true)], { hoursPerDay: 8 });
  assert.equal(r.adopt, null);
  assert.equal(r.publish.hoursPerDay, 8);
});
test("nothing anywhere → do nothing", () => {
  assert.deepEqual(reconcileSettings([jobRow], null), { adopt: null, publish: null });
});
test("an empty local object is never worth publishing", () => {
  assert.deepEqual(reconcileSettings([], {}), { adopt: null, publish: null });
});
test("a job row never masquerades as settings", () => {
  const r = reconcileSettings([jobRow], null);
  assert.equal(r.adopt, null);
});

console.log(`\n${pass} settings-sync checks passed.`);
