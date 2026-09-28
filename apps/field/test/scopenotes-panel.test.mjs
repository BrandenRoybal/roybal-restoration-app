/* Scope Notes section — DOM render (jsdom): room accordions from the merged
   notes, amber until kept, ✓/✕ update the review state, "Accept all in this
   room" and "Use as typed scope" carry the accepted lines into the typed
   scope under the room heading, and "Not in estimate" lists what the draft
   missed. No network: nothing here calls the office.
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

const { scopeNotesSection } = await import("../js/scopenotes.js");
const { mergeScopeNotes, noteItems, NOTE_BUCKETS, clipKey } = await import("../js/walk.js");

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Scope Notes section (DOM)");

const room = (name, o = {}) => { const r = { room: name }; for (const b of NOTE_BUCKETS) r[b] = o[b] || []; return r; };
const notes = { clip: "c1", clipRoom: "Kitchen", dropped: 0, jobWide: room(""),
  rooms: [room("Kitchen", { observations: [{ text: "base run swollen at the toe kick", clip: "c1", at: 12 }],
    instructions: [{ text: "Take it to four feet on the sink wall.", clip: "c1", at: 134 }, { text: "new hood vent to the outside", clip: "c1", at: 160 }],
    verify: [{ text: "~12 LF (est. from still 01:42)", clip: "c1", at: 102 }] })] };
const at = "2026-09-26T10:00:00Z";
const clip = { id: "c1", kind: "walk", name: "IMG_1.MOV", path: "sitevisit/p1/c1.MOV", room: "Kitchen", status: "transcribed", at, duration: 170,
  transcript: { text: "hello", utterances: [{ start: 0, end: 1, speaker: 0, text: "Kitchen." }], seconds: 170 } };
const project = { id: "p1", rooms: ["Kitchen"], jobType: "restoration", siteVisit: { files: [clip], typedScope: "", scopeNotes: null } };
const sv = project.siteVisit;
sv.scopeNotes = mergeScopeNotes([{ key: clipKey(clip), notes }], { at });   // current for this transcript → "Re-read", not "Update"
const inv = { id: "e1", items: [{ room: "Kitchen", desc: "Cabinetry - lower (base) units - Detach & reset, sink wall to 4 feet" }] };
let saves = 0, typed = 0;
const root = scopeNotesSection({ project, sv, inv, save: () => { saves++; }, onTypedScope: () => { typed++; } });
document.body.append(root);
const text = () => root.textContent;
const rows = () => [...root.querySelectorAll("details div[style*='border-radius:7px']")];

test("the room accordion lists every note amber with its ▶ time chip and the ✓ ✎ ✕ trio", () => {
  const det = root.querySelector("details");
  assert.ok(det && det.open, "the room with open items is expanded");
  assert.match(det.querySelector("summary").textContent, /^Kitchen · 4 notes$/);
  assert.equal(rows().length, 4);
  assert.ok(rows().every((r) => r.getAttribute("style").includes("#fff4e5")), "amber until kept");
  assert.match(text(), /Observed/); assert.match(text(), /Instructions/); assert.match(text(), /Verify/);
  assert.ok(rows()[0].textContent.includes("▶ 0:12"));
  assert.match(text(), /4 notes · 0 accepted · 1 to verify/);
  assert.match(text(), /Not in estimate \(0\)|new hood vent/, "the hood vent has no line yet, but it isn't accepted so it isn't missing yet");
  assert.doesNotMatch(text(), /Not in estimate/);
  assert.match(text(), /↻ Re-read the clips/);
});

test("✓ keeps a note (green), ✕ drops it (struck), and the summary follows; the review state is saved", () => {
  const items = noteItems(sv.scopeNotes);
  const keep = rows()[0].querySelector("button[title='Keep']");
  keep.click();
  assert.equal(sv.scopeNotes.accepted[items[0].key], true);
  assert.ok(rows()[0].getAttribute("style").includes("#e8f5ea"));
  rows()[3].querySelector("button[title='Drop']").click();
  assert.equal(sv.scopeNotes.accepted[items[3].key], false);
  assert.ok(rows()[3].getAttribute("style").includes("line-through"));
  assert.match(text(), /4 notes · 1 accepted(?! · 1 to verify)/);   // a dropped verify item is no longer open
  assert.ok(saves >= 2);
});

test("Accept all in this room keeps the rest (never a dropped one), and Not in estimate lists the accepted instruction the draft lacks", () => {
  [...root.querySelectorAll("button")].find((b) => b.textContent === "✓ Accept all in this room").click();
  const items = noteItems(sv.scopeNotes);
  assert.equal(sv.scopeNotes.accepted[items[3].key], false, "the dropped verify item stays dropped");
  assert.equal(items.filter((it) => sv.scopeNotes.accepted[it.key] === true).length, 3);
  assert.match(text(), /Not in estimate \(1\)/);
  assert.match(text(), /new hood vent to the outside \[walk Kitchen 2:40\]/);
  assert.doesNotMatch(text(), /Not in estimate.*Take it to four feet/s);   // the sink-wall line covers that instruction
});

test("Use as typed scope appends the accepted lines under the room heading, marks them used, and the draft block excludes them", () => {
  [...root.querySelectorAll("button")].find((b) => b.textContent === "➜ Use as typed scope").click();
  assert.equal(sv.typedScope,
    "## Kitchen\n- base run swollen at the toe kick [walk Kitchen 0:12]\n- Take it to four feet on the sink wall. [walk Kitchen 2:14]\n- new hood vent to the outside [walk Kitchen 2:40]");
  assert.equal(typed, 1);
  assert.equal(Object.keys(sv.scopeNotes.used).length, 3);
  assert.match(text(), /in typed scope/);
  [...root.querySelectorAll("button")].find((b) => b.textContent === "➜ Use as typed scope").click();   // nothing left to carry
  assert.equal(sv.typedScope.split("## Kitchen").length, 2);
});

console.log(`\n${pass} passed`);
