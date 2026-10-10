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
   reads failing leaves the tab as it was. Then the nightly billing check's
   invoice gaps: every line with its figures and records ("no rate" when the
   job has none, out of the total), the total, what to check, no YES number,
   only the field job read, and Approve and add lines landing as what the
   executor did; superseded with no gaps left reads as no longer needed.
   Then the nightly QuickBooks match's receipts cards: a line per receipt
   and the project link, no YES number, the heartbeat read for the "qbo"
   channel (and the line when it's off), every outbox row of an approved
   card read and counted ("2 of 3 updated in QuickBooks; 1 refused: …"),
   and "Approve all QuickBooks cards (N)": one confirm, then each card
   through the same call its own Approve makes, stopping at the first that
   doesn't go through, then a fresh read. Then carrier packets
   (packet.send): the To filled with the worker's suggestion and where it
   came from, a Cc, the subject, the email behind "Show the email", the PDF
   link, and no YES number; Approve off until the To is one good address
   (held to adjustersend.js checkAddress's answers) and the Cc a list of
   them; what he typed kept across repaints, and no timed repaint while he
   types; Approve sending op_proposal_approve with p_edited_params {to, cc}
   built on the page, then the outbox row's "Sent from Gmail" or "Couldn't
   send: …"; the packet channel's lane line; decline as on any spine card;
   and a tab that drew an older cached field module (kind "other") still
   giving the card all of that.
   Run: node apps/field/test/admin-approvals.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

// the office admin imports field modules as "../../js/x.js" (one origin, two
// folders on the server); on disk they live in apps/field/js. A second copy
// of the tab (approvals.js?as=crew) keeps its own once-per-page owner check,
// so it starts over for the other login. A copy loaded as approvals.js?field=old
// is a tab that drew an older cached field module: approvals.js?old, the same
// file with packet.send unmapped, so a carrier packet is a plain card (kind other).
register("data:text/javascript," + encodeURIComponent(`
import { readFileSync } from "node:fs";
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL && ctx.parentURL.includes("/apps/admin/js/") && spec.startsWith("../../js/")) {
    const url = new URL(spec.replace("../../js/", "../../field/js/"), ctx.parentURL);
    if (spec === "../../js/approvals.js" && new URL(ctx.parentURL).searchParams.has("field")) url.search = "?old";
    return next(url.href, ctx);
  }
  const r = await next(spec, ctx);
  return r.url.includes("/apps/admin/js/") ? { ...r, format: "module" } : r;   // no package.json there
}
export async function load(url, ctx, next) {
  if (!url.endsWith("/apps/field/js/approvals.js?old")) return next(url, ctx);
  const src = readFileSync(new URL(url.slice(0, -"?old".length)), "utf8");
  return { format: "module", shortCircuit: true, source: src.split('"packet.send": "packet"').join('"packet.send (not yet)": "packet"') };
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
const BILLING = "193d7dd0-74f9-407d-9891-8cb7aab22f82";          // agent:billing
const INTEGRATIONS = "5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10";     // agent:integrations (0023)
const ALSTON = "a628eea5-5c1e-4b7a-9d2f-3e8c1b0a7f42";           // a field job, "2156 Alston rd."
const DOCUMENTS = "b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65";        // agent:documents (0026)
const SAMPLE = "c0ffee00-1111-4222-8333-444455556666";           // a field job, "123 Example St" (carrier packets)
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
const CATALOG = [{ name: "email.send", version: 1, description: "Send one email. Execution writes one outbox row; the worker delivers it through Gmail." },
  { name: "invoice.review_gaps", version: 1, description: "Add the lines the nightly billing check found documented but not billed. Execution appends one new draft invoice to the job." },
  { name: "receipts.qbo_link", version: 1, description: "Update QuickBooks for this job's receipts. Execution queues one QuickBooks change per receipt: tag the matching expense to the job's QuickBooks project and attach the receipt photo; it never edits a tag already set and it refuses if the receipts changed since the card was filed." },
  { name: "packet.send", version: 1, description: "Email the carrier packet to the adjuster. Execution writes one outbox row on the packet channel carrying the stored PDF; the worker sends it once through Gmail, to the address confirmed on the card, and the packet is recorded as sent." }];
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
  if (u.includes("/rest/v1/agents?select=id,name&")) {
    return json(200, [{ id: AGENT, name: "agent:brief" }, { id: BILLING, name: "agent:billing" }, { id: INTEGRATIONS, name: "agent:integrations" },
      { id: DOCUMENTS, name: "agent:documents" }].filter((a) => ids(u, "id").includes(a.id)));
  }
  if (u.includes("/rest/v1/field_projects?select=id,title:data->>title,customer:data->>customer,address:data->>address&")) {
    return json(200, [{ id: FIELD1, title: null, customer: "Pollen", address: "1192 Bemis Ct" },
      { id: ALSTON, title: "2156 Alston rd.", customer: "Pollen Apartments", address: "2156 Alston Rd" },
      { id: SAMPLE, title: null, customer: "Jane Sample", address: "123 Example St, Fairbanks, AK 99701" }].filter((j) => ids(u, "id").includes(j.id)));
  }
  if (u.includes("/rest/v1/coordination_jobs?select=id,title:data->>title,customer:data->>customer,address:data->>address&")) {
    return json(200, ids(u, "id").includes(BOARD1) ? [{ id: BOARD1, title: "Smith remodel", customer: "Smith", address: null }] : []);
  }
  if (u.includes("/rest/v1/outbox?select=proposal_id,status,next_attempt_at,error,provider_status,created_at,updated_at&")) {
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
  assert.match(ob.u, /select=proposal_id,status,next_attempt_at,error,provider_status,created_at,updated_at&/);
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

/* ---------- the nightly billing check: invoice gaps ---------- */
const LIMITS = "Limits: an internal leak check, not carrier-grade justification. Prices come only from this job's own invoice lines; the rest are left unpriced.";
/* the input billing.reconcile files (contract K3), plus the fingerprint the filing door stamps */
const gapsRow = { id: id("spine", 9), operation: "invoice.review_gaps@1", sms_code: 21, status: "proposed", edited_params: null,
  input: { job_id: FIELD1, findings_hash: "0123456789abcdef0123456789abcdef", base_rev: 41, rate_invoice_id: "inv-7f3a", rate_invoice_no: "1043",
    sent: true, total_usd: 721.25, unpriced_count: 2, detector: "billing.reconcile@0.1", limits: LIMITS,
    invoice_fingerprint: "fedcba9876543210fedcba9876543210",
    lines: [
      { finding_id: "equip:dehu", class: "dehu", desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", qty: 6, unit: "EA",
        price: 85, amount: 510, room: "", code: "DHM>", basis: "20 dehu-days documented from 6 unit rows; 14 billed on invoice 1043.",
        refs: [{ kind: "drying_log", id: "log-1", label: "20 dehu-days from 6 unit rows, 07-28→08-04", date: "2026-07-28" },
          { kind: "invoice_line", id: "inv-7f3a#2", label: "invoice 1043 line 3: 14 EA Dehumidifier @ $85.00" }] },
      { finding_id: "labor:hours", class: "labor", desc: "Water Extraction & Remediation Technician - per hour", qty: 3.25, unit: "HR",
        price: 65, amount: 211.25, room: "", code: "LAB", basis: "27.25 h in QuickBooks Time inside the mitigation window; 24 billed.",
        refs: [{ kind: "time_entries", id: "jc-889", label: "QuickBooks Time: 27.25 h, 07-27→08-06" }] },
      { finding_id: "cat3:containment", class: "cat3", desc: "Containment Barrier/Airlock/Decon. Chamber", qty: null, unit: "SF",
        price: null, amount: null, room: "Basement", code: "BARR", basis: "Cat 3 job: no containment line on the invoice.",
        refs: [{ kind: "water_category", id: "3", label: "Water category 3 (Cat 3 package applies)" }] },
      { finding_id: "cat3:hepa_filter", class: "cat3", desc: "Add for HEPA filter (for negative air exhaust fan)", qty: 2, unit: "EA",
        price: null, amount: null, room: "", code: "FHEPA", basis: "One per scrubber on a Cat 3 job.", refs: [] },
    ],
    hints: [{ kind: "open_equipment_row", label: "1 equipment row has no removal date: counted to its last reading",
      refs: [{ kind: "equipment_row", id: "log-1#eq4", label: "Dehu D-4" }] }] },
  proposed_by_kind: "agent", proposed_by_id: BILLING,
  rationale: "Add 4 lines ($721.25, 2 unpriced) to Pollen: dehu-days, labor hours, Cat 3 package\n" + LIMITS,
  evidence_refs: [{ kind: "invoice", id: "inv-7f3a", label: "Compared with 1 T&M invoice; newest is invoice 1043" }],
  job_id: FIELD1, created_at: iso(-9), expires_at: iso(14 * 24 - 9), approved_at: null, updated_at: iso(-9), decline_reason: null, result: null, error: null };
const row = (root, k) => {
  const kv = [...root.querySelectorAll(".ap-kv")].find((x) => x.querySelector(".ap-k").textContent === k);
  return kv ? kv.querySelector(".ap-v") : null;
};

await test("an invoice-gaps card shows every line with its figures and records, the priced total and what to check, with no YES number", async () => {
  reset5();
  const noGaps = { ...gapsRow, id: id("spine", 10), sms_code: null, status: "superseded", updated_at: iso(-3), result: { superseded_reason: "no_gaps" } };
  const present = { ...gapsRow, id: id("spine", 11), sms_code: null, status: "executed", approved_at: iso(-4), updated_at: iso(-4),
    result: { status: "already_present", invoice_id: "5d41402a-bc4b-2a76-b971-9d911017c592", lines_added: 0, total_usd: 0, unpriced: 0, rev: 41 } };
  PA = [];
  PR = [gapsRow, noGaps, present];
  const before = since0();
  await go();
  const c = card("spine:" + gapsRow.id);
  assert.equal(c.querySelector(".ap-head").textContent,
    "Invoice gapsAdd the lines the nightly billing check found documented but not billed: 4 lines · $721.25 · 2 unpriced");
  assert.ok(c.querySelector(".ap-head .badge").classList.contains("ap-money"), "a money ask's own chip");
  assert.match(c.querySelector(".ap-meta").textContent, /^Pollen, 1192 Bemis Ct · from Billing agent · asked .+ · expires in 13 days$/);
  assert.equal(c.querySelector(".ap-yes"), null, "answered here only: roybal-notify never reads these");
  assert.equal(row(c, "Adds").textContent, "A new draft invoice, beside invoice 1043 (an invoice on this job has already gone out)");
  const lines = [...c.querySelectorAll(".ap-lines > .ap-line")];
  assert.deepEqual(lines.map((l) => [l.querySelector(".ap-line__what").textContent, l.querySelector(".ap-line__fig").textContent]), [
    ["Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", "6 EA × $85.00 = $510.00"],
    ["Water Extraction & Remediation Technician - per hour", "3.25 HR × $65.00 = $211.25"],
    ["Containment Barrier/Airlock/Decon. Chamber (Basement)", "no quantity · no rate"],
    ["Add for HEPA filter (for negative air exhaust fan)", "2 EA · no rate"],
  ]);
  assert.deepEqual(lines.map((l) => l.querySelector(".ap-line__fig").classList.contains("ap-line__fig--open")), [false, false, true, true],
    "a line with no rate stands out");
  assert.equal(lines[0].querySelector(".ap-line__why").textContent, "20 dehu-days documented from 6 unit rows; 14 billed on invoice 1043.");
  assert.deepEqual([...lines[0].querySelectorAll(".ap-refs li")].map((li) => li.textContent),
    ["20 dehu-days from 6 unit rows, 07-28→08-04", "invoice 1043 line 3: 14 EA Dehumidifier @ $85.00"]);
  assert.equal(lines[3].querySelector(".ap-refs"), null, "no records, no empty list");
  assert.equal(row(c, "Total").textContent, "$721.25 + 2 lines with no rate (not in the total); the new invoice adds this job's O&P and tax");
  assert.equal(row(c, "To check").textContent, "1 equipment row has no removal date: counted to its last readingDehu D-4");
  assert.equal(row(c, "Why").textContent, gapsRow.rationale, "both lines, the break kept");
  assert.deepEqual([...row(c, "Evidence").querySelectorAll("li")].map((li) => li.textContent), ["Compared with 1 T&M invoice; newest is invoice 1043"]);
  // in order: what it adds, the lines, the total, what to check, then why and the evidence
  assert.deepEqual([...c.querySelectorAll(".ap-ev > .ap-kv > .ap-k")].map((k) => k.textContent), ["Adds", "Lines", "Total", "To check", "Why", "Evidence"]);
  assert.equal(btn(c, "Approve and add lines").disabled, false);
  // Recently decided: what the executor did, and a card the next night's check no longer needed
  assert.deepEqual(recent().map((x) => x.dataset.key), ["spine:" + noGaps.id, "spine:" + present.id]);
  assert.equal(card("spine:" + noGaps.id).querySelector(".ap-out").textContent, "No longer needed: the invoice covers it");
  assert.equal(card("spine:" + present.id).querySelector(".ap-out").textContent, "Already on the job");
  // the reads: the field job only (never the board), the billing agent's name, no heartbeat
  const reads = calls.slice(before);
  assert.ok(reads.some((x) => x.u.includes("/field_projects?") && ids(x.u, "id").includes(FIELD1)));
  assert.ok(!reads.some((x) => x.u.includes("/coordination_jobs?")), "an invoice gap is on a field job");
  assert.ok(reads.some((x) => x.u.includes("/agents?") && ids(x.u, "id").includes(BILLING)));
  assert.equal(beats(before), 0);
  noJunk(view);
  reset5();
});

await test("Approve and add lines: one confirm naming the lines, the priced total and the job; the executed row lands as what was added", async () => {
  reset5();
  PA = [];
  PR = [gapsRow];
  await go();
  asked.length = 0;
  const added = { status: "added", invoice_id: "5d41402a-bc4b-2a76-b971-9d911017c592", lines_added: 4, total_usd: 721.25, unpriced: 2, rev: 42 };
  // runtime sql: op_proposal_approve runs the executor before it answers, so the row comes back executed
  spine = () => json(200, { ...gapsRow, status: "executed", approved_at: new Date().toISOString(), approved_via: "inbox",
    updated_at: new Date().toISOString(), result: added });
  const before = since0();
  btn(card("spine:" + gapsRow.id), "Approve and add lines").click();
  await settle();
  assert.deepEqual(asked, ["Add 4 lines ($721.25, 2 unpriced) as a new draft invoice on Pollen, 1192 Bemis Ct?"]);
  const rpc = calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_"));
  assert.match(rpc.u, /\/rest\/v1\/rpc\/op_proposal_approve$/);
  assert.deepEqual(rpc.body, { p_proposal_id: gapsRow.id, p_via: "inbox" }, "no edit: every line");
  const out = card("spine:" + gapsRow.id).querySelector(".ap-out");
  assert.equal(out.textContent, "Added 4 lines on a new draft invoice");
  assert.ok(out.classList.contains("ap-out--ok"));
  assert.equal(document.getElementById("toast").textContent, "Added 4 lines on a new draft invoice");
  // the invoices changed after it was filed: the executor refused, and the card says why
  await go();
  spine = () => json(200, { ...gapsRow, status: "failed", approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    error: "invoice.review_gaps: the job's invoices changed since this was proposed, so nothing was added; the nightly check files a fresh card if the work is still unbilled and the job is still one it checks (not archived, not every invoice paid)" });
  btn(card("spine:" + gapsRow.id), "Approve and add lines").click();
  await settle();
  assert.equal(card("spine:" + gapsRow.id).querySelector(".ap-out").textContent,
    "Failed: invoice.review_gaps: the job's invoices changed since this was proposed, so nothing was added; the nightly check files a fresh card if the work is still unbilled and the job is still one it checks (not archived, not every invoice paid)");
  noJunk(view);
  reset5();
});

/* ---------- the nightly QuickBooks match: receipts.qbo_link ---------- */
const CITI = "3176 - Citi - Home Depot Consumer Credit Card";
const photo = (c) => "media:" + c.repeat(64) + ":184211";
/* the Oct 7 read: Citi Home Depot bank-rule expenses with no job tag and no photo */
const hdItem = (receipt_id, date, amount, txn, c) => ({ receipt_id, vendor: "Home Depot", date, amount, receipt_no: "1303 00001 50615",
  qbo_txn_type: "Purchase", qbo_txn_id: txn, qbo_sync_token: "0", qbo_doc_number: "", qbo_account_name: CITI, qbo_total: amount,
  changes: ["tag", "attach"], photo_refs: [photo(c)], project_ref: "412739523" });
const qboInput = (items, o = {}) => ({ job_id: ALSTON, job_name: "2156 Alston rd.", receipts_fingerprint: "0123456789abcdef0123456789abcdef",
  items_hash: "fedcba9876543210fedcba9876543210", offer: 0, qbo_customer_id: "112", qbo_name: "Pollen Apartments",
  link: { qbo_customer_id: "112", qbo_name: "Pollen Apartments", qbo_project_ref: "412739523", source: "suggested_tagged",
    why: "1 of this job's receipts matches a QuickBooks expense already tagged to Pollen Apartments" },
  items, total_usd: items.reduce((t, i) => t + Math.abs(i.amount), 0), matcher: "receipts.qbo_match@1", ...o });
const qboRow = (n, items, o = {}) => ({ id: id("spine", 40 + n), operation: "receipts.qbo_link@1", sms_code: 30 + n, status: "proposed", edited_params: null,
  input: qboInput(items), proposed_by_kind: "agent", proposed_by_id: INTEGRATIONS,
  rationale: `${items.length} receipt${items.length === 1 ? "" : "s"} on 2156 Alston rd. ${items.length === 1 ? "matches a QuickBooks expense that has" : "match QuickBooks expenses that have"} no job tag or photo.`,
  evidence_refs: [], job_id: ALSTON, created_at: iso(-9), expires_at: iso(14 * 24 - 9 + n), approved_at: null, updated_at: iso(-9),
  decline_reason: null, result: null, error: null, ...o });
const q1 = qboRow(1, [hdItem("r-6788", "2026-09-24", 67.88, "10519", "b"), hdItem("r-1369", "2026-09-30", 1369.5, "10577", "a")]);
const q2 = qboRow(2, [hdItem("r-2790", "2026-10-01", 27.9, "10584", "c")], { job_id: FIELD1, input: { ...qboInput([hdItem("r-2790", "2026-10-01", 27.9, "10584", "c")]), job_id: FIELD1, job_name: "1192 Bemis Ct", link: undefined } });
const q3 = qboRow(3, [hdItem("r-4506", "2026-10-03", 45.06, "10614", "d")], { input: qboInput([hdItem("r-4506", "2026-10-03", 45.06, "10614", "d")], { link: undefined }) });
const QBO_HEAD = "QuickBooksUpdate QuickBooks for this job's receipts: ";
const QBO_OFF_WAITING = "QuickBooks updates are off on the worker right now: approving queues these, and they wait until updates are back on.";
const kvKeys = (root) => [...root.querySelectorAll(".ap-ev > .ap-kv > .ap-k")].map((k) => k.textContent);
const bulkBtn = () => view.querySelector(".ap-bulk button");
/* op_proposal_approve on a receipts card: runtime sql, so the row comes back
   executed with what the executor queued, and the next read finds it so too */
const answered = (r) => { PR = PR.map((x) => (x.id === r.id ? r : x)); return json(200, r); };
const queued = (r) => answered({ ...r, status: "executed", approved_at: new Date().toISOString(), approved_via: "inbox", updated_at: new Date().toISOString(),
  result: { queued: r.input.items.length, skipped: 0, outbox_ids: r.input.items.map((_, i) => `0000000${i}-0000-4000-8000-000000000000`) } });

await test("a QuickBooks receipts card shows a line per receipt and the project link, from the integrations agent, with no YES number", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  PA = [];
  PR = [q1];
  const before = since0();
  await go();
  const c = card("spine:" + q1.id);
  assert.equal(c.querySelector(".ap-head").textContent, QBO_HEAD + "2156 Alston rd.: 2 receipts");
  assert.ok(c.querySelector(".ap-head .badge").classList.contains("ap-qbo"), "its own chip");
  assert.match(c.querySelector(".ap-meta").textContent, /^2156 Alston rd\. · from Integrations agent · asked .+ · expires in 1[34] days$/);
  assert.equal(c.querySelector(".ap-yes"), null, "answered here only: roybal-notify never reads these");
  assert.equal(row(c, "Project").textContent,
    "Links this job to QuickBooks project Pollen Apartments: 1 of this job's receipts matches a QuickBooks expense already tagged to Pollen Apartments");
  assert.deepEqual([...c.querySelectorAll(".ap-lines > .ap-line")].map((l) => l.textContent), [
    `Home Depot · Sep 24 · $67.88 → QuickBooks expense 10519 (${CITI}): tag to Pollen Apartments, attach the photo`,
    `Home Depot · Sep 30 · $1,369.50 → QuickBooks expense 10577 (${CITI}): tag to Pollen Apartments, attach the photo`,
  ]);
  assert.equal(row(c, "Why").textContent, q1.rationale);
  assert.deepEqual(kvKeys(c), ["Project", "Receipts", "Why"], "the link, the receipts, then why; no evidence links");
  assert.equal(c.querySelector(".ap-lane"), null, "the worker is serving qbo: nothing about it");
  assert.equal(btn(c, "Approve: update QuickBooks").disabled, false);
  assert.equal(bulkBtn(), null, "one card: no Approve all");
  // the reads: the field job only, the agent's name, and the heartbeat (is the worker serving qbo)
  const reads = calls.slice(before);
  assert.ok(reads.some((x) => x.u.includes("/field_projects?") && ids(x.u, "id").includes(ALSTON)));
  assert.ok(!reads.some((x) => x.u.includes("/coordination_jobs?")), "receipts are on a field job");
  assert.ok(reads.some((x) => x.u.includes("/agents?") && ids(x.u, "id").includes(INTEGRATIONS)));
  assert.equal(beats(before), 1);
  noJunk(view);
  // the worker not serving qbo (RECEIPTS_QBO=off): approving queues them, and the card says so before the tap
  heartbeat = beatAt(0.5, ["sms", "email"]);
  await go();
  const lane = card("spine:" + q1.id).querySelector(".ap-lane");
  assert.equal(lane.textContent, QBO_OFF_WAITING);
  assert.ok(lane.compareDocumentPosition(card("spine:" + q1.id).querySelector(".ap-actions")) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  reset5();
});

await test("an approved QuickBooks card reads every outbox row it wrote and says how they went", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  const items = [...q1.input.items, hdItem("r-2790", "2026-10-01", 27.9, "10584", "c")];
  const done = { ...qboRow(4, items), sms_code: null, status: "executed", approved_at: iso(-3), updated_at: iso(-3),
    result: { queued: 3, skipped: 0, outbox_ids: [] } };
  const ob = (status, error = null) => ({ proposal_id: done.id, status, next_attempt_at: iso(-3), error, created_at: iso(-3), updated_at: iso(-2) });
  PA = [];
  PR = [done];
  OUTBOX = [ob("sent"), ob("dead", "tagged_other: expense 10584 is already tagged to Bemis Ct in QuickBooks"), ob("sent")];
  const before = since0();
  await go();
  const out = card("spine:" + done.id).querySelector(".ap-out");
  assert.equal(out.textContent, "2 of 3 updated in QuickBooks; 1 refused: tagged to another job");
  assert.ok(out.classList.contains("ap-out--bad"));
  const read = calls.slice(before).find((x) => x.u.includes("/outbox?select="));
  assert.deepEqual(ids(read.u, "proposal_id"), [done.id]);
  assert.match(read.u, /&order=created_at\.desc&limit=1000$/, "a row per receipt: room for many cards' worth");
  // all through
  OUTBOX = [ob("sent"), ob("sent"), ob("delivered")];
  await go();
  assert.equal(card("spine:" + done.id).querySelector(".ap-out").textContent, "All 3 updated in QuickBooks");
  // still going with the worker's qbo channel off
  heartbeat = beatAt(0.5, ["sms", "email"]);
  OUTBOX = [ob("sent"), ob("pending"), ob("failed", "qbo_unavailable: QuickBooks 503")];
  await go();
  assert.equal(card("spine:" + done.id).querySelector(".ap-out").textContent, "1 of 3 updated in QuickBooks; 2 waiting (QuickBooks updates are off on the worker)");
  noJunk(view);
  reset5();
});

await test("Approve on one QuickBooks card: one confirm naming the receipts and the job, the single RPC, and it lands as queued", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  PA = [];
  PR = [q1];
  await go();
  asked.length = 0;
  spine = (fn, body) => (fn === "op_proposal_approve" && body.p_proposal_id === q1.id ? queued(q1) : json(500, { message: "unexpected" }));
  const before = since0();
  btn(card("spine:" + q1.id), "Approve: update QuickBooks").click();
  await settle();
  assert.deepEqual(asked, ["Update QuickBooks for 2 receipts on 2156 Alston rd.?"]);
  const rpc = calls.slice(before).filter((x) => x.u.includes("/rpc/op_proposal_"));
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].body, { p_proposal_id: q1.id, p_via: "inbox" }, "no edit: every receipt");
  const out = card("spine:" + q1.id).querySelector(".ap-out");
  assert.equal(out.textContent, "2 queued for QuickBooks");
  assert.ok(out.classList.contains("ap-out--wait"));
  assert.equal(document.getElementById("toast").textContent, "2 queued for QuickBooks");
  reset5();
});

await test("Approve all QuickBooks cards: shown for two or more, one confirm, each card through its own Approve call in order, then a fresh read", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  PA = [reminder];
  PR = [email, q3, q1, q2];
  await go();
  assert.equal(bulkBtn().textContent, "Approve all QuickBooks cards (3)");
  const keys = waiting().map((c) => c.dataset.key);
  assert.deepEqual(keys, ["spine:" + email.id, "text:" + reminder.id, "spine:" + q1.id, "spine:" + q2.id, "spine:" + q3.id]);
  assert.ok(bulkBtn().closest(".ap-bulk").compareDocumentPosition(waiting()[0]) & window.Node.DOCUMENT_POSITION_FOLLOWING, "above the list");
  // nothing happens without the yes
  asked.length = 0;
  confirmAnswer = false;
  let before = since0();
  bulkBtn().click();
  await settle();
  assert.deepEqual(asked, ["Update QuickBooks for all 3 cards: 4 receipts on 2 jobs? Each card is approved in turn, and it stops at the first one that doesn't go through."]);
  assert.equal(calls.slice(before).filter((x) => x.u.includes("/rpc/op_proposal_")).length, 0);
  confirmAnswer = true;
  // yes: each in turn, waiting on the one before it
  asked.length = 0;
  const order = [];
  const rowsById = { [q1.id]: q1, [q2.id]: q2, [q3.id]: q3 };
  let running = 0, most = 0;
  spine = async (fn, body) => {
    order.push([fn, body]);
    running++; most = Math.max(most, running);
    await settle(5);
    running--;
    return queued(rowsById[body.p_proposal_id]);
  };
  before = since0();
  bulkBtn().click();
  await settle(150);
  assert.equal(asked.length, 1, "the one confirm; no per-card confirm after it");
  assert.deepEqual(order, [q1, q2, q3].map((r) => ["op_proposal_approve", { p_proposal_id: r.id, p_via: "inbox" }]), "soonest expiry first, the single Approve's call");
  assert.equal(most, 1, "one at a time");
  assert.deepEqual(waiting().map((c) => c.dataset.key), ["spine:" + email.id, "text:" + reminder.id], "the others untouched");
  assert.deepEqual([q1, q2, q3].map((r) => card("spine:" + r.id).querySelector(".ap-out").textContent),
    ["2 queued for QuickBooks", "Queued for QuickBooks", "Queued for QuickBooks"]);
  assert.equal(document.getElementById("toast").textContent, "Approved 3 QuickBooks cards.");
  assert.equal(bulkBtn(), null, "nothing left to approve all");
  // then it reads where things stand
  const after = calls.slice(before);
  const lastRpc = after.findLastIndex((x) => x.u.includes("/rpc/op_proposal_"));
  assert.ok(after.slice(lastRpc).some((x) => x.u.includes("/rest/v1/proposals?select=")), "a fresh read after the last answer");
  noJunk(view);
  reset5();
});

await test("Approve all stops at the first card that doesn't go through: a refusal, or a card the executor failed", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  const MOVED = "receipts.qbo_link: the receipts changed since this card was filed, so nothing was queued; tonight's match files a fresh card if QuickBooks still needs the change";
  // the second card's executor fails (its receipts changed since filing): the approval stands, the card failed
  PA = [];
  PR = [q1, q2, q3];
  await go();
  let order = [];
  spine = (fn, body) => {
    order.push(body.p_proposal_id);
    if (body.p_proposal_id === q2.id) {
      return answered({ ...q2, status: "failed", approved_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: MOVED });
    }
    return queued(body.p_proposal_id === q1.id ? q1 : q3);
  };
  bulkBtn().click();
  await settle(150);
  assert.deepEqual(order, [q1.id, q2.id], "the third is never sent");
  assert.equal(card("spine:" + q1.id).querySelector(".ap-out").textContent, "2 queued for QuickBooks");
  assert.equal(card("spine:" + q2.id).querySelector(".ap-out").textContent, "Failed: " + MOVED);
  assert.deepEqual(waiting().map((c) => c.dataset.key), ["spine:" + q3.id], "the rest still waiting");
  assert.equal(document.getElementById("toast").textContent, "Stopped after 1 of 3: one didn't go through, and the rest are still waiting.");
  // a refusal on the first: its line under the card, nothing else sent
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "qbo"]);
  PA = [];
  PR = [q1, q2, q3];
  await go();
  order = [];
  spine = (fn, body) => { order.push(body.p_proposal_id); return json(403, { code: "42501", message: "op spine: not allowed" }); };
  const before = since0();
  bulkBtn().click();
  await settle(150);
  assert.deepEqual(order, [q1.id]);
  assert.equal(errText("spine:" + q1.id), "Your login isn't allowed to answer this one.");
  assert.equal(btn(card("spine:" + q1.id), "Approve: update QuickBooks").disabled, false, "its buttons back");
  assert.deepEqual(waiting().map((c) => c.dataset.key), [q1, q2, q3].map((r) => "spine:" + r.id));
  assert.equal(bulkBtn().textContent, "Approve all QuickBooks cards (3)", "and the button, to try again");
  assert.equal(bulkBtn().disabled, false);
  assert.equal(document.getElementById("toast").textContent, "Stopped after 0 of 3: one didn't go through, and the rest are still waiting.");
  assert.ok(calls.slice(before).some((x) => x.u.includes("/rest/v1/proposals?select=")), "a fresh read");
  noJunk(view);
  reset5();
});

/* ---------- carrier packets: packet.send ---------- */
const PDF_URL = `https://demo.supabase.co/storage/v1/object/sign/carrier-packets/${SAMPLE}/PKT-2026-0007-v1-b1.pdf?token=demo`;
const PKT_BODY = "Hello,\n\nAttached is the water mitigation documentation for this claim, as one PDF: carrier packet PKT-2026-0007, version 1.\n\n" +
  "Insured: Jane Sample\nProperty: 123 Example St, Fairbanks, AK 99701\nClaim: DEMO-12345\nCarrier: Sample Mutual\n\nPlease reply to confirm you received it.";
const PKT_SUBJECT = "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)";
const PKT_FILE = "PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf";
const PKT_FROM = "the newest email filed to this job on its claim number";
const PKT_WHY = "Carrier packet PKT-2026-0007 v1 for Jane Sample, 123 Example St, Fairbanks, AK 99701.\n" +
  "Suggested To: adjuster@example.com, from the newest email filed to this job on its claim number.\n38 pages, 6.1 MB.";
/* what carrier_packet_file files: the suggestion, never a to or cc; no SMS code */
const pktRow = { id: id("spine", 60), operation: "packet.send@1", sms_code: null, status: "proposed", edited_params: null,
  input: { packet_version_id: "dddddddd-0000-4000-8000-000000000001", offer: 0, subject: PKT_SUBJECT, body: PKT_BODY, filename: PKT_FILE,
    suggested_to: "adjuster@example.com", suggested_from: PKT_FROM },
  proposed_by_kind: "agent", proposed_by_id: DOCUMENTS, rationale: PKT_WHY,
  evidence_refs: [{ kind: "pdf", label: "Carrier packet PKT-2026-0007 v1 (PDF)", url: PDF_URL }],
  job_id: SAMPLE, created_at: iso(-1), expires_at: iso(14 * 24 - 1), approved_at: null, updated_at: iso(-1), decline_reason: null, result: null, error: null };
const PKT_HEAD = "Carrier packetEmail the carrier packet to the adjuster: PKT-2026-0007 v1 - Claim DEMO-12345 - Sample";
/* op_proposal_approve on a packet card: runtime sql, so the row comes back executed with the edit it was given */
const pktApproved = (body) => answered({ ...pktRow, status: "executed", edited_params: body.p_edited_params, approved_at: new Date().toISOString(),
  approved_via: "inbox", updated_at: new Date().toISOString(),
  result: { outbox_id: "eeeeeeee-0000-4000-8000-000000000001", packet_version_id: pktRow.input.packet_version_id, to: body.p_edited_params.to } });
const pktOut = (status, o = {}) => ({ proposal_id: pktRow.id, status, next_attempt_at: iso(-1), error: null, created_at: iso(-1), updated_at: iso(-0.9), ...o });
const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const toOf = (key) => card(key).querySelector("input.ap-to");
const ccOf = (key) => card(key).querySelector("input.ap-cc");
const PKT = "spine:" + pktRow.id;

await test("a carrier packet card: the To filled with the worker's suggestion and where it came from, a Cc, the subject, the email behind Show the email, the PDF link, and no YES number", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [{ ...pktRow, sms_code: 31 }];                   // a number on the row is still never offered
  const before = since0();
  await go();
  const c = card(PKT);
  assert.equal(c.querySelector(".ap-head").textContent, PKT_HEAD);
  assert.equal(c.querySelector(".ap-head .badge").className, "badge disp-b", "an email to the adjuster: the email's tone");
  assert.match(c.querySelector(".ap-meta").textContent, /^Jane Sample, 123 Example St, Fairbanks, AK 99701 · from Documents agent · asked .+ · expires in 1[34] days$/);
  const to = toOf(PKT), cc = ccOf(PKT);
  assert.deepEqual([to.type, to.value, cc.value], ["email", "adjuster@example.com", ""]);
  assert.equal(c.querySelector(`label[for="${to.id}"]`).textContent, "To");
  assert.equal(c.querySelector(`label[for="${cc.id}"]`).textContent, "Cc");
  assert.equal(row(c, "To").querySelector(".ap-addr").textContent, "From " + PKT_FROM + ".");
  assert.equal(c.querySelector(".ap-addr--bad").hidden, true, "a good address: nothing wrong to say");
  assert.equal(row(c, "Subject").textContent, PKT_SUBJECT);
  // the email: collapsed, whole once shown, and collapsed again
  const mail = c.querySelector(".ap-mail"), toggle = btn(c, "Show the email");
  assert.deepEqual([mail.hidden, toggle.getAttribute("aria-expanded")], [true, "false"]);
  toggle.click();
  assert.deepEqual([mail.hidden, mail.textContent, toggle.textContent, toggle.getAttribute("aria-expanded")], [false, PKT_BODY, "Hide the email", "true"]);
  toggle.click();
  assert.deepEqual([mail.hidden, toggle.textContent], [true, "Show the email"]);
  // the PDF: its own row, the host it really opens first, a new tab with no opener
  const pdf = row(c, "PDF");
  assert.equal(pdf.textContent, "opens demo.supabase.co — Open the PDF · " + PKT_FILE);
  const a = pdf.querySelector("a");
  assert.deepEqual([a.getAttribute("href"), a.getAttribute("target"), a.textContent], [PDF_URL, "_blank", "Open the PDF"]);
  assert.match(a.getAttribute("rel"), /\bnoopener\b/);
  assert.equal(row(c, "Why").textContent, PKT_WHY);
  assert.deepEqual(kvKeys(c), ["To", "Cc", "Subject", "Email", "PDF", "Why"], "the PDF link isn't listed again under Evidence");
  assert.equal(c.querySelector(".ap-yes"), null, "inbox only: no YES number");
  assert.equal(c.querySelector(".ap-lane"), null, "the worker is serving packets: nothing about it");
  assert.equal(btn(c, "Approve and send").disabled, false);
  // the reads: the field job only, the documents agent's name, and the heartbeat (is the packet channel served)
  const reads = calls.slice(before);
  assert.ok(reads.some((x) => x.u.includes("/field_projects?") && ids(x.u, "id").includes(SAMPLE)));
  assert.ok(!reads.some((x) => x.u.includes("/coordination_jobs?")), "a packet is on a field job");
  assert.ok(reads.some((x) => x.u.includes("/agents?") && ids(x.u, "id").includes(DOCUMENTS)));
  assert.equal(beats(before), 1);
  noJunk(view);
  reset5();
});

await test("Approve stays off until the To is one good address, saying what's wrong in the adjuster email's words; a bad Cc too; what he typed survives a repaint", async () => {
  const { checkAddress } = await import("../js/adjustersend.js");
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  const approveOff = () => btn(card(PKT), "Approve and send").disabled;
  const wrong = () => card(PKT).querySelector(".ap-addr--bad");
  for (const v of ["", "   ", "a@example.com, b@example.com", "a@example.com; b@example.com", "Jane Sample <jane@example.com>", "jane",
    "jane@example", "jane@@example.com", "jane sample@example.com", "x".repeat(320) + "@example.com", "kelly.o'brien@example.com",
    "  claims@example.com  ", "CLAIMS@EXAMPLE.COM"]) {
    typeIn(toOf(PKT), v);
    const want = checkAddress(v);
    assert.equal(approveOff(), !want.ok, JSON.stringify(v));
    assert.equal(wrong().hidden, want.ok, JSON.stringify(v));
    assert.equal(wrong().textContent, want.ok ? "" : want.error, JSON.stringify(v));
  }
  // a changed To says what was suggested; the suggestion again (any case) says where it came from
  typeIn(toOf(PKT), "claims@example.com");
  assert.equal(row(card(PKT), "To").querySelector(".ap-addr").textContent, `Suggested: adjuster@example.com, from ${PKT_FROM}.`);
  typeIn(toOf(PKT), "Adjuster@Example.com");
  assert.equal(row(card(PKT), "To").querySelector(".ap-addr").textContent, `From ${PKT_FROM}.`);
  typeIn(toOf(PKT), "claims@example.com");
  for (const [v, error] of [["office@example.com", ""], [" office@example.com , second@example.com ", ""], ["office@example.com; second@example.com", ""],
    ["office", "Cc: “office” doesn't look like an email address."], ["office@example.com second@example.com", "Cc: “office@example.com second@example.com” doesn't look like an email address."],
    ["Office <office@example.com>", "Cc: just the addresses, without the names."],
    [Array.from({ length: 60 }, (_, i) => `person${i}@example.com`).join(", "), "Cc: that's too many addresses."], ["", ""]]) {
    typeIn(ccOf(PKT), v);
    assert.equal(approveOff(), !!error, v);
    assert.equal(wrong().textContent, error, v);
  }
  // a repaint (Refresh, the 45 s timer, another card's answer) keeps what he typed and the open email
  typeIn(ccOf(PKT), "office@example.com");
  btn(card(PKT), "Show the email").click();
  btn(view, "↻ Refresh").click();
  await settle();
  assert.deepEqual([toOf(PKT).value, ccOf(PKT).value], ["claims@example.com", "office@example.com"]);
  assert.equal(card(PKT).querySelector(".ap-mail").hidden, false);
  assert.equal(row(card(PKT), "To").querySelector(".ap-addr").textContent, `Suggested: adjuster@example.com, from ${PKT_FROM}.`);
  // and a bad one stays bad after the repaint, Approve off
  typeIn(toOf(PKT), "claims");
  btn(view, "↻ Refresh").click();
  await settle();
  assert.equal(approveOff(), true);
  assert.equal(wrong().textContent, "That doesn't look like an email address.");
  reset5();
});

await test("a stray angle bracket in the To or a Cc keeps Approve off; whatever Approve can send, the worker's address check takes", async () => {
  const { validAddresses } = await import("../../../services/worker/rfc822.mjs");
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  const approveOff = () => btn(card(PKT), "Approve and send").disabled;
  const wrong = () => card(PKT).querySelector(".ap-addr--bad");
  // half a pasted "Name <address>": the worker would refuse it for good
  for (const v of ["adjuster@example.com>", "<adjuster@example.com", "adj<uster@example.com", "adjuster@exam>ple.com"]) {
    assert.equal(validAddresses(v), false, v);
    typeIn(toOf(PKT), v);
    assert.equal(approveOff(), true, v);
    assert.equal(wrong().textContent, "Just the address, without the name.", v);
  }
  typeIn(toOf(PKT), "claims@example.com");
  for (const v of ["office@example.com>", "<office@example.com", "office@example.com, <second@example.com", "office@example.com; second@example.com>"]) {
    assert.equal(validAddresses(v.replace(/;/g, ",")), false, v);
    typeIn(ccOf(PKT), v);
    assert.equal(approveOff(), true, v);
    assert.equal(wrong().textContent, "Cc: just the addresses, without the names.", v);
  }
  // every To and Cc Approve is on for goes through the worker's check as sent
  let on = 0;
  for (const to of ["claims@example.com", "  claims@example.com ", "kelly.o'brien@example.com", "<claims@example.com>", "claims@example.com>",
    "Jane Sample <claims@example.com>", "claims@exa,mple.com", "claims@example.com;"]) {
    for (const cc of ["", "office@example.com", " office@example.com , second@example.com ", "office@example.com; second@example.com",
      "<office@example.com>", "office@example.com>", "Office <office@example.com>", "office@example.com;; ,second@example.com"]) {
      typeIn(toOf(PKT), to);
      typeIn(ccOf(PKT), cc);
      if (approveOff()) continue;
      on++;
      assert.ok(validAddresses(to), JSON.stringify([to, cc]));
      assert.ok(!cc.trim() || validAddresses(cc.replace(/;/g, ",")), JSON.stringify([to, cc]));
    }
  }
  assert.equal(on, 3 * 5, "the bare addresses, and only those, are approvable");
  reset5();
});

await test("the 45 s refresh waits while he's typing in a packet's To or Cc, and goes once he isn't", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [reminder];
  PR = [pktRow];
  const tick = await onTimer();
  for (const field of [toOf, ccOf]) {
    field(PKT).focus();
    assert.equal(document.activeElement, field(PKT));
    let before = since0();
    tick();
    await settle();
    assert.equal(listReads(before), 0, "no repaint under his hands");
    field(PKT).blur();
    before = since0();
    tick();
    await settle();
    assert.equal(listReads(before), 1);
  }
  reset5();
});

await test("a refresh whose proposals read failed keeps the To and Cc he typed and the open email: the next good read shows them, and Approve sends them", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [reminder];
  PR = [];                    // a good read without the card: nothing typed or opened on it before is kept
  await go();
  PR = [pktRow];
  OUTBOX = [];
  await go();
  assert.deepEqual([toOf(PKT).value, ccOf(PKT).value, card(PKT).querySelector(".ap-mail").hidden], ["adjuster@example.com", "", true]);
  typeIn(toOf(PKT), "claims@example.com");
  typeIn(ccOf(PKT), "office@example.com");
  btn(card(PKT), "Show the email").click();
  const real = globalThis.fetch;
  const reads = [
    // a 5xx on the proposals read: the text queue still shows, the packet card doesn't
    [async (url, opts) => (String(url).includes("/rest/v1/proposals?") && !(opts.headers || {}).Range ? json(503, { message: "upstream" }) : real(url, opts)),
      ["The new approvals queue didn't load (503)."]],
    // no connection at all (a laptop waking): both queues down
    [async (url, opts) => { if (/\/rest\/v1\/(proposals|pending_actions)\?/.test(String(url))) throw new TypeError("Failed to fetch"); return real(url, opts); },
      ["The text queue didn't load: no connection.", "The new approvals queue didn't load: no connection."]],
  ];
  for (const [down, warns] of reads) {
    globalThis.fetch = down;
    btn(view, "↻ Refresh").click();
    await settle();
    globalThis.fetch = real;
    assert.deepEqual([...view.querySelectorAll(".warn:not(.ap-err)")].map((w) => w.textContent), warns);
    assert.equal(card(PKT), null, "its queue didn't load");
    btn(view, "↻ Refresh").click();
    await settle();
    assert.deepEqual([toOf(PKT).value, ccOf(PKT).value], ["claims@example.com", "office@example.com"], warns[0]);
    assert.equal(row(card(PKT), "To").querySelector(".ap-addr").textContent, `Suggested: adjuster@example.com, from ${PKT_FROM}.`);
    assert.equal(card(PKT).querySelector(".ap-mail").hidden, false, "the email he opened stays open");
  }
  asked.length = 0;
  spine = (fn, body) => pktApproved(body);
  const before = since0();
  btn(card(PKT), "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send the carrier packet to claims@example.com, Cc office@example.com?"]);
  assert.deepEqual(calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_")).body.p_edited_params,
    { to: "claims@example.com", cc: "office@example.com" });
  // a read that loaded without the card (answered elsewhere) lets what he typed go
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  typeIn(toOf(PKT), "claims@example.com");
  PR = [];
  btn(view, "↻ Refresh").click();
  await settle();
  assert.equal(card(PKT), null);
  PR = [pktRow];
  btn(view, "↻ Refresh").click();
  await settle();
  assert.deepEqual([toOf(PKT).value, ccOf(PKT).value], ["adjuster@example.com", ""]);
  reset5();
});

await test("Approve and send: one confirm naming the To and Cc, then op_proposal_approve with p_edited_params {to, cc} built on this page; the card then reads its outbox row", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  OUTBOX = [];
  await go();
  typeIn(toOf(PKT), "  claims@example.com ");
  typeIn(ccOf(PKT), "office@example.com; second@example.com");
  // a cancelled confirm sends nothing
  asked.length = 0;
  confirmAnswer = false;
  let before = since0();
  btn(card(PKT), "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send the carrier packet to claims@example.com, Cc office@example.com, second@example.com?"]);
  assert.equal(calls.slice(before).filter((x) => x.u.includes("/rpc/op_proposal_")).length, 0);
  confirmAnswer = true;
  // yes: the To and Cc as checked, in the one request, the fields held still while it's out
  let release;
  spine = (fn, body) => new Promise((res) => { release = () => res(pktApproved(body)); });
  asked.length = 0;
  before = since0();
  btn(card(PKT), "Approve and send").click();
  await settle(10);
  assert.equal(asked.length, 1);
  const rpc = calls.slice(before).filter((x) => x.u.includes("/rpc/op_proposal_"));
  assert.equal(rpc.length, 1);
  assert.match(rpc[0].u, /\/rest\/v1\/rpc\/op_proposal_approve$/);
  assert.deepEqual(rpc[0].body, { p_proposal_id: pktRow.id, p_via: "inbox",
    p_edited_params: { to: "claims@example.com", cc: "office@example.com, second@example.com" } });
  assert.deepEqual([toOf(PKT).readOnly, ccOf(PKT).readOnly], [true, true]);
  assert.equal(btn(card(PKT), "Working…").disabled, true);
  release();
  await settle();
  const out = () => card(PKT).querySelector(".ap-out");
  assert.equal(card(PKT).classList.contains("ap-card--done"), true);
  assert.deepEqual([out().textContent, out().className], ["Queued to send", "ap-out ap-out--wait"]);
  assert.equal(document.getElementById("toast").textContent, "Queued to send");
  // the worker sent it: the next read finds its outbox row
  OUTBOX = [pktOut("sent")];
  before = since0();
  await go();
  assert.deepEqual([out().textContent, out().className], ["Sent from Gmail", "ap-out ap-out--ok"]);
  assert.ok(calls.slice(before).some((x) => x.u.includes("/outbox?select=") && ids(x.u, "proposal_id").includes(pktRow.id)), "its outbox row is read");
  OUTBOX = [pktOut("dead", { error: "Gmail refused the message: it is too large" })];
  await go();
  assert.deepEqual([out().textContent, out().className], ["Couldn't send: Gmail refused the message: it is too large", "ap-out ap-out--bad"]);
  // a blank Cc goes as ""
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  asked.length = 0;
  spine = (fn, body) => pktApproved(body);
  before = since0();
  btn(card(PKT), "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send the carrier packet to adjuster@example.com?"]);
  assert.deepEqual(calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_")).body.p_edited_params, { to: "adjuster@example.com", cc: "" });
  noJunk(view);
  reset5();
});

await test("a packet refusal keeps the card, its To and Cc as typed; an executor that refused says why; decline is as on any spine card", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  typeIn(toOf(PKT), "claims@example.com");
  spine = () => json(400, { code: "22023", message: "op spine: edited input is invalid: to: does not match the pattern" });
  btn(card(PKT), "Approve and send").click();
  await settle();
  assert.equal(errText(PKT), "The server refused this as invalid: edited input is invalid: to: does not match the pattern. Nothing changed.");
  assert.equal(card(PKT).classList.contains("ap-card--done"), false, "still waiting");
  assert.deepEqual([toOf(PKT).value, toOf(PKT).readOnly, btn(card(PKT), "Approve and send").disabled], ["claims@example.com", false, false]);
  // the executor said no (the packet changed under the card): the approval stands, the card failed, with why
  const NEWER = "packet.send: a newer version of this packet exists, so nothing was sent";
  spine = (fn, body) => answered({ ...pktRow, status: "failed", edited_params: body.p_edited_params,
    approved_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: NEWER });
  btn(card(PKT), "Approve and send").click();
  await settle();
  assert.equal(card(PKT).querySelector(".ap-out").textContent, "Failed: " + NEWER);
  // decline: a prompt for the reason, op_proposal_decline as for any spine card, with no To in it
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [pktRow];
  await go();
  asked.length = 0;
  promptAnswer = "Sent it by hand";
  spine = (fn, body) => answered({ ...pktRow, status: "declined", decline_reason: body.p_reason, updated_at: new Date().toISOString() });
  const before = since0();
  btn(card(PKT), "Decline").click();
  await settle();
  assert.match(asked[0], /^Decline "Email the carrier packet to the adjuster: PKT-2026-0007 v1 - Claim DEMO-12345 - Sample"\?\n\nA reason/);
  const rpc = calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_"));
  assert.match(rpc.u, /op_proposal_decline$/);
  assert.deepEqual(rpc.body, { p_proposal_id: pktRow.id, p_reason: "Sent it by hand" });
  assert.equal(card(PKT).querySelector(".ap-out").textContent, "Declined: Sent it by hand");
  promptAnswer = "";
  reset5();
});

await test("the worker not serving the packet channel: the waiting packet says approving queues it, an approved one says it waits; the email card reads email's own", async () => {
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email"]);                 // CARRIER_PACKET=off
  const queuedPkt = { ...pktRow, id: id("spine", 61), status: "executed", edited_params: { to: "claims@example.com", cc: "" },
    approved_at: iso(-2), updated_at: iso(-2), result: { outbox_id: "eeeeeeee-0000-4000-8000-000000000002" } };
  PA = [];
  PR = [email, pktRow, queuedPkt];
  OUTBOX = [{ ...pktOut("pending"), proposal_id: queuedPkt.id }];
  await go();
  const lane = card(PKT).querySelector(".ap-lane");
  assert.equal(lane.textContent, OFF_WAITING);
  assert.ok(lane.compareDocumentPosition(card(PKT).querySelector(".ap-actions")) & window.Node.DOCUMENT_POSITION_FOLLOWING, "read before the buttons");
  assert.equal(card("spine:" + email.id).querySelector(".ap-lane"), null, "email itself is on");
  assert.equal(card("spine:" + queuedPkt.id).querySelector(".ap-out").textContent, OFF_QUEUED);
  assert.equal(btn(card(PKT), "Approve and send").disabled, false, "still answerable");
  reset5();
});

await test("a packet card from an older cached field module (kind other) still gets the packet branch: To and Cc, the email, the PDF, no YES number, and an Approve that carries the To", async () => {
  const OLD = await import("../js/approvals.js?old");
  assert.equal(OLD.fromProposal(pktRow).kind, "other", "that module doesn't know packets");
  assert.equal(OLD.fromProposal({ ...pktRow, sms_code: 31 }).yesHint, "or text YES 31", "and would offer the row's number");
  assert.deepEqual(OLD.decisionRequest(OLD.fromProposal(pktRow), "approve").body, { p_proposal_id: pktRow.id, p_via: "inbox" },
    "its request has no To: the page must not use it");
  const S = await import("../../admin/js/approvals.js?field=old");
  reset5();
  heartbeat = beatAt(0.5, ["sms", "email", "packet"]);
  PA = [];
  PR = [{ ...pktRow, sms_code: 31 }];
  OUTBOX = [];
  await go(S);
  const c = card(PKT);
  assert.equal(c.querySelector(".ap-head").textContent, "Carrier packetEmail the carrier packet to the adjuster", "the chip is the page's");
  assert.equal(c.querySelector(".ap-head .badge").className, "badge disp-b");
  assert.deepEqual([toOf(PKT).value, ccOf(PKT).value], ["adjuster@example.com", ""], "the suggestion, from the row");
  assert.equal(row(c, "To").querySelector(".ap-addr").textContent, "From " + PKT_FROM + ".");
  assert.equal(row(c, "Subject").textContent, PKT_SUBJECT);
  btn(c, "Show the email").click();
  assert.equal(c.querySelector(".ap-mail").textContent, PKT_BODY, "the body, from the row");
  assert.equal(row(c, "PDF").querySelector("a").getAttribute("href"), PDF_URL);
  assert.equal(row(c, "PDF").textContent, "opens demo.supabase.co — Open the PDF · " + PKT_FILE);
  assert.deepEqual(kvKeys(c), ["To", "Cc", "Subject", "Email", "PDF", "Why"]);
  assert.equal(c.querySelector(".ap-yes"), null, "no YES number, whatever that module offers");
  typeIn(toOf(PKT), "Jane <jane@example.com>");
  assert.equal(btn(c, "Approve and send").disabled, true);
  typeIn(toOf(PKT), "claims@example.com");
  assert.equal(btn(c, "Approve and send").disabled, false);
  asked.length = 0;
  spine = (fn, body) => pktApproved(body);
  const before = since0();
  btn(c, "Approve and send").click();
  await settle();
  assert.deepEqual(asked, ["Send the carrier packet to claims@example.com?"]);
  assert.deepEqual(calls.slice(before).find((x) => x.u.includes("/rpc/op_proposal_")).body,
    { p_proposal_id: pktRow.id, p_via: "inbox", p_edited_params: { to: "claims@example.com", cc: "" } });
  // that module reads no outbox row for it and would say "Done": the page says it was queued, and where to look
  const STALE = "Queued to send. Reload the page to see how it went.";
  assert.equal(card(PKT).querySelector(".ap-out").textContent, STALE);
  assert.equal(document.getElementById("toast").textContent, STALE);
  assert.equal(card(PKT).querySelector(".ap-head").textContent, "Carrier packetEmail the carrier packet to the adjuster");
  noJunk(view);
  reset5();
});

location.hash = "#/";
console.log(`\n${pass} passed`);
process.exit(0);
