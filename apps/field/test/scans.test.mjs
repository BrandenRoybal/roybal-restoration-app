/* scans.js — equipment scan in and out: tag parsing, the append-only event
   log, placements, the drying-log rows derived from them (the same bytes on
   every device and in the worker), the decision for one read, undo, and the
   cross-job / print / room-picker helpers.
   Run: node --test test/scans.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TAG_PAD, TAG_PREFIXES, TYPE_LABELS, parseTag, tagKey, typeFromTag, liveScans, placements, openPlacement,
  wallTime, applyScans, recordScan, voidEvent, voidPlacement, openElsewhere, scanRecord, roomSuggestions, undoTyped,
  releaseTypedScans, rowOutAt, rowRoom, rowScans, restoreMoveLines, settleTypedRow,
} from "../js/scans.js";
import { equipClassOf, deployedCounts } from "../js/dryingcalc.js";
import { mergeProjects, ID_COLLECTIONS, tombstoneItems } from "../js/merge.js";
import { newProject, blankEquipRow } from "../js/model.js";

const SCANS_URL = new URL("../js/scans.js", import.meta.url).href;
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- fixtures ---------- */
// 2026-10-08 18:00Z is 10:00 on the Alaska clock (AKDT, UTC-8)
const T0 = Date.UTC(2026, 9, 8, 18, 0);
const at = (min) => new Date(T0 + min * 60000).toISOString();
const ctx = (id, min, extra = {}) => ({ id, at: at(min), by: "crew@example.com", tech: "Pat Tech", build: "v208", ...extra });
const place = (tag, room, id, min, extra = {}) => ({ ...ctx(id, min), tag, mode: "place", room, how: "camera", ...extra });
const remove = (tag, id, min, extra = {}) => ({ ...ctx(id, min), tag, mode: "remove", how: "camera", ...extra });
// a raw event, every field present
const ev = (act, tag, id, min, extra = {}) => ({
  id, tag, act, at: at(min), room: "", type: "", model: "", logId: "", voids: "",
  how: "camera", by: "crew@example.com", tech: "Pat Tech", build: "v208", ...extra,
});
const log = (id, equipment = [blankEquipRow()]) => ({ id, by: "", createdAt: "", dryoutStart: "", dryoutFinish: "", techSupervisor: "", equipment, readings: [] });
const job = (extra = {}) => ({
  id: "job-1", customer: "Test Customer", address: "1 Test St", updatedAt: "2026-10-08T18:00:00.000Z",
  rooms: [], photos: [], moistureMaps: [], dryingLogs: [log("L1")], equipmentScans: [], ...extra,
});
const rows = (p, li = 0) => p.dryingLogs[li].equipment;
const scanned = (p) => p.dryingLogs.flatMap((l) => l.equipment.filter((r) => r.scanId));

/* ---------- constants and tags ---------- */
test("the tag constants: three digits, four prefixes, and every type label lands in the right class", () => {
  assert.equal(TAG_PAD, 3);
  assert.deepEqual(TAG_PREFIXES, { AM: "air_mover", DH: "dehumidifier", AF: "air_scrubber", HT: "heater" });
  const want = { air_mover: "airMover", dehumidifier: "dehu", dehu_lgr: "dehu", dehu_desiccant: "dehu",
    air_scrubber: "scrubber", heater: "heater", other: null };
  assert.deepEqual(Object.keys(TYPE_LABELS).sort(), Object.keys(want).sort());
  for (const [code, cls] of Object.entries(want)) assert.equal(equipClassOf(TYPE_LABELS[code]), cls, code);
  assert.equal(TYPE_LABELS.air_mover, "Air mover");
});

test("parseTag reads every label and typing form, pads prefixed digits, never truncates, and refuses the rest", () => {
  const ok = {
    "RC:AM-014": "AM-014", "AM-014": "AM-014", "am 14": "AM-014", "am14": "AM-014", "  dh_3 ": "DH-003",
    "rc: af-2": "AF-002", "RC:HT-1\n": "HT-001", "AM\u2014014": "AM-014", "am \u2013 14": "AM-014", "AM-0014": "AM-0014", "AM-1234": "AM-1234", "XY-7": "XY-007",
    "https://app.example.com/#eq=AM-014": "AM-014", "https://app.example.com/?eq=RC%3ADH-02&x=1": "DH-002",
    "https://app.example.com/?a=1&eq=am%2014": "AM-014", "#eq=RC:101": "101",
    "101": "101", "RC:007": "007", " 42 ": "42",
  };
  for (const [text, tag] of Object.entries(ok)) assert.equal(parseTag(text), tag, JSON.stringify(text));
  for (const bad of ["", "   ", null, undefined, "hello", "AM-14A", "A-14", "ABC-1", "1234567", "AM-1234567",
    "https://app.example.com/AM-014", "ROYBAL RESTORATION\nBox: 1\nJob: X", "RC:", "#eq=", "12.5"]) {
    assert.equal(parseTag(bad), null, JSON.stringify(bad));
  }
});

test("tagKey: AM-14 ≡ AM-014 ≡ am 014; numeric tags lose leading zeros; anything else is uppercased", () => {
  assert.equal(tagKey("AM-14"), "AM-14");
  assert.equal(tagKey("AM-014"), "AM-14");
  assert.equal(tagKey("am 014"), "AM-14");
  assert.equal(tagKey("AM0014"), "AM-14");
  assert.equal(tagKey("AM\u2212014"), "AM-14");
  assert.equal(tagKey("AM-000"), "AM-0");
  assert.equal(tagKey("007"), "7");
  assert.equal(tagKey("101"), "101");
  assert.equal(tagKey("000"), "0");
  assert.equal(tagKey(" d-1 "), "D-1");
  assert.equal(tagKey("n/a"), "N/A");
  for (const none of ["", "  ", null, undefined]) assert.equal(tagKey(none), "");
});

test("typeFromTag follows the prefix; numeric and unknown prefixes have no type", () => {
  assert.equal(typeFromTag("AM-014"), "air_mover");
  assert.equal(typeFromTag("dh 3"), "dehumidifier");
  assert.equal(typeFromTag("AF-2"), "air_scrubber");
  assert.equal(typeFromTag("HT-001"), "heater");
  for (const none of ["101", "XY-1", "", null, "D-1"]) assert.equal(typeFromTag(none), null, String(none));
});

/* ---------- time ---------- */
test("wallTime is the Alaska wall clock for a UTC stamp, across both DST changes and the date line", () => {
  const cases = {
    "2026-07-01T20:00:00.000Z": "2026-07-01T12:00",   // AKDT
    "2026-01-15T20:00:00.000Z": "2026-01-15T11:00",   // AKST
    "2026-10-08T03:30:00.000Z": "2026-10-07T19:30",   // the day before in Alaska
    "2026-03-08T10:59:00.000Z": "2026-03-08T01:59",   // last AKST minute
    "2026-03-08T11:00:00.000Z": "2026-03-08T03:00",   // spring forward
    "2026-11-01T09:59:00.000Z": "2026-11-01T01:59",   // last AKDT minute
    "2026-11-01T10:00:00.000Z": "2026-11-01T01:00",   // fall back
    "2026-12-31T23:59:59.999Z": "2026-12-31T14:59",
    "2026-10-08T10:00:00-08:00": "2026-10-08T10:00",  // an offset stamp
    "2026-10-08T18:00:00+0000": "2026-10-08T10:00",
    "2026-10-08T18:00:00.123456Z": "2026-10-08T10:00",
  };
  for (const [iso, wall] of Object.entries(cases)) assert.equal(wallTime(iso), wall, iso);
  // no zone = no instant (it would be read in the device's zone): refused, like garbage
  for (const bad of ["", null, undefined, "garbage", "2026-10-08T10:00", "2026-10-08", "2026-13-45T10:00:00Z", 1696780800000]) {
    assert.equal(wallTime(bad), "", String(bad));
  }
});

test("wallTime gives the same answer without Intl time-zone data (the fixed US rule)", () => {
  const stamps = [];
  for (let d = Date.UTC(2025, 0, 1); d < Date.UTC(2028, 0, 1); d += 7 * 3600000 + 13 * 60000) stamps.push(new Date(d).toISOString());
  for (const y of [2025, 2026, 2027]) {
    for (const s of ["03-08T10:59", "03-08T11:00", "03-09T10:59", "03-09T11:00", "03-14T10:59", "03-14T11:00",
      "11-01T09:59", "11-01T10:00", "11-02T09:59", "11-02T10:00", "11-07T09:59", "11-07T10:00"]) stamps.push(`${y}-${s}:00.000Z`);
  }
  const code = `globalThis.Intl = { DateTimeFormat: function () { throw new Error("no zone data"); } };
    const { wallTime } = await import(${JSON.stringify(SCANS_URL)});
    process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(wallTime)));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(stamps)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), stamps.map(wallTime));
});

/* ---------- the event log ---------- */
test("liveScans: well-formed events only, voids and what they void dropped, sorted by time then id", () => {
  const p = job({ equipmentScans: [
    ev("place", "AM-002", "b", 5, { room: "Kitchen" }),
    ev("place", "AM-001", "a", 5, { room: "Kitchen" }),          // same minute: id breaks the tie
    ev("place", "AM-003", "c", 1, { room: "Hall" }),
    ev("remove", "AM-003", "d", 9),
    ev("void", "AM-003", "v1", 10, { voids: "d" }),
    ev("place", "AM-001", "a", 7, { room: "Elsewhere" }),        // a second copy of id a: the first one counts
    { id: "", tag: "AM-009", act: "place", at: at(1) },          // no id
    ev("dance", "AM-009", "x1", 1),                               // unknown act
    ev("place", "AM-009", "x2", 1, { at: "2026-10-08T10:00" }),  // zone-less time
    ev("place", "AM-009", "x3", 1, { at: "" }),
    ev("place", "  ", "x4", 1),                                   // no tag
    ev("void", "AM-009", "x5", 1, { voids: "" }),                // a void of nothing
    null, "junk", 42,
  ] });
  assert.deepEqual(liveScans(p).map((e) => e.id), ["c", "a", "b"]);
  assert.deepEqual(liveScans({}), []);
  assert.deepEqual(liveScans(null), []);
  assert.deepEqual(liveScans({ equipmentScans: "nope" }), []);
});

test("placements: place opens, same room is ignored, another room is a move, remove closes, a later place reopens", () => {
  const p = job({ equipmentScans: [
    ev("place", "AM-014", "p1", 1, { room: "Kitchen", type: "Air mover", model: "Velo Pro", logId: "L1" }),
    ev("place", "AM-14", "p2", 2, { room: " kitchen " }),        // same unit (key), same room: nothing
    ev("place", "am 014", "p3", 3, { room: "Bedroom", by: "b@example.com", tech: "Sam" }),   // a second device's place: a move
    ev("move", "AM-014", "m1", 4, { room: "Bedroom" }),          // already there: nothing
    ev("move", "AM-014", "m2", 5, { room: "Hall" }),
    ev("remove", "AM-014", "r1", 6, { room: "Hall", tech: "Lee" }),
    ev("remove", "AM-014", "r2", 7),                              // not out: nothing
    ev("move", "AM-014", "m3", 8, { room: "Bath" }),              // not out: nothing
    ev("place", "AM-014", "p4", 9, { room: "Bath" }),             // back out: a new placement
    ev("place", "DH-003", "p5", 3, { room: "Kitchen", elsewhere: { jobId: "job-2", label: "Other", since: at(-60) } }),
  ] });
  const ps = placements(p);
  assert.deepEqual(ps.map((x) => x.placeId), ["p1", "p5", "p4"]);
  const [a, dh, again] = ps;
  assert.equal(a.tag, "AM-014");
  assert.equal(a.tagKey, "AM-14");
  assert.equal(a.room, "Hall");
  assert.equal(a.placedRoom, "Kitchen");
  assert.equal(a.type, "Air mover");
  assert.equal(a.model, "Velo Pro");
  assert.equal(a.logId, "L1");
  assert.equal(a.placedAt, at(1));
  assert.deepEqual(a.moves, [
    { id: "p3", at: at(3), room: "Bedroom", by: "b@example.com", tech: "Sam" },
    { id: "m2", at: at(5), room: "Hall", by: "crew@example.com", tech: "Pat Tech" },
  ]);
  assert.equal(a.removeId, "r1");
  assert.equal(a.removedAt, at(6));
  assert.equal(a.removedTech, "Lee");
  assert.equal(a.removedBy, "crew@example.com");
  assert.equal(a.elsewhere, null);
  assert.deepEqual(dh.elsewhere, { jobId: "job-2", label: "Other", since: at(-60) });
  assert.equal(again.removeId, "");
  assert.equal(again.room, "Bath");
  assert.equal(openPlacement(p, "am-14").placeId, "p4");
  assert.equal(openPlacement(p, "RC:DH-3").placeId, "p5");
  assert.equal(openPlacement(p, "HT-001"), null);
  assert.equal(openPlacement(p, ""), null);
});

/* ---------- materializing rows ---------- */
test("a scan replaces the new log's blank seed row with a scanned row in the right shape", () => {
  const p = job();
  const r = recordScan(p, place("RC:AM-014", "Kitchen", "s1", 0, { logId: "L1" }));
  assert.equal(r.outcome, "placed");
  assert.equal(rows(p).length, 1);
  assert.deepEqual(rows(p)[0], {
    asset: "AM-014", type: "Air mover", location: "Kitchen", placed: "2026-10-08T10:00", removed: "", hours: "", notes: "",
    scanId: "s1",
    scan: { placeId: "s1", removeId: "", by: "crew@example.com", tech: "Pat Tech", how: "camera", placedAt: at(0),
      removedAt: "", removedBy: "", removedTech: "", model: "", moves: [], removedTyped: false, endedTyped: false, backAt: "", plan: "" },
  });
  assert.equal(applyScans(p).changed, false, "a second run changes nothing");
  // the existing readers see an ordinary row
  assert.deepEqual(deployedCounts(rows(p)), { airMovers: 1, dehus: 0, scrubbers: 0, heaters: 0 });
});

test("a typed row stays: the blank-row swap is only for the single factory blank", () => {
  const typed = { asset: "101", type: "Air mover", location: "Hall", placed: "2026-10-07T09:00", removed: "", hours: "", notes: "" };
  const p = job({ dryingLogs: [log("L1", [typed])] });
  recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  assert.deepEqual(rows(p).map((r) => r.asset), ["101", "AM-001"]);
  // two blank rows are not "the" seed row either
  const q = job({ dryingLogs: [log("L1", [blankEquipRow(), blankEquipRow()])] });
  recordScan(q, place("AM-001", "Kitchen", "s1", 0));
  assert.equal(rows(q).length, 3);
  // a seed row someone typed a note into is not blank
  const n = job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), notes: "check hall" }])] });
  recordScan(n, place("AM-001", "Kitchen", "s1", 0));
  assert.equal(rows(n).length, 2);
});

test("no drying log: the event is recorded and no log is made; the row appears once a log exists", () => {
  const p = job({ dryingLogs: [] });
  const r = recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  assert.equal(r.outcome, "placed");
  assert.equal(p.equipmentScans.length, 1);
  assert.equal(r.event.logId, "");
  assert.deepEqual(p.dryingLogs, []);
  assert.equal(applyScans(p).changed, false);
  const q = job({ dryingLogs: undefined, equipmentScans: undefined });
  assert.equal(recordScan(q, place("AM-001", "Kitchen", "s1", 0)).outcome, "placed");
  assert.equal(q.dryingLogs, undefined, "never creates the logs array");
  assert.equal(q.equipmentScans.length, 1, "creates the scans array");
  p.dryingLogs.push(log("L9"));
  assert.equal(applyScans(p).changed, true);
  assert.deepEqual(rows(p).map((x) => [x.asset, x.scanId]), [["AM-001", "s1"]]);
});

test("the row goes to the log the scan named, else the first; it is found again in any log", () => {
  const p = job({ dryingLogs: [log("L1", []), log("L2", [])] });
  recordScan(p, place("AM-001", "Kitchen", "s1", 0, { logId: "L2" }));
  recordScan(p, place("AM-002", "Kitchen", "s2", 1, { logId: "gone" }));
  recordScan(p, place("AM-003", "Kitchen", "s3", 2));      // no logId: the first log's id is recorded
  assert.equal(p.equipmentScans[2].logId, "L1");
  assert.deepEqual(rows(p, 0).map((r) => r.asset), ["AM-002", "AM-003"]);
  assert.deepEqual(rows(p, 1).map((r) => r.asset), ["AM-001"]);
  // moved by hand to the other log: it stays there
  rows(p, 1).push(rows(p, 0).shift());
  assert.equal(applyScans(p).changed, false);
  assert.deepEqual(rows(p, 1).map((r) => r.asset), ["AM-001", "AM-002"]);
});

test("locked fields are rewritten every run; location and type are kept when typed, filled when emptied", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  const row = rows(p)[0];
  Object.assign(row, { asset: "AM-15", placed: "2026-10-01T08:00", hours: 99, _manualHrs: true, location: "Kitchen (north wall)", type: "Axial air mover" });
  assert.equal(applyScans(p).changed, true);
  assert.equal(row.asset, "AM-014");
  assert.equal(row.placed, "2026-10-08T10:00");
  assert.equal(row.hours, "");
  assert.equal(row._manualHrs, undefined);
  assert.equal(row.location, "Kitchen (north wall)");
  assert.equal(row.type, "Axial air mover");
  Object.assign(row, { location: " ", type: "" });
  applyScans(p);
  assert.equal(row.location, "Kitchen");
  assert.equal(row.type, "Air mover");
});

test("a remove scan stamps Removed and the hours; undoing it clears both; a typed removal is kept", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  const r = recordScan(p, remove("AM-014", "s2", 25 * 60 + 29));    // 25 h 29 min later
  assert.equal(r.outcome, "removed");
  const row = rows(p)[0];
  assert.equal(row.removed, "2026-10-09T11:29");
  assert.equal(row.hours, 25);
  assert.equal(row.scan.removeId, "s2");
  assert.equal(row.scan.removedAt, at(25 * 60 + 29));
  assert.equal(row.scan.removedTyped, false);
  // the Removed field is the scan's: an edit to it is put back
  row.removed = "2026-10-09T08:00";
  applyScans(p);
  assert.equal(row.removed, "2026-10-09T11:29");
  // undo the remove: the unit is out again
  assert.ok(voidEvent(p, "s2", ctx("v1", 1600)));
  assert.equal(row.removed, "");
  assert.equal(row.hours, "");
  assert.equal(row.scan.removeId, "");
  assert.ok(openPlacement(p, "AM-014"));
  // a removal typed on the row (no scan) stays, with its hours
  row.removed = "2026-10-08T22:31";
  assert.equal(applyScans(p).changed, true);
  assert.equal(row.removed, "2026-10-08T22:31");
  assert.equal(row.hours, 13);
  assert.equal(row.scan.removedTyped, true);
  assert.equal(applyScans(p).changed, false);
  // a removal typed before the placement is not a negative run
  row.removed = "2026-10-08T09:00";
  applyScans(p);
  assert.equal(row.hours, "");
});

test("hours are what a device in Alaska computes, across the fall change (13 real hours, 12 on the wall)", () => {
  const p = job();
  const placedAt = Date.UTC(2026, 10, 1, 8, 0);        // 11-01 00:00 AKDT
  recordScan(p, { ...place("AM-001", "Kitchen", "s1", 0), at: new Date(placedAt).toISOString() });
  recordScan(p, { ...remove("AM-001", "s2", 0), at: new Date(placedAt + 13 * 3600000).toISOString() });
  assert.equal(rows(p)[0].placed, "2026-11-01T00:00");
  assert.equal(rows(p)[0].removed, "2026-11-01T12:00");
  assert.equal(rows(p)[0].hours, 13);
});

test("moves keep the row: a 'moved to' line per move, user notes untouched, an undone move's line taken back", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  const row = rows(p)[0];
  row.notes = "behind the fridge";
  const m = recordScan(p, place("AM-014", "Bedroom", "s2", 270));    // 14:30
  assert.equal(m.outcome, "moved");
  assert.equal(m.event.act, "place", "a move is a place in the new room (it survives another device's remove)");
  assert.equal(m.message, "AM-014 moved Kitchen → Bedroom");
  assert.equal(rows(p).length, 1, "still one row");
  assert.equal(row.location, "Kitchen");
  assert.equal(row.notes, "behind the fridge\nmoved to Bedroom 10/08 14:30");
  recordScan(p, place("AM-014", "Hall", "s3", 24 * 60 + 5));
  assert.equal(row.notes, "behind the fridge\nmoved to Bedroom 10/08 14:30\nmoved to Hall 10/09 10:05");
  assert.deepEqual(row.scan.moves, [{ at: at(270), room: "Bedroom" }, { at: at(24 * 60 + 5), room: "Hall" }]);
  assert.equal(openPlacement(p, "AM-014").room, "Hall");
  assert.equal(applyScans(p).changed, false);
  // undo the first move: its line goes, the person's text and the other line stay
  voidEvent(p, "s2", ctx("v1", 24 * 60 + 10));
  assert.equal(row.notes, "behind the fridge\nmoved to Hall 10/09 10:05");
  assert.deepEqual(row.scan.moves.map((x) => x.room), ["Hall"]);
  // a line the crew typed themselves is never doubled
  const q = job();
  recordScan(q, place("AM-001", "Kitchen", "s1", 0));
  rows(q)[0].notes = "moved to Bath 10/08 11:00 (CJ)\n";
  recordScan(q, place("AM-001", "Bath", "s2", 60));
  assert.equal(rows(q)[0].notes, "moved to Bath 10/08 11:00 (CJ)\n");
});

test("undoing a place takes its row out of the log; other rows stay", () => {
  const p = job();
  recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  recordScan(p, place("AM-002", "Kitchen", "s2", 1));
  const v = voidEvent(p, "s1", ctx("v1", 2));
  assert.equal(v.act, "void");
  assert.equal(v.voids, "s1");
  assert.equal(v.tag, "AM-001", "a void carries the tag it undoes (the audit table needs one)");
  assert.equal(v.how, "");
  assert.equal(v.room, "");
  assert.deepEqual(rows(p).map((r) => r.asset), ["AM-002"]);
  assert.equal(voidEvent(p, "s1", ctx("v2", 3)), null, "already undone");
  assert.equal(voidEvent(p, "v1", ctx("v3", 3)), null, "a void is not undone");
  assert.equal(voidEvent(p, "nope", ctx("v4", 3)), null, "unknown id");
  assert.equal(voidEvent(p, "", ctx("v5", 3)), null);
  assert.equal(p.equipmentScans.length, 3, "nothing pushed for the refusals");
  assert.equal(p.equipmentScans.find((e) => e.id === "s1").act, "place", "the voided event itself is never edited");
});

test("voidPlacement undoes the whole row: place, moves and remove each get a void", () => {
  const p = job();
  recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  recordScan(p, place("AM-001", "Bath", "s2", 5));
  recordScan(p, remove("AM-001", "s3", 9));
  recordScan(p, place("AM-002", "Kitchen", "s4", 10));
  const voids = voidPlacement(p, "s1", ctx("v1", 11));
  assert.deepEqual(voids.map((x) => [x.id, x.voids]), [["v1", "s1"], ["v1-1", "s2"], ["v1-2", "s3"]]);
  assert.ok(voids.every((x) => x.act === "void" && x.tag === "AM-001"));
  assert.deepEqual(rows(p).map((r) => r.asset), ["AM-002"]);
  assert.deepEqual(liveScans(p).map((e) => e.id), ["s4"]);
  assert.deepEqual(voidPlacement(p, "s1", ctx("v9", 12)), [], "nothing left to undo");
  assert.deepEqual(voidPlacement(p, "zzz", ctx("v9", 12)), []);
  // AM-001 can go out again
  assert.equal(recordScan(p, place("AM-001", "Hall", "s5", 13)).outcome, "placed");
});

test("rows left behind are cleaned: a voided placement's row, and a second copy after a merge", () => {
  const p = job({ dryingLogs: [log("L1", []), log("L2", [])] });
  recordScan(p, place("AM-001", "Kitchen", "s1", 0, { logId: "L2" }));
  const copy = clone(rows(p, 1)[0]);
  rows(p, 0).push(copy, clone(copy));                    // two strays in the other log
  rows(p, 1).push(clone(copy));                          // and a twin in its own log
  assert.equal(applyScans(p).changed, true);
  assert.equal(rows(p, 0).length, 0);
  assert.equal(rows(p, 1).length, 1);
  // a scanned row whose event this copy doesn't hold at all (a copy an older
  // build wrote without the scan log) is the drying record: it stays, once,
  // untouched, and comes back under the scans' control when they return
  const ghost = { ...clone(copy), scanId: "ghost", notes: "typed note", scan: { ...copy.scan, placeId: "ghost" } };
  rows(p, 0).push(ghost, clone(ghost));
  assert.equal(applyScans(p).changed, true);
  assert.deepEqual(rows(p, 0), [ghost]);
  assert.equal(applyScans(p).changed, false);
  const saved = clone(p.equipmentScans);
  p.equipmentScans = [];
  assert.equal(applyScans(p).changed, false, "a lost scan log takes no rows with it");
  assert.equal(scanned(p).length, 2);
  p.equipmentScans = saved;
  assert.equal(applyScans(p).changed, false);
  // …but a tombstoned event's row goes: that delete was meant
  tombstoneItems(p, ["ghost"]);
  assert.equal(applyScans(p).changed, true);
  assert.deepEqual(rows(p, 0), []);
  assert.equal(rows(p, 1).length, 1);
});

test("applyScans on a job with no scans and no scanned rows touches nothing", () => {
  const typed = { asset: "1", type: "Air mover", location: "Hall", placed: "2026-10-07T09:00", removed: "", hours: 7, notes: "", _manualHrs: true };
  const p = job({ dryingLogs: [log("L1", [typed])] });
  delete p.equipmentScans;
  const before = clone(p);
  assert.equal(applyScans(p).changed, false);
  assert.deepEqual(p, before);
  assert.deepEqual(applyScans(null), { changed: false });
  assert.deepEqual(applyScans({}), { changed: false });
});

/* ---------- recordScan ---------- */
test("recordScan: placed writes a complete event and a short message", () => {
  const p = job();
  const r = recordScan(p, place("am 14", "  Kitchen ", "s1", 0, { how: "typed", elsewhere: null }));
  assert.equal(r.outcome, "placed");
  assert.equal(r.message, "AM-014 Air mover → Kitchen");
  assert.deepEqual(r.event, {
    id: "s1", tag: "AM-014", act: "place", at: at(0), room: "Kitchen", type: "Air mover", model: "", logId: "L1",
    voids: "", how: "typed", by: "crew@example.com", tech: "Pat Tech", build: "v208",
  });
  assert.equal(p.equipmentScans[0], r.event);
  assert.equal(r.placement.placeId, "s1");
  assert.equal(r.placement.room, "Kitchen");
});

test("recordScan: the outcomes that record nothing", () => {
  const p = job();
  const none = (r, outcome) => { assert.equal(r.outcome, outcome); assert.equal(r.event, null); };
  none(recordScan(p, place("hello", "Kitchen", "x", 0)), "invalid");
  assert.equal(recordScan(p, place("", "Kitchen", "x", 0)).message, "That isn't a tag (example AM-014)");
  none(recordScan(p, place("AM-001", "", "x", 0)), "need_room");
  none(recordScan(p, place("AM-001", "   ", "x", 0)), "need_room");
  none(recordScan(p, place("101", "Kitchen", "x", 0)), "need_type");
  assert.match(recordScan(p, place("101", "Kitchen", "x", 0)).message, /101/);
  none(recordScan(p, place("101", "Kitchen", "x", 0, { typeCode: "spaceship" })), "need_type");
  none(recordScan(p, remove("AM-001", "x", 0)), "not_here");
  assert.equal(recordScan(p, remove("AM-001", "x", 0)).message, "AM-001 isn't out on this job");
  recordScan(p, place("AM-001", "Kitchen", "s1", 1));
  const again = recordScan(p, place("RC:AM-1", "kitchen", "x", 2));
  none(again, "already");
  assert.equal(again.message, "AM-001 is already in Kitchen");
  assert.equal(again.placement.placeId, "s1");
  none(recordScan(null, place("AM-001", "Kitchen", "x", 0)), "invalid");
  assert.equal(p.equipmentScans.length, 1);
});

test("recordScan: a numeric tag takes its type from the pick or the fleet row, and shows the fleet's tag and model", () => {
  const p = job();
  const picked = recordScan(p, place("101", "Kitchen", "s1", 0, { typeCode: "dehu_lgr" }));
  assert.equal(picked.outcome, "placed");
  assert.equal(picked.event.type, "LGR dehumidifier");
  const unit = { id: "u1", tag: "0102", type: "air_scrubber", make: "Phoenix", model: "Guardian", rating: "500 CFM", owned: "owned", status: "active" };
  const fleet = recordScan(p, place("RC:102", "Hall", "s2", 1, { unit }));
  assert.equal(fleet.event.tag, "0102");
  assert.equal(fleet.event.type, "Air scrubber");
  assert.equal(fleet.event.model, "Phoenix Guardian · 500 CFM");
  assert.equal(fleet.message, "0102 Air scrubber → Hall");
  // the explicit pick beats the fleet row, the fleet row beats the prefix
  const both = recordScan(p, place("AM-7", "Hall", "s3", 2, { unit: { tag: "AM-007", type: "heater" }, typeCode: "other" }));
  assert.equal(both.event.type, "Other");
  const byUnit = recordScan(p, place("AM-8", "Hall", "s4", 3, { unit: { tag: "AM-008", type: "heater" } }));
  assert.equal(byUnit.event.type, "Heater");
  // a fleet row for another tag is not used for the display tag
  const stray = recordScan(p, place("AM-9", "Hall", "s5", 4, { unit: { tag: "DH-001", type: "dehumidifier" } }));
  assert.equal(stray.event.tag, "AM-009");
  assert.deepEqual(rows(p).map((r) => [r.asset, r.type]), [
    ["101", "LGR dehumidifier"], ["0102", "Air scrubber"], ["AM-007", "Other"], ["AM-008", "Heater"], ["AM-009", "Dehumidifier"],
  ]);
});

test("recordScan: a unit out on another job is still placed, with the other job noted", () => {
  const p = job();
  const elsewhere = { jobId: "job-2", label: "Other Customer", since: at(-600), room: "Garage" };
  const r = recordScan(p, place("DH-003", "Kitchen", "s1", 0, { elsewhere }));
  assert.equal(r.outcome, "placed");
  assert.deepEqual(r.event.elsewhere, { jobId: "job-2", label: "Other Customer", since: at(-600) });
  assert.equal(r.message, "DH-003 Dehumidifier → Kitchen (still out on Other Customer)");
  assert.deepEqual(r.placement.elsewhere, r.event.elsewhere);
});

test("recordScan: remove reports the room; ids are never reused; a missing time falls back to now", () => {
  const p = job();
  recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  const r = recordScan(p, remove("AM-001", "s1", 5));      // the caller's id is taken: a fresh one is made
  assert.equal(r.outcome, "removed");
  assert.equal(r.message, "AM-001 removed from Kitchen");
  assert.notEqual(r.event.id, "s1");
  assert.equal(new Set(p.equipmentScans.map((e) => e.id)).size, 2);
  assert.equal(r.event.room, "Kitchen");
  assert.equal(r.placement.removeId, r.event.id);
  const q = job();
  const t = Date.now();
  const s = recordScan(q, { tag: "AM-001", mode: "place", room: "Kitchen" });
  assert.equal(s.outcome, "placed");
  assert.ok(s.event.id);
  assert.ok(Math.abs(Date.parse(s.event.at) - t) < 60000);
  assert.ok(s.event.at.endsWith("Z"));
});

/* ---------- determinism ---------- */
// a job with a placement, a move, a remove and a typed removal across the fall change
function busyJob() {
  const p = job({ dryingLogs: [log("L1")] });
  const base = Date.UTC(2026, 9, 31, 20, 17, 42, 123);
  const t = (h) => new Date(base + h * 3600000).toISOString();
  recordScan(p, { ...place("AM-001", "Kitchen", "a1", 0), at: t(0) });
  recordScan(p, { ...place("AM-002", "Kitchen", "a2", 0), at: t(0.1) });
  recordScan(p, { ...place("DH-001", "Basement", "a3", 0), at: t(0.2) });
  recordScan(p, { ...place("AM-001", "Bedroom", "a4", 0), at: t(14.5) });
  recordScan(p, { ...remove("AM-002", "a5", 0), at: t(30.25) });
  rows(p)[2].removed = "2026-11-02T08:00";
  applyScans(p);
  return p;
}
const SCRIPT = `const m = await import(${JSON.stringify(SCANS_URL)});
  const p = JSON.parse(process.argv[1]);
  for (const log of p.dryingLogs) log.equipment = [];
  m.applyScans(p);
  p.dryingLogs[0].equipment[2].removed = "2026-11-02T08:00";
  m.applyScans(p);
  process.stdout.write(JSON.stringify({ rows: p.dryingLogs, record: m.scanRecord(p), wall: m.wallTime("2026-11-01T09:30:00.000Z") }));`;

test("the rows are the same bytes in any device time zone (UTC worker, Alaska phone, elsewhere)", () => {
  const p = busyJob();
  const local = (() => {
    const q = clone(p);
    for (const l of q.dryingLogs) l.equipment = [];
    applyScans(q);
    q.dryingLogs[0].equipment[2].removed = "2026-11-02T08:00";
    applyScans(q);
    return JSON.stringify({ rows: q.dryingLogs, record: scanRecord(q), wall: wallTime("2026-11-01T09:30:00.000Z") });
  })();
  const outs = new Set([local]);
  for (const TZ of ["UTC", "America/Anchorage", "Asia/Tokyo", "Pacific/Kiritimati", "America/New_York"]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT, JSON.stringify(p)], { encoding: "utf8", env: { ...process.env, TZ } });
    assert.equal(r.status, 0, r.stderr);
    outs.add(r.stdout);
  }
  assert.equal(outs.size, 1, "every zone derives the same rows");
  const { rows: logs } = JSON.parse(local);
  assert.deepEqual(logs[0].equipment.map((r) => [r.asset, r.placed, r.removed, r.hours]), [
    ["AM-001", "2026-10-31T12:17", "", ""],
    ["AM-002", "2026-10-31T12:23", "2026-11-01T17:32", 30],
    ["DH-001", "2026-10-31T12:29", "2026-11-02T08:00", 45],      // 43.5 h on the wall + the hour the fall change repeats
  ]);
  assert.match(logs[0].equipment[0].notes, /^moved to Bedroom 11\/01 01:47$/);
});

test("applyScans is idempotent and the rows are rebuilt the same however they were lost", () => {
  const p = busyJob();
  assert.equal(applyScans(p).changed, false);
  const want = JSON.stringify(scanned(p).map(({ notes, ...r }) => r));
  const q = clone(p);
  q.dryingLogs[0].equipment = [blankEquipRow()];
  assert.equal(applyScans(q).changed, true);
  assert.equal(applyScans(q).changed, false);
  // the typed removal lived only on the lost row; everything the scans say comes back identical
  const got = scanned(q).map(({ notes, ...r }) => r);
  got[2].removed = "2026-11-02T08:00"; got[2].hours = 45; got[2].scan.removedTyped = true;
  assert.equal(JSON.stringify(got), want);
  assert.equal(scanned(q)[0].notes, scanned(p)[0].notes);
  assert.equal(rows(q).length, 3, "the seed blank gave way");
});

test("two devices scanning the same log offline: the union keeps both sides' units, the same on both", () => {
  const start = job({ dryingLogs: [log("L1")] });
  const a = clone(start), b = clone(start);
  recordScan(a, place("AM-001", "Kitchen", "a1", 0));
  recordScan(a, place("AM-002", "Kitchen", "a2", 1));
  a.updatedAt = "2026-10-08T18:05:00.000Z";
  recordScan(b, place("DH-001", "Basement", "b1", 2));
  rows(b)[0].notes = "typed on the tablet";
  recordScan(b, place("AM-001", "Bedroom", "b2", 3));     // B saw A's unit in the bedroom: no open placement on B, so a place
  b.updatedAt = "2026-10-08T18:09:00.000Z";
  const ab = mergeProjects(a, b).merged, ba = mergeProjects(b, a).merged;
  assert.equal(ab.equipmentScans.length, 4);
  assert.deepEqual(rows(ab).map((r) => r.asset), ["DH-001", "AM-001"], "B's newer log won whole: A's rows are gone");
  applyScans(ab); applyScans(ba);
  assert.equal(JSON.stringify(ab.dryingLogs), JSON.stringify(ba.dryingLogs));
  // A placed AM-001 first; B's later place in another room reads as a move of that one unit
  assert.deepEqual(rows(ab).map((r) => [r.asset, r.scanId, r.location]), [
    ["DH-001", "b1", "Basement"], ["AM-001", "a1", "Kitchen"], ["AM-002", "a2", "Kitchen"],
  ]);
  assert.equal(rows(ab)[0].notes, "typed on the tablet");
  assert.equal(rows(ab)[1].notes, "moved to Bedroom 10/08 10:03");
  assert.equal(placements(ab).length, 3);
  assert.equal(applyScans(ab).changed, false);
});

test("an undo on one device reaches the other through the union; a tombstoned event is gone everywhere", () => {
  const start = job();
  recordScan(start, place("AM-001", "Kitchen", "s1", 0));
  recordScan(start, place("AM-002", "Kitchen", "s2", 1));
  const a = clone(start), b = clone(start);
  voidEvent(a, "s1", ctx("v1", 5));
  a.updatedAt = "2026-10-08T18:01:00.000Z";
  rows(b)[0].notes = "edited later on B";
  b.updatedAt = "2026-10-08T18:09:00.000Z";
  const m = mergeProjects(a, b).merged;
  assert.deepEqual(rows(m).map((r) => r.asset), ["AM-001", "AM-002"], "B's newer log still holds the undone row");
  applyScans(m);
  assert.deepEqual(rows(m).map((r) => r.asset), ["AM-002"]);
  assert.ok(ID_COLLECTIONS.includes("equipmentScans"));
  const t = clone(start);
  tombstoneItems(t, ["s2"]);
  t.equipmentScans = t.equipmentScans.filter((e) => e.id !== "s2");
  t.updatedAt = "2026-10-08T18:00:30.000Z";
  const n = mergeProjects(t, b).merged;
  assert.deepEqual(n.equipmentScans.map((e) => e.id), ["s1"]);
  applyScans(n);
  assert.deepEqual(rows(n).map((r) => r.asset), ["AM-001"]);
});

test("newProject starts an empty scan log", () => {
  assert.deepEqual(newProject().equipmentScans, []);
});

/* ---------- across jobs, print, rooms ---------- */
test("openElsewhere finds the unit on another job from its scans or its typed rows, most recent first", () => {
  const here = job({ id: "here" });
  recordScan(here, place("AM-014", "Kitchen", "h1", 0));
  const scannedJob = job({ id: "j2", customer: "Scan Customer" });
  recordScan(scannedJob, place("AM-14", "Garage", "x1", -300));
  const typedJob = job({ id: "j3", customer: "", address: "9 Typed Rd", dryingLogs: [log("T", [
    { asset: "am-014", type: "Air mover", location: "Den", placed: "2026-10-08T06:00", removed: "", hours: "", notes: "" },
  ])] });
  const pulled = job({ id: "j4", dryingLogs: [log("T", [
    { asset: "AM-014", type: "Air mover", location: "Den", placed: "2026-10-08T07:00", removed: "2026-10-08T08:00", hours: 1, notes: "" },
  ])] });
  const archived = job({ id: "j5", archivedAt: "2026-10-01" });
  recordScan(archived, place("AM-014", "Den", "z1", 30));
  const deleted = job({ id: "j6", deleted: true });
  recordScan(deleted, place("AM-014", "Den", "z2", 40));
  const all = [here, scannedJob, typedJob, pulled, archived, deleted, null];
  assert.deepEqual(openElsewhere(all, "RC:AM-014", "here", T0), { jobId: "j3", label: "9 Typed Rd", since: "2026-10-08T14:00:00.000Z", room: "Den" });
  assert.deepEqual(openElsewhere([here, scannedJob], "AM-014", "here"), { jobId: "j2", label: "Scan Customer", since: at(-300), room: "Garage" });
  assert.equal(openElsewhere([here], "AM-014", "here"), null);
  assert.equal(openElsewhere(all, "AM-099", "here"), null);
  assert.equal(openElsewhere(all, "", "here"), null);
  assert.equal(openElsewhere([job({ id: "j7", customer: "", address: "" , dryingLogs: [log("T", [{ asset: "101", placed: "2026-10-08T05:00", removed: "" }])] })], "101", "here").label, "another job");
  // removed on the other job: not out there
  recordScan(scannedJob, remove("AM-014", "x2", -200));
  assert.equal(openElsewhere([here, scannedJob], "AM-014", "here"), null);
});

test("scanRecord lists every live event in time order, on the Alaska clock, typed for moves and removes", () => {
  const p = job();
  recordScan(p, place("AM-001", "Kitchen", "s1", 0, { how: "camera" }));
  recordScan(p, place("AM-002", "Kitchen", "s2", 1, { how: "typed", tech: "Sam" }));
  recordScan(p, place("AM-001", "Bath", "s3", 62, { how: "photo" }));
  recordScan(p, remove("AM-001", "s4", 125));
  voidEvent(p, "s2", ctx("v1", 126));
  assert.deepEqual(scanRecord(p), [
    { at: "2026-10-08T10:00", tag: "AM-001", type: "Air mover", act: "place", room: "Kitchen", how: "camera", tech: "Pat Tech", by: "crew@example.com" },
    { at: "2026-10-08T11:02", tag: "AM-001", type: "Air mover", act: "move", room: "Bath", how: "photo", tech: "Pat Tech", by: "crew@example.com" },
    { at: "2026-10-08T12:05", tag: "AM-001", type: "Air mover", act: "remove", room: "Bath", how: "camera", tech: "Pat Tech", by: "crew@example.com" },
  ]);
  assert.deepEqual(scanRecord(job()), []);
});

test("roomSuggestions: scanned rooms, row locations, the room list, Magicplan rooms, moisture-map labels — each once", () => {
  const p = job({
    rooms: ["Living Room", "kitchen", ""],
    floorPlan: { dimensions: { rooms: [{ name: "Primary Bedroom", floorSF: 100 }, { name: " living room " }, {}], notes: [] } },
    moistureMaps: [{ id: "m1", label: "Basement" }, { id: "m2", label: "" }],
    dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "1", type: "Air mover", location: "Hall  closet" }])],
  });
  recordScan(p, place("AM-001", "Kitchen", "s1", 0));
  recordScan(p, place("AM-002", "Bath", "s2", 1));
  recordScan(p, place("AM-001", "Laundry", "s3", 2));
  recordScan(p, place("AM-003", "Gone", "s4", 3));
  voidEvent(p, "s4", ctx("v1", 4));
  assert.deepEqual(roomSuggestions(p), ["Kitchen", "Bath", "Laundry", "Hall closet", "Living Room", "Primary Bedroom", "Basement"]);
  assert.deepEqual(roomSuggestions(job({ dryingLogs: [] })), []);
  assert.deepEqual(roomSuggestions(null), []);
});

/* ---------- review fixes: key order, clock skew, offline moves, typed rows ---------- */
// Postgres jsonb keeps object keys sorted by length, then bytes: what a copy looks like after the server
const jsonbOrder = (v) => Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === "object"
  ? Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).reduce((o, k) => { o[k] = jsonbOrder(v[k]); return o; }, {}) : v;

test("a copy back from the server (jsonb key order) is not a change: no push owed, no loop", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  recordScan(p, place("AM-014", "Bath", "s2", 30));
  recordScan(p, remove("AM-014", "s3", 60));
  const back = jsonbOrder(clone(p));
  assert.notEqual(JSON.stringify(back.dryingLogs), JSON.stringify(p.dryingLogs), "the key order really differs");
  assert.equal(applyScans(back).changed, false);
  assert.equal(applyScans(back).changed, false);
});

test("a remove or move from a device whose clock is behind still lands after the place", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 60));
  const r = recordScan(p, remove("AM-014", "s2", 59));             // the second phone runs a minute slow
  assert.equal(r.outcome, "removed");
  assert.equal(openPlacement(p, "AM-014"), null, "the unit really is out");
  assert.ok(Date.parse(r.event.at) > Date.parse(at(60)), r.event.at);
  assert.equal(rows(p)[0].removed, "2026-10-08T11:00");
  const q = job();
  recordScan(q, place("AM-014", "Kitchen", "s1", 60));
  const m = recordScan(q, place("AM-014", "Bath", "s2", 30));
  assert.equal(m.outcome, "moved");
  assert.equal(openPlacement(q, "AM-014").room, "Bath");
});

test("a move made offline after another device's remove puts the unit back on the log in the new room", () => {
  const base = job();
  recordScan(base, place("AM-020", "Kitchen", "s1", 0));
  const a = clone(base), b = clone(base);
  recordScan(a, remove("AM-020", "s2", 60));                      // online phone pulls it
  const mv = recordScan(b, place("AM-020", "Bath", "s3", 90));   // offline phone still shows it out: moves it
  assert.equal(mv.outcome, "moved");
  b.updatedAt = "2026-10-08T20:00:00.000Z";
  const { merged } = mergeProjects(a, b);
  applyScans(merged);
  const out = scanned(merged).map((r) => [r.asset, r.location, r.placed, r.removed]);
  assert.deepEqual(out, [["AM-020", "Kitchen", "2026-10-08T10:00", "2026-10-08T11:00"], ["AM-020", "Bath", "2026-10-08T11:30", ""]]);
  assert.equal(openPlacement(merged, "AM-020").room, "Bath");
});

test("a Removed typed on a scanned row is its removal: Remove changes nothing, a Place starts a new row that says so", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  rows(p)[0].removed = "2026-10-08T13:00";                       // pulled without a scan, time typed
  applyScans(p);
  assert.equal(openElsewhere([{ ...p, id: "job-1" }], "AM-014", "job-2", Date.parse(at(24 * 60))), null, "not 'still listed' anywhere");
  const again = recordScan(p, remove("AM-014", "s2", 24 * 60));
  assert.equal(again.outcome, "already");
  assert.equal(again.message, "AM-014 is already marked removed (10/08 13:00)");
  assert.equal(p.equipmentScans.length, 1, "nothing recorded");
  assert.equal(rows(p)[0].removed, "2026-10-08T13:00", "the typed time stands");
  const back = recordScan(p, place("AM-014", "Kitchen", "s3", 24 * 60));
  assert.equal(back.outcome, "placed", "back on the job: a new placement, not 'already'");
  assert.deepEqual(p.equipmentScans.map((e) => [e.act, e.how, e.after || "", e.endedAt || ""]),
    [["place", "camera", "", ""], ["place", "camera", "s1", "2026-10-08T21:00:00.000Z"]], "no event pretends the typed time was scanned");
  assert.deepEqual(scanned(p).map((r) => [r.placed, r.removed, r.scan.removeId]), [["2026-10-08T10:00", "2026-10-08T13:00", ""], ["2026-10-09T10:00", "", ""]]);
  assert.equal(recordScan(p, remove("AM-014", "s4", 25 * 60)).outcome, "removed", "the new row is the open one");
  assert.deepEqual(scanned(p).map((r) => [r.placed, r.removed]), [["2026-10-08T10:00", "2026-10-08T13:00"], ["2026-10-09T10:00", "2026-10-09T11:00"]]);
  // ✕ on the old row takes off only that row
  voidPlacement(p, "s1", ctx("v1", 26 * 60));
  assert.deepEqual(scanned(p).map((r) => [r.placed, r.removed]), [["2026-10-09T10:00", "2026-10-09T11:00"]]);
});

test("a typed removal a newer copy of the log lost comes back from the event that ended it", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  const stale = clone(p);
  rows(p)[0].removed = "2026-10-08T13:00";
  applyScans(p);
  recordScan(p, place("AM-014", "Bath", "s2", 24 * 60));
  stale.dryingLogs[0].readings = [{ id: "r1" }];                 // the other phone's later edit of the same log
  stale.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[p, stale], [stale, p]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.deepEqual(scanned(merged).map((r) => [r.location, r.placed, r.removed]),
      [["Kitchen", "2026-10-08T10:00", "2026-10-08T13:00"], ["Bath", "2026-10-09T10:00", ""]]);
  }
});

test("a Removed typed ahead of time is a planned pickup: the unit is still out, a move moves it, the Remove scan replaces it", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  rows(p)[0].removed = "2026-10-10T09:00";
  applyScans(p);
  assert.ok(openElsewhere([{ ...p, id: "job-1" }], "AM-014", "job-2", Date.parse(at(60))), "still listed here");
  assert.equal(recordScan(p, place("AM-014", "Kitchen", "s2", 30)).outcome, "already");
  assert.equal(recordScan(p, place("AM-014", "Bath", "s3", 60)).outcome, "moved");
  const r = recordScan(p, remove("AM-014", "s4", 24 * 60));
  assert.equal(r.outcome, "removed");
  assert.deepEqual(scanned(p).map((x) => [x.placed, x.removed]), [["2026-10-08T10:00", "2026-10-09T10:00"]]);
});

test("a move one phone made and a remove another stamped a few minutes earlier: the unit is out, not back", () => {
  const base = job();
  recordScan(base, place("AM-020", "Kitchen", "s1", 0));
  const a = clone(base), b = clone(base);
  recordScan(b, place("AM-020", "Bath", "s2", 30));             // right clock: moved at 10:30
  recordScan(a, remove("AM-020", "s3", 27));                     // pulled at 10:32, but this clock is 5 minutes slow
  for (const [x, y] of [[a, b], [b, a]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.deepEqual(scanned(merged).map((r) => [r.location, r.placed, r.removed]), [["Kitchen", "2026-10-08T10:00", "2026-10-08T10:27"]]);
    assert.equal(openPlacement(merged, "AM-020"), null);
    assert.deepEqual(scanRecord(merged).map((r) => r.act), ["place", "remove", "move"], "the move is still on the record");
  }
});

test("a hand-typed row stays a typed row: Remove fills in Removed and Hrs, Place elsewhere notes the move, never a second row", () => {
  const typed = (extra = {}) => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "am 14", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "behind fridge", ...extra }])] });
  const p = typed();
  const same = recordScan(p, place("AM-014", "kitchen", "s1", 0));
  assert.equal(same.outcome, "already");
  assert.equal(same.message, "AM-014 is already on this log in Kitchen (typed row)");
  assert.deepEqual(p.equipmentScans, [], "same room: nothing recorded");
  const r = recordScan(p, remove("AM-014", "s2", 0));
  assert.equal(r.outcome, "removed");
  assert.equal(r.message, "AM-014 removed from Kitchen (typed row)");
  assert.deepEqual([r.event.act, r.event.room, r.event.onRow], ["remove", "Kitchen", { placed: "2026-10-05T09:00" }], "kept like any scan");
  assert.deepEqual(placements(p), [], "never a placement");
  assert.equal(rows(p).length, 1);
  const row = rows(p)[0];
  assert.deepEqual([row.asset, row.placed, row.removed, row.hours, row.notes, !!row.scanId], ["am 14", "2026-10-05T09:00", "2026-10-08T10:00", 73, "behind fridge", false]);
  assert.equal(recordScan(p, remove("AM-014", "s3", 5)).outcome, "not_here", "once removed, it is not out");
  assert.equal(scanRecord(p, []).length, 0, "only a log's own record has it");
  assert.deepEqual(scanRecord(p, [], "L1").map((x) => [x.tag, x.act, x.room]), [["AM-014", "remove", "Kitchen"]]);
  assert.deepEqual(row.scanFill, { removeId: "s2", removed: "2026-10-08T10:00", was: { removed: "", hours: "", manualHrs: null }, moves: [] },
    "the row keeps what the scan replaced");
  // the card's Undo voids the scan and puts the row back as it was typed
  assert.equal(undoTyped(p, r, ctx("v1", 1)), "restored");
  assert.deepEqual([row.removed, row.hours, row.notes], ["", "", "behind fridge"]);
  assert.equal(applyScans(p).changed, false, "a voided scan never fills it again");
  assert.equal(undoTyped(p, r, ctx("v2", 2)), "", "already undone");

  const q = typed();
  const mv = recordScan(q, place("AM-014", "Bath", "s1", 0));
  assert.equal(mv.outcome, "moved");
  assert.equal(mv.message, "AM-014 moved Kitchen → Bath (typed row)");
  assert.equal(rows(q).length, 1, "one row for one machine");
  assert.equal(rows(q)[0].location, "Kitchen");
  assert.equal(rows(q)[0].notes, "behind fridge\nmoved to Bath 10/08 10:00");
  assert.equal(rowRoom(rows(q)[0]), "Bath");
  assert.equal(recordScan(q, place("AM-014", "bath", "s2", 5)).outcome, "already", "it is in the Bath now");
  assert.equal(recordScan(q, place("AM-014", "Hall", "s3", 10)).message, "AM-014 moved Bath → Hall (typed row)");
  assert.deepEqual(deployedCounts(rows(q)), deployedCounts([{ type: "Air mover" }]));

  assert.equal(recordScan(typed({ location: "" }), place("AM-014", "Kitchen", "s1", 0)).outcome, "already", "a typed row with no room is not moved from nowhere");
  assert.equal(recordScan(typed(), remove("AM-015", "s9", 0)).outcome, "not_here", "another unit is still not here");
  // a typed row whose run is done (Hrs TYPED, or a Removed that has passed) is not out: a scan starts a new row
  for (const done of [{ hours: "72", _manualHrs: true }, { removed: "2026-10-06T09:00" }]) {
    const d = typed(done);
    assert.equal(recordScan(d, remove("AM-014", "s1", 0)).outcome, "not_here");
    assert.equal(recordScan(d, place("AM-014", "Kitchen", "s2", 0)).outcome, "placed");
    assert.equal(rows(d).length, 2, "the typed run and the new one");
    assert.deepEqual([rows(d)[0].hours, rows(d)[0].removed], [done.hours || "", done.removed || ""], "the typed row is untouched");
  }
  // Hrs the page worked out from a Removed since cleared are not a typed run: still out
  const left = typed({ hours: 120 });
  assert.equal(rowOutAt(rows(left)[0], T0), true);
  assert.equal(recordScan(left, remove("AM-014", "s1", 0)).outcome, "removed");
  // a planned pickup typed on the row: the unit is out until then, and the Remove scan replaces the plan
  const plan = typed({ removed: "2026-10-12T09:00", hours: 168 });
  const pr = recordScan(plan, remove("AM-014", "s1", 0));
  assert.equal(pr.outcome, "removed");
  assert.deepEqual([rows(plan)[0].removed, rows(plan)[0].hours], ["2026-10-08T10:00", 73]);
  assert.equal(undoTyped(plan, pr, ctx("v1", 1)), "restored");
  assert.deepEqual([rows(plan)[0].removed, rows(plan)[0].hours], ["2026-10-12T09:00", 168]);
  // and another job sees a typed row's planned pickup as out, a passed one as in, a typed-Hrs run as in
  const other = (extra) => [{ ...typed(extra), id: "job-1" }];
  assert.ok(openElsewhere(other({ removed: "2026-10-12T09:00" }), "AM-014", "job-2", T0));
  assert.equal(openElsewhere(other({ removed: "2026-10-06T09:00" }), "AM-014", "job-2", T0), null);
  assert.equal(openElsewhere(other({ hours: "72", _manualHrs: true }), "AM-014", "job-2", T0), null);
  assert.equal(openElsewhere(other({ notes: "moved to Hall 10/06 08:00" }), "AM-014", "job-2", T0).room, "Hall");
});

test("a typed row's scan survives another phone's newer copy of the log; what the crew types after it wins", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-014", type: "Air mover", location: "Kitchen", placed: "2026-10-01T09:00" }])] });
  const a = typed(), b = typed();
  recordScan(a, remove("AM-014", "s1", 0));
  b.dryingLogs[0].readings = [{ id: "r1" }];                     // the other phone's later save of the same log
  b.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a, b], [b, a]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.deepEqual(rows(merged).map((r) => [r.removed, r.hours, !!r.scanId]), [["2026-10-08T10:00", 169, false]]);
    assert.equal(applyScans(merged).changed, false);
    assert.equal(applyScans(jsonbOrder(clone(merged))).changed, false, "and the server's key order is no change");
  }
  // the crew clears or retypes Removed: the scan is voided, so no copy fills it back
  const { merged } = mergeProjects(clone(a), clone(b));
  applyScans(merged);
  const row = rows(merged)[0];
  row.removed = "";
  const v = releaseTypedScans(merged, row, ctx("v1", 5));
  assert.deepEqual(v.map((e) => [e.act, e.voids]), [["void", "s1"]]);
  assert.equal(applyScans(merged).changed, false, "not filled back");
  const again = mergeProjects(clone(merged), clone(a)).merged;
  applyScans(again);
  assert.equal(rows(again)[0].removed, "", "not even from a copy that still has the fill");
  assert.deepEqual(releaseTypedScans(merged, row, ctx("v2", 6)), [], "nothing left to void");
});

test("Undo of a typed row's scan after a sync swapped the row object: found again by tag and Placed; left alone if it changed", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const p = typed();
  const r = recordScan(p, remove("AM-030", "s1", 0));
  p.dryingLogs[0].equipment = clone(p.dryingLogs[0].equipment);   // a graft replaces every row object
  assert.equal(undoTyped(p, r, ctx("v1", 1)), "restored");
  assert.equal(rows(p)[0].removed, "");
  const q = typed();
  const r2 = recordScan(q, remove("AM-030", "s1", 0));
  rows(q)[0].removed = "2026-10-08T09:30";                        // corrected by hand since
  assert.equal(undoTyped(q, r2, ctx("v1", 1)), "voided");
  assert.equal(rows(q)[0].removed, "2026-10-08T09:30", "the hand correction stands");
});

test("a remove scan over a planned pickup on a scanned row: undoing it puts the plan back", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  rows(p)[0].removed = "2026-10-10T09:00";
  applyScans(p);
  recordScan(p, remove("AM-014", "s2", 60));
  assert.equal(rows(p)[0].removed, "2026-10-08T11:00");
  voidEvent(p, "s2", ctx("v1", 61));
  assert.deepEqual([rows(p)[0].removed, rows(p)[0].hours], ["2026-10-10T09:00", 47]);
});

test("the old row's Removed is marked ended once the unit is scanned back in", () => {
  const p = job();
  recordScan(p, place("AM-014", "Kitchen", "s1", 0));
  rows(p)[0].removed = "2026-10-08T13:00";
  applyScans(p);
  assert.equal(rows(p)[0].scan.endedTyped, false);
  recordScan(p, place("AM-014", "Kitchen", "s2", 24 * 60));
  assert.deepEqual(scanned(p).map((r) => r.scan.endedTyped), [true, false]);
  voidPlacement(p, "s2", ctx("v1", 24 * 60 + 1));                // ✕ the newer row: the old one is open to edits again
  assert.deepEqual(scanned(p).map((r) => [r.removed, r.scan.endedTyped]), [["2026-10-08T13:00", false]]);
});

test("✕ on a row whose move another device's remove overtook takes that move with it", () => {
  const base = job();
  recordScan(base, place("AM-020", "Kitchen", "s1", 0));
  const a = clone(base), b = clone(base);
  recordScan(b, place("AM-020", "Bath", "s2", 30));
  recordScan(a, remove("AM-020", "s3", 27));
  const { merged } = mergeProjects(a, b);
  applyScans(merged);
  voidPlacement(merged, "s1", ctx("v1", 40));
  assert.deepEqual(scanned(merged), [], "no new open row in the Bath");
  assert.equal(openPlacement(merged, "AM-020"), null);
});

test("a re-place from a phone whose clock is behind lands after the remove it follows", () => {
  const p = job();
  recordScan(p, place("AM-020", "Kitchen", "s1", -60));
  recordScan(p, remove("AM-020", "s2", 0));                       // another phone, right clock, 10:00
  const r = recordScan(p, place("AM-020", "Hall", "s3", -5));      // this phone: 5 minutes later, clock 10 minutes slow
  assert.equal(r.outcome, "placed");
  assert.ok(r.placement, "really placed");
  assert.ok(Date.parse(r.event.at) > Date.parse(at(0)), r.event.at);
  assert.deepEqual(scanned(p).map((x) => [x.location, x.removed === ""]), [["Kitchen", false], ["Hall", true]]);
});

test("scanRecord reads a place that moved a unit as a move, and keeps one log's units when asked", () => {
  const p = job({ dryingLogs: [log("A", []), log("B", [])] });
  recordScan(p, place("AM-001", "Kitchen", "s1", 0, { logId: "A" }));
  recordScan(p, place("AM-002", "Bath", "s2", 1, { logId: "B" }));
  recordScan(p, place("AM-001", "Hall", "s3", 2));
  assert.deepEqual(scanRecord(p).map((r) => [r.tag, r.act]), [["AM-001", "place"], ["AM-002", "place"], ["AM-001", "move"]]);
  const onA = p.dryingLogs[0].equipment.map((r) => r.scanId);
  assert.deepEqual(scanRecord(p, onA).map((r) => [r.tag, r.act, r.room]), [["AM-001", "place", "Kitchen"], ["AM-001", "move", "Hall"]]);
});

test("Undo of a typed row's scan holds after another phone's newer copy of the log wins the merge", () => {
  for (const removed of ["", "2026-10-10T09:00"]) {                // open, then with a planned pickup
    const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-015", type: "Air mover", location: "Kitchen", placed: "2026-10-05T10:00", removed }])] });
    const a = typed();
    const r = recordScan(a, remove("AM-015", "s1", 0));            // a wrong-mode Remove on phone A
    const b = mergeProjects(clone(typed()), clone(a)).merged;      // phone B pulls it
    applyScans(b);
    assert.equal(rows(b)[0].removed, "2026-10-08T10:00");
    assert.equal(undoTyped(a, r, ctx("v1", 1)), "restored");       // A undoes it
    assert.equal(rows(a)[0].removed, removed);
    b.dryingLogs[0].readings = [{ id: "r1" }];                     // B saves before it pulls the undo
    b.updatedAt = "2026-10-12T00:00:00.000Z";
    for (const [x, y] of [[a, b], [b, a]]) {
      const { merged } = mergeProjects(clone(x), clone(y));
      applyScans(merged);
      assert.equal(rows(merged)[0].removed, removed, "the undo holds on the merged copy");
      assert.equal(rows(merged)[0].scanFill, undefined);
      assert.equal(rowOutAt(rows(merged)[0], Date.parse(at(24 * 60))), true, "still out the next day");
      assert.equal(applyScans(merged).changed, false);
      assert.equal(recordScan(merged, remove("AM-015", "s9", 24 * 60)).outcome, "removed", "the real pickup the next day is taken");
    }
  }
});

test("two phones Remove-scan one typed row: the earlier counts, and undoing it lets the later one stand", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-016", type: "Air mover", location: "Kitchen", placed: "2026-10-05T10:00" }])] });
  const a = typed(), b = typed();
  const ra = recordScan(a, remove("AM-016", "sa", 0));
  recordScan(b, remove("AM-016", "sb", 30));
  b.updatedAt = "2026-10-12T00:00:00.000Z";
  const { merged } = mergeProjects(clone(a), clone(b));
  applyScans(merged);
  assert.equal(rows(merged)[0].removed, "2026-10-08T10:00");
  assert.equal(undoTyped(merged, ra, ctx("v1", 40)), "restored");
  assert.equal(rows(merged)[0].removed, "2026-10-08T10:30", "the other phone's scan now");
  assert.equal(applyScans(merged).changed, false);
});

test("the same unit typed twice with the same Placed: each Remove scan closes its own row", () => {
  const row = () => ({ ...blankEquipRow(), asset: "AM-014", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" });
  const p = job({ dryingLogs: [log("L1", [row(), row()])] });
  assert.equal(recordScan(p, remove("AM-014", "s1", 0)).outcome, "removed");
  assert.equal(recordScan(p, remove("AM-014", "s2", 1)).outcome, "removed");
  assert.deepEqual(rows(p).map((r) => r.removed), ["2026-10-08T10:00", "2026-10-08T10:01"]);
  assert.equal(recordScan(p, remove("AM-014", "s3", 2)).outcome, "not_here");
  assert.equal(applyScans(clone(p)).changed, false);
});

test("two phones move one typed row: the lines merge in time order and the room is the later move", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-014", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const a = typed(), b = typed();
  recordScan(a, place("AM-014", "Bath", "sa", 0));
  recordScan(b, place("AM-014", "Hall", "sb", 5));
  b.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a, b], [b, a]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.equal(rows(merged)[0].notes, "moved to Bath 10/08 10:00\nmoved to Hall 10/08 10:05");
    assert.equal(rowRoom(rows(merged)[0]), "Hall");
    assert.equal(recordScan(merged, place("AM-014", "Hall", "s9", 10)).outcome, "already");
  }
  assert.equal(rowRoom({ placed: "2026-12-30T09:00", location: "Den", notes: "moved to Bath 01/02 08:00\nmoved to Hall 12/31 09:00" }), "Bath", "into the new year");
});

test("a typed row's move: a line the crew deletes stays deleted, and undoing the move takes its line off", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-014", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const p = typed();
  recordScan(p, place("AM-014", "Bedroom", "s1", 0));
  const row = rows(p)[0];
  row.notes = "fan on high";                                       // deleted by hand
  assert.deepEqual(releaseTypedScans(p, row, ctx("v1", 1), "notes").map((e) => e.voids), ["s1"]);
  applyScans(p);
  assert.equal(row.notes, "fan on high");
  assert.equal(rowRoom(row), "Kitchen");
  const q = typed();
  const mv = recordScan(q, place("AM-014", "Bedroom", "s1", 0));
  assert.deepEqual(rowScans(q, rows(q)[0]).moves.map((e) => e.id), ["s1"]);
  assert.equal(undoTyped(q, mv, ctx("v1", 1)), "restored");
  assert.equal(rows(q)[0].notes, "fan on high");
  assert.equal(rows(q)[0].scanFill, undefined);
  // ✕ on the row: every scan on it is undone
  const z = typed();
  recordScan(z, place("AM-014", "Bedroom", "s1", 0));
  recordScan(z, remove("AM-014", "s2", 5));
  assert.deepEqual(releaseTypedScans(z, rows(z)[0], ctx("v1", 6), "row").map((e) => e.voids).sort(), ["s1", "s2"]);
});

test("✕ on an old closed row keeps a later placement that a stale phone's move started", () => {
  const base = job();
  recordScan(base, place("AM-020", "Kitchen", "p0", -60));
  const a = clone(base), b = clone(base);
  recordScan(a, remove("AM-020", "a1", 0));                         // pulled at 10:00
  recordScan(b, place("AM-020", "Bath", "b1", 180));                // offline phone: into the Bath at 13:00
  const { merged } = mergeProjects(a, b);
  applyScans(merged);
  assert.deepEqual(scanned(merged).map((r) => [r.location, r.scanId]), [["Kitchen", "p0"], ["Bath", "b1"]]);
  voidPlacement(merged, "p0", ctx("v1", 200));
  assert.deepEqual(scanned(merged).map((r) => [r.location, r.removed, r.scanId]), [["Bath", "", "b1"]], "the Bath row stays");
  assert.ok(openPlacement(merged, "AM-020"));
});

test("a scanned row a scan removed is in, even when the removing phone's clock ran ahead", () => {
  const p = job();
  recordScan(p, place("DH-002", "Kitchen", "s1", 0));
  recordScan(p, remove("DH-002", "s2", 60 + 40));
  const row = scanned(p)[0];
  assert.equal(rowOutAt(row, Date.parse(at(80))), false, "removed by a scan stamped 20 minutes ahead");
  row.scan = { ...row.scan, removeId: "" };
  row.removed = "2026-10-08T13:00";                                 // a typed pickup (no remove scan) still plans ahead
  assert.equal(rowOutAt(row, Date.parse(at(60))), true);
});

test("a scan-filled Removed the crew retyped on one phone holds when the other phone's newer copy wins", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const a = typed();
  recordScan(a, remove("AM-030", "r1", 0));                        // phone A pulls it, 10/08 10:00
  for (const [what, set, want] of [["removed", "2026-10-08T08:00", ["2026-10-08T08:00", 71]], ["removed", "", ["", ""]], ["row", null, ["2026-10-08T10:00", 73]]]) {
    const b = mergeProjects(clone(typed()), clone(a)).merged;
    applyScans(b);
    const row = rows(b)[0];
    if (set !== null) row.removed = set;                           // the lead fixes it on phone B
    const v = releaseTypedScans(b, row, ctx("v1", 5), what);
    assert.deepEqual(v.map((e) => [e.voids, e.release, e.set && e.set.removed]), [["r1", what, what === "removed" ? set : undefined]]);
    if (what === "row") b.dryingLogs[0].equipment.splice(0, 1);
    const a2 = clone(a);
    recordScan(a2, place("AM-031", "Hall", "x1", 6));               // A saves again before it pulls B's edit
    a2.updatedAt = "2026-10-12T00:00:00.000Z";
    for (const [x, y] of [[a2, b], [b, a2]]) {
      const { merged } = mergeProjects(clone(x), clone(y));
      applyScans(merged);
      const r = rows(merged).find((q) => q.asset === "AM-030");
      assert.deepEqual([r.removed, r.hours], want, `${what} ${set}`);
      assert.equal(applyScans(merged).changed, false);
      assert.equal(applyScans(jsonbOrder(clone(merged))).changed, false);
    }
  }
});

test("a remark typed after a typed row's move line keeps the move; undoing the move leaves the remark", () => {
  const p = job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const mv = recordScan(p, place("AM-030", "Bath", "m1", 0));
  const row = rows(p)[0];
  row.notes = "moved to Bath 10/08 10:00 - left on high";
  assert.deepEqual(releaseTypedScans(p, row, ctx("v1", 1), "notes"), [], "the line is still there");
  assert.equal(rowRoom(row), "Bath");
  assert.equal(recordScan(p, place("AM-030", "Bath", "s9", 2)).outcome, "already");
  row.notes = "moved to Bath 10/08 10:00, left on high";            // punctuation first works the same
  assert.deepEqual(releaseTypedScans(p, row, ctx("v1", 1), "notes"), []);
  assert.equal(rowRoom(row), "Bath");
  assert.equal(undoTyped(p, mv, ctx("v2", 3)), "restored");
  assert.equal(row.notes, "left on high");
  assert.equal(rowRoom(row), "Kitchen");
  // the fill handle writes Notes over: the live move line comes back, as on a scanned row
  const q = job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  recordScan(q, place("AM-030", "Bath", "m1", 0));
  rows(q)[0].notes = "pulled, area at goal";
  restoreMoveLines(rows(q)[0]);
  applyScans(q);
  assert.equal(rows(q)[0].notes, "pulled, area at goal\nmoved to Bath 10/08 10:00");
});

test("a typed row a scan removed is in, even when that phone's clock ran ahead", () => {
  const p = job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "DH-002", type: "Dehumidifier", location: "Kitchen", placed: "2026-09-29T09:00" }])] });
  recordScan(p, remove("DH-002", "r1", 40));                        // stamped 40 minutes ahead
  assert.equal(rowOutAt(rows(p)[0], Date.parse(at(20))), false);
  assert.equal(openElsewhere([{ ...p, id: "job-1" }], "DH-002", "job-2", Date.parse(at(20))), null);
  assert.equal(recordScan(p, place("DH-002", "Bath", "s2", 20)).outcome, "placed", "back in: a new row, not a move of the removed one");
});

test("a typed row's move line rewritten on one phone (another room, same time) holds when the other phone's newer copy wins", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const a = typed();
  recordScan(a, place("AM-030", "Bath", "m1", 0));
  const b = mergeProjects(clone(typed()), clone(a)).merged;
  applyScans(b);
  rows(b)[0].notes = "fan on high\nmoved to Laundry 10/08 10:00";
  const v = releaseTypedScans(b, rows(b)[0], ctx("v1", 5), "notes");
  assert.deepEqual(v.map((e) => [e.voids, e.release, e.set]), [["m1", "notes", { line: "moved to Laundry 10/08 10:00" }]]);
  const a2 = clone(a);
  recordScan(a2, place("AM-031", "Hall", "x1", 6));
  a2.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a2, b], [b, a2]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    const r = rows(merged).find((q) => q.asset === "AM-030");
    assert.equal(r.notes, "fan on high\nmoved to Laundry 10/08 10:00");
    assert.equal(rowRoom(r), "Laundry");
    assert.equal(applyScans(merged).changed, false);
  }
});

test("settleTypedRow: a Removed corrected in two steps ends on the second, on every copy, whichever wins", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const a = typed();
  recordScan(a, remove("AM-030", "r1", 0));
  const b = mergeProjects(clone(typed()), clone(a)).merged;
  applyScans(b);
  const row = rows(b)[0];
  // step one (a segment cleared, or the date picked first), committed and settled
  row.removed = "";
  assert.equal(releaseTypedScans(b, row, ctx("v1", 5))[0].set.removed, "");
  assert.deepEqual(settleTypedRow(b, row, ctx("v2", 6)), [], "nothing more to carry yet");
  const mid = clone(b);                                             // what B pushed in between
  // step two: no scan is live on the row any more, but its void still says ""
  row.removed = "2026-10-08T08:00";
  assert.deepEqual(releaseTypedScans(b, row, ctx("v3", 7)), []);
  const again = settleTypedRow(b, row, ctx("v4", 8));
  assert.deepEqual(again.map((e) => [e.voids, e.release, e.set.removed]), [["r1", "removed", "2026-10-08T08:00"]]);
  assert.deepEqual(settleTypedRow(b, row, ctx("v5", 9)), [], "settled once");
  // A, newer, either still holding the scan or having taken B's in-between copy
  const a2 = clone(a);
  recordScan(a2, place("AM-031", "Hall", "x1", 8));
  const a3 = mergeProjects(clone(a2), clone(mid)).merged;
  applyScans(a3);
  assert.equal(rows(a3).find((q) => q.asset === "AM-030").removed, "", "A took the in-between value");
  for (const newer of [a2, a3]) {
    newer.updatedAt = "2026-10-12T00:00:00.000Z";
    for (const [x, y] of [[newer, b], [b, newer]]) {
      const { merged } = mergeProjects(clone(x), clone(y));
      applyScans(merged);
      const r = rows(merged).find((q) => q.asset === "AM-030");
      assert.deepEqual([r.removed, r.hours], ["2026-10-08T08:00", 71]);
      assert.equal(applyScans(merged).changed, false);
      assert.deepEqual(settleTypedRow(merged, r, ctx("v6", 10)), [], "the merged copy agrees with its scans");
    }
  }
});

test("settleTypedRow: an edit never settled (the app closed first) is carried when the log next opens", () => {
  const a = job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  recordScan(a, remove("AM-030", "r1", 0));
  const b = clone(a);
  const row = rows(b)[0];
  row.removed = "";
  releaseTypedScans(b, row, ctx("v1", 5));                          // the first input
  row.removed = "2026-10-08T08:00";                                 // saved, then the app was killed
  const opened = clone(b);
  applyScans(opened);
  assert.equal(rows(opened)[0].removed, "2026-10-08T08:00", "the row keeps what was typed");
  const v = settleTypedRow(opened, rows(opened)[0], ctx("v2", 30));
  assert.deepEqual(v.map((e) => [e.voids, e.set.removed]), [["r1", "2026-10-08T08:00"]]);
  const a2 = clone(a);
  a2.updatedAt = "2026-10-12T00:00:00.000Z";
  const { merged } = mergeProjects(clone(a2), clone(opened));
  applyScans(merged);
  assert.equal(rows(merged)[0].removed, "2026-10-08T08:00");
});

test("settleTypedRow: a move line rewritten twice, or its time corrected, is the line every copy shows; a remark the other phone typed stays", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const a = typed();
  recordScan(a, place("AM-030", "Bath", "m1", 0));
  const fresh = () => { const b = mergeProjects(clone(typed()), clone(a)).merged; applyScans(b); return b; };
  const newerA = (remark) => {
    const a2 = clone(a);
    recordScan(a2, place("AM-031", "Hall", "x1", 6));
    if (remark) rows(a2)[0].notes = rows(a2)[0].notes.replace("moved to Bath 10/08 10:00", "moved to Bath 10/08 10:00 - 2nd fan behind door");
    a2.updatedAt = "2026-10-12T00:00:00.000Z";
    return a2;
  };
  const check = (b, want, a2 = newerA()) => {
    for (const [x, y] of [[a2, b], [b, a2]]) {
      const { merged } = mergeProjects(clone(x), clone(y));
      applyScans(merged);
      const r = rows(merged).find((q) => q.asset === "AM-030");
      assert.equal(r.notes, want);
      assert.equal(applyScans(merged).changed, false);
    }
  };
  // twice: a typo, then the room meant
  const b = fresh();
  rows(b)[0].notes = "fan on high\nmoved to Laundy 10/08 10:00";
  assert.deepEqual(settleTypedRow(b, rows(b)[0], ctx("v1", 5)).map((e) => e.set.line), ["moved to Laundy 10/08 10:00"]);
  rows(b)[0].notes = "fan on high\nmoved to Laundry 10/08 10:00";
  assert.deepEqual(settleTypedRow(b, rows(b)[0], ctx("v2", 6)).map((e) => [e.voids, e.set.line]), [["m1", "moved to Laundry 10/08 10:00"]]);
  check(b, "fan on high\nmoved to Laundry 10/08 10:00");
  assert.equal(rowRoom(rows(b)[0]), "Laundry");
  // then deleted: the line goes on every copy
  rows(b)[0].notes = "fan on high";
  assert.equal(settleTypedRow(b, rows(b)[0], ctx("v3", 7)).length, 1);
  check(b, "fan on high");
  // the time corrected (scanned late), same room
  const c = fresh();
  rows(c)[0].notes = "fan on high\nmoved to Bath 10/08 09:35";
  assert.deepEqual(settleTypedRow(c, rows(c)[0], ctx("v4", 5)).map((e) => e.set.line), ["moved to Bath 10/08 09:35"]);
  check(c, "fan on high\nmoved to Bath 10/08 09:35");
  // the room fixed on B while A added a remark on that line: A's remark stays
  const e = fresh();
  rows(e)[0].notes = "fan on high\nmoved to Laundry 10/08 10:00";
  settleTypedRow(e, rows(e)[0], ctx("v5", 5));
  check(e, "fan on high\nmoved to Laundry 10/08 10:00 - 2nd fan behind door", newerA(true));
});

test("settleTypedRow: two moves in one minute, one fixed or deleted, never takes the other scan's line", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const a = typed();
  const m1 = recordScan(a, place("AM-030", "Bath", "m1", 0, { at: "2026-10-08T18:00:10.000Z" }));
  recordScan(a, place("AM-030", "Laundry", "m2", 0, { at: "2026-10-08T18:00:40.000Z" }));
  assert.equal(rows(a)[0].notes, "fan on high\nmoved to Bath 10/08 10:00\nmoved to Laundry 10/08 10:00");
  const fresh = () => { const b = mergeProjects(clone(typed()), clone(a)).merged; applyScans(b); return b; };
  // the Laundry line fixed to Utility
  const b = fresh();
  rows(b)[0].notes = "fan on high\nmoved to Bath 10/08 10:00\nmoved to Utility 10/08 10:00";
  assert.deepEqual(settleTypedRow(b, rows(b)[0], ctx("v1", 5)).map((e) => [e.voids, e.set && e.set.line]), [["m2", "moved to Utility 10/08 10:00"]]);
  const a2 = clone(a);
  recordScan(a2, place("AM-031", "Hall", "x1", 6));
  a2.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a2, b], [b, a2]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.equal(rows(merged)[0].notes, "fan on high\nmoved to Bath 10/08 10:00\nmoved to Utility 10/08 10:00");
    assert.equal(rowRoom(rows(merged)[0]), "Utility");
  }
  // the Laundry line deleted on B while A undoes the Bath move: no move left
  const c = fresh();
  rows(c)[0].notes = "fan on high\nmoved to Bath 10/08 10:00";
  assert.deepEqual(settleTypedRow(c, rows(c)[0], ctx("v2", 5)).map((e) => [e.voids, e.set]), [["m2", undefined]]);
  const a3 = clone(a);
  assert.equal(undoTyped(a3, m1, ctx("u1", 6)), "restored");
  a3.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a3, c], [c, a3]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.equal(rows(merged)[0].notes, "fan on high");
    assert.equal(rowRoom(rows(merged)[0]), "Kitchen");
  }
});

test("settleTypedRow: the newest hand edit wins across a row's scans, not the first one that changed", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const edit = (p, v, id, min) => {                                // forms.js: input, then change
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min)).length) applyScans(p);
  };
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  let a = typed();
  recordScan(a, remove("AM-030", "r1", 0));
  let b = sync(a, typed());
  edit(a, "2026-10-09T12:00", "a1", 20);                            // a planned pickup
  b = sync(a, b); a = clone(b);
  edit(b, "2026-10-08T11:15", "b1", 110);                           // B, not synced since
  assert.equal(recordScan(a, remove("AM-030", "r2", 159)).outcome, "removed");
  edit(a, "2026-10-09T12:00", "a2", 176);                           // A's lead puts the pickup back, last
  a.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a, b], [b, a]]) {
    const m = sync(x, y);
    assert.equal(row(m).removed, "2026-10-09T12:00");
    assert.equal(applyScans(m).changed, false);
    const v = settleTypedRow(m, row(m), ctx("v9", 200));               // the log opened: the older register catches up
    assert.deepEqual(v.map((e) => [e.voids, e.set.removed]), [["r1", "2026-10-09T12:00"]]);
    assert.deepEqual(settleTypedRow(m, row(m), ctx("v10", 201)), []);
  }
});

test("settleTypedRow: lines from two phones' same-minute scans, one line deleted then rewritten elsewhere, room and time both fixed; applyScans stays idempotent", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const newer = (p, min) => { recordScan(p, place("AM-031", "Hall", "x" + min, min)); p.updatedAt = at(min); return p; };
  // two phones scanned the unit into the Bath in the same minute: one line, two scans
  const a = typed(), b = typed();
  recordScan(a, place("AM-030", "Bath", "m1", 0, { at: "2026-10-08T18:00:05.000Z" }));
  recordScan(b, place("AM-030", "Bath", "m2", 0, { at: "2026-10-08T18:00:40.000Z" }));
  b.updatedAt = at(1);
  const both = sync(a, b);
  assert.equal(row(both).notes, "fan on high\nmoved to Bath 10/08 10:00");
  const fixed = clone(both);
  row(fixed).notes = "fan on high\nmoved to Laundry 10/08 10:00";
  assert.deepEqual(settleTypedRow(fixed, row(fixed), ctx("v1", 5)).map((e) => e.set.line), ["moved to Laundry 10/08 10:00", "moved to Laundry 10/08 10:00"]);
  const other = newer(clone(both), 6);
  for (const [x, y] of [[other, fixed], [fixed, other]]) assert.equal(row(sync(x, y)).notes, "fan on high\nmoved to Laundry 10/08 10:00");
  // deleted on one phone, rewritten on the other (later): the rewrite comes back on the deleting phone's newer copy
  const one = typed();
  recordScan(one, place("AM-030", "Bath", "m1", 0));
  const p = sync(one, typed()), q = clone(p);
  row(p).notes = "fan on high";
  assert.equal(settleTypedRow(p, row(p), ctx("d1", 10)).length, 1);
  const shown = row(q).notes;
  row(q).notes = "fan on high\nmoved to Laundry 10/08 09:35";        // room and time both fixed in one edit: still a rewrite
  assert.deepEqual(settleTypedRow(q, row(q), ctx("d2", 20), { edit: "notes", before: shown }).map((e) => e.set.line), ["moved to Laundry 10/08 09:35"]);
  newer(p, 30);
  for (const [x, y] of [[p, q], [q, p]]) {
    const m = sync(x, y);
    assert.equal(row(m).notes, "fan on high\nmoved to Laundry 10/08 09:35");
    assert.equal(rowRoom(row(m)), "Laundry");
  }
  // a rewritten line's scan and a new move scan keep their order: nothing changes on the next run
  const r = clone(q);
  recordScan(r, place("AM-030", "Bedroom", "m3", 40));
  assert.deepEqual(row(r).scanFill.moves.map((m) => m.id), ["m1", "m3"]);
  assert.equal(applyScans(r).changed, false);
});

test("settleTypedRow, a Removed edit: every scan the row replaced takes the time typed, so the newest edit wins whichever copy is newer", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  // forms.js: the input writes Removed and gives the scans way; the change carries the time onto them
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed" }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  for (const bNewer of [true, false]) {
    let A = typed();
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    let B = sync(A, typed());
    edit(A, "2026-10-09T12:00", "a1", 20);
    B = sync(A, B); A = clone(B);
    edit(B, "2026-10-08T11:15", "b1", 110);                         // B's lead: the real pickup
    assert.equal(recordScan(A, remove("AM-030", "r2", 159)).outcome, "removed");
    edit(A, "2026-10-09T12:00", "a2", 176);                         // A's lead types the plan again: the newest edit
    assert.deepEqual(A.equipmentScans.filter((e) => e.act === "void" && e.at >= at(176)).map((e) => [e.voids, e.set.removed]).sort(),
      [["r1", "2026-10-09T12:00"], ["r2", "2026-10-09T12:00"]], "both scans restated, r1 although A's own copy of it already said so");
    const later = bNewer ? B : A;
    later.dryingLogs[0].readings.push({ id: "rd" }); later.updatedAt = at(190);
    for (const [x, y] of [[A, B], [B, A]]) assert.equal(row(sync(x, y)).removed, "2026-10-09T12:00", bNewer ? "B's copy newer" : "A's copy newer");
  }
});

test("settleTypedRow when a log only opens: a scan out of step is realigned just after the newest edit, never over a later one", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const edit = (p, v, id, min, settle = true) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settle && settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed" }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  let A = typed();
  recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
  let B = sync(A, typed());
  edit(A, "2026-10-09T12:00", "a1", 20);                            // the planned pickup
  B = sync(A, B); A = clone(B);
  edit(B, "2026-10-08T11:15", "b1", 110);
  assert.equal(recordScan(A, remove("AM-030", "r2", 159)).outcome, "removed");
  edit(A, "2026-10-09T12:00", "a2", 176, false);                    // the plan typed again; the app closed before the field was left
  B = sync(A, B); A = clone(B);                                     // A's copy newer: r2's 10/09 12:00 shows, r1 still says 11:15
  assert.equal(row(A).removed, "2026-10-09T12:00");
  edit(B, "2026-10-08T13:20", "b2", 205);                           // B's lead: the real pickup
  // a Notes edit on that phone lines the scan up the same way: it is no Removed edit
  const N = clone(A), before = row(N).notes;
  row(N).notes = "dehu draining to sink";
  assert.deepEqual(settleTypedRow(N, row(N), ctx("note", 210), { edit: "notes", before }).map((e) => [e.voids, e.at]),
    [["r1", new Date(Date.parse(at(176)) + 1).toISOString()]]);
  const pushed = settleTypedRow(A, row(A), ctx("view", 210));       // A only opens the log, not synced since
  assert.deepEqual(pushed.map((e) => [e.voids, e.set.removed, e.at]), [["r1", "2026-10-09T12:00", new Date(Date.parse(at(176)) + 1).toISOString()]],
    "stamped just after the edit it follows, not with A's clock");
  applyScans(A);
  for (const [x, y] of [[A, B], [B, A]]) assert.equal(row(sync(x, y)).removed, "2026-10-08T13:20");
  assert.deepEqual(settleTypedRow(A, row(A), ctx("view2", 211)), [], "realigned once");
});

test("a typed row's scan corrected on a phone whose copy then lost the merge to one that never had the scan: every copy ends on the correction", () => {
  const typed = (extra = {}) => job({ updatedAt: at(-60), dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high", ...extra }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const both = (A, B, check, aligned = true) => {
    for (const [x, y] of [[A, B], [B, A]]) {
      const m = sync(x, y);
      check(row(m));
      assert.equal(applyScans(m).changed, false);
      if (aligned) assert.deepEqual(settleTypedRow(m, row(m), ctx("open", 300)), [], "nothing to line up after");
    }
  };
  const offline = (B, min) => { B.dryingLogs[0].readings.push({ id: "rd" + min }); B.updatedAt = at(min); };   // B, offline, saves a reading: its copy is newer
  // a Remove scan's time retyped (the real pull time), or cleared (the wrong unit)
  for (const put of ["2026-10-08T09:40", ""]) {
    const A = typed(), B = typed();
    recordScan(A, remove("AM-030", "r1", 0));
    row(A).removed = put;
    releaseTypedScans(A, row(A), ctx("a1", 2));
    A.updatedAt = at(2);
    offline(B, 10);
    both(A, B, (r) => assert.equal(r.removed, put, put || "cleared"));
  }
  // a Removed B typed before the scan's time: the scan never filled it, nor does its correction.
  // The row lists it as one it kept its Removed over, so an open lines nothing up
  {
    const A = typed(), B = typed({ removed: "2026-10-08T09:30" });
    recordScan(A, remove("AM-030", "r1", 0));
    row(A).removed = "2026-10-08T09:40";
    releaseTypedScans(A, row(A), ctx("a1", 2));
    A.updatedAt = at(2);
    offline(B, 10);
    both(A, B, (r) => {
      assert.equal(r.removed, "2026-10-08T09:30");
      assert.deepEqual(r.scanFill.released.map((x) => [x.id, x.removed, x.v, x.kept]), [["r1", "2026-10-08T09:30", "a1", true]]);
    });
  }
  // a moved-to line the crew rewrote (the picker was left on the wrong room)
  {
    const A = typed(), B = typed();
    recordScan(A, place("AM-030", "Laundry", "m1", 270));
    const before = row(A).notes;
    row(A).notes = "fan on high\nmoved to Bath 10/08 14:30";
    if (settleTypedRow(A, row(A), ctx("a2", 272), { edit: "notes", before }).length) applyScans(A);
    A.updatedAt = at(272);
    offline(B, 280);
    both(A, B, (r) => { assert.equal(r.notes, "fan on high\nmoved to Bath 10/08 14:30"); assert.equal(rowRoom(r), "Bath"); });
  }
  // two phones each scanned it out and typed a time; the copy that wins lists only its own scan: the later edit stands
  {
    const A = typed(), B = typed();
    recordScan(A, remove("AM-030", "r1", 0)); recordScan(B, remove("AM-030", "r2", 5));
    row(A).removed = "2026-10-09T12:00"; releaseTypedScans(A, row(A), ctx("a1", 20)); A.updatedAt = at(40);
    row(B).removed = "2026-10-08T11:15"; releaseTypedScans(B, row(B), ctx("b1", 30)); B.updatedAt = at(31);
    both(A, B, (r) => assert.equal(r.removed, "2026-10-08T11:15"), false);   // (an open lines r1 up after it)
  }
});

test("a corrected scan the winning copy never listed is claimed on the first pass, though the row's own scan only moves past it there: applying again changes nothing", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  let A = typed();
  recordScan(A, remove("AM-030", "r0", 0)); A.updatedAt = at(0);   // pulled at 10:00, then every phone syncs
  let B = sync(A, typed()), C = sync(A, typed());
  edit(A, "2026-10-10T07:00", "a1", 10);                           // A: the pickup is really Saturday...
  recordScan(A, remove("AM-030", "r2", 20)); A.updatedAt = at(20); // ...then scans it out at 10:20 anyway
  edit(A, "2026-10-09T12:00", "a2", 30);                           // and types Friday noon over both scans
  edit(B, "2026-10-08T08:30", "b1", 40);                           // B, offline: 8:30, before r2 was scanned
  edit(C, "2026-10-10T07:00", "c1", 50);                           // C, the newest edit of r0: Saturday
  B.dryingLogs[0].readings.push({ id: "rd60" }); B.updatedAt = at(60);   // B's copy (r0 only, at 8:30) wins the merge
  const ends = [];
  for (const [x, y, z] of [[A, B, C], [C, A, B], [B, C, A]]) {
    const m = sync(sync(x, y), z);
    assert.equal(applyScans(m).changed, false, "a second pass claims nothing new");
    assert.deepEqual(row(m).scanFill.released.map((r) => r.id).sort(), ["r0", "r2"]);
    ends.push(row(m).removed);
  }
  assert.deepEqual(ends, ["2026-10-10T07:00", "2026-10-10T07:00", "2026-10-10T07:00"], "the newest edit stands, every order");
});

test("a scan cleared as the wrong unit on a phone whose copy then lost the merge: a Removed the other phone typed stays", () => {
  const typed = () => job({ updatedAt: at(-60), dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const A = typed(), B = typed();
  recordScan(A, remove("AM-030", "r1", 0));                         // A scans the wrong unit at 10:00
  row(A).removed = "";
  releaseTypedScans(A, row(A), ctx("a1", 2));                        // and clears it
  A.updatedAt = at(2);
  row(B).removed = "2026-10-08T10:30"; B.updatedAt = at(31);         // B, offline, pulls AM-030 for real
  B.dryingLogs[0].readings.push({ id: "rd40" }); B.updatedAt = at(40);
  for (const [x, y] of [[A, B], [B, A]]) {
    const m = sync(x, y);
    assert.equal(row(m).removed, "2026-10-08T10:30");
    assert.equal(applyScans(m).changed, false);
  }
});

test("a corrected scan the winning copy's Removed was typed before: a later edit of that Removed stands, it is never filled with the correction then", () => {
  const typed = () => job({ updatedAt: at(-60), dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const edit = (p, v, id, min) => {   // forms.js mk: input (release, settle), then change (settle again)
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    if (settleTypedRow(p, row(p), ctx(id + "c", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  // B's lead typed the pull time 09:30 (10:05) over A's correction 09:40 (10:02): B's copy wins, then B changes it again
  for (const later of ["2026-10-08T10:15", ""]) {
    let A = typed(), B = typed();
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    edit(A, "2026-10-08T09:40", "a1", 2);
    edit(B, "2026-10-08T09:30", "b1", 5);
    B = sync(B, A); A = sync(A, B);
    assert.equal(row(A).removed, "2026-10-08T09:30");
    edit(B, later, "b2", 360);
    assert.equal(applyScans(B).changed, false, later || "cleared");
    assert.equal(row(B).removed, later);
    for (const [x, y] of [[A, B], [B, A]]) assert.equal(row(sync(x, y)).removed, later, later || "cleared");
  }
  // both leads typed the same 09:40; synced; then A clears it (still running) or types a later pickup
  for (const later of ["", "2026-10-10T09:00"]) {
    let A = typed(), B = typed();
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    edit(A, "2026-10-08T09:40", "a1", 2);
    edit(B, "2026-10-08T09:40", "b1", 3);
    B.dryingLogs[0].readings.push({ id: "rd" }); B.updatedAt = at(5);
    A = sync(A, B); B = sync(B, A);
    assert.equal(row(A).removed, "2026-10-08T09:40");
    assert.deepEqual(settleTypedRow(A, row(A), ctx("open", 100)), [], "nothing to line up: the row says what the correction does");
    edit(A, later, "a2", 240);
    assert.equal(applyScans(A).changed, false, later || "cleared");
    for (const [x, y] of [[A, B], [B, A]]) assert.equal(row(sync(x, y)).removed, later, later || "cleared");
  }
});

test("a scan the winning row kept its Removed over: opening the log carries nothing, so a later hand edit on the other phone stands", () => {
  const typed = () => job({ updatedAt: at(-60), dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    if (settleTypedRow(p, row(p), ctx(id + "c", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  const open = (p, id, min) => { const v = settleTypedRow(p, row(p), ctx(id, min)); if (v.length) { applyScans(p); p.updatedAt = at(min); } return v; };
  const strip = ({ updatedAt, ...c }) => JSON.stringify(c);
  for (const aOpens of [false, true]) {
    let server = typed();
    const sync = (p, min) => {   // sync.js absorb: merge with the server's copy, rebuild; a union adding something goes up stamped now
      const m = mergeProjects(clone(p), clone(server)).merged;
      applyScans(m);
      if (strip(m) === strip(server)) return clone(server);
      m.updatedAt = at(min); server = clone(m); return m;
    };
    let A = clone(server), B = clone(server);
    recordScan(B, remove("AM-030", "r1", 0)); B.updatedAt = at(0);
    edit(B, "2026-10-08T09:50", "b1", 2);                         // B's lead: the real pull time
    edit(A, "2026-10-08T09:40", "a1", 10); A = sync(A, 11);         // A never saw the scan
    B = sync(B, 12);
    assert.equal(row(B).removed, "2026-10-08T09:40", "A's copy won");
    assert.deepEqual(row(B).scanFill.released, [{ id: "r1", removed: "2026-10-08T09:40", v: "b1a", kept: true }]);
    edit(A, "2026-10-08T09:30", "a2", 13);                         // A's lead, not synced since: the last edit
    assert.deepEqual(open(B, "openB", 14), [], "an open on B carries nothing");
    A = sync(A, 15);
    if (aOpens) assert.deepEqual(open(A, "openA", 15.5), []);
    B = sync(B, 16);
    for (let k = 0; k < 3; k++) { A = sync(A, 17 + 2 * k); B = sync(B, 18 + 2 * k); }
    assert.deepEqual([row(A).removed, row(B).removed], ["2026-10-08T09:30", "2026-10-08T09:30"], aOpens ? "A opened too" : "only B opened");
  }
});

test("corrected scans on a row typed before them end the same whichever phone synced first", () => {
  const typed = (extra = {}) => job({ updatedAt: at(-120), dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", ...extra }])] });
  const row = (p) => rows(p)[0];
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    if (settleTypedRow(p, row(p), ctx(id + "c", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  const open = (p, id, min) => { for (const r of rows(p)) if (!r.scanId && r.scanFill && settleTypedRow(p, r, ctx(id, min)).length) applyScans(p); };
  const run = (ph, order) => {   // through the server one at a time (each union stamped now), the log opened after each, then everyone pulls
    let srv = null, clock = 400;
    const syncPhone = (k) => {
      clock += 10;
      if (srv) { const m = mergeProjects(clone(ph[k]), clone(srv)).merged; applyScans(m); m.updatedAt = at(clock); ph[k] = m; }
      open(ph[k], "open" + k + clock, clock + 1);
      srv = clone(ph[k]);
    };
    for (const k of order) syncPhone(k);
    for (const k of order) syncPhone(k);
    assert.equal(applyScans(clone(srv)).changed, false);
    return [...new Set(Object.values(ph).map((p) => row(p).removed).concat(row(srv).removed))];
  };
  // A makes it a planned pickup over its scan; C corrects its own scan last; B's hand-typed 10:15 (before C's scan) wins the row
  const three = () => {
    const ph = { A: typed(), B: typed(), C: typed() };
    recordScan(ph.A, remove("AM-030", "s1", 0)); ph.A.updatedAt = at(0);
    edit(ph.A, "2026-10-09T12:00", "a1", 2);
    recordScan(ph.C, remove("AM-030", "s2", 30)); ph.C.updatedAt = at(30);
    edit(ph.C, "2026-10-08T10:25", "c1", 35);
    edit(ph.B, "2026-10-08T10:15", "b1", 16);
    ph.B.dryingLogs[0].readings.push({ id: "rd" }); ph.B.updatedAt = at(300);
    return ph;
  };
  for (const order of ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"]) assert.deepEqual(run(three(), [...order]), ["2026-10-08T10:25"], order);
  // two scans, each corrected, both after the 09:30 B typed, and B's copy the newest: it keeps 09:30
  // whether A's correction reached it first or both came in one merge
  const A = typed(); recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0); edit(A, "2026-10-08T09:40", "a1", 2);
  const D = typed(); recordScan(D, remove("AM-030", "r2", 10)); D.updatedAt = at(10); edit(D, "2026-10-08T09:50", "d1", 30);
  const B = typed({ removed: "2026-10-08T09:30" }); B.dryingLogs[0].readings.push({ id: "rd" }); B.updatedAt = at(40);
  const merge = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const ends = [merge(merge(A, B), D), merge(merge(A, D), B), merge(merge(D, B), A)];
  for (const m of ends) {
    assert.equal(row(m).removed, "2026-10-08T09:30");
    assert.deepEqual(row(m).scanFill.released.map((r) => [r.id, r.kept]).sort(), [["r1", true], ["r2", true]]);
    assert.deepEqual(settleTypedRow(m, row(m), ctx("open", 60)), [], "an open carries nothing");
  }
});

test("✕ after a correction: a copy that still shows the row keeps following the correction", () => {
  const fresh = () => ({ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" });
  const typed = () => job({ updatedAt: at(-60), dryingLogs: [log("L1", [fresh()])] });
  const row = (p) => rows(p).find((r) => r.asset === "AM-030");
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const X = (p, id, min) => {
    const voids = releaseTypedScans(p, row(p), ctx(id, min), "row");
    rows(p).splice(rows(p).indexOf(row(p)), 1);
    p.updatedAt = at(min);
    return voids;
  };
  // A corrects the Remove scan C already pulled (or clears it: the wrong unit), then ✕; C's copy, newer, brings the row back
  for (const put of ["2026-10-07T16:00", ""]) {
    const A = typed();
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    const C = sync(typed(), A); C.updatedAt = at(1);
    row(A).removed = put;
    releaseTypedScans(A, row(A), ctx("a1", 2));
    assert.deepEqual(X(A, "x1", 5).map((e) => [e.voids, e.release]), [["r1", "row"]]);
    C.dryingLogs[0].readings.push({ id: "rd" }); C.updatedAt = at(10);
    for (const [x, y] of [[A, C], [C, A]]) {
      const m = sync(x, y);
      assert.equal(row(m).removed, put, put || "cleared");
      assert.equal(applyScans(m).changed, false);
    }
  }
  // a moved-to line rewritten (the picker was on the wrong room), then ✕
  {
    const A = typed();
    recordScan(A, place("AM-030", "Bath", "m1", 270)); A.updatedAt = at(270);
    const C = sync(typed(), A); C.updatedAt = at(271);
    const before = row(A).notes;
    row(A).notes = "fan on high\nmoved to Bedroom 10/08 14:30";
    if (settleTypedRow(A, row(A), ctx("a2", 272), { edit: "notes", before }).length) applyScans(A);
    X(A, "x2", 275);
    C.dryingLogs[0].readings.push({ id: "rd" }); C.updatedAt = at(280);
    for (const [x, y] of [[A, C], [C, A]]) {
      const m = sync(x, y);
      assert.equal(row(m).notes, "fan on high\nmoved to Bedroom 10/08 14:30");
      assert.equal(rowRoom(row(m)), "Bedroom");
    }
  }
  // the ✕ phone's clock behind the phone that made the correction: the row typed in again still isn't refilled
  for (const skew of [0, 10]) {
    let A = typed(), B = typed();
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    B = sync(B, A);
    row(B).removed = "2026-10-08T09:40";
    releaseTypedScans(B, row(B), ctx("b1", 2 + skew));               // B's clock reads 10:02 + skew
    B.updatedAt = at(2 + skew);
    A = sync(A, B); A.updatedAt = at(3);
    const [v] = X(A, "x1", 5);                                       // A's clock: 10:05
    assert.ok(v.at > A.equipmentScans.find((e) => e.id === "b1").at, "after the correction it follows");
    rows(A).push({ ...fresh(), notes: "" });
    A.dryingLogs[0].readings.push({ id: "rd" }); A.updatedAt = at(20);
    assert.equal(applyScans(A).changed, false, `skew ${skew}`);
    assert.equal(row(sync(B, A)).removed, "", `skew ${skew}`);
  }
});

test("✕ on a typed row whose scans an edit already released: the row typed in again is not refilled", () => {
  const fresh = () => ({ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" });
  const row = (p) => rows(p)[0];
  for (const kind of ["removed", "moved"]) {
    const A = job({ dryingLogs: [log("L1", [{ ...fresh(), notes: "fan on high" }])] });
    if (kind === "removed") {
      recordScan(A, remove("AM-030", "r1", 0));
      row(A).removed = "2026-10-08T09:40";
      releaseTypedScans(A, row(A), ctx("a1", 2));
    } else {
      recordScan(A, place("AM-030", "Laundry", "m1", 270));
      const before = row(A).notes;
      row(A).notes = "fan on high\nmoved to Bath 10/08 14:30";
      if (settleTypedRow(A, row(A), ctx("a2", 272), { edit: "notes", before }).length) applyScans(A);
    }
    applyScans(A);
    const sc = rowScans(A, row(A));
    assert.equal(sc.removes.length + sc.moves.length, 0, "no live scan on it: ✕ asks nothing");
    const voids = releaseTypedScans(A, row(A), ctx("x1", 300), "row");
    assert.deepEqual(voids.map((e) => [e.voids, e.release]), [[kind === "removed" ? "r1" : "m1", "row"]]);
    rows(A).splice(0, 1);
    rows(A).push(fresh());                                           // typed in again, still running
    assert.equal(applyScans(A).changed, false, kind);
    assert.deepEqual([row(A).removed, row(A).notes, rowRoom(row(A))], ["", "", "Kitchen"]);
  }
});

test("a newer correction of a typed row's scan that restates the Removed the row already shows changes nothing on it: Hrs typed by hand stay", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  let A = typed();
  recordScan(A, remove("AM-030", "r1", 0));
  edit(A, "2026-10-08T09:40", "a1", 2);                    // the real pull time
  let B = sync(A, typed());
  edit(A, "2026-10-08T09:50", "a2", 10);                   // A mistypes it, then puts it back
  edit(A, "2026-10-08T09:40", "a3", 11);
  row(B).hours = 70; row(B)._manualHrs = true; B.updatedAt = at(20);   // B types the Hrs off the machine's meter
  for (const [x, y] of [[A, B], [B, A]]) {
    const m = sync(x, y);
    assert.equal(row(m).removed, "2026-10-08T09:40");
    assert.equal(row(m).hours, 70, "the Hrs B typed stay");
    assert.equal(applyScans(m).changed, false);
  }
});

test("two scans of one unit whose registers a merge left out of step: an edit that restates both at one instant moves every copy, whichever void sorts last", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const edit = (p, v, id, min) => {
    row(p).removed = v;
    releaseTypedScans(p, row(p), ctx(id + "a", min));
    if (settleTypedRow(p, row(p), ctx(id + "b", min), { edit: "removed", since: at(min) }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  for (const tie of ["~a2", "!a2"]) {                                // r1's restate sorts after r2's, then before
    let A = typed(), B = typed(), C;
    recordScan(A, remove("AM-030", "r1", 0)); A.updatedAt = at(0);
    C = sync(A, typed());                                            // the office tablet
    recordScan(B, remove("AM-030", "r2", 5)); B.updatedAt = at(5);   // B, not synced, scans it out too
    edit(A, "2026-10-09T12:00", "a1", 20);
    edit(B, "2026-10-08T11:15", "b1", 30);
    C = sync(sync(C, B), A);                                         // nobody opens the log: r1 still says 10/09 12:00
    assert.equal(row(C).removed, "2026-10-08T11:15");
    A = sync(A, C);
    edit(A, "2026-10-09T12:00", tie, 50);                            // the planned pickup, typed back: both scans restated at 10:50
    C.customer = "office edit"; C.updatedAt = at(55);
    for (const [x, y] of [[A, C], [C, A]]) assert.equal(row(sync(x, y)).removed, "2026-10-09T12:00", tie);
  }
});

test("settleTypedRow, a Notes edit: a move line already on the row is never a scan line's rewrite; a line new in this edit is, even with room and time both changed", () => {
  const typed = (notes) => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const noted = (p, notes, id, min) => {
    const before = row(p).notes;
    row(p).notes = notes;
    const v = settleTypedRow(p, row(p), ctx(id, min), { edit: "notes", before });
    if (v.length) applyScans(p);
    p.updatedAt = at(min);
    return v.map((e) => (e.set ? e.set.line : "(deleted)"));
  };
  const hand = "moved to Bath 10/06 08:00";                         // typed by hand before any scan
  const base = typed(hand);
  const A = clone(base);
  recordScan(A, place("AM-030", "Laundry", "m1", 0)); A.updatedAt = at(0);
  const both = sync(A, base);
  assert.equal(row(both).notes, hand + "\nmoved to Laundry 10/08 10:00");
  // the scan line deleted: a deletion, not a rewrite into the hand line
  const B = clone(both);
  assert.deepEqual(noted(B, hand, "b1", 10), ["(deleted)"]);
  const A2 = clone(both);
  noted(A2, "moved to Utility 10/06 08:00\nmoved to Laundry 10/08 10:00", "a1", 15);   // A fixes the hand line's room, newer
  for (const [x, y] of [[A2, B], [B, A2]]) {
    const m = sync(x, y);
    assert.equal(row(m).notes, "moved to Utility 10/06 08:00");
    assert.equal(rowRoom(row(m)), "Utility");
  }
  const back = clone(B); row(back).notes = "fan on high"; restoreMoveLines(row(back));
  assert.equal(row(back).notes, "fan on high", "the fill handle never puts the hand line back as a scan line");
  // the scan line deleted and a line for another day typed in the same edit: that line is the crew's own
  const D = clone(both);
  assert.deepEqual(noted(D, hand + "\nmoved to Utility 10/07 09:00", "d1", 12), ["(deleted)"]);
  // the scan line rewritten in room and time, the hand line still there: a rewrite
  const C = clone(both);
  assert.deepEqual(noted(C, hand + "\nmoved to Utility 10/08 09:35", "c1", 20), ["moved to Utility 10/08 09:35"]);
  const A3 = clone(both); A3.dryingLogs[0].readings.push({ id: "rd" }); A3.updatedAt = at(30);
  for (const [x, y] of [[A3, C], [C, A3]]) assert.equal(rowRoom(row(sync(x, y))), "Utility");
});

test("settleTypedRow, one Notes edit that deletes one scan line and rewrites another: each scan gets its own, and undoing the deleted one keeps the rewrite", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const A = typed();
  const o1 = recordScan(A, place("AM-030", "Bath", "m1", 0));
  recordScan(A, place("AM-030", "Laundry", "m2", 60)); A.updatedAt = at(60);
  const B = sync(A, typed());
  assert.equal(row(B).notes, "fan on high\nmoved to Bath 10/08 10:00\nmoved to Laundry 10/08 11:00");
  const before = row(B).notes;
  row(B).notes = "fan on high\nmoved to Utility 10/08 10:50";        // the wrong Bath scan deleted, the Laundry line corrected
  const v = settleTypedRow(B, row(B), ctx("b1", 80), { edit: "notes", before });
  applyScans(B); B.updatedAt = at(80);
  assert.deepEqual(v.map((e) => [e.voids, e.set ? e.set.line : "(deleted)"]).sort(), [["m1", "(deleted)"], ["m2", "moved to Utility 10/08 10:50"]]);
  assert.equal(undoTyped(A, o1, ctx("u1", 85)), "restored");        // A, not synced, undoes the Bath scan
  A.updatedAt = at(85);
  for (const [x, y] of [[A, B], [B, A]]) {
    const m = sync(x, y);
    assert.equal(row(m).notes, "fan on high\nmoved to Utility 10/08 10:50");
    assert.equal(rowRoom(row(m)), "Utility");
  }
});

test("settleTypedRow: a move line deleted, then typed back, is the scan's again; another scan's same line showing is not", () => {
  const typed = () => job({ dryingLogs: [log("L1", [{ ...blankEquipRow(), asset: "AM-030", type: "Air mover", location: "Kitchen", placed: "2026-10-05T09:00", notes: "fan on high" }])] });
  const row = (p) => rows(p)[0];
  const sync = (x, y) => { const m = mergeProjects(clone(x), clone(y)).merged; applyScans(m); return m; };
  const noted = (p, notes, id, min) => {
    const before = row(p).notes;
    row(p).notes = notes;
    if (settleTypedRow(p, row(p), ctx(id, min), { edit: "notes", before }).length) applyScans(p);
    p.updatedAt = at(min);
  };
  const A = typed();
  recordScan(A, place("AM-030", "Laundry", "m1", 0)); A.updatedAt = at(0);
  const B = sync(A, typed());
  noted(B, "fan on high", "b1", 10);                                // deleted by mistake
  noted(B, "fan on high\nmoved to Laundry 10/08 10:00", "b2", 11);  // typed back
  assert.deepEqual(row(B).scanFill.moves, [{ id: "m1", line: "moved to Laundry 10/08 10:00", released: true }]);
  A.dryingLogs[0].readings.push({ id: "rd" }); A.updatedAt = at(20);
  for (const [x, y] of [[A, B], [B, A]]) {
    const m = sync(x, y);
    assert.equal(row(m).notes, "fan on high\nmoved to Laundry 10/08 10:00");
    assert.equal(rowRoom(row(m)), "Laundry");
  }
  // two phones scanned it into the same room in the same minute; B deleted its own line before A's scan arrived
  const P = typed(), Q = typed();
  recordScan(P, place("AM-030", "Utility", "p1", 30)); P.updatedAt = at(30);
  recordScan(Q, place("AM-030", "Utility", "q1", 30, { at: new Date(Date.parse(at(30)) + 20000).toISOString() })); Q.updatedAt = at(31);
  noted(Q, "fan on high", "q2", 32);
  const m = sync(P, Q);
  assert.equal(row(m).notes, "fan on high\nmoved to Utility 10/08 10:30", "P's scan still shows");
  assert.deepEqual(settleTypedRow(m, row(m), ctx("view", 40)), [], "Q's deleted line stays deleted: the line showing is P's");
});

/* ---------- the module's own rules ---------- */
test("scans.js is pure and safe on old iOS: no imports, no DOM or network, none of the newer built-ins", () => {
  const src = readFileSync(fileURLToPath(SCANS_URL), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(/m, "imports nothing");
  assert.doesNotMatch(code, /\b(document|window|fetch|localStorage|sessionStorage|navigator|XMLHttpRequest)\b/);
  assert.doesNotMatch(code, /Object\.hasOwn\b|\.at\(|structuredClone|localeCompare/);
});
