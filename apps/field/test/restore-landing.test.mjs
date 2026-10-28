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
window.alert = () => {};
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";
// each receipt read waits here until the test answers it; so does an AI draft while holdDraft is set,
// and the board's answer to "site visit done" while holdBoard is
const asks = [];
let holdDraft = null, holdBoard = null, cloudRow = null;
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
  // the server's row for "Take the cloud's copy", while cloudRow is set
  if (cloudRow && String(url).includes(`/rest/v1/field_projects?id=eq.${cloudRow.id}&select=id,data,deleted,updated_at`))
    return Promise.resolve({ ok: true, status: 200, json: async () => [cloudRow], text: async () => "" });
  return Promise.reject(new TypeError("offline in this test"));
};
const quiet = { error: console.error, warn: console.warn };
console.error = () => {}; console.warn = () => {};   // sync and the media queue find no network

/* moments inside a restore where a read can land: its read of the stored copy
   going out (onJobRead, the next job read), its backup's transaction
   opening (onBackupTx) or committing (onBackupDone), and the restore's own
   save opening its transaction (onRestorePut, the first job write after a backup).
   failJobWrites: the next N job writes fail as a lost connection does */
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
let onBackupTx = null, onBackupDone = null, onRestorePut = null, onJobRead = null, sawBackup = false, failJobWrites = 0;
P.transaction = function (names, mode, ...rest) {
  const n = [].concat(names).join();
  if (mode === "readwrite" && n === "projects" && failJobWrites > 0) {
    failJobWrites--;
    throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
  }
  if (mode === "readwrite" && n === "projects" && sawBackup && onRestorePut) { const f = onRestorePut; onRestorePut = null; sawBackup = false; f(); }
  if (mode !== "readwrite" && n === "projects" && onJobRead) { const f = onJobRead; onJobRead = null; queueMicrotask(f); }
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
const { newWorkAuth, newCertCompletion, newCertDrying } = await import("../js/model.js");

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
  const entry = Store.snapshotEntry;
  Store.snapshotEntry = async (k) => {
    const got = await entry.call(Store, k);
    const d = got && got.data;
    if (!d || d.id !== "jobS3") return got;
    let fired = false; const rc = d.receipts;
    Object.defineProperty(d, "receipts", { enumerable: true, configurable: true, get() { if (!fired) { fired = true; answer(spenard); } return rc; } });
    return got;
  };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await recovered();
  } finally { Store.snapshotEntry = entry; }
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

/* the page's copy saving itself while the backup is written (a receipt read
   landing on it) writes over the stored row: the write that went around that
   copy is kept because Restore unioned its read into the copy before the backup */
await test("a write that went around the page's copy is kept when a read saves that copy during Restore's backup", async () => {
  await jobWithLostReceipt("jobV");
  const answer = await readOutThenJobPage("jobV");
  const row = await Store.get("jobV");
  await Store.put({ ...row, photos: [{ id: "ph1", caption: "from the office" }] }, { quiet: true });
  onBackupTx = () => answer(spenard);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  assert.equal(onBackupTx, null, "the read answered inside the restore");
  assert.deepEqual(await stored("jobV"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
  assert.deepEqual(((await Store.get("jobV")).photos || []).map((p) => p.id), ["ph1"], "the other write is kept");
});

await test("a Progress Update saved around the page's copy is kept when a read saves that copy during Restore's backup", async () => {
  const job = { id: "jobX", jobType: "construction", constructionType: "remodel", customer: "Ester", address: "4 Ester Dome Rd",
    updatedAt: "2026-10-20T00:00:00.000Z", receipts: [{ id: "R1", photo, extraPages: [], vendor: "", amount: "", items: [] }] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, receipts: [...job.receipts, { id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  const answerRead = await readOutThenJobPage("jobX");
  // a Progress Update asked for, then back to the job home while it's written
  await nav("#/p/jobX/progress");
  await until(() => buttons(/Generate update/).length > 0);
  holdDraft = [];
  buttons(/Generate update/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobX");
  await until(() => buttons(/⏪ Restore/).length > 0);
  toasts.length = 0;
  answer();
  await until(() => toasted(/Progress update drafted/));
  await settle(200);
  onBackupTx = () => answerRead(spenard);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  assert.equal(onBackupTx, null, "the read answered inside the restore");
  assert.deepEqual(await stored("jobX"), ["R1:Spenard Builders Supply", "lost:Rental Zone"]);
  assert.equal((await Store.get("jobX")).progressNarrative, "Week 2: drywall hung and taped.", "the update is kept");
});

/* the union of Restore's read goes in before its backup: what the page's copy
   saves while the backup is written goes on top of it, even a cleared field */
await test("an Unarchive tapped while Restore's backup is written stays unarchived", async () => {
  const job = { id: "jobY", jobType: "restoration", customer: "Yukon", address: "9 Yukon Dr",
    updatedAt: "2026-10-20T00:00:00.000Z", archivedAt: "2026-10-21T00:00:00.000Z", receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  const { archivedAt: _was, ...unarchived } = job;
  await Store.backup({ ...unarchived, updatedAt: "2026-10-19T00:00:00.000Z", receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobY");
  await until(() => buttons(/Unarchive/).length > 0 && buttons(/⏪ Restore/).length > 0);
  onBackupTx = () => buttons(/Unarchive/)[0].click();
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  assert.equal(onBackupTx, null, "Unarchive was tapped inside the restore");
  const after = await Store.get("jobY");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.equal(after.archivedAt || "", "", "the job stays unarchived");
});

await test("on a job stamped ahead of the phone's clock, an AI timeline draft landing during Restore's backup is kept", async () => {
  const ahead = new Date(Date.now() + 5 * 60e3).toISOString();
  const job = { id: "jobS", jobType: "construction", constructionType: "remodel", customer: "Salcha", address: "2 Salcha Rd", updatedAt: ahead, receipts: [],
    boardPlan: { phases: [{ name: "Old guess", estimatedHours: 2, lagDays: 0, confidence: 0.4 }], notBefore: "", notBeforeLabel: "",
      assumptions: [], generatedAt: "2026-10-01T00:00:00.000Z", status: "dismissed" } };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-19T00:00:00.000Z", receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobS");
  await until(() => buttons(/Estimate timeline/).length > 0 && buttons(/⏪ Restore/).length > 0);
  holdDraft = [];
  buttons(/Estimate timeline/)[0].click();
  await until(() => holdDraft.length === 1);
  const draftBack = holdDraft[0];
  holdDraft = null;
  onBackupTx = () => draftBack();                    // saved on the page's copy, stamped by this phone's clock
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  assert.equal(onBackupTx, null, "the draft came back inside the restore");
  const after = await Store.get("jobS");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.equal(`${after.boardPlan.status}:${after.boardPlan.phases.map((p) => p.name).join("+")}`, "draft:Demo+Drywall", "the new draft is kept");
});

/* a backup taken while a server merge had the job stamped ahead of this phone,
   and the job since saved by a landing stamped with this phone's clock: the
   backup's stamp is the later one, but it is never the newer side */
await test("a backup stamped ahead of the job never puts its old values back over the job's", async () => {
  const at = (min) => new Date(Date.now() + min * 60e3).toISOString();
  const job = { id: "jobG", jobType: "restoration", customer: "Rivera & Sons", address: "7 Rivera Ln", claimNo: "CLM-2", updatedAt: at(0),
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 120, items: [] }] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, customer: "Rivera", claimNo: "CLM-1", updatedAt: at(4),
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }, { id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobG");
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  const after = await Store.get("jobG");
  assert.deepEqual(after.receipts.map((r) => `${r.id}:${r.amount}`).sort(), ["lost:42", "r1:120"], "the lost receipt is back; r1 keeps its corrected amount");
  assert.equal(after.customer, "Rivera & Sons", "the corrected name stays");
  assert.equal(after.claimNo, "CLM-2", "the corrected claim number stays");
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

await test("on a job stamped ahead of the phone's clock, a regenerated Progress Update saved around the page's copy is kept by a Restore", async () => {
  // the job already has an update, so both copies hold one: the stamps alone would keep the old
  const ahead = new Date(Date.now() + 5 * 60e3).toISOString();
  const job = { id: "jobRG", jobType: "construction", constructionType: "remodel", customer: "Ester", address: "9 Ester Dome Rd", updatedAt: ahead, receipts: [],
    progressNarrative: "Week 1: demo done.", progressNarrativeDate: "2026-10-18" };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-20T00:00:00.000Z", receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobRG/progress");
  await until(() => buttons(/Generate update|Regenerate/).length > 0);
  holdDraft = [];
  buttons(/Generate update|Regenerate/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobRG");
  await until(() => buttons(/⏪ Restore/).length > 0);
  toasts.length = 0;
  answer();                                          // saved on a store copy, stamped by this phone's clock
  await until(() => toasted(/Progress update drafted/));
  await settle(200);
  const mid = await Store.get("jobRG");
  assert.equal(mid.progressNarrative, "Week 2: drywall hung and taped.");
  assert.ok(mid.updatedAt < ahead, "the store write's stamp is behind the page copy's");
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  const after = await Store.get("jobRG");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.equal(after.progressNarrative, "Week 2: drywall hung and taped.", "the new update is kept, not the old one");
});

await test("after \"Take the cloud's copy\", Restore brings this phone's unsynced changes back, and a form it only tapped open never covers the signed one", async () => {
  const SIGNED = "2026-10-20";
  const signed = { ...newWorkAuth(), date: SIGNED, scope: { 0: true, 1: true, 2: true, 3: true, 4: false, 5: false, 6: true, 7: true }, smsConsent: true,
    ownerSig: "data:image/png;base64,T1dORVI=", ownerName: "Pat Chena", ownerDate: SIGNED, repSig: "data:image/png;base64,UkVQ", repName: "Branden", repDate: SIGNED };
  // the cloud's copy, with the work auth another phone had the owner sign
  const cloud = { id: "jobTC", jobType: "restoration", customer: "Chena", address: "5 Chena Pump Rd", claimNo: "CLM-1", updatedAt: "2026-10-24T09:00:00.000Z", rev: 7,
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }], workAuth: signed };
  // this phone's later work, never synced; it had only tapped the work auth open
  const local = { ...cloud, customer: "Chena Hot Springs LLC", claimNo: "CLM-7", updatedAt: "2026-10-24T11:00:00.000Z", workAuth: newWorkAuth(),
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 120, items: [] }, { id: "r2", vendor: "Rental Zone", amount: 42, items: [] }] };
  delete local.rev;
  await Store.put(local, { bump: false, quiet: true });
  await nav("#/p/jobTC");
  await until(() => buttons(/Take the cloud.s copy/).length > 0);
  cloudRow = { id: "jobTC", data: cloud, deleted: false, updated_at: cloud.updatedAt };
  try {
    tap(buttons(/Take the cloud.s copy/)[0]);
    await until(() => toasted(/Took the cloud.s copy/));
  } finally { cloudRow = null; }
  await settle(900);                                 // its reload is a no-op here: open the job again
  await nav("#/");
  await nav("#/p/jobTC");
  assert.equal((await Store.get("jobTC")).claimNo, "CLM-1", "the cloud's copy replaced this phone's");
  await until(() => buttons(/⏪ Restore/).length > 0);
  let asked = "";
  globalThis.confirm = window.confirm = (m) => { asked = m; return true; };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await until(() => toasted(/Brought back this phone's changes from before it took the cloud's copy\./));
  } finally { globalThis.confirm = window.confirm = () => true; }
  assert.match(asked, /set aside when it took the cloud's copy\. Nothing on the job is removed: anything it has that the job doesn't comes back, and where both have a value, the copy saved last keeps its own\./, "the Restore question says what this backup is and how the merge goes");
  await settle(400);
  const after = await Store.get("jobTC");
  assert.deepEqual(after.receipts.map((r) => `${r.id}:${r.amount}`).sort(), ["r1:120", "r2:42"], "the new receipt and the corrected amount are back");
  assert.equal(after.customer, "Chena Hot Springs LLC");
  assert.equal(after.claimNo, "CLM-7");
  const wa = after.workAuth;
  assert.equal(wa.ownerName, "Pat Chena", "the signed work auth stays");
  assert.deepEqual([wa.date, wa.ownerDate, wa.repDate], [SIGNED, SIGNED, SIGNED], "with its signed dates");
  assert.equal(wa.scope[4], false, "the scope the owner declined stays unchecked");
  assert.equal(wa.smsConsent, true);
  // the set-aside copy again: the job now has all of it
  assert.equal((await Store.snapshots("jobTC")).length, 2, "the set-aside copy and the one Restore saved first");
  await until(() => buttons(/⏪ Restore/).length >= 2);
  tap(buttons(/⏪ Restore/).pop());                  // the oldest: the set-aside copy
  await until(() => toasted(/Nothing was missing from the job\. Where both had a value, the job's copy, saved at least as recently, kept its own\./));
  await settle(400);
  assert.equal((await Store.get("jobTC")).claimNo, "CLM-7");
});

await test("a copy set aside that is older than the cloud's copy it gave way to: the job's values stay, and the toast says so", async () => {
  // this phone's edits were made offline before the office's, so the cloud's copy is stamped after them
  const cloud = { id: "jobSO", jobType: "restoration", customer: "Salcha", address: "2 Salcha Rd", claimNo: "CLM-1", updatedAt: "2026-10-24T11:00:00.000Z", rev: 8,
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }], notes: "office: adjuster visit Tue" };
  const local = { ...cloud, claimNo: "CLM-7", updatedAt: "2026-10-24T10:00:00.000Z", notes: "",
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 120, items: [] }, { id: "r2", vendor: "Rental Zone", amount: 42, items: [] }] };
  delete local.rev;
  await Store.put(local, { bump: false, quiet: true });
  await nav("#/p/jobSO");
  await until(() => buttons(/Take the cloud.s copy/).length > 0);
  cloudRow = { id: "jobSO", data: cloud, deleted: false, updated_at: cloud.updatedAt };
  try {
    tap(buttons(/Take the cloud.s copy/)[0]);
    await until(() => toasted(/Took the cloud.s copy/));
  } finally { cloudRow = null; }
  await settle(900);
  await nav("#/");
  await nav("#/p/jobSO");
  assert.equal((await Store.get("jobSO")).updatedAt, cloud.updatedAt, "the job is the cloud's copy, unchanged since");
  await until(() => buttons(/⏪ Restore/).length > 0);
  let asked = "";
  globalThis.confirm = window.confirm = (m) => { asked = m; return true; };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await until(() => toasted(/Recovered 1 item from the backup\. Where both had a value, the job's copy, saved at least as recently, kept its own\./));
  } finally { globalThis.confirm = window.confirm = () => true; }
  assert.match(asked, /set aside when it took the cloud's copy\. Nothing on the job is removed: anything it has that the job doesn't comes back, and where both have a value, the copy saved last keeps its own\./);
  assert.doesNotMatch(asked, /its changes come back|hadn't synced|newer than the job/, "it promises nothing the merge decides later");
  await settle(400);
  const after = await Store.get("jobSO");
  assert.deepEqual(after.receipts.map((r) => `${r.id}:${r.amount}`).sort(), ["r1:100", "r2:42"], "the new receipt comes back; the job's amount stays");
  assert.equal(after.claimNo, "CLM-1");
  assert.equal(after.notes, "office: adjuster visit Tue");
});

await test("a set-aside copy stamped the same as the cloud's copy: the job's values stay, and the toast says so", async () => {
  const at = "2026-10-24T11:00:00.000Z";
  const cloud = { id: "jobSE", jobType: "restoration", customer: "Ester", address: "3 Ester Dome Rd", claimNo: "CLM-1", updatedAt: at, rev: 8,
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }] };
  const local = { ...cloud, claimNo: "CLM-7", receipts: [...cloud.receipts, { id: "r2", vendor: "Rental Zone", amount: 42, items: [] }] };
  delete local.rev;
  await Store.put(local, { bump: false, quiet: true });
  await nav("#/p/jobSE");
  await until(() => buttons(/Take the cloud.s copy/).length > 0);
  cloudRow = { id: "jobSE", data: cloud, deleted: false, updated_at: at };
  try {
    tap(buttons(/Take the cloud.s copy/)[0]);
    await until(() => toasted(/Took the cloud.s copy/));
  } finally { cloudRow = null; }
  await settle(900);
  await nav("#/");
  await nav("#/p/jobSE");
  await until(() => buttons(/⏪ Restore/).length > 0);
  let asked = "";
  globalThis.confirm = window.confirm = (m) => { asked = m; return true; };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await until(() => toasted(/Recovered 1 item from the backup\. Where both had a value, the job's copy, saved at least as recently, kept its own\./));
  } finally { globalThis.confirm = window.confirm = () => true; }
  assert.match(asked, /set aside when it took the cloud's copy\. Nothing on the job is removed: anything it has that the job doesn't comes back, and where both have a value, the copy saved last keeps its own\./);
  await settle(400);
  assert.equal((await Store.get("jobSE")).claimNo, "CLM-1", "on equal stamps the job's side wins");
});

await test("a set-aside copy restored after a draft was saved around the page's copy: the job's values stay, the draft is kept, and the toast says so", async () => {
  // this phone's copy is newer than the cloud's, but a Progress Update drafted since is newer still
  const cloud = { id: "jobPU", jobType: "construction", constructionType: "remodel", customer: "Harding", address: "6 Harding Dr", claimNo: "CLM-1",
    updatedAt: "2026-10-24T09:00:00.000Z", rev: 7, receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }] };
  const local = { ...cloud, claimNo: "CLM-7", updatedAt: "2026-10-24T11:00:00.000Z",
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 120, items: [] }, { id: "r2", vendor: "Rental Zone", amount: 42, items: [] }] };
  delete local.rev;
  await Store.put(local, { bump: false, quiet: true });
  await nav("#/p/jobPU");
  await until(() => buttons(/Take the cloud.s copy/).length > 0);
  cloudRow = { id: "jobPU", data: cloud, deleted: false, updated_at: cloud.updatedAt };
  try {
    tap(buttons(/Take the cloud.s copy/)[0]);
    await until(() => toasted(/Took the cloud.s copy/));
  } finally { cloudRow = null; }
  await settle(900);
  await nav("#/");
  await nav("#/p/jobPU/progress");
  await until(() => buttons(/Generate update|Regenerate/).length > 0);
  holdDraft = [];
  buttons(/Generate update|Regenerate/)[0].click();
  await until(() => holdDraft.length === 1);
  const answer = holdDraft[0];
  holdDraft = null;
  await nav("#/p/jobPU");
  await until(() => buttons(/⏪ Restore/).length > 0);
  toasts.length = 0;
  answer();                                          // saved on a store copy, around the job home's
  await until(() => toasted(/Progress update drafted/));
  await settle(200);
  assert.ok((await Store.get("jobPU")).updatedAt > local.updatedAt, "the draft stamped the stored copy after the set-aside one");
  let asked = "";
  globalThis.confirm = window.confirm = (m) => { asked = m; return true; };
  try {
    tap(buttons(/⏪ Restore/)[0]);
    await until(() => toasted(/Recovered 1 item from the backup\. Where both had a value, the job's copy, saved at least as recently, kept its own\./));
  } finally { globalThis.confirm = window.confirm = () => true; }
  assert.match(asked, /set aside when it took the cloud's copy\. Nothing on the job is removed: anything it has that the job doesn't comes back, and where both have a value, the copy saved last keeps its own\./);
  assert.doesNotMatch(asked, /its changes come back|newer than the job/, "it promises nothing the merge decides later");
  await settle(400);
  const after = await Store.get("jobPU");
  assert.deepEqual(after.receipts.map((r) => `${r.id}:${r.amount}`).sort(), ["r1:100", "r2:42"]);
  assert.equal(after.claimNo, "CLM-1");
  assert.equal(after.progressNarrative, "Week 2: drywall hung and taped.", "the draft is kept");
});

await test("a work authorization tapped open blank, then restored, comes back as signed: its dates, scope and text opt-in", async () => {
  const SIGNED = "2026-10-20";
  const signed = { ...newWorkAuth(), date: SIGNED, scope: { 0: true, 1: true, 2: true, 3: true, 4: false, 5: false, 6: true, 7: true }, smsConsent: true,
    ownerSig: "data:image/png;base64,T1dORVI=", ownerName: "Pat Chena", ownerDate: SIGNED, repSig: "data:image/png;base64,UkVQ", repName: "Branden", repDate: SIGNED };
  const job = { id: "jobWA", jobType: "restoration", customer: "Chena Ridge HOA", address: "4 Chena Ridge Rd", updatedAt: new Date().toISOString(), receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  // sync's copy from before a newer one without the work auth replaced it
  await Store.backup({ ...job, updatedAt: "2026-10-21T00:00:00.000Z", workAuth: signed });
  await nav("#/p/jobWA/f/workAuth");                  // "where did it go?": the tile saves a blank
  assert.ok((await Store.get("jobWA")).workAuth, "opening the form saved a blank");
  await nav("#/p/jobWA");
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => toasted(/Recovered 1 form from the backup\./));
  await settle(400);
  const wa = (await Store.get("jobWA")).workAuth;
  assert.equal(wa.ownerName, "Pat Chena");
  assert.ok(wa.ownerSig, "the owner's signature is back");
  assert.deepEqual([wa.date, wa.ownerDate, wa.repDate], [SIGNED, SIGNED, SIGNED], "the signed dates, not today's");
  assert.deepEqual([wa.scope[4], wa.scope[5]], [false, false], "the scope the owner declined stays unchecked");
  assert.equal(wa.smsConsent, true, "the owner's text opt-in is kept");
});

await test("an AI timeline draft that lands on the page's copy while Restore's read of the stored copy is out is kept", async () => {
  // the read comes back without the draft and stamped older: the page's copy, which moved, is the newer side
  const job = { id: "jobRD", jobType: "construction", constructionType: "remodel", customer: "Rosie Creek", address: "3 Rosie Creek Rd",
    updatedAt: "2026-10-22T00:00:00.000Z", receipts: [],
    boardPlan: { phases: [{ name: "Old guess", estimatedHours: 2, lagDays: 0, confidence: 0.4 }], notBefore: "", notBeforeLabel: "",
      assumptions: [], generatedAt: "2026-10-01T00:00:00.000Z", status: "dismissed" } };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-19T00:00:00.000Z", receipts: [{ id: "lost", vendor: "Rental Zone", amount: 42, items: [] }] });
  await nav("#/p/jobRD");
  await until(() => buttons(/Estimate timeline/).length > 0 && buttons(/⏪ Restore/).length > 0);
  holdDraft = [];
  buttons(/Estimate timeline/)[0].click();
  await until(() => holdDraft.length === 1);
  const draftBack = holdDraft[0];
  holdDraft = null;
  // the stored row differs from the page's copy, so Restore unions its read in
  await Store.put({ ...(await Store.get("jobRD")), photos: [{ id: "ph1", caption: "from the office" }] }, { quiet: true });
  let drafted = null;
  onJobRead = () => { draftBack(); drafted = true; };
  tap(buttons(/⏪ Restore/)[0]);
  await recovered();
  await settle(400);
  assert.ok(drafted, "the draft came back while the read was out");
  const after = await Store.get("jobRD");
  assert.deepEqual(after.receipts.map((r) => r.id), ["lost"]);
  assert.deepEqual((after.photos || []).map((p) => p.id), ["ph1"], "the write around the page's copy is kept");
  assert.equal(`${after.boardPlan.status}:${after.boardPlan.phases.map((p) => p.name).join("+")}`, "draft:Demo+Drywall", "the new draft is kept");
});

await test("a certificate of completion tapped open blank, then restored, comes back as signed", async () => {
  const SIGNED = "2026-10-20";
  const signed = { ...newCertCompletion(), issueDate: SIGNED, completionDate: "2026-10-19", scopeSummary: "Kitchen remodel", warrantyWorkmanship: "2 years",
    sigContractor: "data:image/png;base64,QlI=", sigContractorName: "Branden", sigContractorDate: SIGNED,
    sigOwner: "data:image/png;base64,T1dORVI=", sigOwnerName: "Dana Two Rivers", sigOwnerDate: SIGNED };
  const job = { id: "jobCO", jobType: "construction", constructionType: "remodel", customer: "Two Rivers", address: "8 Two Rivers Rd", updatedAt: new Date().toISOString(), receipts: [] };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-21T00:00:00.000Z", certCompletion: signed });
  await nav("#/p/jobCO/f/certCompletion");           // a blank, with an id of its own
  const blank = (await Store.get("jobCO")).certCompletion;
  assert.ok(blank && blank.id && blank.id !== signed.id, "opening the form saved a blank with its own id");
  await nav("#/p/jobCO");
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => toasted(/Recovered 1 form from the backup\./));
  await settle(400);
  const cc = (await Store.get("jobCO")).certCompletion;
  assert.equal(cc.sigOwnerName, "Dana Two Rivers");
  assert.deepEqual([cc.issueDate, cc.sigContractorDate, cc.sigOwnerDate], [SIGNED, SIGNED, SIGNED], "the signed dates, not today's");
  assert.equal(cc.warrantyWorkmanship, "2 years", "the warranty that was signed");
});

await test("a certificate tapped open on an Alaska evening, when its createdAt stamp is already tomorrow in UTC, still counts as blank", async () => {
  const SIGNED = "2026-10-20";
  const signed = { ...newCertCompletion(), issueDate: SIGNED, completionDate: "2026-10-19", scopeSummary: "Bath remodel",
    sigOwner: "data:image/png;base64,T1dORVI=", sigOwnerName: "Lee Farmers Loop", sigOwnerDate: SIGNED };
  const blank = newCertCompletion();
  const tomorrow = new Date(Date.parse(blank.issueDate) + 86400e3).toISOString().slice(0, 10);
  blank.createdAt = `${tomorrow}T02:30:00.000Z`;     // 6:30 PM the day before, Alaska time
  const job = { id: "jobCE", jobType: "construction", constructionType: "remodel", customer: "Lee", address: "5 Farmers Loop Rd",
    updatedAt: new Date().toISOString(), receipts: [], certCompletion: blank };
  await Store.put(job, { bump: false, quiet: true });
  await Store.backup({ ...job, updatedAt: "2026-10-21T00:00:00.000Z", certCompletion: signed });
  await nav("#/p/jobCE");
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => toasted(/Recovered 1 form from the backup\./));
  await settle(400);
  const cc = (await Store.get("jobCE")).certCompletion;
  assert.equal(cc.sigOwnerName, "Lee Farmers Loop");
  assert.deepEqual([cc.issueDate, cc.sigOwnerDate], [SIGNED, SIGNED], "the signed dates, not the blank's");
});

await test("a certificate opened blank whose issue date the crew then set is a filled form: Restore keeps that date", async () => {
  const SIGNED = "2026-10-22", SET = "2026-10-23";
  const signed = { ...newCertDrying(), issueDate: SIGNED, sigTech: "data:image/png;base64,QlI=", sigTechName: "Branden", sigTechDate: SIGNED };
  for (const [id, setAside] of [["jobCD", false], ["jobCS", true]]) {
    const job = { id, jobType: "restoration", customer: "Badger", address: "7 Badger Rd", updatedAt: "2026-10-24T09:00:00.000Z", rev: 3, receipts: [] };
    if (setAside) {                                  // this phone's signed copy, set aside for the cloud's
      const local = { ...job, updatedAt: "2026-10-24T11:00:00.000Z", certDrying: signed };
      delete local.rev;
      await Store.put(local, { bump: false, quiet: true });
      await nav(`#/p/${id}`);
      await until(() => buttons(/Take the cloud.s copy/).length > 0);
      cloudRow = { id, data: job, deleted: false, updated_at: job.updatedAt };
      try {
        tap(buttons(/Take the cloud.s copy/)[0]);
        await until(() => toasted(/Took the cloud.s copy/));
      } finally { cloudRow = null; }
      await settle(900);
      await nav("#/");
    } else {                                         // sync's copy from before a newer one without the cert replaced it
      await Store.put(job, { bump: false, quiet: true });
      await Store.backup({ ...job, updatedAt: "2026-10-21T00:00:00.000Z", certDrying: signed });
    }
    await nav(`#/p/${id}/f/certDrying`);             // a blank, then the crew sets its issue date
    type(input("Issue Date"), SET);
    for (let i = 0; i < 150 && ((await Store.get(id)).certDrying || {}).issueDate !== SET; i++) await settle(30);
    assert.equal((await Store.get(id)).certDrying.issueDate, SET, "the date the crew set is saved");
    await nav(`#/p/${id}`);
    await until(() => buttons(/⏪ Restore/).length > 0);
    tap(buttons(/⏪ Restore/)[0]);
    await until(() => toasted(setAside
      ? /Recovered 1 form from the backup\. Where both had a value, the job's copy, saved at least as recently, kept its own\./
      : /Recovered 1 form from the backup\./));
    await settle(400);
    const cd = (await Store.get(id)).certDrying;
    assert.equal(cd.issueDate, SET, `the issue date the crew set stays (${setAside ? "set-aside" : "replaced"} backup)`);
    assert.equal(cd.sigTechName, "Branden", "what the job's form lacked comes back");
    assert.ok(cd.sigTech, "with the signature");
  }
});

await test("a copy set aside before this update, whose record doesn't say what it is, still brings this phone's changes back", async () => {
  const cloud = { id: "jobLS", jobType: "restoration", customer: "Goldstream", address: "1 Goldstream Rd", claimNo: "CLM-1", updatedAt: "2026-10-24T09:00:00.000Z",
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 100, items: [] }] };
  const local = { ...cloud, claimNo: "CLM-7", updatedAt: "2026-10-24T11:00:00.000Z",
    receipts: [{ id: "r1", vendor: "Spenard Builders", amount: 120, items: [] }, { id: "r2", vendor: "Rental Zone", amount: 42, items: [] }] };
  // what "Take the cloud's copy" did before this update: a plain backup of this phone's copy, then the cloud's, unbumped
  await Store.backup(local);
  const [{ key }] = await Store.snapshots("jobLS");
  await new Promise((resolve, reject) => {
    const open = indexedDB.open("roybal-field");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const t = open.result.transaction("backups", "readwrite"), os = t.objectStore("backups"), get = os.get(key);
      get.onsuccess = () => { const rec = get.result; delete rec.kind; os.put(rec); };
      t.oncomplete = () => { open.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  });
  assert.equal((await Store.snapshotEntry(key)).kind, "", "the record says nothing about what it holds");
  await Store.put(cloud, { bump: false, quiet: true });
  await nav("#/p/jobLS");
  await until(() => buttons(/⏪ Restore/).length > 0);
  tap(buttons(/⏪ Restore/)[0]);
  await until(() => toasted(/Brought back what that backup had\./));
  await settle(400);
  const after = await Store.get("jobLS");
  assert.deepEqual(after.receipts.map((r) => `${r.id}:${r.amount}`).sort(), ["r1:120", "r2:42"], "the new receipt and the corrected amount are back");
  assert.equal(after.claimNo, "CLM-7");
});

quiet.error.call(console, `\n${pass} passed`);
process.exit(0);
