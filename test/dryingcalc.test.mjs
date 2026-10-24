/* Drying equipment sizing — the IICRC WRT worksheets (US Imperial), pure math.
   Run: node apps/field/test/dryingcalc.test.mjs   (from repo root) */
import assert from "node:assert";
import { airmoverCalc, dehuCalc, scrubberCalc, equipmentCalc, deployedCounts, equipClassOf, DEHU_FACTORS } from "../js/dryingcalc.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Drying equipment sizing (WRT worksheets)");

/* ---------- Airmover worksheet: 1/room + floor ÷70/÷50 + upper ÷150/÷100 + insets ---------- */
const ROOMS = [
  { name: "Living Room", floorSF: "259", perimLF: "65" },
  { name: "Hallway", floorSF: "48", perimLF: "32" },
];
const am = airmoverCalc({ rooms: ROOMS });
ok("step 1+2 low: 2 rooms + ceil(307/70)=5 -> 7", am.low === 7);
ok("step 1+2 high: 2 rooms + ceil(307/50)=7 -> 9", am.high === 9);
ok("floor/perimeter totals carried", am.floorSF === 307 && am.perimLF === 97);

const amFull = airmoverCalc({ rooms: ROOMS, upperWetSF: 220, insets: 2 });
ok("step 3 low: +ceil(220/150)=2 -> 11 total", amFull.low === 7 + 2 + 2);
ok("step 3 high: +ceil(220/100)=3 -> 14 total", amFull.high === 9 + 3 + 2);
ok("basis walks the worksheet steps", /1\/room \(2\)/.test(amFull.basis) && /÷70\/÷50/.test(amFull.basis) && /inset/.test(amFull.basis));

const lower = airmoverCalc({ rooms: ROOMS, lowerWallsOnly: true });
ok("lower-walls rule: ceil(97/14) = 7, one figure (no range)", lower.low === 7 && lower.high === 7 && lower.mode === "lowerWalls");
ok("lower-walls basis cites 14 LF", /14 /.test(lower.basis));

ok("fractions round UP (351 SF -> ceil 5.01 = 6 low)", airmoverCalc({ rooms: [{ name: "A", floorSF: "351", perimLF: "1" }] }).low === 1 + 6);
ok("nothing to size -> null", airmoverCalc({ rooms: [] }) === null && airmoverCalc({}) === null);

/* ---------- Dehumidification factor chart ---------- */
ok("factor chart matches the worksheet",
  DEHU_FACTORS.conv["2"] === 40 && DEHU_FACTORS.conv["3"] === 30 && DEHU_FACTORS.conv["4"] === null &&
  DEHU_FACTORS.lgr["3"] === 40 && DEHU_FACTORS.lgr["4"] === 40 &&
  DEHU_FACTORS.desiccant["1"] === 1 && DEHU_FACTORS.desiccant["4"] === 3);

const lgr = dehuCalc({ volume: 2456, waterClass: "3", type: "lgr", ahamPints: 70 });
ok("LGR class 3: 2456/40 = 62 PPD -> 1 x 70-pint", lgr.pintsPerDay === 62 && lgr.units === 1);
const conv2 = dehuCalc({ volume: 2456, waterClass: "2", type: "conv", ahamPints: 70 });
ok("Conventional class 2 factor 40: 62 PPD", conv2.pintsPerDay === 62);
const conv4 = dehuCalc({ volume: 2456, waterClass: "4", type: "conv" });
ok("Conventional class 4 is N/A per the chart", conv4.na === true && /N\/A/.test(conv4.basis));
const big = dehuCalc({ volume: 36000, waterClass: "3", type: "lgr", ahamPints: 110 });
ok("36k cu ft class 3 LGR: 900 PPD -> 9 x 110-pint", big.pintsPerDay === 900 && big.units === 9);
const des = dehuCalc({ volume: 12000, waterClass: "2", type: "desiccant", cfmRating: 500 });
ok("desiccant class 2: 12000 x 2 ACH / 60 = 400 CFM -> 1 x 500-CFM", des.ach === 2 && des.cfm === 400 && des.units === 1);
const des3 = dehuCalc({ volume: 30000, waterClass: "3", type: "desiccant", cfmRating: 500 });
ok("desiccant class 3: 30000 x 3 / 60 = 1500 CFM -> 3 units", des3.cfm === 1500 && des3.units === 3);
ok("no volume -> null", dehuCalc({ volume: 0, waterClass: "2" }) === null);

/* ---------- AFD / scrubbers via the desiccant formula ---------- */
const sc3 = scrubberCalc({ volume: 2456, waterCategory: "3" });
ok("cat 3: 2456 x 4 / 60 = 164 CFM -> 1 x 500-CFM AFD", sc3.cfm === 164 && sc3.count === 1);
const sc3big = scrubberCalc({ volume: 36000, waterCategory: "3" });
ok("cat 3 big: 2400 CFM -> 5 AFDs", sc3big.cfm === 2400 && sc3big.count === 5);
ok("cat 1: none", scrubberCalc({ volume: 2456, waterCategory: "1" }).count === 0);

/* ---------- Full pass + aux heat ---------- */
const full = equipmentCalc({ rooms: ROOMS, waterClass: "3", waterCategory: "3", affT: "58", ceiling: 8, dehuType: "lgr", dehuPints: 70 });
ok("volume from ceiling: 307 x 8 = 2456", full.inputs.volume === 2456);
ok("58°F -> aux heat needed", full.heat.needed === true && /70–90/.test(full.heat.basis));
ok("72°F -> no aux heat", equipmentCalc({ rooms: ROOMS, waterClass: "2", waterCategory: "1", affT: "72" }).heat.needed === false);
ok("no affT -> heat unknown", equipmentCalc({ rooms: ROOMS, waterClass: "2", waterCategory: "1" }).heat.known === false);

/* ---------- Deployed counts from free-text equipment types ---------- */
const dep = deployedCounts([
  { type: "Dri-Eaz Velo Pro low-profile air mover" }, { type: "axial fan" }, { type: "Centrifugal mover" },
  { type: "LGR 7000XLi dehumidifier" }, { type: "Dehu #2" },
  { type: "HEPA air scrubber" }, { type: "Negative air machine" },
  { type: "Aux heater" }, { type: "" },
]);
ok("deployed counts match free-text types", dep.airMovers === 3 && dep.dehus === 2 && dep.scrubbers === 2 && dep.heaters === 1);
// deliberate change: an LGR or desiccant unit is a dehu even without the word (it used to count as nothing)
const lgr2 = deployedCounts([{ type: "LGR 7000XLi" }, { type: "Phoenix desiccant" }, { type: "lgr" }, { type: "Dehu #2" }, null, { type: "Generator" }]);
ok("LGR / desiccant without 'dehu' now count as dehus; unmatched and empty rows still count nothing",
  lgr2.dehus === 4 && lgr2.airMovers === 0 && lgr2.scrubbers === 0 && lgr2.heaters === 0);
ok("deployedCounts tolerates a non-array", deployedCounts(null).dehus === 0 && deployedCounts(undefined).airMovers === 0);

/* ---------- equipClassOf: the one classifier both counters use ---------- */
const CLASS_CASES = [
  ["LGR 7000XLi dehumidifier", "dehu"], ["Dehu #2", "dehu"], ["LGR 7000XLi", "dehu"], ["Desiccant 1200", "dehu"],
  ["lgr_dehumidifier", "dehu"], ["HEPA air scrubber", "scrubber"], ["Negative air machine", "scrubber"],
  ["neg. air", "scrubber"], ["AFD 500", "scrubber"], ["air_scrubber", "scrubber"], ["Air filtration device", "scrubber"],
  ["Aux heater", "heater"], ["heater", "heater"], ["Dri-Eaz Velo Pro low-profile air mover", "airMover"],
  ["axial fan", "airMover"], ["Centrifugal mover", "airMover"], ["air_mover", "airMover"], ["air movers", "airMover"],
  ["Generator", null], ["", null], [null, null], [undefined, null],
];
for (const [type, want] of CLASS_CASES) ok(`equipClassOf(${JSON.stringify(type)}) -> ${want}`, equipClassOf(type) === want);
ok("first match wins: a 'dehu' scrubber combo stays a dehu, a heated mover is a heater",
  equipClassOf("dehu + scrubber") === "dehu" && equipClassOf("heated air mover") === "heater");
ok("LGR run into a model number (\"LGR7000\") is not matched: the word needs a boundary", equipClassOf("LGR7000") === null);

/* ---------- M3: Magicplan room volume, offered ---------- */
const MEASURED = [
  { name: "Living Room", floorSF: "214", perimLF: "58", ceiling: "8 ft", source: "magicplan", conf: 1, volumeCF: 1900 },   // scan says 1900, floor × ceiling says 1712
  { name: "Hall", floorSF: "40", perimLF: "26", ceiling: "", source: "magicplan", conf: 1, volumeCF: 0 },
];
const offCalc = equipmentCalc({ rooms: MEASURED, waterClass: "2", waterCategory: "1", affT: "72" });
const onCalc = equipmentCalc({ rooms: MEASURED, waterClass: "2", waterCategory: "1", affT: "72", useMeasuredVolume: true });
ok("without the chip the volume is floor × ceiling as before", offCalc.inputs.volume === 254 * 8 && offCalc.inputs.measuredVolumeRooms === 0);
ok("with the chip a room's scanned volume replaces its floor × ceiling; rooms without one keep the formula", onCalc.inputs.volume === 1900 + 40 * 8 && onCalc.inputs.measuredVolumeRooms === 1);
ok("the dehu basis says the volume was measured, and by how much of the job", /measured by the Magicplan scan for 1 of 2 room\(s\)/.test(onCalc.dehu.basis) && !/Magicplan/.test(offCalc.dehu.basis));

console.log(`\n${pass} drying-calc checks passed.`);
