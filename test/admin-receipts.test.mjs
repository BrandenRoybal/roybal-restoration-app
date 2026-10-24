/* The office Receipts tab (apps/admin/js/receiptlibrary.js) — DOM render
   (jsdom), local Store (fake-indexeddb), Supabase answered by a fake fetch.
   The library, the returns-counter viewer, logging / changing / deleting a
   return, the pull races (compare-and-swap, graft), two devices changing
   one return, the phone check, the return windows page, the
   window-closing reminder, and QuickBooks (0023): each receipt's badge and
   the job's project link; then 0025's bills, receipts paid in parts, a
   refused charge, a cancelled change and a second try's card.
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
let floorN = 202;                    // app_settings min_field_build, as field_build_floor reads it
let W = [{ vendor_key: "home depot", display_name: "Home Depot", return_days: 90, notes: "" }];
const R = [];
let qboMissing = false;              // 0023 not applied yet
let qboProxyOld = false;             // a qbo-proxy from before phase 3: no listProjects
let QL = [];                         // job_qbo_links
const QR = [];                       // receipt_qbo_links
let PROPS = [];                      // proposals (0025: the card holding a failed receipt's second try)
let propsAnswer = 200;               // 403: a login that can't read proposals
// listProjects rows as qbo-proxy compacts them (ids from the Oct 7 read)
const PROJECTS = [
  { id: "444", name: "1192 Bemis Ct.", fqn: "1192 Bemis Ct.", parentId: "", isProject: true },
  { id: "112", name: "Pollen Apartments", fqn: "Pollen Apartments", parentId: "", isProject: true },
  { id: "514", name: "Smith addition", fqn: "Smith:Smith addition", parentId: "88", isProject: false },
];
// PostgREST pages: limit/offset honoured, so a read past 1000 rows must page
const page = (rows, u) => {
  const q = new URL(u).searchParams;
  const off = Number(q.get("offset") || 0), lim = Number(q.get("limit") || rows.length);
  return rows.slice(off, off + lim);
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, body });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (u.includes("/rest/v1/rpc/role_is")) return role === "error" ? json(503, {}) : json(200, role);
  if (qboMissing && /\/rest\/v1\/(job_qbo_links|receipt_qbo_links|rpc\/job_qbo_link_set)/.test(u)) {
    return json(404, { code: "PGRST205", message: "Could not find the table 'public.job_qbo_links' in the schema cache" });
  }
  if (u.includes("/rest/v1/rpc/job_qbo_link_set")) {
    if (body.p_job_id === JOB2) return json(400, { code: "P0002", message: "job_qbo_link_set: no job " + JOB2 });   // not synced up yet
    QL = QL.filter((l) => l.job_id !== body.p_job_id);
    if (!body.p_qbo_customer_id) return json(200, null);
    const row = { job_id: body.p_job_id, qbo_customer_id: body.p_qbo_customer_id, qbo_project_ref: body.p_qbo_project_ref,
      qbo_name: body.p_qbo_name, source: "picked", set_by_kind: "human" };
    QL.push(row);
    return json(200, row);
  }
  if (u.includes("/rest/v1/job_qbo_links")) return json(200, page(QL, u));
  if (u.includes("/rest/v1/receipt_qbo_links")) {
    const ids = JSON.parse("[" + new URL(u).searchParams.get("receipt_id").match(/^in\.\((.*)\)$/)[1] + "]");
    return json(200, QR.filter((r) => ids.includes(r.receipt_id)));
  }
  if (u.includes("/rest/v1/proposals")) {
    if (propsAnswer !== 200) return json(propsAnswer, { code: "42501", message: "permission denied for table proposals" });
    const ids = JSON.parse("[" + new URL(u).searchParams.get("id").match(/^in\.\((.*)\)$/)[1] + "]");
    return json(200, PROPS.filter((p) => ids.includes(p.id)).map(({ id, status }) => ({ id, status })));
  }
  if (u.includes("/functions/v1/qbo-proxy")) {
    if (qboProxyOld) return json(404, { ok: false, error: "Unknown action: listProjects" });
    return json(200, { projects: PROJECTS, ok: true, data: { projects: PROJECTS } });   // both places, as qbo-proxy answers
  }
  if (missing && /receipt_vendor|receipt_return_review|field_build_floor/.test(u)) return json(404, { code: "PGRST205", message: "Could not find the table" });
  if (u.includes("/rest/v1/rpc/field_build_floor")) {
    return role === false ? json(403, { code: "42501", message: "only the office can read the field app build floor" }) : json(200, floorN);
  }
  // a save nudges the sync; this test has no server for it
  if (/\/rest\/v1\/(rpc\/sync_|field_projects|rpc\/field_)/.test(u)) return json(503, { message: "no sync server in this test" });
  if (u.includes("/rest/v1/rpc/receipt_vendor_set")) {
    W = W.filter((w) => w.vendor_key !== body.p_key);
    if (body.p_days != null) W.push({ vendor_key: body.p_key, display_name: body.p_display, return_days: body.p_days, notes: body.p_notes });
    return json(200, 1);
  }
  if (u.includes("/rest/v1/rpc/receipt_return_review_set")) {
    for (const id of body.p_receipts) R.push({ job_id: body.p_job, receipt_id: id, status: body.p_status });
    return json(200, body.p_receipts.length);
  }
  if (u.includes("/rest/v1/receipt_vendors")) return json(200, page(W, u));
  if (u.includes("/rest/v1/receipt_return_reviews")) return json(200, page(R, u));
  throw new Error("unexpected fetch " + u);
};

const { Store, todayISO } = await import("../js/core.js");
const L = await import("../js/receiptlib.js");
const M = await import("../../admin/js/receiptlibrary.js");

const view = document.getElementById("view");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const go = async (hash) => { location.hash = hash; await settle(5); await M.renderReceipts(view); await settle(); };
const enc = encodeURIComponent;
const btn = (root, text) => [...root.querySelectorAll("button, a")].find((b) => b.textContent.trim() === text);
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const toastText = () => document.getElementById("toast").textContent;
// letters, not \b, around the word: a stray null glued between "$49.96" and
// "1192" is junk too
const noJunk = (el) => assert.ok(!/(?<![A-Za-z])(null|undefined|NaN)(?![A-Za-z])/.test(el.textContent), el.textContent.match(/.{0,40}(null|undefined|NaN).{0,40}/));

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Office Receipts tab (DOM)");

/* ---------- two jobs ---------- */
const today = todayISO();
const ago = (n) => L.addDaysISO(today, -n);
const JOB = "11111111-1111-4111-8111-111111111111", JOB2 = "22222222-2222-4222-8222-222222222222";
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SLIP_IMG = IMG.replace("iVBOR", "iVBOr");
await Store.put({ id: JOB, customer: "Pollen", address: "1192 Bemis Ct", claimNo: "CLM-9", qbJobcodeName: "1192 Bemis Ct.", updatedAt: "2026-10-01T00:00:00.000Z", receipts: [
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
  r1.querySelector(".rl-show").click();          // a double click
  await settle();
  assert.equal(document.querySelectorAll(".rl-view").length, 1, "one viewer, not two stacked");
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

await test("the cap is the room on the receipt the items came from, not the one the form started from", async () => {
  await go(`#/receipts/${JOB}/R1/return`);
  const qtys = view.querySelectorAll(".rl-item input[type=number]");
  type(qtys[2], "1");                                  // one of R2's studs only
  type(view.querySelector(".rl-money"), "130");        // R1 has $410 left; R2 has $120
  btn(view, "Save return").click();
  await settle(80);
  assert.match(view.querySelector(".warn").textContent, /more than what's left on the receipt \(\$120\.00\)/);
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

await test("choosing the slip picker's placeholder again leaves the crew's slip where it was", async () => {
  await go(`#/receipts/${JOB}/R2/return`);
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "SLIP"));
  sel.value = "SLIP"; sel.dispatchEvent(new window.Event("change"));
  assert.match(view.querySelector(".rl-slipview").textContent, /moves onto the return/);
  sel.value = ""; sel.dispatchEvent(new window.Event("change"));
  assert.match(view.querySelector(".rl-slipview").textContent, /No slip photo yet/);
});

await test("a slip the crew snapped moves onto the return; a sync landing mid-save keeps the crew's work", async () => {
  await go(`#/receipts/${JOB}/R2/return`);
  type(view.querySelector(".rl-item input[type=number]"), "5");
  assert.equal(view.querySelector(".rl-money").value, "30.00");
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "SLIP"));
  sel.value = "SLIP";
  sel.dispatchEvent(new window.Event("change"));
  assert.match(view.querySelector(".rl-slipview").textContent, /moves onto the return/);
  // a pull lands between the save's read and its write: a crew note on R1
  const putIf = Store.putIf;
  let raced = 0;
  Store.putIf = async function (proj, seen) {
    if (!raced++) {
      const crew = await Store.get(JOB);
      crew.receipts.find((r) => r.id === "R1").notes = "crew: 2 sheets left in the garage";
      crew.updatedAt = "2026-10-05T12:00:00.000Z";
      await Store.put(crew, { bump: false, quiet: true });
    }
    return putIf.call(this, proj, seen);
  };
  try {
    btn(view, "Save return").click();
    await settle(120);
  } finally { Store.putIf = putIf; }
  assert.equal(raced, 2, "the first write saw the row move and tried again");
  const p = await Store.get(JOB);
  assert.equal(p.receipts.find((r) => r.id === "R1").notes, "crew: 2 sheets left in the garage", "the crew's newer work survived");
  assert.equal(p.updatedAt, L.nextStamp("2026-10-05T12:00:00.000Z"), "stamped past the copy it landed on");
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
  assert.equal(c.id, creditId + "~1", "the changed return's id is derived, not random");
  assert.equal(c.amount, "-105.96");
  assert.equal(c.items[0].qty, "2");
  assert.equal(location.hash, `#/receipts/${JOB}/${enc(c.id)}`);
  creditId = c.id;
});

await test("another device changed the same return first: this form says so instead of doubling the refund", async () => {
  await go(`#/receipts/${JOB}/${enc(creditId)}/change`);
  type(view.querySelector(".rl-money"), "52.98");
  // the other device's change arrives by sync while this form is open
  const p = await Store.get(JOB);
  const old = p.receipts.find((r) => r.id === creditId);
  p.receipts = p.receipts.filter((r) => r.id !== creditId);
  p.receipts.push({ ...old, id: L.successorId(creditId), amount: "-100.00" });
  p.deletedIds[creditId] = new Date().toISOString();
  p.updatedAt = "2026-10-05T13:00:00.000Z";
  await Store.put(p, { bump: false, quiet: true });
  btn(view, "Save changes").click();
  await settle(80);
  assert.match(view.querySelector(".warn").textContent, /changed on another device/);
  const cs = (await credits()).filter((c) => c.returnOf === "R1");
  assert.deepEqual(cs.map((c) => [c.id, c.amount]), [[L.successorId(creditId), "-100.00"]], "still one return: theirs");
  creditId = L.successorId(creditId);
  await go(`#/receipts/${JOB}/${enc(creditId)}`);
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
  assert.ok(p.deletedIds[L.successorId(creditId)], "and the id a change in flight on another device would write");
  assert.ok(p.deletedIds[L.movedId(creditId)], "or a move in flight");
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
  assert.equal(slot.textContent, "", "the last group cleared: no empty card left behind");
  const again = document.createElement("div"); view.replaceChildren(again);
  await M.fillReturnsToday(again, await Store.all());
  assert.equal(again.textContent, "", "cleared for good");
});

await test("past PostgREST's 1000-row cap the cleared list pages, so a cleared flag stays cleared", async () => {
  const junk = Array.from({ length: 1200 }, (_, i) => ({ job_id: JOB2, receipt_id: "old-" + i, status: "nothing_to_return" }));
  R.unshift(...junk);                                   // R1's answer is now row 1200, on the second page
  await go("#/receipts/vendors");                       // a fresh read
  const reads = calls.filter((c) => c.u.includes("/rest/v1/receipt_return_reviews")).slice(-2).map((c) => new URL(c.u).searchParams);
  assert.deepEqual(reads.map((q) => [q.get("offset"), q.get("limit")]), [["0", "1000"], ["1000", "1000"]]);
  assert.equal(reads[0].get("order"), "job_id,receipt_id", "a stable order to page by");
  const slot = document.createElement("div"); view.replaceChildren(slot);
  await M.fillReturnsToday(slot, await Store.all());
  assert.equal(slot.textContent, "", "R1 stays cleared");
  R.splice(0, junk.length);
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

/* ---------- QuickBooks (0023): each receipt's state, each job's project ---------- */
const idOf = (rowEl) => decodeURIComponent(rowEl.querySelector(".rl-row__main").getAttribute("href").split("/").pop());
const rowFor = (id) => [...view.querySelectorAll(".rl-row")].find((r) => idOf(r) === id);
const badgesOf = (el) => [...el.querySelectorAll(".badge")].map((b) => b.textContent);
const qboReads = (from) => calls.slice(from).filter((c) => c.u.includes("/rest/v1/receipt_qbo_links"));
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const saveIn = (pick) => [...pick.querySelectorAll("button")].find((b) => /^Link/.test(b.textContent));
const jobFilter = (id) => {
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === JOB));
  sel.value = id; sel.dispatchEvent(new window.Event("change"));
};

await test("each receipt says where it stands with QuickBooks, from one select of the receipts on screen", async () => {
  const ret = (await credits()).find((c) => c.returnOf === "R2");
  QR.push(
    { receipt_id: "R1", state: "in_qbo", qbo_txn_id: "10577", detail: { qbo_account_name: "3176 - Citi - Home Depot Consumer Credit Card" } },
    { receipt_id: "R2", state: "unmatched", qbo_txn_id: null, detail: { reason: "waiting_feed" } },
    { receipt_id: ret.id, state: "queued", qbo_txn_id: "10580", detail: {} },
    { receipt_id: "S1", state: "conflict", qbo_txn_id: "10563", detail: { reason: "tagged_other", qbo_customer_name: "Pollen Apartments" } },
    { receipt_id: "S2", state: "failed", qbo_txn_id: "10566", detail: { error: "tagged_other: expense 10566 is already tagged to Pollen Apartments in QuickBooks" } },
    { receipt_id: "NOT-ON-SCREEN", state: "done", qbo_txn_id: "1", detail: {} });
  const from = calls.length;
  await go("#/receipts");
  const reads = qboReads(from);
  assert.equal(reads.length, 1, "one select");
  const asked = JSON.parse("[" + new URL(reads[0].u).searchParams.get("receipt_id").slice(4, -1) + "]");
  assert.deepEqual(asked.sort(), [...view.querySelectorAll(".rl-row")].map(idOf).sort(), "the ids on screen, no others");
  assert.ok(badgesOf(rowFor("R1")).includes("In QuickBooks ✓ #10577"));
  assert.match(rowFor("R1").querySelector(".badge.disp-g[title]").title, /QuickBooks expense 10577 · 3176 - Citi/);
  assert.ok(badgesOf(rowFor("R2")).includes("Waiting for the bank feed"));
  assert.ok(badgesOf(rowFor(ret.id)).includes("Waiting on QuickBooks"));
  assert.deepEqual(badgesOf(rowFor("S1")), ["Check in QuickBooks: tagged to Pollen Apartments"]);
  assert.equal(rowFor("S1").querySelector(".rl-badges").hidden, false, "a row with no other badge shows its line once the badge lands");
  assert.deepEqual(badgesOf(rowFor("S2")), ["QuickBooks refused: expense 10566 is already tagged to Pollen Apartments in QuickBooks"]);
  noJunk(view);
  // a search repaints the rows from what this page already read
  type(view.querySelector(".rl-search"), "spenard");
  await settle(220);
  assert.equal(qboReads(from).length, 1, "nothing asked twice");
  assert.deepEqual(badgesOf(rowFor("S1")), ["Check in QuickBooks: tagged to Pollen Apartments"]);
  type(view.querySelector(".rl-search"), "");
  await settle(220);
});

await test("every QuickBooks state reads in the office's words", async () => {
  const t = (state, detail = {}, txn = null) => (M.qboStatus({ state, qbo_txn_id: txn, detail }) || {}).text;
  assert.equal(t("in_qbo", {}, "10577"), "In QuickBooks ✓ #10577");
  assert.equal(t("done", {}, "10519"), "In QuickBooks ✓ #10519");
  assert.equal(t("done"), "In QuickBooks ✓", "a store entry before its id came back");
  assert.equal(t("queued"), "Waiting on QuickBooks");
  assert.equal(t("unmatched", { reason: "waiting_feed" }), "Waiting for the bank feed");
  assert.equal(t("unmatched", { reason: "store_not_entered" }), "Not in QuickBooks yet");
  // a dump ticket is booked as a Bill, which the match doesn't read: never "not in QuickBooks"
  assert.equal(t("unmatched", { reason: "bill_not_checked" }), "Booked as a bill: not checked");
  assert.equal(t("unmatched", { reason: "needs_job_link" }), "Link the job to QuickBooks");
  assert.equal(t("unmatched", { reason: "not_found" }), "No QuickBooks match");
  assert.equal(t("unmatched", { reason: "constructor" }), "No QuickBooks match", "a reason this page doesn't know");
  assert.equal(t("conflict", { reason: "ambiguous" }), "Check in QuickBooks: more than one expense matches");
  assert.equal(t("conflict", { reason: "partly_tagged" }), "Check in QuickBooks: only part of the expense is tagged to a job");
  assert.equal(t("conflict", { reason: "tagged_other" }), "Check in QuickBooks: tagged to another job");
  assert.equal(t("conflict", { reason: "claimed_by_other" }), "Check in QuickBooks: another receipt has this expense");
  assert.equal(t("failed", { error: "changed_in_qbo: expense 10577 changed in QuickBooks since the card was filed" }),
    "QuickBooks refused: expense 10577 changed in QuickBooks since the card was filed");
  // a refusal is QuickBooks (or the card) saying no; anything else outlasted the retries without QuickBooks answering
  assert.equal(t("failed"), "Couldn't update QuickBooks: the change didn't go through");
  assert.equal(t("failed", { error: "qbo_not_connected: QuickBooks is not connected" }), "Couldn't update QuickBooks: QuickBooks is not connected");
  assert.equal(t("failed", { error: "qbo-proxy unreachable: fetch failed" }), "Couldn't update QuickBooks: qbo-proxy unreachable: fetch failed");
  assert.equal(t("failed", { error: "lease expired (held by w1)" }), "Couldn't update QuickBooks: lease expired (held by w1)");
  assert.equal(t("failed", { error: "photo_type: the stored photo is image/heic" }), "QuickBooks refused: the stored photo is image/heic");
  // the tag (or the new entry) went in and the photo didn't: not a ✓, and not "refused"
  assert.equal(t("done", { provider_status: "tagged=done;attached=0;attach_error=qbo_refused" }, "10577"),
    "Tagged in QuickBooks #10577; photo not attached: QuickBooks refused it");
  assert.equal(t("done", { provider_status: "tagged=done;attached=0;attach_error=photo_type" }),
    "Tagged in QuickBooks; photo not attached: the photo isn't a JPEG, PNG or PDF");
  assert.equal(t("done", { provider_status: "tagged=done;attached=1" }, "10577"), "In QuickBooks ✓ #10577");
  const long = "qbo_refused: QuickBooks refused the change (400 / 6000): " + "a business validation error ".repeat(10);
  const f = M.qboStatus({ state: "failed", qbo_txn_id: "10577", detail: { error: long } });
  assert.ok(f.text.length <= "QuickBooks refused: ".length + 140 && f.text.endsWith("…"), "the badge clips a long refusal");
  assert.equal(f.title, "QuickBooks expense 10577 · " + long, "the whole of it on hover");
  assert.equal(M.qboStatus({ state: "in_qbo", qbo_txn_id: "1", detail: {} }).tone, "disp-g");
  assert.equal(M.qboStatus({ state: "failed", detail: {} }).tone, "disp-r");
  // the refusal codes are the approvals card's (a field export the admin page itself never imports)
  const { QBO_REFUSED } = await import("../js/approvals.js");
  assert.deepEqual([...M.QBO_REFUSED_CODES].sort(), Object.keys(QBO_REFUSED).sort());
  assert.equal(M.qboStatus(null), null);
  assert.equal(M.qboStatus({ state: "something_new", detail: {} }), null, "a state this page doesn't know shows nothing");
});

/* ---------- 0025: bills, a receipt paid in parts, a cancel, a second try ---------- */
// FNSB dump ticket 01286734 → Bill 10625; Rental Zone 995d2795 ($351.00) =
// Purchase 10615 ($126.90, Oct 2) + 10661 ($224.10, Oct 7), card 1658
const BILL_DETAIL = { qbo_doc_number: "01286734", qbo_account_name: "Accounts Payable (A/P)", qbo_total: 34.04 };
const RZ_ACCOUNT = "1658 - Bank of America AK Air CC";
const rzParts = (t1 = "0", t2 = "0") => [
  { qbo_txn_id: "10615", qbo_sync_token: t1, qbo_total: 126.9, qbo_date: "2026-10-02" },
  { qbo_txn_id: "10661", qbo_sync_token: t2, qbo_total: 224.1, qbo_date: "2026-10-07" }];
const CARD_OPEN = "cccccccc-0000-4000-8000-0000000000c1", CARD_NO = "cccccccc-0000-4000-8000-0000000000c2";
const CARD_RAN = "cccccccc-0000-4000-8000-0000000000c3", CARD_GONE = "cccccccc-0000-4000-8000-0000000000c4";

await test("0025 in the office's words: a bill, a receipt in parts, a refused charge, the new reasons, a cancel and a second try", async () => {
  const st = (row, card) => M.qboStatus(row, card) || {};
  // a bill is only ever noted: in QuickBooks, untagged, or not entered yet
  const bill = st({ state: "in_qbo", qbo_txn_type: "Bill", qbo_txn_id: "10625", qbo_sync_token: "0", parts: null, detail: BILL_DETAIL });
  assert.deepEqual([bill.text, bill.tone, bill.title],
    ["In QuickBooks ✓ bill #10625", "disp-g", "QuickBooks bill 10625 · Accounts Payable (A/P) · doc # 01286734"]);
  assert.equal(st({ state: "conflict", qbo_txn_type: "Bill", qbo_txn_id: "10625", parts: null, detail: { reason: "bill_untagged", ...BILL_DETAIL } }).text,
    "Check in QuickBooks: booked as a bill without a job: tag it in QuickBooks");
  const notEntered = st({ state: "unmatched", detail: { reason: "bill_not_entered" } });
  assert.deepEqual([notEntered.text, notEntered.tone], ["No matching QuickBooks bill yet", "disp-x"]);
  assert.equal(st({ state: "unmatched", detail: { reason: "bill_not_checked" } }).text, "Booked as a bill: not checked", "the bills couldn't be read that night");
  assert.equal(st({ state: "unmatched", qbo_txn_type: "Bill", qbo_txn_id: "10625", detail: { reason: "needs_job_link" } }).text, "Link the job to QuickBooks");
  // a receipt paid in two card charges: both named, in and done alike
  const split = { state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0", parts: rzParts(),
    detail: { qbo_account_name: RZ_ACCOUNT, qbo_total: 351 } };
  assert.deepEqual([st(split).text, st(split).tone, st(split).title],
    ["In QuickBooks ✓ #10615 + #10661", "disp-g", "QuickBooks expenses 10615 + 10661 · " + RZ_ACCOUNT]);
  const sent = (status) => ({ ...split, state: "done", qbo_sync_token: "1", parts: rzParts("1", "1"),
    detail: { ...split.detail, provider_id: "Purchase:10615:1", provider_status: status } });
  assert.equal(st(sent("tagged=done;attached=2;parts=10615:1,10661:1")).text, "In QuickBooks ✓ #10615 + #10661");
  assert.equal(st(sent("tagged=done;attached=1;parts=10615:1,10661:1;attach_error=photo_unreadable")).text,
    "Tagged in QuickBooks #10615 + #10661; photo not attached: the photo couldn't be read");
  // the later charge refused after the first was tagged: done, and it says which
  const refused = st(sent("tagged=done;attached=1;parts=10615:1,10661:0;part_error=changed_in_qbo"));
  assert.deepEqual([refused.text, refused.tone],
    ["Tagged #10615 in QuickBooks; #10661 refused: changed in QuickBooks since the card was filed", "disp-b"]);
  assert.equal(st(sent("tagged=done;attached=1;parts=10615:1,10661:0;part_error=tagged_other;attach_error=upload_refused")).text,
    "Tagged #10615 in QuickBooks; #10661 refused: tagged to another job; photo not attached: QuickBooks refused it");
  const three = { ...sent("tagged=done;attached=0;parts=10615:1,10616:1,10661:0;part_error=frobbed"),
    parts: [rzParts("1")[0], { qbo_txn_id: "10616", qbo_sync_token: "1", qbo_total: 94, qbo_date: "2026-10-03" }, rzParts()[1]] };
  assert.equal(st(three).text, "Tagged #10615 in QuickBooks; #10616 or #10661 refused: frobbed", "three charges: which later one isn't told");
  assert.equal(st({ state: "done", qbo_txn_id: "10615", detail: { provider_status: "tagged=done;part_error=qbo_refused" } }).text,
    "Tagged #10615 in QuickBooks; a charge refused: QuickBooks refused it");
  // more than one set of charges adds up
  assert.equal(st({ state: "conflict", qbo_txn_type: null, qbo_txn_id: null,
    detail: { reason: "ambiguous_split", candidates: ["10615", "10661", "10700", "10701"] } }).text,
  "Check in QuickBooks: more than one set of charges adds up to it");
  // the office cancelled it: its own words, neutral, never "QuickBooks refused"
  for (const [error, text] of [["cancelled: marked dead by hand", "Cancelled: marked dead by hand"],
    ["cancelled: Branden: wrong job, tagged by hand", "Cancelled: Branden: wrong job, tagged by hand"], ["cancelled:", "Cancelled"],
    ["Cancelled: wrong job", "Cancelled: wrong job"], ["cancelled", "Cancelled"]]) {
    const c = st({ state: "failed", qbo_txn_id: "10577", detail: { error } });
    assert.deepEqual([c.text, c.tone, c.title], [text, "disp-x", "QuickBooks expense 10577 · " + error], error);
  }
  assert.ok(!M.QBO_REFUSED_CODES.includes("cancelled"), "cancelled is no refusal");
  // a second try that died of the same code: the matcher won't offer a third
  const down = "qbo_unavailable: QuickBooks 503: Service Unavailable";
  const twice = { state: "failed", qbo_txn_id: "10577",
    detail: { error: down, refile: { proposal_id: CARD_RAN, error: "qbo_unavailable", why: "QuickBooks 503" } } };
  assert.deepEqual([st(twice).text, st(twice).tone],
    ["Couldn't update QuickBooks: QuickBooks 503: Service Unavailable · Tried twice; needs a fix", "disp-r"]);
  assert.equal(st({ ...twice, detail: { ...twice.detail, refile: { proposal_id: null, error: "relinked" } } }).text,
    "Couldn't update QuickBooks: QuickBooks 503: Service Unavailable", "a second try that died of something else");
  assert.equal(st({ state: "failed", detail: { error: "lease expired", refile: { error: "failed" } } }).text,
    "Couldn't update QuickBooks: lease expired · Tried twice; needs a fix", "no code either time");
  // the card holding its second try: open, or answered without it
  const refiled = { state: "failed", qbo_txn_id: "10577",
    detail: { error: "relinked: the job was linked to another QuickBooks project", refiled_proposal_id: CARD_OPEN } };
  assert.equal(st(refiled, "proposed").text, "QuickBooks refused: the job was linked to another QuickBooks project · On a new card in Approvals");
  assert.equal(st(refiled, "declined").text, "QuickBooks refused: the job was linked to another QuickBooks project · Second try declined in Approvals");
  assert.equal(st(refiled, "executed").text, "QuickBooks refused: the job was linked to another QuickBooks project · Second try declined in Approvals");
  for (const card of [undefined, "", "expired", "superseded", "constructor", null, 7]) {
    assert.equal(st(refiled, card).text, "QuickBooks refused: the job was linked to another QuickBooks project", String(card));
  }
  assert.equal(st({ ...twice, detail: { ...twice.detail, refiled_proposal_id: CARD_OPEN } }, "proposed").text,
    "Couldn't update QuickBooks: QuickBooks 503: Service Unavailable · On a new card in Approvals", "the open card is the news");
  // stamped with a later card this login can't read (owner-only), or one that
  // expired: its next try exists, so it is not "tried twice"
  for (const card of ["", "expired", "superseded", undefined]) {
    assert.equal(st({ ...twice, detail: { ...twice.detail, refiled_proposal_id: CARD_OPEN } }, card).text,
      "Couldn't update QuickBooks: QuickBooks 503: Service Unavailable", String(card));
  }
  // a row from before 0025 (no parts key, no type) reads exactly as it did, and so does parts: null
  for (const [row, text] of [
    [{ state: "in_qbo", qbo_txn_id: "10577", detail: { qbo_account_name: "3176 - Citi" } }, "In QuickBooks ✓ #10577"],
    [{ state: "done", qbo_txn_id: "10577", detail: { provider_status: "tagged=done;attached=0;attach_error=qbo_refused" } },
      "Tagged in QuickBooks #10577; photo not attached: QuickBooks refused it"],
    [{ state: "failed", qbo_txn_id: "10566", detail: { error: "tagged_other: expense 10566 is already tagged" } },
      "QuickBooks refused: expense 10566 is already tagged"],
  ]) {
    assert.deepEqual(M.qboStatus(row), M.qboStatus({ ...row, parts: null, qbo_txn_type: "Purchase" }));
    assert.equal(M.qboStatus(row).text, text);
    if (row.state === "in_qbo") assert.equal(M.qboStatus(row).title, "QuickBooks expense 10577 · 3176 - Citi");
  }
  assert.equal(st({ ...split, parts: "10615,10661" }).text, "In QuickBooks ✓ #10615", "parts that aren't a list: the row's own id");
});

await test("0025 on screen: every column read (a database without 0025 answers too), a split and a bill named, each second try's card read in one more select", async () => {
  const saved = QR.splice(0);
  const ret = (await credits()).find((c) => c.returnOf === "R2");
  PROPS = [{ id: CARD_OPEN, status: "proposed" }, { id: CARD_NO, status: "declined" }];
  QR.push(
    { receipt_id: "R1", state: "done", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "1", parts: rzParts("1", "1"),
      detail: { qbo_account_name: RZ_ACCOUNT, qbo_total: 351, provider_status: "tagged=done;attached=2;parts=10615:1,10661:1" } },
    { receipt_id: "R2", state: "failed", qbo_txn_type: "Purchase", qbo_txn_id: "10519", parts: null,
      detail: { error: "qbo_unavailable: QuickBooks 503: Service Unavailable", refiled_proposal_id: CARD_OPEN.toUpperCase() } },
    { receipt_id: "S1", state: "in_qbo", qbo_txn_type: "Bill", qbo_txn_id: "10625", parts: null, detail: BILL_DETAIL },
    { receipt_id: "S2", state: "failed", qbo_txn_id: "10566",
      detail: { error: "relinked: the job was linked to another QuickBooks project", refiled_proposal_id: CARD_NO } },
    { receipt_id: ret.id, state: "failed", qbo_txn_id: "10600", detail: { error: "cancelled: marked dead by hand", refiled_proposal_id: CARD_GONE } });
  const cardReads = (from) => calls.slice(from).filter((c) => c.u.includes("/rest/v1/proposals"));
  const qbBadges = (id) => badgesOf(rowFor(id)).filter((b) => /QuickBooks|Cancelled/.test(b));
  try {
    let from = calls.length;
    await go("#/receipts");
    const reads = qboReads(from);
    assert.equal(reads.length, 1);
    assert.equal(new URL(reads[0].u).searchParams.get("select"), "*", "no column list: naming parts would answer 400 before 0025");
    assert.equal(cardReads(from).length, 1, "one select of the cards");
    const q = new URL(cardReads(from)[0].u).searchParams;
    assert.equal(q.get("select"), "id,status");
    assert.deepEqual(JSON.parse("[" + q.get("id").slice(4, -1) + "]").sort(), [CARD_OPEN, CARD_NO, CARD_GONE].sort(), "each card once");
    assert.deepEqual(qbBadges("R1"), ["In QuickBooks ✓ #10615 + #10661"]);
    assert.match(rowFor("R1").querySelector(".badge.disp-g[title]").title, /^QuickBooks expenses 10615 \+ 10661 · 1658 - Bank of America AK Air CC$/);
    assert.deepEqual(qbBadges("R2"), ["Couldn't update QuickBooks: QuickBooks 503: Service Unavailable · On a new card in Approvals"]);
    assert.deepEqual(badgesOf(rowFor("S1")), ["In QuickBooks ✓ bill #10625"]);
    assert.deepEqual(badgesOf(rowFor("S2")), ["QuickBooks refused: the job was linked to another QuickBooks project · Second try declined in Approvals"]);
    assert.deepEqual(qbBadges(ret.id), ["Cancelled: marked dead by hand"], "a card it can't find: nothing more");
    assert.equal(rowFor(ret.id).querySelector(".badge.disp-x[title]").title, "QuickBooks expense 10600 · cancelled: marked dead by hand");
    noJunk(view);
    // a search repaints from what this page already read: neither is asked again
    type(view.querySelector(".rl-search"), "home depot");
    await settle(220);
    assert.equal(cardReads(from).length, 1, "nothing asked twice");
    assert.equal(qboReads(from).length, 1);
    type(view.querySelector(".rl-search"), "");
    await settle(220);
    // a login that can't read proposals, or a read that fails: the badges, with no card line
    for (const answer of [403, 503]) {
      propsAnswer = answer;
      from = calls.length;
      await go("#/receipts");
      assert.equal(cardReads(from).length, 1, String(answer));
      assert.deepEqual(qbBadges("R2"), ["Couldn't update QuickBooks: QuickBooks 503: Service Unavailable"], String(answer));
      assert.deepEqual(badgesOf(rowFor("S1")), ["In QuickBooks ✓ bill #10625"], String(answer));
    }
    propsAnswer = 200;
    // no failed row names a card: proposals isn't read at all
    for (const r of QR) delete r.detail.refiled_proposal_id;
    from = calls.length;
    await go("#/receipts");
    assert.equal(cardReads(from).length, 0);
    // the receipt's own page reads it too
    QR.find((r) => r.receipt_id === "R2").detail.refiled_proposal_id = CARD_NO;
    from = calls.length;
    await go(`#/receipts/${JOB}/R2`);
    assert.equal(cardReads(from).length, 1);
    assert.ok(badgesOf(view.querySelector(".rl-badges"))
      .includes("Couldn't update QuickBooks: QuickBooks 503: Service Unavailable · Second try declined in Approvals"));
  } finally {
    propsAnswer = 200;
    PROPS = [];
    QR.splice(0, QR.length, ...saved);
  }
});

await test("Link to QuickBooks: the picker starts on the QuickBooks Time match, searches, and saves through job_qbo_link_set", async () => {
  await go("#/receipts");
  assert.equal(button(view, "Link to QuickBooks"), undefined, "no job header while every job is listed");
  jobFilter(JOB);
  await settle();
  assert.match(view.textContent, /1192 Bemis CtLink to QuickBooks/);
  const from = calls.length;
  button(view, "Link to QuickBooks").click();
  await settle();
  const pick = document.querySelector(".rl-qbo-pick");
  assert.ok(pick, "the picker opened");
  assert.deepEqual(calls.slice(from).filter((c) => c.u.includes("/functions/v1/qbo-proxy")).map((c) => c.body), [{ action: "listProjects" }]);
  assert.equal(pick.querySelectorAll("[aria-pressed]").length, 3);
  assert.match(pick.querySelector('[aria-pressed="true"]').textContent, /^1192 Bemis Ct\..*QuickBooks Time match/);
  assert.match(pick.textContent, /Smith:Smith addition.*sub-customer/);
  assert.equal(saveIn(pick).textContent, "Link to 1192 Bemis Ct.");
  type(pick.querySelector("input[type=search]"), "pollen apart");
  assert.deepEqual([...pick.querySelectorAll("[aria-pressed]")].map((b) => b.textContent), ["Pollen Apartments"]);
  pick.querySelector("[aria-pressed]").click();
  assert.equal(saveIn(pick).textContent, "Link to Pollen Apartments");
  const sv = saveIn(pick);
  sv.click(); sv.click();                          // a double click
  await settle(80);
  const sets = calls.slice(from).filter((c) => c.u.includes("rpc/job_qbo_link_set"));
  assert.deepEqual(sets.map((c) => c.body), [{ p_job_id: JOB, p_qbo_customer_id: "112", p_qbo_name: "Pollen Apartments", p_qbo_project_ref: null }], "one save");
  assert.equal(document.querySelector(".rl-qbo-pick"), null, "closed");
  assert.match(view.textContent, /QuickBooks: Pollen Apartments · Change/);
  assert.match(toastText(), /1192 Bemis Ct is linked to Pollen Apartments in QuickBooks\. The next QuickBooks check uses it\./);
  noJunk(view);
  jobFilter("");                                       // every job again, for the tests after
  await settle();
  assert.equal(button(view, "Change"), undefined, "the header goes with the filter");
});

await test("a receipt's page shows its QuickBooks badge and the job's project; Change starts on it, Unlink clears it", async () => {
  await go(`#/receipts/${JOB}/R1`);
  assert.ok(badgesOf(view.querySelector(".rl-badges")).includes("In QuickBooks ✓ #10577"));
  assert.match(view.textContent, /after returnsQuickBooks: Pollen Apartments · ChangeAll of this job's receipts ›/, "in the job card");
  assert.doesNotMatch(view.textContent, /null/, "no stray null where a receipt has no returns card");
  button(view, "Change").click();
  await settle();
  const pick = document.querySelector(".rl-qbo-pick");
  assert.match(pick.textContent, /Linked now: Pollen Apartments\./);
  assert.match(pick.querySelector('[aria-pressed="true"]').textContent, /^Pollen Apartments.*linked now/);
  assert.equal(saveIn(pick).textContent, "Linked");
  assert.equal(saveIn(pick).disabled, true, "saving the same project again is not offered");
  const from = calls.length;
  button(pick, "Unlink").click();
  await settle(80);
  assert.deepEqual(calls.slice(from).filter((c) => c.u.includes("rpc/job_qbo_link_set")).map((c) => c.body),
    [{ p_job_id: JOB, p_qbo_customer_id: "", p_qbo_name: "", p_qbo_project_ref: null }]);
  assert.deepEqual(QL, []);
  assert.equal(document.querySelector(".rl-qbo-pick"), null);
  assert.ok(button(view, "Link to QuickBooks"), "back to the link button");
  noJunk(view);
});

await test("a qbo-proxy without listProjects yet: the picker says so and saves nothing", async () => {
  qboProxyOld = true;
  await go(`#/receipts/${JOB}/R1`);
  const from = calls.length;
  button(view, "Link to QuickBooks").click();
  await settle();
  const pick = document.querySelector(".rl-qbo-pick");
  assert.match(pick.textContent, /The QuickBooks project list isn't available yet\./);
  assert.equal(saveIn(pick).disabled, true);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.querySelector(".rl-qbo-pick"), null, "Esc closes it");
  assert.equal(calls.slice(from).filter((c) => c.u.includes("rpc/job_qbo_link_set")).length, 0);
  qboProxyOld = false;
});

await test("a job with no QuickBooks Time match starts with nothing picked; a job the server hasn't seen says so", async () => {
  await go(`#/receipts/${JOB2}/S1`);
  button(view, "Link to QuickBooks").click();
  await settle();
  const pick = document.querySelector(".rl-qbo-pick");
  assert.equal(pick.querySelector('[aria-pressed="true"]'), null, "nothing picked for the office");
  assert.equal(saveIn(pick).textContent, "Link");
  assert.equal(saveIn(pick).disabled, true);
  [...pick.querySelectorAll("[aria-pressed]")].find((b) => /^Smith addition/.test(b.textContent)).click();
  saveIn(pick).click();
  await settle(80);
  assert.ok(document.querySelector(".rl-qbo-pick"), "stays open to try again");
  assert.match(pick.querySelector(".warn").textContent, /This job hasn't reached the server yet\. Try again after it syncs\./);
  assert.equal(saveIn(pick).disabled, false);
  button(pick, "Cancel").click();
  assert.equal(document.querySelector(".rl-qbo-pick"), null);
  assert.ok(button(view, "Link to QuickBooks"), "still unlinked");
});

await test("before 0023 lands, the receipts show with no QuickBooks badge or link, quietly", async () => {
  qboMissing = true;
  const from = calls.length;
  await go("#/receipts");
  assert.equal(view.querySelectorAll(".rl-row").length, 5);
  assert.doesNotMatch(view.textContent, /QuickBooks/);
  jobFilter(JOB);
  await settle();
  assert.doesNotMatch(view.textContent, /QuickBooks/, "no job header either");
  await go(`#/receipts/${JOB}/R1`);
  assert.doesNotMatch(view.textContent, /QuickBooks/);
  assert.ok(view.querySelector(".rl-facts"), "the rest of the page is all there");
  assert.equal(qboReads(from).length, 0, "job_qbo_links' 404 stops the badge read too");
  assert.equal(document.querySelector(".warn"), null);
  qboMissing = false;
  await go("#/receipts");
  jobFilter("");
  await settle();
  assert.equal(view.querySelectorAll(".rl-row").length, 5);
});

await test("before the database update lands, the library still works and windows say why they're off", async () => {
  missing = true;
  await go("#/receipts/vendors");
  assert.match(view.textContent, /switch on after this feature's database update is applied/);
  await go("#/receipts");
  assert.equal(view.querySelectorAll(".rl-row").length, 5);
  await go(`#/receipts/${JOB}/R1/return`);
  assert.match(view.textContent, /Logging returns switches on after this feature's database update/);
  assert.equal(view.querySelector(".rl-form"), null);
  missing = false;
});

await test("logging a return waits until the server requires Field Forms v202 or later", async () => {
  floorN = 0;                                           // no floor: an old phone could still save
  await go("#/receipts/vendors");                       // a fresh check
  await go(`#/receipts/${JOB}/R1/return`);
  assert.match(view.textContent, /once every phone is required to run Field Forms v202 or later/);
  assert.equal(view.querySelector(".rl-form"), null);
  assert.equal(localStorage.getItem("roybal-receipt-floor"), "0", "remembered for an offline open");
  floorN = 201;
  await go("#/receipts/vendors");
  await go(`#/receipts/${JOB}/R1/return`);
  assert.equal(view.querySelector(".rl-form"), null, "a floor under v202 still lets v201 save");
  floorN = 203;
  await go("#/receipts/vendors");
  await go(`#/receipts/${JOB}/R1/return`);
  assert.ok(view.querySelector(".rl-form"), "v202 or later required: the form opens");
  floorN = 202;
});

await test("a late render after the office moved to another tab leaves that tab alone", async () => {
  location.hash = "#/jobs"; await settle(5);
  view.replaceChildren(document.createTextNode("the Jobs table"));
  await M.renderReceipts(view); await settle();
  assert.equal(view.textContent, "the Jobs table");
});

await test("a crew login on the windows page is told the office sets them", async () => {
  role = false;
  await go("#/receipts/vendors");
  assert.match(view.textContent, /Return windows are set by the office\./);
  assert.equal(view.querySelectorAll("input.rl-days").length, 0);
  await go(`#/receipts/${JOB}/R1/return`);
  assert.match(view.textContent, /Returns are logged by the office\./);
});

await test("a crew login gets no QuickBooks link control (the door and the project list are office-only)", async () => {
  QL.push({ job_id: JOB, qbo_customer_id: "112", qbo_project_ref: null, qbo_name: "Pollen Apartments", source: "picked" });
  await go(`#/receipts/${JOB}/R1`);
  assert.equal(button(view, "Change"), undefined);
  assert.equal(button(view, "Link to QuickBooks"), undefined);
  assert.doesNotMatch(view.textContent, /QuickBooks: Pollen/);
  QL = [];
});

await test("changing a return logged as store credit keeps its override, so it saves", async () => {
  role = "error"; floorN = 202;
  await go("#/receipts/vendors");
  const p = await Store.get(JOB2);
  p.receipts.push({ id: "SC", kind: "return", returnOf: "S1", vendor: "Spenard Builders Supply", date: today, amount: "-150.00",
    category: "materials", notes: "↩ Return of Spenard Builders Supply receipt — store credit", items: [] });
  await Store.put(p);
  await go(`#/receipts/${JOB2}/SC/change`);
  const over = view.querySelector(".rl-check input[type=checkbox]");
  assert.equal(over.checked, true, "$150 back on an $88.10 receipt: ticked already");
  btn(view, "Save changes").click();
  await settle(80);
  const after = (await Store.get(JOB2)).receipts.filter((r) => r && r.kind === "return");
  assert.deepEqual(after.map((r) => [r.id, r.amount]), [["SC~1", "-150.00"]]);
});

/* ---------- a third job: changes that move, crew retakes, slips, re-reads ---------- */
const JOB3 = "33333333-3333-4333-8333-333333333333";
const SLIP_RETAKE = IMG.replace("iVBOR", "iVBOz"), SLIP_OTHER = IMG.replace("iVBOR", "iVBOy");
const { mergeProjects, tombstoneItems } = await import("../js/merge.js");
const { receiptTotals } = await import("../js/receiptcalc.js");
const qtyFor = (desc) => view.querySelector(`input[aria-label="Quantity returned: ${desc}"]`);
await Store.put({ id: JOB3, customer: "Keepers", address: "3981 Fahrenkamp", updatedAt: "2026-10-01T00:00:00.000Z", receipts: [
  { id: "A", vendor: "Home Depot", date: ago(10), amount: "20.00", category: "materials", items: [{ id: "a1", desc: "duct tape", qty: "2", unit: "ea", price: "10.00" }] },
  { id: "B", vendor: "Home Depot", date: ago(9), amount: "120.00", category: "materials", items: [{ id: "b1", desc: "2x4x8 stud", qty: "20", unit: "ea", price: "6.00" }] },
  { id: "c0", kind: "return", returnOf: "A", vendor: "Home Depot", date: ago(8), amount: "-10.00", category: "materials",
    notes: "↩ Return of Home Depot receipt", items: [{ id: "c0-1", of: "a1", ofReceipt: "A", desc: "duct tape", qty: "1", price: "-10.00" }] },
] }, { bump: false, quiet: true });
let movedId = null;

await test("a change that moves a return onto another receipt gets a moved id, so a phone deleting the first receipt leaves it", async () => {
  const stale = structuredClone(await Store.get(JOB3));     // a crew phone that synced before the change
  const desk = structuredClone(stale);                      // a second office device, same copy
  await go(`#/receipts/${JOB3}/c0/change`);
  type(qtyFor("duct tape"), "0");
  type(qtyFor("2x4x8 stud"), "5");
  type(view.querySelector(".rl-money"), "30.00");
  btn(view, "Save changes").click();
  await settle(80);
  const office = await Store.get(JOB3);
  const c = office.receipts.find((r) => r && r.kind === "return");
  assert.equal(c.returnOf, "B");
  assert.equal(c.id, "c0~m1", "derived, but outside the phone's reach");
  for (const id of L.returnLineage("c0")) assert.ok(office.deletedIds[id], id + " closed, so an in-place change elsewhere can't add a copy");
  assert.ok(!office.deletedIds["c0~m1"], "never its own id");
  movedId = c.id;
  // the desk deleted c0 before it heard of the move: the delete wins
  const del = structuredClone(desk), kill = L.returnFamily("c0");
  del.receipts = del.receipts.filter((r) => !kill.includes(r.id));
  tombstoneItems(del, kill);
  del.updatedAt = "2026-10-06T08:00:00.000Z";
  for (const { merged } of [mergeProjects(office, del), mergeProjects(del, office)]) {
    assert.deepEqual(merged.receipts.filter((r) => r.kind === "return"), [], "a deleted return stays deleted");
    assert.equal(receiptTotals(merged).total, 140);
  }
  // the desk made a move of its own (a wider one): the same id, so one return
  const wide = structuredClone(desk);
  wide.receipts = wide.receipts.filter((r) => r.id !== "c0");
  wide.receipts.push({ ...c, amount: "-40.00", items: [...c.items, { id: "c0~m1-2", of: "a1", ofReceipt: "A", desc: "duct tape", qty: "1", price: "-10.00" }] });
  tombstoneItems(wide, L.returnFamily("c0").filter((x) => x !== "c0~m1"));
  wide.updatedAt = "2026-10-06T08:30:00.000Z";
  for (const { merged } of [mergeProjects(office, wide), mergeProjects(wide, office)]) {
    assert.deepEqual(merged.receipts.filter((r) => r.kind === "return").map((r) => r.id), ["c0~m1"], "one return, not two");
  }
  // the phone deletes A from its older copy, where c0 still sits on A alone
  const plan = L.deletePlan(stale, "A");
  assert.deepEqual(plan.kill, ["A", ...L.returnLineage("c0")]);
  stale.receipts = stale.receipts.filter((r) => !plan.kill.includes(r.id));
  tombstoneItems(stale, plan.kill);
  stale.updatedAt = "2026-10-06T09:00:00.000Z";
  for (const { merged } of [mergeProjects(office, stale), mergeProjects(stale, office)]) {
    assert.deepEqual(merged.receipts.map((r) => r.id).sort(), ["B", movedId].sort(), "the moved return survives the phone's delete");
    assert.equal(receiptTotals(merged).total, 90);
  }
});

await test("a moved return moves again (and back) without tripping over its own ids", async () => {
  await go(`#/receipts/${JOB3}/${enc(movedId)}/change`);
  type(qtyFor("2x4x8 stud"), "0");
  type(qtyFor("duct tape"), "1");
  type(view.querySelector(".rl-money"), "10.00");
  btn(view, "Save changes").click();
  await settle(80);
  const p = await Store.get(JOB3);
  const rs = p.receipts.filter((r) => r && r.kind === "return");
  assert.deepEqual(rs.map((r) => [r.id, r.returnOf, r.amount]), [["c0~m2", "A", "-10.00"]]);
  assert.ok(p.deletedIds["c0~m1"]);
  movedId = "c0~m2";
});

await test("Delete on a return page drawn before another device changed it past reach says so", async () => {
  await go(`#/receipts/${JOB3}/${enc(movedId)}`);
  const p = await Store.get(JOB3);                         // that device's delete lands by sync
  p.receipts = p.receipts.filter((r) => r.id !== movedId);
  tombstoneItems(p, L.returnFamily(movedId));
  p.updatedAt = "2026-10-06T09:30:00.000Z";
  await Store.put(p, { bump: false, quiet: true });
  btn(view, "Delete return").click();
  await settle(80);
  assert.match(toastText(), /changed or deleted on another device/);
  const after = await Store.get(JOB3);
  assert.equal(after.updatedAt, "2026-10-06T09:30:00.000Z", "nothing written");
});

await test("a crew retake that syncs in while the form is open is the slip that moves over", async () => {
  const p = await Store.get(JOB3);
  p.receipts.push({ id: "SLIP3", vendor: "Home Depot", date: today, amount: "", category: "materials", by: "CJ", photo: SLIP_IMG, items: [] });
  await Store.put(p, { bump: false, quiet: true });
  await go(`#/receipts/${JOB3}/B/return`);
  type(qtyFor("2x4x8 stud"), "1");
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "SLIP3"));
  sel.value = "SLIP3"; sel.dispatchEvent(new window.Event("change"));
  const crew = await Store.get(JOB3);                         // the crew's Retake lands by sync
  crew.receipts.find((r) => r.id === "SLIP3").photo = SLIP_RETAKE;
  crew.updatedAt = "2026-10-06T10:00:00.000Z";
  await Store.put(crew, { bump: false, quiet: true });
  btn(view, "Save return").click();
  await settle(80);
  const after = await Store.get(JOB3);
  const c = after.receipts.find((r) => r && r.kind === "return" && r.id !== movedId);
  assert.equal(c.photo, SLIP_RETAKE, "the retake, not the photo the form saw when it was picked");
  assert.ok(after.deletedIds.SLIP3);
});

await test("on a change, un-picking a crew slip brings back the return's own slip photo", async () => {
  const p = await Store.get(JOB3);
  p.receipts.push({ id: "SLIP4", vendor: "Home Depot", date: today, amount: "", category: "materials", by: "CJ", photo: SLIP_OTHER, items: [] });
  await Store.put(p, { bump: false, quiet: true });
  const c = p.receipts.find((r) => r && r.kind === "return" && r.id !== movedId);
  await go(`#/receipts/${JOB3}/${enc(c.id)}/change`);
  const shown = () => { const img = view.querySelector(".rl-slipview img"); return img ? img.getAttribute("src") : view.querySelector(".rl-slipview").textContent; };
  assert.equal(shown(), SLIP_RETAKE);
  const sel = [...view.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "SLIP4"));
  sel.value = "SLIP4"; sel.dispatchEvent(new window.Event("change"));
  assert.equal(shown(), SLIP_OTHER);
  sel.value = ""; sel.dispatchEvent(new window.Event("change"));
  assert.equal(shown(), SLIP_RETAKE, "the placeholder puts the return's own slip back");
  sel.value = "SLIP4"; sel.dispatchEvent(new window.Event("change"));
  btn(view.querySelector(".rl-slipview"), "Remove").click();
  assert.equal(shown(), SLIP_RETAKE, "so does Remove on a crew slip");
  btn(view, "Save changes").click();
  await settle(80);
  const after = await Store.get(JOB3);
  const changed = after.receipts.find((r) => r && r.id === L.successorId(c.id));
  assert.equal(changed.photo, SLIP_RETAKE);
  assert.ok(after.receipts.some((r) => r.id === "SLIP4") && !after.deletedIds.SLIP4, "the crew's other slip stays a receipt");
});

await test("a return whose item was read again since won't open in Change: it says to delete and log it again", async () => {
  const p = await Store.get(JOB3);
  const b = p.receipts.find((r) => r.id === "B");
  b.items = [{ id: "b9", desc: "STUD 2X4 8FT KD", qty: "20", unit: "ea", price: "6.00" }];   // ✨ Read again on a phone
  p.updatedAt = "2026-10-06T11:00:00.000Z";
  await Store.put(p, { bump: false, quiet: true });
  const onB = p.receipts.find((r) => r && r.kind === "return" && r.returnOf === "B");
  await go(`#/receipts/${JOB3}/${enc(onB.id)}/change`);
  assert.match(view.textContent, /no longer matches its receipt.*Delete this return and log it again/s);
  assert.equal(view.querySelector(".rl-form"), null);
});

const stray = calls.filter((c) => !/\/rest\/v1\/(rpc\/role_is|rpc\/receipt_|rpc\/field_build_floor|receipt_vendors|receipt_return_reviews|job_qbo_links|receipt_qbo_links|proposals|rpc\/job_qbo_link_set)|\/functions\/v1\/qbo-proxy/.test(c.u));
console.log("  (sync nudges: " + [...new Set(stray.map((c) => c.u.replace(/\?.*$/, "")))].join(", ") + ")");
console.log(`\n${pass} passed`);
process.exit(0);
