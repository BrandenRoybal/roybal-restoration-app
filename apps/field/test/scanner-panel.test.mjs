/* 📷 Scan equipment overlay (apps/field/js/scanner.js, jsdom): the camera and
   the decoder are stubbed (deps.loadDecoder, navigator.mediaDevices), the
   scan decisions are the real scans.js. Covers: no camera → the photo / type
   fallback; a typed tag lands in the chosen room as a scanned drying-log row;
   Remove mode; Undo voids; the type pick for a plain-number tag; a live
   camera read with the 3 s repeat guard, torch and room photo; the photo of
   the label; a unit still out on another job; and location.hash never moves
   while the overlay is open. Last, the REAL vendored decoder reads a label
   made by the app's own QR encoder through the scanner's wasm path.
   Run: node apps/field/test/scanner-panel.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/#/p/job-a/f/dryingLogs", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage", "sessionStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");
window.localStorage.setItem("roybal-tech", JSON.stringify({ id: null, name: "Test Tech" }));
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

// no test may reach a server; the one real-decoder case reads the wasm from disk
globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.startsWith("file:")) return new Response(readFileSync(fileURLToPath(s)), { headers: { "Content-Type": "application/wasm" } });
  throw new Error("no network in tests: " + s);
};

/* ---------- camera + canvas stubs ---------- */
const media = window.HTMLMediaElement.prototype;
let cameraPlays = true;
media.play = function () {
  if (cameraPlays && this.srcObject) setTimeout(() => this.dispatchEvent(new window.Event("playing")), 1);
  return Promise.resolve();
};
media.pause = function () {};
Object.defineProperty(media, "readyState", { configurable: true, get() { return this.srcObject ? 4 : 0; } });
Object.defineProperty(window.HTMLVideoElement.prototype, "videoWidth", { configurable: true, get() { return this.srcObject ? 1280 : 0; } });
Object.defineProperty(window.HTMLVideoElement.prototype, "videoHeight", { configurable: true, get() { return this.srcObject ? 720 : 0; } });
const drawn = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage: (...a) => drawn.push(a.slice(1)),
    getImageData: (x, y, w, hh) => ({ data: new Uint8ClampedArray(w * hh * 4), width: w, height: hh }),
  };
};
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";

let gumCalls = 0;
const streams = [];
function fakeStream({ torch = false } = {}) {
  const track = {
    stopped: false, constraints: [],
    stop() { this.stopped = true; },
    getCapabilities: () => (torch ? { torch: true } : {}),
    applyConstraints(c) { this.constraints.push(c); return Promise.resolve(); },
    addEventListener() {},
  };
  const s = { track, getTracks: () => [track], getVideoTracks: () => [track] };
  streams.push(s);
  return s;
}
function setCamera(impl) {
  Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: impl ? { getUserMedia: (c) => { gumCalls++; return impl(c); } } : undefined });
}

/* ---------- decoder stub ---------- */
const frames = [];            // texts the next camera frames "contain"
let photoText = "";           // what a photo of a label decodes to
const fakeZ = {
  prepared: [], reads: [],
  async prepareZXingModule(o) { this.prepared.push(o); return {}; },
  async readBarcodes(input, opts) {
    this.reads.push({ input, opts });
    if (input instanceof Blob) return photoText ? [{ text: photoText }] : [];
    const t = frames.shift();
    return t ? [{ text: t }] : [];
  },
  purgeZXingModule() {},
};

const { openScanner, deps } = await import("../js/scanner.js");
const { BUILD } = await import("../js/config.js");
let nowMs = 1_000_000;
deps.now = () => nowMs;
deps.startMs = 80;
deps.tickMs = 5;
deps.refreshFleet = async () => ({ ok: false, units: [], missing: false });

/* ---------- helpers ---------- */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (cond()) return true; await settle(5); }
  return cond();
}
const ov = () => document.querySelector(".sc");
const sheet = () => document.querySelector(".sc-sheet");
const btn = (label, root = document) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const tap = (el) => { assert.ok(el, "button exists"); el.click(); };
// every card read also checks that no empty slot ever prints as the word "null"
const cardText = () => {
  const t = (document.querySelector(".sc-card") || {}).textContent || "";
  assert.ok(!/\bnull\b|undefined/.test(t), "card prints null/undefined: " + t);
  return t;
};
const countText = () => document.querySelector(".sc-count").textContent;
async function typeTag(text) {
  tap(btn("⌨ Type tag"));
  const input = sheet().querySelector(".sc-input");
  input.value = text;
  tap(btn("Use", sheet()));
  await settle(5);
}
const roomPref = (id, room) => { if (room == null) sessionStorage.removeItem("roybal-scan-room:" + id); else sessionStorage.setItem("roybal-scan-room:" + id, room); };

const blankRow = () => ({ asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" });
const job = (id = "job-a", extra = {}) => ({
  id, customer: "Test Owner", address: "1 Test Way", rooms: ["Kitchen", "Hall"], photos: [], equipmentScans: [],
  dryingLogs: [{ id: "log-1", by: "", createdAt: "2026-10-01T00:00:00.000Z", dryoutStart: "", dryoutFinish: "", techSupervisor: "",
    equipment: [blankRow()], readings: [] }],
  ...extra,
});
const live = (p) => {
  const voided = new Set(p.equipmentScans.filter((e) => e.act === "void").map((e) => e.voids));
  return p.equipmentScans.filter((e) => e.act !== "void" && !voided.has(e.id));
};

// location.hash must never move while the overlay is open (iOS standalone kills the camera)
const startHash = location.hash;
let hashChanges = 0;
window.addEventListener("hashchange", () => { hashChanges++; });
for (const k of ["pushState", "replaceState"]) {
  const orig = window.history[k].bind(window.history);
  window.history[k] = (...a) => { hashChanges++; return orig(...a); };
}
const hashUntouched = () => { assert.equal(location.hash, startHash); assert.equal(hashChanges, 0, "no hash / history change"); };

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Scan equipment overlay (DOM)");

/* ---------- 1. the decoder can't load: type the tag still works ---------- */
await test("a device that can't load the decoder gets 'type the tag' (no photo option) and can still log", async () => {
  deps.loadDecoder = async () => { throw new Error("no wasm here"); };
  setCamera(async () => fakeStream());
  roomPref("job-a", "Kitchen");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  const fb = ov().querySelector(".sc-fallback");
  assert.match(fb.textContent, /The scanner couldn't load on this device\./);
  assert.ok(btn("📷 Photo of the label").hidden, "a photo needs the decoder too");
  assert.ok(!btn("⌨ Type the tag").hidden);
  assert.ok(streams[streams.length - 1].track.stopped, "the camera is released");
  await typeTag("AM-7");
  assert.equal(live(p).length, 1);
  tap(btn("Done"));
  await done;
  assert.equal(ov(), null);
  hashUntouched();
});

deps.loadDecoder = async () => fakeZ;

/* ---------- 2. no camera → fallback; typed tag → scanned row ---------- */
await test("no getUserMedia → 'Camera didn't start.' with Photo of the label and Type the tag", async () => {
  setCamera(null);
  roomPref("job-a", "Kitchen");
  const p = job();
  let saves = 0;
  const done = openScanner(p, { onChange: (pp) => { assert.equal(pp, p); saves++; } });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  const fb = ov().querySelector(".sc-fallback");
  assert.match(fb.textContent, /Camera didn't start\./);
  assert.ok(!btn("📷 Photo of the label", fb).hidden);
  assert.ok(!btn("⌨ Type the tag", fb).hidden);
  assert.ok(btn("Try the camera again", fb).hidden, "no camera API: nothing to retry");
  assert.equal(ov().querySelector(".sc-room").textContent, "Room: Kitchen ▾");

  // typing a non-tag says so and logs nothing
  tap(btn("⌨ Type the tag", fb));
  sheet().querySelector(".sc-input").value = "hello";
  tap(btn("Use", sheet()));
  assert.match(sheet().textContent, /That isn't a tag \(example AM-014\)/);
  tap(btn("Cancel", sheet()));
  assert.equal(p.equipmentScans.length, 0);

  await typeTag("am 14");
  const [ev] = p.equipmentScans;
  assert.equal(p.equipmentScans.length, 1);
  assert.equal(ev.tag, "AM-014"); assert.equal(ev.act, "place"); assert.equal(ev.room, "Kitchen");
  assert.equal(ev.how, "typed"); assert.equal(ev.tech, "Test Tech"); assert.equal(ev.build, BUILD);
  assert.equal(ev.logId, "log-1"); assert.ok(ev.id && ev.at.endsWith("Z"));
  const rows = p.dryingLogs[0].equipment;
  assert.equal(rows.length, 1, "the factory-blank row was replaced");
  assert.equal(rows[0].scanId, ev.id); assert.equal(rows[0].asset, "AM-014");
  assert.equal(rows[0].location, "Kitchen"); assert.equal(rows[0].type, "Air mover");
  assert.ok(rows[0].placed, "placed time filled in");
  assert.match(cardText(), /AM-014.*Kitchen/);
  assert.equal(countText(), "Placed 1 · Moved 0 · Removed 0");
  assert.equal(saves, 1, "onChange after the scan");

  // Undo on the card voids the event; the row goes; the record keeps both
  tap(btn("Undo", document.querySelector(".sc-card")));
  assert.equal(p.equipmentScans.length, 2);
  assert.equal(p.equipmentScans[1].act, "void"); assert.equal(p.equipmentScans[1].voids, ev.id);
  assert.equal(p.dryingLogs[0].equipment.filter((r) => r.scanId).length, 0);
  assert.match(cardText(), /^Undone: /);
  assert.equal(countText(), "Placed 0 · Moved 0 · Removed 0");
  assert.equal(saves, 2);
  hashUntouched();
  tap(btn("Done"));
  await done;
  assert.equal(ov(), null);
});

/* ---------- 3. Remove mode, a move, not-here ---------- */
await test("Remove mode pulls a unit (sticky), a unit scanned in another room moves, an absent unit is 'not here'", async () => {
  setCamera(null);
  window.localStorage.removeItem("roybal-scan-mode");
  roomPref("job-a", "Kitchen");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await typeTag("AM-020");
  await typeTag("DH-002");
  assert.equal(live(p).length, 2);

  // change room → scan again → a move on the same row
  tap(ov().querySelector(".sc-room"));
  assert.match(sheet().textContent, /Which room\?/);
  tap(btn("Hall", sheet()));
  assert.equal(ov().querySelector(".sc-room").textContent, "Room: Hall ▾");
  assert.equal(sessionStorage.getItem("roybal-scan-room:job-a"), "Hall");
  await typeTag("AM-020");
  const mv = p.equipmentScans[p.equipmentScans.length - 1];
  assert.equal(mv.act, "move"); assert.equal(mv.room, "Hall");
  const am = p.dryingLogs[0].equipment.filter((r) => r.asset === "AM-020");
  assert.equal(am.length, 1, "a move keeps its one row");
  assert.match(am[0].notes, /moved to Hall/);
  assert.equal(countText(), "Placed 2 · Moved 1 · Removed 0");

  // the same room again is 'already' (amber), nothing logged
  const n = p.equipmentScans.length;
  await typeTag("AM-020");
  assert.equal(p.equipmentScans.length, n);
  assert.ok(document.querySelector(".sc-card").classList.contains("sc-card--warn"));

  tap(btn("Remove"));
  assert.equal(window.localStorage.getItem("roybal-scan-mode"), "remove");
  assert.ok(ov().classList.contains("sc--remove"));
  await typeTag("DH-002");
  const rm = p.equipmentScans[p.equipmentScans.length - 1];
  assert.equal(rm.act, "remove"); assert.equal(rm.room, "Kitchen", "the room it was in");
  const dh = p.dryingLogs[0].equipment.find((r) => r.asset === "DH-002");
  assert.ok(dh.removed, "removed time filled in");
  assert.equal(countText(), "Placed 2 · Moved 1 · Removed 1");

  await typeTag("HT-009");
  assert.match(cardText(), /^HT-009 isn't out on this job$/);
  assert.ok(document.querySelector(".sc-card").classList.contains("sc-card--warn"));
  tap(btn("Done"));
  await done;

  // the mode is remembered for the next open
  const p2 = job();
  const d2 = openScanner(p2, { onChange: () => {} });
  await until(() => ov());
  assert.equal(btn("Remove").getAttribute("aria-pressed"), "true");
  tap(btn("Place"));
  tap(btn("Done"));
  await d2;
  hashUntouched();
});

/* ---------- 4. need_type ---------- */
await test("a plain-number tag with no fleet entry asks for the type with four big buttons, then logs it", async () => {
  setCamera(null);
  roomPref("job-a", "Kitchen");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await typeTag("101");
  assert.equal(p.equipmentScans.length, 0);
  assert.match(sheet().textContent, /What is 101\?/);
  for (const l of ["Air mover", "Dehumidifier", "Air scrubber", "Heater"]) assert.ok(btn(l, sheet()), l);
  tap(btn("Dehumidifier", sheet()));
  assert.equal(sheet(), null);
  const [ev] = p.equipmentScans;
  assert.equal(ev.tag, "101"); assert.equal(ev.type, "Dehumidifier");
  assert.equal(p.dryingLogs[0].equipment[0].type, "Dehumidifier");
  tap(btn("Done"));
  await done;
  hashUntouched();
});

await test("a plain-number tag the fleet list knows logs straight away with its type and model", async () => {
  setCamera(null);
  roomPref("job-a", "Kitchen");
  deps.refreshFleet = async () => ({ ok: true, units: [{ id: "u1", tag: "102", type: "heater", make: "Acme", model: "H1", rating: "", owned: "owned", status: "active" }] });
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await settle();                                   // the fleet list refreshes in the background
  await typeTag("102");
  assert.equal(sheet(), null, "no type question");
  const [ev] = p.equipmentScans;
  assert.equal(ev.type, "Heater");
  assert.match(ev.model, /Acme/);
  tap(btn("Done"));
  await done;
  deps.refreshFleet = async () => ({ ok: false, units: [], missing: false });
});

/* ---------- 5. a job with no drying log ---------- */
await test("a job with no drying log gets one with only the scanned row; a cancelled type pick leaves none behind", async () => {
  setCamera(null);
  roomPref("job-n", "Basement");
  const p = job("job-n", { dryingLogs: [] });
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await typeTag("55");
  tap(btn("Cancel", sheet()));
  assert.equal(p.dryingLogs.length, 0, "no empty log left by an abandoned scan");
  await typeTag("AF-003");
  assert.equal(p.dryingLogs.length, 1);
  assert.deepEqual(p.dryingLogs[0].equipment.map((r) => r.asset), ["AF-003"]);
  assert.equal(p.equipmentScans[0].logId, p.dryingLogs[0].id);
  tap(btn("Done"));
  await done;
});

/* ---------- 6. Place mode with no room asks for the room first ---------- */
await test("Place mode with no room opens the room sheet with the job's rooms, and a typed room works", async () => {
  setCamera(null);
  roomPref("job-r", null);
  const p = job("job-r");
  const done = openScanner(p, { onChange: () => {} });
  await until(() => sheet());
  assert.match(sheet().textContent, /Which room\?/);
  assert.ok(btn("Kitchen", sheet()) && btn("Hall", sheet()));
  sheet().querySelector(".sc-input").value = "  Primary bath ";
  tap(btn("Use", sheet()));
  assert.equal(ov().querySelector(".sc-room").textContent, "Room: Primary bath ▾");
  assert.equal(sessionStorage.getItem("roybal-scan-room:job-r"), "Primary bath");
  tap(btn("Done"));
  await done;
});

/* ---------- 7. live camera ---------- */
await test("live camera: a label read logs once (3 s repeat guard), torch toggles, room photo is captioned, Done releases the camera", async () => {
  cameraPlays = true;
  let constraints = null;
  setCamera(async (c) => { constraints = c; return fakeStream({ torch: true }); });
  roomPref("job-a", "Kitchen");
  const p = job();
  let saves = 0;
  const done = openScanner(p, { onChange: () => { saves++; } });
  await until(() => ov() && !ov().querySelector(".sc-torch").hidden);
  assert.deepEqual(constraints, { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  const v = ov().querySelector("video");
  for (const a of ["playsinline", "muted", "autoplay"]) assert.ok(v.hasAttribute(a), a);
  assert.match(ov().querySelector(".sc-status").textContent, /Point at a label/);

  // the decoder was prepared with the vendored wasm, never a CDN
  const o = fakeZ.prepared[fakeZ.prepared.length - 1];
  assert.equal(o.fireImmediately, true);
  const wasmUrl = o.overrides.locateFile("zxing_reader.wasm", "https://cdn.example/");
  assert.match(wasmUrl, /^file:.*\/apps\/field\/assets\/vendor\/zxing\/zxing_reader\.wasm$/);
  assert.ok(existsSync(fileURLToPath(wasmUrl)), "the vendored wasm is where the scanner looks");
  assert.equal(o.overrides.locateFile("x.data", "p/"), "p/x.data");

  frames.push("RC:AM-014", "RC:AM-014", "RC:AM-014");
  await until(() => p.equipmentScans.length === 1 && frames.length === 0);
  await settle(30);
  assert.equal(p.equipmentScans.length, 1, "the same label in view is logged once");
  assert.equal(p.equipmentScans[0].how, "camera");
  assert.equal(saves, 1);
  const read = fakeZ.reads[fakeZ.reads.length - 1];
  assert.deepEqual(read.opts, { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 });
  assert.equal(read.input.width, 720); assert.equal(read.input.height, 720);
  assert.deepEqual(drawn[drawn.length - 1], [280, 0, 720, 720, 0, 0, 720, 720], "the centre square of a 1280×720 frame");

  nowMs += 3500;                                   // past the guard: seen again → 'already', nothing new
  frames.push("RC:AM-014");
  await until(() => frames.length === 0);
  await settle(20);
  assert.equal(p.equipmentScans.length, 1);
  assert.match(cardText(), /already in Kitchen/);

  frames.push("RC:DH-002");
  await until(() => p.equipmentScans.length === 2);
  // Undo while the label is still in view: it is not logged straight back
  tap(btn("Undo", document.querySelector(".sc-card")));
  assert.equal(live(p).length, 1);
  frames.push("RC:DH-002");
  await until(() => frames.length === 0);
  await settle(20);
  assert.equal(live(p).length, 1, "the undone label in view stays undone");
  nowMs += 3500;
  frames.push("RC:DH-002");
  await until(() => live(p).length === 2);
  frames.push("HELLO WORLD");
  await until(() => /isn't an equipment label/.test(cardText()));

  tap(ov().querySelector(".sc-torch"));
  await settle(5);
  const tr = streams[streams.length - 1].track;
  assert.deepEqual(tr.constraints, [{ advanced: [{ torch: true }] }]);
  assert.equal(ov().querySelector(".sc-torch").getAttribute("aria-pressed"), "true");

  tap(btn("📸 Room photo"));
  assert.equal(p.photos.length, 1);
  const ph = p.photos[0];
  assert.equal(ph.caption, "Equipment - Kitchen - AM-014, DH-002");
  assert.equal(ph.room, "Kitchen"); assert.equal(ph.stage, "during");
  assert.match(ph.src, /^data:image\/jpeg/);
  assert.ok(ph.id);

  // pagehide stops the camera; coming back starts it again
  const before = gumCalls;
  window.dispatchEvent(new window.Event("pagehide"));
  assert.ok(tr.stopped);
  window.dispatchEvent(new window.Event("pageshow"));
  await until(() => gumCalls === before + 1 && !ov().querySelector(".sc-torch").hidden);
  tap(btn("Done"));
  await done;
  assert.ok(streams.every((s) => s.track.stopped), "every track stopped");
  assert.equal(ov(), null);
  assert.match(document.getElementById("toast").textContent, /Placed 2/);
  hashUntouched();
});

await test("a camera that never starts playing falls back after the wait, and the stream is released", async () => {
  cameraPlays = false;
  setCamera(async () => fakeStream());
  roomPref("job-a", "Kitchen");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  assert.match(ov().querySelector(".sc-fallback").textContent, /Camera didn't start\./);
  assert.ok(streams[streams.length - 1].track.stopped);
  cameraPlays = true;
  tap(btn("Try the camera again"));
  await until(() => ov().querySelector(".sc-fallback").hidden && /Point at a label/.test(ov().querySelector(".sc-status").textContent));
  tap(btn("Done"));
  await done;
});

/* ---------- 8. photo of the label ---------- */
await test("📷 Photo of the label decodes the still and logs it as a photo read", async () => {
  setCamera(async () => { throw new Error("NotAllowedError"); });
  roomPref("job-a", "Kitchen");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  const input = [...ov().querySelectorAll("input[type=file]")][0];
  assert.equal(input.getAttribute("capture"), "environment");
  assert.equal(input.getAttribute("accept"), "image/*");
  photoText = "RC:HT-101";
  const file = new File([new Uint8Array(64)], "IMG_0001.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change"));
  await until(() => p.equipmentScans.length === 1);
  assert.equal(p.equipmentScans[0].tag, "HT-101"); assert.equal(p.equipmentScans[0].how, "photo");
  assert.equal(p.equipmentScans[0].type, "Heater");
  assert.equal(fakeZ.reads[fakeZ.reads.length - 1].input, file);

  photoText = "";
  input.dispatchEvent(new window.Event("change"));
  await until(() => /No label found/.test(cardText()));
  assert.equal(p.equipmentScans.length, 1);
  photoText = "";
  tap(btn("Done"));
  await done;
});

/* ---------- 9. a unit still out on another job ---------- */
await test("a unit still open on another job logs here with an amber note naming that job", async () => {
  setCamera(null);
  roomPref("job-a", "Kitchen");
  const other = job("job-b", { customer: "Other Owner", address: "9 Elm St" });
  other.dryingLogs[0].equipment = [{ ...blankRow(), asset: "AM-14", type: "Air mover", location: "Den", placed: "2026-10-01T09:00" }];
  const p = job();
  const done = openScanner(p, { onChange: () => {}, otherProjects: () => Promise.resolve([p, other]) });
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await settle();                                   // the job list arrives in the background
  await typeTag("AM-014");
  const [ev] = p.equipmentScans;
  assert.equal(ev.act, "place");
  assert.equal(ev.elsewhere && ev.elsewhere.jobId, "job-b");
  assert.ok(document.querySelector(".sc-card").classList.contains("sc-card--warn"));
  assert.match(cardText(), /Other Owner/);
  assert.match(cardText(), /the office will see both/);
  tap(btn("Done"));
  await done;
});

/* ---------- 10. who's scanning ---------- */
await test("with no tech chosen on this device the picker comes first, and the scan carries the typed name", async () => {
  setCamera(null);
  roomPref("job-a", "Kitchen");
  window.localStorage.removeItem("roybal-tech");
  const p = job();
  const done = openScanner(p, { onChange: () => {} });
  await until(() => /Who's capturing\?/.test(document.body.textContent));
  assert.equal(ov(), null, "the overlay waits for the pick");
  const nameIn = [...document.querySelectorAll("input")].find((i) => i.placeholder === "Or type a name");
  nameIn.value = "Sam Example";
  tap(btn("Use name"));
  await until(() => ov() && !ov().querySelector(".sc-fallback").hidden);
  await typeTag("AM-031");
  assert.equal(p.equipmentScans[0].tech, "Sam Example");
  tap(btn("Done"));
  await done;
});

/* ---------- 11. one overlay, and a hash change from elsewhere closes it ---------- */
await test("a double tap opens one overlay; a hash change from elsewhere closes it and releases the camera", async () => {
  cameraPlays = true;
  setCamera(async () => fakeStream());
  roomPref("job-a", "Kitchen");
  const p = job();
  const a = openScanner(p, { onChange: () => {} });
  const b = openScanner(p, { onChange: () => {} });
  await until(() => ov() && /Point at a label/.test(ov().querySelector(".sc-status").textContent));
  assert.equal(document.querySelectorAll(".sc").length, 1);
  window.dispatchEvent(new window.HashChangeEvent("hashchange"));   // a back swipe, simulated
  hashChanges--;                                                    // that one was ours
  await Promise.all([a, b]);
  assert.equal(ov(), null);
  assert.ok(streams[streams.length - 1].track.stopped);
  hashUntouched();
});

/* ---------- 12. the real vendored decoder ---------- */
await test("the vendored zxing reader decodes an RC:AM-014 label (ECC Q) from the app's own encoder, via the scanner's wasm path", async () => {
  assert.equal(fakeZ.prepared.length, 1, "prepared once per page load, however many times the scanner opened");
  const z = await import(new URL("../assets/vendor/zxing/reader/index.js", import.meta.url).href);
  const overrides = fakeZ.prepared[0].overrides;                    // exactly what scanner.js passes
  await z.prepareZXingModule({ overrides, fireImmediately: true });
  // every frame after that must not need Object.hasOwn (Safari before 15.4)
  const realHasOwn = Object.hasOwn;
  Object.hasOwn = () => { throw new TypeError("Object.hasOwn is not a function"); };
  const qrcode = (await import("../assets/vendor/qrcode/qrcode.mjs")).default;
  const q = qrcode(0, "Q"); q.addData("RC:AM-014"); q.make();
  const n = q.getModuleCount(), cell = 8, quiet = 4, W = 720, size = (n + 2 * quiet) * cell, x0 = ((W - size) / 2) | 0;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const lx = x - x0, ly = y - x0;
    let g = 140;                                                    // grey surround (the unit's housing)
    if (lx >= 0 && ly >= 0 && lx < size && ly < size) {
      const r = Math.floor(ly / cell) - quiet, c = Math.floor(lx / cell) - quiet;
      g = r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c) ? 25 : 235;
    }
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = g; data[i + 3] = 255;
  }
  let res;
  try { res = await z.readBarcodes({ data, width: W, height: W }, { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 }); }
  finally { Object.hasOwn = realHasOwn; }
  assert.equal(res.length, 1);
  assert.equal(res[0].text, "RC:AM-014");
  assert.equal(res[0].ecLevel, "Q");
  assert.equal(z.ZXING_WASM_VERSION, "3.1.4");
});

console.log(`\n${pass} passed`);
process.exit(0);
