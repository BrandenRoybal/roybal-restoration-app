/* adjustersend.js — the narrative page's adjuster email as "approve to
   send" (operations spine, step 5): who gets offered it (the owner, while
   the email lane is live, and nobody on any failed check), the To prefill
   from records, the address check with the spine's own pattern, the exact
   op_propose / approve / decline bodies, every answer the spine can give
   and its sentence, what an approved email's outbox row says about it
   (went out, couldn't be sent, on its way), and the section's whole life
   in jsdom against a faked PostgREST that throws on any request it
   doesn't expect.
   Run: node --test test/adjustersend.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/" });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "HTMLElement", "Node", "Event", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
/* signed in BEFORE supa.js loads (it reads the session at import) */
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "a.b.c", refresh_token: "r", email: "branden@x.com", expires_at: Date.now() + 1e9 }));

const asked = [];
let answerConfirm = true, answerPrompt = "";
globalThis.confirm = (q) => { asked.push(q); return answerConfirm; };
globalThis.prompt = (q) => { asked.push(q); return answerPrompt; };

/* ---- fake PostgREST ---- */
const calls = [];
const net = {};
const resetNet = () => Object.assign(net, {
  role: () => [200, true],
  lane: () => [200, true],
  emails: () => [200, []],
  open: () => [200, []],
  outbox: () => [200, []],
  propose: null, approve: null, decline: null,
  office: () => [200, { ok: true, draft: { subject: "Claim CLM-77", body: "Hello" } }],
});
resetNet();
const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body === undefined) throw new SyntaxError("no body"); return body; },
  text: async () => JSON.stringify(body),
});
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path: u.pathname, query: u.search, body });
  const route = {
    "/auth/v1/token": () => [200, { access_token: "t." + body.email, refresh_token: "r", expires_in: 3600, user: { email: body.email } }],
    "/rest/v1/rpc/role_is": net.role,
    "/rest/v1/rpc/outbox_channel_ready": net.lane,
    "/rest/v1/email_messages": net.emails,
    "/rest/v1/proposals": net.open,
    "/rest/v1/outbox": net.outbox,
    "/rest/v1/rpc/op_propose": net.propose,
    "/rest/v1/rpc/op_proposal_approve": net.approve,
    "/rest/v1/rpc/op_proposal_decline": net.decline,
    "/functions/v1/roybal-ai-office": net.office,
  }[u.pathname];
  if (!route) throw new Error("unexpected request " + u.pathname + u.search);
  const out = await route(body, u);
  if (out instanceof Error) throw out;
  return resp(out[0], out[1]);
};
const { signIn } = await import("../js/supa.js");
const S = await import("../js/adjustersend.js");
const login = async (email) => { await signIn(email, "pw"); calls.length = 0; };

// 10:00 AM Alaska (AKDT, UTC-8) on Tue Oct 6 2026
const NOW = Date.parse("2026-10-06T18:00:00.000Z");
const iso = (h) => new Date(NOW + h * 3600e3).toISOString();
const JOB = "11111111-1111-4111-8111-111111111111";
const project = {
  id: JOB, customer: "Jane Pollen", address: "1192 Bemis Ct", claimNo: "CLM-77\b \b", email: "Jane@Pollen.com",
  adjuster: "Bob Adams (bob.adams@carrier.com), 907-555-1212",
};
const LINKS = {
  packet: "https://portal.roybalconstruction.com/packet/tokP",
  photos: "https://portal.roybalconstruction.com/photos/tokF",
};
const row = (over = {}) => ({
  id: "bbbbbbbb-0000-4000-8000-000000000001", operation: "email.send@1", status: "proposed", sms_code: 4,
  input: { to: "adj@carrier.com", subject: "Claim CLM-77", body: "Hello" }, edited_params: null,
  job_id: JOB, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(), created_at: new Date(Date.now() - 3600e3).toISOString(),
  approved_via: null, error: null, ...over,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcCalls = (fn) => calls.filter((c) => c.path === "/rest/v1/rpc/" + fn);

/* ============================ pure ============================ */

test("the spine's address pattern takes one bare address and nothing else", () => {
  for (const ok of ["adj@carrier.com", "a.b+claims@sub.carrier.co.uk"]) assert.ok(S.SPINE_TO.test(ok), ok);
  for (const no of ["", "adj@carrier", "adj carrier@x.com", "Bob <adj@carrier.com>", "a@b.com, c@d.com", "a@b@c.com", "adj@carrier.com\n"]) {
    assert.ok(!S.SPINE_TO.test(no), JSON.stringify(no));
  }
});

test("checkAddress trims and says what's wrong in plain words", () => {
  assert.deepEqual(S.checkAddress("  adj@carrier.com "), { ok: true, to: "adj@carrier.com" });
  assert.equal(S.checkAddress("").error, "Type the adjuster's email address.");
  assert.equal(S.checkAddress("a@b.com, c@d.com").error, "One address only: this sends to a single adjuster.");
  assert.equal(S.checkAddress("a@b.com;c").error, "One address only: this sends to a single adjuster.");
  assert.equal(S.checkAddress("Bob <bob@carrier.com>").error, "Just the address, without the name.");
  assert.equal(S.checkAddress("bob@carrier.com>").error, "Just the address, without the name.");
  assert.equal(S.checkAddress("<bob@carrier.com").error, "Just the address, without the name.");
  assert.equal(S.checkAddress("bob at carrier.com").error, "That doesn't look like an email address.");
  assert.equal(S.checkAddress("bob@carrier").error, "That doesn't look like an email address.");
  assert.equal(S.checkAddress("b".repeat(320) + "@x.com").error, "That address is too long.");
});

test("addressIn finds the address inside free text; bareAddress reads a From header", () => {
  assert.equal(S.addressIn("Bob Adams (bob.adams@carrier.com), 907-555-1212"), "bob.adams@carrier.com");
  assert.equal(S.addressIn("write to mailto:bob@carrier.com."), "bob@carrier.com");
  assert.equal(S.addressIn("Bob Adams, State Farm"), "");
  assert.equal(S.addressIn("bob@carrier then bob@carrier.com"), "bob@carrier.com", "skips a token the pattern refuses");
  assert.equal(S.addressIn(undefined), "");
  assert.equal(S.bareAddress("Jane <Jane@Pollen.com>"), "jane@pollen.com");
  assert.equal(S.bareAddress(" JANE@pollen.com "), "jane@pollen.com");
  assert.equal(S.bareAddress(""), "");
});

test("an apostrophe (or any atext character) in the local part keeps the address whole", () => {
  // gmail-proxy stores from_addr bare and keeps the apostrophe
  assert.equal(S.bareAddress("kelly.o'brien@carrier.com"), "kelly.o'brien@carrier.com");
  assert.equal(S.bareAddress(" Kelly.O'Brien@Carrier.com "), "kelly.o'brien@carrier.com");
  assert.equal(S.bareAddress("Kelly O'Brien <kelly.o'brien@carrier.com>"), "kelly.o'brien@carrier.com");
  assert.equal(S.addressIn("Kelly O'Brien (kelly.o'brien@carrier.com), 907-555-1212"), "kelly.o'brien@carrier.com");
  assert.equal(S.addressIn("a{b}c|d/e=f?g^h_i`j~k!#$%&*+-@x.com"), "a{b}c|d/e=f?g^h_i`j~k!#$%&*+-@x.com");
  // only quotes around it go
  assert.equal(S.addressIn("send to 'kelly.o'brien@carrier.com'."), "kelly.o'brien@carrier.com");
  assert.equal(S.addressIn("“jane@x.com”"), "jane@x.com");
  assert.equal(S.bareAddress("'kelly.o'brien@carrier.com'"), "kelly.o'brien@carrier.com");
  // separators still end it
  assert.equal(S.addressIn("O'Brien:kelly@x.com"), "kelly@x.com");
  assert.equal(S.bareAddress("jane@x.com, bob@y.com"), "jane@x.com");
  assert.equal(S.bareAddress("(jane@x.com)"), "jane@x.com");

  const mail = [{ from_addr: "kelly.o'brien@carrier.com", matched_by: "claim", received_at: "2026-10-01T20:00:00Z" }];
  assert.deepEqual(S.prefillTo(project, mail), { to: "kelly.o'brien@carrier.com", source: "claim", at: "2026-10-01T20:00:00Z" }, "from an email row");
  assert.deepEqual(S.prefillTo({ ...project, adjuster: "Kelly O'Brien, kelly.o'brien@carrier.com, 907-555-1212" }, []),
    { to: "kelly.o'brien@carrier.com", source: "adjuster", at: "" }, "from the Adjuster field");
  assert.deepEqual(S.prefillTo({ ...project, adjuster: "kelly.o'brien@carrier.com" }, []),
    { to: "kelly.o'brien@carrier.com", source: "adjuster", at: "" }, "the Adjuster field holding just the address");
  assert.deepEqual(S.prefillTo({ ...project, email: "Kelly.O'Brien@carrier.com" }, mail).source, "adjuster", "still the customer's when it's hers");
  assert.ok(S.checkAddress("kelly.o'brien@carrier.com").ok);
});

test("the To prefill: claim-matched mail first, never the customer's, then the Adjuster field, else blank", () => {
  const mail = [
    { from_addr: "jane@pollen.com", matched_by: "claim", received_at: "2026-10-05T20:00:00Z" },      // the customer, about the claim
    { from_addr: "plumber@pipes.com", matched_by: "customer", received_at: "2026-10-04T20:00:00Z" },
    { from_addr: "adj@carrier.com", matched_by: "claim", received_at: "2026-10-01T20:00:00Z" },
    { from_addr: "old@carrier.com", matched_by: "claim", received_at: "2026-09-01T20:00:00Z" },
  ];
  assert.deepEqual(S.prefillTo(project, mail), { to: "adj@carrier.com", source: "claim", at: "2026-10-01T20:00:00Z" });
  assert.deepEqual(S.prefillTo(project, [...mail].reverse()), S.prefillTo(project, mail), "newest first whatever order the rows came in");
  assert.deepEqual(S.prefillTo(project, mail.slice(0, 2)), { to: "plumber@pipes.com", source: "email", at: "2026-10-04T20:00:00Z" });
  assert.deepEqual(S.prefillTo(project, mail.slice(0, 1)), { to: "bob.adams@carrier.com", source: "adjuster", at: "" });
  assert.deepEqual(S.prefillTo(project, [{ from_addr: "x@y.com", direction: "out", matched_by: "claim" }]).source, "adjuster", "outbound mail never counts");
  assert.deepEqual(S.prefillTo({ ...project, adjuster: "Bob Adams" }, []), { to: "", source: "", at: "" });
  assert.deepEqual(S.prefillTo({ ...project, adjuster: "jane@pollen.com" }, []), { to: "", source: "", at: "" }, "the customer's address typed as the adjuster");
  assert.deepEqual(S.prefillTo(null, null), { to: "", source: "", at: "" });
});

test("checkDraft: a subject and a body, inside email.send@1's limits", () => {
  assert.equal(S.checkDraft("Claim 7", "Hello"), "");
  assert.equal(S.checkDraft("  ", "Hello"), "The subject is empty.");
  assert.equal(S.checkDraft("x".repeat(301), "Hello"), "The subject is too long (300 characters at most).");
  assert.equal(S.checkDraft("Claim 7", " \n "), "The email is empty.");
  assert.equal(S.checkDraft("Claim 7", "x".repeat(100001)), "The email is too long to send this way.");
});

test("the rationale names the claim and the job, on one line", () => {
  assert.equal(S.rationaleFor(project), "Claim documentation email to the adjuster for claim CLM-77 — Jane Pollen");
  assert.equal(S.rationaleFor({ address: "1192 Bemis Ct" }), "Claim documentation email to the adjuster — 1192 Bemis Ct");
  assert.equal(S.rationaleFor({ claimNo: "9\n9", customer: " Jane \n Pollen " }), "Claim documentation email to the adjuster for claim 9 9 — Jane Pollen");
  assert.equal(S.rationaleFor({}), "Claim documentation email to the adjuster");
});

test("the op_propose body, exactly", () => {
  const b = S.proposeBody({ project, to: "adj@carrier.com", subject: " Claim CLM-77 ", body: "Hello\n\nlinks\n", links: { ...LINKS, contents: "javascript:alert(1)" } });
  assert.deepEqual(b, {
    p_operation: "email.send",
    p_input: { to: "adj@carrier.com", subject: "Claim CLM-77", body: "Hello\n\nlinks\n" },
    p_job_id: JOB,
    p_rationale: "Claim documentation email to the adjuster for claim CLM-77 — Jane Pollen",
    p_evidence_refs: [{ label: "Job packet", url: LINKS.packet }, { label: "Job photos", url: LINKS.photos }],
    p_proposed_via: "ui",
    p_expires_in: "72 hours",
  });
  assert.ok(!("p_build" in b));
  assert.deepEqual(S.linkRefs({ contents: "https://portal.roybalconstruction.com/photos/c", packet: "https://p/1" }),
    [{ label: "Job packet", url: "https://p/1" }, { label: "Contents photos", url: "https://portal.roybalconstruction.com/photos/c" }]);
  assert.deepEqual(S.linkRefs(null), []);
});

test("approve and decline bodies: answered in the app is p_via chip", () => {
  assert.deepEqual(S.approveRequest("p1"), { rpc: "op_proposal_approve", body: { p_proposal_id: "p1", p_via: "chip" } });
  assert.deepEqual(S.declineRequest("p1", "  wrong adjuster "), { rpc: "op_proposal_decline", body: { p_proposal_id: "p1", p_reason: "wrong adjuster" } });
  assert.deepEqual(S.declineRequest("p1", ""), { rpc: "op_proposal_decline", body: { p_proposal_id: "p1", p_reason: null } });
});

test("answerOf reads the SQLSTATE, not the status, and takes a one-element array", () => {
  const r = row();
  assert.deepEqual(S.answerOf(200, r), { ok: true, row: r });
  assert.deepEqual(S.answerOf(200, [r]), { ok: true, row: r });
  const why = (s, b) => S.answerOf(s, b).why;
  assert.equal(why(403, { code: "42501", message: "op spine: role crew may not propose email.send@1" }), "forbidden");
  assert.equal(why(500, { code: "P0002", message: "op spine: no live operation email.send@1" }), "retired");
  assert.equal(why(500, { code: "P0002", message: "op spine: no proposal x" }), "gone");
  assert.equal(why(500, { code: "55000", message: "op spine: proposal x expired at 2026-10-06" }), "expired");
  assert.equal(why(500, { code: "55000", message: "op spine: proposal x is expired; only a proposed row can be declined" }), "expired");
  assert.equal(why(500, { code: "55000", message: "op spine: proposal x is declined" }), "answered");
  assert.equal(why(400, { code: "22023", message: "op spine: email.send@1 input is invalid: to: does not match" }), "invalid");
  assert.equal(why(401, { code: "PGRST301", message: "JWT expired" }), "signedout");
  assert.equal(why(401, null), "signedout");
  assert.equal(why(404, { code: "PGRST202", message: "Could not find the function" }), "old");
  assert.equal(why(200, [r, r]), "odd");
  assert.equal(why(200, {}), "odd");
  assert.equal(why(502, undefined), "server");
  assert.equal(S.answerOf(500, { code: "P0001", message: "op spine: expiry must be between now and 30 days" }).message, "expiry must be between now and 30 days");
});

test("every refusal has a sentence, per door", () => {
  const a = (why, message = "") => ({ ok: false, why, status: 500, code: "", message });
  assert.equal(S.refusal("file", a("network")), "Couldn't reach the server, so it may not have been filed. Trying again is safe: the same email is only filed once.");
  assert.equal(S.refusal("file", a("forbidden")), "Your login can't send email for approval. Nothing was filed.");
  assert.equal(S.refusal("file", a("invalid", "email.send@1 input is invalid: to: too long.")), "The server refused this email: email.send@1 input is invalid: to: too long. Nothing was filed.");
  assert.equal(S.refusal("file", a("retired")), "Email sending isn't set up on the server right now. Nothing was filed.");
  assert.equal(S.refusal("file", a("old")), "The server doesn't have email approvals yet. Nothing was filed; copy it or open it in your mail app instead.");
  assert.equal(S.refusal("file", a("server", "boom")), "The server couldn't file it (500: boom). Trying again is safe: the same email is only filed once.");
  assert.equal(S.refusal("file", a("signedout")), S.SIGNED_OUT);
  assert.equal(S.refusal("approve", a("network")), "Couldn't reach the server. Trying again is safe: it sends once, however many times it's approved.");
  assert.equal(S.refusal("approve", a("expired")), "That one expired — nothing was sent.");
  assert.equal(S.refusal("approve", a("answered", "proposal x is declined")), "That one was declined — nothing was sent.");
  assert.equal(S.refusal("approve", a("answered", "proposal x is weird")), "That one was already answered. Check the Approvals tab.");
  assert.equal(S.refusal("approve", a("retired")), "This kind of ask was retired before you answered it. Decline it; nothing was sent.");
  assert.equal(S.refusal("approve", a("forbidden")), "Your login isn't allowed to answer this one.");
  assert.equal(S.refusal("approve", a("gone")), "This ask no longer exists. Nothing was sent.");
  assert.equal(S.refusal("decline", a("answered", "proposal x is executed; only a proposed row can be declined")), "That one was already approved. It goes out once.");
  assert.equal(S.refusal("decline", a("answered", "proposal x is failed; only a proposed row can be declined")), "That one was approved, but it didn't run. Nothing was cancelled.");
  assert.equal(S.refusal("decline", a("answered", "")), "That one was already answered — nothing was cancelled.");
  assert.equal(S.refusal("decline", a("network")), "Couldn't reach the server. Try again.");
  assert.equal(S.refusal("decline", a("old")), "The server doesn't have the approvals update yet. Nothing changed.");
});

test("matchOpen: the same email waiting is shown, a different one to that address is asked about", () => {
  const now = Date.now();
  const same = row();
  const other = row({ id: "p2", input: { to: "ADJ@carrier.com", subject: "Older draft", body: "Hi" } });
  const elsewhere = row({ id: "p3", input: { to: "someone@else.com", subject: "Claim CLM-77", body: "Hello" } });
  const stale = row({ id: "p4", expires_at: iso(-1) });
  const edited = row({ id: "p5", input: { to: "first@carrier.com", subject: "Claim CLM-77", body: "Hello" }, edited_params: { to: "adj@carrier.com" } });
  assert.deepEqual(S.matchOpen([other, same], "adj@carrier.com", "Claim CLM-77", "Hello", now), { same, other });
  assert.deepEqual(S.matchOpen([elsewhere, stale], "adj@carrier.com", "Claim CLM-77", "Hello", now), { same: null, other: null });
  assert.equal(S.matchOpen([edited], "adj@carrier.com", "Claim CLM-77", "Hello", now).same, edited, "what would run is what counts");
  assert.deepEqual(S.matchOpen(null, "a@b.co", "s", "b", now), { same: null, other: null });
});

test("rowState and the lines the section shows", () => {
  const now = Date.now();
  assert.equal(S.rowState(row(), now), "waiting");
  assert.equal(S.rowState(row({ expires_at: iso(-1) }), now), "expired");
  for (const s of ["approved", "executing", "executed"]) assert.equal(S.rowState(row({ status: s }), now), "approved");
  assert.equal(S.rowState(row({ status: "superseded" }), now), "declined");
  assert.equal(S.rowState(row({ status: "failed" }), now), "failed");
  assert.equal(S.rowState({}, now), "other");

  assert.equal(S.waitingLine(row()), "⏳ Waiting for approval — the email to adj@carrier.com.");
  assert.equal(S.doorsLine(row()), "or approve it from the Approvals tab, or text YES 4");
  assert.equal(S.doorsLine(row({ sms_code: null })), "or approve it from the Approvals tab");
  assert.equal(S.doorsLine(row({ status: "executed" })), "or approve it from the Approvals tab", "a decided row's code is someone else's now");

  const done = row({ status: "executed", approved_via: "chip" });
  assert.equal(S.approvedLine(done, true), "✅ Approved — the email to adj@carrier.com is queued and goes out in a minute.");
  assert.equal(S.approvedLine(done, false), "✅ Approved — the email to adj@carrier.com. It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.");
  assert.equal(S.approvedLine(done, null), "✅ Approved — the email to adj@carrier.com is queued to send.");
  assert.equal(S.approvedLine({ ...done, approved_via: "sms" }, true), "That one was already approved by text. It goes out once.");
  assert.equal(S.approvedLine({ ...done, approved_via: "inbox" }, true), "That one was already approved in the Approvals tab. It goes out once.");
  assert.equal(S.approvedLine(row({ status: "failed", error: "Gmail refused" }), true), "⚠️ Approved, but it didn't run: Gmail refused");

  assert.equal(S.filedNote(row({ status: "executed" })), "This exact email was already approved. It goes out once.");
  assert.equal(S.filedNote(row({ status: "declined" })), "This exact email was declined earlier today, so it wasn't filed again. Change it to ask again.");
  assert.equal(S.filedNote(row({ status: "expired" })), "This exact email expired unanswered, so it wasn't filed again. Change it to ask again.");

  assert.equal(S.sourceLine({ source: "claim", at: "2026-10-01T20:00:00Z" }), "From the newest email about this claim (Oct 1). Check it's the adjuster's.");
  assert.equal(S.sourceLine({ source: "email", at: "" }), "From the newest email filed to this job that isn't the customer's. Check it's the adjuster's.");
  assert.equal(S.sourceLine({ source: "adjuster" }), "From the job's Adjuster field.");
  assert.equal(S.sourceLine(null), "No adjuster address on file yet. Type it in.");
  assert.equal(S.approveConfirm("adj@carrier.com"), "Send this email to adj@carrier.com?");
  assert.equal(S.declinePrompt("adj@carrier.com"), "Decline the email to adj@carrier.com?\n\nA reason, if you want to give one (optional):");
  assert.equal(S.dupConfirm({ created_at: "2026-10-05T23:12:00Z" }, "adj@carrier.com"),
    "Another email to adj@carrier.com is already waiting for approval on this job (asked Oct 5, 3:12 PM). Approving both would send both.\n\nSend this one for approval too?");
  assert.equal(S.dupConfirm({}, "adj@carrier.com").split("\n")[0], "Another email to adj@carrier.com is already waiting for approval on this job. Approving both would send both.");
});

test("outboxState reads an approved email's outbox rows the way the YES reply does", () => {
  for (const st of ["sent", "delivered"]) assert.deepEqual(S.outboxState([{ status: st, error: null }]), { state: "sent" }, st);
  assert.deepEqual(S.outboxState([{ status: "dead", error: "  Gmail refused kelly@carrier.com: 550 no such user. " }]),
    { state: "dead", error: "Gmail refused kelly@carrier.com: 550 no such user" }, "trimmed, closing period dropped");
  assert.deepEqual(S.outboxState([{ status: "dead", error: null }]), { state: "dead", error: "it gave up" });
  assert.deepEqual(S.outboxState([{ status: "dead", error: "  ..  " }]), { state: "dead", error: "it gave up" });
  const long = S.outboxState([{ status: "dead", error: "é".repeat(200) }]);
  assert.equal(Array.from(long.error).length, 160, "160 characters, not 160 bytes");
  assert.deepEqual(S.outboxState([{ status: "dead" }, { status: "sent" }]), { state: "sent" }, "one that went out wins");
  for (const st of ["pending", "sending", "failed", "", undefined]) assert.deepEqual(S.outboxState([{ status: st }]), { state: "waiting" }, String(st));
  for (const bad of [[], null, undefined, {}, "nope", [null]]) assert.deepEqual(S.outboxState(bad), { state: "waiting" }, "no row, or a read that failed: " + JSON.stringify(bad));
});

test("approvedLine for one approved at another door: from its outbox row, then the lane", () => {
  const SENT = { state: "sent" }, WAITS = { state: "waiting" };
  const DEAD = { state: "dead", error: "Gmail refused kelly@carrier.com: 550 no such user" };
  const OFF = "It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.";
  const DEAD_LINE = "That one was approved, but the email couldn't be sent: Gmail refused kelly@carrier.com: 550 no such user. Nothing went out.";
  for (const [via, by] of [["sms", "by text"], ["inbox", "in the Approvals tab"]]) {
    const r = row({ status: "executed", approved_via: via });
    assert.equal(S.approvedLine(r, true, SENT), `That one was already approved ${by}. It went out once.`);
    assert.equal(S.approvedLine(r, false, SENT), `That one was already approved ${by}. It went out once.`, "it went, whatever the lane says now");
    assert.equal(S.approvedLine(r, true, DEAD), DEAD_LINE);
    assert.equal(S.approvedLine(r, false, DEAD), DEAD_LINE);
    assert.equal(S.approvedLine(r, false, WAITS), `That one was already approved ${by}. ${OFF}`);
    assert.equal(S.approvedLine(r, true, WAITS), `That one was already approved ${by}. It goes out once.`);
    assert.equal(S.approvedLine(r, null, WAITS), `That one was already approved ${by}. It goes out once.`);
    // the outbox read failed (outboxOf hands back "waiting"), or wasn't passed: the lane decides, never "went out"
    assert.equal(S.approvedLine(r, false, S.outboxState(null)), `That one was already approved ${by}. ${OFF}`);
    assert.equal(S.approvedLine(r, true), `That one was already approved ${by}. It goes out once.`);
    assert.equal(S.approvedLine(r, false), `That one was already approved ${by}. ${OFF}`);
  }
  assert.equal(S.approvedLine(row({ status: "executed", approved_via: "sms" }), true, { state: "dead", error: "" }),
    "That one was approved, but the email couldn't be sent: it gave up. Nothing went out.");
  // approved by this panel's chip, but its outbox row already went or died: approved before this tap (another phone)
  const chip = row({ status: "executed", approved_via: "chip" });
  assert.equal(S.approvedLine(chip, true, SENT), "✅ Approved — the email to adj@carrier.com. It went out once.");
  assert.equal(S.approvedLine(chip, false, DEAD), DEAD_LINE);
  assert.equal(S.approvedLine(chip, true, WAITS), "✅ Approved — the email to adj@carrier.com is queued and goes out in a minute.");
  assert.equal(S.approvedLine(chip, false, WAITS), `✅ Approved — the email to adj@carrier.com. ${OFF}`);
  assert.equal(S.approvedLine(row({ status: "failed", error: "boom" }), true, SENT), "⚠️ Approved, but it didn't run: boom");

  // the same words where a decline or a refiling finds it approved first
  const a = { ok: false, why: "answered", status: 500, code: "55000", message: "proposal x is executed; only a proposed row can be declined" };
  assert.equal(S.refusal("decline", a, { outbox: SENT, lane: true }), "That one was already approved. It went out once.");
  assert.equal(S.refusal("decline", a, { outbox: DEAD, lane: true }), DEAD_LINE);
  assert.equal(S.refusal("decline", a, { outbox: WAITS, lane: false }), `That one was already approved. ${OFF}`);
  assert.equal(S.refusal("decline", { ...a, message: "proposal x is approved" }, { outbox: WAITS, lane: true }), "That one was already approved. It goes out once.");
  const filed = row({ status: "executed", approved_via: "inbox" });
  assert.equal(S.filedNote(filed, Date.now(), { outbox: SENT, lane: true }), "This exact email was already approved. It went out once.");
  assert.equal(S.filedNote(filed, Date.now(), { outbox: WAITS, lane: false }), `This exact email was already approved. ${OFF}`);
  assert.equal(S.filedNote(filed, Date.now(), { outbox: WAITS, lane: true }), "This exact email was already approved. It goes out once.");
  assert.equal(S.filedNote(filed, Date.now(), { outbox: DEAD, lane: true }),
    "This exact email was approved earlier, but it couldn't be sent: Gmail refused kelly@carrier.com: 550 no such user. Nothing went out. Change it to ask again.");
});

/* ======================= who is offered it ======================= */

test("a crew login gets nothing: one role check, no lane check, no reads", async () => {
  resetNet(); await login("crew@x.com");
  net.role = () => [200, false];
  assert.equal(await S.sendSetup(project), null);
  assert.deepEqual(calls.map((c) => c.path), ["/rest/v1/rpc/role_is"]);
  assert.deepEqual(calls[0].body, { p_roles: ["owner"] });
  calls.length = 0;
  assert.equal(await S.sendSetup(project), null);
  assert.deepEqual(calls, [], "a no is kept for this login");
});

test("a role check that fails offers nothing and isn't kept", async () => {
  resetNet(); await login("owner1@x.com");
  for (const fail of [() => [500, { message: "boom" }], () => [200, "yes"], () => [401, { code: "PGRST301" }], () => new TypeError("Failed to fetch")]) {
    net.role = fail;
    assert.equal(await S.sendSetup(project), null);
  }
  assert.equal(rpcCalls("role_is").length, 5, "asked every time (the 401 once more, after its token refresh)");
  assert.equal(rpcCalls("outbox_channel_ready").length, 0);
  net.role = () => [200, true];
  assert.ok(await S.sendSetup(project), "the next good answer counts");
});

test("the owner while the email lane isn't live gets nothing", async () => {
  resetNet(); await login("owner2@x.com");
  for (const lane of [() => [200, false], () => [404, { code: "PGRST202" }], () => [500, {}], () => [200, "true"], () => [200, null], () => new TypeError("Failed to fetch")]) {
    net.lane = lane;
    assert.equal(await S.sendSetup(project), null);
  }
  assert.deepEqual(rpcCalls("outbox_channel_ready").map((c) => c.body), Array(6).fill({ p_channel: "email" }));
  assert.equal(rpcCalls("role_is").length, 1, "the owner's yes is kept");
  assert.equal(calls.filter((c) => c.path === "/rest/v1/email_messages").length, 0);
});

test("the owner, lane live: offered, with the To from this job's inbound mail", async () => {
  resetNet(); await login("owner3@x.com");
  net.emails = () => [200, [{ from_addr: "adj@carrier.com", matched_by: "claim", received_at: "2026-10-01T20:00:00Z" }]];
  assert.deepEqual(await S.sendSetup(project), { to: "adj@carrier.com", source: "claim", at: "2026-10-01T20:00:00Z" });
  const read = calls.find((c) => c.path === "/rest/v1/email_messages");
  assert.equal(read.query, `?job_id=eq.${JOB}&direction=eq.in&order=received_at.desc&limit=20&select=from_addr,matched_by,received_at`);
  net.emails = () => [500, {}];
  assert.deepEqual(await S.sendSetup(project), { to: "bob.adams@carrier.com", source: "adjuster", at: "" }, "a failed mail read still offers it");
  for (const c of calls) assert.ok(!c.body || !("p_build" in c.body), "rest(), never supa.js's rpc()");
});

test("no job uuid, or signed out: nothing, and nothing asked", async () => {
  resetNet(); await login("owner4@x.com");
  assert.equal(await S.sendSetup({ ...project, id: "id-1700000000000-abc" }), null);
  assert.equal(await S.sendSetup(null), null);
  assert.deepEqual(calls, []);
});

/* ======================== the section ======================== */

function mount(setup = { to: "adj@carrier.com", source: "claim", at: "2026-10-01T20:00:00Z" }) {
  const subj = document.createElement("input");
  subj.value = "Claim CLM-77 — 1192 Bemis Ct";
  const bodyTa = document.createElement("textarea");
  bodyTa.value = "Hello Bob,\n\nClaim documentation online:\n• Full job packet (view & print): " + LINKS.packet + "\n";
  const el = S.sendSection({ project, subj, bodyTa, setup, links: LINKS });
  document.body.append(el);
  const to = el.querySelector("input");
  const btn = (text) => [...el.querySelectorAll("button")].find((b) => b.textContent === text && b.isConnected);
  const note = () => el.children[3];
  const err = () => el.querySelector("[role=alert]");
  return { el, subj, bodyTa, to, btn, note, err };
}
const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await sleep(5); assert.ok(cond(), "timed out"); };
/* a pressed button reads "Working…" while its request is out, so wait on the line, not the button */
const answered = (s) => until(() => !s.note().textContent.startsWith("⏳"));

test("the section: To prefilled with where it came from, and Send for approval", async () => {
  resetNet(); await login("owner5@x.com");
  const s = mount();
  assert.equal(s.to.value, "adj@carrier.com");
  assert.match(s.el.textContent, /Or send it from the office email once you approve it:/);
  assert.match(s.el.textContent, /From the newest email about this claim \(Oct 1\)\. Check it's the adjuster's\./);
  assert.ok(s.btn("Send for approval"));
  assert.ok(!s.btn("Approve and send"));
  assert.equal(s.err().hidden, true);
  assert.deepEqual(calls, [], "mounting asks nothing");
  s.el.remove();
});

test("no packet link, no Send for approval: just why, and nothing asked", async () => {
  resetNet(); await login("owner5b@x.com");
  for (const links of [{ photos: LINKS.photos }, {}, null, { packet: "javascript:alert(1)", photos: LINKS.photos }]) {
    const subj = document.createElement("input");
    const bodyTa = document.createElement("textarea");
    subj.value = "Claim CLM-77"; bodyTa.value = "Hello Bob,\n\nClaim documentation online:\n• All job photos, full resolution: " + LINKS.photos + "\n";
    const el = S.sendSection({ project, subj, bodyTa, setup: { to: "adj@carrier.com", source: "claim" }, links });
    document.body.append(el);
    assert.equal(el.textContent, S.NO_PACKET, JSON.stringify(links));
    assert.match(S.NO_PACKET, /^The packet link didn't publish, so this email can't go for approval/);
    assert.match(S.NO_PACKET, /draft it again .*or use Copy\.$/);
    assert.equal(el.querySelectorAll("button, input").length, 0, "no To field, no file button");
    assert.deepEqual([subj.readOnly, bodyTa.readOnly], [false, false]);
    el.remove();
  }
  await sleep(10);
  assert.deepEqual(calls, []);
});

test("a bad address or an empty draft files nothing", async () => {
  resetNet(); await login("owner6@x.com");
  const s = mount({ to: "", source: "" });
  s.btn("Send for approval").click();
  assert.equal(s.err().textContent, "Type the adjuster's email address.");
  s.to.value = "Bob <bob@carrier.com>";
  s.btn("Send for approval").click();
  assert.equal(s.err().textContent, "Just the address, without the name.");
  s.to.value = "bob@carrier.com"; s.subj.value = " ";
  s.btn("Send for approval").click();
  assert.equal(s.err().textContent, "The subject is empty.");
  await sleep(10);
  assert.deepEqual(calls, []);
  assert.equal(s.subj.readOnly, false);
  s.el.remove();
});

test("Send for approval files the email as edited, then waits with Approve / Decline and the YES number", async () => {
  resetNet(); await login("owner7@x.com"); asked.length = 0;
  let filed = null;
  net.propose = (b) => { filed = b; return [200, row({ input: b.p_input, sms_code: 12 })]; };
  const s = mount();
  s.to.value = " adj@carrier.com ";
  s.bodyTa.value += "\nThanks, Branden";        // his edit rides along
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  const read = calls.find((c) => c.path === "/rest/v1/proposals");
  assert.match(read.query, new RegExp(`^\\?operation=like\\.email\\.send@\\*&job_id=eq\\.${JOB}&status=eq\\.proposed&expires_at=gt\\.`));
  assert.deepEqual(filed, S.proposeBody({ project, to: "adj@carrier.com", subject: s.subj.value, body: s.bodyTa.value, links: LINKS }));
  assert.ok(filed.p_input.body.endsWith("\nThanks, Branden"));
  assert.equal(s.note().textContent, "⏳ Waiting for approval — the email to adj@carrier.com.");
  assert.match(s.el.textContent, /or approve it from the Approvals tab, or text YES 12/);
  assert.ok(s.btn("Decline"));
  assert.ok(!s.btn("Send for approval"));
  assert.deepEqual([s.to.readOnly, s.subj.readOnly, s.bodyTa.readOnly], [true, true, true], "what waits is what's on screen");
  assert.deepEqual(asked, [], "nothing else was waiting, so nothing was asked");
  s.el.remove();
});

test("Approve sends op_proposal_approve with p_via chip once he confirms, and says it's queued", async () => {
  resetNet(); await login("owner8@x.com"); asked.length = 0;
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.approve = (b) => [200, row({ id: b.p_proposal_id, status: "executed", approved_via: "chip", input: { to: "adj@carrier.com", subject: "s", body: "b" } })];
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  answerConfirm = false;
  s.btn("Approve and send").click();
  await sleep(10);
  assert.deepEqual(asked, ["Send this email to adj@carrier.com?"]);
  assert.equal(rpcCalls("op_proposal_approve").length, 0, "a No sends nothing");
  answerConfirm = true;
  s.btn("Approve and send").click();
  await answered(s);
  assert.deepEqual(rpcCalls("op_proposal_approve").map((c) => c.body), [{ p_proposal_id: row().id, p_via: "chip" }]);
  assert.equal(s.note().textContent, "✅ Approved — the email to adj@carrier.com is queued and goes out in a minute.");
  assert.equal(rpcCalls("outbox_channel_ready").length, 1, "the lane is read again for the wording");
  assert.deepEqual(calls.filter((c) => c.path === "/rest/v1/outbox").map((c) => c.query),
    [`?proposal_id=eq.${row().id}&select=status,error&order=created_at.desc&limit=1`], "and its outbox row, beside it");
  assert.ok(!s.btn("Decline") && !s.btn("Send for approval"));
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();
});

test("Approve on one he already approved by text says so; the lane off says it waits", async () => {
  resetNet(); await login("owner9@x.com");
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.approve = () => [200, row({ status: "executed", approved_via: "sms" })];
  let s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  s.btn("Approve and send").click();
  await answered(s);
  assert.equal(s.note().textContent, "That one was already approved by text. It goes out once.");
  s.el.remove();

  net.approve = () => [200, row({ status: "executed", approved_via: "chip" })];
  net.lane = () => [200, false];
  s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  s.btn("Approve and send").click();
  await answered(s);
  assert.equal(s.note().textContent, "✅ Approved — the email to adj@carrier.com. It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.");
  s.el.remove();
});

test("Approve refused as expired, or failed on the server: the draft opens up again with why", async () => {
  resetNet(); await login("owner10@x.com");
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.approve = () => [500, { code: "55000", message: "op spine: proposal x expired at 2026-10-06 18:00:00+00" }];
  let s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  s.btn("Approve and send").click();
  await until(() => s.btn("Send for approval"));
  assert.equal(s.note().textContent, "That one expired — nothing was sent.");
  assert.equal(s.bodyTa.readOnly, false);
  s.el.remove();

  net.approve = () => [503, undefined];
  s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  s.btn("Approve and send").click();
  await until(() => !s.err().hidden);
  assert.equal(s.err().textContent, "The server couldn't run that (503). Nothing changed.");
  assert.ok(s.btn("Approve and send") && !s.btn("Approve and send").disabled, "still waiting: he can try again");
  assert.equal(s.btn("Approve and send").textContent, "Approve and send");
  s.el.remove();
});

test("Decline sends the reason, unlocks the draft, and a No to the prompt sends nothing", async () => {
  resetNet(); await login("owner11@x.com"); asked.length = 0;
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.decline = (b) => [200, row({ id: b.p_proposal_id, status: "declined", decline_reason: b.p_reason })];
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Decline"));
  answerPrompt = null;
  s.btn("Decline").click();
  await sleep(10);
  assert.equal(rpcCalls("op_proposal_decline").length, 0);
  answerPrompt = "wrong adjuster";
  s.btn("Decline").click();
  await until(() => s.btn("Send for approval"));
  assert.deepEqual(asked, Array(2).fill("Decline the email to adj@carrier.com?\n\nA reason, if you want to give one (optional):"));
  assert.deepEqual(rpcCalls("op_proposal_decline").map((c) => c.body), [{ p_proposal_id: row().id, p_reason: "wrong adjuster" }]);
  assert.equal(s.note().textContent, S.DECLINED);
  assert.deepEqual([s.to.readOnly, s.subj.readOnly, s.bodyTa.readOnly], [false, false, false]);
  s.el.remove();
});

test("Decline on one approved elsewhere first: it says so and stays shut", async () => {
  resetNet(); await login("owner12@x.com");
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.decline = () => [500, { code: "55000", message: "op spine: proposal x is executed; only a proposed row can be declined" }];
  answerPrompt = "";
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Decline"));
  s.btn("Decline").click();
  await answered(s);
  assert.equal(s.note().textContent, "That one was already approved. It goes out once.");
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();
});

/* approved at another door before his tap: the panel reads that email's outbox row */
async function approveAnswered(over, { outbox, lane = () => [200, true] } = {}) {
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.approve = () => [200, row({ status: "executed", ...over })];
  net.outbox = outbox; net.lane = lane;
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  s.btn("Approve and send").click();
  await answered(s);
  return s;
}
const outboxReads = () => calls.filter((c) => c.path === "/rest/v1/outbox");

test("Approve on one approved in the inbox whose email died: says nothing went out, and the draft opens up", async () => {
  resetNet(); await login("owner12b@x.com");
  const s = await approveAnswered({ approved_via: "inbox" }, {
    outbox: () => [200, [{ status: "dead", error: "Gmail refused kelly@carrier.com: 550 5.1.1 no such user." }]],
  });
  assert.equal(s.note().textContent, "That one was approved, but the email couldn't be sent: Gmail refused kelly@carrier.com: 550 5.1.1 no such user. Nothing went out.");
  assert.deepEqual(outboxReads().map((c) => c.query), [`?proposal_id=eq.${row().id}&select=status,error&order=created_at.desc&limit=1`]);
  assert.ok(s.btn("Send for approval") && !s.btn("Approve and send"), "he can fix the address and ask again");
  assert.deepEqual([s.to.readOnly, s.subj.readOnly, s.bodyTa.readOnly], [false, false, false]);
  s.el.remove();
});

test("Approve on one approved by text that went out: it went out once, and stays shut", async () => {
  resetNet(); await login("owner12c@x.com");
  const s = await approveAnswered({ approved_via: "sms" }, { outbox: () => [200, [{ status: "delivered", error: null }]], lane: () => [200, false] });
  assert.equal(s.note().textContent, "That one was already approved by text. It went out once.");
  assert.ok(!s.btn("Send for approval") && !s.btn("Approve and send"));
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();
});

test("Approve on one approved by text, still queued with the lane off: the 48-hour line", async () => {
  resetNet(); await login("owner12d@x.com");
  const s = await approveAnswered({ approved_via: "sms" }, { outbox: () => [200, [{ status: "pending", error: null }]], lane: () => [200, false] });
  assert.equal(s.note().textContent, "That one was already approved by text. It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.");
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();
});

test("the outbox read failing never says it went out: the lane decides the words", async () => {
  for (const [i, outbox] of [() => [500, { message: "boom" }], () => [200, "nope"], () => new TypeError("Failed to fetch")].entries()) {
    resetNet(); await login(`owner12e${i}@x.com`);
    let s = await approveAnswered({ approved_via: "inbox" }, { outbox, lane: () => [200, false] });
    assert.equal(s.note().textContent, "That one was already approved in the Approvals tab. It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.");
    s.el.remove();
    s = await approveAnswered({ approved_via: "inbox" }, { outbox, lane: () => [200, true] });
    assert.equal(s.note().textContent, "That one was already approved in the Approvals tab. It goes out once.");
    s.el.remove();
  }
});

test("Decline on one approved elsewhere whose email died: says nothing went out", async () => {
  resetNet(); await login("owner12f@x.com");
  net.propose = (b) => [200, row({ input: b.p_input })];
  net.decline = () => [500, { code: "55000", message: "op spine: proposal x is executed; only a proposed row can be declined" }];
  net.outbox = () => [200, [{ status: "dead", error: "" }]];
  answerPrompt = "";
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Decline"));
  s.btn("Decline").click();
  await answered(s);
  assert.equal(s.note().textContent, "That one was approved, but the email couldn't be sent: it gave up. Nothing went out.");
  assert.equal(outboxReads().length, 1);
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();
});

test("op_propose handing back the same email already approved: its outbox row says how it stands", async () => {
  resetNet(); await login("owner12g@x.com");
  net.propose = (b) => [200, row({ input: b.p_input, status: "executed", approved_via: "inbox" })];
  net.outbox = () => [200, [{ status: "sent", error: null }]];
  let s = mount();
  s.btn("Send for approval").click();
  await until(() => !s.note().hidden);
  assert.equal(s.note().textContent, "This exact email was already approved. It went out once.");
  assert.ok(!s.btn("Send for approval"));
  assert.equal(s.bodyTa.readOnly, true);
  s.el.remove();

  net.outbox = () => [200, [{ status: "dead", error: "Too many tries" }]];
  s = mount();
  s.btn("Send for approval").click();
  await until(() => !s.note().hidden);
  assert.equal(s.note().textContent, "This exact email was approved earlier, but it couldn't be sent: Too many tries. Nothing went out. Change it to ask again.");
  assert.ok(s.btn("Send for approval"));
  assert.equal(s.bodyTa.readOnly, false, "he can change it and ask again");
  s.el.remove();
});

test("the same email already waiting isn't filed again: the section shows that one", async () => {
  resetNet(); await login("owner13@x.com");
  const s = mount();
  const waitingRow = row({ id: "p-old", sms_code: 7, input: { to: "adj@carrier.com", subject: s.subj.value, body: s.bodyTa.value } });
  net.open = () => [200, [waitingRow]];
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  assert.equal(rpcCalls("op_propose").length, 0);
  assert.match(s.el.textContent, /or text YES 7/);
  s.el.remove();
});

test("a different email to the same address waiting: he's asked first, and a No files nothing", async () => {
  resetNet(); await login("owner14@x.com"); asked.length = 0;
  net.open = () => [200, [row({ id: "p-other", input: { to: "adj@carrier.com", subject: "Older draft", body: "Hi" }, created_at: "2026-10-05T23:12:00Z" })]];
  net.propose = (b) => [200, row({ id: "p-new", input: b.p_input })];
  const s = mount();
  answerConfirm = false;
  s.btn("Send for approval").click();
  await until(() => asked.length === 1 && !s.btn("Send for approval").disabled);
  assert.equal(asked[0], S.dupConfirm({ created_at: "2026-10-05T23:12:00Z" }, "adj@carrier.com"));
  assert.equal(rpcCalls("op_propose").length, 0);
  assert.equal(s.bodyTa.readOnly, false);
  answerConfirm = true;
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  assert.equal(rpcCalls("op_propose").length, 1);
  s.el.remove();
});

test("the open-asks read failing: he's asked before it files", async () => {
  resetNet(); await login("owner15@x.com"); asked.length = 0;
  net.open = () => [500, {}];
  net.propose = (b) => [200, row({ input: b.p_input })];
  answerConfirm = true;
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => s.btn("Approve and send"));
  assert.deepEqual(asked, [S.uncheckedConfirm("adj@carrier.com")]);
  s.el.remove();
});

test("a refused filing leaves the draft editable and says why", async () => {
  resetNet(); await login("owner16@x.com");
  net.propose = () => [403, { code: "42501", message: "op spine: role crew may not propose email.send@1" }];
  let s = mount();
  s.btn("Send for approval").click();
  await until(() => !s.err().hidden);
  assert.equal(s.err().textContent, "Your login can't send email for approval. Nothing was filed.");
  assert.ok(s.btn("Send for approval") && !s.btn("Send for approval").disabled);
  assert.equal(s.btn("Send for approval").textContent, "Send for approval");
  assert.equal(s.subj.readOnly, false);
  s.el.remove();

  net.propose = () => new TypeError("Failed to fetch");
  s = mount();
  s.btn("Send for approval").click();
  await until(() => !s.err().hidden);
  assert.equal(s.err().textContent, "Couldn't reach the server, so it may not have been filed. Trying again is safe: the same email is only filed once.");
  s.el.remove();
});

test("op_propose handing back the same email already declined today: a note, and the draft opens up", async () => {
  resetNet(); await login("owner17@x.com");
  net.propose = (b) => [200, row({ input: b.p_input, status: "declined" })];
  const s = mount();
  s.btn("Send for approval").click();
  await until(() => !s.note().hidden);
  assert.equal(s.note().textContent, "This exact email was declined earlier today, so it wasn't filed again. Change it to ask again.");
  assert.ok(s.btn("Send for approval"));
  assert.equal(s.bodyTa.readOnly, false);
  s.el.remove();
});

test("a double tap files once", async () => {
  resetNet(); await login("owner18@x.com");
  net.propose = async (b) => { await sleep(20); return [200, row({ input: b.p_input })]; };
  const s = mount();
  const b = s.btn("Send for approval");
  b.click(); b.click(); b.dispatchEvent(new window.Event("click"));
  await until(() => s.btn("Approve and send"));
  assert.equal(rpcCalls("op_propose").length, 1);
  s.el.remove();
});

/* ================== the draft says where the links are ================== */

test("the narrative page asks for a draft with linked:true; without it the flag isn't sent", async () => {
  resetNet(); await login("owner19@x.com");
  const { draftAdjusterEmail } = await import("../js/officeai.js");
  assert.deepEqual(await draftAdjusterEmail(project, { linked: true }), { subject: "Claim CLM-77", body: "Hello" });
  assert.deepEqual(await draftAdjusterEmail(project), { subject: "Claim CLM-77", body: "Hello" });
  const sent = calls.filter((c) => c.path === "/functions/v1/roybal-ai-office").map((c) => c.body);
  assert.deepEqual(sent.map((b) => [b.action, b.linked]), [["adjusterEmail", true], ["adjusterEmail", undefined]]);
  assert.ok(!("linked" in sent[1]), "an unlinked caller sends no flag at all");
  // app.js appends the packet/photo links under the draft, so it's the linked caller
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.deepEqual(app.match(/draftAdjusterEmail\([^)]*\)/g), ["draftAdjusterEmail(project, { linked: true })"]);
});
