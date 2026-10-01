/* Site Visit panel — the 📝 Scope notes section and the ▶ clip player (jsdom).
   Notes render amber per room; ✓ / ✕ / Accept the rest settle them; "Use as
   typed scope" copies the accepted instructions; ▶ opens a player seeked to
   the second the note was said; the draft's uncited instructions list.
   Run: node apps/field/test/scopenotes-panel.test.mjs   (from repo root) */
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
// jsdom has no media pipeline
for (const m of ["load", "pause"]) window.HTMLMediaElement.prototype[m] = () => {};
window.HTMLMediaElement.prototype.play = () => Promise.resolve();

const { siteVisitPanel, openClipPlayer, packetForDraft } = await import("../js/sitevisit.js");
const { enqueueMedia, deps } = await import("../js/mediaqueue.js");
const { adoptScopeNotes } = await import("../js/scopenotes.js");
deps.online = () => false;

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Site Visit panel — scope notes and the clip player");

const at = "2026-10-01T10:00:00Z";
const project = { id: "p1", customer: "Test", rooms: ["Kitchen"], jobType: "restoration",
  siteVisit: { files: [
    { id: "w1", kind: "walk", name: "IMG_1.MOV", path: "sitevisit/p1/w1-IMG_1.MOV", mime: "video/quicktime", duration: 95, room: "Kitchen", status: "transcribed", at, frames: 0,
      transcript: { text: "[00:00] Kitchen.", utterances: [{ start: 0, end: 1, speaker: 0, text: "Kitchen." }], seconds: 95 } },
  ], transcript: "— Clip 1 · Kitchen · 1:35 —\n[00:00] Kitchen.", transcriptSeconds: 95, typedScope: "", pending: null } };
adoptScopeNotes(project.siteVisit, { rooms: [{ room: "Kitchen", items: [
  { bucket: "instructions", text: "take it to four feet on the sink wall", clip: 1, at: 12 },
  { bucket: "verify", text: "check the subfloor under the fridge", clip: 1, at: 80 },
] }] });
const inv = { id: "e1", items: [], siteVisitDraft: { questions: [], uncovered: [{ id: "N1", text: "take it to four feet on the sink wall", cite: "walk Kitchen 0:12" }] } };
let saves = 0;
const root = siteVisitPanel({ project, inv, save: () => { saves++; }, onApplied: () => {} });
document.body.append(root);
await new Promise((r) => setTimeout(r, 50));
const btn = (label, scope = root) => [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
const note = (id) => root.querySelector(`[data-note="${id}"]`);

await test("the section sits under the walk clips with counts, rooms open while notes need checking", () => {
  assert.match(root.textContent, /📝 Scope notes/);
  assert.match(root.textContent, /2 notes · 2 to check · 1 to verify/);
  const d = root.querySelector("details");
  assert.ok(d && d.open, "Kitchen is open");
  assert.ok(note("N1").textContent.includes("take it to four feet"));
  assert.ok(note("N1").getAttribute("style").includes("#fff4e5"), "unreviewed is amber");
  assert.ok(btn("↻ Draft again"));
  assert.ok(!/\bnull\b/.test(root.textContent));
});

await test("✓ keeps a note, ✓ again un-keeps it; ✕ strikes it out", () => {
  btn("✓", note("N1")).click();
  assert.equal(project.siteVisit.scopeNotes.rooms[0].items[0].state, "accepted");
  assert.match(root.textContent, /1 to check/);
  btn("✓", note("N1")).click();
  assert.equal(project.siteVisit.scopeNotes.rooms[0].items[0].state, undefined);
  btn("✕", note("N2")).click();
  assert.equal(project.siteVisit.scopeNotes.rooms[0].items[1].state, "rejected");
  assert.match(root.textContent, /2 notes · 1 to check(?! · 1 to verify)/);
});

await test("✎ rewords and keeps it", () => {
  window.prompt = () => "tear out to 4 ft on the sink wall";
  globalThis.window.prompt = window.prompt;
  btn("✎", note("N1")).click();
  const it = project.siteVisit.scopeNotes.rooms[0].items[0];
  assert.equal(it.text, "tear out to 4 ft on the sink wall");
  assert.equal(it.state, "accepted");
  assert.equal(project.siteVisit.scopeNotes.status, "reviewed");
  assert.match(root.textContent, /all checked ✓/);
});

await test("Use as typed scope copies the accepted instruction; the draft packet carries only accepted notes", () => {
  btn("Use as typed scope").click();
  assert.equal(project.siteVisit.typedScope, "Kitchen:\n- tear out to 4 ft on the sink wall");
  const p = packetForDraft(project.siteVisit);
  assert.match(p.scopeNotes, /\[N1\] INSTRUCTION: tear out to 4 ft on the sink wall \(walk Kitchen 0:12\)/);
  assert.ok(!p.scopeNotes.includes("subfloor"), "a rejected note never reaches the draft");
  assert.ok(saves > 0);
});

await test("the draft's uncited instructions are listed", () => {
  assert.match(root.textContent, /Said on the walk, not in this estimate/);
  assert.match(root.textContent, /\[N1\] take it to four feet on the sink wall — walk Kitchen 0:12/);
});

await test("each walk clip has a ▶, and a note's ▶ opens the player seeked to just before its second", async () => {
  assert.ok(btn("▶"), "the clip row's play button");
  // a clip still in the queue plays from the phone
  const blob = new Blob([new Uint8Array(10)], { type: "video/quicktime" });
  await enqueueMedia({ id: "w1", projectId: "p1", kind: "walk", blob, mime: "video/quicktime", name: "IMG_1.MOV", path: "sitevisit/p1/w1-IMG_1.MOV" });
  globalThis.URL.createObjectURL = () => "blob:clip";
  globalThis.URL.revokeObjectURL = () => {};
  const chip = [...note("N1").querySelectorAll("button")].find((b) => b.textContent.startsWith("▶ "));
  assert.equal(chip.textContent, "▶ Kitchen 0:12");
  chip.click();
  for (let t = Date.now(); Date.now() - t < 2000 && !document.querySelector(".clipplayer");) await new Promise((r) => setTimeout(r, 10));
  const player = document.querySelector(".clipplayer");
  assert.ok(player, "the player opened");
  const v = player.querySelector("video");
  assert.equal(v.getAttribute("src") || v.src, "blob:clip");
  assert.match(player.textContent, /walk Kitchen 0:12/);
  btn("Close", player).click();
  assert.ok(!document.querySelector(".clipplayer"));
});

await test("a clip with no path doesn't open anything", async () => {
  await openClipPlayer({ id: "x" }, 5);
  assert.ok(!document.querySelector(".clipplayer"));
});

console.log(`\n${pass} passed`);
process.exit(0);
