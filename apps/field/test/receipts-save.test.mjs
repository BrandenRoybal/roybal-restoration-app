/* Receipts on a phone whose storage drops out (apps/field/js/receipts.js +
   core.js, jsdom). iOS can kill the browser's storage process while the
   app is open: every save then failed for good, "Saving…" stayed on
   screen and the crew kept snapping into a page that kept nothing. Now
   the store reopens once, and when it still can't save: a snapped photo
   that didn't land never shows as a receipt, a retake keeps the old
   photo, an AI read that answered is kept and saves itself when the
   phone recovers (never a second AI call for it), and a read that comes
   back after the crew moved on lands on the job on screen without
   dropping the receipt snapped meanwhile. A read that never answers
   gives the button back.
   Run: node apps/field/test/receipts-save.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
// jsdom decodes no images: the photo keeps its raw data URL (core.js fileToDataURL)
globalThis.Image = class { set src(_v) { setTimeout(() => this.onerror && this.onerror(), 0); } };
window.confirm = () => true;
globalThis.confirm = window.confirm;
// a signed-in device (made-up login), so the AI read is asked
window.localStorage.setItem("roybal-session", JSON.stringify({
  access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "crew@example.com" }));

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
const storageDown = () => { dead.add(lastDb); openFails = true; };
const storageBack = () => { openFails = false; };

/* ---- the AI reader: each call waits until the test answers it ---- */
const asks = [];   // { pages, answer(receipt), signal }
globalThis.fetch = (url, opts = {}) => {
  const body = JSON.parse(opts.body || "{}");
  if (!/roybal-ai-office/.test(String(url)) || body.action !== "receiptRead") return Promise.reject(new TypeError("unexpected fetch " + url));
  return new Promise((resolve, reject) => {
    const ask = { pages: body.pages, signal: opts.signal,
      answer: (receipt) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, receipt }) }) };
    if (opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    asks.push(ask);
  });
};

const { Store, flushPending, unsavedProject, onProjectSaved } = await import("../js/core.js");
const { receiptsPage, onReceiptLive } = await import("../js/receipts.js");
const { readTuning } = await import("../js/officeai.js");
const { signIn } = await import("../js/supa.js");

const view = document.getElementById("view");
const ctx = { view, setChrome: () => {} };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const toastText = () => document.getElementById("toast").textContent;
const btn = (re) => [...view.querySelectorAll("button")].find((b) => re.test(b.textContent));
const pill = () => view.querySelector(".saved-pill");
const saves = []; onProjectSaved((p) => saves.push(p.id));
const unhandled = []; process.on("unhandledRejection", (e) => unhandled.push(e));

/* app.js in miniature: one job on screen, the hash drives which page shows */
let live = null;
onReceiptLive((id) => (live && live.id === id ? live : null));
async function open(project, rid = null) {
  live = project;
  location.hash = rid ? `#/p/${project.id}/f/receipts/${rid}` : `#/p/${project.id}/f/receipts`;
  await receiptsPage(project, rid, ctx);
  await settle();
}
async function follow() {                       // what the router does on hashchange: a fresh copy of the job
  const m = location.hash.match(/^#\/p\/([^/]+)\/f\/receipts(?:\/(.+))?$/);
  await flushPending().catch(() => {});
  live = unsavedProject(m[1]) || await Store.get(m[1]);
  await receiptsPage(live, m[2] || null, ctx);
  await settle();
}
let shot = 0;
async function snap(input) {                    // a photo from the camera
  const f = new window.File(["receipt photo " + (++shot)], `IMG_${shot}.jpg`, { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  input.dispatchEvent(new window.Event("change"));
  await settle(80);
  return "data:image/jpeg;base64," + Buffer.from("receipt photo " + shot).toString("base64");
}
async function upload(input, n) {               // several photos picked at once (📎 Upload)
  const files = Array.from({ length: n }, () => new window.File(["receipt photo " + (++shot)], `IMG_${shot}.jpg`, { type: "image/jpeg" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new window.Event("change"));
  await settle(120);
}
const uploadOnList = () => view.querySelector('input[type="file"][multiple]');
const cameraOnList = () => view.querySelector('input[type="file"][capture]');
const retakeInput = () => view.querySelector('input[type="file"]');
const job = (id, receipts = []) => ({ id, address: "2156 Alston Rd", customer: "Alston", updatedAt: "2026-10-20T00:00:00.000Z", receipts });
const spenard = { vendor: "Spenard Builders Supply", date: "2026-10-12", total: 155.26, receiptNo: "700687087", confidence: 0.9 };

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Receipts when the phone's storage drops out (DOM)");

await test("a photo snapped while the phone can't save: no receipt appears, nothing is read, the crew is told to snap again", async () => {
  const p = job("j1");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  const before = asks.length;
  storageDown();
  await snap(cameraOnList());
  assert.match(toastText(), /couldn't save that photo\. Snap it again/);
  assert.equal(p.receipts.length, 0, "nothing on screen claims a photo the phone doesn't hold");
  assert.equal(location.hash, "#/p/j1/f/receipts", "stays on the list");
  assert.equal(asks.length, before, "no AI call for a photo that isn't kept");
  storageBack();
  assert.equal((await Store.get("j1")).receipts.length, 0);
});

await test("an AI read whose save fails is kept: the pill says Not saved, it saves on its own once the phone recovers, one AI call", async () => {
  const p = job("j2");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  const photo = await snap(cameraOnList());
  assert.match(location.hash, /^#\/p\/j2\/f\/receipts\/.+/, "the editor opens");
  await follow();
  assert.equal(asks.length, 1, "the read went out");
  assert.equal(asks[0].pages[0], photo);
  assert.equal(btn(/Reading/).disabled, true);
  storageDown();
  asks[0].answer(spenard);
  await settle(80);
  assert.match(toastText(), /Read Spenard Builders Supply, but this phone couldn't save it yet\. It keeps trying/);
  assert.equal(live.receipts[0].vendor, "Spenard Builders Supply", "the read is on the receipt on screen");
  assert.equal(unsavedProject("j2"), live, "and waiting in the save queue");
  await settle(400);
  assert.match(pill().textContent, /Not saved/, "the editor on screen says so (never stuck on Saving…)");
  storageBack();
  for (let i = 0; i < 60 && unsavedProject("j2"); i++) await settle(100);   // the queue retries by itself
  assert.equal(unsavedProject("j2"), null);
  assert.equal(pill().textContent, "✓ Saved");
  const saved = (await Store.get("j2")).receipts[0];
  assert.equal(saved.vendor, "Spenard Builders Supply");
  assert.equal(saved.amount, "155.26");
  assert.equal(asks.length, 1, "never a second AI call for a save that failed");
});

await test("Done before the read answers, then a second snap: the late read lands on the first receipt and the second stays", async () => {
  const p = job("j3");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  const n0 = asks.length;
  await snap(cameraOnList());
  await follow();
  const a = live.receipts[0];
  btn(/✓ Done/).click();
  await settle();
  assert.equal(location.hash, "#/p/j3/f/receipts");
  await follow();
  await snap(cameraOnList());
  await follow();
  const b = live.receipts[1];
  assert.ok(b && b.id !== a.id);
  assert.equal(asks.length, n0 + 2, "one read per receipt");
  asks[n0].answer(spenard);
  await settle(80);
  let saved = await Store.get("j3");
  assert.deepEqual(saved.receipts.map((r) => r.id), [a.id, b.id], "the second receipt was not dropped");
  assert.equal(saved.receipts[0].vendor, "Spenard Builders Supply");
  assert.ok(!saved.receipts[1].vendor, "the first read landed on the first receipt only");
  asks[n0 + 1].answer({ ...spenard, vendor: "Home Depot", total: 42.1, receiptNo: "1" });
  await settle(80);
  saved = await Store.get("j3");
  assert.deepEqual(saved.receipts.map((r) => r.vendor), ["Spenard Builders Supply", "Home Depot"]);
});

await test("a retake while a read is out: the old photo's read is dropped and the new photo is read", async () => {
  const p = job("j4");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  const n0 = asks.length;
  await snap(cameraOnList());
  await follow();
  const r = live.receipts[0];
  const newPhoto = await snap(retakeInput());
  assert.equal(r.photo, newPhoto);
  assert.equal(asks.length, n0 + 1, "the retake waits for the read already out");
  asks[n0].answer({ ...spenard, vendor: "Old Photo Store" });
  await settle(80);
  assert.equal(asks.length, n0 + 2, "the new photo is read without another tap");
  assert.equal(asks[n0 + 1].pages[0], newPhoto);
  assert.ok(!r.vendor, "nothing from the old photo landed");
  asks[n0 + 1].answer(spenard);
  await settle(80);
  assert.equal((await Store.get("j4")).receipts[0].vendor, "Spenard Builders Supply");
});

await test("a retake the phone can't save keeps the old photo and asks the AI nothing", async () => {
  const p = job("j5", [{ id: "R1", vendor: "Spenard Builders Supply", amount: "155.26", photo: "data:image/jpeg;base64,T0xE", ai: { at: "2026-10-20T00:00:00.000Z" }, items: [] }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "R1");
  const n0 = asks.length;
  storageDown();
  await snap(retakeInput());
  assert.match(toastText(), /couldn't save the new photo, so the old one stays/);
  assert.equal(p.receipts[0].photo, "data:image/jpeg;base64,T0xE");
  assert.equal(asks.length, n0);
  storageBack();
});

await test("✓ Done with nothing changed writes nothing (each write used to resave every photo on the job)", async () => {
  const p = job("j6", [{ id: "R1", vendor: "Spenard Builders Supply", amount: "155.26", photo: "data:image/jpeg;base64,T0xE", ai: { at: "2026-10-20T00:00:00.000Z" }, items: [] }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "R1");
  saves.length = 0;
  btn(/✓ Done/).click();
  await settle(450);
  await flushPending();
  assert.equal(saves.length, 0);
  assert.equal(location.hash, "#/p/j6/f/receipts");
});

await test("🗑 when the phone can't save: the delete waits in the queue and lands once it recovers", async () => {
  const p = job("j7", [{ id: "R1", vendor: "Spenard Builders Supply", amount: "155.26", items: [] }, { id: "R2", vendor: "Home Depot", amount: "9.00", items: [] }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "R1");
  storageDown();
  btn(/^🗑$/).click();
  for (let i = 0; i < 40 && !/delete/.test(toastText()); i++) await settle(50);   // receiptlib.js loads on demand
  assert.match(toastText(), /couldn't save the delete yet\. It keeps trying/);
  assert.equal(location.hash, "#/p/j7/f/receipts");
  storageBack();
  await flushPending();
  assert.deepEqual((await Store.get("j7")).receipts.map((r) => r.id), ["R2"]);
});

await test("✎ Type one in when the phone can't save: no blank receipt is left behind", async () => {
  const p = job("j8");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  storageDown();
  btn(/Type one in/).click();
  await settle(80);
  assert.match(toastText(), /couldn't save a new receipt/);
  assert.equal(p.receipts.length, 0);
  assert.equal(location.hash, "#/p/j8/f/receipts");
  storageBack();
});

await test("a read that never answers gives up and gives the button back (was: '✨ Reading…' for good)", async () => {
  readTuning.receiptMs = 60;
  const p = job("j9", [{ id: "R1", vendor: "", amount: "", photo: "data:image/jpeg;base64,T0xE", items: [] }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "R1");
  btn(/Read receipt/).click();
  await settle(20);
  assert.equal(btn(/Reading/).disabled, true);
  await settle(150);
  assert.match(toastText(), /no answer in a minute/);
  const b = btn(/Read receipt/);
  assert.ok(b && !b.disabled);
  readTuning.receiptMs = 60000;
});

await test("a snap that can't save takes back only its own photo: receipts uploaded earlier, still waiting for their read, stay", async () => {
  const p = job("j10");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await upload(uploadOnList(), 3);
  await follow();                                   // the last one's editor opens and reads
  btn(/✓ Done/).click();
  await settle();
  await follow();                                   // back on the list; the first two still wait for a read
  assert.equal(live.receipts.length, 3);
  storageDown();
  await snap(cameraOnList());
  assert.match(toastText(), /couldn't save that photo/);
  assert.equal(live.receipts.length, 3, "the three saved receipts are still on the job");
  storageBack();
  await snap(cameraOnList());
  assert.equal((await Store.get("j10")).receipts.length, 4, "and the next snap keeps them");
});

await test("a read that answers after the crew left the job while the phone can't save: says so, and never writes an old copy of the job", async () => {
  const p = job("j11");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList());
  await follow();
  const a = live.receipts[0], n = asks.length - 1;
  btn(/✓ Done/).click();
  await settle();
  await follow();
  await snap(cameraOnList());                       // receipt B
  await follow();
  const b = live.receipts[1];
  live = null; view.replaceChildren(); location.hash = "#/";   // on to the job list
  storageDown();
  asks[n].answer(spenard);
  await settle(80);
  assert.match(toastText(), /Read Spenard Builders Supply, but this phone couldn't save it\. Tap ✨ Read receipt on it again/);
  assert.equal(unsavedProject("j11"), null, "nothing queued to write back later");
  storageBack();
  await settle(100);
  assert.deepEqual((await Store.get("j11")).receipts.map((r) => r.id), [a.id, b.id], "receipt B is still there");
});

await test("a read that answers after the job was deleted keeps it deleted", async () => {
  const p = job("j12");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList());
  await follow();
  const n = asks.length - 1;
  await Store.del("j12", { quiet: true });          // 🗑 on the job (app.js deleteProject)
  live = null; view.replaceChildren(); location.hash = "#/";
  saves.length = 0;
  asks[n].answer(spenard);
  await settle(80);
  assert.match(toastText(), /gone from the job/);
  assert.equal(await Store.get("j12"), null);
  assert.equal(saves.length, 0);
});

await test("the receipt reopened while its read is out: no second read offered, the read shows up, and a line typed after it saves", async () => {
  const p = job("j13");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList());
  await follow();
  const rid = live.receipts[0].id, n = asks.length - 1;
  btn(/✓ Done/).click();
  await settle();
  await follow();
  location.hash = `#/p/j13/f/receipts/${rid}`;      // tapped again from the list
  await follow();
  assert.ok(btn(/Reading/) && btn(/Reading/).disabled, "'Reading…', not a second paid read");
  asks[n].answer({ ...spenard, items: [{ desc: "2x4 stud", qty: 10, price: 4.5 }] });
  await settle(120);
  assert.equal(asks.length, n + 1);
  assert.equal(view.querySelector('input[placeholder^="Home Depot"]').value, "Spenard Builders Supply", "the open page repaints with the read");
  assert.doesNotMatch(toastText(), /then Done/);
  assert.ok(btn(/Read receipt/) && !btn(/Read receipt/).disabled);
  btn(/Add line item/).click();
  await settle();
  const rows = view.querySelectorAll("tbody tr");
  const desc = rows[rows.length - 1].querySelector("textarea");
  desc.value = "Simpson A35 clip"; desc.dispatchEvent(new window.Event("input"));
  await settle(450);
  await flushPending();
  assert.deepEqual((await Store.get("j13")).receipts[0].items.map((i) => i.desc), ["2x4 stud", "Simpson A35 clip"]);
});

await test("a read that answers after Done repaints the list: its row and the job total, not 'Unknown vendor — $0.00'", async () => {
  const p = job("j14");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList());
  await follow();
  const n = asks.length - 1;
  btn(/✓ Done/).click();
  await settle();
  await follow();
  assert.match(view.querySelector(".citem").textContent, /Unknown vendor — \$0\.00/);
  asks[n].answer(spenard);
  await settle(80);
  assert.match(view.querySelector(".citem").textContent, /Spenard Builders Supply — \$155\.26/);
  assert.match(view.textContent, /Job costs to date\s*\$155\.26/);
});

await test("a read landing while the router opens the job (it read the job first) reaches the page's copy too", async () => {
  const p = job("j15");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList());
  await follow();
  const n = asks.length - 1;
  btn(/✓ Done/).click();
  await settle();
  live = null;                                      // app.js route: liveProject = null, then the job is read…
  const routed = await Store.get("j15");
  const put = Store.put;
  Store.put = function (...a) { Store.put = put; live = routed; return put.apply(Store, a); };   // …and bound while the read's write lands
  asks[n].answer(spenard);
  await settle(80);
  Store.put = put;
  await receiptsPage(live, null, ctx);
  await settle();
  assert.equal(live.receipts[0].vendor, "Spenard Builders Supply", "the page's copy carries the read");
  await snap(cameraOnList());                       // its next save
  assert.equal((await Store.get("j15")).receipts[0].vendor, "Spenard Builders Supply", "and keeps it");
});

await test("↩ Save return when the phone can't save: nothing changes, it says so plainly, and Save works once it can", async () => {
  const purchase = { id: "P1", vendor: "Spenard Builders Supply", date: "2026-10-12", amount: "155.26", receiptNo: "700687087", category: "materials",
    items: [{ id: "i1", desc: "2x4x8 KD stud", qty: "10", unit: "ea", price: "4.50" }], photo: "", extraPages: [] };
  const slip = { id: "S1", vendor: "Spenard Builders Supply", date: "2026-10-14", amount: "", category: "materials",
    items: [{ id: "s1", desc: "2x4x8 KD stud", qty: "2", unit: "ea", price: "-4.50" }], photo: "data:image/jpeg;base64,U0xJUA==", extraPages: [],
    ai: { at: "2026-10-14T00:00:00.000Z", isReturn: true, refund: 9 } };
  const p = job("j16", [purchase, slip]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "S1");
  for (let i = 0; i < 40 && !btn(/Log as a return/); i++) await settle(50);
  btn(/Log as a return/).click();
  for (let i = 0; i < 40 && !btn(/Save return/); i++) await settle(50);
  await settle(450);
  storageDown();
  btn(/Save return/).click();
  await settle(120);
  assert.match(view.querySelector(".warn").textContent, /This phone couldn't save the return\. Try again in a moment/);
  assert.ok(live.receipts.some((r) => r.id === "S1") && !live.receipts.some((r) => r.kind === "return"), "the job in memory is as it was");
  assert.ok(!(live.deletedIds && live.deletedIds.S1), "the slip is not tombstoned");
  storageBack();
  btn(/Save return/).click();
  await settle(120);
  assert.match(toastText(), /Return logged/);
  const disk = (await Store.get("j16")).receipts;
  assert.ok(disk.some((r) => r.kind === "return") && !disk.some((r) => r.id === "S1"));
});

await test("two reads that answer together after the crew left the job both land (one used to write its copy over the other's)", async () => {
  const p = job("j17");
  await Store.put(p, { bump: false, quiet: true });
  await open(p);
  await snap(cameraOnList()); await follow();                  // receipt A: its read goes out
  const na = asks.length - 1;
  btn(/✓ Done/).click(); await settle(); await follow();
  await snap(cameraOnList()); await follow();                  // receipt B: its read goes out
  const nb = asks.length - 1;
  btn(/✓ Done/).click(); await settle(); await follow();
  live = null; view.replaceChildren(); location.hash = "#/";   // back to the job list
  asks[na].answer(spenard);
  asks[nb].answer({ ...spenard, vendor: "Home Depot", total: 42.1, receiptNo: "1" });
  await settle(300);
  const disk = (await Store.get("j17")).receipts;
  assert.equal(disk[0].vendor, "Spenard Builders Supply");
  assert.equal(disk[1].vendor, "Home Depot");
  assert.ok(disk[0].ai && disk[1].ai);
});

await test("a late read whose save fails leaves the save pill with the receipt the crew is on: Not saved, then ✓ Saved once it lands", async () => {
  const p = job("j18", [
    { id: "A", vendor: "", amount: "", photo: "data:image/jpeg;base64,QQ==", items: [], extraPages: [] },
    { id: "B", vendor: "Home Depot", amount: "9.00", items: [], extraPages: [], photo: "" }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "A");
  btn(/Read receipt/).click(); await settle();
  const n = asks.length - 1;
  btn(/✓ Done/).click(); await settle(); await follow();
  location.hash = "#/p/j18/f/receipts/B"; await follow();       // receipt B, nothing waiting to save
  storageDown();
  asks[n].answer(spenard); await settle(450);
  assert.match(pill().textContent, /Not saved/, "the read waits to save: B's pill doesn't say ✓ Saved");
  const notes = () => view.querySelector('textarea[placeholder^="What it was for"]');
  notes().value = "for the bathroom"; notes().dispatchEvent(new window.Event("input"));
  await settle(450);
  storageBack();
  await flushPending();
  const disk = (await Store.get("j18")).receipts;
  assert.equal(disk[0].vendor, "Spenard Builders Supply");
  assert.equal(disk[1].notes, "for the bathroom");
  assert.equal(pill().textContent, "✓ Saved", "not stuck on Not saved / Saving…");
});

await test("…and when the crew's own edit on that receipt is the one waiting, the late read doesn't take its pill: ✓ Saved once both land", async () => {
  const p = job("j20", [
    { id: "A", vendor: "", amount: "", photo: "data:image/jpeg;base64,QQ==", items: [], extraPages: [] },
    { id: "B", vendor: "Home Depot", amount: "9.00", items: [], extraPages: [], photo: "" }]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "A");
  btn(/Read receipt/).click(); await settle();
  const n = asks.length - 1;
  btn(/✓ Done/).click(); await settle(); await follow();
  location.hash = "#/p/j20/f/receipts/B"; await follow();
  const notes = () => view.querySelector('textarea[placeholder^="What it was for"]');
  storageDown();
  notes().value = "for the bathroom"; notes().dispatchEvent(new window.Event("input"));
  await settle(450);
  assert.match(pill().textContent, /Not saved/);
  asks[n].answer(spenard); await settle(150);
  storageBack();
  await flushPending();
  const disk = (await Store.get("j20")).receipts;
  assert.equal(disk[0].vendor, "Spenard Builders Supply");
  assert.equal(disk[1].notes, "for the bathroom");
  assert.equal(pill().textContent, "✓ Saved", "was left on Not saved, and Saving… for good after a tap");
});

await test("a sign-in refresh that never answers still gives the button back within the read's minute (and Log as a return works)", async () => {
  const realFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (url, opts) => {
    if (!/auth\/v1\/token/.test(String(url))) return realFetch(url, opts);
    // the sign-in answers with a session a few seconds from expiry; the refresh then hangs
    if (++tokenCalls === 1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: "t", refresh_token: "r", expires_in: 5, user: { email: "crew@example.com" } }) });
    return new Promise(() => {});
  };
  await signIn("crew@example.com", "pw");
  readTuning.receiptMs = 80;
  const slip = { id: "S1", vendor: "Spenard Builders Supply", date: "2026-10-14", amount: "", category: "materials",
    items: [{ id: "s1", desc: "2x4x8 KD stud", qty: "2", unit: "ea", price: "-4.50" }], photo: "data:image/jpeg;base64,U0xJUA==", extraPages: [] };
  const purchase = { id: "P1", vendor: "Spenard Builders Supply", date: "2026-10-12", amount: "155.26", category: "materials",
    items: [{ id: "i1", desc: "2x4x8 KD stud", qty: "10", unit: "ea", price: "4.50" }], photo: "", extraPages: [] };
  const p = job("j19", [purchase, slip]);
  await Store.put(p, { bump: false, quiet: true });
  await open(p, "S1");
  const before = asks.length;
  btn(/Read receipt/).click();
  await settle(300);
  assert.equal(tokenCalls, 2, "the refresh was asked");
  assert.equal(asks.length, before, "no AI call went out");
  assert.equal(btn(/Read receipt|Reading/).textContent, "✨ Read receipt");
  assert.equal(btn(/Read receipt|Reading/).disabled, false);
  assert.match(toastText(), /no answer in a minute/);
  for (let i = 0; i < 40 && !btn(/Log (it )?as a return/); i++) await settle(50);
  btn(/Log (it )?as a return/).click(); await settle(100);
  assert.ok(btn(/Save return/), "the return form opens");
  readTuning.receiptMs = 60000;
  globalThis.fetch = (url, opts) => /auth\/v1\/token/.test(String(url))
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: "t", refresh_token: "r", expires_in: 3600, user: { email: "crew@example.com" } }) })
    : realFetch(url, opts);
  await signIn("crew@example.com", "pw");
  globalThis.fetch = realFetch;
});

await settle(50);
assert.equal(unhandled.length, 0, "no unhandled rejections: " + unhandled.map(String).join("; "));
console.log(`\n${pass} passed`);
process.exit(0);
