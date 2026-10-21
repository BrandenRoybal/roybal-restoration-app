/* The app shell when the phone's storage drops out (apps/field/js/app.js,
   jsdom). A route that couldn't read the store used to throw with no
   catch: the URL moved, the old page stayed, ‹ did nothing and the app
   looked frozen. Now it shows what happened with Try again / Reload, a
   red banner says nothing new is being kept until the store answers
   again, and the job page no longer reads every full backup copy of the
   job just to count them.
   Run: node apps/field/test/app-storage.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const SHELL = `<!DOCTYPE html><html><body>
  <header id="topbar"><button id="backBtn" hidden></button>
    <div><span id="topbarSub"></span></div><div id="netStatus">●</div></header>
  <main id="view"></main><div id="toast" hidden></div></body></html>`;
const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");   // local-only mode: no sign-in gate
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.confirm = () => true;
globalThis.confirm = window.confirm;
window.scrollTo = () => {};
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";

/* ---- the storage process dying (as in store-reconnect.test.mjs) ---- */
const dead = new WeakSet();
let lastDb = null, openFails = false;
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
P.transaction = function (...a) {
  lastDb = this;
  if (dead.has(this)) throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
  return origTx.apply(this, a);
};
const origOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (...a) => {
  if (openFails) {
    const req = { result: null, error: new DOMException("Connection to Indexed Database server lost. Refresh the page to try again", "UnknownError") };
    setTimeout(() => req.onerror && req.onerror(), 0);
    return req;
  }
  return origOpen(...a);
};

const { Store } = await import("../js/core.js");
await import("../js/app.js");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const view = () => document.getElementById("view");
const text = () => view().textContent;
const banner = () => document.querySelector('[role="alert"]');
async function nav(hash) {
  location.hash = hash;
  window.dispatchEvent(new window.Event("hashchange"));
  await settle(80);
}

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("App shell when the phone's storage drops out (DOM)");

const job = { id: "jobA", jobType: "restoration", customer: "Alston", address: "2156 Alston Rd", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
await Store.put(job, { bump: false, quiet: true });

await test("a route that can't read the phone's storage says so, with Try again, instead of leaving the old page up", async () => {
  await nav("#/p/jobA");
  assert.match(text(), /Alston/);
  dead.add(lastDb); openFails = true;
  await nav("#/p/jobA/f/receipts");
  assert.match(text(), /⚠ This phone stopped saving/);
  assert.doesNotMatch(text(), /Moisture Map/, "the job page is not left on screen");
  assert.ok(banner() && /stopped saving\. Nothing new is being kept/.test(banner().textContent), "the red banner is up");
  openFails = false;
  [...view().querySelectorAll("button")].find((b) => /Try again/.test(b.textContent)).click();
  await settle(120);
  assert.ok([...view().querySelectorAll("button")].some((b) => /Type one in/.test(b.textContent)), "Try again opens the receipts page");
  assert.equal(banner(), null, "the banner goes once the store answers again");
});

await test("the backups card shows only when this phone holds backups, and reads them only when unfolded", async () => {
  let reads = 0;
  const realBackups = Store.backups;
  Store.backups = (id) => { reads++; return realBackups.call(Store, id); };
  await nav("#/");
  await nav("#/p/jobA");
  await settle(80);
  assert.doesNotMatch(text(), /⏪ Backups on this device/, "no backups, no card");
  await Store.backup({ ...job, receipts: [{ id: "old" }] });
  await nav("#/");
  await nav("#/p/jobA");
  await settle(80);
  assert.match(text(), /⏪ Backups on this device/);
  assert.equal(reads, 0, "folded: the full copies are not read");
  const head = [...view().querySelectorAll("div")].find((d) => d.firstChild && d.firstChild.textContent === "⏪ Backups on this device");
  head.click();
  await settle(80);
  assert.equal(reads, 1);
  assert.match(head.textContent, /1 snapshot\b/);
  assert.ok([...view().querySelectorAll("button")].some((b) => /⏪ Restore/.test(b.textContent)));
  head.click(); head.click();
  await settle(40);
  assert.equal(reads, 1, "read once per page");
  Store.backups = realBackups;
});

await test("an edit whose save failed is what the page shows when the crew comes back to it, and it lands once the phone saves again", async () => {
  await Store.put({ ...(await Store.get("jobA")), receipts: [{ id: "R1", vendor: "", amount: "", items: [] }] });
  await nav("#/p/jobA/f/receipts/R1");
  let writesDown = true;
  const tx = P.transaction;
  P.transaction = function (names, mode, ...rest) {
    if (writesDown && mode === "readwrite") throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
    return tx.call(this, names, mode, ...rest);
  };
  const vendor = () => view().querySelector('input[placeholder^="Home Depot"]');
  vendor().value = "Spenard"; vendor().dispatchEvent(new window.Event("input", { bubbles: true }));
  await settle(450);
  assert.match(view().querySelector(".saved-pill").textContent, /Not saved/);
  await nav("#/p/jobA/f/receipts");                 // Done, while the phone still can't save
  await nav("#/p/jobA/f/receipts/R1");              // and back to the receipt
  assert.equal(vendor().value, "Spenard", "the unsaved edit, not the older stored receipt");
  writesDown = false;
  P.transaction = tx;
  await nav("#/p/jobA");                            // the next page change saves it
  assert.equal((await Store.get("jobA")).receipts[0].vendor, "Spenard");
  assert.equal(banner(), null);
});

await test("a page that fails for another reason keeps a way out: ‹ and Job list (Try again alone would loop)", async () => {
  const get = Store.get;
  // a row that breaks the page (any renderer bug does the same)
  Store.get = async (id) => { const p = await get.call(Store, id); return Object.defineProperty({ ...p }, "receipts", { get() { throw new Error("bad row"); }, enumerable: true }); };
  const errs = console.error; console.error = () => {};
  await nav("#/p/jobA/f/receipts");
  console.error = errs;
  Store.get = get;
  assert.match(text(), /⚠ This page couldn't open/);
  assert.match(text(), /go back to the job list/);
  assert.equal(document.getElementById("backBtn").hidden, false, "‹ shows");
  const out = [...view().querySelectorAll("button")].find((b) => /Job list/.test(b.textContent));
  assert.ok(out, "a Job list button");
  out.click();
  await settle(120);
  assert.equal(location.hash, "#/");
  assert.match(text(), /Alston/, "the job list");
});

console.log(`\n${pass} passed`);
process.exit(0);
