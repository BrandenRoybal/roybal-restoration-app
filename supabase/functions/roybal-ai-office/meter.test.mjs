/* Meter reading — the pure half (no Deno, no network).
   Run: node --experimental-strip-types meter.test.mjs */
import assert from "node:assert/strict";
import { METER_READ_SCHEMA, METER_UNITS, METER_DEVICES, METER_SYSTEM, meterReadText, normalizeMeterRead, meterReadMode, meterRef } from "./meter.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

test("schema: strict, every field required, enums match the normaliser's lists", () => {
  assert.equal(METER_READ_SCHEMA.additionalProperties, false);
  assert.deepEqual([...METER_READ_SCHEMA.required].sort(), Object.keys(METER_READ_SCHEMA.properties).sort());
  assert.deepEqual(METER_READ_SCHEMA.properties.unit.enum, [...METER_UNITS]);
  assert.deepEqual(METER_READ_SCHEMA.properties.device.enum, [...METER_DEVICES]);
  assert.equal(METER_READ_SCHEMA.properties.confidence.minimum, 0);
  assert.equal(METER_READ_SCHEMA.properties.confidence.maximum, 1);
});

test("prompt: the rules that keep a wrong number out of a reading are in the text", () => {
  const t = meterReadText({});
  assert.match(t, /LARGE primary reading only/);
  assert.match(t, /seven-segment/);
  assert.match(t, /1 vs 7, 5 vs 6/);
  assert.match(t, /Never guess and never round/);
  assert.match(t, /thermo_hygrometer/);
  assert.doesNotMatch(t, /meter \/ setting is/);
  assert.match(METER_SYSTEM, /A wrong number is worse than no number/);
});

test("prompt: the map's meter and material ride along as context, cleaned and capped", () => {
  const t = meterReadText({ meter: "Protimeter MMS3 · Search (REL)\n\u0007", material: "Drywall / Gypsum" });
  assert.match(t, /meter \/ setting is: Protimeter MMS3 · Search \(REL\)\n/);
  assert.match(t, /Material being read: Drywall \/ Gypsum/);
  const long = meterReadText({ meter: "x".repeat(500) });
  assert.ok(long.includes("x".repeat(120)) && !long.includes("x".repeat(121)));
});

test("normalize: a clean read passes through and is fillable", () => {
  const r = normalizeMeterRead({ device: "moisture_meter", readable: true, value: "17.4", unit: "%", mode: " Pin  WME ", confidence: 0.934, note: "" });
  assert.deepEqual(r, { device: "moisture_meter", readable: true, value: "17.4", unit: "%", mode: "Pin WME", confidence: 0.93, note: "", fillable: true });
});

test("normalize: comma decimals, a trailing % and leading zeros become a plain decimal", () => {
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: true, value: "17,4", confidence: 1 }).value, "17.4");
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: true, value: "17.4 %", confidence: 1 }).value, "17.4");
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: true, value: "07.5", confidence: 1 }).value, "7.5");
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: true, value: "0.8", confidence: 1 }).value, "0.8");
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: true, value: "112", confidence: 1 }).value, "112");
});

test("normalize: anything that is not a plain number is not readable and offers no value", () => {
  for (const value of ["1?.4", "17.4.2", "abc", "1234", "", "-3", "17.", ".5", "≤ 16"]) {
    const r = normalizeMeterRead({ device: "moisture_meter", readable: true, value, unit: "%", confidence: 0.9 });
    assert.equal(r.value, "", value);
    assert.equal(r.readable, false, value);
    assert.equal(r.fillable, false, value);
  }
});

test("normalize: the model saying not readable wins over a value it sent anyway", () => {
  const r = normalizeMeterRead({ device: "moisture_meter", readable: false, value: "18.2", confidence: 0.4, note: "glare on the last digit" });
  assert.equal(r.value, "");
  assert.equal(r.fillable, false);
  assert.equal(r.note, "glare on the last digit");
  assert.equal(normalizeMeterRead({ device: "moisture_meter", readable: "true", value: "18.2" }).readable, false);
});

test("normalize: a thermo-hygrometer read is kept but never fillable into a moisture cell", () => {
  const r = normalizeMeterRead({ device: "thermo_hygrometer", readable: true, value: "45", unit: "other", confidence: 0.95, note: "RH 45%, 68°F" });
  assert.equal(r.value, "45");
  assert.equal(r.readable, true);
  assert.equal(r.fillable, false);
});

test("normalize: never throws on junk and clamps confidence", () => {
  for (const junk of [null, undefined, 7, "x", [], { confidence: "high" }]) {
    const r = normalizeMeterRead(junk);
    assert.equal(r.readable, false);
    assert.equal(r.fillable, false);
    assert.equal(r.device, "other");
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
  assert.equal(normalizeMeterRead({ confidence: 7 }).confidence, 1);
  assert.equal(normalizeMeterRead({ confidence: -2 }).confidence, 0);
  assert.equal(normalizeMeterRead({ unit: "WME", device: "pinless" }).unit, "other");
  assert.equal(normalizeMeterRead({ unit: "WME", device: "pinless" }).device, "other");
});

test("mode: check by default, fill and off only on an explicit word", () => {
  for (const v of [undefined, null, "", "  ", "check", "maybe"]) assert.equal(meterReadMode(v), "check", String(v));
  for (const v of ["fill", "FILL", " on ", "true", "1", "yes"]) assert.equal(meterReadMode(v), "fill", v);
  for (const v of ["off", "OFF", "false", "0", "no"]) assert.equal(meterReadMode(v), "off", v);
});

test("ref: the photo and cell ids pass through clean; anything else is dropped", () => {
  assert.deepEqual(meterRef({ photoId: "mp_1-a", mapId: "map1", rowKey: "rk9", loc: 3, photo: "data:..." }),
    { photoId: "mp_1-a", mapId: "map1", rowKey: "rk9", loc: 3 });
  assert.deepEqual(meterRef({ photoId: "a b", mapId: "x".repeat(65), rowKey: 7, loc: -1 }), { photoId: "", mapId: "", rowKey: "", loc: null });
  assert.deepEqual(meterRef({ loc: 2.5 }), { photoId: "", mapId: "", rowKey: "", loc: null });
  assert.deepEqual(meterRef(null), { photoId: "", mapId: "", rowKey: "", loc: null });
});

test("ref: the ids never reach the model's prompt", () => {
  const text = meterReadText({ meter: "Tramex", material: "Drywall", photoId: "mp_secret", rowKey: "rk_secret" });
  assert.ok(!/secret/.test(text));
});

console.log(`\n${pass} checks passed.`);
