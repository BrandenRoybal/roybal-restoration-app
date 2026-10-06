/* The 🧾 Receipts tile's pages on a phone (apps/field/js/receipts.js, jsdom):
   the return badges arrive from receiptlib.js loaded on demand (it is not in
   the app's startup graph), a category holding only a return still gets its
   totals row, and the 🗑 on a receipt takes its own returns with it but stops
   at a return the office logged across two receipts.
   Run: node apps/field/test/receipts-page.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
let confirms = [];
window.confirm = (msg) => { confirms.push(msg); return true; };
globalThis.confirm = window.confirm;

const { Store } = await import("../js/core.js");
const { receiptsPage } = await import("../js/receipts.js");

const view = document.getElementById("view");
const ctx = { view, setChrome: () => {} };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const toastText = () => document.getElementById("toast").textContent;

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Receipts tile on a phone (DOM)");

const job = () => ({
  id: "p1", customer: "Pollen", address: "1192 Bemis Ct", updatedAt: "2026-10-01T00:00:00.000Z", receipts: [
    { id: "R1", vendor: "Home Depot", date: "2026-09-01", amount: "200.00", category: "materials",
      items: [{ id: "a", desc: "slab door", qty: "2", price: "100" }] },
    { id: "R2", vendor: "Home Depot", date: "2026-09-02", amount: "60.00", category: "materials",
      items: [{ id: "b", desc: "2x4x8 stud", qty: "10", price: "6" }] },
    { id: "C1", kind: "return", returnOf: "R2", vendor: "Home Depot", date: "2026-09-05", amount: "-12.00", category: "materials",
      items: [{ id: "C1-1", of: "b", ofReceipt: "R2", desc: "2x4x8 stud", qty: "2", price: "-6.00" }] },
  ] });

await test("the list shows the return badges once receiptlib.js loads on demand", async () => {
  const p = job();
  await receiptsPage(p, null, ctx);
  await settle();
  const rows = [...view.querySelectorAll(".citem")];
  assert.equal(rows.length, 3);
  const r2 = rows.find((r) => /Home Depot — \$60\.00/.test(r.textContent));
  assert.match(r2.textContent, /↩ Partly returned [−-]?\$12\.00/);
  assert.match(rows.find((r) => /[−-]\$12\.00/.test(r.querySelector(".jobrow__title").textContent)).textContent, /↩ Return/);
});

await test("a category holding only a return still gets its row, so 'included above' is true", async () => {
  const p = job();
  p.receipts = p.receipts.filter((r) => r.id === "C1");                 // its receipt deleted on an old phone
  await receiptsPage(p, null, ctx);
  await settle();
  const card = view.querySelector(".card");
  assert.match(card.textContent, /🪵 Materials\s*[−-]\$12\.00/);
  assert.match(card.textContent, /↩ Returns \(included above\)/);
});

await test("🗑 on a receipt takes its own return with it, and the ids a change in flight would use", async () => {
  const p = job();
  await Store.put(p, { bump: false, quiet: true });
  await receiptsPage(p, "R2", ctx);
  confirms = [];
  [...view.querySelectorAll("button")].find((b) => b.textContent === "🗑").click();
  await settle(80);
  assert.match(confirms[0], /Delete this receipt and the return logged against it/);
  const saved = await Store.get("p1");
  assert.deepEqual(saved.receipts.map((r) => r.id), ["R1"]);
  for (const id of ["R2", "C1", "C1~1", "C1~2", "C1~3"]) assert.ok(saved.deletedIds[id], id + " tombstoned");
});

await test("🗑 stops at a return the office logged across this receipt and another", async () => {
  const p = job();
  p.receipts.push({ id: "C2", kind: "return", returnOf: "R1", vendor: "Home Depot", date: "2026-09-06", amount: "-106.00", category: "materials",
    items: [{ id: "C2-1", of: "a", ofReceipt: "R1", desc: "slab door", qty: "1", price: "-100" },
      { id: "C2-2", of: "b", ofReceipt: "R2", desc: "2x4x8 stud", qty: "1", price: "-6" }] });
  await Store.put(p, { bump: false, quiet: true });
  await receiptsPage(p, "R2", ctx);
  confirms = [];
  [...view.querySelectorAll("button")].find((b) => b.textContent === "🗑").click();
  await settle(80);
  assert.equal(confirms.length, 0, "not even asked");
  assert.match(toastText(), /part of a return the office logged that also covers another receipt/);
  assert.equal((await Store.get("p1")).receipts.length, 4, "nothing deleted");
});

await test("a return opens read-only: no total to retype, no AI read, no 🗑", async () => {
  const p = job();
  await receiptsPage(p, "C1", ctx);
  assert.match(view.querySelector("h1").textContent, /↩ Return/);
  assert.equal(view.querySelectorAll("input").length, 0);
  const labels = [...view.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(!labels.some((t) => /Read receipt|Retake|🗑/.test(t)), labels.join(", "));
});

console.log(`\n${pass} passed`);
process.exit(0);
