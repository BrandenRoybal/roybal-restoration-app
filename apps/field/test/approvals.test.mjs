/* approvals.js — the office Approvals tab's pure logic (operations spine,
   step 4): both queues' rows as one card shape, waiting / recently decided /
   expired and their order, the names a page must look up, outcome lines,
   Alaska times, what each button sends, and the sentence for every answer
   roybal-notify decidePending and the spine RPCs can give. Then spine
   step 5: a waiting spine card's YES number (and none when one number is
   live on both queues), spine jobs named from either job table, and what
   the newest worker heartbeat says about email sending, on a waiting
   email and an approved one.
   Run: node --test test/approvals.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fromPending, fromProposal, inbox, needs, lookFrom, outcome, isLive, isExpired, isRecent,
  akTime, expiresIn, expiredLine, firstSentence, jobName, agentName, stageLabel,
  approveConfirm, declineConfirm, declinePrompt, decisionRequest, pendingAnswer, spineAnswer,
  decidedText, settle, NO_CONNECTION, SIGNED_OUT, NEVER_REPORTED,
  NEVER_REPORTED_PHASE, WAIT_MS, sawApproved, skippedLine, labelOf, READ_GAP_MS,
  emailLaneOf, HEARTBEAT_FRESH_MS, LANE_OFF_WAITING, LANE_OFF_QUEUED, LANE_OFF_FAILED,
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

test("spine: email.send reads the catalog's first sentence and the key input, with the agent, rationale, evidence and its YES number", () => {
  const c = fromProposal(email, LOOK);
  assert.equal(c.key, "spine:" + email.id);
  assert.deepEqual([c.lane, c.kind, c.chip], ["spine", "email", "Email"]);
  assert.equal(c.title, "Send one email: adjuster@carrier.com");
  assert.equal(c.yesHint, "or text YES 4", "the text-queue card's words: roybal-notify answers a YES n on the spine too");
  assert.equal(c.code, 4);
  assert.equal(c.by, "Brief agent");
  assert.deepEqual([c.jobTable, c.jobId], ["either", BOARD2], "the page looks it up in both job tables");
  assert.equal(c.job, "", "a job the lookup missed is just left off");
  assert.equal(c.evidence.rationale, "The adjuster asked for it on Monday.");
  assert.deepEqual(c.evidence.refs, [
    { text: "Email from the adjuster, Oct 5", url: "https://mail.google.com/mail/u/0/#inbox/1", host: "mail.google.com" },
    { text: "INV-1001", url: "", host: "" },
    { text: "Sneaky", url: "", host: "" },              // only an https link becomes a link
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
  assert.deepEqual(box.skipped, { text: 0, spine: 0 });
  assert.deepEqual(inbox(null, undefined, {}, NOW), { waiting: [], recent: [], expired: 0, skipped: { text: 0, spine: 0 } });
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
  // the spine email's job (BOARD2) could be either kind of job, so both tables are asked
  assert.deepEqual(n.field.sort(), [FIELD1, BOARD2].sort());
  assert.deepEqual(n.board.sort(), [BOARD1, BOARD2].sort());
  assert.deepEqual(n.agents, [AGENT]);
  assert.deepEqual(n.people, [PERSON]);
  assert.deepEqual(n.outbox.sort(), [queuedSms.id, delivered.id].sort(), "executed spine sends only");
  assert.deepEqual(n.lanes, ["email"], "a spine email waiting or sent: the page reads the worker's heartbeat");
  assert.deepEqual(needs([]), { field: [], board: [], agents: [], people: [], outbox: [], lanes: [] });
});

test("lookFrom: catalog by name@version and name, agents and profiles by id, the newest outbox row per proposal", () => {
  assert.match(LOOK.ops["email.send@1"], /^Send one email/);
  assert.match(LOOK.ops["job.set_stage"], /^Move a job/);
  assert.equal(LOOK.people[AGENT], "Brief agent");
  assert.equal(LOOK.people[PERSON], "Gregory Roybal");
  assert.equal(LOOK.outbox[delivered.id].status, "delivered");
  assert.deepEqual(lookFrom(), { jobs: {}, ops: {}, people: {}, outbox: {}, emailLane: null }, "no heartbeat read: can't tell");
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
  assert.equal(outcome({ ...t, status: "approved", answeredHere: true }).text, "Approved — adding the phase");
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
  assert.deepEqual(ok(502, null).error, "The server didn't answer. Refresh to see whether it went through.");
  assert.deepEqual(ok(500, { ok: false, error: "server_error", message: "gmail-proxy timed out" }).error,
    "Something went wrong on the server (500: gmail-proxy timed out). Refresh to see whether it went through.");
  assert.deepEqual(ok(401, { ok: false, error: "Missing Authorization bearer token" }), { ok: false, error: SIGNED_OUT });
  assert.deepEqual(ok(403, { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." }),
    { ok: false, error: "Only the owner's login can answer this." });
  assert.deepEqual(ok(404, { ok: false, error: "not_open", message: "Already answered, or it expired." }),
    { ok: false, error: "Already answered, or it expired.", gone: true });
  assert.deepEqual(ok(409, { ok: false, error: "quiet_hours", message: "Customer texts go out between 7am and 8pm Alaska time. It's still waiting; approve it then." }),
    { ok: false, error: "Customer texts go out between 7am and 8pm Alaska time. It's still waiting; approve it then." });
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

/* ---------- review round 1 ---------- */

test("job.set_stage names the job the executor moves: edited_params.job_id, then input.job_id; proposals.job_id only when neither is set", () => {
  const OTHER = "55555555-5555-4555-8555-555555555555";
  const look = { ...LOOK, jobs: { ...LOOK.jobs, [BOARD2]: "Jones roof", [OTHER]: "Okafor basement" } };
  // op_propose stored p_job_id (BOARD2) while input.job_id says BOARD1: BOARD1 is the one that moves
  const c = fromProposal({ ...stage, job_id: BOARD2 }, look);
  assert.deepEqual([c.jobId, c.job], [BOARD1, "Smith remodel"]);
  assert.equal(approveConfirm(c), "Move Smith remodel to Final / Punch on the board?");
  assert.deepEqual(needs([c]).board, [BOARD1], "the lookup asks for the job that moves");
  // an edit that names a job wins, as it does in op_execute's input || edited_params
  const e = fromProposal({ ...stage, job_id: BOARD2, edited_params: { stage: "done", job_id: OTHER } }, look);
  assert.deepEqual([e.jobId, e.job], [OTHER, "Okafor basement"]);
  assert.equal(approveConfirm(e), "Move Okafor basement to Complete on the board?");
  // params with no job: the row's own job_id stands in
  const f = fromProposal({ ...stage, job_id: BOARD2, input: { stage: "done" }, edited_params: null }, look);
  assert.deepEqual([f.jobId, f.job], [BOARD2, "Jones roof"]);
  // other kinds still name proposals.job_id
  assert.equal(fromProposal({ ...email, input: { ...email.input, job_id: BOARD1 } }, look).jobId, BOARD2);
});

test("a row naming Object.prototype's members is just unknown, and a row that won't read is left off with a warning", () => {
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const c = fromPending({ ...reminder, kind: k, proposed_by: k }, LOOK);
    assert.deepEqual([c.kind, c.chip, c.approveLabel, c.by], ["other", k, "Approve", k], k);
    const s = fromProposal({ ...email, operation: k + "@1", proposed_by_kind: k, proposed_by_id: k }, LOOK);
    assert.deepEqual([s.kind, s.chip, s.by], ["other", k, ""], k);
    assert.equal(fromProposal({ ...stage, input: { job_id: BOARD1, stage: k }, edited_params: null }, LOOK).evidence.stage, k);
    assert.equal(stageLabel(k), k);
    assert.equal(outcome({ ...fromProposal(delivered), outbox: { status: k } }).text, "Queued to send");
    assert.equal(fromPending({ ...reminder, job_id: k }, LOOK).job, "", "no job is named by a prototype member");
  }
  // a prototype-named id in a lookup read can't swap a map's prototype
  const look = lookFrom({ jobs: [{ id: "__proto__", title: "Poison" }], outbox: [{ proposal_id: "__proto__", status: "dead" }] });
  assert.equal(Object.getPrototypeOf(look.outbox), Object.prototype);
  assert.equal(fromProposal(delivered, look).outbox, null);
  assert.equal(fromPending({ ...reminder, job_id: "__proto__" }, look).job, "Poison", "an own key still counts");
  // one row whose label can't become text: the others still make the list
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const box = inbox([reminder, { ...phase, id: "bad-1", label: { toString: 1 } }], [email, { ...email, id: "bad-2", rationale: { toString: 1 } }], LOOK, NOW);
    assert.deepEqual(box.waiting.map((c) => c.key), ["spine:" + email.id, "text:" + reminder.id]);
    assert.deepEqual(box.skipped, { text: 1, spine: 1 }, "both were open and unexpired");
  } finally { console.warn = warn; }
  assert.equal(warned.length, 2);
  assert.match(warned[0], /left off a text row .*bad-1/);
  assert.match(warned[1], /left off a spine row .*bad-2/);
});

test("evidence links carry the host they really open, past userinfo and as punycode; only a parseable https link is one", () => {
  const refs = fromProposal({ ...email, evidence_refs: [
    { label: "QuickBooks invoice INV-4", url: "https://qb-login.example.net/signin" },
    { label: "Gmail thread", url: "https://mail.google.com@evil.example/x" },
    { label: "Look-alike", href: "https://gооgle.com/" },          // Cyrillic o's
    "https://mail.google.com/mail/u/0/#inbox/2",
    { label: "Plain http", url: "http://mail.google.com/" },
    { label: "Broken", url: "https://" },
  ] }).evidence.refs;
  assert.deepEqual(refs.map((r) => [r.text, r.host]), [
    ["QuickBooks invoice INV-4", "qb-login.example.net"],
    ["Gmail thread", "evil.example"],
    ["Look-alike", "xn--ggle-55da.com"],
    ["https://mail.google.com/mail/u/0/#inbox/2", "mail.google.com"],
    ["Plain http", ""],
    ["Broken", ""],
  ]);
  assert.deepEqual(refs.slice(4).map((r) => r.url), ["", ""]);
});

test("decidePending's newer answers: an expired login, a role check that couldn't answer, quiet hours and try-again in the server's words", () => {
  const c = fromPending(text);
  const ok = (status, body) => pendingAnswer(status, body, c, "approve");
  assert.deepEqual(ok(401, { ok: false, error: "auth", message: "Your login expired. Sign in again." }),
    { ok: false, error: "Your login expired. Sign in again." });
  assert.deepEqual(ok(401, { ok: false, error: "Missing Authorization bearer token" }), { ok: false, error: SIGNED_OUT }, "unchanged");
  assert.deepEqual(ok(503, { ok: false, error: "role_check_failed", message: "Couldn't check your login just now. Try again." }),
    { ok: false, error: "Couldn't check your login just now. Try again." });
  assert.deepEqual(ok(403, { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." }),
    { ok: false, error: "Only the owner's login can answer this." }, "unchanged");
  // the window is roybal-notify's setting: its sentence, not one with hours baked in here
  assert.deepEqual(ok(409, { ok: false, error: "quiet_hours", message: "Customer texts go out between 8am and 9pm Alaska time. It's still waiting; approve it then." }),
    { ok: false, error: "Customer texts go out between 8am and 9pm Alaska time. It's still waiting; approve it then." });
  assert.deepEqual(ok(409, { ok: false, error: "try_again", message: "Couldn't reach the board just now. Nothing was added; try again in a minute." }),
    { ok: false, error: "Couldn't reach the board just now. Nothing was added; try again in a minute." });
  for (const body of [{ ok: false, error: "quiet_hours" }, { ok: false, error: "try_again" }, null]) {
    const a = ok(409, body);
    assert.equal(a.ok, false);
    assert.ok(!a.gone, "the card stays live");
    assert.ok(a.error && !/\d/.test(a.error), `the fallback names no hours: ${a.error}`);
  }
  assert.match(ok(409, { error: "try_again" }).error, /try again in a minute/i);
});

test("a row read back still 'approved' long after this tab first saw it never reported back; a 5xx with no JSON says to refresh", () => {
  const stuck = fromPending({ ...reminder, status: "approved" });
  assert.deepEqual(outcome(stuck, NOW, NOW - WAIT_MS - 1), { text: NEVER_REPORTED, tone: "bad" });
  assert.equal(NEVER_REPORTED, "Approved, but it never reported back. Check whether it went out before sending it again.");
  assert.deepEqual(outcome(fromPending({ ...reminder, status: "approved", result: { error: "gmail token expired" } })),
    { text: "Failed: gmail token expired", tone: "bad" });
  const box = inbox([{ ...reminder, status: "approved" }], [], LOOK, NOW);
  assert.equal(outcome(box.recent[0], NOW, NOW - 10 * 60e3).text, NEVER_REPORTED, "on Recently decided as read from the server");
  const mine = decidedText(fromPending(reminder), { ok: true, status: "approved", message: "", action: { status: "approved", result: {} } }, NOW);
  assert.deepEqual(outcome(mine, NOW + 60 * 60e3, NOW), { text: "Approved — waiting to hear how it went", tone: "wait" }, "this tab's own answer");
  const c = fromPending(reminder);
  for (const st of [500, 502, 503, 504, 546]) {
    assert.equal(pendingAnswer(st, null, c, "approve").error, "The server didn't answer. Refresh to see whether it went through.", String(st));
  }
  // "text YES n" is kept for the two answers that mean decidePending never ran
  assert.match(pendingAnswer(400, { ok: false, error: "Unknown action. Expected one of: sendSms" }, c, "approve").error, /Text YES 12/);
  assert.match(pendingAnswer(404, null, c, "approve").error, /Text YES 12/);
  assert.ok(!/YES/.test(pendingAnswer(500, { ok: false, error: "server_error", message: "x" }, c, "approve").error));
});

test("the decided card takes the row as the server re-read it: a phase that was already there says so at once", () => {
  const card = fromPending(phase, LOOK);
  const ans = pendingAnswer(200, { ok: true, status: "executed", message: "Phase was already on the board — nothing was added.",
    action: { id: phase.id, code: 13, kind: "boardEdit", label: phase.label, status: "executed", result: { rowId: BOARD1, skipped: "phase already exists" } } }, card, "approve");
  assert.deepEqual(ans.action, { status: "executed", result: { rowId: BOARD1, skipped: "phase already exists" } });
  const done = decidedText(card, ans, NOW);
  assert.equal(outcome(done).text, "Phase was already on the board");
  assert.equal(done.result.rowId, BOARD1);
  // a failed answer whose re-read shows gmail-proxy already stamped it executed: the row's word wins
  const sentAnyway = decidedText(fromPending(reminder), { ok: true, status: "failed", message: "connection reset",
    action: { status: "executed", result: {} } }, NOW);
  assert.equal(outcome(sentAnyway).text, "Sent");
  // a failure carries its reason from the stamped result, else the message
  assert.equal(outcome(decidedText(card, { ok: true, status: "failed", message: "x", action: { status: "failed", result: { error: "the board job changed" } } }, NOW)).text,
    "Failed: the board job changed");
  assert.equal(outcome(decidedText(card, { ok: true, status: "failed", message: "board said no" }, NOW)).text, "Failed: board said no");
  // a body without action (an older function) still works as before
  assert.equal(outcome(decidedText(card, { ok: true, status: "executed", message: "" }, NOW)).text, "Phase added");
});

test("Alaska 'yesterday' is the calendar day before, across both DST changes", () => {
  // Mar 9 2026, 00:30 AKDT, the night after the 23-hour day
  const spring = Date.parse("2026-03-09T08:30:00Z");
  assert.equal(akTime("2026-03-08T08:45:00Z", spring), "Sat, Mar 7, 11:45 PM", "two days back is a date");
  assert.equal(akTime("2026-03-08T19:00:00Z", spring), "yesterday 11:00 AM");
  assert.equal(akTime("2026-03-09T08:10:00Z", spring), "12:10 AM");
  // Nov 1 2026, 11:30 PM AKST, the end of the 25-hour day
  const fall = Date.parse("2026-11-02T08:30:00Z");
  assert.equal(akTime("2026-10-31T18:00:00Z", fall), "yesterday 10:00 AM");
  assert.equal(akTime("2026-11-01T08:30:00Z", fall), "12:30 AM", "the first minutes of the long day are today");
  assert.equal(akTime("2026-10-31T07:30:00Z", fall), "Fri, Oct 30, 11:30 PM");
  // across a month and a year end
  assert.equal(akTime("2026-12-31T20:00:00Z", Date.parse("2027-01-01T20:00:00Z")), "yesterday 11:00 AM");
  assert.equal(akTime("2026-10-07T18:00:00Z", NOW), "Wed, Oct 7, 10:00 AM", "tomorrow is a date, not 'yesterday'");
});

test("P0002 'no live operation': the ask was retired, only Decline can answer it; 'no proposal' is gone", () => {
  assert.deepEqual(spineAnswer(500, { code: "P0002", message: "op spine: no live operation email.send@1" }),
    { ok: false, error: "This kind of ask was retired before you answered it. Decline it; nothing was sent.", declineOnly: true });
  assert.deepEqual(spineAnswer(500, { code: "P0002", message: "op spine: no proposal bbbbbbbb-0000-4000-8000-000000000001" }),
    { ok: false, error: "This ask no longer exists.", gone: true });
});

/* ---------- review round 2 ---------- */

test("Safari before 15.4 (no Object.hasOwn): every row still makes its card, with its chip and names", () => {
  const real = Object.hasOwn;
  delete Object.hasOwn;
  try {
    assert.equal(typeof Object.hasOwn, "undefined");
    const box = inbox(PENDING, SPINE, LOOK, NOW);
    assert.equal(box.waiting.length, 5);
    assert.deepEqual(box.skipped, { text: 0, spine: 0 });
    const r = box.waiting.find((c) => c.id === reminder.id);
    assert.deepEqual([r.chip, r.by, r.job], ["Email", "Morning brief", "Pollen, 1192 Bemis Ct"]);
    assert.equal(stageLabel("on_hold"), "On Hold");
    assert.equal(outcome(box.recent.find((c) => c.id === delivered.id), NOW).text, "Delivered");
    assert.equal(lookFrom({ jobs: [{ id: FIELD1, title: "Pollen" }] }).jobs[FIELD1], "Pollen");
  } finally { Object.hasOwn = real; }
});

test("rows left off are counted when they may be waiting, and the line says how to answer them", () => {
  const bad = (row, n) => ({ ...row, id: "bad-" + n, label: { toString: 1 }, rationale: { toString: 1 } });
  const warn = console.warn;
  console.warn = () => {};
  let box;
  try {
    box = inbox(
      [bad(reminder, 1), bad(phase, 2), bad(sent, 3), bad(lapsed, 4), bad({ ...phase, expires_at: { toString: 1 } }, 5), reminder],
      [bad(email, 6), bad(delivered, 7)], LOOK, NOW);
  } finally { console.warn = warn; }
  // 1, 2: open and unexpired; 3 answered and 4 expired are not waiting; 5's expiry won't read: counted
  assert.deepEqual(box.skipped, { text: 3, spine: 1 });
  assert.deepEqual(box.waiting.map((c) => c.id), [reminder.id]);
  assert.equal(skippedLine({ text: 1, spine: 0 }), "1 ask couldn't be shown here. Answer it by text, or tell Claude.");
  assert.equal(skippedLine({ text: 3, spine: 0 }), "3 asks couldn't be shown here. Answer them by text, or tell Claude.");
  // a spine ask the brief texted him can be answered by text now; one that wasn't, can't
  assert.equal(skippedLine({ text: 0, spine: 1 }), "1 ask couldn't be shown here. Any that came to you by text can be answered there; otherwise tell Claude.");
  assert.equal(skippedLine({ text: 0, spine: 2 }), "2 asks couldn't be shown here. Any that came to you by text can be answered there; otherwise tell Claude.");
  assert.equal(skippedLine(box.skipped), "4 asks couldn't be shown here. Any that came to you by text can be answered there; otherwise tell Claude.");
  for (const none of [{ text: 0, spine: 0 }, {}, null, undefined]) assert.equal(skippedLine(none), "");
});

test("a row seen at 'approved' waits a few minutes from this tab's first sighting before it says it never reported back", () => {
  const mail = fromPending({ ...reminder, status: "approved" });
  const board = fromPending({ ...phase, status: "approved" });
  const WAIT = { text: "Approved — waiting to hear how it went", tone: "wait" };
  const ADDING = { text: "Approved — adding the phase", tone: "wait" };
  assert.equal(WAIT_MS, 3 * 60 * 1000);
  assert.deepEqual(outcome(mail, NOW, NOW), WAIT, "just seen");
  assert.deepEqual(outcome(mail, NOW, NOW - WAIT_MS), WAIT, "three minutes on the dot: still waiting");
  assert.deepEqual(outcome(mail, NOW, NOW - WAIT_MS - 1), { text: NEVER_REPORTED, tone: "bad" });
  assert.deepEqual(outcome(board, NOW, NOW - 60e3), ADDING);
  assert.deepEqual(outcome(board, NOW, NOW - WAIT_MS - 1), { text: NEVER_REPORTED_PHASE, tone: "bad" });
  assert.equal(NEVER_REPORTED_PHASE, "Approved, but it never reported back. Check the board before approving it again.");
  // no sighting kept yet (or a junk one) is a sighting now
  for (const seen of [undefined, null, NaN, "x"]) assert.deepEqual(outcome(mail, NOW, seen), WAIT, String(seen));
  assert.deepEqual(outcome(mail), WAIT);
  // this tab's answer (landed, or still out: the page marks it) waits whatever the clock says
  assert.deepEqual(outcome({ ...mail, answeredHere: true }, NOW, NOW - 60 * 60e3), WAIT);
  assert.deepEqual(outcome({ ...board, answeredHere: true }, NOW, NOW - 60 * 60e3), ADDING);
  // an error stamped on it is a failure at once
  assert.equal(outcome({ ...mail, error: "gmail said no" }, NOW, NOW).text, "Failed: gmail said no");
  // the spine's 'approved' is its own thing: the worker runs it
  assert.equal(outcome(fromProposal({ ...stage, status: "approved" }), NOW, NOW - 60 * 60e3).text, "Approved, queued to run");
});

test("sawApproved keeps each text row's first sighting across refreshes, drops rows no longer approved, and ignores the spine", () => {
  const seen = new Map();
  const a = fromPending({ ...reminder, status: "approved" }), b = fromPending({ ...phase, status: "approved" });
  const s = fromProposal({ ...stage, status: "approved" });
  assert.equal(sawApproved(seen, [a, s, fromPending(sent)], NOW), seen);
  assert.deepEqual([...seen], [[a.key, NOW]], "only the text row at 'approved'");
  sawApproved(seen, [a, b], NOW + 60e3);
  assert.deepEqual([...seen], [[a.key, NOW], [b.key, NOW + 60e3]], "a's first sighting is kept");
  assert.equal(outcome(a, NOW + 4 * 60e3, seen.get(a.key)).text, NEVER_REPORTED);
  assert.equal(outcome(b, NOW + 4 * 60e3, seen.get(b.key)).text, "Approved — adding the phase");
  // b was put back to pending (the board couldn't be reached), then approved again later: it waits afresh
  sawApproved(seen, [a, { ...b, status: "pending" }], NOW + 5 * 60e3);
  assert.deepEqual([...seen.keys()], [a.key]);
  sawApproved(seen, [a, b], NOW + 20 * 60e3);
  assert.equal(seen.get(b.key), NOW + 20 * 60e3);
  assert.equal(outcome(b, NOW + 21 * 60e3, seen.get(b.key)).text, "Approved — adding the phase");
  sawApproved(seen, [], NOW);
  assert.equal(seen.size, 0);
  assert.equal(sawApproved(new Map(), null, NOW).size, 0);
});

test("after a gap in reading, a row still 'approved' starts its sighting over: a revert and a fresh approval may have gone unseen", () => {
  const seen = new Map();
  const b = fromPending({ ...phase, status: "approved" });
  sawApproved(seen, [b], NOW);
  // reads every 45 s keep the first sighting
  sawApproved(seen, [b], NOW + 45e3, NOW);
  sawApproved(seen, [b], NOW + 90e3, NOW + 45e3);
  assert.equal(seen.get(b.key), NOW);
  // the office was on the board for five minutes: whatever it saw before may not be this run
  sawApproved(seen, [b], NOW + 90e3 + READ_GAP_MS + 1, NOW + 90e3);
  assert.equal(seen.get(b.key), NOW + 90e3 + READ_GAP_MS + 1);
  assert.equal(outcome(b, NOW + 90e3 + READ_GAP_MS + 60e3, seen.get(b.key)).text, "Approved — adding the phase");
  // no earlier read to compare (the page's first): nothing to restart
  const fresh = new Map([[b.key, NOW]]);
  sawApproved(fresh, [b], NOW + 10 * 60e3);
  assert.equal(fresh.get(b.key), NOW);
  // an email or a text never goes back to pending, so a gap doesn't restart it: stuck is stuck
  const a = fromPending({ ...reminder, status: "approved" });
  const mail = new Map([[a.key, NOW]]);
  sawApproved(mail, [a], NOW + 10 * 60e3, NOW);
  assert.equal(mail.get(a.key), NOW);
  assert.equal(outcome(a, NOW + 10 * 60e3, mail.get(a.key)).text, NEVER_REPORTED);
  // a clock that went backwards is a gap, and a sighting in the future is never kept
  const back = new Map([[a.key, NOW + 60 * 60e3], [b.key, NOW]]);
  sawApproved(back, [a, b], NOW + 60e3, NOW + 30 * 60e3);
  assert.deepEqual([back.get(a.key), back.get(b.key)], [NOW + 60e3, NOW + 60e3]);
});

test("a skip the server knew of stays a skip when the re-read still says 'approved'", () => {
  const card = fromPending(phase, LOOK);
  const done = decidedText(card, { ok: true, status: "executed", message: "Phase was already on the board — nothing was added.",
    action: { id: phase.id, code: phase.code, kind: "boardEdit", label: phase.label, status: "approved", result: { skipped: "phase already exists" } } }, NOW);
  assert.equal(done.status, "executed");
  assert.equal(outcome(done).text, "Phase was already on the board");
});

test("labelOf reads the label as the screen shows it, and never stalls on one built to", () => {
  for (const fake of ["Invoice (quickbooks.intuit.com).", "Invoice (quickbooks.intuit.com)\u200b", "Invoice (quickbooks.intuit.com)\u2060",
    "Invoice (quickbooks.intuit.com)\u200e", "Invoice \uFF08quickbooks\uFF0Eintuit\uFF0Ecom\uFF09", "Invoice (opens (quickbooks.intuit.com))",
    "Invoice {quickbooks.intuit.com}", "opens quickbooks.intuit.com \u2014 Invoice", "Opens quickbooks.intuit.com: Invoice"]) {
    assert.equal(labelOf(fake), "Invoice", JSON.stringify(fake));
  }
  // invisible marks that aren't format characters, and brackets that only look like brackets
  for (const fake of ["Invoice (quickbooks.intuit.com)\u034F", "Invoice (quickbooks.intuit.com)\uFE0F", "Invoice (quickbooks.intuit.com)\u3164",
    "Invoice (quickbooks.intuit.com)\u2800", "Invoice (quickbooks.\uFE0Fintuit.\uFE0Fcom)", "Invoice \u3010quickbooks.intuit.com\u3011",
    "Invoice \u2768quickbooks.intuit.com\u2769", "Invoice <quickbooks.intuit.com>", "\u034Fopens quickbooks.intuit.com \u2014 Invoice"]) {
    assert.equal(labelOf(fake), "Invoice", JSON.stringify(fake));
  }
  // a filename isn't a host; "opens" with no host after it is just a word
  for (const kept of ["Invoice (INV-4.pdf)", "Photos (IMG_2041.jpg)", "Estimate (Smith.xlsx)", "Plans (A1.dwg)", "opens Monday"]) {
    assert.equal(labelOf(kept), kept, kept);
  }
  // a label that claims no host shows exactly as written: its emoji, its final period, its fullwidth letters
  for (const kept of ["Paid in full.", "Crew \u{1F468}\u200D\u{1F527} photos", "\uFF29nvoice 4", "Invoice\u2026"]) {
    assert.equal(labelOf(kept), kept, JSON.stringify(kept));
  }
  // long runs of spaces, newlines or brackets: linear, so well under a second each
  for (const big of ["a" + " ".repeat(200000) + "b", "Invoice" + "\n".repeat(200000) + "INV-4", "(".repeat(100000) + "x.com" + ")".repeat(100000)]) {
    const t = performance.now();
    labelOf(big);
    assert.ok(performance.now() - t < 1000, `took ${Math.round(performance.now() - t)} ms`);
  }
});

test("a final answer beats a re-read that still says 'approved'; otherwise the re-read row wins", () => {
  const card = fromPending(reminder, LOOK);
  const done = (status, action) => decidedText(card, { ok: true, status, message: "m", ...(action ? { action } : {}) }, NOW);
  // the read raced the executed stamp: the send went out
  assert.equal(done("executed", { status: "approved", result: {} }).status, "executed");
  assert.equal(outcome(done("executed", { status: "approved", result: {} })).text, "Sent");
  assert.equal(done("declined", { status: "approved", result: {} }).status, "declined");
  assert.equal(done("failed", { status: "approved", result: { error: "gmail token expired" } }).status, "failed");
  assert.equal(outcome(done("failed", { status: "approved", result: { error: "gmail token expired" } })).text, "Failed: gmail token expired");
  // the re-read still wins when it is the final word
  assert.equal(done("failed", { status: "executed", result: {} }).status, "executed");
  assert.equal(done("executed", { status: "failed", result: { error: "x" } }).status, "failed");
  // no final answer to keep: the re-read stands
  assert.equal(done("approved", { status: "approved", result: {} }).status, "approved");
  assert.equal(done("executed").status, "executed", "an older function's body, no action");
  assert.equal(done("executed", { status: "weird", result: {} }).status, "executed");
});

test("a link's label loses its own trailing host-like brackets; the host the card prints is the real one", () => {
  assert.equal(labelOf("Invoice (quickbooks.intuit.com)"), "Invoice");
  assert.equal(labelOf("Invoice INV-4 (opens quickbooks.intuit.com/app/invoices)"), "Invoice INV-4");
  assert.equal(labelOf("Invoice [quickbooks.intuit.com]"), "Invoice");
  assert.equal(labelOf("Invoice (qb.intuit.com) (intuit.com)  "), "Invoice", "every trailing chunk");
  assert.equal(labelOf("Thread (gооgle.com)"), "Thread", "a look-alike host is host-like too");
  assert.equal(labelOf("Invoice (quickbooks\uFF0Eintuit\u3002com)"), "Invoice", "so is one with dots a browser reads as dots");
  assert.equal(labelOf("Invoice (https://quickbooks.intuit.com/x)"), "Invoice");
  for (const kept of ["Invoice (INV-4)", "Report (Oct 5)", "Hours (3.5 h)", "Call (e.g. Monday)", "Invoice (quickbooks.intuit.com) for Smith"]) {
    assert.equal(labelOf(kept), kept, kept);
  }
  const long = "Invoice (" + "a".repeat(350) + ".com)";
  assert.equal(labelOf(long), long, "a chunk longer than the 300 characters looked at is left alone");
  const refs = fromProposal({ ...email, evidence_refs: [
    { label: "Invoice (quickbooks.intuit.com)", url: "https://evil.example/pay" },
    { label: "(mail.google.com)", url: "https://evil.example/mail" },          // nothing left: the link stands in
    { label: "(mail.google.com)", type: "email", id: "77", url: "https://evil.example/m" },
    { label: "Not a link (quickbooks.intuit.com)" },                         // no link, no host printed: kept as written
    "https://evil.example/x (quickbooks.intuit.com)",
    { kind: "QuickBooks invoice", id: "(quickbooks.intuit.com)", url: "https://evil.example/k" },   // the kind/id fallback too
  ] }).evidence.refs;
  assert.deepEqual(refs.map((r) => [r.text, r.host]), [
    ["Invoice", "evil.example"],
    ["https://evil.example/mail", "evil.example"],
    ["email 77", "evil.example"],
    ["Not a link (quickbooks.intuit.com)", ""],
    ["https://evil.example/x", "evil.example"],
    ["QuickBooks invoice", "evil.example"],
  ]);
});

/* ---------- spine step 5 ---------- */

test("a spine card offers its YES number only while it waits; one with no number, or a decided one, offers none", () => {
  const box = inbox([], SPINE, LOOK, NOW);
  assert.equal(box.waiting.find((c) => c.id === email.id).yesHint, "or text YES 4");
  assert.equal(fromProposal({ ...email, sms_code: null }, LOOK).yesHint, "", "op_propose numbered nothing");
  assert.equal(fromProposal({ ...email, sms_code: null }, LOOK).code, null);
  for (const status of ["approved", "executing", "executed", "failed", "declined", "superseded", "expired"]) {
    // the number is free for reuse once the row stops being proposed
    assert.equal(fromProposal({ ...email, status }, LOOK).yesHint, "", status);
  }
  assert.equal(fromProposal({ ...stage, sms_code: 7 }, LOOK).yesHint, "or text YES 7", "every operation, not only email");
  assert.ok(!box.recent.some((c) => c.yesHint), "Recently decided never offers a number");
});

test("one number live on both queues: neither card offers it (roybal-notify answers code-clash); everything else keeps its hint", () => {
  const clashText = { ...reminder, code: 4 };                      // the spine email holds 4 too
  const box = inbox([clashText, phase], [email, { ...stage, sms_code: 9 }], LOOK, NOW);
  const hint = (id) => box.waiting.find((c) => c.id === id).yesHint;
  assert.deepEqual([hint(reminder.id), hint(email.id)], ["", ""]);
  assert.equal(hint(phase.id), "or text YES 13");
  assert.equal(hint(stage.id), "or text YES 9");
  assert.equal(box.waiting.find((c) => c.id === email.id).code, 4, "the card keeps its number; it just doesn't offer it");
  // a clash only counts among live rows: an expired text row on 4 is no clash
  const old = inbox([{ ...reminder, code: 4, expires_at: iso(-1) }], [email], LOOK, NOW);
  assert.equal(old.waiting.find((c) => c.id === email.id).yesHint, "or text YES 4");
  // two text rows on one number are left as they were (decidePending's own guard)
  const twin = inbox([reminder, { ...phase, code: 12 }], [], LOOK, NOW);
  assert.deepEqual(twin.waiting.map((c) => c.yesHint), ["or text YES 12", "or text YES 12"]);
});

test("a spine email's job is named from either table: the brief's and the adjuster's are field jobs; job.set_stage stays a board job", () => {
  const fieldMail = { ...email, job_id: FIELD1 };
  const c = fromProposal(fieldMail, LOOK);
  assert.deepEqual([c.jobTable, c.jobId, c.job], ["either", FIELD1, "Pollen, 1192 Bemis Ct"]);
  assert.deepEqual(needs([c]).field, [FIELD1]);
  assert.deepEqual(needs([c]).board, [FIELD1], "uuids don't collide, so asking both tables is safe");
  assert.equal(fromProposal({ ...email, job_id: BOARD1 }, LOOK).job, "Smith remodel", "a board job still names");
  const s = fromProposal(stage, LOOK);
  assert.equal(s.jobTable, "board");
  assert.deepEqual([needs([s]).field, needs([s]).board], [[], [BOARD1]]);
  assert.deepEqual(needs([fromProposal(queuedSms)]).field, [], "no job, nothing to read");
  // the text queue is as it was
  assert.deepEqual([fromPending(reminder).jobTable, fromPending(phase).jobTable], ["field", "board"]);
});

test("needs asks for the heartbeat only for a spine email that is waiting or was sent", () => {
  const lanes = (rows) => needs(inbox([], rows, {}, NOW).waiting.concat(inbox([], rows, {}, NOW).recent)).lanes;
  assert.deepEqual(lanes([email]), ["email"]);
  assert.deepEqual(lanes([delivered]), ["email"]);
  assert.deepEqual(lanes([declinedSpine]), [], "a declined email has nothing to wait for");
  assert.deepEqual(lanes([queuedSms, stage]), [], "texts and stage moves don't go by email");
  assert.deepEqual(needs([fromPending(reminder)]).lanes, [], "the text queue's email goes through gmail-proxy");
});

test("the newest heartbeat says whether the worker is sending email: fresh and listing email, or not; a read that won't read says nothing", () => {
  const beat = (mins, channels, extra = {}) => [{ at: new Date(NOW - mins * 60e3).toISOString(), meta: { channels, email: true, ...extra } }];
  assert.equal(HEARTBEAT_FRESH_MS, 10 * 60 * 1000);
  assert.equal(emailLaneOf(beat(0.5, ["sms", "email"]), NOW), true);
  assert.equal(emailLaneOf(beat(9.9, ["email"]), NOW), true);
  assert.equal(emailLaneOf(beat(0.5, ["sms"]), NOW), false, "production today: no Gmail pair on the worker");
  assert.equal(emailLaneOf(beat(10, ["sms", "email"]), NOW), false, "ten minutes of silence is a stopped worker");
  assert.equal(emailLaneOf(beat(300, ["sms", "email"]), NOW), false);
  assert.equal(emailLaneOf([], NOW), false, "no worker has ever beaten");
  assert.equal(emailLaneOf(beat(-1, ["email"]), NOW), true, "a clock a little behind the server's");
  // only the first row (the read is newest first) counts
  assert.equal(emailLaneOf([...beat(1, ["sms"]), ...beat(2, ["sms", "email"])], NOW), false);
  for (const junk of [null, undefined, {}, "x", [{ at: "nope", meta: { channels: ["email"] } }], [{ at: iso(0), meta: null }],
    [{ at: iso(0), meta: { channels: "email" } }], [null]]) {
    assert.equal(emailLaneOf(junk, NOW), null, JSON.stringify(junk));
  }
  assert.equal(lookFrom({ heartbeats: beat(1, ["sms"]), now: NOW }).emailLane, false);
  assert.equal(lookFrom({ heartbeats: beat(1, ["sms", "email"]), now: NOW }).emailLane, true);
  assert.equal(lookFrom({ heartbeats: null, now: NOW }).emailLane, null, "not read, or the read failed");
  // a prototype-named channel or key changes nothing
  assert.equal(emailLaneOf([{ at: iso(0), meta: { channels: ["__proto__", "constructor"] } }], NOW), false);
});

test("email sending off: a waiting email says approving queues it; an approved one in line or retrying says it waits; nothing else changes", () => {
  const off = lookFrom({ catalog: CATALOG, agents: [{ id: AGENT, name: "agent:brief" }], jobs: [{ id: FIELD1, customer: "Pollen" }],
    outbox: [{ proposal_id: delivered.id, status: "pending", created_at: iso(-4) }], heartbeats: [{ at: iso(-0.05), meta: { channels: ["sms"] } }], now: NOW });
  const on = { ...off, emailLane: true }, unknown = { ...off, emailLane: null };
  const w = fromProposal(email, off);
  assert.equal(w.emailLane, false);
  assert.equal(w.laneHint, LANE_OFF_WAITING);
  assert.equal(LANE_OFF_WAITING, "Email sending is off on the worker right now: approving queues this, and it waits until that's back.");
  assert.equal(approveConfirm(w), "Send this email to adjuster@carrier.com?", "the confirm is as it was");
  assert.equal(w.yesHint, "or text YES 4", "a text still answers it");
  for (const look of [on, unknown]) {
    assert.equal(fromProposal(email, look).laneHint, "", "sending, or can't tell: nothing new");
  }
  assert.equal(fromProposal(queuedSms, off).laneHint, "", "a text doesn't wait on email");
  assert.equal(fromProposal(queuedSms, off).emailLane, null);
  assert.equal(fromPending(reminder, off).laneHint, "", "the text queue sends through gmail-proxy");
  assert.equal(fromPending(reminder, off).emailLane, null);
  assert.equal(fromProposal({ ...email, status: "executed" }, off).laneHint, "", "only a waiting card carries the line");
  // approved (email.send runs inline, so 'executed' with an outbox row) and still in line
  const sent = (outbox, look = off) => outcome({ ...fromProposal({ ...delivered }, look), outbox }, NOW);
  assert.deepEqual(sent({ status: "pending" }), { text: LANE_OFF_QUEUED, tone: "wait" });
  assert.equal(LANE_OFF_QUEUED, "Queued, but email sending is off on the worker, so it waits until that's back");
  assert.deepEqual(sent({ status: "pending", next_attempt_at: iso(3) }), { text: LANE_OFF_QUEUED, tone: "wait" });
  assert.deepEqual(sent({ status: "failed", error: "Gmail API 503" }), { text: LANE_OFF_FAILED, tone: "wait" });
  assert.equal(LANE_OFF_FAILED, "Send failed, and email sending is off on the worker, so it waits until that's back");
  assert.deepEqual(sent(null), { text: LANE_OFF_QUEUED, tone: "wait" }, "just approved here: its outbox row isn't read yet");
  // what already happened still says so
  assert.deepEqual(sent({ status: "sent" }), { text: "Sent", tone: "ok" });
  assert.deepEqual(sent({ status: "sending" }), { text: "Sending", tone: "wait" });
  assert.deepEqual(sent({ status: "dead", error: "this email waited 50 hours in line, past the 48-hour limit (EMAIL_MAX_AGE_HOURS), so it was not sent. Send a fresh one if it should still go." }),
    { text: "Couldn't send: this email waited 50 hours in line, past the 48-hour limit (EMAIL_MAX_AGE_HOURS), so it was not sent. Send a fresh one if it should still go.", tone: "bad" });
  // sending, or can't tell: exactly as before
  for (const look of [on, unknown, {}]) {
    assert.equal(sent({ status: "pending" }, look).text, "Queued to send");
    assert.equal(sent({ status: "failed" }, look).text, "Send failed, retrying");
    assert.equal(sent(null, look).text, "Queued to send");
  }
  // a spine text with email off is untouched; a declined email too
  assert.equal(outcome({ ...fromProposal(queuedSms, off), outbox: { status: "pending" } }, NOW).text, "Queued to send");
  assert.equal(outcome(fromProposal(declinedSpine, off), NOW).text, "Declined: Already called them");
  assert.equal(outcome(fromProposal({ ...email, status: "approved" }, off), NOW).text, "Approved, queued to run");
});

test("an approve answered by the server lands with the lane wording the page knew, as the toast will say it", () => {
  const off = { ...LOOK, emailLane: false };
  const box = inbox([], [email], off, NOW);
  const card = box.waiting[0];
  const done = fromProposal({ ...email, status: "executed", approved_at: iso(0), approved_via: "inbox", result: { outbox_id: "o1" } }, off);
  const after = settle(box, card, done);
  assert.equal(outcome(after.recent[0], NOW).text, LANE_OFF_QUEUED);
  assert.equal(outcome(fromProposal({ ...email, status: "executed" }, LOOK), NOW).text, "Queued to send", "lane unknown: as before");
});
