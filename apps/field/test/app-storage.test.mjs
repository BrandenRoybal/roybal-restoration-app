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

const { Store, hasUnsaved, autosave, flushPending } = await import("../js/core.js");
await import("../js/app.js");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/* poll, not a fixed wait: a page renders after its store reads come back */
async function until(ok, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("timed out waiting for: " + ok); await settle(20); }
}
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
  await until(() => [...view().querySelectorAll("button")].some((b) => /Type one in/.test(b.textContent)));   // Try again opens the receipts page
  assert.equal(banner(), null, "the banner goes once the store answers again");
});

await test("the backups card shows only when this phone holds backups, and reads a copy only when its Restore is tapped", async () => {
  const reads = { backups: 0, snapshotEntry: 0, olderBackups: 0 };
  const real = {};
  for (const k of Object.keys(reads)) {
    real[k] = Store[k];
    Store[k] = (...a) => { reads[k]++; return real[k].apply(Store, a); };
  }
  await nav("#/");
  await nav("#/p/jobA");
  await until(() => /Cloud copy of this job/.test(text()));
  await settle(80);                                 // the card's own store read
  assert.doesNotMatch(text(), /⏪ Backups on this device/, "no backups, no card");
  await Store.backup({ ...job, receipts: [{ id: "old" }] });
  await nav("#/");
  await nav("#/p/jobA");
  await until(() => /⏪ Backups on this device/.test(text()));
  const head = [...view().querySelectorAll("div")].find((d) => d.firstChild && d.firstChild.textContent === "⏪ Backups on this device");
  assert.match(head.textContent, /1 snapshot\b/);
  head.click();
  await settle(80);
  assert.deepEqual(reads, { backups: 0, snapshotEntry: 0, olderBackups: 0 }, "opening the job and unfolding the card load no copy");
  const restore = [...view().querySelectorAll("button")].find((b) => /⏪ Restore/.test(b.textContent));
  assert.ok(restore);
  let asked = 0;
  globalThis.confirm = window.confirm = () => { asked++; return false; };   // read it, then back out: no restore, no reload
  restore.click();
  await until(() => asked === 1);
  globalThis.confirm = window.confirm = () => true;
  assert.deepEqual(reads, { backups: 0, snapshotEntry: 1, olderBackups: 0 }, "Restore reads that one copy");
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
  await until(() => /Not saved/.test(view().querySelector(".saved-pill").textContent));
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
  await until(() => location.hash === "#/" && /Alston/.test(text()));   // the job list
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
// a tap whose toast is waited for: the last test's toast is still up
const tap = (btn) => { document.getElementById("toast").textContent = ""; btn.click(); };
const restoreButtons = () => [...view().querySelectorAll("button")].filter((b) => /⏪ Restore/.test(b.textContent));

await test("Restore waits for an edit to the job that hasn't saved yet: it doesn't merge into the older saved copy or reload over the edit", async () => {
  await Store.put({ ...(await Store.get("jobA")), receipts: [{ id: "R3", vendor: "", amount: "", items: [] }] });
  await nav("#/p/jobA/f/receipts/R3");
  const writesBack = jobWritesDown();
  const vendor = view().querySelector('input[placeholder^="Home Depot"]');
  vendor.value = "Fairbanks Lumber"; vendor.dispatchEvent(new window.Event("input", { bubbles: true }));
  await until(() => /Not saved/.test(view().querySelector(".saved-pill").textContent));
  await nav("#/p/jobA");                            // the job page, from the queued copy
  await until(() => restoreButtons().length > 0);
  const before = (await Store.get("jobA")).updatedAt;
  const btn = restoreButtons()[0];
  tap(btn);
  await until(() => /still saving on this phone/.test(toastText()));
  assert.doesNotMatch(toastText(), /close|reopen/i);
  await settle(800);                                // past any reload a restore could schedule
  assert.equal(reloads.length, 0, "no reload over the queued edit");
  assert.equal((await Store.get("jobA")).updatedAt, before, "the restore wrote nothing under the edit");
  assert.equal(btn.disabled, false);
  writesBack();
  await nav("#/p/jobA/f/receipts");                 // the next page change saves it
  assert.equal((await Store.get("jobA")).receipts.find((r) => r.id === "R3").vendor, "Fairbanks Lumber");
});

await test("an edit queued while Restore runs, on another copy of the job, stops the restore before it saves", async () => {
  await nav("#/p/jobA");
  await until(() => restoreButtons().length > 0);
  const before = (await Store.get("jobA")).updatedAt;
  const backup = Store.backup;
  // a write that fails mid-restore leaves its own copy of the job in the save queue
  Store.backup = async (p, o) => { if (p && p.id === "jobA") autosave({ ...p, notes: "typed" }, null); return backup.call(Store, p, o); };
  const writesBack = jobWritesDown();
  const btn = restoreButtons()[0];
  tap(btn);
  await until(() => /still saving on this phone/.test(toastText()));
  assert.doesNotMatch(toastText(), /close|reopen/i);
  Store.backup = backup;
  await settle(800);
  assert.equal(reloads.length, 0);
  assert.equal((await Store.get("jobA")).updatedAt, before, "nothing put under the queued copy");
  assert.equal(btn.disabled, false);
  writesBack();
  await flushPending();
  assert.equal((await Store.get("jobA")).notes, "typed", "the queued edit lands as it was");
});

await test("a Restore that can't save keeps the restore in the save queue, says so, and keeps the backup it was restoring", async () => {
  const jobB = { id: "jobB", jobType: "restoration", customer: "Chena", address: "1885 Chena Landings", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(jobB, { bump: false, quiet: true });
  await Store.backup({ ...jobB, receipts: [{ id: "lost", vendor: "Rental Zone" }] });   // the oldest holds what went missing
  for (let i = 1; i < 10; i++) await Store.backup({ ...jobB, notes: "v" + i });
  const source = (await Store.snapshots("jobB")).at(-1).key;
  await nav("#/");
  await nav("#/p/jobB");
  await until(() => restoreButtons().length === 10);
  const btns = restoreButtons();
  const writesBack = jobWritesDown();
  const warn = console.warn; console.warn = () => {};
  tap(btns.at(-1));                              // the oldest: the backup of the current copy pushes it past 10
  await until(() => /couldn't save it yet/.test(toastText()));
  console.warn = warn;
  assert.match(toastText(), /Recovered 1 item from the backup, but/);
  assert.doesNotMatch(toastText(), /close|reopen/i, "never sends the crew past the save queue");
  assert.ok(hasUnsaved(), "the restore waits in the save queue");
  await settle(800);
  assert.equal(reloads.length, 0);
  assert.ok((await Store.snapshots("jobB")).some((s) => s.key === source), "the backup being restored was not pruned");
  assert.equal((await Store.snapshot(source)).receipts[0].vendor, "Rental Zone");
  assert.deepEqual((await Store.get("jobB")).receipts, [], "nothing reached the disk yet");
  writesBack();
  await flushPending();                             // the queue lands it once the phone saves again
  assert.deepEqual((await Store.get("jobB")).receipts.map((r) => r.vendor), ["Rental Zone"]);
  assert.ok(!hasUnsaved());
});

await test("a Restore that can't even read the job leaves everything as it was and says to try again", async () => {
  await nav("#/p/jobB");
  await until(() => restoreButtons().length > 0);
  const get = Store.get;
  Store.get = async () => { throw Object.assign(new Error("storage stopped"), { code: "storage-lost" }); };
  const before = (await get.call(Store, "jobB")).updatedAt;
  const btn = restoreButtons()[0];
  tap(btn);
  await until(() => /couldn't run the restore/.test(toastText()));
  assert.doesNotMatch(toastText(), /close|reopen/i);
  Store.get = get;
  assert.equal(btn.disabled, false);
  assert.ok(!hasUnsaved());
  assert.equal((await Store.get("jobB")).updatedAt, before);
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
  await until(() => /Not saved/.test(view().querySelector(".saved-pill").textContent));
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
