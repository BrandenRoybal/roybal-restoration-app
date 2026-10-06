/* The office Approvals tab (apps/admin/js/approvals.js) — DOM render (jsdom),
   Supabase and the roybal-notify function answered by a fake fetch that
   throws on anything it doesn't expect. The owner sees both queues merged
   and ordered with their evidence; Approve and Decline on each lane send
   exactly the right request; every refusal renders its sentence under the
   card; the "function not updated yet" fallback sends him to YES / NO by
   text; Recently decided says what came of each; the expired line; the nav
   badge; and any other login sees one line and nothing is read for it.
   Then review round 1: one card's answer in flight leaves the others usable;
   an owner check that can't answer offers Retry and is asked again; a
   retired kind of ask can still be declined; a row that never reported back
   says so; a skipped phase says so at once; evidence links show their host;
   the whole email shows; one hand-made row can't take the tab down.
   Then review round 2: a row seen at 'approved' waits a few minutes (and
   for as long as this tab's own answer is out) before it says it never
   reported back; a re-read that raced the executed stamp still says Sent;
   the real host comes before a link's label; and on a Safari without
   Object.hasOwn every card still shows, with asks that won't read said out
   loud.
   Then spine step 5: a waiting spine card offers its YES number (and no
   card does for a number live on both queues), a spine email on a field
   job names it, the page reads the newest worker heartbeat only when a
   spine email is shown and says when email sending is off (a heartbeat
   that won't read says nothing new), and the page calls no field export
   that a stale cached copy of the field module could lack. Then step 5
   review round 1: the lane-off lines promise only the worker's 48 hours,
   and a send the worker gave up on after its card aged off shows again,
   named, for 48 hours from when it did. Then step 5 review round 2: so
   does one whose proposal is older than the page's 7-day read (its dead
   outbox row is read, then that proposal by id), and either of those
   reads failing leaves the tab as it was.
   Run: node apps/field/test/admin-approvals.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

// the office admin imports field modules as "../../js/x.js" (one origin, two
// folders on the server); on disk they live in apps/field/js. A second copy
// of the tab (approvals.js?as=crew) keeps its own once-per-page owner check,
// so it starts over for the other login.
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL && ctx.parentURL.includes("/apps/admin/js/") && spec.startsWith("../../js/")) {
    return next(new URL(spec.replace("../../js/", "../../field/js/"), ctx.parentURL).href, ctx);
  }
  const r = await next(spec, ctx);
  return r.url.includes("/apps/admin/js/") ? { ...r, format: "module" } : r;   // no package.json there
}`));

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <nav id="anav"><a href="#/approvals">Approvals<span id="approvalsBadge" class="navbadge" hidden></span></a></nav>
  <main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/admin/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "KeyboardEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
const asked = [];                     // every confirm() / prompt() the page raised
let confirmAnswer = true, promptAnswer = "";
window.confirm = (m) => { asked.push(m); return confirmAnswer; };
window.prompt = (m) => { asked.push(m); return promptAnswer; };
globalThis.confirm = window.confirm;
globalThis.prompt = window.prompt;
localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "branden@roybalconstruction.com" }));

/* ---------- the two queues ---------- */
const NOW = Date.now();
const iso = (hrs) => new Date(NOW + hrs * 3600e3).toISOString();
const FIELD1 = "11111111-1111-4111-8111-111111111111";
const BOARD1 = "22222222-2222-4222-8222-222222222222";
const AGENT = "1af33481-7f1c-4485-87f5-7b0ec5e27554";
const id = (lane, n) => (lane === "text" ? "aaaaaaaa" : "bbbbbbbb") + `-0000-4000-8000-${String(n).padStart(12, "0")}`;

const reminder = { id: id("text", 1), code: 12, kind: "emailSend", proposed_by: "morning-brief", status: "pending",
  label: "email the INV-1001 reminder to Pollen", job_id: FIELD1, created_at: iso(-3), expires_at: iso(21), executed_at: null, result: null,
  params: { to: "pollen@example.com", subject: "Invoice INV-1001 is past due", body: "Hi Jane,\n\nA reminder that INV-1001 ($1,240.00) was due Sep 30.\n\nThank you,\nRoybal Construction", jobId: FIELD1, invoiceKey: FIELD1 + ":INV-1001" } };
const phase = { id: id("text", 2), code: 13, kind: "boardEdit", proposed_by: "qb-time", status: "pending",
  label: 'add phase "Demo" to Smith remodel (12h logged)', job_id: BOARD1, created_at: iso(-13), expires_at: iso(11), executed_at: null, result: null,
  params: { op: "addPhase", rowId: BOARD1, phase: { id: "p1", name: "Demo", estimatedHours: 12 } } };
const email = { id: id("spine", 1), operation: "email.send@1", sms_code: 4, status: "proposed",
  input: { to: "adjuster@carrier.com", subject: "Estimate for claim 9", body: "Attached is the estimate for claim 9." }, edited_params: null,
  proposed_by_kind: "agent", proposed_by_id: AGENT, rationale: "The adjuster asked for it on Monday.",
  evidence_refs: [{ label: "Email from the adjuster", url: "https://mail.google.com/mail/u/0/#inbox/1" }],
  job_id: BOARD1, created_at: iso(-2), expires_at: iso(4), approved_at: null, updated_at: iso(-2), decline_reason: null, result: null, error: null };
const sent = { ...reminder, id: id("text", 3), code: 11, status: "executed", created_at: iso(-27), expires_at: iso(-3), executed_at: iso(-25) };
const failed = { ...phase, id: id("text", 4), status: "failed", created_at: iso(-12), expires_at: iso(12),
  result: { error: "the board job changed while this was pending — nothing was added" } };
const delivered = { ...email, id: id("spine", 2), status: "executed", approved_at: iso(-5), updated_at: iso(-5) };
const declined = { ...email, id: id("spine", 3), status: "declined", updated_at: iso(-6), decline_reason: "Already called them" };
const lapsed = { ...phase, id: id("text", 5), created_at: iso(-30), expires_at: iso(-6) };
const swept = { ...phase, id: id("text", 6), status: "expired", created_at: iso(-60), expires_at: iso(-36) };
const stale = { ...email, id: id("spine", 4), expires_at: iso(-20) };
let PA = [reminder, phase, sent, failed, lapsed, swept];
let PR = [email, delivered, declined, stale];
const CATALOG = [{ name: "email.send", version: 1, description: "Send one email. Execution writes one outbox row; the worker delivers it through Gmail." }];
let OUTBOX = [{ proposal_id: delivered.id, status: "delivered", next_attempt_at: iso(-5), error: null, created_at: iso(-5) }];
/* the newest worker heartbeat, as of the page's clock: sending email unless a test says otherwise */
const beatAt = (minsAgo, channels) => () => json(200, [{ at: new Date(Date.now() - minsAgo * 60e3).toISOString(),
  meta: { channels, email: channels.includes("email"), kinds: ["report"] } }]);
let heartbeat = beatAt(0.5, ["sms", "email"]);       // () => Response, or throws

/* ---------- Supabase and roybal-notify, faked ---------- */
const calls = [];
let roles = { owner: true, office: false };
let roleIs = null;                    // (body) => Response: overrides role_is's answer (a 503, a throw)
let notify = null;                    // (body) => Response | Promise<Response>
let spine = null;                     // (fn, body) => Response
const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const ids = (u, col) => ((new URL(u).searchParams.get(col) || "").match(/^in\.\((.*)\)$/) || [, ""])[1].split(",").filter(Boolean);
const since = (u) => Date.parse((new URL(u).searchParams.get("expires_at") || "").replace(/^gte\./, ""));
const live = (rows, open) => rows.filter((r) => r.status === open && Date.parse(r.expires_at) > Date.now());
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  const headers = opts.headers || {};
  calls.push({ u, body, headers });
  const counted = (rows) => json(200, [], { "Content-Range": rows.length ? `0-0/${rows.length}` : "*/0" });
  if (u.includes("/rest/v1/rpc/role_is")) return roleIs ? roleIs(body) : json(200, roles[body.p_roles.join(",")] === true);
  if (u.includes("/auth/v1/token?grant_type=refresh_token")) return json(200, { access_token: "t", refresh_token: "r", expires_in: 3600 });
  if (u.includes("/functions/v1/roybal-notify")) return notify(body);
  if (u.includes("/rest/v1/rpc/op_proposal_")) return spine(u.match(/rpc\/(\w+)/)[1], body);
  if (u.includes("/rest/v1/pending_actions?")) {
    if (headers.Range === "0-0") return counted(live(PA, "pending"));
    assert.match(u, /select=id,code,kind,label,params,job_id,proposed_by,status,result,created_at,expires_at,executed_at&/);
    return json(200, PA.filter((r) => Date.parse(r.expires_at) >= since(u)));
  }
  if (u.includes("/rest/v1/proposals?")) {
    if (headers.Range === "0-0") return counted(live(PR, "proposed"));
    assert.match(u, /select=id,operation,input,edited_params,/);
    assert.match(u, /select=[^&]*,sms_code&/, "the spine's YES number is read");
    // the proposals of sends that died lately, by id, whatever their expiry
    if (new URL(u).searchParams.has("id")) return json(200, PR.filter((r) => ids(u, "id").includes(r.id)));
    return json(200, PR.filter((r) => Date.parse(r.expires_at) >= since(u)));
  }
  if (u.includes("/rest/v1/outbox?status=eq.dead&")) {
    const q = new URL(u).searchParams;
    const from = Date.parse(q.get("updated_at").replace(/^gte\./, ""));
    return json(200, OUTBOX.filter((o) => o.status === "dead" && o.proposal_id && Date.parse(o.updated_at) >= from)
      .map((o) => ({ proposal_id: o.proposal_id })));
  }
  if (u.includes("/rest/v1/worker_heartbeats?")) {
    assert.match(u, /\/rest\/v1\/worker_heartbeats\?select=at,meta&order=at\.desc&limit=1$/);
    return heartbeat();
  }
  if (u.includes("/rest/v1/operation_catalog?select=name,version,description")) return json(200, CATALOG);
  if (u.includes("/rest/v1/agents?select=id,name&")) return json(200, ids(u, "id").includes(AGENT) ? [{ id: AGENT, name: "agent:brief" }] : []);
  if (u.includes("/rest/v1/field_projects?select=id,title:data->>title,customer:data->>customer,address:data->>address&")) {
    return json(200, ids(u, "id").includes(FIELD1) ? [{ id: FIELD1, title: null, customer: "Pollen", address: "1192 Bemis Ct" }] : []);
  }
  if (u.includes("/rest/v1/coordination_jobs?select=id,title:data->>title,customer:data->>customer,address:data->>address&")) {
    return json(200, ids(u, "id").includes(BOARD1) ? [{ id: BOARD1, title: "Smith remodel", customer: "Smith", address: null }] : []);
  }
  if (u.includes("/rest/v1/outbox?select=proposal_id,status,next_attempt_at,error,created_at,updated_at&")) {
    return json(200, OUTBOX.filter((o) => ids(u, "proposal_id").includes(o.proposal_id)));
  }
  throw new Error("unexpected fetch " + u);
};

const M = await import("../../admin/js/approvals.js");

const view = document.getElementById("view");
const badge = () => document.getElementById("approvalsBadge");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const go = async (mod = M) => { location.hash = "#/approvals"; await settle(5); await mod.renderApprovals(view); await settle(); };
const waiting = () => [...view.querySelectorAll(".ap-card:not(.ap-card--done)")];
const recent = () => [...view.querySelectorAll(".ap-card--done")];
const card = (key) => view.querySelector(`.ap-card[data-key="${key}"]`);
const btn = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const errText = (key) => { const e = card(key).querySelector(".ap-err"); return e.hidden ? "" : e.textContent; };
const since0 = () => calls.length;
const noJunk = (el) => assert.ok(!/\bnull\b|\bundefined\b|NaN|\[object/.test(el.textContent), el.textContent.match(/.{0,40}(null|undefined|NaN|\[object).{0,40}/));

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Office Approvals tab (DOM)");

await test("the badge counts what's waiting in both queues, owner only, and reuses the count for 20 s", async () => {
  const before = since0();
  await M.refreshApprovalsBadge();
  assert.equal(badge().hidden, false);
  assert.equal(badge().textContent, "3", "reminder + phase on the text queue, the email on the spine");
  const reads = calls.slice(before).filter((c) => c.headers.Range === "0-0");
  assert.equal(reads.length, 2);
  for (const c of reads) {
    assert.equal(c.headers.Prefer, "count=exact");
    assert.match(c.u, /select=id&status=eq\.(pending|proposed)&expires_at=gt\.\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A/, "the ISO time is encoded");
  }
  const again = since0();
  await M.refreshApprovalsBadge();
  assert.equal(calls.length, again, "cached");
});

await test("the owner sees both queues merged, soonest expiry first, with the evidence; YES only on the text queue", async () => {
  await go();
  const keys = waiting().map((c) => c.dataset.key);
  assert.deepEqual(keys, ["spine:" + email.id, "text:" + phase.id, "text:" + reminder.id], "4 h, 11 h, 21 h");
  const e = card("spine:" + email.id);
  assert.match(e.querySelector(".ap-head").textContent, /^EmailSend one email: adjuster@carrier\.com$/);
  assert.match(e.querySelector(".ap-meta").textContent, /^Smith remodel · from Brief agent · asked .+ · expires in [34] h$/);
  assert.match(e.textContent, /Why\s*The adjuster asked for it on Monday\./);
  assert.equal(e.querySelector(".ap-refs a").getAttribute("href"), "https://mail.google.com/mail/u/0/#inbox/1");
  assert.equal(e.querySelector(".ap-refs a").getAttribute("rel"), "noopener noreferrer");
  assert.equal(e.querySelector(".ap-refs li").textContent, "opens mail.google.com — Email from the adjuster", "the host it opens, ahead of its label");
  assert.equal(e.querySelector(".ap-yes").textContent, "or text YES 4", "the spine's number, offered the same way");
  assert.equal(e.querySelector(".ap-lane"), null, "the worker is sending email: nothing about it");
  assert.equal(btn(e, "Approve and send").disabled, false);
  const r = card("text:" + reminder.id);
  assert.match(r.querySelector(".ap-head").textContent, /^EmailEmail the INV-1001 reminder to Pollen$/);
  assert.match(r.querySelector(".ap-meta").textContent, /^Pollen, 1192 Bemis Ct · from Morning brief · asked/);
  assert.match(r.textContent, /To\s*pollen@example\.com/);
  assert.match(r.textContent, /Subject\s*Invoice INV-1001 is past due/);
  assert.equal(r.querySelector(".ap-mail").textContent, reminder.params.body, "the whole email, line breaks and all");
  assert.equal(r.querySelector(".ap-yes").textContent, "or text YES 12");
  const p = card("text:" + phase.id);
  assert.match(p.querySelector(".ap-head").textContent, /^Board phaseAdd phase "Demo" to Smith remodel \(12h logged\)$/);
  assert.match(p.textContent, /Phase\s*Demo.*Hours\s*12 h logged/s);
  assert.ok(btn(p, "Approve and add phase"));
  assert.equal(p.querySelector(".ap-yes").textContent, "or text YES 13");
  assert.equal(badge().textContent, "3", "the page repaints the badge from what it loaded");
  noJunk(view);
});

await test("Recently decided says what came of each, newest first; the expired line counts both queues over 7 days", async () => {
  assert.deepEqual(recent().map((c) => c.dataset.key), ["spine:" + delivered.id, "spine:" + declined.id, "text:" + failed.id, "text:" + sent.id]);
  const out = (key) => card(key).querySelector(".ap-out").textContent;
  assert.equal(out("text:" + sent.id), "Sent");
  assert.equal(out("text:" + failed.id), "Failed: the board job changed while this was pending — nothing was added");
  assert.equal(out("spine:" + delivered.id), "Delivered", "the outbox row's delivery state");
  assert.equal(out("spine:" + declined.id), "Declined: Already called them");
  assert.match(card("text:" + failed.id).querySelector(".ap-meta").textContent, / · asked /, "no decision time is kept for a failure");
  assert.match(card("text:" + sent.id).querySelector(".ap-meta").textContent, / · answered /);
  assert.equal(view.querySelector(".ap-expired").textContent, "3 asks expired without an answer in the last 7 days");
  // the reads it made: select lists, limits, encoded times, lookups only for what's shown
  const pa = calls.find((c) => c.u.includes("/pending_actions?select=id,code"));
  assert.match(pa.u, /&expires_at=gte\.\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\d\.\d{3}Z&order=expires_at\.desc&limit=200$/);
  // the spine email's job (BOARD1) is asked of both tables: a brief or adjuster email names a field job
  const fieldRead = calls.findLast((c) => c.u.includes("/field_projects?"));
  assert.deepEqual(ids(fieldRead.u, "id").sort(), [FIELD1, BOARD1].sort());
  assert.match(fieldRead.u, /&limit=100$/);
  assert.ok(calls.some((c) => c.u.includes("/coordination_jobs?") && ids(c.u, "id").includes(BOARD1)));
  assert.ok(calls.some((c) => c.u.includes("/outbox?") && c.u.includes(`proposal_id=in.(${delivered.id})`)));
});

await test("Approve on the text queue: one confirm, decidePending with exactly {action, id, decision}, buttons off meanwhile, then Recently decided", async () => {
  asked.length = 0;
  let release;
  notify = () => new Promise((res) => { release = () => res(json(200, { ok: true, status: "executed", message: "Done — email the reminder.", action: { id: reminder.id, code: 12 } })); });
  const c = card("text:" + reminder.id);
  const before = since0();
  btn(c, "Approve and send").click();
  await settle(10);
  assert.deepEqual(asked, ["Send this email to pollen@example.com?"]);
  const sentCall = calls.slice(before).find((x) => x.u.includes("/functions/v1/roybal-notify"));
  assert.deepEqual(sentCall.body, { action: "decidePending", id: reminder.id, decision: "approve" });
  assert.equal(sentCall.headers.Authorization, "Bearer t");
  assert.equal(btn(c, "Approve and send"), undefined, "the pressed one says it's working");
  assert.equal(btn(c, "Working…").disabled, true);
  assert.equal(btn(c, "Decline").disabled, true);
  assert.equal(btn(card("text:" + phase.id), "Approve and add phase").disabled, false, "the other cards stay usable");
  // a refresh asked for mid-answer repaints nothing
  const reads = since0();
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle(10);
  assert.equal(calls.slice(reads).filter((x) => x.u.includes("/pending_actions?select=id,code")).length, 0);
  release();
  await settle();
  assert.equal(card("text:" + reminder.id).classList.contains("ap-card--done"), true);
  assert.equal(recent()[0].dataset.key, "text:" + reminder.id);
  assert.equal(recent()[0].querySelector(".ap-out").textContent, "Sent");
  assert.equal(waiting().length, 2);
  assert.ok(calls.slice(before).some((x) => x.headers.Range === "0-0"), "the badge recounts");
  assert.equal(document.getElementById("toast").textContent, "Sent");
});

await test("Decline on the text queue: a confirm, then decision decline; a cancelled confirm sends nothing", async () => {
  await go();
  asked.length = 0;
  confirmAnswer = false;
  let before = since0();
  btn(card("text:" + phase.id), "Decline").click();
  await settle();
  assert.equal(calls.slice(before).filter((x) => x.u.includes("roybal-notify")).length, 0);
  confirmAnswer = true;
  notify = () => json(200, { ok: true, status: "declined", message: "Declined — add phase." });
  before = since0();
  btn(card("text:" + phase.id), "Decline").click();
  await settle();
  assert.deepEqual(asked, ['Decline "Add phase "Demo" to Smith remodel (12h logged)"? Nothing is sent or changed.',
    'Decline "Add phase "Demo" to Smith remodel (12h logged)"? Nothing is sent or changed.']);
  assert.deepEqual(calls.slice(before).find((x) => x.u.includes("roybal-notify")).body, { action: "decidePending", id: phase.id, decision: "decline" });
  assert.equal(card("text:" + phase.id).querySelector(".ap-out").textContent, "Declined");
});

await test("Approve on the spine: op_proposal_approve with exactly {p_proposal_id, p_via: inbox}; the row back lands in Recently decided", async () => {
  await go();
  asked.length = 0;
  spine = () => json(200, { ...email, status: "executed", approved_at: new Date().toISOString(), approved_via: "inbox",
    result: { outbox_id: "o1" } });
  const before = since0();
  btn(card("spine:" + email.id), "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send this email to adjuster@carrier.com?"]);
  const rpc = calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_"));
  assert.match(rpc.u, /\/rest\/v1\/rpc\/op_proposal_approve$/);
  assert.deepEqual(rpc.body, { p_proposal_id: email.id, p_via: "inbox" });
  assert.equal(card("spine:" + email.id).querySelector(".ap-out").textContent, "Queued to send");
});

await test("Decline on the spine: a prompt for the reason, sent as p_reason; an empty one is null; cancel sends nothing", async () => {
  await go();
  asked.length = 0;
  promptAnswer = null;
  let before = since0();
  btn(card("spine:" + email.id), "Decline").click();
  await settle();
  assert.equal(calls.slice(before).filter((x) => x.u.includes("/rpc/op_proposal_")).length, 0, "cancelled");
  assert.match(asked[0], /^Decline "Send one email: adjuster@carrier\.com"\?\n\nA reason/);
  promptAnswer = "  ";
  spine = (fn, body) => json(500, { code: "55000", message: "op spine: proposal x is declined; only a proposed row can be declined" });
  before = since0();
  btn(card("spine:" + email.id), "Decline").click();
  await settle();
  const first = calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_"));
  assert.match(first.u, /op_proposal_decline$/);
  assert.deepEqual(first.body, { p_proposal_id: email.id, p_reason: null });
  await go();
  promptAnswer = "Already called them";
  spine = (fn, body) => json(200, { ...email, status: "declined", decline_reason: body.p_reason, updated_at: new Date().toISOString() });
  before = since0();
  btn(card("spine:" + email.id), "Decline").click();
  await settle();
  assert.deepEqual(calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_")).body, { p_proposal_id: email.id, p_reason: "Already called them" });
  assert.equal(card("spine:" + email.id).querySelector(".ap-out").textContent, "Declined: Already called them");
});

await test("every decidePending refusal renders its sentence under the card, which stays; a not_open one keeps its buttons off", async () => {
  const cases = [
    [() => json(400, { ok: false, error: "bad_request", message: 'Provide `decision`, "approve" or "decline".' }),
      'The server didn\'t accept this request: Provide `decision`, "approve" or "decline". Nothing changed.'],
    [() => json(401, { ok: false, error: "Missing Authorization bearer token" }), "Your sign-in has expired. Sign out, sign back in, and try again."],
    [() => json(403, { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." }), "Only the owner's login can answer this."],
    [() => json(409, { ok: false, error: "quiet_hours", message: "Customer texts go out between 8am and 9pm Alaska time. It's still waiting; approve it then." }),
      "Customer texts go out between 8am and 9pm Alaska time. It's still waiting; approve it then."],
    [() => json(409, { ok: false, error: "try_again", message: "Couldn't reach the board just now. Nothing was added; try again in a minute." }),
      "Couldn't reach the board just now. Nothing was added; try again in a minute."],
    [() => json(401, { ok: false, error: "auth", message: "Your login expired. Sign in again." }), "Your login expired. Sign in again."],
    [() => json(503, { ok: false, error: "role_check_failed", message: "Couldn't check your login just now. Try again." }),
      "Couldn't check your login just now. Try again."],
    [() => json(500, { ok: false, error: "server_error", message: "gmail-proxy timed out" }),
      "Something went wrong on the server (500: gmail-proxy timed out). Refresh to see whether it went through."],
    [() => new Response("<html>Bad gateway</html>", { status: 502 }), "The server didn't answer. Refresh to see whether it went through."],
    [() => { throw new TypeError("Failed to fetch"); }, "No connection. Try again when you're online."],
    [() => json(404, { ok: false, error: "not_open", message: "Already answered, or it expired." }), "Already answered, or it expired.", true],
  ];
  for (const [answer, sentence, gone] of cases) {
    await go();
    notify = answer;
    const key = "text:" + reminder.id;
    btn(card(key), "Approve and send").click();
    await settle();
    assert.equal(errText(key), sentence);
    assert.equal(card(key).classList.contains("ap-card--done"), false, "still waiting");
    assert.equal(btn(card(key), "Approve and send").disabled, !!gone, sentence);
    assert.equal(btn(card(key), "Decline").disabled, !!gone);
  }
  // the server still lists it as open: a refresh drops the "gone" line and gives the buttons back
  await go();
  assert.equal(errText("text:" + reminder.id), "");
});

await test("the function not updated yet: 400 Unknown action sends him to YES n, or NO n for a decline", async () => {
  notify = () => json(400, { ok: false, error: "Unknown action. Expected one of: sendSms" });
  await go();
  btn(card("text:" + phase.id), "Approve and add phase").click();
  await settle();
  assert.equal(errText("text:" + phase.id), "The server can't take this answer from the app yet. Text YES 13 to approve it.");
  btn(card("text:" + phase.id), "Decline").click();
  await settle();
  assert.equal(errText("text:" + phase.id), "The server can't take this answer from the app yet. Text NO 13 to decline it.");
  await go();
  assert.equal(errText("text:" + phase.id), "The server can't take this answer from the app yet. Text NO 13 to decline it.", "kept across a refresh");
});

await test("every spine refusal renders its sentence, and never offers YES by text", async () => {
  const cases = [
    [403, { code: "42501", message: "op spine: proposal x waits on owner, not office" }, "Your login isn't allowed to answer this one."],
    [500, { code: "P0002", message: "op spine: no proposal x" }, "This ask no longer exists.", true],
    [500, { code: "55000", message: "op spine: proposal x expired at 2026-10-06" }, "Already answered, or it expired.", true],
    [400, { code: "22023", message: "op spine: unknown approval channel policy" }, "The server refused this as invalid: unknown approval channel policy. Nothing changed."],
    [404, { code: "PGRST202", message: "Could not find the function public.op_proposal_approve" }, "The server doesn't have the approvals update yet. Nothing changed."],
    [401, { code: "PGRST301", message: "JWT expired" }, "Your sign-in has expired. Sign out, sign back in, and try again."],
  ];
  for (const [status, body, sentence, gone] of cases) {
    await go();
    spine = () => json(status, body);
    const key = "spine:" + email.id;
    btn(card(key), "Approve and send").click();
    await settle();
    assert.equal(errText(key), sentence);
    assert.ok(!/YES/.test(errText(key)));
    assert.equal(btn(card(key), "Approve and send").disabled, !!gone);
  }
});

await test("coming back to the tab refreshes it; an answer by text elsewhere moves the card", async () => {
  await go();
  PA = PA.map((r) => (r.id === reminder.id ? { ...r, status: "executed", executed_at: new Date().toISOString() } : r));
  const before = since0();
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle();
  assert.equal(calls.slice(before).filter((x) => x.u.includes("/pending_actions?select=id,code")).length, 1);
  assert.equal(card("text:" + reminder.id).querySelector(".ap-out").textContent, "Sent");
  assert.equal(badge().textContent, "2");
});

await test("a lane that won't load says so; both down shows only the warning and Try again", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes("/rest/v1/proposals?") && !(opts.headers || {}).Range
    ? json(503, { message: "upstream" }) : real(url, opts));
  await go();
  assert.equal(view.querySelector(".warn").textContent, "The new approvals queue didn't load (503).");
  assert.ok(card("text:" + phase.id), "the text queue still shows");
  globalThis.fetch = async (url, opts) => (/\/rest\/v1\/(proposals|pending_actions)\?/.test(String(url)) ? json(503, {}) : real(url, opts));
  await go();
  assert.deepEqual([...view.querySelectorAll(".warn")].map((w) => w.textContent),
    ["The text queue didn't load (503).", "The new approvals queue didn't load (503)."]);
  assert.equal(view.querySelector(".ap-card"), null);
  assert.ok(btn(view, "Try again"));
  globalThis.fetch = real;
});

/* ---------- review round 1 ---------- */
const fresh = () => { PA = [reminder, phase, sent, failed, lapsed, swept]; PR = [email, delivered, declined, stale]; };
const onTimer = async (mod = M) => {         // render with the page's 45 s timer caught, so the test can fire it
  const real = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn, ms) => (ms === 45000 ? ((tick = fn), 0) : real(fn, ms));
  try { await go(mod); } finally { globalThis.setInterval = real; }
  return () => tick();
};
const listReads = (from) => calls.slice(from).filter((x) => x.u.includes("/pending_actions?select=id,code")).length;

await test("one card's answer in flight: its buttons off and the pressed one says Working…, the others still answer, no refresh until all land", async () => {
  fresh();
  const tick = await onTimer();
  asked.length = 0;
  const holds = {};
  notify = (body) => new Promise((res) => { holds[body.id] = (b) => res(json(200, b)); });
  const r = "text:" + reminder.id, p = "text:" + phase.id;
  btn(card(r), "Approve and send").click();
  await settle(10);
  assert.equal(btn(card(r), "Working…").disabled, true);
  assert.equal(btn(card(r), "Decline").disabled, true);
  assert.equal(btn(card(p), "Approve and add phase").disabled, false);
  assert.equal(btn(card("spine:" + email.id), "Decline").disabled, false);
  // the 45 s timer and Refresh both wait while it's out
  let reads = since0();
  tick(); btn(view, "↻ Refresh").click();
  await settle(10);
  assert.equal(listReads(reads), 0);
  // a tap on another card is not swallowed: its own confirm, its own request
  btn(card(p), "Approve and add phase").click();
  await settle(10);
  assert.deepEqual(asked, ["Send this email to pollen@example.com?", 'Add the phase "Demo" to Smith remodel on the board?']);
  assert.ok(holds[phase.id], "the second request went out");
  assert.equal(btn(card(p), "Working…").disabled, true);
  // the first lands and repaints the page; the second is still latched
  holds[reminder.id]({ ok: true, status: "executed", message: "Done — email the reminder.",
    action: { id: reminder.id, code: 12, kind: "emailSend", label: reminder.label, status: "executed", result: {} } });
  await settle();
  assert.equal(card(r).classList.contains("ap-card--done"), true);
  assert.equal(btn(card(p), "Working…").disabled, true, "still out after the repaint");
  assert.equal(btn(card(p), "Decline").disabled, true);
  reads = since0();
  tick();
  await settle(10);
  assert.equal(listReads(reads), 0, "one still out: the timer still waits");
  holds[phase.id]({ ok: true, status: "declined", message: "Declined — add phase.",
    action: { id: phase.id, code: 13, kind: "boardEdit", label: phase.label, status: "declined", result: null } });
  await settle();
  assert.equal(card(p).querySelector(".ap-out").textContent, "Declined");
  assert.deepEqual(recent().slice(0, 2).map((c) => c.dataset.key), [p, r]);
  // nothing out: the timer refreshes again
  reads = since0();
  tick();
  await settle();
  assert.equal(listReads(reads), 1);
});

await test("an Approve that found the phase already there says so at once, in the toast and on the card", async () => {
  fresh();
  await go();
  notify = () => json(200, { ok: true, status: "executed", message: "Phase was already on the board — nothing was added.",
    action: { id: phase.id, code: 13, kind: "boardEdit", label: phase.label, status: "executed", result: { rowId: BOARD1, skipped: "phase already exists" } } });
  btn(card("text:" + phase.id), "Approve and add phase").click();
  await settle();
  assert.equal(card("text:" + phase.id).querySelector(".ap-out").textContent, "Phase was already on the board");
  assert.equal(document.getElementById("toast").textContent, "Phase was already on the board");
});

await test("a refusal that keeps the row open (quiet hours, try again) leaves both buttons usable", async () => {
  for (const error of ["quiet_hours", "try_again"]) {
    fresh();
    await go();
    notify = () => json(409, { ok: false, error, message: "server words for " + error });
    btn(card("text:" + phase.id), "Approve and add phase").click();
    await settle();
    assert.equal(errText("text:" + phase.id), "server words for " + error);
    assert.equal(btn(card("text:" + phase.id), "Approve and add phase").disabled, false, error);
    assert.equal(btn(card("text:" + phase.id), "Decline").disabled, false, error);
  }
});

await test("a retired kind of ask (P0002 no live operation): Approve goes off, Decline still answers it", async () => {
  fresh();
  await go();
  const key = "spine:" + email.id;
  spine = () => json(500, { code: "P0002", message: "op spine: no live operation email.send@1" });
  btn(card(key), "Approve and send").click();
  await settle();
  const line = "This kind of ask was retired before you answered it. Decline it; nothing was sent.";
  assert.equal(errText(key), line);
  assert.equal(btn(card(key), "Approve and send").disabled, true);
  assert.equal(btn(card(key), "Decline").disabled, false);
  // the server still lists it as open: a refresh keeps the line and the lock
  btn(view, "↻ Refresh").click();
  await settle();
  assert.equal(errText(key), line);
  assert.equal(btn(card(key), "Approve and send").disabled, true);
  promptAnswer = "";
  let release;
  spine = (fn) => new Promise((res) => { release = () => res(json(200, { ...email, status: "declined", decline_reason: null, updated_at: new Date().toISOString() })); });
  btn(card(key), "Decline").click();
  await settle(10);
  assert.equal(btn(card(key), "Working…").disabled, true, "the pressed one says it's working");
  assert.equal(btn(card(key), "Approve and send").disabled, true);
  release();
  await settle();
  assert.equal(card(key).querySelector(".ap-out").textContent, "Declined");
});

/* review round 2: a row seen at 'approved' waits a few minutes from this
   tab's first sighting before it says it never reported back */
const later = async (mins, fn) => {          // run fn with the page's clock mins ahead
  const real = Date.now;
  Date.now = () => real.call(Date) + mins * 60e3;
  try { await fn(); } finally { Date.now = real; }
};
await test("Recently decided: a row read back at 'approved' waits a few minutes from first sight, then never reported back (unless it carries an error)", async () => {
  const stuck = { ...reminder, id: id("text", 7), code: 16, status: "approved", created_at: iso(-2), expires_at: iso(22) };
  const stuckErr = { ...phase, id: id("text", 8), code: 17, status: "approved", created_at: iso(-1), expires_at: iso(23), result: { error: "the board job changed" } };
  const stuckPhase = { ...phase, id: id("text", 11), code: 18, status: "approved", created_at: iso(-1), expires_at: iso(23) };
  PA = [reminder, phase, stuck, stuckErr, stuckPhase];
  PR = [];
  await go();
  const out = (row) => card("text:" + row.id).querySelector(".ap-out");
  const tones = (row) => [out(row).textContent, out(row).classList.contains("ap-out--wait") ? "wait" : out(row).classList.contains("ap-out--bad") ? "bad" : "?"];
  assert.deepEqual(tones(stuck), ["Approved — waiting to hear how it went", "wait"], "a YES text may be running right now");
  assert.deepEqual(tones(stuckPhase), ["Approved — adding the phase", "wait"]);
  assert.equal(out(stuckErr).textContent, "Failed: the board job changed");
  // two minutes on, the office comes back to the tab: still waiting (the first sighting is kept, not restarted)
  await later(2, () => go());
  assert.deepEqual(tones(stuck), ["Approved — waiting to hear how it went", "wait"]);
  // past three minutes, the next refresh: it never reported back
  await later(4, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  assert.deepEqual(tones(stuck), ["Approved, but it never reported back. Check whether it went out before sending it again.", "bad"]);
  assert.deepEqual(tones(stuckPhase), ["Approved, but it never reported back. Check the board before approving it again.", "bad"]);
  // the phase went back to pending (the board was out) and was approved again later: it waits afresh
  PA = PA.map((r) => (r.id === stuckPhase.id ? { ...r, status: "pending" } : r));
  await later(5, () => go());
  assert.equal(card("text:" + stuckPhase.id).classList.contains("ap-card--done"), false, "waiting again");
  PA = PA.map((r) => (r.id === stuckPhase.id ? { ...r, status: "approved" } : r));
  await later(6, () => go());
  assert.deepEqual(tones(stuckPhase), ["Approved — adding the phase", "wait"]);
  assert.deepEqual(tones(stuck), ["Approved, but it never reported back. Check whether it went out before sending it again.", "bad"]);
});

await test("evidence links show the host they really open first, then the label (whose own host-like tail is dropped)", async () => {
  PA = [];
  PR = [{ ...email, evidence_refs: [{ label: "QuickBooks invoice INV-4", url: "https://qb-login.example.net/signin" },
    { label: "Gmail", url: "https://mail.google.com@evil.example/x" },
    { label: "Invoice (quickbooks.intuit.com)", url: "https://evil.example/pay" },
    { label: "Not a link", url: "http://x.example/" }] }];
  await go();
  const items = [...card("spine:" + email.id).querySelectorAll(".ap-refs li")];
  assert.deepEqual(items.map((li) => li.textContent), ["opens qb-login.example.net — QuickBooks invoice INV-4", "opens evil.example — Gmail",
    "opens evil.example — Invoice", "Not a link"]);
  for (const li of items.slice(0, 3)) {
    const host = li.querySelector(".ap-host"), link = li.querySelector("a");
    assert.equal(li.firstChild, host, "the real host comes before anything the proposer wrote");
    assert.ok(host.compareDocumentPosition(link) & window.Node.DOCUMENT_POSITION_FOLLOWING, "the link after it");
    assert.ok(!host.contains(link) && !link.contains(host));
  }
  assert.deepEqual([items[2].querySelector("a").textContent, items[2].querySelector("a").getAttribute("href")], ["Invoice", "https://evil.example/pay"]);
  assert.deepEqual(items.map((li) => li.querySelector("a") && li.querySelector("a").getAttribute("rel")),
    ["noopener noreferrer", "noopener noreferrer", "noopener noreferrer", null]);
  assert.equal(items[3].querySelector(".ap-host"), null, "no link, no host");
});

await test("the email or text body is shown whole: no height cap and no inner scroll on .ap-mail", async () => {
  const css = readFileSync(new URL("../../admin/css/admin.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]*\.ap-mail\b[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 1, "the .ap-mail rule");
  for (const [, sel, decl] of rules) assert.ok(!/max-height|overflow(-y)?\s*:/.test(decl), `${sel.trim()} clamps the body: ${decl}`);
});

await test("one hand-made row (a prototype-named kind, a label that won't read) doesn't take the tab down", async () => {
  const odd = { ...reminder, id: id("text", 9), code: 77, kind: "constructor", proposed_by: "__proto__", label: "do a thing" };
  const bad = { ...reminder, id: id("text", 10), code: 78, label: { toString: 1 } };
  PA = [reminder, phase, odd, bad];
  PR = [email];
  const warned = [], warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try { await go(); } finally { console.warn = warn; }
  assert.ok(!/didn't load/.test(view.textContent), view.textContent.slice(0, 200));
  assert.deepEqual(waiting().map((c) => c.dataset.key).sort(), ["spine:" + email.id, "text:" + phase.id, "text:" + reminder.id, "text:" + odd.id].sort());
  assert.match(card("text:" + odd.id).querySelector(".ap-head").textContent, /^constructorDo a thing$/);
  assert.ok(btn(card("text:" + odd.id), "Approve"));
  assert.ok(warned.some((w) => w.includes(bad.id)), "the row left off is named in the console");
  assert.equal(view.querySelector(".ap-skipped").textContent, "1 ask couldn't be shown here. Answer it by text, or tell Claude.", "and on the page");
  noJunk(view);
  fresh();
});

await test("the office comes back to the tab while its own answer is out: that row reads as running, however long it takes", async () => {
  fresh();
  await go();
  let release;
  notify = () => new Promise((res) => { release = () => res(json(200, { ok: true, status: "executed", message: "Done — email the reminder.",
    action: { id: reminder.id, code: 12, kind: "emailSend", label: reminder.label, status: "executed", result: {} } })); });
  btn(card("text:" + reminder.id), "Approve and send").click();
  await settle(10);
  // the server flipped it to approved and is sending; the office opens the tab again meanwhile
  PA = PA.map((r) => (r.id === reminder.id ? { ...r, status: "approved" } : r));
  await go();
  const out = () => card("text:" + reminder.id).querySelector(".ap-out");
  assert.equal(card("text:" + reminder.id).classList.contains("ap-card--done"), true);
  assert.equal(out().textContent, "Approved — waiting to hear how it went");
  assert.ok(out().classList.contains("ap-out--wait"));
  await later(10, () => go());
  assert.equal(out().textContent, "Approved — waiting to hear how it went", "ten minutes on, but this tab's answer is still out");
  // it lands: the page reads where things stand
  PA = PA.map((r) => (r.id === reminder.id ? { ...r, status: "executed", executed_at: new Date().toISOString() } : r));
  release();
  await settle();
  assert.equal(out().textContent, "Sent");
  fresh();
});

await test("an Approve whose re-read raced the executed stamp (the row read back 'approved') says Sent, not still running", async () => {
  fresh();
  await go();
  notify = () => json(200, { ok: true, status: "executed", message: "Done — email the reminder.",
    action: { id: reminder.id, code: 12, kind: "emailSend", label: reminder.label, status: "approved", result: {} } });
  btn(card("text:" + reminder.id), "Approve and send").click();
  await settle();
  assert.equal(card("text:" + reminder.id).querySelector(".ap-out").textContent, "Sent");
  assert.equal(document.getElementById("toast").textContent, "Sent");
  // the executed stamp never landed: the server row stays 'approved', but this tab heard it went out
  PA = PA.map((r) => (r.id === reminder.id ? { ...r, status: "approved" } : r));
  btn(view, "↻ Refresh").click();
  await settle();
  assert.equal(card("text:" + reminder.id).querySelector(".ap-out").textContent, "Sent", "not 'waiting'");
  await later(4, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  assert.equal(card("text:" + reminder.id).querySelector(".ap-out").textContent, "Sent", "nor 'never reported back'");
  // once the row moves on, the server's word is the card's again
  PA = PA.map((r) => (r.id === reminder.id ? { ...r, status: "failed", result: { error: "bounced" } } : r));
  await later(5, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  assert.equal(card("text:" + reminder.id).querySelector(".ap-out").textContent, "Failed: bounced");
  fresh();
});

await test("away from the tab while a row went back to pending and was approved again: coming back, it waits afresh", async () => {
  fresh();
  const again = { ...phase, id: id("text", 12), code: 19, status: "approved", created_at: iso(-1), expires_at: iso(23) };
  PA = [reminder, again];
  PR = [];
  await go();
  const out = () => card("text:" + again.id).querySelector(".ap-out");
  assert.equal(out().textContent, "Approved — adding the phase");
  // the office goes to the board; the run fails over, is put back to pending, and YES comes again, none of it read here
  location.hash = "#/board";
  await settle(5);
  // five minutes on, back on the tab mid-run
  await later(5, () => go());
  assert.equal(out().textContent, "Approved — adding the phase", "not 'never reported back' on a run seconds old");
  // reads stay continuous from here, so a run that really is stuck still says so
  await later(6, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  await later(7, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  await later(8.5, async () => { btn(view, "↻ Refresh").click(); await settle(); });
  assert.equal(out().textContent, "Approved, but it never reported back. Check the board before approving it again.");
  fresh();
});

await test("Safari before 15.4 (no Object.hasOwn): every card still shows; asks that won't read are said out loud, never \"nothing waiting\"", async () => {
  fresh();
  // Node's own Response uses Object.hasOwn, so it can't just go: it throws, as
  // that Safari does, only when the tab's modules call it themselves
  const real = Object.hasOwn;
  Object.hasOwn = function hasOwn(o, k) {
    if (/\/apps\/(field|admin)\/js\/approvals\.js/.test(new Error().stack.split("\n")[2] || "")) {
      throw new TypeError("Object.hasOwn is not a function");
    }
    return real(o, k);
  };
  try { await go(); } finally { Object.hasOwn = real; }
  assert.deepEqual(waiting().map((c) => c.dataset.key), ["spine:" + email.id, "text:" + phase.id, "text:" + reminder.id]);
  assert.equal(card("spine:" + email.id).querySelector(".ap-head .badge").className, "badge disp-b", "the chip's tone");
  assert.equal(card("text:" + phase.id).querySelector(".ap-head .badge").className, "badge cat2");
  assert.equal(recent().length, 4);
  assert.equal(view.querySelector(".ap-skipped"), null);
  // every waiting row unreadable: the line says so, and the badge still counts them
  const bad = (r) => ({ ...r, label: { toString: 1 }, rationale: { toString: 1 } });
  PA = [bad(reminder), bad(phase), sent, bad(failed)];
  PR = [bad(email)];
  const warn = console.warn;
  console.warn = () => {};
  try { await go(); } finally { console.warn = warn; }
  assert.equal(waiting().length, 0);
  const line = view.querySelector(".ap-skipped");
  assert.equal(line.textContent, "3 asks couldn't be shown here. Any that came to you by text can be answered there; otherwise tell Claude.",
    "the failed one isn't waiting, so it isn't counted");
  assert.ok(line.classList.contains("warn"));
  assert.ok(!/Nothing is waiting on you/.test(view.textContent));
  assert.deepEqual([badge().hidden, badge().textContent], [false, "3"]);
  PA = [bad(reminder), phase];
  PR = [];
  console.warn = () => {};
  try { await go(); } finally { console.warn = warn; }
  assert.equal(view.querySelector(".ap-skipped").textContent, "1 ask couldn't be shown here. Answer it by text, or tell Claude.");
  assert.deepEqual(waiting().map((c) => c.dataset.key), ["text:" + phase.id]);
  fresh();
});

await test("any other login sees one line, no badge, and nothing beyond the role check is read", async () => {
  roles = { owner: false, office: false };
  const C = await import("../../admin/js/approvals.js?as=crew");
  const before = since0();
  await go(C);
  assert.equal(view.querySelector(".ap-card"), null);
  assert.match(view.textContent, /Approvals belong to the owner's login\./);
  badge().hidden = false; badge().textContent = "9";
  await C.refreshApprovalsBadge();
  assert.equal(badge().hidden, true);
  const read = calls.slice(before).map((c) => c.u.replace(/^https:\/\/[^/]+/, ""));
  assert.ok(read.length >= 1 && read.every((u) => u === "/rest/v1/rpc/role_is"), read.join(", "));
  // a definite no is kept for the page
  const again = since0();
  await go(C);
  await C.refreshApprovalsBadge();
  assert.equal(calls.slice(again).filter((c) => c.u.includes("/rpc/role_is")).length, 0);
  assert.match(view.textContent, /Approvals belong to the owner's login\./);
  roles = { owner: true, office: false };
});

await test("an owner check that can't answer says so with Retry (never \"not yours\"), isn't kept, and the badge asks again on the next paint", async () => {
  fresh();
  const roleChecks = (from) => calls.slice(from).filter((c) => c.u.includes("/rpc/role_is")).length;
  // the page: a 503, then a fetch that throws, then healthy
  const F = await import("../../admin/js/approvals.js?as=flaky");
  roleIs = () => json(503, { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." });
  let before = since0();
  await go(F);
  assert.match(view.textContent, /Couldn't check your login just now\./);
  assert.ok(!/belong to the owner/.test(view.textContent));
  assert.equal(view.querySelector(".ap-card"), null);
  assert.ok(calls.slice(before).every((c) => c.u.endsWith("/rest/v1/rpc/role_is")), "nothing beyond the check is read");
  roleIs = () => { throw new TypeError("Failed to fetch"); };
  btn(view, "Retry").click();
  await settle();
  assert.match(view.textContent, /Couldn't check your login just now\./, "a throw with the browser online is the same");
  roleIs = null;
  before = since0();
  btn(view, "Retry").click();
  await settle();
  assert.equal(roleChecks(before), 1, "Retry asked again");
  assert.ok(card("text:" + reminder.id), "the owner's cards");
  before = since0();
  await go(F);
  assert.equal(roleChecks(before), 0, "a yes is kept");
  // the badge: hidden while the check can't answer, then counted on the next paint
  const G = await import("../../admin/js/approvals.js?as=flaky-badge");
  roleIs = () => json(503, {});
  badge().hidden = false; badge().textContent = "9";
  await G.refreshApprovalsBadge();
  assert.equal(badge().hidden, true);
  roleIs = null;
  before = since0();
  await G.refreshApprovalsBadge();
  assert.equal(roleChecks(before), 1, "asked again");
  assert.deepEqual([badge().hidden, badge().textContent], [false, "3"]);
});

/* ---------- spine step 5 ---------- */
const OFF_WAITING = "Email sending is off on the worker right now: approving queues this, and it waits up to 48 hours for sending to come back, then it isn't sent.";
const OFF_QUEUED = "Queued, but email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent";
const beats = (from) => calls.slice(from).filter((c) => c.u.includes("/worker_heartbeats?")).length;
const reset5 = () => {
  fresh();
  OUTBOX = [{ proposal_id: delivered.id, status: "delivered", next_attempt_at: iso(-5), error: null, created_at: iso(-5) }];
  heartbeat = beatAt(0.5, ["sms", "email"]);
};

await test("a spine email on a field job (the brief's reminder, the adjuster email) names that job; both job tables are asked", async () => {
  reset5();
  const brief = { ...email, id: id("spine", 5), sms_code: 5, job_id: FIELD1,
    rationale: "email the INV-1001 reminder to Pollen (6 days past due, $1,240.00 open)" };
  PA = [];
  PR = [brief];
  const before = since0();
  await go();
  const c = card("spine:" + brief.id);
  assert.match(c.querySelector(".ap-meta").textContent, /^Pollen, 1192 Bemis Ct · from Brief agent · asked /);
  assert.equal(c.querySelector(".ap-yes").textContent, "or text YES 5");
  const reads = calls.slice(before);
  assert.ok(reads.some((x) => x.u.includes("/field_projects?") && ids(x.u, "id").includes(FIELD1)));
  assert.ok(reads.some((x) => x.u.includes("/coordination_jobs?") && ids(x.u, "id").includes(FIELD1)), "either table");
  noJunk(view);
  reset5();
});

await test("email sending off on the worker: the waiting email says approving queues it, the approved one says it waits, the toast too", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms"]);                      // production today: no Gmail pair on the worker
  OUTBOX = [{ proposal_id: delivered.id, status: "pending", next_attempt_at: iso(-5), error: null, created_at: iso(-5) }];
  await go();
  const e = card("spine:" + email.id);
  const lane = e.querySelector(".ap-lane");
  assert.equal(lane.textContent, OFF_WAITING);
  assert.equal(lane.getAttribute("role"), "note");
  assert.ok(lane.compareDocumentPosition(e.querySelector(".ap-actions")) & window.Node.DOCUMENT_POSITION_FOLLOWING, "read before the buttons");
  assert.equal(btn(e, "Approve and send").disabled, false, "still answerable");
  assert.equal(e.querySelector(".ap-yes").textContent, "or text YES 4");
  assert.equal(card("text:" + reminder.id).querySelector(".ap-lane"), null, "the text queue's email goes through gmail-proxy");
  const out = card("spine:" + delivered.id).querySelector(".ap-out");
  assert.equal(out.textContent, OFF_QUEUED);
  assert.ok(out.classList.contains("ap-out--wait"));
  assert.equal(card("spine:" + declined.id).querySelector(".ap-out").textContent, "Declined: Already called them");
  // approving queues it, and the card and the toast say it waits
  asked.length = 0;
  spine = () => json(200, { ...email, status: "executed", approved_at: new Date().toISOString(), approved_via: "inbox", result: { outbox_id: "o2" } });
  btn(e, "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send this email to adjuster@carrier.com?"]);
  assert.equal(card("spine:" + email.id).querySelector(".ap-out").textContent, OFF_QUEUED);
  assert.equal(document.getElementById("toast").textContent, OFF_QUEUED);
  noJunk(view);
  reset5();
});

await test("a worker that stopped beating reads as not sending; once it beats with email again the line goes", async () => {
  reset5();
  heartbeat = beatAt(15, ["sms", "email"]);
  await go();
  assert.equal(card("spine:" + email.id).querySelector(".ap-lane").textContent, OFF_WAITING);
  heartbeat = beatAt(0.2, ["sms", "email"]);
  btn(view, "↻ Refresh").click();
  await settle();
  assert.equal(card("spine:" + email.id).querySelector(".ap-lane"), null);
  assert.equal(card("spine:" + delivered.id).querySelector(".ap-out").textContent, "Delivered");
  reset5();
});

await test("a heartbeat read that fails or won't read never breaks the tab and says nothing new", async () => {
  OUTBOX = [{ proposal_id: delivered.id, status: "pending", next_attempt_at: iso(-5), error: null, created_at: iso(-5) }];
  for (const [what, answer] of [
    ["a 503", () => json(503, { message: "upstream" })],
    ["no table yet (before 0016)", () => json(404, { code: "PGRST205", message: "Could not find the table" })],
    ["no connection", () => { throw new TypeError("Failed to fetch"); }],
    ["not a list", () => json(200, { at: "x" })],
    ["a row that won't read", () => json(200, [{ at: "soon", meta: "?" }])],
    ["not JSON", () => new Response("<html>", { status: 200 })],
  ]) {
    fresh();
    heartbeat = answer;
    await go();
    assert.equal(waiting().length, 3, what);
    assert.ok(!/didn't load/.test(view.textContent), what);
    assert.equal(view.querySelector(".ap-lane"), null, what);
    assert.equal(card("spine:" + delivered.id).querySelector(".ap-out").textContent, "Queued to send", what);
    assert.equal(card("spine:" + email.id).querySelector(".ap-yes").textContent, "or text YES 4", what);
  }
  reset5();
});

await test("the heartbeat is read only while a spine email is on the page", async () => {
  reset5();
  PR = [];
  let before = since0();
  await go();
  assert.equal(beats(before), 0, "the text queue alone: no read");
  PR = [declined];
  before = since0();
  await go();
  assert.equal(beats(before), 0, "a declined email waits on nothing");
  PR = [email];
  before = since0();
  await go();
  assert.equal(beats(before), 1);
  reset5();
});

await test("one number live on both queues: neither card offers it; a tap still answers each", async () => {
  reset5();
  PA = [{ ...reminder, code: 4 }, phase];                // the spine email holds 4 as well
  PR = [email];
  await go();
  assert.equal(card("spine:" + email.id).querySelector(".ap-yes"), null);
  assert.equal(card("text:" + reminder.id).querySelector(".ap-yes"), null);
  assert.equal(card("text:" + phase.id).querySelector(".ap-yes").textContent, "or text YES 13");
  assert.equal(btn(card("spine:" + email.id), "Approve and send").disabled, false);
  assert.equal(btn(card("text:" + reminder.id), "Approve and send").disabled, false);
  reset5();
});

await test("the page calls only field exports that step 4 shipped, or checks a newer one first (a stale cached field module can't blank it)", async () => {
  // what apps/field/js/approvals.js exported at step 4 (origin/main 171e47b)
  const STEP4 = new Set(["RECENT_MS", "EXPIRED_MS", "stageLabel", "firstSentence", "jobName", "agentName", "labelOf", "fromPending",
    "fromProposal", "isLive", "isExpired", "isRecent", "inbox", "skippedLine", "needs", "lookFrom", "akTime", "expiresIn", "expiredLine",
    "WAIT_MS", "NEVER_REPORTED", "NEVER_REPORTED_PHASE", "outcome", "READ_GAP_MS", "sawApproved", "approveConfirm", "declineConfirm",
    "declinePrompt", "decisionRequest", "NO_CONNECTION", "SIGNED_OUT", "pendingAnswer", "spineAnswer", "decidedText", "settle"]);
  const src = readFileSync(new URL("../../admin/js/approvals.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const used = [...new Set([...src.matchAll(/\bA\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  assert.ok(used.includes("lookFrom") && used.includes("needs"), "the scan finds the calls");
  for (const name of used) {
    if (STEP4.has(name)) continue;
    assert.ok(src.includes(`typeof A.${name} === "function"`) || src.includes(`A.${name} !== undefined`),
      `A.${name} is newer than step 4 and isn't checked before it's used`);
  }
  // and every step-4 name it calls is still exported, so the newer module serves an older page too
  const field = await import("../js/approvals.js");
  for (const name of used.filter((n) => STEP4.has(n))) assert.notEqual(field[name], undefined, name);
});

await test("a send the worker gave up on after its card aged off shows again in Recently decided, named, for 48 hours from then", async () => {
  reset5();
  const STALE = "this email waited 58 hours in line, past the 48-hour limit (EMAIL_MAX_AGE_HOURS), so it was not sent. Send a fresh one if it should still go.";
  // the brief's reminder, approved 60 h ago while sending was off; the worker came back an hour ago and gave up on it
  const late = { ...email, id: id("spine", 6), sms_code: null, job_id: FIELD1, status: "executed", created_at: iso(-61), expires_at: iso(-37),
    approved_at: iso(-60), updated_at: iso(-60), rationale: "email the INV-1001 reminder to Pollen (6 days past due, $1,240.00 open)" };
  const dead = { proposal_id: late.id, status: "dead", next_attempt_at: iso(-60), error: STALE, created_at: iso(-60), updated_at: iso(-1) };
  PA = [];
  PR = [late];
  OUTBOX = [dead];
  let before = since0();
  await go();
  const c = card("spine:" + late.id);
  assert.ok(c && c.classList.contains("ap-card--done"), "on Recently decided");
  assert.equal(c.querySelector(".ap-out").textContent, "Couldn't send: " + STALE);
  assert.ok(c.querySelector(".ap-out").classList.contains("ap-out--bad"));
  // nothing else on the page names its job or proposer: they were read for it
  assert.match(c.querySelector(".ap-meta").textContent, /^Pollen, 1192 Bemis Ct · from Brief agent · answered /);
  const ob = calls.slice(before).find((x) => x.u.includes("/outbox?select="));
  assert.match(ob.u, /select=proposal_id,status,next_attempt_at,error,created_at,updated_at&/);
  assert.deepEqual(ids(ob.u, "proposal_id"), [late.id]);
  assert.equal(beats(before), 0, "an older send waits on nothing: no heartbeat read");
  assert.equal(view.querySelector(".ap-lane"), null);
  noJunk(view);
  // beside the rest: newest news first, since it died after every other answer here
  PR = [email, delivered, declined, late];
  OUTBOX = [{ proposal_id: delivered.id, status: "delivered", next_attempt_at: iso(-5), error: null, created_at: iso(-5), updated_at: iso(-4.9) }, dead];
  await go();
  assert.deepEqual(recent().map((x) => x.dataset.key), ["spine:" + late.id, "spine:" + delivered.id, "spine:" + declined.id]);
  assert.equal(card("spine:" + delivered.id).querySelector(".ap-out").textContent, "Delivered");
  // died 49 h ago, or still in line with the worker down: not shown
  for (const row of [{ ...dead, updated_at: iso(-49) }, { ...dead, status: "pending", error: null, updated_at: iso(-60) }]) {
    PR = [late];
    OUTBOX = [row];
    await go();
    assert.equal(card("spine:" + late.id), null, row.status + " " + row.updated_at);
    assert.equal(view.querySelector(".ap-none").textContent, "Nothing is waiting on you.");
  }
  // an outbox read that answers with something other than a list says nothing and breaks nothing
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes("/rest/v1/outbox?") ? json(200, { message: "not a list" }) : real(url, opts));
  PR = [email, delivered, late];
  OUTBOX = [dead];
  try { await go(); } finally { globalThis.fetch = real; }
  assert.ok(!/didn't load/.test(view.textContent));
  assert.equal(waiting().length, 1);
  assert.equal(card("spine:" + delivered.id).querySelector(".ap-out").textContent, "Queued to send");
  assert.equal(card("spine:" + late.id), null);
  reset5();
});

/* ---------- spine step 5, review round 2 ---------- */
await test("a send that died in the last 48 hours shows even when its proposal is older than the 7-day read; a read that fails changes nothing", async () => {
  reset5();
  const GONE = "this email waited 9 days in line, past the 48-hour limit (EMAIL_MAX_AGE_HOURS), so it was not sent. Send a fresh one if it should still go.";
  // the brief's reminder, filed 9 days ago with a day to answer it and approved at once; the worker
  // was stopped, came back an hour ago and gave up on it. Its expiry is 8 days back: the 7-day read misses it.
  const ancient = { ...email, id: id("spine", 7), sms_code: null, job_id: FIELD1, status: "executed", created_at: iso(-216), expires_at: iso(-192),
    approved_at: iso(-215.9), updated_at: iso(-215.9), rationale: "email the INV-1001 reminder to Pollen (6 days past due, $1,240.00 open)" };
  // and one inside the 7 days that died too: already on the page, so not read again by id
  const inside = { ...email, id: id("spine", 8), sms_code: null, status: "executed", created_at: iso(-80), expires_at: iso(-56),
    approved_at: iso(-79), updated_at: iso(-79) };
  const deadOld = { proposal_id: ancient.id, status: "dead", next_attempt_at: iso(-215.9), error: GONE, created_at: iso(-215.9), updated_at: iso(-1) };
  const deadIn = { proposal_id: inside.id, status: "dead", next_attempt_at: iso(-79), error: "Gmail refused the address", created_at: iso(-79), updated_at: iso(-2) };
  const byId = (from) => calls.slice(from).filter((c) => c.u.includes("/rest/v1/proposals?") && new URL(c.u).searchParams.has("id"));
  const deadReads = (from) => calls.slice(from).filter((c) => c.u.includes("/rest/v1/outbox?status=eq.dead&"));
  PA = [];
  PR = [email, ancient, inside];
  OUTBOX = [deadOld, deadIn];
  let before = since0();
  await go();
  const c = card("spine:" + ancient.id);
  assert.ok(c && c.classList.contains("ap-card--done"), "on Recently decided");
  assert.equal(c.querySelector(".ap-out").textContent, "Couldn't send: " + GONE);
  assert.ok(c.querySelector(".ap-out").classList.contains("ap-out--bad"));
  assert.match(c.querySelector(".ap-meta").textContent, /^Pollen, 1192 Bemis Ct · from Brief agent · answered /, "its job and proposer were read for it");
  assert.equal(card("spine:" + inside.id).querySelector(".ap-out").textContent, "Couldn't send: Gmail refused the address");
  assert.deepEqual(recent().map((x) => x.dataset.key), ["spine:" + ancient.id, "spine:" + inside.id], "newest news first, each once");
  assert.equal(waiting().length, 1, "the waiting email is still there");
  assert.equal(view.querySelector(".ap-expired"), null, "an executed row is never counted as expired");
  // the reads: dead outbox rows of the last 48 hours, then only the proposals the 7-day read didn't have
  const dr = deadReads(before);
  assert.equal(dr.length, 1);
  assert.match(dr[0].u, /\/rest\/v1\/outbox\?status=eq\.dead&updated_at=gte\.\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\d\.\d{3}Z&proposal_id=not\.is\.null&select=proposal_id&order=updated_at\.desc&limit=100$/);
  const from = Date.parse(new URL(dr[0].u).searchParams.get("updated_at").replace(/^gte\./, ""));
  assert.ok(Math.abs(from - (Date.now() - 48 * 3600e3)) < 60e3, "48 hours back");
  const pr = byId(before);
  assert.equal(pr.length, 1);
  assert.deepEqual(ids(pr[0].u, "id"), [ancient.id]);
  const main = calls.slice(before).find((x) => x.u.includes("/rest/v1/proposals?select=") && new URL(x.u).searchParams.has("expires_at"));
  const cols = (u) => new URL(u).searchParams.get("select");
  assert.equal(cols(pr[0].u), cols(main.u), "the same columns as the main read");
  assert.match(pr[0].u, /&limit=100$/);
  noJunk(view);

  // died 49 h ago: the dead read leaves it out, nothing is read by id, nothing shows
  OUTBOX = [{ ...deadOld, updated_at: iso(-49) }];
  before = since0();
  await go();
  assert.equal(card("spine:" + ancient.id), null);
  assert.equal(byId(before).length, 0);
  // no dead rows at all: no read by id
  OUTBOX = [];
  before = since0();
  await go();
  assert.equal(byId(before).length, 0);
  assert.equal(card("spine:" + ancient.id), null);

  // a bad proposal_id in the answer can't sink the read by id
  OUTBOX = [deadOld];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes("/rest/v1/outbox?status=eq.dead&")
    ? json(200, [{ proposal_id: "not-a-uuid" }, null, { proposal_id: ancient.id }, { proposal_id: ancient.id }]) : real(url, opts));
  before = since0();
  try { await go(); } finally { globalThis.fetch = real; }
  assert.deepEqual(ids(byId(before)[0].u, "id"), [ancient.id]);
  assert.ok(card("spine:" + ancient.id));

  // either extra read failing (an error, no connection, an answer that isn't a list) leaves the tab as it was
  const asToday = () => {
    assert.ok(!/didn't load/.test(view.textContent), view.textContent);
    assert.equal(view.querySelectorAll(".warn:not(.ap-err)").length, 0, "no warning line");
    assert.equal(card("spine:" + ancient.id), null);
    assert.equal(waiting().length, 1);
    assert.equal(card("spine:" + inside.id).querySelector(".ap-out").textContent, "Couldn't send: Gmail refused the address");
  };
  OUTBOX = [deadOld, deadIn];
  const fails = [
    (u) => u.includes("/rest/v1/outbox?status=eq.dead&") && json(503, { message: "upstream" }),
    (u) => { if (u.includes("/rest/v1/outbox?status=eq.dead&")) throw new TypeError("Failed to fetch"); },
    (u) => u.includes("/rest/v1/outbox?status=eq.dead&") && json(200, { message: "not a list" }),
    (u) => u.includes("/rest/v1/proposals?") && u.includes("&id=in.") && json(503, { message: "upstream" }),
    (u) => { if (u.includes("/rest/v1/proposals?") && u.includes("&id=in.")) throw new TypeError("Failed to fetch"); },
    (u) => u.includes("/rest/v1/proposals?") && u.includes("&id=in.") && json(200, { message: "not a list" }),
  ];
  for (const fail of fails) {
    globalThis.fetch = async (url, opts) => fail(String(url)) || real(url, opts);
    try { await go(); } finally { globalThis.fetch = real; }
    asToday();
  }

  // the new approvals queue didn't load: its one warning, and nothing read by id beside it
  globalThis.fetch = async (url, opts) => (String(url).includes("/rest/v1/proposals?") && !(opts.headers || {}).Range
    ? json(503, { message: "upstream" }) : real(url, opts));
  before = since0();
  try { await go(); } finally { globalThis.fetch = real; }
  assert.deepEqual([...view.querySelectorAll(".warn:not(.ap-err)")].map((w) => w.textContent), ["The new approvals queue didn't load (503)."]);
  assert.equal(byId(before).length, 0);
  assert.equal(card("spine:" + ancient.id), null);
  reset5();
});

location.hash = "#/";
console.log(`\n${pass} passed`);
process.exit(0);
