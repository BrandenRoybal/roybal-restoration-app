/* The app shell when the phone's storage drops out (apps/field/js/app.js,
   jsdom). A route that couldn't read the store used to throw with no
   catch: the URL moved, the old page stayed, ‹ did nothing and the app
   looked frozen. Now it shows what happened with Try again / Reload, a
   red banner says nothing new is being kept until the store answers
   again, and the job page no longer reads every full backup copy of the
   job just to count them.
   Run: node apps/field/test/app-storage.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import "fake-indexeddb/auto";

const SHELL = `<!DOCTYPE html><html><body>
  <header id="topbar"><button id="backBtn" hidden></button>
    <div><span id="topbarSub"></span></div><div id="netStatus">●</div></header>
  <main id="view"></main><div id="toast" hidden></div></body></html>`;
// jsdom can't navigate: a location.reload() shows up as its "not implemented" error
const reloads = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { if (/navigation/i.test(String(e && e.message))) reloads.push(e.message); else console.error(e); });
vc.sendTo(console, { omitJSDOMErrors: true });
const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
// an installed copy: a service worker is in control, and a deploy hands over to a new one
const swListeners = {};
Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: {
  controller: {}, addEventListener: (t, fn) => { (swListeners[t] ||= []).push(fn); },
  register: () => Promise.resolve({ update: () => {} }) } });
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

const { Store, hasUnsaved } = await import("../js/core.js");
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

await test("the backups card shows only when this phone holds backups, and reads a copy only when its Restore is tapped", async () => {
  const reads = { backups: 0, snapshot: 0, olderBackups: 0 };
  const real = {};
  for (const k of Object.keys(reads)) {
    real[k] = Store[k];
    Store[k] = (...a) => { reads[k]++; return real[k].apply(Store, a); };
  }
  await nav("#/");
  await nav("#/p/jobA");
  await settle(80);
  assert.doesNotMatch(text(), /⏪ Backups on this device/, "no backups, no card");
  await Store.backup({ ...job, receipts: [{ id: "old" }] });
  await nav("#/");
  await nav("#/p/jobA");
  await settle(80);
  assert.match(text(), /⏪ Backups on this device/);
  const head = [...view().querySelectorAll("div")].find((d) => d.firstChild && d.firstChild.textContent === "⏪ Backups on this device");
  assert.match(head.textContent, /1 snapshot\b/);
  head.click();
  await settle(80);
  assert.deepEqual(reads, { backups: 0, snapshot: 0, olderBackups: 0 }, "opening the job and unfolding the card load no copy");
  const restore = [...view().querySelectorAll("button")].find((b) => /⏪ Restore/.test(b.textContent));
  assert.ok(restore);
  globalThis.confirm = window.confirm = () => false;   // read it, then back out: no restore, no reload
  restore.click();
  await settle(80);
  globalThis.confirm = window.confirm = () => true;
  assert.deepEqual(reads, { backups: 0, snapshot: 1, olderBackups: 0 }, "Restore reads that one copy");
  assert.equal(restore.disabled, false);
  for (const k of Object.keys(reads)) Store[k] = real[k];
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

const jobWritesDown = () => {
  const tx = P.transaction;
  P.transaction = function (names, mode, ...rest) {
    if (mode === "readwrite" && [].concat(names).includes("projects")) throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
    return tx.call(this, names, mode, ...rest);
  };
  return () => { P.transaction = tx; };
};
const toastText = () => document.getElementById("toast").textContent;
const restoreButtons = () => [...view().querySelectorAll("button")].filter((b) => /⏪ Restore/.test(b.textContent));

await test("Restore waits for an edit to the job that hasn't saved yet: it doesn't merge into the older saved copy or reload over the edit", async () => {
  await Store.put({ ...(await Store.get("jobA")), receipts: [{ id: "R3", vendor: "", amount: "", items: [] }] });
  await nav("#/p/jobA/f/receipts/R3");
  const writesBack = jobWritesDown();
  const vendor = view().querySelector('input[placeholder^="Home Depot"]');
  vendor.value = "Fairbanks Lumber"; vendor.dispatchEvent(new window.Event("input", { bubbles: true }));
  await settle(450);
  assert.match(view().querySelector(".saved-pill").textContent, /Not saved/);
  await nav("#/p/jobA");                            // the job page, from the queued copy
  const before = (await Store.get("jobA")).updatedAt;
  restoreButtons()[0].click();
  await settle(150);
  assert.match(toastText(), /hasn't saved on this phone yet/);
  assert.equal(reloads.length, 0, "no reload over the queued edit");
  assert.equal((await Store.get("jobA")).updatedAt, before, "the restore wrote nothing under the edit");
  assert.equal(restoreButtons()[0].disabled, false);
  writesBack();
  await nav("#/p/jobA/f/receipts");                 // the next page change saves it
  assert.equal((await Store.get("jobA")).receipts.find((r) => r.id === "R3").vendor, "Fairbanks Lumber");
});

await test("a Restore that can't save says so, and the backup it was restoring is still on the phone", async () => {
  const jobB = { id: "jobB", jobType: "restoration", customer: "Chena", address: "1885 Chena Landings", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(jobB, { bump: false, quiet: true });
  await Store.backup({ ...jobB, receipts: [{ id: "lost", vendor: "Rental Zone" }] });   // the oldest holds what went missing
  for (let i = 1; i < 10; i++) await Store.backup({ ...jobB, notes: "v" + i });
  const source = (await Store.snapshots("jobB")).at(-1).key;
  await nav("#/");
  await nav("#/p/jobB");
  const btns = restoreButtons();
  assert.equal(btns.length, 10);
  const writesBack = jobWritesDown();
  const warn = console.warn; console.warn = () => {};
  btns.at(-1).click();                              // the oldest: the backup of the current copy pushes it past 10
  await settle(150);
  console.warn = warn;
  writesBack();
  assert.match(toastText(), /restore didn't save/);
  assert.equal(btns.at(-1).disabled, false, "the button comes back");
  assert.equal(reloads.length, 0);
  assert.ok((await Store.snapshots("jobB")).some((s) => s.key === source), "the backup being restored was not pruned");
  assert.equal((await Store.snapshot(source)).receipts[0].vendor, "Rental Zone");
});

// last: once the reload has "happened", this page stays reloading
await test("a new version arriving while an edit can't save waits for it to land: no reload over the crew's typing", async () => {
  await Store.put({ ...(await Store.get("jobA")), receipts: [{ id: "R2", vendor: "", amount: "", items: [] }] });
  await nav("#/p/jobA/f/receipts/R2");
  let writesDown = true;
  const tx = P.transaction;
  P.transaction = function (names, mode, ...rest) {
    if (writesDown && mode === "readwrite") throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
    return tx.call(this, names, mode, ...rest);
  };
  const vendor = view().querySelector('input[placeholder^="Home Depot"]');
  vendor.value = "Spenard"; vendor.dispatchEvent(new window.Event("input", { bubbles: true }));
  await settle(450);
  assert.match(view().querySelector(".saved-pill").textContent, /Not saved/);
  for (const fn of swListeners.controllerchange || []) fn();     // the deploy activates
  await settle(120);
  assert.equal(reloads.length, 0, "no reload while the edit waits to save (it used to reload, and the edit was gone)");
  assert.ok(hasUnsaved());
  await nav("#/p/jobA/f/receipts");                 // a page change while it still can't save
  assert.equal(reloads.length, 0);
  writesDown = false;
  P.transaction = tx;
  await nav("#/p/jobA");                            // the next page change saves it; then the update applies
  await settle(120);
  assert.equal((await Store.get("jobA")).receipts[0].vendor, "Spenard");
  assert.equal(reloads.length, 1, "the update applies once nothing is waiting to save");
});

console.log(`\n${pass} passed`);
process.exit(0);
