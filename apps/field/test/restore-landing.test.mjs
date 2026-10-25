/* The backups card's Restore while something else writes the job
   (apps/field/js/app.js backupRow, jsdom). A receipt read lands on the job
   page's own copy and saves it straight to the store, never through the save
   queue. Restore used to merge into a copy it had read from the store, save
   that, then reload: a read landing before its save was written over, and one
   landing after it wrote the pre-restore copy back. Restore now merges into
   the page's copy in one tick and saves that, and re-renders instead of
   reloading, so neither the read nor the restore is lost, and an edit stuck
   on another job never leaves the old copy on screen.
   Run: node apps/field/test/restore-landing.test.mjs   (from repo root) */
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
vc.on("jsdomError", (e) => { if (/navigation/i.test(String(e && e.message))) reloads.push(e.message); });
const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: {
  controller: {}, addEventListener: () => {}, register: () => Promise.resolve({ update: () => {} }) } });
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.Image = class { set src(_v) { setTimeout(() => this.onerror && this.onerror(), 0); } };
// signed in, so ✨ Read receipt is offered; the network is this test's fetch
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "crew@example.com" }));
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.confirm = () => true;
globalThis.confirm = window.confirm;
window.scrollTo = () => {};
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";
// each receipt read waits here until the test answers it
const asks = [];
globalThis.fetch = window.fetch = (url, opts = {}) => {
  let body = {};
  try { body = JSON.parse(opts.body || "{}"); } catch {}
  if (/roybal-ai-office/.test(String(url)) && body.action === "receiptRead")
    return new Promise((resolve) => asks.push((receipt) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, receipt }) })));
  return Promise.reject(new TypeError("offline in this test"));
};
const quiet = { error: console.error, warn: console.warn };
console.error = () => {}; console.warn = () => {};   // sync and the media queue find no network

// the Restore's backup opening its transaction: the moment a read lands inside the restore
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
let onBackupTx = null;
P.transaction = function (names, mode, ...rest) {
  if (mode === "readwrite" && [].concat(names).join() === "backups" && onBackupTx) { const f = onBackupTx; onBackupTx = null; f(); }
  return origTx.call(this, names, mode, ...rest);
};

const { Store, onProjectSaved, autosave, unsavedProject, flushPending } = await import("../js/core.js");
await import("../js/app.js");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(ok, ms = 4000) {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("timed out waiting for: " + ok); await settle(20); }
}
const view = () => document.getElementById("view");
const buttons = (re) => [...view().querySelectorAll("button")].filter((b) => re.test(b.textContent));
const toastText = () => document.getElementById("toast").textContent;
const tap = (btn) => { document.getElementById("toast").textContent = ""; btn.click(); };
async function nav(hash) { location.hash = hash; window.dispatchEvent(new window.Event("hashchange")); await settle(120); }

let pass = 0;
const test = async (name, fn) => { await fn(); quiet.error.call(console, "  ✓ " + name); pass++; };
quiet.error.call(console, "Restore while a receipt read or another job's save is in flight (DOM)");

const photo = "data:image/jpeg;base64," + Buffer.from("receipt photo").toString("base64");
const spenard = { vendor: "Spenard Builders Supply", date: "2026-10-12", total: 155.26, receiptNo: "700687087", confidence: 0.9 };
/* a job with an unread receipt R1, and a backup holding a receipt it has since lost */
async function jobWithLostReceipt(id) {
  const job = { id, jobType: "restoration", customer: "Alston " + id, address: "2156 Alston Rd", updatedAt: "2026-10-20T00:00:00.000Z",
    receipts: [{ id: "R1", photo, extraPages: [], vendor: "", amount: "", items: [] }] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, receipts: [...job.receipts, { id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
}
/* tap Read on R1, then go back to the job page while the read is out */
async function readOutThenJobPage(id) {
  await nav(`#/p/${id}/f/receipts/R1`);
  await until(() => buttons(/Read receipt/).length > 0);
  const before = asks.length;
  buttons(/Read receipt/)[0].click();
  await until(() => asks.length === before + 1);
  await nav(`#/p/${id}`);
  await until(() => buttons(/⏪ Restore/).length > 0);
  return asks[before];
}
const stored = async (id) => (await Store.get(id)).receipts.map((r) => `${r.id}:${r.vendor || "-"}`).sort();

await test("a read that lands while Restore is saving its backup is merged in: the job keeps the read and the restored receipt", async () => {
  await jobWithLostReceipt("jobA");
  const answer = await readOutThenJobPage("jobA");
  onBackupTx = () => answer(spenard);
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => /Recovered 1 item from the backup\./.test(toastText()));
  await settle(300);
  assert.equal(onBackupTx, null, "the read answered inside the restore");
  assert.deepEqual(await stored("jobA"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
  await settle(800);
  assert.equal(reloads.length, 0, "no reload");
  assert.deepEqual(await stored("jobA"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("a read that lands right after Restore saved adds to the restored copy instead of writing the old one back", async () => {
  await jobWithLostReceipt("jobB");
  const answer = await readOutThenJobPage("jobB");
  let fired = false;
  onProjectSaved((p) => {
    if (fired || p.id !== "jobB" || !(p.receipts || []).some((r) => r.id === "lost")) return;
    fired = true;
    answer(spenard);                                 // the restore's own save just committed
  });
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => fired);
  await until(() => /Read Spenard/.test(toastText()));
  await settle(800);
  assert.equal(reloads.length, 0, "no reload");
  assert.deepEqual(await stored("jobB"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("with another job's edit stuck, a Restore asks nothing more, shows the restored job, and the page's own buttons keep it", async () => {
  await jobWithLostReceipt("jobC");
  const jobQ = { id: "jobQ", jobType: "restoration", customer: "Chena", address: "1 Q St", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(jobQ, { bump: false, quiet: true });
  // jobQ's edit can't save (a full disk on a big job while small writes still fit)
  const OS = globalThis.IDBObjectStore.prototype, put = OS.put;
  OS.put = function (v, ...rest) {
    if (this.name === "projects" && v && v.id === "jobQ") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return put.call(this, v, ...rest);
  };
  const q = await Store.get("jobQ");
  q.customer = "typed on Q";
  autosave(q, null);
  await settle(450);
  assert.ok(unsavedProject("jobQ"), "jobQ's edit is stuck in the save queue");
  await nav("#/p/jobC");
  await until(() => buttons(/⏪ Restore/).length > 0);
  const asked = [];
  globalThis.confirm = window.confirm = (m) => { asked.push(m); return true; };
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => /Recovered 1 item from the backup\./.test(toastText()));
  await settle(800);
  assert.equal(asked.length, 1, "only the restore's own question: " + asked.map((m) => m.slice(0, 40)).join(" / "));
  assert.equal(reloads.length, 0);
  assert.deepEqual(await stored("jobC"), ["R1:-", "lost:Rental Zone"]);
  // the crew stays on the job page and taps a button that saves the job directly
  await until(() => buttons(/Archive/).length > 0);
  buttons(/Archive/)[0].click();
  await settle(300);
  const after = await Store.get("jobC");
  assert.ok(after.archivedAt, "archived");
  assert.deepEqual(after.receipts.map((r) => r.id).sort(), ["R1", "lost"], "the page's copy is the restored one");
  OS.put = put;
  await flushPending();
  assert.equal((await Store.get("jobQ")).customer, "typed on Q");
  globalThis.confirm = window.confirm = () => true;
});

quiet.error.call(console, `\n${pass} passed`);
process.exit(0);
