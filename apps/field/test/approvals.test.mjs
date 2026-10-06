/* approvals.js — the office Approvals tab's pure logic (operations spine,
   step 4): both queues' rows as one card shape, waiting / recently decided /
   expired and their order, the names a page must look up, outcome lines,
   Alaska times, what each button sends, and the sentence for every answer
   roybal-notify decidePending and the spine RPCs can give.
   Run: node --test test/approvals.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fromPending, fromProposal, inbox, needs, lookFrom, outcome, isLive, isExpired, isRecent,
  akTime, expiresIn, expiredLine, firstSentence, jobName, agentName, stageLabel,
  approveConfirm, declineConfirm, declinePrompt, decisionRequest, pendingAnswer, spineAnswer,
  decidedText, settle, NO_CONNECTION, SIGNED_OUT,
} from "../js/approvals.js";

// 10:00 AM Alaska (AKDT, UTC-8) on Tue Oct 6 2026
const NOW = Date.parse("2026-10-06T18:00:00.000Z");
const iso = (h) => new Date(NOW + h * 3600e3).toISOString();      // hours from now
const FIELD1 = "11111111-1111-4111-8111-111111111111";
const BOARD1 = "22222222-2222-4222-8222-222222222222";
const BOARD2 = "33333333-3333-4333-8333-333333333333";
const AGENT = "1af33481-7f1c-4485-87f5-7b0ec5e27554";
const PERSON = "44444444-4444-4444-8444-444444444444";

const reminder = {
  id: "aaaaaaaa-0000-4000-8000-000000000001", code: 12, kind: "emailSend", proposed_by: "morning-brief",
  label: "email the INV-1001 reminder to Pollen", job_id: FIELD1, status: "pending",
  params: { to: "pollen@example.com", subject: "Invoice INV-1001 is past due", body: "Hi Jane,\n\nA reminder that INV-1001 ($1,240.00) was due Sep 30.", jobId: FIELD1, invoiceKey: FIELD1 + ":INV-1001" },
  created_at: iso(-3), expires_at: iso(21), executed_at: null, result: null,
};
const phase = {
  id: "aaaaaaaa-0000-4000-8000-000000000002", code: 13, kind: "boardEdit", proposed_by: "qb-time",
  label: 'add phase "Demo" to Smith remodel (12h logged)', job_id: BOARD1, status: "pending",
  params: { op: "addPhase", rowId: BOARD1, phase: { id: "p1", name: "Demo", estimatedHours: 12, crewIds: [] }, entryIds: ["e1"] },
  created_at: iso(-13), expires_at: iso(11), executed_at: null, result: null,
};
const text = {
  id: "aaaaaaaa-0000-4000-8000-000000000003", code: 14, kind: "sendText", proposed_by: "sms-assist",
  label: "text Jane that the crew is running 10 minutes late", job_id: null, status: "pending",
  params: { to: "+19075551234", message: "Hi Jane, the crew is running about 10 minutes late.", audience: "customer" },
  created_at: iso(-1), expires_at: iso(0.66), executed_at: null, result: null,
};
const sent = { ...reminder, id: "aaaaaaaa-0000-4000-8000-000000000004", code: 11, status: "executed",
  created_at: iso(-27), expires_at: iso(-3), executed_at: iso(-25.5) };
const failedPhase = { ...phase, id: "aaaaaaaa-0000-4000-8000-000000000005", status: "failed",
  created_at: iso(-12), expires_at: iso(12), result: { error: "the board job changed while this was pending — nothing was added" } };
const oldDecline = { ...reminder, id: "aaaaaaaa-0000-4000-8000-000000000006", status: "declined", created_at: iso(-75), expires_at: iso(-51) };
const lapsed = { ...phase, id: "aaaaaaaa-0000-4000-8000-000000000007", status: "pending", created_at: iso(-30), expires_at: iso(-6) };
const swept = { ...phase, id: "aaaaaaaa-0000-4000-8000-000000000008", status: "expired", created_at: iso(-130), expires_at: iso(-106) };
const ancient = { ...phase, id: "aaaaaaaa-0000-4000-8000-000000000009", status: "pending", created_at: iso(-400), expires_at: iso(-376) };
const skipped = { ...phase, id: "aaaaaaaa-0000-4000-8000-00000000000a", status: "executed", executed_at: iso(-2),
  result: { rowId: BOARD1, skipped: "phase already exists" } };

const email = {
  id: "bbbbbbbb-0000-4000-8000-000000000001", operation: "email.send@1", action_type: "comms", sms_code: 4,
  input: { to: "adjuster@carrier.com", subject: "Estimate for claim 9", body: "Attached is the estimate." },
  edited_params: null, proposed_by_kind: "agent", proposed_by_id: AGENT, proposed_via: "agent",
  rationale: "The adjuster asked for it on Monday.",
  evidence_refs: [{ label: "Email from the adjuster, Oct 5", url: "https://mail.google.com/mail/u/0/#inbox/1" }, "INV-1001",
    { title: "Sneaky", url: "javascript:alert(1)" }, {}],
  job_id: BOARD2, status: "proposed", created_at: iso(-2), expires_at: iso(4), approved_at: null, updated_at: iso(-2),
  decline_reason: null, result: null, error: null,
};
const stage = {
  id: "bbbbbbbb-0000-4000-8000-000000000002", operation: "job.set_stage@1", action_type: "job",
  input: { job_id: BOARD1, stage: "on_hold" }, edited_params: { stage: "final" },
  proposed_by_kind: "human", proposed_by_id: PERSON, rationale: null, evidence_refs: [],
  job_id: null, status: "proposed", created_at: iso(-1), expires_at: iso(30), approved_at: null, updated_at: iso(-1),
};
const queuedSms = {
  id: "bbbbbbbb-0000-4000-8000-000000000003", operation: "sms.send@1", input: { to: "+19075550000", body: "Crew arrives 8 AM." },
  proposed_by_kind: "system", status: "executed", created_at: iso(-12), expires_at: iso(12), approved_at: iso(-11), updated_at: iso(-11),
};
const delivered = { ...email, id: "bbbbbbbb-0000-4000-8000-000000000004", status: "executed", approved_at: iso(-5), updated_at: iso(-5) };
const declinedSpine = { ...email, id: "bbbbbbbb-0000-4000-8000-000000000005", status: "declined", approved_at: null,
  updated_at: iso(-6), decline_reason: "Already called them" };
const failedSpine = { ...stage, id: "bbbbbbbb-0000-4000-8000-000000000006", status: "failed", approved_at: iso(-7),
  error: "job.set_stage: no live job 22222222-2222-4222-8222-222222222222" };
const staleSpine = { ...email, id: "bbbbbbbb-0000-4000-8000-000000000007", status: "proposed", expires_at: iso(-18) };
const movedSpine = { ...stage, id: "bbbbbbbb-0000-4000-8000-000000000008", status: "executed", approved_at: iso(-4),
  result: { job_id: BOARD1, from: "on_hold", to: "done" } };

const CATALOG = [
  { name: "email.send", version: 1, description: "Send one email. Execution writes one outbox row; the worker delivers it through Gmail." },
  { name: "sms.send", version: 1, description: "Send one text message. Execution writes one outbox row, held until quiet hours end; the worker delivers it through Twilio." },
  { name: "job.set_stage", version: 1, description: "Move a job on the board to another stage (coordination_jobs.data.stage)." },
];
const LOOK = lookFrom({
  catalog: CATALOG,
  agents: [{ id: AGENT, name: "agent:brief" }],
  profiles: [{ id: PERSON, full_name: "Gregory Roybal" }],
  jobs: [{ id: FIELD1, title: null, customer: "Pollen", address: "1192 Bemis Ct" }, { id: BOARD1, title: "Smith remodel", customer: "Smith" }],
  outbox: [
    { proposal_id: delivered.id, status: "delivered", created_at: iso(-4) },
    { proposal_id: delivered.id, status: "pending", created_at: iso(-5) },
    { proposal_id: queuedSms.id, status: "pending", next_attempt_at: "2026-10-07T15:00:00.000Z", created_at: iso(-11) },
  ],
});
const PENDING = [reminder, phase, text, sent, failedPhase, oldDecline, lapsed, swept, ancient, skipped];
const SPINE = [email, stage, queuedSms, delivered, declinedSpine, failedSpine, staleSpine, movedSpine];

test("text queue: an emailSend reminder becomes an Email card with the whole email, its job and a YES hint", () => {
  const c = fromPending(reminder, LOOK);
  assert.equal(c.key, "text:" + reminder.id);
  assert.equal(c.lane, "text");
  assert.equal(c.kind, "email");
  assert.equal(c.chip, "Email");
  assert.equal(c.title, "Email the INV-1001 reminder to Pollen");
  assert.equal(c.approveLabel, "Approve and send");
  assert.equal(c.yesHint, "or text YES 12");
  assert.equal(c.by, "Morning brief");
  assert.deepEqual([c.jobTable, c.jobId, c.job], ["field", FIELD1, "Pollen, 1192 Bemis Ct"]);
  assert.equal(c.evidence.to, "pollen@example.com");
  assert.equal(c.evidence.subject, "Invoice INV-1001 is past due");
  assert.match(c.evidence.body, /^Hi Jane,\n\nA reminder/);
});

test("text queue: boardEdit names its coordination_jobs row and the phase's hours; sendText has no job", () => {
  const p = fromPending(phase, LOOK);
  assert.deepEqual([p.kind, p.chip, p.approveLabel, p.by], ["phase", "Board phase", "Approve and add phase", "QuickBooks Time"]);
  assert.deepEqual([p.jobTable, p.jobId, p.job], ["board", BOARD1, "Smith remodel"]);
  assert.deepEqual([p.evidence.phase, p.evidence.hours], ["Demo", 12]);
  // params.rowId is the one the executor writes, even if job_id says otherwise
  assert.equal(fromPending({ ...phase, job_id: null }).jobId, BOARD1);
  const t = fromPending(text);
  assert.deepEqual([t.kind, t.chip, t.by, t.jobId, t.yesHint], ["text", "Text", "Text assistant", "", "or text YES 14"]);
  assert.equal(t.evidence.message, "Hi Jane, the crew is running about 10 minutes late.");
  assert.equal(t.evidence.to, "+19075551234");
});

test("text queue: an unknown kind or proposer still makes a card, with a plain Approve", () => {
  const c = fromPending({ id: "x", code: 30, kind: "invoiceSend", proposed_by: "web-agent", label: "", status: "pending", params: null });
  assert.deepEqual([c.kind, c.chip, c.title, c.approveLabel, c.by], ["other", "invoiceSend", "invoiceSend", "Approve", "web-agent"]);
  assert.equal(fromPending(null).title, "An ask");
});

test("spine: email.send reads the catalog's first sentence and the key input, with the agent, rationale and evidence; never a YES hint", () => {
  const c = fromProposal(email, LOOK);
  assert.equal(c.key, "spine:" + email.id);
  assert.deepEqual([c.lane, c.kind, c.chip], ["spine", "email", "Email"]);
  assert.equal(c.title, "Send one email: adjuster@carrier.com");
  assert.equal(c.yesHint, "", "sms_code is set, but YES by text doesn't reach the spine");
  assert.equal(c.code, null);
  assert.equal(c.by, "Brief agent");
  assert.deepEqual([c.jobTable, c.jobId], ["board", BOARD2]);
  assert.equal(c.job, "", "a job the lookup missed is just left off");
  assert.equal(c.evidence.rationale, "The adjuster asked for it on Monday.");
  assert.deepEqual(c.evidence.refs, [
    { text: "Email from the adjuster, Oct 5", url: "https://mail.google.com/mail/u/0/#inbox/1" },
    { text: "INV-1001", url: "" },
    { text: "Sneaky", url: "" },              // only an https link becomes a link
  ]);
  // the catalog unreadable: the operation's name stands in
  assert.equal(fromProposal(email).title, "email.send: adjuster@carrier.com");
  assert.equal(fromProposal(email).by, "An agent");
});

test("spine: job.set_stage shows what would run (edited_params over input), the board job and the person who asked", () => {
  const c = fromProposal(stage, LOOK);
  assert.deepEqual([c.kind, c.chip, c.approveLabel], ["stage", "Job stage", "Approve and move job"]);
  assert.equal(c.title, "Move a job on the board to another stage: Final / Punch");
  assert.deepEqual([c.jobId, c.job, c.evidence.stage], [BOARD1, "Smith remodel", "Final / Punch"]);
  assert.equal(c.by, "Gregory Roybal");
  const sms = fromProposal(queuedSms, LOOK);
  assert.deepEqual([sms.kind, sms.chip, sms.title, sms.evidence.message, sms.by],
    ["text", "Text", "Send one text message: +19075550000", "Crew arrives 8 AM.", "The system"]);
});

test("helpers: first sentence, job names, agent names, stage labels", () => {
  assert.equal(firstSentence(CATALOG[0].description), "Send one email");
  assert.equal(firstSentence(CATALOG[2].description), "Move a job on the board to another stage");
  assert.equal(firstSentence(""), "");
  assert.equal(jobName({ title: "Smith remodel", customer: "Smith" }), "Smith remodel");
  assert.equal(jobName({ customer: "Pollen", address: "1192 Bemis Ct" }), "Pollen, 1192 Bemis Ct");
  assert.equal(jobName(null), "");
  assert.equal(agentName("agent:brief"), "Brief agent");
  assert.equal(agentName("agent:collections"), "Collections agent");
  assert.equal(agentName(""), "");
  assert.equal(stageLabel("in_progress"), "In Progress");
  assert.equal(stageLabel("someday"), "someday");
});

test("inbox: both lanes merged, soonest expiry first; recent answers newest first; the expired count over 7 days", () => {
  const box = inbox(PENDING, SPINE, LOOK, NOW);
  assert.deepEqual(box.waiting.map((c) => c.key), [
    "text:" + text.id,          // 40 min
    "spine:" + email.id,        // 4 h
    "text:" + phase.id,         // 11 h
    "text:" + reminder.id,      // 21 h
    "spine:" + stage.id,        // 30 h
  ]);
  assert.deepEqual(box.recent.map((c) => c.key), [
    "text:" + skipped.id,       // ran 2 h ago
    "spine:" + movedSpine.id,   // approved 4 h ago
    "spine:" + delivered.id,    // 5 h
    "spine:" + declinedSpine.id, // 6 h (its last update)
    "spine:" + failedSpine.id,  // 7 h
    "spine:" + queuedSms.id,    // 11 h
    "text:" + failedPhase.id,   // asked 12 h ago (no decision time is kept)
    "text:" + sent.id,          // ran 25.5 h ago
  ]);
  assert.ok(!box.recent.some((c) => c.id === oldDecline.id), "a decline older than 48 h is off the list");
  assert.equal(box.expired, 3, "lapsed + swept + the stale spine row; not the one from three weeks ago");
  assert.deepEqual(inbox(null, undefined, {}, NOW), { waiting: [], recent: [], expired: 0 });
});

test("filters: live needs the open status AND a future expiry, whatever the row says", () => {
  const c = fromPending(reminder);
  assert.equal(isLive(c, NOW), true);
  assert.equal(isLive({ ...c, expiresAt: iso(-0.01) }, NOW), false);
  assert.equal(isExpired({ ...c, expiresAt: iso(-0.01) }, NOW), true);
  assert.equal(isLive({ ...c, status: "approved" }, NOW), false);
  assert.equal(isLive(fromProposal({ ...email, status: "pending" }), NOW), false, "spine's open status is 'proposed'");
  assert.equal(isRecent(fromProposal({ ...email, status: "expired" }), NOW), false);
  assert.equal(isExpired(fromProposal({ ...email, status: "expired", expires_at: iso(-200) }), NOW), false);
});

test("needs: the ids to name, per table and kind; a non-uuid id never reaches an in.() read", () => {
  const box = inbox([...PENDING, { ...reminder, id: "zz", job_id: "local-123", params: {} }], SPINE, {}, NOW);
  const n = needs([...box.waiting, ...box.recent]);
  assert.deepEqual(n.field, [FIELD1]);
  assert.deepEqual(n.board.sort(), [BOARD1, BOARD2].sort());
  assert.deepEqual(n.agents, [AGENT]);
  assert.deepEqual(n.people, [PERSON]);
  assert.deepEqual(n.outbox.sort(), [queuedSms.id, delivered.id].sort(), "executed spine sends only");
  assert.deepEqual(needs([]), { field: [], board: [], agents: [], people: [], outbox: [] });
});

test("lookFrom: catalog by name@version and name, agents and profiles by id, the newest outbox row per proposal", () => {
  assert.match(LOOK.ops["email.send@1"], /^Send one email/);
  assert.match(LOOK.ops["job.set_stage"], /^Move a job/);
  assert.equal(LOOK.people[AGENT], "Brief agent");
  assert.equal(LOOK.people[PERSON], "Gregory Roybal");
  assert.equal(LOOK.outbox[delivered.id].status, "delivered");
  assert.deepEqual(lookFrom(), { jobs: {}, ops: {}, people: {}, outbox: {} });
});

test("outcomes: sent, phase added, already there, queued with the quiet-hours time, delivered, declined with why, failed with why", () => {
  const box = inbox(PENDING, SPINE, LOOK, NOW);
  const by = (id) => outcome(box.recent.find((c) => c.id === id), NOW);
  assert.deepEqual(by(sent.id), { text: "Sent", tone: "ok" });
  assert.deepEqual(by(skipped.id), { text: "Phase was already on the board", tone: "ok" });
  assert.deepEqual(by(failedPhase.id), { text: "Failed: the board job changed while this was pending — nothing was added", tone: "bad" });
  assert.deepEqual(by(queuedSms.id), { text: "Queued, goes out Wed, Oct 7, 7:00 AM", tone: "wait" });
  assert.deepEqual(by(delivered.id), { text: "Delivered", tone: "ok" });
  assert.deepEqual(by(declinedSpine.id), { text: "Declined: Already called them", tone: "no" });
  assert.deepEqual(by(failedSpine.id), { text: "Failed: job.set_stage: no live job 22222222-2222-4222-8222-222222222222", tone: "bad" });
  assert.deepEqual(by(movedSpine.id), { text: "Moved to Complete", tone: "ok" });
  const t = fromPending(phase);
  assert.equal(outcome({ ...t, status: "executed" }).text, "Phase added");
  assert.equal(outcome({ ...t, status: "declined" }).text, "Declined");
  assert.equal(outcome({ ...t, status: "approved" }).text, "Approved, still running");
  assert.equal(outcome({ ...t, status: "failed", error: "" }).text, "Failed: no reason given");
  const e = fromProposal({ ...email, status: "executed" });
  assert.equal(outcome(e).text, "Queued to send", "no outbox row readable");
  assert.equal(outcome({ ...e, outbox: { status: "dead", error: "Gmail refused the address" } }).text, "Couldn't send: Gmail refused the address");
  assert.equal(outcome({ ...e, outbox: { status: "dead" } }).tone, "bad");
  assert.equal(outcome({ ...e, outbox: { status: "failed" } }).text, "Send failed, retrying");
  assert.equal(outcome({ ...e, outbox: { status: "sent" } }).text, "Sent");
  assert.equal(outcome({ ...e, status: "approved" }).text, "Approved, queued to run");
  assert.equal(outcome({ ...e, status: "declined", evidence: { ...e.evidence, reason: "" } }).text, "Declined");
});

test("Alaska time: today, yesterday, else the date; expiry counts down without overstating", () => {
  assert.equal(akTime("2026-10-06T15:02:00Z", NOW), "7:02 AM");
  assert.equal(akTime("2026-10-06T07:30:00Z", NOW), "yesterday 11:30 PM", "Oct 6 07:30 UTC is still Oct 5 in Alaska");
  assert.equal(akTime("2026-10-01T22:15:00Z", NOW), "Thu, Oct 1, 2:15 PM");
  assert.equal(akTime("", NOW), "");
  assert.equal(expiresIn(iso(5.9), NOW), "expires in 5 h");
  assert.equal(expiresIn(iso(0.66), NOW), "expires in 39 min");
  assert.equal(expiresIn(iso(0.005), NOW), "expires in under a minute");
  assert.equal(expiresIn(iso(30), NOW), "expires in 30 h");
  assert.equal(expiresIn(iso(24 * 5 + 2), NOW), "expires in 5 days");
  assert.equal(expiresIn("nope", NOW), "");
  assert.equal(expiredLine(0), "");
  assert.equal(expiredLine(1), "1 ask expired without an answer in the last 7 days");
  assert.equal(expiredLine(3), "3 asks expired without an answer in the last 7 days");
});

test("the dialogs name the action", () => {
  assert.equal(approveConfirm(fromPending(reminder, LOOK)), "Send this email to pollen@example.com?");
  assert.equal(approveConfirm(fromPending(text)), "Send this text to +19075551234?");
  assert.equal(approveConfirm(fromPending(phase, LOOK)), 'Add the phase "Demo" to Smith remodel on the board?');
  assert.equal(approveConfirm(fromPending(phase)), 'Add the phase "Demo" to this job on the board?');
  assert.equal(approveConfirm(fromProposal(stage, LOOK)), "Move Smith remodel to Final / Punch on the board?");
  assert.equal(approveConfirm(fromPending({ id: "x", kind: "mystery", label: "do a thing" })), "Approve: Do a thing?");
  assert.equal(declineConfirm(fromPending(reminder)), 'Decline "Email the INV-1001 reminder to Pollen"? Nothing is sent or changed.');
  assert.match(declinePrompt(fromProposal(email, LOOK)), /^Decline "Send one email: adjuster@carrier\.com"\?\n\nA reason/);
});

test("requests: the text queue goes through decidePending, the spine through its two RPCs (p_via inbox, reason or null)", () => {
  const t = fromPending(reminder), s = fromProposal(email);
  assert.deepEqual(decisionRequest(t, "approve"), { fn: "roybal-notify", body: { action: "decidePending", id: reminder.id, decision: "approve" } });
  assert.deepEqual(decisionRequest(t, "decline", "ignored"), { fn: "roybal-notify", body: { action: "decidePending", id: reminder.id, decision: "decline" } });
  assert.deepEqual(decisionRequest(s, "approve"), { rpc: "op_proposal_approve", body: { p_proposal_id: email.id, p_via: "inbox" } });
  assert.deepEqual(decisionRequest(s, "decline", "  Already called them "), { rpc: "op_proposal_decline", body: { p_proposal_id: email.id, p_reason: "Already called them" } });
  assert.deepEqual(decisionRequest(s, "decline", "  "), { rpc: "op_proposal_decline", body: { p_proposal_id: email.id, p_reason: null } });
});

test("decidePending: every answer in the contract, and the not-deployed fallback that sends him to YES / NO by text", () => {
  const c = fromPending(reminder);
  const ok = (status, body, d = "approve") => pendingAnswer(status, body, c, d);
  assert.deepEqual(ok(200, { ok: true, status: "executed", message: "Done — email the reminder." }), { ok: true, status: "executed", message: "Done — email the reminder." });
  assert.deepEqual(ok(200, { ok: true, status: "declined", message: "" }, "decline"), { ok: true, status: "declined", message: "" });
  assert.deepEqual(ok(200, { ok: true, status: "failed", message: "gmail said no" }), { ok: true, status: "failed", message: "gmail said no" });
  assert.deepEqual(ok(400, { ok: false, error: "bad_request", message: "Provide `id`, the pending action's uuid." }),
    { ok: false, error: "The server didn't accept this request: Provide `id`, the pending action's uuid. Nothing changed." });
  assert.deepEqual(ok(400, { ok: false, error: "Unknown action. Expected one of: sendSms" }),
    { ok: false, error: "The server can't take this answer from the app yet. Text YES 12 to approve it." });
  assert.deepEqual(ok(400, { ok: false, error: "Unknown action. Expected one of: sendSms" }, "decline"),
    { ok: false, error: "The server can't take this answer from the app yet. Text NO 12 to decline it." });
  assert.deepEqual(ok(404, null), { ok: false, error: "The server can't take this answer from the app yet. Text YES 12 to approve it." });
  assert.deepEqual(ok(404, { code: "NOT_FOUND", message: "Requested function was not found" }).error,
    "The server can't take this answer from the app yet. Text YES 12 to approve it.");
  assert.deepEqual(ok(502, null).error, "The server can't take this answer from the app yet. Text YES 12 to approve it.");
  assert.deepEqual(ok(500, { ok: false, error: "server_error", message: "gmail-proxy timed out" }).error,
    "Something went wrong on the server (500: gmail-proxy timed out). Text YES 12 to approve it.");
  assert.deepEqual(ok(401, { ok: false, error: "Missing Authorization bearer token" }), { ok: false, error: SIGNED_OUT });
  assert.deepEqual(ok(403, { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." }),
    { ok: false, error: "Only the owner's login can answer this." });
  assert.deepEqual(ok(404, { ok: false, error: "not_open", message: "Already answered, or it expired." }),
    { ok: false, error: "Already answered, or it expired.", gone: true });
  assert.deepEqual(ok(409, { ok: false, error: "quiet_hours", message: "…" }),
    { ok: false, error: "Customer texts go out only between 7 AM and 8 PM Alaska time. This one is still waiting: approve it again after 7 AM." });
  assert.deepEqual(ok(418, { message: "short and stout" }), { ok: false, error: "short and stout" });
  assert.deepEqual(ok(418, null), { ok: false, error: "Couldn't record that (418)." });
  assert.equal(ok(200, { ok: false }).ok, false, "a 200 that isn't ok:true recorded nothing");
  assert.match(NO_CONNECTION, /No connection/);
});

test("spine RPCs: the row back, or a sentence by SQLSTATE (PostgREST serves 55000 and P0002 as 500s)", () => {
  const row = { ...email, status: "executed" };
  assert.deepEqual(spineAnswer(200, row), { ok: true, row });
  assert.deepEqual(spineAnswer(403, { code: "42501", message: "op spine: proposal x waits on owner, not office" }),
    { ok: false, error: "Your login isn't allowed to answer this one." });
  assert.deepEqual(spineAnswer(500, { code: "P0002", message: "op spine: no proposal x" }), { ok: false, error: "This ask no longer exists.", gone: true });
  assert.deepEqual(spineAnswer(500, { code: "55000", message: "op spine: proposal x is declined" }), { ok: false, error: "Already answered, or it expired.", gone: true });
  assert.deepEqual(spineAnswer(400, { code: "22023", message: "op spine: unknown approval channel policy" }),
    { ok: false, error: "The server refused this as invalid: unknown approval channel policy. Nothing changed." });
  assert.deepEqual(spineAnswer(404, { code: "PGRST202", message: "Could not find the function" }),
    { ok: false, error: "The server doesn't have the approvals update yet. Nothing changed." });
  assert.deepEqual(spineAnswer(401, { code: "PGRST301", message: "JWT expired" }), { ok: false, error: SIGNED_OUT });
  assert.deepEqual(spineAnswer(400, { code: "PGRST100", message: "parse error" }), { ok: false, error: "The server couldn't run that (PGRST100). Nothing changed." });
  assert.deepEqual(spineAnswer(500, { code: "XX000", message: "boom" }), { ok: false, error: "boom" });
  assert.deepEqual(spineAnswer(503, null), { ok: false, error: "Couldn't record that (503)." });
  assert.equal(spineAnswer(200, null).ok, false);
});

test("an answered card moves off Waiting onto the top of Recently decided with its outcome", () => {
  const box = inbox(PENDING, SPINE, LOOK, NOW);
  const card = box.waiting.find((c) => c.id === reminder.id);
  const done = decidedText(card, { ok: true, status: "executed", message: "" }, NOW);
  assert.deepEqual([done.status, done.decidedAt, done.answeredAt], ["executed", new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  const after = settle(box, card, done);
  assert.equal(after.waiting.length, box.waiting.length - 1);
  assert.ok(!after.waiting.some((c) => c.key === card.key));
  assert.equal(after.recent[0], done);
  assert.equal(outcome(after.recent[0]).text, "Sent");
  const failed = decidedText(card, { ok: true, status: "failed", message: "gmail refused" }, NOW);
  assert.equal(outcome(failed).text, "Failed: gmail refused");
  assert.equal(after.expired, box.expired);
});
