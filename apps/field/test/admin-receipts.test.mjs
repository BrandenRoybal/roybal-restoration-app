/* The office Receipts tab (apps/admin/js/receiptlibrary.js) — DOM render
   (jsdom), local Store (fake-indexeddb), Supabase answered by a fake fetch.
   The library, the returns-counter viewer, logging / changing / deleting a
   return, the pull-race graft, the return windows page and the
   window-closing reminder.
   Run: node apps/field/test/admin-receipts.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { register } from "node:module";
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

const dom = new JSDOM(`<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`,
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
localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "branden@roybalconstruction.com" }));

/* ---------- Supabase, faked ---------- */
const calls = [];
let role = "error";                  // "error" → officeRole() null (fail open, not cached); true; false
let missing = false;                 // 0018 not applied yet
let W = [{ vendor_key: "home depot", display_name: "Home Depot", return_days: 90, notes: "" }];
const R = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, body });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (u.includes("/rest/v1/rpc/role_is")) return role === "error" ? json(503, {}) : json(200, role);
  if (missing && /receipt_vendor|receipt_return_review/.test(u)) return json(404, { code: "PGRST205", message: "Could not find the table" });
  if (u.includes("/rest/v1/rpc/receipt_vendor_set")) {
    W = W.filter((w) => w.vendor_key !== body.p_key);
    if (body.p_days != null) W.push({ vendor_key: body.p_key, display_name: body.p_display, return_days: body.p_days, notes: body.p_notes });
    return json(200, 1);
  }
  if (u.includes("/rest/v1/rpc/receipt_return_review_set")) {
    for (const id of body.p_receipts) R.push({ job_id: body.p_job, receipt_id: id, status: body.p_status });
    return json(200, body.p_receipts.length);
  }
  if (u.includes("/rest/v1/receipt_vendors")) return json(200, W);
  if (u.includes("/rest/v1/receipt_return_reviews")) return json(200, R);
  throw new Error("unexpected fetch " + u);
};

const { Store, todayISO } = await import("../js/core.js");
const L = await import("../js/receiptlib.js");
const M = await import("../../admin/js/receiptlibrary.js");

const view = document.getElementById("view");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const go = async (hash) => { location.hash = hash; await settle(5); await M.renderReceipts(view); await settle(); };
const btn = (root, text) => [...root.querySelectorAll("button, a")].find((b) => b.textContent.trim() === text);
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const noJunk = (el) => assert.ok(!/\bnull\b|\bundefined\b|NaN/.test(el.textContent), el.textContent.match(/.{0,40}(null|undefined|NaN).{0,40}/));

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Office Receipts tab (DOM)");

/* ---------- two jobs ---------- */
const today = todayISO();
const ago = (n) => L.addDaysISO(today, -n);
const JOB = "11111111-1111-4111-8111-111111111111", JOB2 = "22222222-2222-4222-8222-222222222222";
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SLIP_IMG = IMG.replace("iVBOR", "iVBOr");
await Store.put({ id: JOB, customer: "Pollen", address: "1192 Bemis Ct", claimNo: "CLM-9", updatedAt: "2026-10-01T00:00:00.000Z", receipts: [
  { id: "R1", vendor: "THE HOME DEPOT #1234", date: ago(80), amount: "569.76", subtotal: "", tax: "", category: "materials", receiptNo: "0612-00412",
    cardLast4: "4558", paidWith: "card", by: "CJ", photo: IMG, extraPages: [], items: [
      { id: "i1", desc: '3/4" CDX plywood 4x8', qty: "10", unit: "ea", price: "52.98", sku: "166073" },
      { id: "i2", desc: "KILZ 2 all-purpose primer 1 gal", qty: "2", unit: "ea", price: "24.98", sku: "" }] },
  { id: "R2", vendor: "Home Depot", date: ago(78), amount: "120.00", category: "materials", photo: IMG,
    items: [{ id: "j1", desc: "2x4x8 stud", qty: "20", unit: "ea", price: "6.00", sku: "" }] },
  { id: "SLIP", vendor: "Home Depot", date: ago(1), amount: "", category: "materials", by: "Gregory", photo: SLIP_IMG, items: [] },
] }, { bump: false, quiet: true });
await Store.put({ id: JOB2, customer: "Smith", address: "1885 Chena Landings", updatedAt: "2026-10-01T00:00:00.000Z", receipts: [
  { id: "S1", vendor: "Spenard Builders Supply", date: ago(5), amount: "88.10", category: "materials", items: [] },
] }, { bump: false, quiet: true });
const credits = async (job = JOB) => ((await Store.get(job)).receipts || []).filter((r) => r && r.kind === "return");

await test("the library lists every job's receipts newest first, sums them, and flags the closing Home Depot window", async () => {
  await go("#/receipts");
  const rows = view.querySelectorAll(".rl-row");
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /Home Depot.*No total|Home Depot—/s, "the $0 slip, newest");
  assert.match(view.querySelector(".rl-sum").textContent, /^4 receipts · \$777\.86 net$/);
  const flags = view.querySelector(".rl-flags");
  assert.ok(flags, "the reminder shows once the windows load");
  assert.match(flags.textContent, /Home Depot on 1192 Bemis Ct — closes in 10 days/);
  assert.match(flags.textContent, /2 receipts · \$689\.76 · 90-day window/);
  assert.equal(view.querySelector(".rl-nudge"), null, "windows are set: no set-up nudge");
  noJunk(view);
});

await test("search: every word, inch marks ignored, the matching item line shown; a miss says so", async () => {
  const search = view.querySelector(".rl-search");
  type(search, '3/4" plywood');
  await settle(220);
  const rows = view.querySelectorAll(".rl-row");
  assert.equal(rows.length, 1);
  assert.match(rows[0].querySelector(".rl-lines").textContent, /CDX plywood 4x8 × 10 — \$52\.98/);
  type(search, "plywood spenard");
  await settle(220);
  assert.equal(view.querySelectorAll(".rl-row").length, 0);
  assert.match(view.textContent, /Nothing matches “plywood spenard”/);
  type(search, "");
  await settle(220);
  assert.equal(view.querySelectorAll(".rl-row").length, 4);
});

await test("🧾 puts the photo full screen with vendor · date · total · # · card; Esc closes it", async () => {
  const r1 = [...view.querySelectorAll(".rl-row")].find((r) => /0612-00412/.test(r.textContent));
  r1.querySelector(".rl-show").click();
  await settle();
  const ov = document.querySelector(".rl-view");
  assert.ok(ov);
  assert.match(ov.querySelector(".rl-view__facts").textContent, /THE HOME DEPOT #1234.*\$569\.76 · #0612-00412 · ••4558/s);
  assert.equal(ov.querySelectorAll("img").length, 1);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.querySelector(".rl-view"), null);
});

await test("a receipt's page: facts, items, its return window, and the job's total", async () => {
  await go(`#/receipts/${JOB}/R1`);
  assert.match(view.querySelector("h1").textContent, /THE HOME DEPOT #1234/);
  assert.match(view.textContent, /\$569\.76/);
  assert.match(view.textContent, /Home Depot takes returns for 90 days: last day .* \(closes in 10 days\)\./);
  assert.equal(view.querySelectorAll(".minitable tbody tr").length, 2);
  assert.ok(btn(view, "↩ Log a return").getAttribute("href").endsWith(`/${JOB}/R1/return`));
  assert.match(view.textContent, /1192 Bemis Ct · 3 receipts\$689\.76/);
  noJunk(view);
});

let before, creditId;
await test("log a return: qty prefills the refund, a double click saves one credit, the job moves 1 ms", async () => {
  await go(`#/receipts/${JOB}/R1/return`);
  before = await Store.get(JOB);
  const qtys = view.querySelectorAll(".rl-item input[type=number]");
  assert.equal(qtys.length, 3, "R1's two items, then R2's stud under 'another receipt'");
  assert.match(view.querySelector("details summary").textContent, /another Home Depot receipt on this job too\? \(1\)/);
  type(qtys[0], "3");
  const refund = view.querySelector(".rl-money");
  assert.equal(refund.value, "158.94");
  const opts = [...view.querySelectorAll("select option")].map((o) => o.textContent);
  assert.ok(opts.some((t) => /Home Depot · .* · Gregory/.test(t)), "the crew's $0 slip is offered");
  const save = btn(view, "Save return");
  save.click(); save.click();
  await settle(80);
  const cs = await credits();
  assert.equal(cs.length, 1, "one credit, not two");
  const c = cs[0];
  creditId = c.id;
  assert.equal(c.amount, "-158.94");
  assert.equal(c.returnOf, "R1");
  assert.deepEqual(c.items.map((l) => [l.of, l.ofReceipt, l.qty, l.price]), [["i1", "R1", "3", "-52.98"]]);
  assert.equal(c.by, "branden@roybalconstruction.com");
  const after = await Store.get(JOB);
  assert.equal(after.updatedAt, L.nextStamp(before.updatedAt), "append-only stamp, not now()");
  assert.equal(location.hash, `#/receipts/${JOB}/R1`);
  assert.equal(after.receipts.find((r) => r.id === "R1").amount, "569.76", "the original receipt is untouched");
});

await test("the receipt now shows what went back; the job total is net", async () => {
  await M.renderReceipts(view); await settle();
  assert.match(view.textContent, /↩ \$158\.94 returned/);
  assert.match(view.querySelector(".minitable thead").textContent, /Returned/);
  assert.match(view.textContent, /−\$158\.94/);
  assert.match(view.textContent, /\$530\.82 after returns/);
});

await test("a refund over what's left is refused until 'store credit or exchange' is ticked", async () => {
  await go(`#/receipts/${JOB}/R2/return`);
  type(view.querySelector(".rl-money"), "9999");
  btn(view, "Save return").click();
  await settle(80);
  const warn = view.querySelector(".warn");
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /more than what's left on those receipts|more than what's left on the receipt/);
  assert.equal((await credits()).length, 1);
});

await test("a sync that writes the server's older copy over the save gets the credit put back", async () => {
  await Store.put(JSON.parse(JSON.stringify(before)), { bump: false, quiet: true });   // the pull race
  assert.equal((await credits()).length, 0);
  await M.graft(JOB);
  const back = await credits();
  assert.equal(back.length, 1);
  assert.equal(back[0].id, creditId);
  const stamp = (await Store.get(JOB)).updatedAt;
  assert.equal(stamp, L.nextStamp(before.updatedAt));
  await M.graft(JOB);
  assert.equal((await Store.get(JOB)).updatedAt, stamp, "nothing lost: no second write");
});

await test("a slip the crew snapped as a $0 receipt moves onto the return and leaves the list", async () => {
  await go(`#/receipts/${JOB}/R2/return`);
  type(view.querySelector(".rl-item input[type=number]"), "5");
  assert.equal(view.querySelector(".rl-money").value, "30.00");
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "SLIP"));
  sel.value = "SLIP";
  sel.dispatchEvent(new window.Event("change"));
  assert.match(view.querySelector(".rl-slipview").textContent, /moves onto the return/);
  btn(view, "Save return").click();
  await settle(80);
  const p = await Store.get(JOB);
  assert.equal(p.receipts.some((r) => r.id === "SLIP"), false);
  assert.ok(p.deletedIds && p.deletedIds.SLIP, "tombstoned, so a phone's copy can't bring it back");
  const c = p.receipts.find((r) => r.kind === "return" && r.returnOf === "R2");
  assert.equal(c.photo, SLIP_IMG);
  assert.equal(c.amount, "-30.00");
});

await test("change a return: the old credit is replaced (tombstoned) by a new one", async () => {
  await go(`#/receipts/${JOB}/${creditId}/change`);
  const qty = view.querySelector(".rl-item input[type=number]");
  assert.equal(qty.value, "3", "prefilled from the credit");
  assert.equal(view.querySelector(".rl-money").value, "158.94");
  type(qty, "2");
  assert.equal(view.querySelector(".rl-money").value, "158.94", "a logged refund is never re-guessed");
  type(view.querySelector(".rl-money"), "105.96");
  btn(view, "Save changes").click();
  await settle(80);
  const p = await Store.get(JOB);
  assert.equal(p.receipts.some((r) => r.id === creditId), false);
  assert.ok(p.deletedIds[creditId]);
  const c = p.receipts.find((r) => r.kind === "return" && r.returnOf === "R1");
  assert.equal(c.amount, "-105.96");
  assert.equal(c.items[0].qty, "2");
  assert.equal(location.hash, `#/receipts/${JOB}/${c.id}`);
  creditId = c.id;
});

await test("a return's own page reads read-only facts and deletes cleanly", async () => {
  await M.renderReceipts(view); await settle();
  assert.match(view.querySelector("h1").textContent, /^↩ Return · THE HOME DEPOT #1234/);
  assert.match(view.textContent, /Return of.*THE HOME DEPOT #1234 .* \$569\.76/s);
  assert.match(view.textContent, /CDX plywood 4x8 × 2/);
  btn(view, "Delete return").click();
  await settle(80);
  const p = await Store.get(JOB);
  assert.equal(p.receipts.some((r) => r.id === creditId), false);
  assert.ok(p.deletedIds[creditId]);
  assert.equal(location.hash, `#/receipts/${JOB}/R1`);
});

await test("Today shows the reminder; 'Nothing left over' clears the group in one call", async () => {
  const slot = document.createElement("div"); view.replaceChildren(slot);
  await M.fillReturnsToday(slot, await Store.all());
  assert.match(slot.textContent, /Home Depot on 1192 Bemis Ct — closes in 10 days/);
  assert.match(slot.textContent, /1 receipt · \$569\.76/, "R2 has a return now, so only R1 asks");
  btn(slot, "Nothing left over").click();
  await settle(80);
  const call = calls.filter((c) => c.u.includes("rpc/receipt_return_review_set")).pop();
  assert.deepEqual(call.body, { p_job: JOB, p_receipts: ["R1"], p_status: "nothing_to_return" });
  assert.equal(slot.querySelector(".rl-flag"), null);
  const again = document.createElement("div"); view.replaceChildren(again);
  await M.fillReturnsToday(again, await Store.all());
  assert.equal(again.textContent, "", "cleared for good");
});

await test("return windows: every store from the receipts, set one, see it saved through the door", async () => {
  await go("#/receipts/vendors");
  const rows = [...view.querySelectorAll(".rl-vrow")];
  const names = rows.map((r) => r.querySelector("strong") && r.querySelector("strong").textContent);
  assert.ok(names.includes("Home Depot") && names.includes("Spenard Builders Supply"));
  const sp = rows.find((r) => /Spenard/.test(r.textContent));
  assert.match(sp.textContent, /1 receipt · \$88\.10/);
  type(sp.querySelector("input.rl-days"), "30");
  btn(sp, "Save").click();
  await settle(80);
  const call = calls.filter((c) => c.u.includes("rpc/receipt_vendor_set")).pop();
  assert.deepEqual(call.body, { p_key: "spenard builders supply", p_days: 30, p_display: "Spenard Builders Supply", p_notes: "" });
  assert.match(sp.textContent, /✓ Saved/);
  noJunk(view);
});

await test("a phone's change under an open library shows the refresh pill instead of repainting", async () => {
  await go("#/receipts");
  const pill = view.querySelector(".rl-pill");
  assert.equal(pill.hidden, true);
  const p = await Store.get(JOB2);
  p.receipts.push({ id: "S2", vendor: "Spenard Builders Supply", date: today, amount: "12.00", category: "materials", items: [] });
  await Store.put(p);
  await settle(1000);
  assert.equal(pill.hidden, false);
  assert.equal(view.querySelectorAll(".rl-row").length, 4, "the list on screen didn't move (R1, R2, R2's return, S1)");
  pill.click(); await settle(80);
  assert.equal(view.querySelectorAll(".rl-row").length, 5);
});

await test("⚙ Settings card links to the windows page", async () => {
  const slot = document.createElement("div"); view.replaceChildren(slot);
  M.fillSettingsCard(slot); await settle();
  assert.match(slot.textContent, /🧾 Receipt return windows.* 2 stores set\./s);
  assert.equal(btn(slot, "Set return windows").getAttribute("href"), "#/receipts/vendors");
});

await test("before the database update lands, the library still works and windows say why they're off", async () => {
  missing = true;
  await go("#/receipts/vendors");
  assert.match(view.textContent, /switch on after this feature's database update is applied/);
  await go("#/receipts");
  assert.equal(view.querySelectorAll(".rl-row").length, 5);
  missing = false;
});

await test("a crew login on the windows page is told the office sets them", async () => {
  role = false;
  await go("#/receipts/vendors");
  assert.match(view.textContent, /Return windows are set by the office\./);
  assert.equal(view.querySelectorAll("input.rl-days").length, 0);
});

console.log(`\n${pass} passed`);
process.exit(0);
