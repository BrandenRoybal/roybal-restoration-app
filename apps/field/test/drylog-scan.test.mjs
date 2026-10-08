/* Drying Log ⇄ equipment scans (apps/field/js/forms.js dryingLog, jsdom).
   A scanned row's tag, placed time and hours are the scan's: read-only,
   marked 📷, never written by typing or by the fill handle (a scan's
   removed time too, once a scan removed the unit). ✕ on a scanned row
   undoes the scan with void events instead of deleting it. Scans another
   device made land in the table when the page opens. On paper the scanned
   times carry a superscript S and the sheet prints the scan record. The
   📷 Scan equipment button stays off until the fleet table answers, and
   the overlay's onChange saves the job and repaints the table. Also the
   small pure parts of fleet.js and qr.js's optional error correction.
   Run: node apps/field/test/drylog-scan.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "MouseEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
let confirmAnswer = true;
const confirms = [];
window.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };
globalThis.confirm = window.confirm;
// a signed-in device (made-up login), so the fleet read goes to the fake server below
window.localStorage.setItem("roybal-session", JSON.stringify({
  access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "crew@example.com" }));

/* the fake server: only the fleet table is asked for */
let fleetAnswer = () => new Response("[]", { status: 200 });
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (/\/rest\/v1\/equipment_units\?/.test(String(url))) return fleetAnswer();
  throw new TypeError("network down");
};

const { Store } = await import("../js/core.js");
const { newDryingLog, blankEquipRow } = await import("../js/model.js");
const { setCtx } = await import("../js/formkit.js");
const { dryingLog, scanDeps } = await import("../js/forms.js");
const { recordScan, scanRecord, placements } = await import("../js/scans.js");
const fleet = await import("../js/fleet.js");
const { qrSvg, qrModules } = await import("../js/qr.js");
const { BUILD } = await import("../js/config.js");

const view = document.getElementById("view");
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const toastText = () => document.getElementById("toast").textContent;

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Drying Log — equipment scans (DOM)");

/* ---------- fixtures (made-up job) ---------- */
const T0 = "2026-10-05T18:00:00.000Z";          // 10:00 on the Alaska clock (AKDT)
const T1 = "2026-10-05T18:05:00.000Z";
const T2 = "2026-10-07T20:00:00.000Z";          // 12:00 AKDT, two days later
const ctx = (id, at, extra = {}) => ({ id, at, by: "crew@example.com", tech: "Tech A", build: "v208", how: "camera", ...extra });

function job() {
  const log = newDryingLog();
  log.id = "log1";
  log.equipment = [{ ...blankEquipRow(), asset: "AM-020", type: "Air mover", location: "Hall", placed: "2026-10-05T09:00" }];
  const p = { id: "job1", customer: "Test Customer", address: "1 Test St", rooms: ["Kitchen", "Bedroom"],
    dryingLogs: [log], equipmentScans: [], updatedAt: "2026-10-05T00:00:00.000Z" };
  recordScan(p, { tag: "RC:AM-014", mode: "place", room: "Kitchen", logId: "log1", ...ctx("e1", T0) });
  recordScan(p, { tag: "AM-015", mode: "place", room: "Kitchen", logId: "log1", ...ctx("e2", T1, { how: "typed" }) });
  log.equipment.push(blankEquipRow());          // a typed row still blank at the bottom
  return p;
}

let pill;
function render(p, d = p.dryingLogs[0]) {
  pill = document.createElement("span");
  pill.textContent = "✓ Saved";
  setCtx(p, pill);
  const sheet = dryingLog(p, d);
  view.replaceChildren(sheet);
  return sheet;
}
// the equipment table is the one whose header starts "Asset #"
function eqTable(sheet) {
  return [...sheet.querySelectorAll("table.grid")].find((t) => /Asset #/.test(t.querySelector("thead").textContent));
}
const rowsOf = (sheet) => [...eqTable(sheet).querySelector("tbody").children];
const inputsOf = (tr) => [...tr.querySelectorAll("input")];   // asset, placed, removed, hours
const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const btn = (scope, label) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

/* drag a cell's fill handle from row `from` down to the last row (jsdom has no
   layout: every row's top is 0, so any clientY past 4 reaches the bottom) */
function dragFill(sheet, from, colIndex) {
  const td = rowsOf(sheet)[from].children[colIndex];
  const handle = td.querySelector(".fillh");
  const ev = (type, y) => handle.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y }));
  ev("pointerdown", 0); ev("pointermove", 50); ev("pointerup", 50);
}

/* ---------- the table ---------- */
await test("scanned rows sit beside typed ones; their tag, placed time and hours are read-only and marked 📷", () => {
  const p = job();
  const sheet = render(p);
  const rows = rowsOf(sheet);
  assert.equal(rows.length, 4);
  const [typed, s1, s2, blank] = rows;
  for (const el of inputsOf(typed)) assert.equal(el.readOnly, false, "a typed row stays editable");
  for (const el of inputsOf(blank)) assert.equal(el.readOnly, false);
  const [asset, placed, removed, hours] = inputsOf(s1);
  assert.equal(asset.value, "AM-014");
  assert.equal(placed.value, "2026-10-05T10:00", "placed on the Alaska clock");
  assert.ok(asset.readOnly && placed.readOnly && hours.readOnly, "tag / placed / hours locked");
  assert.equal(removed.readOnly, false, "a unit still out can be given a typed removal");
  assert.ok(s1.classList.contains("eq-scanned") && !typed.classList.contains("eq-scanned"));
  const mark = s1.querySelector(".scan-mark");
  assert.ok(mark && mark.textContent === "📷" && mark.classList.contains("app-only"));
  assert.equal(mark.title, "Scanned on site by Tech A 10/05/2026 10:00");
  assert.ok(!typed.querySelector(".scan-mark"), "no mark on a typed row");
  mark.click();
  assert.match(toastText(), /Scanned on site by Tech A/);
  assert.equal(inputsOf(s2)[0].value, "AM-015");
});

await test("typing into a locked field changes nothing; type, room and notes stay editable", () => {
  const p = job();
  const sheet = render(p);
  const s1 = rowsOf(sheet)[1];
  const row = p.dryingLogs[0].equipment[1];
  const [asset, placed, , hours] = inputsOf(s1);
  typeInto(asset, "AM-999");
  typeInto(placed, "2026-10-01T08:00");
  typeInto(hours, "500");
  assert.equal(row.asset, "AM-014");
  assert.equal(row.placed, "2026-10-05T10:00");
  assert.equal(row.hours, "");
  assert.equal(asset.value, "AM-014", "the input snaps back");
  assert.ok(!row._manualHrs);
  const loc = s1.querySelectorAll("textarea")[1];
  typeInto(loc, "Kitchen by the sink");
  assert.equal(row.location, "Kitchen by the sink", "the crew can still correct the room");
  // a typed removal on a unit still out: kept, and the hours follow on the Alaska clock
  typeInto(inputsOf(s1)[2], "2026-10-06T16:00");
  assert.equal(row.removed, "2026-10-06T16:00");
  assert.equal(row.hours, 30);
  assert.equal(hours.value, "30");
  assert.equal(row.scan.removedTyped, true);
  assert.equal(pill.textContent, "Saving…");
});

await test("the fill handle never writes into a scanned row's tag, times or hours", () => {
  const p = job();
  const sheet = render(p);
  const eq = p.dryingLogs[0].equipment;
  // Asset # (column 0) from the typed AM-020: the blank row at position 3 gets AM-023
  dragFill(sheet, 0, 0);
  assert.equal(eq[1].asset, "AM-014");
  assert.equal(eq[2].asset, "AM-015");
  assert.equal(eq[3].asset, "AM-023", "a typed row below takes the next number by position");
  assert.match(toastText(), /Filled 1 row · skipped 2 scanned/);
  // Placed (column 3)
  dragFill(render(p), 0, 3);
  assert.equal(eq[1].placed, "2026-10-05T10:00");
  assert.equal(eq[2].placed, "2026-10-05T10:05");
  assert.equal(eq[3].placed, "2026-10-05T09:00");
  // Hrs (column 6): typed rows only, and only they turn manual
  eq[0].hours = 12; eq[0]._manualHrs = true;
  dragFill(render(p), 0, 6);
  assert.equal(eq[1].hours, "");
  assert.ok(!eq[1]._manualHrs && !eq[2]._manualHrs);
  assert.equal(eq[3].hours, 12);
  // Room (column 2) is not the scan's: it fills like any other row
  dragFill(render(p), 0, 2);
  assert.equal(eq[1].location, "Hall");
  assert.equal(eq[3].location, "Hall");
  // a scanned row's own Removed fills down while the unit is still out...
  eq[0].removed = "2026-10-08T09:00";
  dragFill(render(p), 0, 4);
  assert.equal(eq[1].removed, "2026-10-08T09:00", "a typed removal is allowed while no scan removed it");
  // ...but not once a scan removed it
  recordScan(p, { tag: "AM-015", mode: "remove", ...ctx("e3", T2) });
  eq[0].removed = "2026-10-09T09:00";
  const sheet2 = render(p);
  const i15 = p.dryingLogs[0].equipment.findIndex((r) => r.asset === "AM-015");
  dragFill(sheet2, 0, 4);
  assert.equal(p.dryingLogs[0].equipment[i15].removed, "2026-10-07T12:00", "the scan's removed time stays");
});

await test("a scan's Remove locks Removed, computes the hours and prints an S on both times", () => {
  const p = job();
  recordScan(p, { tag: "AM-014", mode: "remove", ...ctx("e3", T2) });
  const sheet = render(p);
  const s1 = rowsOf(sheet)[1];
  const [, placed, removed, hours] = inputsOf(s1);
  assert.equal(removed.value, "2026-10-07T12:00");
  assert.ok(removed.readOnly);
  assert.equal(hours.value, "50");
  const sups = s1.querySelectorAll("sup.scan-s");
  assert.equal(sups.length, 2, "S on placed and removed");
  assert.equal(sups[0].style.display, "none", "S shows on paper only");
  assert.equal(rowsOf(sheet)[2].querySelectorAll("sup.scan-s").length, 1, "only placed is scanned on AM-015");
  assert.equal(rowsOf(sheet)[0].querySelectorAll("sup.scan-s").length, 0, "a typed row has none");
  assert.ok(placed.parentElement.classList.contains("scan-cell"));
});

await test("✕ on a scanned row asks, then undoes the scan with void events (the row goes)", () => {
  const p = job();
  recordScan(p, { tag: "AM-014", mode: "place", room: "Bedroom", ...ctx("e3", T2) });   // a move
  const placeId = p.dryingLogs[0].equipment[1].scanId;
  let sheet = render(p);
  confirmAnswer = false;
  rowsOf(sheet)[1].querySelector(".rowdel").click();
  assert.equal(confirms.pop(), "Undo this scan? The row comes off the drying log; the scan stays in the server's scan log, marked undone.");
  assert.equal(p.equipmentScans.length, 3, "said no: nothing recorded");
  assert.equal(rowsOf(sheet).length, 4);
  confirmAnswer = true;
  const before = p.equipmentScans.length;
  rowsOf(sheet)[1].querySelector(".rowdel").click();
  const voids = p.equipmentScans.slice(before);
  assert.deepEqual(voids.map((e) => e.act), ["void", "void"], "the place and its move");
  assert.deepEqual(voids.map((e) => e.voids).sort(), ["e1", "e3"]);
  assert.ok(voids.every((e) => e.build === BUILD && e.tech === "" && e.id && /T.*Z$/.test(e.at)), "stamped like a scan");
  assert.ok(!placements(p).some((P) => P.placeId === placeId));
  assert.ok(!p.dryingLogs[0].equipment.some((r) => r.scanId === placeId));
  sheet = view.firstChild;
  assert.deepEqual(rowsOf(sheet).map((tr) => inputsOf(tr)[0].value), ["AM-020", "AM-015", ""]);
  assert.equal(pill.textContent, "Saving…", "the undo is saved like any edit");
  assert.ok(!scanRecord(p).some((r) => r.tag === "AM-014"), "the record prints only what still counts");
  // a typed row's ✕ still just deletes it
  rowsOf(sheet)[0].querySelector(".rowdel").click();
  assert.deepEqual(p.dryingLogs[0].equipment.map((r) => r.asset), ["AM-015", ""]);
  // a scanned row whose scan isn't on this device (applyScans leaves it): ✕ takes it off, no void
  p.dryingLogs[0].equipment.push({ asset: "AM-099", type: "Air mover", location: "Den", placed: "2026-10-05T09:00",
    removed: "", hours: "", notes: "", scanId: "elsewhere-1", scan: { placeId: "elsewhere-1", removeId: "" } });
  sheet = render(p);
  const n = p.equipmentScans.length;
  rowsOf(sheet)[2].querySelector(".rowdel").click();
  assert.equal(p.equipmentScans.length, n, "nothing to void");
  assert.deepEqual(p.dryingLogs[0].equipment.map((r) => r.asset), ["AM-015", ""]);
});

await test("scans from another device land in the table when the page opens, and are saved", () => {
  const p = job();
  // another device's events merged in, rows not derived yet (and the log came from an older copy)
  p.equipmentScans.push({ id: "x1", tag: "DH-003", act: "place", at: T1, room: "Bedroom", type: "Dehumidifier",
    model: "", logId: "log1", voids: "", how: "camera", by: "crew@example.com", tech: "Tech B", build: "v208" });
  p.dryingLogs[0].equipment = p.dryingLogs[0].equipment.filter((r) => r.asset !== "AM-015");
  const sheet = render(p);
  const tags = rowsOf(sheet).map((tr) => inputsOf(tr)[0].value);
  assert.ok(tags.includes("DH-003") && tags.includes("AM-015"), tags.join(","));
  assert.equal(pill.textContent, "Saving…");
  // nothing new: no save
  render(p);
  assert.equal(pill.textContent, "✓ Saved");
});

/* ---------- on paper ---------- */
await test("the printed sheet carries the S legend, the scan record and its footnote", () => {
  const p = job();
  recordScan(p, { tag: "AM-014", mode: "place", room: "Bedroom", ...ctx("e3", "2026-10-06T17:30:00.000Z") });
  recordScan(p, { tag: "AM-015", mode: "remove", ...ctx("e4", T2, { tech: "", how: "photo" }) });
  const sheet = render(p);
  const pr = sheet.querySelector(".eqscan-print");
  assert.ok(pr && pr.classList.contains("print-only"));
  assert.ok(eqTable(sheet).closest(".tablewrap").nextElementSibling === pr, "right under the equipment table");
  assert.equal(pr.querySelector(".eqscan-legend").textContent, "S = recorded by scanning the unit's QR label on site");
  assert.equal(pr.querySelector(".eqscan-title").textContent, "Equipment scan record");
  const t = pr.querySelector("table.eqscan-rec");
  assert.deepEqual([...t.querySelectorAll("th")].map((th) => th.textContent), ["Time", "Tag", "Type", "Action", "Room", "Read by", "Tech"]);
  const cells = [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  assert.deepEqual(cells, [
    ["10/05/2026 10:00", "AM-014", "Air mover", "Placed", "Kitchen", "Camera", "Tech A"],
    ["10/05/2026 10:05", "AM-015", "Air mover", "Placed", "Kitchen", "Typed tag", "Tech A"],
    ["10/06/2026 09:30", "AM-014", "Air mover", "Moved", "Bedroom", "Camera", "Tech A"],
    ["10/07/2026 12:00", "AM-015", "Air mover", "Removed", "Kitchen", "Label photo", "crew"],   // no tech picked: the login, never an email address
  ]);
  assert.equal(pr.querySelector(".eqscan-foot").textContent,
    "Times come from the scanning device's clock at the moment the label was read. Each scan is also logged on Roybal's server when the device syncs, and that log can't be edited.");
  // the move is noted on the kept row, the SOP way
  assert.match(p.dryingLogs[0].equipment[1].notes, /^moved to Bedroom 10\/06 09:30$/m);
});

await test("a log with no scanned rows prints nothing extra", () => {
  const log = newDryingLog();
  const p = { id: "job2", customer: "Other", dryingLogs: [log], equipmentScans: [] };
  const sheet = render(p);
  assert.equal(sheet.querySelector(".eqscan-print").childElementCount, 0);
  assert.equal(sheet.querySelectorAll("sup.scan-s").length, 0);
});

/* ---------- the 📷 Scan equipment button ---------- */
const scanButton = (sheet) => btn(sheet, "📷 Scan equipment");
const note = (sheet) => scanButton(sheet).parentElement.nextElementSibling;

await test("before the database update the button is off and says why", async () => {
  await settle();                               // the earlier pages' fleet reads are done
  localStorage.removeItem("roybal-fleet-ready");
  fleetAnswer = () => new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.equipment_units' in the schema cache" }), { status: 404 });
  const sheet = render(job());
  const b = scanButton(sheet);
  assert.ok(b && b.classList.contains("btn--primary") && b.classList.contains("app-only"));
  assert.ok(btn(sheet, "+ Add equipment"), "+ Add equipment is still there");
  assert.equal(b.disabled, true);
  await settle();
  assert.equal(b.disabled, true);
  assert.equal(note(sheet).textContent, "Scanning switches on after this feature's database update is applied.");
  assert.equal(note(sheet).hidden, false);
  assert.equal(fleet.fleetReady(), false);
  assert.ok(asked.some((u) => u.includes("equipment_units?select=id,tag,type,make,model,rating,owned,status,notes&order=tag")));
});

await test("never connected: off with 'Connect once'; once the table answers it switches on and stays on offline", async () => {
  localStorage.removeItem("roybal-fleet-ready");
  fleetAnswer = () => { throw new TypeError("network down"); };
  let sheet = render(job());
  await settle();
  assert.equal(scanButton(sheet).disabled, true);
  assert.equal(note(sheet).textContent, "Connect once to switch scanning on");
  fleetAnswer = () => new Response(JSON.stringify([{ id: "u1", tag: "AM-014", type: "air_mover", make: "Acme", model: "X3", rating: "1/3 hp", owned: "owned", status: "active", notes: "" }]), { status: 200 });
  sheet = render(job());
  await settle();
  assert.equal(scanButton(sheet).disabled, false);
  assert.equal(note(sheet).hidden, true);
  assert.equal(fleet.fleetReady(), true);
  assert.equal(fleet.loadFleet()[0].tag, "AM-014");
  fleetAnswer = () => { throw new TypeError("network down"); };
  sheet = render(job());
  assert.equal(scanButton(sheet).disabled, false, "ready before the read answers");
  await settle();
  assert.equal(scanButton(sheet).disabled, false, "an offline read keeps the cache and the flag");
  assert.equal(fleet.loadFleet().length, 1);
});

await test("tapping it opens the overlay on this job; each change saves and repaints the table", async () => {
  localStorage.setItem("roybal-fleet-ready", "1");
  fleetAnswer = () => new Response("[]", { status: 200 });
  const p = job();
  await Store.put({ id: "other", customer: "Someone Else", dryingLogs: [], equipmentScans: [] });
  await Store.put(p);
  let opened = null;
  scanDeps.loadScanner = async () => ({
    openScanner: async (proj, opts) => {
      opened = { proj, opts };
      assert.equal(scanButton(view.firstChild).disabled, true, "no second overlay while one is open");
      recordScan(proj, { tag: "AM-030", mode: "place", room: "Bedroom", logId: opts.logId, ...ctx("e9", T2) });
      pill.textContent = "✓ Saved";
      opts.onChange(proj);
    },
  });
  const sheet = render(p);
  await settle();
  scanButton(sheet).click();
  await settle();
  assert.ok(opened, "openScanner was called");
  assert.equal(opened.proj, p, "the live job object");
  assert.equal(opened.opts.logId, "log1");
  assert.equal(typeof opened.opts.onChange, "function");
  assert.deepEqual(opened.opts.otherProjects.map((x) => x.id), ["other"], "every other job, not this one");
  assert.ok(rowsOf(sheet).some((tr) => inputsOf(tr)[0].value === "AM-030"), "the new row is in the table");
  assert.equal(pill.textContent, "Saving…", "the scan is saved like any edit");
  assert.ok(sheet.querySelector(".eqscan-rec").textContent.includes("AM-030"), "and in the printed record");
  assert.equal(scanButton(sheet).disabled, false, "back on after the overlay closes");
});

await test("a scanner that fails to load says so and leaves the button usable", async () => {
  localStorage.setItem("roybal-fleet-ready", "1");
  scanDeps.loadScanner = async () => { throw new Error("offline and not cached"); };
  const sheet = render(job());
  scanButton(sheet).click();
  await settle();
  assert.match(toastText(), /Couldn't open the scanner: offline and not cached/);
  assert.equal(scanButton(sheet).disabled, false);
});

/* ---------- fleet.js / qr.js ---------- */
await test("fleet.js: lookups by tag key, labels, model text, label payload", () => {
  const units = [{ tag: "AM-014", type: "air_mover", make: "Acme", model: "X3", rating: "1/3 hp" }, { tag: "101", type: "dehu_lgr", make: "", model: "", rating: "" }];
  assert.equal(fleet.unitFor(units, "am 14"), units[0]);
  assert.equal(fleet.unitFor(units, "AM-0014"), units[0]);
  assert.equal(fleet.unitFor(units, "0101"), units[1]);
  assert.equal(fleet.unitFor(units, "AM-015"), null);
  assert.equal(fleet.unitFor(null, "AM-014"), null);
  assert.equal(fleet.unitLabel(units[0]), "Air mover");
  assert.equal(fleet.unitLabel(units[1]), "LGR dehumidifier");
  assert.equal(fleet.unitLabel({ type: "toaster" }), "");
  assert.equal(fleet.unitModelText(units[0]), "Acme X3 · 1/3 hp");
  assert.equal(fleet.unitModelText({ make: " Acme ", model: "", rating: "" }), "Acme");
  assert.equal(fleet.unitModelText({ rating: "70 ppd" }), "70 ppd");
  assert.equal(fleet.unitModelText(null), "");
  assert.equal(fleet.labelPayload("AM-014"), "RC:AM-014");
});

await test("qr.js: error correction is optional, M by default, Q on request", async () => {
  const m = JSON.stringify(await qrModules("RC:AM-014"));
  assert.equal(JSON.stringify(await qrModules("RC:AM-014", "M")), m, "the default is M");
  assert.equal(JSON.stringify(await qrModules("RC:AM-014", "bogus")), m, "an unknown level falls back to M");
  assert.notEqual(JSON.stringify(await qrModules("RC:AM-014", "Q")), m, "Q is a different code");
  assert.equal(JSON.stringify(await qrModules("RC:AM-014", "q")), JSON.stringify(await qrModules("RC:AM-014", "Q")));
  const svg = await qrSvg("ROYBAL");
  assert.ok(svg.includes("<svg"));
  assert.equal(svg, await qrSvg("ROYBAL", 3, 2, "M"));
  assert.notEqual(await qrSvg("RC:AM-014", 3, 2, "Q"), await qrSvg("RC:AM-014", 3, 2));
});

console.log(`${pass} passed`);
