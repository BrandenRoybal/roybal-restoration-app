/* Equipment-placement pure helpers — hit-testing + angle/clamp math.
   No DOM (the pad itself is browser-verified). Run: node apps/field/test/equipment.test.mjs */
import assert from "node:assert";
import { nearestEquip, stepAngle, clamp01 } from "../js/core.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Equipment placement");

/* ---------- stepAngle: 45° steps that wrap 0–359 ---------- */
ok("rotate right from 0 -> 45", stepAngle(0, 45) === 45);
ok("rotate right wraps past 360", stepAngle(350, 45) === 35);
ok("rotate left from 0 wraps to 315", stepAngle(0, -45) === 315);
ok("rotate left 45 -> 0", stepAngle(45, -45) === 0);
ok("non-numeric angle treated as 0", stepAngle(undefined, 45) === 45);

/* ---------- clamp01: keep normalized coords on the canvas ---------- */
ok("clamps below 0", clamp01(-0.3) === 0);
ok("clamps above 1", clamp01(1.4) === 1);
ok("passes through mid", clamp01(0.42) === 0.42);

/* ---------- nearestEquip: which icon did the tap hit (pixel space) ---------- */
const items = [
  { id: "a", type: "air_mover", x: 0.5, y: 0.5 },        // center -> (50,50) on 100x100
  { id: "b", type: "heater", x: 0.1, y: 0.1 },           // -> (10,10)
];
const W = 100, H = 100;
ok("tap near center selects a", nearestEquip(items, 52, 48, W, H, 26)?.id === "a");
ok("tap near corner selects b", nearestEquip(items, 12, 9, W, H, 26)?.id === "b");
ok("tap in empty space -> null", nearestEquip(items, 90, 90, W, H, 26) === null);
ok("picks the CLOSER of two", nearestEquip([{ id: "a", x: 0.4, y: 0.5 }, { id: "b", x: 0.6, y: 0.5 }], 58, 50, W, H, 30)?.id === "b");
ok("empty list -> null", nearestEquip([], 50, 50, W, H) === null);

console.log(`\n${pass} checks passed.`);
