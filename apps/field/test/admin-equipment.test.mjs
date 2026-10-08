/* The office Equipment tab (apps/admin/js/equipment.js) — DOM render
   (jsdom), local Store (fake-indexeddb), Supabase answered by a fake fetch.
   Out now across jobs (scanned and typed rows, a unit on two jobs, 7+
   days, archived jobs), the fleet list and its doors (Add units in runs,
   Edit, status, a duplicate tag), tags seen but not listed, the label
   sheet (10 per letter page, Q-level QR of RC:<tag>, a part-used sheet),
   the database update not applied yet, a login that can't edit, and the
   Avery 5163 / 5523 geometry in admin.css.
   Run: node apps/field/test/admin-equipment.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

// the office admin imports field modules as "../../js/x.js" (one origin, two
// folders on the server); on disk they live in apps/field/js
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL && ctx.parentURL.includes("/apps/admin/js/") && spec.startsWith("../../js/"))
    return next(new URL(spec.replace("../../js/", "../../field/js/"), ctx.parentURL).href, ctx);
  const r = await next(spec, ctx);
  return r.url.includes("/apps/admin/js/") ? { ...r, format: "module" } : r;   // no package.json there
}`));

const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><header class="abar"></header><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/admin/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "KeyboardEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.confirm = () => true;
globalThis.confirm = window.confirm;
let printed = 0;
window.print = () => { printed++; };
localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "office@example.com" }));

const { tagKey, wallTime, TAG_PREFIXES } = await import("../js/scans.js");

/* ---------- Supabase, faked ---------- */
const calls = [];
let role = "error";                  // "error" → can't tell (fail open, not kept); true; false
let missing = false;                 // 0022 not applied yet
let nid = 10;
let U = [
  { id: "u1", tag: "AM-014", type: "air_mover", make: "Dri-Eaz", model: "Velo Pro", serial: "S-1", rating: "1/4 hp", owned: "owned", status: "active", notes: "" },
  { id: "u2", tag: "DH-002", type: "dehu_lgr", make: "Phoenix", model: "200 Max", rating: "", owned: "rented", status: "active", notes: "" },
  { id: "u3", tag: "AM-003", type: "air_mover", make: "", model: "", rating: "", owned: "owned", status: "repair", notes: "" },
  { id: "u4", tag: "HT-001", type: "heater", make: "", model: "", rating: "", owned: "owned", status: "retired", notes: "" },
];
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const refuse = () => json(403, { code: "42501", message: "only the office or a crew lead can change the equipment list" });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, body });
  if (u.includes("/rest/v1/rpc/role_is")) return role === "error" ? json(503, {}) : json(200, role);
  if (missing && /equipment_unit/.test(u)) return json(404, { code: "PGRST205", message: "Could not find the table 'public.equipment_units' in the schema cache" });
  // a save nudges the sync; this test has no server for it
  if (/\/rest\/v1\/(rpc\/sync_|field_projects|rpc\/field_)/.test(u)) return json(503, { message: "no sync server in this test" });
  if (u.includes("/rest/v1/rpc/equipment_units_add_range")) {
    if (role === false) return refuse();
    let n = 0;
    for (let i = body.p_from; i <= body.p_to; i++) {
      const tag = (body.p_prefix ? body.p_prefix + "-" : "") + String(i).padStart(body.p_pad, "0");
      if (U.some((x) => tagKey(x.tag) === tagKey(tag))) continue;
      U.push({ id: "u" + ++nid, tag, type: body.p_type, make: body.p_make, model: body.p_model, rating: body.p_rating, owned: body.p_owned, status: "active", notes: "" });
      n++;
    }
    return json(200, n);
  }
  if (u.includes("/rest/v1/rpc/equipment_unit_save")) {
    if (role === false) return refuse();
    const p = body.p_unit;
    const cur = p.id ? U.find((x) => x.id === p.id) : null;
    const tag = p.tag ? p.tag.toUpperCase() : cur.tag;
    const dup = U.find((x) => tagKey(x.tag) === tagKey(tag) && x.id !== p.id);
    if (dup) return json(409, { code: "23505", message: `${tag} is already on the equipment list`, hint: "Edit that unit instead, or give this one another number." });
    if (cur) { Object.assign(cur, p, { tag }); return json(200, cur); }
    const row = { id: "u" + ++nid, make: "", model: "", rating: "", owned: "owned", status: "active", notes: "", ...p, tag };
    U.push(row);
    return json(200, row);
  }
  if (u.includes("/rest/v1/equipment_units")) return json(200, U.slice().sort((a, b) => (a.tag < b.tag ? -1 : 1)));
  throw new Error("unexpected fetch " + u);
};

const { Store } = await import("../js/core.js");
const { qrSvg } = await import("../js/qr.js");
const M = await import("../../admin/js/equipment.js");

const view = document.getElementById("view");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const go = async (hash) => { location.hash = hash; await settle(5); await M.renderEquipment(view); await settle(60); };
const btn = (root, text) => [...root.querySelectorAll("button, a")].find((b) => b.textContent.trim() === text);
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const pick = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("change", { bubbles: true })); };
const toastText = () => document.getElementById("toast").textContent;
const dialog = () => document.querySelector(".eq-dlg");
// no word boundaries: a stray null lands glued to its neighbours ("Add unitsnull")
const noJunk = (el) => assert.ok(!/null|undefined|NaN|\[object/.test(el.textContent), el.textContent.match(/.{0,40}(null|undefined|NaN|\[object).{0,40}/));
const cards = () => [...view.querySelectorAll(".eq-card")];
const cardOf = (title) => cards().find((c) => c.querySelector(".eq-head strong").textContent === title);
const bodyRows = (card) => [...card.querySelectorAll("tbody tr")];
const fleetTags = () => bodyRows(cardOf("Fleet list")).map((r) => r.children[1].textContent);
const rpc = (fn) => calls.filter((c) => c.u.includes("/rest/v1/rpc/" + fn));

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Office Equipment tab (DOM)");

/* ---------- four jobs (made-up data) ---------- */
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const wall = (d) => wallTime(ago(d));
const ev = (id, tag, act, d, room, typ = "", logId = "") =>
  ({ id, tag, act, at: ago(d), room, type: typ, model: "", logId, voids: "", how: "camera", by: "crew@example.com", tech: "Sam", build: "v208" });
const blank = () => ({ asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" });
const JOB1 = "11111111-1111-4111-8111-111111111111", JOB2 = "22222222-2222-4222-8222-222222222222";
const JOB3 = "33333333-3333-4333-8333-333333333333", JOB4 = "44444444-4444-4444-8444-444444444444";
await Store.put({ id: JOB1, customer: "Pollen", address: "12 Test Loop", updatedAt: "2026-10-01T00:00:00.000Z",
  dryingLogs: [{ id: "L1", equipment: [blank()], readings: [] }],
  equipmentScans: [
    ev("e1", "AM-014", "place", 9, "Kitchen", "Air mover", "L1"),
    ev("e3", "AM-014", "move", 8, "Bedroom"),
    ev("e2", "DH-002", "place", 2, "Basement", "LGR dehumidifier", "L1"),
    ev("e4", "AM-003", "place", 5, "Hall", "Air mover", "L1"),
    ev("e5", "AM-003", "remove", 1, "Hall"),
  ] }, { bump: false, quiet: true });
await Store.put({ id: JOB2, customer: "Smith", address: "40 Sample Rd", updatedAt: "2026-10-01T00:00:00.000Z",
  dryingLogs: [{ id: "L2", equipment: [
    { asset: "AM-14", type: "Air Mover", location: "Living room", placed: wall(1), removed: "", hours: "", notes: "" },
    { asset: "", type: "Dehu", location: "Garage", placed: wall(3), removed: "", hours: "", notes: "" },
    { asset: "AM-030", type: "Air Mover", location: "Den", placed: wall(4), removed: wall(1), hours: "72", notes: "" },
  ], readings: [] }] }, { bump: false, quiet: true });
await Store.put({ id: JOB3, customer: "Oldjob", address: "", archivedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  dryingLogs: [{ id: "L3", equipment: [{ asset: "AM-020", type: "Air Mover", location: "Hall", placed: wall(30), removed: "", hours: "", notes: "" }] }] },
{ bump: false, quiet: true });
await Store.put({ id: JOB4, customer: "Jones", address: "7 Example Ct", updatedAt: "2026-10-01T00:00:00.000Z",
  dryingLogs: [{ id: "L4", equipment: [] }],
  equipmentScans: [
    ev("f1", "101", "place", 1, "Crawlspace", "Heater", "L4"),
    ev("f2", "AF-007", "place", 1, "Kitchen", "Air scrubber", "L4"),
    ev("f3", "202", "place", 1, "Attic", "", "L4"),
  ] }, { bump: false, quiet: true });

await test("Out now: every unit placed and not removed, scanned or typed, on every live job; the unit on two jobs first", async () => {
  await go("#/equipment");
  const out = cardOf("Out now");
  assert.ok(out, "the Out now card");
  assert.equal(out.querySelector(".eq-head span").textContent, "7 units on 3 jobs · 1 out 7+ days");
  const rows = bodyRows(out);
  assert.equal(rows.length, 7, "AM-003 was removed, AM-030 has a removal date, the archived job waits below");
  const tags = rows.map((r) => r.children[0].querySelector("strong").textContent);
  assert.deepEqual(tags.slice(0, 2).sort(), ["AM-014", "AM-14"], "the unit on two jobs leads");
  for (const r of rows.slice(0, 2)) assert.match(r.textContent, /On 2 jobs/);
  const am14 = rows.find((r) => r.children[0].querySelector("strong").textContent === "AM-014");
  assert.equal(am14.children[3].textContent, "Bedroom", "the room it moved to");
  assert.match(am14.textContent, /7\+ days/, "out 9 days");
  assert.equal(am14.children[2].querySelector("a").getAttribute("href"), "/#/p/" + JOB1);
  assert.equal(am14.children[6].textContent, "📷 Scanned");
  const typed = rows.find((r) => r.children[0].querySelector("strong").textContent === "AM-14");
  assert.equal(typed.children[6].textContent, "✎ Typed");
  assert.equal(typed.children[3].textContent, "Living room");
  assert.ok(rows.some((r) => r.children[0].querySelector("strong").textContent === "—" && r.children[3].textContent === "Garage"), "a typed row with no tag still counts");
  assert.ok(!rows.some((r) => /DH-002/.test(r.textContent) && /7\+ days/.test(r.textContent)), "2 days isn't flagged");
  const flags = view.querySelector(".eq-flags");
  assert.match(flags.textContent, /1 unit out on two jobs at once/);
  assert.match(flags.textContent, /AM-014 — Pollen \(Bedroom, since .+\) · Smith \(Living room, since .+\)/);
  // the fix is the real removal time, typed: a Remove scan now would bill the other job's days here
  assert.match(flags.textContent, /type the date and time it really came off in that row's Removed cell/);
  assert.doesNotMatch(flags.textContent, /scan it out \(Remove\)/);
  noJunk(view);
});

await test("Out now: units still open on archived jobs are counted below and shown on request", async () => {
  const out = cardOf("Out now");
  assert.match(out.textContent, /1 more unit is still open on archived jobs/);
  btn(out, "Show them").click();
  const rows = bodyRows(out);
  assert.equal(rows.length, 8);
  const last = rows[rows.length - 1];
  assert.match(last.textContent, /AM-020.*Oldjob.*Archived/s);
  btn(out, "Hide them").click();
  assert.equal(bodyRows(out).length, 7);
});

await test("the scans are written into a copy: the jobs on this device are untouched", async () => {
  const p = await Store.get(JOB1);
  assert.deepEqual(p.dryingLogs[0].equipment, [blank()], "the seed row is still there, no scanned rows written");
  assert.equal(p.updatedAt, "2026-10-01T00:00:00.000Z");
});

await test("the fleet list: active units by default, where each is now and its last scan; filters and search", async () => {
  assert.deepEqual(fleetTags(), ["AM-014", "DH-002"]);
  assert.deepEqual(JSON.parse(localStorage.getItem("roybal-fleet")).map((u) => u.tag).sort(), ["AM-003", "AM-014", "DH-002", "HT-001"],
    "what this device read is kept for the next time it is offline");
  const fleet = cardOf("Fleet list");
  assert.equal(fleet.querySelector(".eq-head span").textContent, "4 units · 2 active");
  const [am, dh] = bodyRows(fleet);
  assert.match(am.children[7].textContent, /On 2 jobs/);
  assert.equal(dh.children[7].textContent, "Pollen · Basement");
  assert.match(dh.children[8].textContent, / · placed$/);
  assert.match(am.children[8].textContent, / · moved$/, "its newest scan was the move");
  assert.equal(dh.children[2].textContent, "LGR dehumidifier");
  assert.equal(dh.children[5].textContent, "Rented");
  pick(fleet.querySelector('select[aria-label="Status"]'), "");
  assert.deepEqual(fleetTags(), ["AM-003", "AM-014", "DH-002", "HT-001"]);
  assert.equal(bodyRows(fleet)[3].children[7].textContent, "Not out on a job");
  pick(fleet.querySelector('select[aria-label="Type"]'), "air_mover");
  assert.deepEqual(fleetTags(), ["AM-003", "AM-014"]);
  pick(fleet.querySelector('select[aria-label="Type"]'), "");
  type(fleet.querySelector(".eq-search"), "velo");
  assert.deepEqual(fleetTags(), ["AM-014"]);
  type(fleet.querySelector(".eq-search"), "basement");
  assert.deepEqual(fleetTags(), ["DH-002"], "search finds where a unit is");
  type(fleet.querySelector(".eq-search"), "");
  pick(fleet.querySelector('select[aria-label="Status"]'), "active");
  noJunk(view);
});

await test("tags seen on jobs but not listed: type from the scan or the prefix; one tap adds; no type asks for one", async () => {
  const seen = cardOf("Tags seen, not in the fleet list");
  const rows = [...seen.querySelectorAll(".eq-seen")];
  assert.deepEqual(rows.map((r) => r.querySelector("strong").textContent), ["101", "202", "AF-007"]);
  assert.match(rows[0].textContent, /101 Heater.*Scanned 1 time on 1 job/s);
  assert.match(rows[2].textContent, /AF-007 Air scrubber/);
  assert.ok(rows[1].querySelector('select[aria-label="Type of 202"]'), "202 says nothing about its type");
  btn(rows[1], "Add").click();
  await settle();
  assert.match(toastText(), /Pick what kind of unit 202 is/);
  assert.equal(rpc("equipment_unit_save").length, 0);
  btn(rows[2], "Add").click();
  await settle(120);
  assert.deepEqual(rpc("equipment_unit_save").pop().body, { p_unit: { tag: "AF-007", type: "air_scrubber" } });
  assert.ok(U.some((u) => u.tag === "AF-007" && u.type === "air_scrubber"));
  const after = [...cardOf("Tags seen, not in the fleet list").querySelectorAll(".eq-seen strong")].map((s) => s.textContent);
  assert.deepEqual(after, ["101", "202"]);
  assert.ok(fleetTags().includes("AF-007"), "and it's on the list");
});

await test("+ Add units: the type sets the prefix, the preview names the run, the door gets it 200 at a time", async () => {
  btn(view, "+ Add units").click();
  const d = dialog();
  assert.ok(d, "the Add units dialog");
  const prefix = d.querySelector('input[aria-label="Prefix"]');
  assert.equal(prefix.value, "AM");
  pick(d.querySelector('select[aria-label="Type"]'), "dehu_lgr");
  assert.equal(prefix.value, "DH", "an LGR is still a DH");
  pick(d.querySelector('select[aria-label="Type"]'), "air_scrubber");
  assert.equal(prefix.value, "AF");
  pick(d.querySelector('select[aria-label="Type"]'), "dehumidifier");
  type(d.querySelector('input[aria-label="From number"]'), "5");
  type(d.querySelector('input[aria-label="To number"]'), "2");
  btn(d, "Add units").click();
  await settle();
  assert.match(d.querySelector(".warn").textContent, /no lower than From/);
  type(d.querySelector('input[aria-label="From number"]'), "1");
  type(d.querySelector('input[aria-label="To number"]'), "250");
  assert.equal(d.querySelector(".eq-preview").textContent, "Adds DH-001 to DH-250: 250 units. Tags already on the list are skipped.");
  d.querySelectorAll("input[type=text]")[1].value = "Phoenix";              // make
  btn(d, "Add units").click();
  await settle(200);
  const runs = rpc("equipment_units_add_range").map((c) => c.body);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { p_prefix: "DH", p_from: 1, p_to: 200, p_pad: 3, p_type: "dehumidifier",
    p_make: "Phoenix", p_model: "", p_rating: "", p_owned: "owned" });
  assert.deepEqual([runs[1].p_from, runs[1].p_to], [201, 250]);
  assert.equal(dialog(), null, "the dialog closed");
  assert.equal(toastText(), "Added 249 units (1 already on the list).", "DH-002 was there");
  assert.ok(fleetTags().includes("DH-250"));
});

await test("+ Add units with a blank prefix adds plain numbers", async () => {
  btn(view, "+ Add units").click();
  const d = dialog();
  pick(d.querySelector('select[aria-label="Type"]'), "other");
  assert.equal(d.querySelector('input[aria-label="Prefix"]').value, "", "Other has no prefix");
  type(d.querySelector('input[aria-label="From number"]'), "101");
  type(d.querySelector('input[aria-label="To number"]'), "103");
  assert.match(d.querySelector(".eq-preview").textContent, /^Adds 101 to 103: 3 units\./);
  pick(d.querySelector('select[aria-label="Type"]'), "heater");
  type(d.querySelector('input[aria-label="Prefix"]'), "");                  // typed blank: stays blank
  btn(d, "Add units").click();
  await settle(150);
  assert.deepEqual(rpc("equipment_units_add_range").pop().body.p_prefix, "");
  assert.ok(U.some((u) => u.tag === "102" && u.type === "heater"));
  const seen = cardOf("Tags seen, not in the fleet list");
  assert.deepEqual([...seen.querySelectorAll(".eq-seen strong")].map((s) => s.textContent), ["202"], "101 is listed now");
});

await test("Edit: a tag already on the list says so and keeps the form; a good save goes through equipment_unit_save by id", async () => {
  const row = bodyRows(cardOf("Fleet list")).find((r) => r.children[1].textContent === "AM-014");
  btn(row, "Edit").click();
  const d = dialog();
  assert.match(d.textContent, /Edit AM-014/);
  const [tag, make, model, serial, rating] = d.querySelectorAll("input[type=text]");
  assert.equal(serial.value, "S-1");
  // a tag the list would take but the scanner can't read never reaches the door
  const saves = rpc("equipment_unit_save").length;
  type(tag, "AMX-014");
  btn(d, "Save").click();
  await settle(20);
  assert.match(d.querySelector(".warn").textContent, /^The scanner can't read that tag/);
  assert.equal(rpc("equipment_unit_save").length, saves);
  type(tag, "dh-2");
  btn(d, "Save").click();
  await settle(80);
  assert.equal(d.querySelector(".warn").textContent, "DH-2 is already on the equipment list. Edit that unit instead, or give this one another number.");
  assert.ok(dialog(), "still open");
  type(tag, "AM-014");
  type(rating, "1/3 hp");
  btn(d, "Save").click();
  await settle(80);
  assert.equal(dialog(), null);
  const sent = rpc("equipment_unit_save").pop().body.p_unit;
  assert.deepEqual(sent, { id: "u1", tag: "AM-014", type: "air_mover", make: "Dri-Eaz", model: "Velo Pro",
    rating: "1/3 hp", owned: "owned", status: "active", notes: "", serial: "S-1" });
  assert.equal(bodyRows(cardOf("Fleet list")).find((r) => r.children[1].textContent === "AM-014").children[4].textContent, "1/3 hp");
  // notes keep their line breaks: saved as typed, and shown that way on the next edit
  btn(bodyRows(cardOf("Fleet list")).find((r) => r.children[1].textContent === "AM-014"), "Edit").click();
  type(dialog().querySelector("textarea"), "Bearing noisy\nSent to shop 9/30");
  btn(dialog(), "Save").click();
  await settle(80);
  assert.equal(rpc("equipment_unit_save").pop().body.p_unit.notes, "Bearing noisy\nSent to shop 9/30");
  btn(bodyRows(cardOf("Fleet list")).find((r) => r.children[1].textContent === "AM-014"), "Edit").click();
  assert.equal(dialog().querySelector("textarea").value, "Bearing noisy\nSent to shop 9/30");
  btn(dialog(), "Cancel").click();
  void make; void model;
});

await test("status: the row's select saves at once, and a repaired unit leaves the active list", async () => {
  const row = bodyRows(cardOf("Fleet list")).find((r) => r.children[1].textContent === "DH-002");
  pick(row.querySelector("select.eq-status"), "repair");
  await settle(80);
  assert.deepEqual(rpc("equipment_unit_save").pop().body, { p_unit: { id: "u2", status: "repair" } });
  assert.ok(!fleetTags().includes("DH-002"));
  assert.match(toastText(), /DH-002: Repair/);
});

await test("print labels: ticked units on a letter sheet, 10 to a page, QR of RC:<tag> at Q; used labels skipped", async () => {
  pick(cardOf("Fleet list").querySelector('select[aria-label="Status"]'), "");
  const tick = (t) => { const r = bodyRows(cardOf("Fleet list")).find((x) => x.children[1].textContent === t); const c = r.querySelector("input[type=checkbox]"); c.checked = true; c.dispatchEvent(new window.Event("change")); };
  tick("AM-014"); tick("DH-002"); tick("AF-007");
  assert.match(cardOf("Fleet list").textContent, /3 units ticked for printing/);
  btn(view, "🖨 Print labels").click();
  const d = dialog();
  assert.match(d.textContent, /Ticked units \(3\)/);
  assert.ok(d.querySelector('input[value="ticked"]').checked, "ticked rows are the default when there are some");
  btn(d, "Open the label sheet").click();
  await settle(5);
  await M.renderEquipment(view);
  await settle(80);
  assert.ok(document.body.classList.contains("eq-print"));
  assert.match(document.getElementById("eq-page-style").textContent, /@page \{ size: letter; margin: 0; \}/);
  let pages = view.querySelectorAll(".eq-page");
  assert.equal(pages.length, 1);
  const labels = pages[0].querySelectorAll(".eq-label");
  assert.equal(labels.length, 3);
  assert.deepEqual([...labels].map((l) => l.querySelector(".eq-label__tag").textContent), ["AF-007", "AM-014", "DH-002"]);
  const am = labels[1];
  assert.equal(am.querySelector(".eq-label__type").textContent, "Air mover");
  assert.equal(am.querySelector(".eq-label__model").textContent, "Dri-Eaz Velo Pro · 1/3 hp");
  assert.equal(am.querySelector(".eq-label__co").textContent, "Roybal Construction");
  assert.equal(am.querySelector(".eq-label__tag").style.fontSize, "36pt");
  const cells = (svg) => / d="([^"]*)"/.exec(svg)[1];                         // the dark modules
  const want = cells(await qrSvg("RC:AM-014", 4, 2, "Q"));
  assert.ok(am.querySelector(".eq-label__qr path").getAttribute("d") === want, "the label's QR is RC:AM-014 at error correction Q");
  assert.ok(want !== cells(await qrSvg("RC:AM-014", 4, 2, "M")), "(and Q draws a different code from M)");
  assert.match(view.textContent, /Use weatherproof laser labels \(Avery 5523, or polyester laser stock\)\. Stick them on indoors above 50°F on a clean, dry spot on the top or handle side, never a grille or filter door\. Try one on an air mover first\./);
  assert.match(view.textContent, /3 labels on 1 sheet\./);
  // a sheet with 8 labels gone: 2 on it, the third on a new sheet
  type(view.querySelector('input[aria-label="Labels already used on the first sheet"]'), "8");
  pages = view.querySelectorAll(".eq-page");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].children.length, 10);
  assert.equal(pages[0].querySelectorAll(".eq-label--blank").length, 8);
  assert.equal(pages[1].querySelector(".eq-label__tag").textContent, "DH-002");
  assert.match(view.textContent, /3 labels on 2 sheets\./);
  btn(view, "🖨 Print").click();
  assert.equal(printed, 1);
  noJunk(view);
  // leaving the sheet takes the print mode with it
  location.hash = "#/equipment";
  await settle(5);
  assert.ok(!document.body.classList.contains("eq-print"));
  assert.equal(document.getElementById("eq-page-style"), null);
});

await test("a long tag gets smaller type so it fits beside the QR", async () => {
  U.push({ id: "u-long", tag: "AM-123456", type: "air_mover", make: "", model: "", rating: "", owned: "owned", status: "active", notes: "" });
  await go("#/equipment");
  btn(view, "🖨 Print labels").click();
  const d = dialog();
  d.querySelector('input[value="active"]').checked = true;
  d.querySelector('input[value="active"]').dispatchEvent(new window.Event("change"));
  btn(d, "Open the label sheet").click();
  await settle(5);
  await M.renderEquipment(view);
  await settle(300);
  const long = [...view.querySelectorAll(".eq-label:not(.eq-label--blank)")].find((l) => l.querySelector(".eq-label__tag").textContent === "AM-123456");
  assert.ok(long, "all active units print");
  assert.ok(parseFloat(long.querySelector(".eq-label__tag").style.fontSize) < 36);
  const n = view.querySelectorAll(".eq-label:not(.eq-label--blank)").length;
  assert.equal(view.querySelectorAll(".eq-page").length, Math.ceil((n + 8) / 10), "the skip stays for this visit");
  location.hash = "#/equipment";
  await settle(5);
});

await test("a sync that changes a job shows the refresh pill instead of repainting", async () => {
  await go("#/equipment");
  const pill = view.querySelector(".rl-pill");
  assert.ok(pill.hidden);
  M.equipmentChanged();
  await settle(700);
  assert.ok(pill.hidden, "nothing changed: no pill");
  const p = await Store.get(JOB2);
  p.dryingLogs[0].equipment[0].removed = wall(0);
  await Store.put(p, { bump: false, quiet: true });
  M.equipmentChanged();
  await settle(700);
  assert.ok(!pill.hidden);
  pill.click();
  await settle(80);
  assert.ok(!/On 2 jobs/.test(cardOf("Out now").textContent), "AM-14 came off Smith: no conflict now");
  assert.equal(view.querySelector(".eq-flags"), null);
  noJunk(view);
});

await test("before the database update: the fleet parts say they switch on with it; Out now still works", async () => {
  missing = true;
  await go("#/equipment");
  assert.match(cardOf("Fleet list").textContent, /Equipment switches on after this feature's database update is applied\./);
  assert.equal(cardOf("Tags seen, not in the fleet list"), undefined);
  assert.ok(bodyRows(cardOf("Out now")).length >= 5);
  assert.ok(btn(view, "🖨 Print labels").disabled);
  assert.equal(btn(view, "+ Add units"), undefined);
  await go("#/equipment/labels");
  assert.match(view.textContent, /switches on after this feature's database update is applied/);
  assert.equal(view.querySelector(".eq-page"), null);
  missing = false;
  location.hash = "#/equipment";
  await settle(5);
});

await test("a login that isn't office or crew lead sees the list with no edit controls", async () => {
  role = false;
  await go("#/equipment");
  assert.ok(fleetTags().length > 0, "it can still read the list");
  assert.equal(btn(view, "+ Add units"), undefined);
  assert.equal(btn(cardOf("Fleet list"), "Edit"), undefined);
  assert.equal(cardOf("Fleet list").querySelector("select.eq-status"), null);
  assert.match(cardOf("Fleet list").textContent, /The office or a crew lead keeps this list\./);
  const seen = cardOf("Tags seen, not in the fleet list");
  assert.ok(seen && !btn(seen, "Add"), "seen tags show, without Add");
  noJunk(view);
});

await test("admin.css: the label sheet is the Avery 5163 / 5523 layout, and fits a letter page", () => {
  const css = readFileSync(new URL("../../admin/css/admin.css", import.meta.url), "utf8");
  const rule = (sel) => {
    const m = new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css);
    assert.ok(m, "no rule for " + sel);
    return Object.fromEntries(m[2].split(";").map((d) => d.split(":").map((x) => x.trim())).filter((d) => d.length === 2 && d[0]));
  };
  const inch = (v) => { assert.match(v, /^-?[\d.]+in$|^0$/, v); return v === "0" ? 0 : parseFloat(v); };
  const page = rule(".eq-page");
  assert.equal(page["box-sizing"], "border-box");
  const [pt, pr, pb, pl] = page.padding.split(/\s+/).map(inch);
  const cols = page["grid-template-columns"].split(/\s+/).map(inch);
  const rows = /^repeat\((\d+),\s*([\d.]+in)\)$/.exec(page["grid-template-rows"]);
  const gap = inch(page["column-gap"]);
  assert.deepEqual(cols, [4, 4], "two columns of 4 in labels");
  assert.equal(Number(rows[1]), 5); assert.equal(inch(rows[2]), 2);
  assert.equal(inch(page["row-gap"]), 0);
  assert.equal(pt, 0.5, "0.5 in top margin");
  assert.equal(pl, 0.156); assert.equal(pr, 0.156);
  assert.equal(gap, 0.188);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(pl + cols[0] + gap + cols[1] + pr, 8.5), "across: 8.5 in");
  assert.ok(near(inch(page.width), 8.5));
  assert.ok(near(pt + 5 * 2 + pb, inch(page.height)), "the box is exactly its rows");
  assert.ok(near(inch(page.height) + 0.5, 11), "plus the 0.5 in bottom margin: 11 in, never over");
  const label = rule(".eq-label");
  assert.equal(inch(label.width), 4); assert.equal(inch(label.height), 2);
  assert.equal(label["box-sizing"], "border-box");
  const lp = label.padding.split(/\s+/).map(inch);
  const qr = rule(".eq-label__qr");
  assert.equal(inch(qr.width), 1.5); assert.equal(inch(qr.height), 1.5);
  assert.ok(lp[0] + 1.5 + lp[2] <= 2, "the QR fits the label's height");
  assert.ok(lp[3] + 1.5 + inch(label.gap) + lp[1] < 4 - 1.9, "about 2 in left for the tag");
  assert.match(css, /@media print \{[\s\S]*body\.eq-print > \*:not\(#view\) \{ display: none !important; \}[\s\S]*body\.eq-print \.eq-page \{[^}]*break-after: page/);
});

await test("Safari < 15.4: no Object.hasOwn, .at() or structuredClone in the tab's code", () => {
  const src = readFileSync(new URL("../../admin/js/equipment.js", import.meta.url), "utf8");
  assert.ok(!/Object\.hasOwn\(|\.at\(|structuredClone/.test(src));
  const admin = readFileSync(new URL("../../admin/js/admin.js", import.meta.url), "utf8");
  assert.match(admin, /\["#\/equipment", "Equipment"\]/, "a tab");
  assert.match(admin, /if \(hs\.startsWith\("#\/equipment"\)\) return renderEquipmentTab\(\);/, "a route");
  assert.match(admin, /!location\.hash\.startsWith\("#\/equipment"\)\) route\(\);/, "left out of the sync repaint");
  assert.match(admin, /sec\("🏷️ Equipment/, "a help section");
  assert.ok(Object.values(TAG_PREFIXES).length === 4);
});

console.log(`\n${pass} passed`);
process.exit(0);
