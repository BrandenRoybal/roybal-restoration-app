/* Meter photos on the Moisture Map (apps/field/js/meterui.js + forms.js, jsdom).
   Today's readings carry a 📷 under each cell, once the server merges
   meter photos (migration 0024). A photo is saved on the device before
   the reader is asked, tagged with the phone that took it, and only that
   phone asks for its number: when the map opens or a sync completes with
   signal. In fill mode a confident number lands in an EMPTY cell amber
   until the tech confirms it, a typed value is never overwritten (a
   different read shows ≠), and in check mode nothing is filled. A read
   lands on the job on screen, or on the saved copy — never through the
   form's autosave. Deleting a reading date takes its photos along. On
   paper a reading with a photo carries a P (P? while unchecked) and the
   photos print after the grid; the Certificate of Drying shows each
   location's final reading with its photo.
   Run: node apps/field/test/meter-ui.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "MouseEvent", "FocusEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
const ctxStub = new Proxy({}, { get: () => () => ({ data: [] }) });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
let confirmAnswer = true;
const confirms = [];
window.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };
globalThis.confirm = window.confirm;
window.localStorage.setItem("roybal-offline", "1");
// a signed-in device (made-up login), so the server check can be asked
window.localStorage.setItem("roybal-session", JSON.stringify({
  access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "crew@example.com" }));
let fetcher = async () => { throw new TypeError("network down"); };
globalThis.fetch = (...a) => fetcher(...a);

const { Store, flushPending, todayISO } = await import("../js/core.js");
const { newCertDrying } = await import("../js/model.js");
const { setCtx } = await import("../js/formkit.js");
const { moistureMap, certDrying } = await import("../js/forms.js");
const { graftProject } = await import("../js/graft.js");
const { readMeter } = await import("../js/officeai.js");
const { meterDeps, readPendingMeters, readAllWaitingMeters, readWaitingMeters, onMeterLive, deviceTag } = await import("../js/meterui.js");
const { pendingReads } = await import("../js/meterphotos.js");

const view = document.getElementById("view");
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const toastText = () => document.getElementById("toast").textContent;
const JPEG = "data:image/jpeg;base64," + "B".repeat(64);
const TODAY = todayISO();
const label = (iso) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Moisture Map — meter photos (DOM)");

/* ---------- the fake camera, server check and reader ---------- */
let online = false;
let replies = [];                      // what the reader answers, in order
const asks = [];
let probeAnswer = { meterPhotos: [] };   // 0024 applied
let probes = 0;
meterDeps.ready = () => online;
meterDeps.pick = async () => ({ name: "meter.jpg", type: "image/jpeg" });
meterDeps.encode = async () => JPEG;
meterDeps.probe = async () => { probes++; return new Response(JSON.stringify(probeAnswer), { status: 200 }); };
meterDeps.read = async (project, src, hint) => {
  asks.push({ src, hint });
  const r = replies.shift();
  if (r instanceof Error) throw r;
  return r;
};
const fillReply = (value, extra = {}) => ({ fill: true, off: false, meter: { device: "moisture_meter", readable: true, value, unit: "%", mode: "", confidence: 0.95, note: "", fillable: true, model: "m", ...extra } });

/* ---------- fixtures (made-up job) ---------- */
const blankRow = (rk, date) => ({ rk, date, values: Array(13).fill(""), notes: "" });
let jobN = 0;
function job() {
  return {
    id: "job-mp-" + (++jobN), customer: "Test Customer", address: "1 Test St", updatedAt: "2026-10-09T00:00:00.000Z",
    moistureMaps: [{ id: "map1", label: "Kitchen", meter: "Tramex MEX5", material: "Drywall / Gypsum", dryGoal: "≤ 1%",
      readings: [blankRow("r0", "2026-10-07"), blankRow("r1", TODAY), blankRow("r2", TODAY)] }],
  };
}
let current = null;            // the job "on screen" (app.js liveProject)
onMeterLive((id) => (current && current.id === id ? current : null));
async function render(p) {
  current = p;
  await Store.put(p);
  setCtx(p, document.createElement("span"));
  const sheet = moistureMap(p, p.moistureMaps[0]);
  view.replaceChildren(sheet);
  await settle();
  return sheet;
}
const grid = (sheet) => sheet.querySelector("table.grid");
const cell = (sheet, r, loc) => grid(sheet).querySelector("tbody").children[r].children[1 + loc];
const badge = (sheet, r, loc) => cell(sheet, r, loc).querySelector("button.mp-btn");
const inputAt = (sheet, r, loc) => cell(sheet, r, loc).querySelector("input.mc");
const sheetEl = () => document.querySelector(".mpsheet");
const btn = (scope, re) => [...scope.querySelectorAll("button")].find((b) => re.test(b.textContent.trim()));
const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const tap = async (el, ms = 40) => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); await settle(ms); };

await test("until the server merges meter photos there is no camera; one check switches it on for good", async () => {
  probeAnswer = { meterPhotos: [{ id: "meter-probe" }] };   // 0022: the sweep left the tombstoned test photo
  let sheet = await render(job());
  assert.equal(probes, 1);
  assert.equal(badge(sheet, 1, 0).hidden, true);
  assert.match(sheet.querySelector(".mp-gate").textContent, /switch on after this feature's database update is applied/);
  assert.equal(localStorage.getItem("roybal-meter-ready"), null);
  probeAnswer = { meterPhotos: [] };                         // 0024 applied
  sheet = await render(job());
  assert.equal(probes, 2);
  assert.equal(sheet.querySelector(".mp-gate").hidden, true);
  assert.equal(badge(sheet, 1, 0).hidden, false, "the grid redraws with the camera once the answer comes back");
  assert.equal(localStorage.getItem("roybal-meter-ready"), "1");
  await render(job());
  assert.equal(probes, 2, "asked once per device, not on every open");
});

await test("today's readings carry a faded 📷; an older date shows none; nothing prints a P yet", async () => {
  const sheet = await render(job());
  for (let loc = 0; loc < 13; loc++) {
    const b = badge(sheet, 1, loc);
    assert.ok(b.classList.contains("mp-none") && b.classList.contains("app-only") && !b.hidden);
    assert.equal(badge(sheet, 0, loc).hidden, true, "a meter photo belongs to the moment of its reading");
    assert.equal(cell(sheet, 1, loc).querySelector("sup.mp-p").hidden, true);
  }
  assert.equal(sheet.querySelector(".mp-print").children.length, 0);
  assert.equal(sheet.querySelector(".mp-banner").hidden, true);
});

await test("with no signal the photo is saved first, tagged with this phone, and waits", async () => {
  const p = job();
  const sheet = await render(p);
  online = false;
  await tap(badge(sheet, 1, 2));
  assert.equal(p.meterPhotos.length, 1);
  const ph = p.meterPhotos[0];
  assert.equal(ph.src, JPEG);
  assert.equal(ph.loc, 2);
  assert.equal(ph.mapId, "map1");
  assert.equal(ph.rowKey, "r1");
  assert.equal(ph.dev, deviceTag());
  assert.equal(ph.read, null);
  assert.ok(badge(sheet, 1, 2).classList.contains("mp-photo"), "before the reader has filled anything, a waiting photo is just a kept photo");
  assert.match(toastText(), /Meter photo saved with this reading/);
  assert.equal(asks.length, 0);
  assert.equal((await Store.get(p.id)).meterPhotos.length, 1, "on the device before any read");
  assert.deepEqual(JSON.parse(localStorage.getItem("roybal-meter-jobs")), [p.id]);
  assert.equal(cell(sheet, 1, 2).querySelector("sup.mp-p").hidden, false);
});

await test("a sync completing with signal reads it; fill mode fills the empty cell amber until confirmed", async () => {
  const p = current, sheet = view.firstElementChild;
  online = true;
  replies = [fillReply("17.4")];
  readAllWaitingMeters();
  await settle(80);
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].hint, { meter: "Tramex MEX5", material: "Drywall / Gypsum", photoId: p.meterPhotos[0].id, mapId: "map1", rowKey: "r1", loc: 2 });
  assert.equal(p.moistureMaps[0].readings[1].values[2], "17.4");
  assert.equal(inputAt(sheet, 1, 2).value, "17.4");
  assert.ok(cell(sheet, 1, 2).classList.contains("mp-fill"));
  assert.equal(badge(sheet, 1, 2).textContent, "?");
  assert.equal(cell(sheet, 1, 2).querySelector("sup.mp-p").textContent, "P?");
  assert.equal(sheet.querySelector(".mp-banner").hidden, false);
  assert.match(sheet.querySelector(".mp-banner").textContent, /1 number was read from a meter photo/);
  assert.equal((await Store.get(p.id)).meterPhotos[0].read.value, "17.4", "saved straight to the device");
  assert.equal(localStorage.getItem("roybal-meter-jobs"), "[]");
  await tap(badge(sheet, 1, 2));
  assert.match(sheetEl().textContent, /Location 3/);
  assert.ok(sheetEl().querySelector("img.mpsheet__img"));
  await tap(btn(sheetEl(), /17\.4 is right/));
  assert.equal(sheetEl(), null);
  assert.ok(p.meterPhotos[0].ok);
  assert.equal(cell(sheet, 1, 2).classList.contains("mp-fill"), false);
  assert.equal(badge(sheet, 1, 2).textContent, "📷");
  assert.equal(sheet.querySelector(".mp-banner").hidden, true);
});

await test("a read that comes back after the tech moved to another job lands on the saved copy, not that job", async () => {
  const p = job();
  await render(p);
  online = false;
  await tap(badge(view.firstElementChild, 2, 0));
  const other = job();                                  // the tech opens another job
  await render(other);
  online = true;
  replies = [fillReply("12")];
  await readPendingMeters(p);
  assert.equal(asks.at(-1).hint.photoId, p.meterPhotos[0].id);
  const saved = await Store.get(p.id);
  assert.equal(saved.meterPhotos[0].read.value, "12");
  assert.equal(saved.moistureMaps[0].readings[2].values[0], "12");
  assert.equal(other.meterPhotos, undefined, "the job on screen is untouched");
  assert.equal((await Store.get(other.id)).meterPhotos, undefined);
});

await test("another phone's photo is never read here", async () => {
  const p = job();
  p.meterPhotos = [{ id: "theirs", by: "x", ts: "2026-10-09T10:00:00.000Z", dev: "another-phone", mapId: "map1", rowKey: "r1", loc: 4, date: TODAY, src: JPEG, read: null, filled: "", ok: "" }];
  const sheet = await render(p);
  online = true;
  const before = asks.length;
  readWaitingMeters(p);
  await readPendingMeters(p);
  assert.equal(asks.length, before);
  assert.equal(badge(sheet, 1, 4).textContent, "📷", "a photo this phone won't read just shows as kept");
  assert.equal(pendingReads(p, deviceTag()).length, 0);
});

await test("a typed value is never overwritten: a different read shows ≠ and the tech picks", async () => {
  const p = job();
  const sheet = await render(p);
  typeInto(inputAt(sheet, 1, 0), "16.9");
  online = true;
  replies = [fillReply("18.2")];
  await tap(badge(sheet, 1, 0), 80);
  assert.equal(p.moistureMaps[0].readings[1].values[0], "16.9");
  assert.equal(badge(sheet, 1, 0).textContent, "≠");
  await tap(badge(sheet, 1, 0));
  assert.match(sheetEl().textContent, /The photo reads 18\.2; the cell says 16\.9/);
  await tap(btn(sheetEl(), /^Use 18\.2$/));
  assert.equal(p.moistureMaps[0].readings[1].values[0], "18.2");
  assert.equal(inputAt(sheet, 1, 0).value, "18.2");
  assert.equal(badge(sheet, 1, 0).textContent, "📷");
});

await test("typing over a prefill confirms the typed number", async () => {
  const p = job();
  const sheet = await render(p);
  online = true;
  replies = [fillReply("22.0")];
  await tap(badge(sheet, 2, 4), 80);
  assert.equal(badge(sheet, 2, 4).textContent, "?");
  typeInto(inputAt(sheet, 2, 4), "21");
  assert.ok(p.meterPhotos[0].ok);
  assert.equal(p.meterPhotos[0].fixed, "21");
  assert.equal(badge(sheet, 2, 4).textContent, "📷");
});

await test("check mode keeps the read on the photo and fills nothing", async () => {
  const p = job();
  const sheet = await render(p);
  online = true;
  replies = [{ ...fillReply("12.5"), fill: false }];
  await tap(badge(sheet, 1, 1), 80);
  assert.equal(p.moistureMaps[0].readings[1].values[1], "");
  assert.equal(p.meterPhotos[0].read.value, "12.5");
  assert.equal(badge(sheet, 1, 1).textContent, "📷");
  await tap(badge(sheet, 1, 1));
  assert.match(sheetEl().textContent, /Kept with this reading/);
  assert.doesNotMatch(sheetEl().textContent, /12\.5/);
  await tap(btn(sheetEl(), /^✕$/));
});

await test("no signal mid-read leaves the photo waiting and counts nothing against it", async () => {
  const p = job();
  const sheet = await render(p);
  online = true;
  replies = Array.from({ length: 6 }, () => new TypeError("Failed to fetch"));
  await tap(badge(sheet, 1, 5), 80);
  for (let i = 0; i < 5; i++) await readPendingMeters(p);
  assert.equal(pendingReads(p, deviceTag()).length, 1);
  assert.equal(JSON.parse(localStorage.getItem("roybal-meter-tries") || "{}")[p.meterPhotos[0].id], undefined);
  replies = [fillReply("9.9")];
  await readPendingMeters(p);
  assert.equal(pendingReads(p, deviceTag()).length, 0, "read once the signal is back");
  assert.equal(p.moistureMaps[0].readings[1].values[5], "9.9");
});

await test("a retake replaces the cell's photo and an unchecked prefill goes with the old one; delete keeps a typed number", async () => {
  const p = job();
  const sheet = await render(p);
  online = true;
  replies = [fillReply("31")];
  await tap(badge(sheet, 1, 6), 80);
  assert.equal(inputAt(sheet, 1, 6).value, "31");
  const first = p.meterPhotos[0].id;
  online = false;
  await tap(badge(sheet, 1, 6));
  await tap(btn(sheetEl(), /Retake/), 80);
  assert.equal(p.meterPhotos.length, 1);
  assert.notEqual(p.meterPhotos[0].id, first);
  assert.ok(p.deletedIds[first]);
  assert.equal(p.moistureMaps[0].readings[1].values[6], "", "the unchecked 31 left with its photo");
  assert.equal(inputAt(sheet, 1, 6).value, "");
  typeInto(inputAt(sheet, 1, 6), "14");
  await tap(badge(sheet, 1, 6));
  confirms.length = 0;
  confirmAnswer = true;
  await tap(btn(sheetEl(), /Delete photo/));
  assert.match(confirms[0], /The number in the cell stays/);
  assert.equal(p.meterPhotos.length, 0);
  assert.equal(p.moistureMaps[0].readings[1].values[6], "14");
  assert.ok(badge(sheet, 1, 6).classList.contains("mp-none"));
});

await test("deleting a reading date asks, then takes its photos along with tombstones", async () => {
  const p = job();
  const sheet = await render(p);
  online = false;
  await tap(badge(sheet, 2, 0));
  await tap(badge(sheet, 2, 1));
  const ids = p.meterPhotos.map((x) => x.id);
  confirms.length = 0;
  confirmAnswer = false;
  const del = () => grid(view.firstElementChild).querySelector("tbody").children[2].querySelector("button.rowdel");
  await tap(del());
  assert.match(confirms[0], /This date has 2 meter photos/);
  assert.equal(p.moistureMaps[0].readings.length, 3, "kept when the tech says no");
  confirmAnswer = true;
  await tap(del());
  assert.equal(p.moistureMaps[0].readings.length, 2);
  assert.equal(p.meterPhotos.length, 0);
  for (const id of ids) assert.ok(p.deletedIds[id]);
});

await test("on paper: a P on the reading (P? while unchecked) and the photos after the grid", async () => {
  const p = job();
  const sheet = await render(p);
  online = true;
  typeInto(inputAt(sheet, 1, 0), "30");
  replies = [fillReply("30")];               // reads what was typed: a plain kept photo
  await tap(badge(sheet, 1, 0), 80);
  replies = [fillReply("19")];               // fills an empty cell: unchecked
  await tap(badge(sheet, 2, 3), 80);
  const pr = sheet.querySelector(".mp-print");
  assert.ok(pr.classList.contains("print-only"));
  assert.match(pr.textContent, /P = this reading has a photo of the meter screen/);
  assert.match(pr.textContent, /P\? = the app read this number from the photo and the tech has not checked it yet/);
  const figs = [...pr.querySelectorAll("figure")];
  assert.equal(figs.length, 2);
  assert.match(figs[0].textContent, new RegExp(`^Loc 1 · ${label(TODAY)} · 30 · `));
  assert.doesNotMatch(figs[0].textContent, /not checked/);
  assert.match(figs[1].textContent, new RegExp(`^Loc 4 · ${label(TODAY)} · 19 · .* · not checked$`));
  assert.equal(figs[0].querySelector("img").getAttribute("src"), JPEG);
  assert.equal(cell(sheet, 1, 0).querySelector("sup.mp-p").textContent, "P");
  assert.equal(cell(sheet, 2, 3).querySelector("sup.mp-p").textContent, "P?");
});

await test("the Certificate of Drying shows each location's final reading with its photo, and flags an unchecked one", async () => {
  const p = job();
  const sheet = await render(p);
  online = false;
  typeInto(inputAt(sheet, 0, 0), "30");
  typeInto(inputAt(sheet, 2, 0), "11");
  await tap(badge(sheet, 2, 0));
  const sec = certDrying(p, newCertDrying()).querySelector(".mp-cert");
  assert.ok(sec, "the section renders when a final reading has a photo");
  assert.match(sec.textContent, /Final Readings with Meter Photos/);
  assert.match(sec.querySelector("figcaption").textContent, new RegExp(`Kitchen · Loc 1 · ${label(TODAY)} · 11$`));
  assert.equal(sec.querySelector(".mp-banner"), null);
  view.replaceChildren(sec);
  await tap(sec.querySelector("figure"));
  assert.ok(sheetEl());
  assert.equal(btn(sheetEl(), /Delete photo|Retake/), undefined, "the certificate's view is read-only");
  await tap(btn(sheetEl(), /^Close$/));
  assert.equal(certDrying(job(), newCertDrying()).querySelector(".mp-cert"), null, "old certificates are unchanged");
  // an unchecked final number is flagged on screen and on paper
  const q = job();
  const qs = await render(q);
  online = true;
  replies = [fillReply("8")];
  await tap(badge(qs, 2, 1), 80);
  const qsec = certDrying(q, newCertDrying()).querySelector(".mp-cert");
  assert.match(qsec.querySelector("figcaption").textContent, /· 8 · not checked$/);
  assert.match(qsec.querySelector(".mp-banner").textContent, /Check it on the Moisture Map before this certificate goes out for signature/);
});

await test("a sync that grafts another device's rows in redraws the grid, and waits while a cell is being typed in", async () => {
  const p = job();
  const sheet = await render(p);
  const fresh = JSON.parse(JSON.stringify(p));
  fresh.moistureMaps[0].readings.push(blankRow("r3", TODAY));
  fresh.moistureMaps[0].readings[1].values[7] = "44";
  const typing = inputAt(sheet, 1, 0);
  typing.focus();
  graftProject(p, fresh);
  document.dispatchEvent(new CustomEvent("roybal:grafted", { detail: { id: p.id } }));
  await settle();
  assert.equal(grid(sheet).querySelector("tbody").children.length, 3, "not while the tech is typing");
  typeInto(typing, "5");
  assert.equal(p.moistureMaps[0].readings[1].values[0], "5", "the row kept by its rk still takes the keystrokes");
  typing.blur();
  typing.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  await settle();
  assert.equal(grid(sheet).querySelector("tbody").children.length, 4);
  assert.equal(inputAt(sheet, 1, 7).value, "44");
  assert.equal(inputAt(sheet, 1, 0).value, "5");
});

await test("a photo taken while a sync grafted the job lands on the reading, not a detached copy", async () => {
  const p = job();
  const sheet = await render(p);
  online = false;
  let release;
  meterDeps.pick = () => new Promise((r) => { release = () => r({ name: "m.jpg", type: "image/jpeg" }); });
  await tap(badge(sheet, 1, 9));
  const fresh = JSON.parse(JSON.stringify(p));
  fresh.moistureMaps[0].readings[1].notes = "from the office";
  graftProject(p, fresh);                              // while the camera is open
  release();
  await settle(60);
  meterDeps.pick = async () => ({ name: "meter.jpg", type: "image/jpeg" });
  assert.equal(p.meterPhotos.length, 1);
  assert.equal(p.meterPhotos[0].rowKey, "r1");
  assert.equal(badge(sheet, 1, 9).textContent, "⏳", "the reader has been filling numbers, so the photo shows it waits for one");
  assert.match(toastText(), /The number fills in when you're back online/);
});

await test("readMeter: a capped month and an older function come back as answers, no signal as a TypeError", async () => {
  fetcher = async () => new Response(JSON.stringify({ ok: true, capped: true, spend: { cap_usd: 50 } }), { status: 200 });
  assert.deepEqual(await readMeter(null, JPEG, { photoId: "x" }), { capped: true });
  fetcher = async () => new Response(JSON.stringify({ ok: false, error: "Unknown action. Expected one of: photoAnalysis" }), { status: 400 });
  assert.deepEqual(await readMeter(null, JPEG), { missing: true });
  fetcher = async () => new Response(JSON.stringify({ ok: false, error: "Couldn't read that photo as an image." }), { status: 500 });
  await assert.rejects(readMeter(null, JPEG), (e) => e.status === 500);
  fetcher = async () => { throw new TypeError("network down"); };
  await assert.rejects(readMeter(null, JPEG), TypeError);
  let sent = null;
  fetcher = async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ ok: true, meter: { value: "7" }, fill: false }), { status: 200 }); };
  const r = await readMeter(null, JPEG, { meter: "Tramex", material: "Drywall", photoId: "p1", mapId: "m1", rowKey: "r1", loc: 2 });
  assert.equal(r.meter.value, "7");
  assert.deepEqual([sent.action, sent.photoId, sent.mapId, sent.rowKey, sent.loc], ["meterRead", "p1", "m1", "r1", 2]);
  fetcher = async () => { throw new TypeError("network down"); };
});

await test("a capped month stops the reader for the session: nothing more is asked, the photos wait", async () => {
  const p = job();
  const sheet = await render(p);
  online = false;
  await tap(badge(sheet, 1, 0));
  await tap(badge(sheet, 1, 1));
  online = true;
  replies = [{ capped: true }];
  const before = asks.length;
  await readPendingMeters(p);
  assert.equal(asks.length, before + 1);
  assert.equal(pendingReads(p, deviceTag()).length, 2, "nothing stamped: read after the month resets");
  replies = [fillReply("1"), fillReply("2")];
  await readPendingMeters(p);
  readAllWaitingMeters();
  await settle(60);
  assert.equal(asks.length, before + 1, "asked no more until the app reloads");
});

await flushPending();
console.log(`\n${pass} checks passed.`);
process.exit(0);
