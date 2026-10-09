/* node --test apps/field/test/meterphotos.test.mjs
   Meter photos on moisture readings (meterphotos.js): the photo is always
   kept, the reader's number is only a prefill, a typed value is never
   overwritten, and every delete is recorded so it sticks across devices. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMeterPhoto, photoAt, mapIndex, rowFor, needsRead, pendingReads, applyMeterRead, cellState, noteTyped,
  confirmMeterPhoto, useMeterRead, removeMeterPhotos, dropsPrefill, rowPhotoIds, locPhotoIds, mapPhotoIds,
  mapPhotoEntries, finalReadingPhotos, uncheckedFills, sweepDeletedMapPhotos, sameReading, rowKeyOf, FILL_MIN, METER_KEY,
} from "../js/meterphotos.js";
import { ID_COLLECTIONS, mergeProjects, tombstoneItems } from "../js/merge.js";
import { blankReadingRow } from "../js/model.js";

const JPEG = "data:image/jpeg;base64," + "A".repeat(40);
const row = (date, values = []) => ({ date, values: [...values, ...Array(13 - values.length).fill("")], notes: "" });
const job = () => ({
  id: "job-1", updatedAt: "2026-10-09T12:00:00.000Z",
  moistureMaps: [{ id: "map-1", meter: "Tramex MEX5", material: "Drywall / Gypsum", readings: [row("2026-10-07"), row("2026-10-08")] }],
});
const read = (value, extra = {}) => ({ meter: { device: "moisture_meter", readable: true, value, unit: "%", mode: "", confidence: 0.95, note: "", fillable: true, model: "m", ...extra }, fill: true });

test("meterPhotos is a top-level id collection, so the merge unions it", () => {
  assert.ok(ID_COLLECTIONS.includes(METER_KEY));
  const a = job(), b = job();
  const pa = addMeterPhoto(a, a.moistureMaps[0], a.moistureMaps[0].readings[0], 0, JPEG);
  const pb = addMeterPhoto(b, b.moistureMaps[0], b.moistureMaps[0].readings[1], 2, JPEG);
  b.updatedAt = "2026-10-09T13:00:00.000Z";          // b's copy of the map wins whole…
  const { merged } = mergeProjects(a, b);
  const ids = merged.meterPhotos.map((p) => p.id).sort();
  assert.deepEqual(ids, [pa.id, pb.id].sort());     // …but both photos survive
});

test("a photo attaches to its cell by the row's rk, never an id field", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const ph = addMeterPhoto(p, m, r, 3, JPEG);
  assert.ok(r.rk && !("id" in r));
  assert.equal(ph.rowKey, r.rk);
  assert.equal(ph.loc, 3);
  assert.equal(ph.date, "2026-10-07");
  assert.equal(photoAt(p, m, r, 3), ph);
  assert.equal(photoAt(p, m, r, 4), null);
  assert.equal(photoAt(p, m, m.readings[1], 3), null);
  assert.equal(rowKeyOf(r), r.rk);                   // stable once assigned
});

test("a retake replaces the cell's photo and records the delete", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const first = addMeterPhoto(p, m, r, 0, JPEG);
  const second = addMeterPhoto(p, m, r, 0, JPEG);
  assert.deepEqual(p.meterPhotos.map((x) => x.id), [second.id]);
  assert.ok(p.deletedIds[first.id]);
  assert.equal(photoAt(p, m, r, 0), second);
});

test("needsRead: only the install that took it asks, with its bytes here, until answered", () => {
  const p = job(), m = p.moistureMaps[0];
  const ph = addMeterPhoto(p, m, m.readings[0], 0, JPEG, "dev-A");
  assert.equal(ph.dev, "dev-A");
  assert.equal(needsRead(ph, "dev-A"), true);
  assert.equal(needsRead(ph, "dev-B"), false, "the office desktop never reads (or bills, or fills) a phone's photo");
  assert.equal(pendingReads(p, "dev-A").length, 1);
  assert.equal(pendingReads(p, "dev-B").length, 0);
  assert.equal(needsRead({ ...ph, src: "media:" + "a".repeat(64) + ":123" }, "dev-A"), false);
  applyMeterRead(p, ph, read("17.4"), "t");
  assert.equal(needsRead(ph, "dev-A"), false);
});

test("check mode records the number on the photo and fills nothing", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const ph = addMeterPhoto(p, m, r, 0, JPEG);
  const out = applyMeterRead(p, ph, { ...read("17.4"), fill: false });
  assert.equal(out.filled, false);
  assert.equal(r.values[0], "");
  assert.equal(ph.read.value, "17.4");
  assert.equal(ph.read.fill, false);
  assert.equal(cellState(ph, ""), "photo");
  assert.equal(cellState(ph, "18"), "photo");        // no ≠ before the reader is trusted
});

test("fill mode fills an EMPTY cell amber until the tech confirms", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const ph = addMeterPhoto(p, m, r, 0, JPEG);
  assert.equal(cellState(ph, ""), "pending");
  assert.equal(applyMeterRead(p, ph, read("17.4")).filled, true);
  assert.equal(r.values[0], "17.4");
  assert.equal(ph.filled, "17.4");
  assert.equal(cellState(ph, r.values[0]), "check");
  confirmMeterPhoto(ph, "t2");
  assert.equal(ph.ok, "t2");
  assert.equal(cellState(ph, r.values[0]), "photo");
});

test("fill mode never overwrites a typed value: it flags the difference instead", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  r.values[0] = "16.9";
  const ph = addMeterPhoto(p, m, r, 0, JPEG);
  assert.equal(applyMeterRead(p, ph, read("17.4")).filled, false);
  assert.equal(r.values[0], "16.9");
  assert.equal(cellState(ph, r.values[0]), "differs");
  assert.equal(cellState(ph, "17.40"), "photo");     // the same number is not a difference
  assert.equal(useMeterRead(p, ph, "t3"), true);
  assert.equal(r.values[0], "17.4");
  assert.equal(cellState(ph, r.values[0]), "photo");
});

test("a doubtful, unreadable or non-moisture read is never a prefill", () => {
  const cases = [
    read("17.4", { confidence: FILL_MIN - 0.01 }),
    read("", { readable: false, fillable: false }),
    read("45", { device: "thermo_hygrometer", fillable: false }),
  ];
  for (const reply of cases) {
    const p = job(), m = p.moistureMaps[0], r = m.readings[0];
    const ph = addMeterPhoto(p, m, r, 0, JPEG);
    assert.equal(applyMeterRead(p, ph, reply).filled, false);
    assert.equal(r.values[0], "");
    assert.equal(cellState(ph, "12"), "photo");
  }
});

test("typing over the prefill is a correction and the typed value is the reading", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const ph = addMeterPhoto(p, m, r, 0, JPEG);
  applyMeterRead(p, ph, read("17.4"));
  assert.equal(noteTyped(ph, "17.4", "x"), false);  // unchanged: still unconfirmed
  r.values[0] = "11.4";
  assert.equal(noteTyped(ph, r.values[0], "t4"), true);
  assert.equal(ph.ok, "t4");
  assert.equal(ph.fixed, "11.4");
  assert.equal(cellState(ph, r.values[0]), "photo");
});

test("a capped month or a switched-off reader stamps nothing: the photo waits to be read later", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const a = addMeterPhoto(p, m, r, 0, JPEG, "d"), b = addMeterPhoto(p, m, r, 1, JPEG, "d");
  assert.deepEqual(applyMeterRead(p, a, { capped: true }, "t"), { filled: false });
  assert.deepEqual(applyMeterRead(p, b, { off: true }, "t"), { filled: false });
  assert.equal(a.read, null);
  assert.equal(b.read, null);
  assert.equal(pendingReads(p, "d").length, 2);
});

test("new reading rows carry their key from the start", () => {
  const r = blankReadingRow();
  assert.ok(typeof r.rk === "string" && r.rk.length > 4);
  assert.ok(!("id" in r));
  assert.notEqual(blankReadingRow().rk, r.rk);
});

test("another device's copy of the map without the row's key: the photo still finds its reading by date", () => {
  const p = job(), m = p.moistureMaps[0];
  const ph = addMeterPhoto(p, m, m.readings[1], 4, JPEG);
  const theirs = { ...m, readings: [row("2026-10-07"), row("2026-10-08")] };   // a newer copy, rows with no rk
  p.moistureMaps = [theirs];
  assert.equal(rowFor(theirs, ph), theirs.readings[1]);
  assert.equal(photoAt(p, theirs, theirs.readings[1], 4), ph);
  assert.deepEqual(rowPhotoIds(p, theirs, theirs.readings[1]), [ph.id]);
  // two rows on that date: no guessing
  theirs.readings.push(row("2026-10-08"));
  assert.equal(rowFor(theirs, ph), null);
  assert.equal(mapIndex(p, theirs).orphans.length, 1);
});

test("a fill that another device's copy of the map dropped asks again: an empty cell, still 'check'", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const ph = addMeterPhoto(p, m, r, 0, JPEG);
  applyMeterRead(p, ph, read("17.4"));
  r.values[0] = "";                                   // the newer copy of the map never had it
  assert.equal(cellState(ph, ""), "check");
  assert.equal(noteTyped(ph, "", "t"), false, "clearing the cell is not a correction");
  assert.equal(uncheckedFills(p).length, 1);
  assert.equal(useMeterRead(p, ph, "t5"), true);
  assert.equal(r.values[0], "17.4");
  assert.equal(cellState(ph, r.values[0]), "photo");
});

test("a retake or a delete takes an UNCONFIRMED prefill out with the photo; a checked or typed number stays", () => {
  const p = job(), m = p.moistureMaps[0], r = m.readings[0];
  const a = addMeterPhoto(p, m, r, 0, JPEG);
  applyMeterRead(p, a, read("17.1"));
  assert.equal(dropsPrefill(p, a), true);
  const b = addMeterPhoto(p, m, r, 0, JPEG);          // retake
  assert.equal(r.values[0], "", "an unchecked AI number never stays behind looking typed");
  assert.equal(applyMeterRead(p, b, read("17.4")).filled, true, "the new photo's read fills the cell afresh");
  confirmMeterPhoto(b, "ok");
  assert.equal(dropsPrefill(p, b), false);
  removeMeterPhotos(p, [b.id]);
  assert.equal(r.values[0], "17.4", "a checked number stays");
  r.values[1] = "9";
  const c = addMeterPhoto(p, m, r, 1, JPEG);
  removeMeterPhotos(p, [c.id]);
  assert.equal(r.values[1], "9", "a typed number stays");
});

test("deleting a reading date, trailing locations or the map takes their photos along, with tombstones", () => {
  const p = job(), m = p.moistureMaps[0];
  const [r0, r1] = m.readings;
  const a = addMeterPhoto(p, m, r0, 0, JPEG), b = addMeterPhoto(p, m, r0, 14, JPEG), c = addMeterPhoto(p, m, r1, 2, JPEG);
  assert.deepEqual(rowPhotoIds(p, m, r0).sort(), [a.id, b.id].sort());
  assert.deepEqual(locPhotoIds(p, m, 13), [b.id]);
  assert.equal(removeMeterPhotos(p, locPhotoIds(p, m, 13)), 1);
  assert.ok(p.deletedIds[b.id]);
  assert.equal(removeMeterPhotos(p, rowPhotoIds(p, m, r0)), 1);
  assert.deepEqual(mapPhotoIds(p, "map-1"), [c.id]);
  assert.equal(removeMeterPhotos(p, mapPhotoIds(p, "map-1")), 1);
  assert.equal(p.meterPhotos.length, 0);
  assert.equal(removeMeterPhotos(p, ["nope"]), 0);
  // the merge honours the marks: another device's copy cannot bring them back
  const other = job();
  other.meterPhotos = [{ ...a }, { ...c }];
  other.updatedAt = "2026-10-09T14:00:00.000Z";
  assert.equal(mergeProjects(p, other).merged.meterPhotos.length, 0);
});

test("the appendix lists photos in grid order and keeps a photo whose row is gone", () => {
  const p = job(), m = p.moistureMaps[0];
  const [r0, r1] = m.readings;
  r1.values[2] = "14";
  const late = addMeterPhoto(p, m, r1, 2, JPEG);
  const early = addMeterPhoto(p, m, r0, 5, JPEG);
  const lost = addMeterPhoto(p, m, { date: "2026-10-06", values: [] }, 1, JPEG);   // a row no longer on the map
  const e = mapPhotoEntries(p, m);
  assert.deepEqual(e.map((x) => x.ph.id), [early.id, late.id, lost.id]);
  assert.equal(e[1].value, "14");
  assert.equal(e[1].date, "2026-10-08");
  assert.equal(e[2].orphan, true);
  assert.equal(e[2].date, "2026-10-06");
  assert.equal(mapIndex(p, { id: "other" }).byRow.size, 0);
});

test("the certificate shows each location's final reading only when that cell has a photo", () => {
  const p = job(), m = p.moistureMaps[0];
  const [r0, r1] = m.readings;
  r0.values[0] = "30"; r0.values[1] = "28"; r1.values[0] = "12";   // loc 2's final reading is on 10/07
  addMeterPhoto(p, m, r0, 0, JPEG);                  // not final: loc 1's final is 10/08
  const fin0 = addMeterPhoto(p, m, r1, 0, JPEG);
  const fin1 = addMeterPhoto(p, m, r0, 1, JPEG);
  const f = finalReadingPhotos(p);
  assert.deepEqual(f.map((x) => [x.loc, x.ph.id, x.value, x.date]), [[0, fin0.id, "12", "2026-10-08"], [1, fin1.id, "28", "2026-10-07"]]);
  assert.deepEqual(f.map((x) => x.unchecked), [false, false]);
  assert.deepEqual(finalReadingPhotos(job()), []);
  // a final number the reader filled and nobody checked is marked
  const q = job(), qm = q.moistureMaps[0];
  const ph = addMeterPhoto(q, qm, qm.readings[1], 3, JPEG);
  applyMeterRead(q, ph, read("11"));
  assert.deepEqual(finalReadingPhotos(q).map((x) => [x.loc, x.value, x.unchecked]), [[3, "11", true]]);
});

test("the merge keeps a photo's read and check even when the copy without them is newer", () => {
  const a = job(), m = a.moistureMaps[0];
  const ph = addMeterPhoto(a, m, m.readings[0], 0, JPEG, "d");
  const office = JSON.parse(JSON.stringify(a));        // pulled before the read landed
  applyMeterRead(a, ph, read("17.4"), "read-at");
  confirmMeterPhoto(ph, "ok-at");
  office.customer = "renamed in the office";
  office.updatedAt = "2026-10-09T15:00:00.000Z";      // and saved later: the newer copy
  for (const [x, y] of [[a, office], [office, a]]) {
    const out = mergeProjects(x, y).merged.meterPhotos.find((e) => e.id === ph.id);
    assert.equal(out.read.value, "17.4");
    assert.equal(out.filled, "17.4");
    assert.equal(out.ok, "ok-at");
  }
  // the newer copy's own read and check are never replaced
  const b = JSON.parse(JSON.stringify(a));
  b.meterPhotos[0].read = { ...b.meterPhotos[0].read, value: "18" };
  b.meterPhotos[0].ok = "b-ok";
  b.updatedAt = "2026-10-09T16:00:00.000Z";
  const both = mergeProjects(a, b).merged.meterPhotos[0];
  assert.equal(both.read.value, "18");
  assert.equal(both.ok, "b-ok");
  // a typed correction travels with its check
  const c = JSON.parse(JSON.stringify(office));
  const t = JSON.parse(JSON.stringify(a));
  t.meterPhotos[0].ok = "typed-at"; t.meterPhotos[0].fixed = "16";
  assert.equal(mergeProjects(t, c).merged.meterPhotos[0].fixed, "16");
});

test("photos on a map deleted on another device are swept, with their own tombstones", () => {
  const p = job(), m = p.moistureMaps[0];
  const ph = addMeterPhoto(p, m, m.readings[0], 0, JPEG);
  assert.equal(sweepDeletedMapPhotos(p), 0);
  tombstoneItems(p, "map-1");
  p.moistureMaps = [];
  assert.equal(sweepDeletedMapPhotos(p), 1);
  assert.equal(p.meterPhotos.length, 0);
  assert.ok(p.deletedIds[ph.id]);
});

test("sameReading compares numbers, not spellings", () => {
  assert.ok(sameReading("17.4", "17.40"));
  assert.ok(sameReading("17,4", "17.4"));
  assert.ok(sameReading(" 8 ", "8.0"));
  assert.ok(!sameReading("17.4", "17.5"));
  assert.ok(!sameReading("", "0"));
  assert.ok(sameReading("", " "));
});
