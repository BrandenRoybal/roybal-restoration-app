/* Magicplan floor SVG → plan image, the pure half (js/magicplanplan.js).
   Run: node apps/field/test/magicplanplan.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { magicplanFloors, svgWithSize } from "../js/magicplanplan.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Magicplan floor plans");

test("magicplanFloors lists the floors with an SVG on file, in scan order, named", () => {
  const p = { siteVisit: { magicplan: { floors: [
    { floor: "1st Floor", path: "sitevisit/lead_42/mp-11111111-1st_Floor.svg" },
    { floor: "", path: "sitevisit/lead_42/mp-22222222-Basement.svg" },
    { floor: "Attic", path: "" },
    { floor: "Roof", path: "sitevisit/lead_42/mp-33333333-Roof.png" },
  ] } } };
  assert.deepEqual(magicplanFloors(p), [
    { floor: "1st Floor", path: "sitevisit/lead_42/mp-11111111-1st_Floor.svg" },
    { floor: "Floor 2", path: "sitevisit/lead_42/mp-22222222-Basement.svg" },
  ]);
  assert.deepEqual(magicplanFloors({}), []);
  assert.deepEqual(magicplanFloors({ siteVisit: { magicplan: {} } }), []);
});

test("svgWithSize gives a viewBox-only root pixel dimensions with the long side at maxDim, and keeps the drawing", () => {
  const r = svgWithSize('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="1" height="1"/></svg>', 2000);
  assert.equal(r.width, 2000);
  assert.equal(r.height, 1500);
  assert.match(r.svg, /^<\?xml version="1.0"\?><svg width="2000" height="1500" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 400 300"><rect width="1" height="1"\/><\/svg>$/);
});

test("unit widths (mm, %) are replaced from the viewBox; pixel widths are rescaled; a root with neither is refused", () => {
  const mm = svgWithSize('<svg width="210mm" height="297mm" viewBox="0 0 210 297"></svg>', 1000);
  assert.equal(mm.width, 707); assert.equal(mm.height, 1000);
  assert.doesNotMatch(mm.svg, /mm/);
  const px = svgWithSize('<svg width="800" height="200"></svg>', 1600);
  assert.equal(px.width, 1600); assert.equal(px.height, 400);
  assert.match(px.svg, /viewBox="0 0 800 200"/);   // added so the scaled root still maps the drawing
  assert.equal(svgWithSize('<svg xmlns="x"></svg>'), null);
  assert.equal(svgWithSize("not an svg"), null);
  assert.equal(svgWithSize(""), null);
});

console.log(`\n${pass} passed`);
