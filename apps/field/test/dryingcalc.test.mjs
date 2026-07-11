/* Drying equipment sizing — deterministic S500 math, pure logic.
   Run: node apps/field/test/dryingcalc.test.mjs   (from repo root) */
import assert from "node:assert";
import { equipmentCalc, deployedCounts, DEHU_CLASS_FACTOR } from "../js/dryingcalc.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Drying equipment sizing (S500)");

const ROOMS = [
  { name: "Living Room", floorSF: "259", perimLF: "65" },   // ceil(65/13)=5 AM
  { name: "Hallway", floorSF: "48", perimLF: "32" },        // ceil(32/13)=3 AM
];

const c2 = equipmentCalc({ rooms: ROOMS, waterClass: "2", waterCategory: "1", affT: "72", ceiling: 8, dehuPints: 70 });
ok("totals roll up (307 SF, 97 LF, 2456 cu ft)", c2.inputs.sf === 307 && c2.inputs.lf === 97 && c2.inputs.volume === 2456);
ok("air movers: 1 per 13 LF per room (5+3)", c2.airMovers.count === 8);
ok("class 2 dehu pints: 2456/50 = 50 ppd", c2.dehu.pintsPerDay === 50);
ok("one 70-pint LGR covers it", c2.dehu.units === 1);
ok("cat 1: no scrubbers", c2.scrubbers.count === 0 && /Not required/.test(c2.scrubbers.basis));
ok("72°F: no aux heat", c2.heat.known && c2.heat.needed === false);
ok("basis lines cite S500", /S500/.test(c2.airMovers.basis) && /S500/.test(c2.dehu.basis));

const c3 = equipmentCalc({ rooms: ROOMS, waterClass: "3", waterCategory: "3", affT: "58", ceiling: 8, dehuPints: 70 });
ok("class 3 factor 40: 2456/40 = 62 ppd", c3.dehu.pintsPerDay === 62);
ok("cat 3: 4 ACH scrubbers (2456*4/30000 -> 1)", c3.scrubbers.count === 1 && /4 ACH/.test(c3.scrubbers.basis));
ok("58°F: aux heat needed", c3.heat.needed === true && /70–90/.test(c3.heat.basis));

const big = equipmentCalc({ rooms: [{ name: "Whole floor", floorSF: "4000", perimLF: "300" }], waterClass: "3", waterCategory: "3", affT: "75", ceiling: 9, dehuPints: 110 });
ok("big job: volume uses ceiling (36000 cu ft)", big.inputs.volume === 36000);
ok("big job: 900 ppd -> 9 x 110-pint units", big.dehu.pintsPerDay === 900 && big.dehu.units === 9);
ok("big job: cat 3 scrubbers = ceil(144000/30000) = 5", big.scrubbers.count === 5);

const c1 = equipmentCalc({ rooms: [{ name: "Bath", floorSF: "60", perimLF: "10" }], waterClass: "1", waterCategory: "2" });
ok("class 1 factor 100 + min 1 unit", DEHU_CLASS_FACTOR["1"] === 100 && c1.dehu.units === 1);
ok("cat 2: 2 ACH scrubber recommended", c1.scrubbers.count === 1 && /2 ACH/.test(c1.scrubbers.basis));
ok("tiny room still gets 1 air mover", c1.airMovers.count === 1);
ok("no affT: heat unknown, says to log a reading", c1.heat.known === false && /No affected-air temperature/.test(c1.heat.basis));

ok("nothing to size -> null", equipmentCalc({ rooms: [] }) === null && equipmentCalc({}) === null);
ok("rooms with no numbers -> null", equipmentCalc({ rooms: [{ name: "X", floorSF: "", perimLF: "" }] }) === null);

const dep = deployedCounts([
  { type: "Dri-Eaz Velo Pro low-profile air mover" }, { type: "axial fan" }, { type: "Centrifugal mover" },
  { type: "LGR 7000XLi dehumidifier" }, { type: "Dehu #2" },
  { type: "HEPA air scrubber" }, { type: "Negative air machine" },
  { type: "Aux heater" }, { type: "" },
]);
ok("deployed counts match free-text types", dep.airMovers === 3 && dep.dehus === 2 && dep.scrubbers === 2 && dep.heaters === 1);

console.log(`\n${pass} drying-calc checks passed.`);
