/* The backups card's Restore while sync pulls an office edit to the same job
   (apps/field/js/app.js backupRow, sync.js pull, the app's onSyncRowChanged
   graft; jsdom). Restore unions its read of the stored copy into the page's
   copy, for a write that went around that copy, in the tick the read arrives
   and before its backup. When sync clean-applies the office's row and grafts
   it into the page's copy while the backup saves, the graft lands on top.
   A union done after the backup judged the grafted copy against the older
   read: it filled what the office cleared and added the old room name back,
   and the restore pushed it. On an iPhone the pull lands there when WebKit
   runs its save between Restore's read and its backup; here the harness
   holds back the backup's "complete" until the pull has landed and been
   grafted.
   Run: node apps/field/test/restore-sync.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import "fake-indexeddb/auto";

const SHELL = `<!DOCTYPE html><html><body>
  <header id="topbar"><button id="backBtn" hidden></button>
    <div><span id="topbarSub"></span></div><div id="netStatus">●</div></header>
  <main id="view"></main><div id="toast" hidden></div></body></html>`;
const vc = new VirtualConsole();
vc.on("jsdomError", () => {});
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
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.confirm = () => true;
globalThis.confirm = window.confirm;
window.scrollTo = () => {};
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";

/* the job as this phone last pushed it (clean), the office's later copy, an older backup */
const S0 = "2026-10-24T10:00:00.000Z";
const local = { id: "jobO", jobType: "restoration", customer: "Ostrander", address: "12 Ostrander Way",
  claimNo: "WRONG-123", rooms: ["Kitchen", "Bedrom"], receipts: [], updatedAt: S0 };
// the office clears the claim number typed on the wrong job and fixes the room's spelling
const office = { ...local, claimNo: "", rooms: ["Kitchen", "Bedroom"], updatedAt: "2026-10-24T12:00:00.000Z", rev: 4 };
// a backup from before either was typed, holding a receipt the job has since lost
const backup = { id: "jobO", jobType: "restoration", customer: "Ostrander", address: "12 Ostrander Way",
  rooms: ["Kitchen"], receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }],
  updatedAt: "2026-10-20T00:00:00.000Z" };

// signed in; sync's bookkeeping says jobO is clean at S0
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "crew@example.com" }));
window.localStorage.setItem("roybal-sync-pushed", JSON.stringify({ jobO: S0 }));
window.localStorage.setItem("roybal-sync-revs", JSON.stringify({ jobO: 3 }));
window.localStorage.setItem("roybal-sync-rebased-v211", "1");
window.localStorage.setItem("roybal-sync-cursor", S0);

// the server: offline until the office's row is published, then one pull gets it
let officeRow = null;
globalThis.fetch = window.fetch = (url) => {
  if (officeRow && /\/rest\/v1\/field_projects\?select=id,data,deleted,updated_at&order=updated_at\.asc/.test(String(url))) {
    const rows = [officeRow];
    officeRow = null;
    return Promise.resolve({ ok: true, status: 200, json: async () => rows, text: async () => "" });
  }
  return Promise.reject(new TypeError("offline in this test"));
};
const quiet = { error: console.error, warn: console.warn };
console.error = () => {}; console.warn = () => {};

/* the next backup's transaction tells core.js it is complete only once `gate` resolves */
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
let slowNextBackup = null;
P.transaction = function (names, mode, ...rest) {
  const t = origTx.call(this, names, mode, ...rest);
  if (mode === "readwrite" && [].concat(names).join() === "backups" && slowNextBackup) {
    const { gate, onStart } = slowNextBackup;
    slowNextBackup = null;
    let cb = null;
    Object.defineProperty(t, "oncomplete", { configurable: true,
      get: () => cb && ((ev) => { gate.then(() => cb.call(t, ev)); }),
      set: (f) => { cb = f; } });
    setTimeout(onStart, 0);
  }
  return t;
};

const { Store } = await import("../js/core.js");
await import("../js/app.js");
const { syncNow } = await import("../js/sync.js");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(ok, ms = 6000) {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("timed out waiting for: " + ok); await settle(20); }
}
const view = () => document.getElementById("view");
const buttons = (re) => [...view().querySelectorAll("button")].filter((b) => re.test(b.textContent));
const toasts = [];
new window.MutationObserver(() => { const t = document.getElementById("toast").textContent; if (t) toasts.push(t); })
  .observe(document.getElementById("toast"), { childList: true, characterData: true, subtree: true });
async function nav(hash) { location.hash = hash; window.dispatchEvent(new window.Event("hashchange")); await settle(120); }

quiet.error.call(console, "Restore while sync pulls an office edit to the job (DOM)");

await Store.put(local, { bump: false, quiet: true });
await Store.backup(backup);
await nav("#/p/jobO");
await until(() => buttons(/⏪ Restore/).length > 0);
await settle(300);

let grafted = 0;
document.addEventListener("roybal:grafted", (e) => { if (e.detail && e.detail.id === "jobO") grafted++; });
let release;
const gate = new Promise((r) => { release = r; });
slowNextBackup = {
  gate,
  // while Restore's backup saves, the office's edit arrives through an ordinary pull
  onStart: async () => {
    officeRow = { id: "jobO", data: office, deleted: false, updated_at: "2026-10-24T12:00:01.000Z" };
    for (let i = 0; i < 100 && !grafted; i++) { await syncNow({ force: true }).catch(() => {}); if (!grafted) await settle(30); }
    release();
  },
};
buttons(/⏪ Restore/)[0].click();
await until(() => toasts.some((t) => /Recovered 1 item from the backup/.test(t)));
await settle(400);
assert.ok(grafted > 0, "the pull landed and was grafted into the page's copy during the backup");

const after = await Store.get("jobO");
assert.deepEqual((after.receipts || []).map((r) => r.id), ["lost"], "the backup's receipt is recovered");
assert.equal(after.claimNo, "", "the claim number the office cleared stays cleared");
assert.deepEqual(after.rooms, ["Kitchen", "Bedroom"], "the room the office renamed is not brought back under its old name");
quiet.error.call(console, "  ✓ a Restore during a pull keeps what the office cleared and renamed, and recovers the backup's receipt");
process.exit(0);
