/* The backups card's Restore while something else writes the job
   (apps/field/js/app.js backupRow, jsdom). A receipt read lands on the job
   page's own copy and saves it straight to the store, never through the save
   queue. Restore used to merge into a copy it had read from the store, save
   that, then reload: a read landing before its save was written over, and one
   landing after it wrote the pre-restore copy back. Restore now merges into
   the page's copy in one tick and saves that, and re-renders instead of
   reloading, so neither the read nor the restore is lost, and an edit stuck
   on another job never leaves the old copy on screen. The page's copy is the
   one the job home last rendered (an AI draft landing re-renders it), and a
   page of the job opened during the restore is redrawn from the restored copy.
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
// each receipt read waits here until the test answers it; so does an AI draft while holdDraft is set,
// and the board's answer to "site visit done" while holdBoard is
const asks = [];
let holdDraft = null, holdBoard = null;
const held = (hold, body) => hold ? new Promise((resolve) => hold.push(() => resolve(body()))) : Promise.resolve(body());
globalThis.fetch = window.fetch = (url, opts = {}) => {
  let body = {};
  try { body = JSON.parse(opts.body || "{}"); } catch {}
  if (/roybal-ai-office/.test(String(url)) && body.action === "receiptRead")
    return new Promise((resolve) => asks.push((receipt) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, receipt }) })));
  if (/roybal-ai-office/.test(String(url)) && body.action === "timelineDraft")
    return held(holdDraft, () => ({ ok: true, status: 200, json: async () => ({ ok: true, draft: {
      phases: [{ name: "Demo", estimatedHours: 8, lagDays: 0, confidence: 0.9 }, { name: "Drywall", estimatedHours: 16, lagDays: 1, confidence: 0.9 }],
      notBefore: "", assumptions: [] } }) }));
  if (/roybal-ai-office/.test(String(url)) && body.action === "rebuildDraft")
    return held(holdDraft, () => ({ ok: true, status: 200, json: async () => ({ ok: true, draft: {
      scopeAreas: [{ area: "Kitchen", items: [{ desc: "Hang and finish drywall", qty: 96, unit: "SF", trade: "Drywall", confidence: 0.9 }] }],
      tradeSequence: [{ trade: "Drywall", confidence: 0.9 }], selections: [] } }) }));
  if (/roybal-ai-office/.test(String(url)) && body.action === "progressNarrative")
    return held(holdDraft, () => ({ ok: true, status: 200, json: async () => ({ ok: true, draft: { narrative: "Week 2: drywall hung and taped." } }) }));
  if (holdBoard && /coordination_jobs\?select=id,data/.test(String(url)))
    return held(holdBoard, () => ({ ok: true, status: 200, json: async () => [] }));
  return Promise.reject(new TypeError("offline in this test"));
};
const quiet = { error: console.error, warn: console.warn };
console.error = () => {}; console.warn = () => {};   // sync and the media queue find no network

/* moments inside a restore where a read can land: its backup's transaction
   opening (onBackupTx) or committing (onBackupDone), and the restore's own
   save opening its transaction (onRestorePut, the first job write after a backup).
   failJobWrites: the next N job writes fail as a lost connection does */
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
let onBackupTx = null, onBackupDone = null, onRestorePut = null, sawBackup = false, failJobWrites = 0;
P.transaction = function (names, mode, ...rest) {
  const n = [].concat(names).join();
  if (mode === "readwrite" && n === "projects" && failJobWrites > 0) {
    failJobWrites--;
    throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
  }
  if (mode === "readwrite" && n === "projects" && sawBackup && onRestorePut) { const f = onRestorePut; onRestorePut = null; sawBackup = false; f(); }
  const t = origTx.call(this, names, mode, ...rest);
  if (mode === "readwrite" && n === "backups") {
    sawBackup = true;
    if (onBackupTx) { const f = onBackupTx; onBackupTx = null; f(); }
    if (onBackupDone) { const f = onBackupDone; onBackupDone = null; t.addEventListener("complete", () => f()); }
  }
  return t;
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
const input = (label) => [...view().querySelectorAll(".field")].find((f) => (f.querySelector("label") || {}).textContent === label).querySelector("input");
const type = (el, value) => { el.value = value; el.dispatchEvent(new window.Event("input")); };
const toastText = () => document.getElementById("toast").textContent;
// every toast since the last tap, so one replaced by the next still counts
const toasts = [];
new window.MutationObserver(() => { const t = toastText(); if (t) toasts.push(t); })
  .observe(document.getElementById("toast"), { childList: true, characterData: true, subtree: true });
const toasted = (re) => toasts.some((t) => re.test(t));
const tap = (btn) => { document.getElementById("toast").textContent = ""; toasts.length = 0; btn.click(); };
async function recovered() {
  await until(() => toasted(/Recovered 1 item from the backup\./));
  const mine = toasts.filter((t) => /backup|restore/i.test(t));
  assert.ok(!mine.some((t) => /close|reopen/i.test(t)), "never tells the crew to close the app: " + mine.join(" / "));
}
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
  await recovered();
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
  await until(() => toasted(/Read Spenard/));
  assert.ok(toasted(/Recovered 1 item from the backup\./));
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
  await recovered();
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

await test("a read that lands just after Restore's backup is written, before its merge, is merged in", async () => {
  await jobWithLostReceipt("jobS1");
  const answer = await readOutThenJobPage("jobS1");
  onBackupDone = () => answer(spenard);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(800);
  assert.equal(onBackupDone, null, "the read answered inside the restore");
  assert.deepEqual(await stored("jobS1"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("a read that lands while Restore's own save is being written adds to the restored copy", async () => {
  await jobWithLostReceipt("jobS2");
  const answer = await readOutThenJobPage("jobS2");
  sawBackup = false;
  onRestorePut = () => answer(spenard);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await until(() => toasted(/Read Spenard/));
  await settle(800);
  assert.equal(onRestorePut, null, "the read answered inside the restore");
  assert.deepEqual(await stored("jobS2"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("a read that lands in the same tick as Restore's merge is kept", async () => {
  await jobWithLostReceipt("jobS3");
  const answer = await readOutThenJobPage("jobS3");
  // the merge reading the backup's receipts is the moment the read answers
  const snap = Store.snapshot;
  Store.snapshot = async (k) => {
    const d = await snap.call(Store, k);
    if (!d || d.id !== "jobS3") return d;
    let fired = false; const rc = d.receipts;
    Object.defineProperty(d, "receipts", { enumerable: true, configurable: true, get() { if (!fired) { fired = true; answer(spenard); } return rc; } });
    return d;
  };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await recovered();
  } finally { Store.snapshot = snap; }
  await until(() => toasted(/Read Spenard/));
  await settle(800);
  assert.deepEqual(await stored("jobS3"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("a read whose save fails mid-restore leaves the page's own copy queued: the restore still goes ahead and saves it", async () => {
  await jobWithLostReceipt("jobS5");
  const answer = await readOutThenJobPage("jobS5");
  // the read lands on the page's copy while the restore backs up, and can't save (both tries)
  onBackupTx = () => { failJobWrites = 2; answer(spenard); };
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  assert.ok(!toasted(/still saving on this phone/), "the restore didn't wait on its own page's copy");
  await until(() => !unsavedProject("jobS5"));
  assert.equal(failJobWrites, 0, "the read's save failed");
  assert.deepEqual(await stored("jobS5"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
});

await test("the job page is redrawn from the restored copy", async () => {
  await jobWithLostReceipt("jobS4");
  await nav("#/p/jobS4");
  await until(() => buttons(/⏪ Restore/).length > 0);
  assert.match(view().textContent, /· 1 receipt(?!s)/);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await until(() => /· 2 receipts/.test(view().textContent));
  assert.equal(reloads.length, 0, "no reload");
});

await test("after an AI timeline draft redraws the job home, Restore keeps the draft and the crew's edit to it", async () => {
  const job = { id: "jobT", jobType: "construction", constructionType: "remodel", customer: "Totem", address: "1 Totem Way",
    updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobT");
  await until(() => buttons(/Estimate timeline/).length > 0);
  buttons(/Estimate timeline/)[0].click();
  await until(() => /review before sending/.test(view().textContent));
  // the crew renames a phase on the redrawn card, which saves the page's copy
  type([...view().querySelectorAll("input")].find((i) => i.value === "Demo"), "Demo + haul-off");
  await until(() => !unsavedProject("jobT"));
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  const after = await Store.get("jobT");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.deepEqual(after.boardPlan && after.boardPlan.phases.map((p) => p.name), ["Demo + haul-off", "Drywall"], "the draft and its edit are kept");
  assert.match(view().textContent, /review before sending/, "the job home still shows the draft");
});

await test("a page of the job opened while Restore runs is redrawn from the restored copy, and saving it keeps the restore", async () => {
  const job = { id: "jobN", jobType: "restoration", customer: "Nordale", address: "9 Nordale Rd", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobN");
  await until(() => buttons(/⏪ Restore/).length > 0);
  // a photo-heavy job: reading it back takes a while
  const get = Store.get;
  let slow = false;
  Store.get = function (id) { const p = get.call(Store, id); return slow && id === "jobN" ? p.then((v) => new Promise((r) => setTimeout(() => r(v), 300))) : p; };
  // while Restore writes its backup, the crew taps Edit job details
  onBackupTx = () => { slow = true; location.hash = "#/p/jobN/edit"; window.dispatchEvent(new window.Event("hashchange")); };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await recovered();
    await until(() => /Edit job/.test(document.getElementById("topbarSub").textContent));
    await settle(500);
  } finally { slow = false; Store.get = get; }
  await settle(400);
  type(input("Claim #"), "CLM-1");                   // the edit page saves its own copy
  await settle(300);
  const after = await Store.get("jobN");
  assert.equal(after.claimNo, "CLM-1");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"], "the restore survives the edit page's save");
  assert.equal(reloads.length, 0, "no reload");
});

await test("an AI timeline draft that comes back after the crew moved to another page of the job lands on that page's copy", async () => {
  const job = { id: "jobT2", jobType: "construction", constructionType: "remodel", customer: "Tanana", address: "2 Tanana Dr",
    updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await nav("#/p/jobT2");
  await until(() => buttons(/Estimate timeline/).length > 0);
  holdDraft = [];
  buttons(/Estimate timeline/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobT2/edit");
  await until(() => /Edit job/.test(document.getElementById("topbarSub").textContent));
  toasts.length = 0;
  answer();
  await until(() => toasted(/Timeline drafted/));
  type(input("Claim #"), "CLM-2");                   // the edit page saves its own copy
  await settle(300);
  const after = await Store.get("jobT2");
  assert.equal(after.claimNo, "CLM-2");
  assert.deepEqual(after.boardPlan && after.boardPlan.phases.map((p) => p.name), ["Demo", "Drywall"], "the draft survives the edit page's save");
});

await test("a rebuild draft that comes back after the crew moved to another page of the job lands on that page's copy", async () => {
  const rest = { id: "jobRs", jobType: "restoration", customer: "Salcha", address: "4 Salcha St", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  const job = { id: "jobRc", jobType: "construction", constructionType: "remodel", customer: "Salcha", address: "4 Salcha St",
    linkedRestorationId: "jobRs", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(rest, { bump: false, quiet: true });
  await Store.put(job, { bump: false, quiet: true });
  await nav("#/p/jobRc");
  await until(() => buttons(/Draft rebuild plan/).length > 0);
  holdDraft = [];
  buttons(/Draft rebuild plan/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobRc/edit");
  await until(() => /Edit job/.test(document.getElementById("topbarSub").textContent));
  toasts.length = 0;
  answer();
  await until(() => toasted(/Rebuild plan drafted/));
  type(input("Claim #"), "CLM-3");                   // the edit page saves its own copy
  await settle(300);
  const after = await Store.get("jobRc");
  assert.equal(after.claimNo, "CLM-3");
  assert.ok(after.rebuildDraft && after.rebuildDraft.status === "draft", "the draft survives the edit page's save");
  assert.equal(after.rebuildDraft.chips.length, 2);
});

await test("an AI draft that comes back while the job's last edit is stuck in the save queue rides that edit", async () => {
  const job = { id: "jobU", jobType: "construction", constructionType: "remodel", customer: "Usibelli", address: "6 Usibelli Way",
    updatedAt: "2026-10-20T00:00:00.000Z", receipts: [{ id: "R1", photo, extraPages: [], vendor: "", amount: "", items: [] }] };
  await Store.put(job, { bump: false, quiet: true });
  await nav("#/p/jobU");
  await until(() => buttons(/Estimate timeline/).length > 0);
  holdDraft = [];
  buttons(/Estimate timeline/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  // the crew types on a receipt while this job can't save (a full disk on a big job), then goes to the job list
  const OS = globalThis.IDBObjectStore.prototype, put = OS.put;
  OS.put = function (v, ...rest) {
    if (this.name === "projects" && v && v.id === "jobU") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return put.call(this, v, ...rest);
  };
  try {
    await nav("#/p/jobU/f/receipts/R1");
    await until(() => view().querySelector('input[placeholder^="Home Depot"]'));
    type(view().querySelector('input[placeholder^="Home Depot"]'), "Fairbanks Lumber");
    await until(() => /Not saved/.test(view().querySelector(".saved-pill").textContent));
    await nav("#/");
    toasts.length = 0;
    answer();                                        // its own save fails too: the draft waits on the queued copy
    await until(() => toasts.length > 0);
  } finally { OS.put = put; }
  await flushPending();
  const after = await Store.get("jobU");
  assert.equal(after.receipts[0].vendor, "Fairbanks Lumber");
  assert.deepEqual(after.boardPlan && after.boardPlan.phases.map((p) => p.name), ["Demo", "Drywall"], "the draft lands with the queued edit");
});

await test("a job home redrawn late from an old copy doesn't become where background writes land", async () => {
  const job = { id: "jobH", jobType: "restoration", customer: "Huffman", address: "5 Huffman Rd", bidOf: "tile-1",
    updatedAt: "2026-10-20T00:00:00.000Z", receipts: [{ id: "R1", photo, extraPages: [], vendor: "", amount: "", items: [] }] };
  await Store.put(job, { bump: false, quiet: true });
  // the home's "✓ Site visit done" waits on the board, then redraws the home from the copy it was drawn with
  await nav("#/p/jobH");
  await until(() => buttons(/Site visit done/).length > 0);
  holdBoard = [];
  buttons(/Site visit done/)[0].click();
  await until(() => holdBoard.length >= 1);
  const release = holdBoard;
  holdBoard = null;
  // meanwhile: a receipt read goes out, and the crew saves a claim number on the edit page
  await nav("#/p/jobH/f/receipts/R1");
  await until(() => buttons(/Read receipt/).length > 0);
  const before = asks.length;
  buttons(/Read receipt/)[0].click();
  await until(() => asks.length === before + 1);
  await nav("#/p/jobH/edit");
  type(input("Claim #"), "CLM-77");
  await settle(300);
  assert.equal((await Store.get("jobH")).claimNo, "CLM-77");
  release.forEach((f) => f());
  await settle(300);
  toasts.length = 0;
  asks[before](spenard);                             // the read lands on the page's copy and saves it
  await until(() => toasted(/Read Spenard/));
  await settle(300);
  const after = await Store.get("jobH");
  assert.equal(after.receipts[0].vendor, "Spenard Builders Supply");
  assert.equal(after.claimNo, "CLM-77", "the saved claim number is kept");
});

await test("a write that went around the page's copy to the store (sync's, before its graft) is kept by a Restore", async () => {
  await jobWithLostReceipt("jobW");
  await nav("#/p/jobW");
  await until(() => buttons(/⏪ Restore/).length > 0);
  // another device's photo, written to the store without touching the page's copy
  const row = await Store.get("jobW");
  await Store.put({ ...row, photos: [{ id: "ph1", caption: "from the office" }] }, { quiet: true });
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  const after = await Store.get("jobW");
  assert.deepEqual(after.receipts.map((r) => r.id).sort(), ["R1", "lost"]);
  assert.deepEqual((after.photos || []).map((p) => p.id), ["ph1"], "the other write is kept");
});

await test("a write that went around the page's copy with an older stamp (a clock behind the job's) is kept by a Restore too", async () => {
  // the job's stamp is ahead of this phone's clock (a server merge floors it at the server's clock)
  const ahead = new Date(Date.now() + 5 * 60e3).toISOString();
  const job = { id: "jobP", jobType: "construction", constructionType: "remodel", customer: "Pioneer", address: "7 Pioneer Rd", updatedAt: ahead, receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-20T00:00:00.000Z", receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  // a Progress Update asked for, then back to the job home while it's written
  await nav("#/p/jobP/progress");
  await until(() => buttons(/Generate update/).length > 0);
  holdDraft = [];
  buttons(/Generate update/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobP");
  await until(() => buttons(/⏪ Restore/).length > 0);
  toasts.length = 0;
  answer();                                          // saved on a store copy, stamped by this phone's clock
  await until(() => toasted(/Progress update drafted/));
  await settle(200);
  assert.ok((await Store.get("jobP")).updatedAt < ahead, "the store write's stamp is behind the page copy's");
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  const after = await Store.get("jobP");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.equal(after.progressNarrative, "Week 2: drywall hung and taped.", "the update is kept");
});

await test("a backup stamped while the phone's clock ran ahead says its time is off", async () => {
  const job = { id: "jobK", jobType: "restoration", customer: "Kodiak", address: "3 Kodiak Ct", updatedAt: "2026-10-20T00:00:00.000Z", receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup(job);
  const realNow = Date.now;
  Date.now = () => realNow() + 864e5;                // a day fast…
  try { await Store.backup({ ...job, customer: "Kodiak 2" }); } finally { Date.now = realNow; }
  await Store.backup({ ...job, customer: "Kodiak 3" });   // …set right: stamped just after it
  await nav("#/p/jobK");
  await until(() => buttons(/⏪ Restore/).length === 3);
  const marked = () => buttons(/⏪ Restore/).map((b) => /time may be off/.test(b.parentNode.textContent));
  // newest first: stamped just after the fast one, the fast one (still in the future), the one before
  assert.deepEqual(marked(), [true, true, false], buttons(/⏪ Restore/).map((b) => b.parentNode.textContent).join(" / "));
  let asked = "";
  globalThis.confirm = window.confirm = (m) => { asked = m; return false; };
  buttons(/⏪ Restore/)[0].click();
  await until(() => asked);
  globalThis.confirm = window.confirm = () => true;
  assert.match(asked, /backup \(time may be off: the phone's clock was set wrong\)\?/, "the Restore question says so too");
  // two days on, the fast one's time has passed; the one stamped after it still says so
  Date.now = () => realNow() + 2 * 864e5;
  try {
    await nav("#/");
    await nav("#/p/jobK");
    await until(() => buttons(/⏪ Restore/).length === 3);
    assert.deepEqual(marked(), [true, false, false]);
  } finally { Date.now = realNow; }
});

quiet.error.call(console, `\n${pass} passed`);
process.exit(0);
