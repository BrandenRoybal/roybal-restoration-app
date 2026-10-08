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
      removedAt: "", removedBy: "", removedTech: "", model: "", moves: [], removedTyped: false },
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
  const r = recordScan(p, remove("AM-014", "s2", 0));
  assert.equal(r.outcome, "removed");
  assert.equal(r.message, "AM-014 removed from Kitchen (typed row)");
  assert.equal(r.event, null);
  assert.deepEqual(p.equipmentScans || [], [], "no event: the row is the record");
  assert.equal(rows(p).length, 1);
  const row = rows(p)[0];
  assert.deepEqual([row.asset, row.placed, row.removed, row.hours, row.notes, !!row.scanId], ["am 14", "2026-10-05T09:00", "2026-10-08T10:00", 73, "behind fridge", false]);
  assert.equal(recordScan(p, remove("AM-014", "s3", 5)).outcome, "not_here", "once removed, it is not out");
  // the card's Undo puts the row back as it was typed
  assert.equal(undoTyped(r), true);
  assert.deepEqual([row.removed, row.hours, row.notes], ["", "", "behind fridge"]);
  assert.equal(undoTyped({ typed: null }), false);

  const q = typed();
  const mv = recordScan(q, place("AM-014", "Bath", "s1", 0));
  assert.equal(mv.outcome, "moved");
  assert.equal(mv.message, "AM-014 moved Kitchen → Bath (typed row)");
  assert.equal(rows(q).length, 1, "one row for one machine");
  assert.equal(rows(q)[0].location, "Kitchen");
  assert.equal(rows(q)[0].notes, "behind fridge\nmoved to Bath 10/08 10:00");
  assert.equal(recordScan(q, place("AM-014", "bath", "s2", 5)).outcome, "already", "it is in the Bath now");
  assert.equal(recordScan(q, place("AM-014", "Hall", "s3", 10)).message, "AM-014 moved Bath → Hall (typed row)");
  assert.deepEqual(deployedCounts(rows(q)), deployedCounts([{ type: "Air mover" }]));
  // two typed edits racing on one log: the newer copy wins whole, as for any typed edit, and there is still one row
  const a = typed(), b = typed();
  recordScan(a, remove("AM-014", "s4", 0));
  b.dryingLogs[0].readings = [{ id: "r1" }];
  b.updatedAt = "2026-10-12T00:00:00.000Z";
  for (const [x, y] of [[a, b], [b, a]]) {
    const { merged } = mergeProjects(clone(x), clone(y));
    applyScans(merged);
    assert.equal(rows(merged).length, 1);
  }

  assert.equal(recordScan(typed({ location: "" }), place("AM-014", "Kitchen", "s1", 0)).outcome, "already", "a typed row with no room is not moved from nowhere");
  assert.equal(recordScan(typed(), remove("AM-015", "s9", 0)).outcome, "not_here", "another unit is still not here");
  // a typed row whose run is done (Hrs typed, or a Removed that has passed) is not out: a scan starts a new row
  for (const done of [{ hours: "72", _manualHrs: true }, { removed: "2026-10-06T09:00" }]) {
    const d = typed(done);
    assert.equal(recordScan(d, remove("AM-014", "s1", 0)).outcome, "not_here");
    assert.equal(recordScan(d, place("AM-014", "Kitchen", "s2", 0)).outcome, "placed");
    assert.equal(rows(d).length, 2, "the typed run and the new one");
    assert.deepEqual([rows(d)[0].hours, rows(d)[0].removed], [done.hours || "", done.removed || ""], "the typed row is untouched");
  }
  // a planned pickup typed on the row: the unit is out until then, and the Remove scan replaces the plan
  const plan = typed({ removed: "2026-10-12T09:00", hours: 168 });
  const pr = recordScan(plan, remove("AM-014", "s1", 0));
  assert.equal(pr.outcome, "removed");
  assert.deepEqual([rows(plan)[0].removed, rows(plan)[0].hours], ["2026-10-08T10:00", 73]);
  assert.equal(undoTyped(pr), true);
  assert.deepEqual([rows(plan)[0].removed, rows(plan)[0].hours], ["2026-10-12T09:00", 168]);
  // and another job sees a typed row's planned pickup as out, a passed one as in
  const other = (extra) => [{ ...typed(extra), id: "job-1" }];
  assert.ok(openElsewhere(other({ removed: "2026-10-12T09:00" }), "AM-014", "job-2", T0));
  assert.equal(openElsewhere(other({ removed: "2026-10-06T09:00" }), "AM-014", "job-2", T0), null);
  assert.equal(openElsewhere(other({ hours: "72", _manualHrs: true }), "AM-014", "job-2", T0), null);
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

/* ---------- the module's own rules ---------- */
test("scans.js is pure and safe on old iOS: no imports, no DOM or network, none of the newer built-ins", () => {
  const src = readFileSync(fileURLToPath(SCANS_URL), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(/m, "imports nothing");
  assert.doesNotMatch(code, /\b(document|window|fetch|localStorage|sessionStorage|navigator|XMLHttpRequest)\b/);
  assert.doesNotMatch(code, /Object\.hasOwn\b|\.at\(|structuredClone|localeCompare/);
});
