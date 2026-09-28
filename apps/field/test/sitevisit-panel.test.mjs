/* Site Visit panel — DOM render (jsdom) with the media queue underneath:
   queued / uploading / failed / uploaded clips paint the right chip, the
   "waiting to upload" line shows, a clip the queue no longer holds is
   reconciled to uploaded on open, and no conditional row prints as "null".
   Run: node apps/field/test/sitevisit-panel.test.mjs   (from repo root) */
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

const { siteVisitPanel } = await import("../js/sitevisit.js");
const { enqueueMedia, deps } = await import("../js/mediaqueue.js");
deps.online = () => false;   // nothing drains during the test

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Site Visit panel (DOM) with the media queue");

const blob = new Blob([new Uint8Array(500)], { type: "video/quicktime" });
await enqueueMedia({ id: "w-q", projectId: "p1", kind: "walk", blob, mime: "video/quicktime", name: "IMG_3.MOV", path: "sitevisit/p1/w-q-IMG_3.MOV" });
const failedBlob = new Blob([new Uint8Array(400)], { type: "video/quicktime" });
await enqueueMedia({ id: "w-f", projectId: "p1", kind: "walk", blob: failedBlob, mime: "video/quicktime", name: "IMG_4.MOV", path: "sitevisit/p1/w-f-IMG_4.MOV" });
const { MediaStore } = await import("../js/core.js");
const fr = await MediaStore.get("w-f"); fr.attempts = 5; fr.lastError = "Upload failed (500)"; await MediaStore.put(fr);

const at = "2026-09-26T10:00:00Z";
const project = { id: "p1", customer: "Test", rooms: ["Kitchen"], jobType: "restoration",
  siteVisit: { files: [
    { id: "w-done", kind: "walk", name: "IMG_1.MOV", path: "sitevisit/p1/w-done-IMG_1.MOV", mime: "video/quicktime", duration: 95, room: "Kitchen", status: "transcribed", at, frames: 1,
      transcript: { text: "[00:00] Kitchen.", utterances: [{ start: 0, end: 1, speaker: 0, text: "Kitchen." }], seconds: 95 } },
    { id: "f1", kind: "frames", videoId: "w-done", name: "IMG_1.MOV @ 5s", path: "sitevisit/p1/f1.jpg", mime: "image/jpeg", caption: "still", at },
    { id: "w-q", kind: "walk", name: "IMG_3.MOV", path: "sitevisit/p1/w-q-IMG_3.MOV", mime: "video/quicktime", duration: 40, room: "", status: "queued", at: "2026-09-26T10:03:00Z" },
    { id: "w-f", kind: "walk", name: "IMG_4.MOV", path: "sitevisit/p1/w-f-IMG_4.MOV", mime: "video/quicktime", duration: 50, room: "", status: "queued", at: "2026-09-26T10:04:00Z" },
    { id: "w-gone", kind: "walk", name: "IMG_5.MOV", path: "sitevisit/p1/w-gone-IMG_5.MOV", mime: "video/quicktime", duration: 60, room: "Bath", status: "uploading", at: "2026-09-26T10:05:00Z" },
  ], transcript: "— Clip 1 · Kitchen · 1:35 —\n[00:00] Kitchen.", transcriptSeconds: 95, typedScope: "", pending: null } };
const inv = { id: "e1", items: [], siteVisitDraft: { questions: ["Which tile?"] } };
let saves = 0;
const root = siteVisitPanel({ project, inv, save: () => { saves++; }, onApplied: () => {} });
document.body.append(root);
await new Promise((r) => setTimeout(r, 60));   // reconcileQueue runs on a tick
const text = () => root.textContent;

await test("the walk slot is first, with Record (Camera) and Add from Photos, and works with no signal", () => {
  const cam = [...root.querySelectorAll("input[type=file]")].find((i) => i.getAttribute("capture") === "environment");
  assert.ok(cam && cam.getAttribute("accept") === "video/*");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent === "🎥 Record"));
  assert.ok(text().includes("Works with no signal"));
});

await test("each clip paints its state: transcribed, queued, failed (with Retry), and the one the queue finished is now uploaded", () => {
  const chips = [...root.querySelectorAll(".clipchip")].map((c) => c.textContent);
  assert.ok(chips.includes("transcribed ✓"), chips.join(" | "));
  assert.ok(chips.includes("queued — uploads when the phone has signal"), chips.join(" | "));
  assert.ok(chips.includes("upload failed — tap retry"), chips.join(" | "));
  assert.ok(chips.includes("uploaded"), "w-gone was reconciled: " + chips.join(" | "));
  assert.equal(project.siteVisit.files.find((f) => f.id === "w-gone").status, "uploaded");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent === "Retry"));
  assert.ok(saves >= 1, "the reconciled state was saved");
});

await test("the slot says what is still waiting, and the word null never prints", () => {
  assert.match(text(), /📤 2 clips waiting to upload · 1 MB · 1 failed/);
  assert.ok(text().includes("Open questions from the last draft"));
  assert.ok(!/\bnull\b/.test(text()), text().match(/.{0,30}null.{0,30}/));
});

await test("the drafting notice says how long a batch really takes", () => {
  project.siteVisit.pending = { batchId: "b", invId: "e1", startedAt: new Date().toISOString(), pricingMode: "piecework" };
  const r2 = siteVisitPanel({ project, inv, save: () => {}, onApplied: () => {} });
  assert.ok(r2.textContent.includes("5–30 minutes, up to an hour"));
});

console.log(`\n${pass} passed`);
process.exit(0);
