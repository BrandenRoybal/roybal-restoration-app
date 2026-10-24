/* The 🧾 Receipts tile's pages on a phone (apps/field/js/receipts.js, jsdom):
   the return badges arrive from receiptlib.js loaded on demand (it is not in
   the app's startup graph), a category holding only a return still gets its
   totals row, the 🗑 on a receipt takes its own returns with it but stops
   at a return the office logged across two receipts, and a return slip
   snapped as a receipt is logged as a return right on the phone.
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

/* ---------- a return slip snapped on the phone ---------- */
const chena = () => ({
  id: "p2", address: "1885 Chena Landings Lp", updatedAt: "2026-10-07T00:00:00.000Z", receipts: [
    { id: "BUY", vendor: "Spenard Builders Supply", date: "2026-10-07", amount: "1146.75", category: "materials", receiptNo: "700665392",
      items: [{ id: "ri-7", qty: "15", sku: "ISD24SM", desc: '2" 4x8 Styrofoam SE 25PSI', unit: "ea", price: "76.45" }] },
    { id: "SLIP", vendor: "Spenard Builders Supply", date: "2026-10-07", amount: "", category: "materials", receiptNo: "7066665392",
      photo: "media:22eb:975427", ai: { at: "2026-10-07T22:38:42.538Z", confidence: 0.6 },
      items: [{ id: "ri-j", qty: "15", sku: "JSD24SM", desc: '2" x 4 x 8 Styrofoam 25 PSI', unit: "ea", price: "-76.45" }] },
  ] });
const btn = (re) => [...view.querySelectorAll("button")].find((b) => re.test(b.textContent));

await test("the list calls a slip a return slip, not a receipt that needs a total", async () => {
  const p = chena();
  await receiptsPage(p, null, ctx);
  await settle();
  const row = [...view.querySelectorAll(".citem")].find((r) => /7066665392/.test(r.textContent));
  assert.match(row.textContent, /↩ Return slip: tap to log it/);
  assert.doesNotMatch(row.textContent, /Needs vendor \/ total/);
});

await test("a slip logs as a return of its invoice: picked, prefilled, the slip folds in, the total drops", async () => {
  const p = chena();
  await Store.put(p, { bump: false, quiet: true });
  await receiptsPage(p, "SLIP", ctx);
  await settle();
  assert.match(view.textContent, /↩ This is a return slip/);
  btn(/Log as a return/).click();
  await settle();
  assert.match(view.querySelector("h1").textContent, /Log a return/);
  const which = view.querySelector("select");
  assert.equal(which.value, "BUY", "the invoice the slip returns is picked");
  const qty = view.querySelector('input[aria-label^="Quantity returned"]');
  assert.equal(qty.value, "15");
  assert.equal(view.querySelector('input[aria-label="Refund on the slip"]').value, "1146.75");
  btn(/Save return/).click();
  await settle(80);
  const saved = await Store.get("p2");
  const credit = saved.receipts.find((r) => r.kind === "return");
  assert.ok(credit, "a return");
  assert.equal(credit.id, "SLIP~ret", "the slip's derived id: every device writes the same one");
  assert.equal(credit.amount, "-1146.75");
  assert.equal(credit.returnOf, "BUY");
  assert.equal(credit.photo, "media:22eb:975427");
  assert.deepEqual(credit.items.map((it) => [it.of, it.ofReceipt, it.qty, it.price]), [["ri-7", "BUY", "15", "-76.45"]]);
  assert.ok(!saved.receipts.some((r) => r.id === "SLIP"), "the slip is off the list");
  assert.ok(saved.deletedIds.SLIP, "and tombstoned");
  assert.match(toastText(), /Return logged: [−-]\$1,146\.75 off this job/);
  await receiptsPage(saved, null, ctx);
  await settle();
  assert.match(view.querySelector(".card").textContent, /Job costs to date\s*\$0\.00/);
});

await test("a refund past what is left stops with the reason, unless it is store credit", async () => {
  const p = chena();
  await Store.put(p, { bump: false, quiet: true });
  await receiptsPage(p, "SLIP", ctx);
  await settle();
  btn(/Log as a return/).click();
  await settle();
  const refund = view.querySelector('input[aria-label="Refund on the slip"]');
  refund.value = "1500"; refund.dispatchEvent(new window.Event("input"));
  btn(/Save return/).click();
  await settle(80);
  assert.match(view.querySelector(".warn").textContent, /more than what's left/);
  assert.ok((await Store.get("p2")).receipts.some((r) => r.id === "SLIP"), "nothing saved");
  view.querySelector("#ret-over").checked = true;
  btn(/Save return/).click();
  await settle(80);
  assert.equal((await Store.get("p2")).receipts.find((r) => r.kind === "return").amount, "-1500.00");
});

await test("a slip another device already turned into a return: says so, adds nothing", async () => {
  const p = chena();
  await Store.put(p, { bump: false, quiet: true });
  await receiptsPage(p, "SLIP", ctx);
  await settle();
  btn(/Log as a return/).click();
  await settle();
  // the other device's return arrives (sync grafts it into the open job)
  p.receipts.push({ id: "SLIP~ret", kind: "return", returnOf: "BUY", vendor: "Spenard Builders Supply", amount: "-1146.75", category: "materials",
    items: [{ id: "SLIP~ret-1", of: "ri-7", ofReceipt: "BUY", desc: "Styrofoam", qty: "15", price: "-76.45" }] });
  p.receipts = p.receipts.filter((r) => r.id !== "SLIP");
  p.deletedIds = { SLIP: "2026-10-07T23:10:00.000Z" };
  btn(/Save return/).click();
  await settle(80);
  assert.match(toastText(), /already logged as a return/);
  assert.equal(p.receipts.filter((r) => r.kind === "return").length, 1);
});

await test("no receipt on the job to return against: says so, saves nothing", async () => {
  const p = chena();
  p.receipts = p.receipts.filter((r) => r.id === "SLIP");
  await receiptsPage(p, "SLIP", ctx);
  await settle();
  btn(/Log as a return/).click();
  await settle();
  assert.match(view.textContent, /no receipt on this job to log it against/);
});

await test("a $0 receipt the AI didn't flag still offers it; a purchase never does", async () => {
  const p = chena();
  p.receipts.push({ id: "BLANK", vendor: "Spenard Builders Supply", date: "2026-10-07", amount: "", items: [] });
  await receiptsPage(p, "BLANK", ctx);
  await settle();
  assert.ok(btn(/Log it as a return/), "the small offer");
  assert.doesNotMatch(view.textContent, /This is a return slip/);
  await receiptsPage(p, "BUY", ctx);
  await settle();
  assert.ok(!btn(/Log (it )?as a return/), "not on a purchase");
});

console.log(`\n${pass} passed`);
process.exit(0);
