/* The 📐 Magicplan card inside the Floor plan chip (10/2) and the Bid card
   without its Magicplan line — DOM render (jsdom), offline, no network.
   Run: node apps/field/test/magicplan-panel.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

const { magicplanPanel } = await import("../js/magicplan.js");
const { linkMagicplan, adoptExport, mpFilePath } = await import("../js/magicplancalc.js");
const { bidCard } = await import("../js/bid.js");

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Magicplan in the Floor plan chip (DOM)");
const settle = () => new Promise((r) => setTimeout(r, 30));
const noNull = (el) => assert.ok(!/\bnull\b|\bundefined\b/.test(el.textContent), el.textContent.match(/.{0,30}(null|undefined).{0,30}/));
const buttons = (el) => [...el.querySelectorAll("button")].map((b) => b.textContent);

await test("a job with no Magicplan project says so, and offline it offers nothing that needs signal", async () => {
  const el = magicplanPanel({ id: "bj-1", customer: "Gina", address: "631 Eberhardt Rd, Fairbanks, AK 99712" }, {});
  await settle();
  assert.match(el.textContent, /📐 MAGICPLAN/);
  assert.match(el.textContent, /Not linked yet\. Create the project before the visit, or link the one you already scanned\./);
  assert.match(el.textContent, /Create, Link and Pull need signal\./);
  assert.deepEqual(buttons(el), []);
  assert.equal(el.querySelector("details"), null);
  noNull(el);
});

const h = (c) => c.repeat(64);
const ROW = {
  id: "exp-1", mp_project_id: "proj-old", mp_plan_id: "plan-old", synced_at: "2026-10-01T20:00:00", status: "ready",
  files: [
    { path: mpFilePath("bj-2", h("a"), "Report.pdf"), name: "Report.pdf", mime: "application/pdf", size: 2_400_000, hash: h("a"), kind: "report" },
    { path: mpFilePath("bj-2", h("b"), "Scan.usdz"), name: "Scan.usdz", mime: "model/vnd.usdz+zip", size: 9_000_000, hash: h("b"), kind: "model3d" },
    { path: mpFilePath("bj-2", h("c"), "room.svg"), name: "1st Floor - Bedroom.svg", mime: "image/svg+xml", size: 3000, hash: h("c"), kind: "room", room: "Bedroom" },
  ],
  photos: [
    { path: mpFilePath("bj-2", h("d"), "p1.jpg"), name: "1st Floor - Bedroom - Window - 1.jpg", mime: "image/jpeg", size: 300_000, hash: h("d"), room: "Bedroom" },
    { path: mpFilePath("bj-2", h("e"), "p2.jpg"), name: "1st Floor - Bedroom - Door - 1.jpg", mime: "image/jpeg", size: 300_000, hash: h("e"), room: "Bedroom" },
  ],
  statistics: { units: "imperial", floors: [{ name: "1st Floor", rooms: [{ name: "Bedroom", floorSF: 154, perimLF: 44.5, ceilingFt: 8 }] }] },
  floors_svg: [],
};

await test("a linked, pulled job names the project, the pull, and lists every file with ⤓ (photos counted, not listed)", async () => {
  const project = { id: "bj-2", customer: "Gina", address: "631 Eberhardt Rd" };
  linkMagicplan(project, { projectId: "proj-old", planId: "plan-old", createdAt: "2026-09-20T17:00:00Z", name: "Gina — Eberhardt (scanned first)" }, { by: "o", at: "2026-10-02T20:00:00Z" });   // midday in Alaska and in UTC: the same day either way
  adoptExport(project, ROW, "2026-10-02T20:01:00Z");
  let opened = 0;
  const el = magicplanPanel(project, { openSiteVisit: () => { opened++; } });
  await settle();
  assert.match(el.textContent, /Linked to Gina — Eberhardt \(scanned first\) \(linked Oct 2, 2026\)\. Pulled Oct 2, 2026: 3 files, 2 photos, 1 room measured\./);
  const det = el.querySelector("details");
  assert.ok(det, "the files sit in a collapsed list");
  assert.equal(det.open, false);
  assert.equal(det.querySelector("summary").textContent, "📁 Files from Magicplan (3 files, 2 photos)");
  assert.equal([...det.querySelectorAll("button")].filter((b) => b.textContent === "⤓").length, 3);
  assert.match(det.textContent, /Scan\.usdz · 3D/);
  assert.match(det.textContent, /1st Floor - Bedroom\.svg · room plan · Bedroom/);
  assert.match(det.textContent, /The 2 photos sit in the Site Visit packet with their room captions\./);
  const sv = [...det.querySelectorAll("button")].find((b) => b.textContent === "📋 Open in Site Visit");
  sv.click();
  assert.equal(opened, 1);
  noNull(el);
});

await test("a project created by the app (never pulled) reads by its customer and street", async () => {
  const project = { id: "bj-3", customer: "Stevens", address: "12 Elm St, North Pole, AK 99705",
    siteVisit: { files: [], magicplan: { projectId: "p-3", planId: "pl-3", createdAt: "2026-09-30T20:00:00Z", by: "o" } } };
  const el = magicplanPanel(project, { openSiteVisit: () => {} });
  await settle();
  assert.match(el.textContent, /Linked to Stevens — 12 Elm St \(created Sep 30, 2026\)\. Scan it, export in the Magicplan app, then ⟳ Pull\./);
  assert.deepEqual(buttons(el), ["📋 Open in Site Visit"]);
  noNull(el);
});

await test("the Bid card no longer carries a Magicplan line or a Pull button", async () => {
  const project = { id: "bj-4", bidOf: "lead_4", customer: "Stevens", siteVisit: { files: [], magicplan: { projectId: "p-4", planId: "pl-4" } } };
  const card = bidCard(project, { openEstimate: () => {}, onChanged: () => {} });
  document.body.append(card);
  await settle();
  assert.ok(card.textContent.includes("📐 BID"));
  assert.ok(!/Magicplan\s*(not created|ready on phone|scan received|imported)/.test(card.textContent), card.textContent);
  assert.ok(!buttons(card).some((b) => /Pull|Create Magicplan/.test(b)), buttons(card).join(" | "));
});

console.log(`\n${pass} Floor plan chip DOM checks passed.`);
