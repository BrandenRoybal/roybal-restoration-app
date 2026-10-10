/* approvals.js — the office Approvals tab's pure logic (operations spine,
   step 4): both queues' rows as one card shape, waiting / recently decided /
   expired and their order, the names a page must look up, outcome lines,
   Alaska times, what each button sends, and the sentence for every answer
   roybal-notify decidePending and the spine RPCs can give. Then spine
   step 5: a waiting spine card's YES number (and none when one number is
   live on both queues), spine jobs named from either job table, and what
   the newest worker heartbeat says about email sending, on a waiting
   email and an approved one, in words that promise no more than the
   worker's 48 hours; and a send the worker gave up on after its card aged
   off shows again for 48 hours from when it did. Then the nightly billing
   check's invoice.review_gaps: its lines, total and hints as text (no rate
   on an unpriced line, which stays out of the total), every amount and the
   total counted as Postgres counts them (exact decimals, half away from
   zero, rounded once), the lines an edit kept, the confirm, the executor's
   three results, superseded as no longer needed or as closed when the
   check's findings changed, and no YES number (inbox only). Then the nightly
   QuickBooks match's receipts.qbo_link: one line per receipt (vendor, date,
   amount, the QuickBooks expense, what it gets), the project link a card
   suggests, the receipts an edit kept, the confirm, no YES number (inbox
   only), what came of it counted from its outbox rows (updated, waiting,
   refused or failed and why, in words from qbo-proxy's error codes), the
   worker's "qbo" channel off, and a change the worker gave up on after the
   card aged off coming back for 48 hours. Then 0025: a rental paid in two
   or three card charges as one line naming each, a second try and why the
   last one didn't go, a charge refused after another was tagged, and a
   change the office cancelled.
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
  qboLaneOf, QBO_OFF_WAITING, QBO_OFF_QUEUED,
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
  assert.deepEqual(inbox(null, undefined, {}, NOW), { waiting: [], recent: [], expired: 0, skipped: { text: 0, spine: 0 }, older: [] });
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
  // every row too, in the order read (a QuickBooks receipts card has one per receipt)
  assert.deepEqual(LOOK.outboxes[delivered.id].map((o) => o.status), ["delivered", "pending"]);
  assert.deepEqual(lookFrom(), { jobs: {}, ops: {}, people: {}, outbox: {}, outboxes: {}, emailLane: null, qboLane: null },
    "no heartbeat read: can't tell");
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
  assert.equal(LANE_OFF_WAITING, "Email sending is off on the worker right now: approving queues this, and it waits up to 48 hours for sending to come back, then it isn't sent.");
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
  assert.equal(LANE_OFF_QUEUED, "Queued, but email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent");
  assert.deepEqual(sent({ status: "pending", next_attempt_at: iso(3) }), { text: LANE_OFF_QUEUED, tone: "wait" });
  assert.deepEqual(sent({ status: "failed", error: "Gmail API 503" }), { text: LANE_OFF_FAILED, tone: "wait" });
  assert.equal(LANE_OFF_FAILED, "Send failed, and email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent");
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

test("a send the worker gave up on after its card aged off comes back to Recently decided for 48 hours from then", () => {
  // the brief's reminder, approved 60 h ago while sending was off; the worker came back 2 h ago and marked it dead
  const STALE = "this email waited 58 hours in line, past the 48-hour limit (EMAIL_MAX_AGE_HOURS), so it was not sent. Send a fresh one if it should still go.";
  const late = { ...email, id: "bbbbbbbb-0000-4000-8000-000000000009", job_id: FIELD1, status: "executed",
    created_at: iso(-61), expires_at: iso(-37), approved_at: iso(-60), updated_at: iso(-60) };
  const lateSms = { ...queuedSms, id: "bbbbbbbb-0000-4000-8000-00000000000a", created_at: iso(-80), expires_at: iso(-56), approved_at: iso(-79), updated_at: iso(-79) };
  const row = (p, status, at, extra = {}) => ({ proposal_id: p.id, status, created_at: iso(-60), updated_at: at, error: status === "dead" ? STALE : null, ...extra });
  const box = (outbox) => inbox([], [...SPINE, late, lateSms], lookFrom({ catalog: CATALOG, jobs: [{ id: FIELD1, customer: "Pollen" }], outbox, now: NOW }), NOW);

  // before the outbox is read (the page's first pass): off the list, but named in older, so its row is read
  const bare = inbox([], [...SPINE, late, lateSms], {}, NOW);
  assert.ok(!bare.recent.some((c) => c.id === late.id));
  assert.deepEqual(bare.older.map((c) => c.id).sort(), [late.id, lateSms.id].sort(), "answered sends past the 48 hours, nothing else");
  const n = needs(bare.older);
  assert.deepEqual(n.outbox.sort(), [late.id, lateSms.id].sort());
  assert.ok(n.field.includes(FIELD1), "and the names it would show with");

  // dead 2 h ago: back on the list, ordered by when it died, saying why
  const b = box([row(late, "dead", iso(-2)), row(lateSms, "dead", iso(-47.9), { error: "Twilio refused the number" })]);
  const c = b.recent.find((x) => x.id === late.id);
  assert.ok(c, "shown again");
  assert.equal(b.recent[0].id, late.id, "newest news first: it died after every other answer here");
  assert.equal(c.job, "Pollen");
  assert.deepEqual(outcome(c, NOW), { text: "Couldn't send: " + STALE, tone: "bad" });
  assert.equal(isRecent(c, NOW), true);
  assert.equal(isRecent(c, Date.parse(iso(45.9))), true);
  assert.equal(isRecent(c, Date.parse(iso(46.01))), false, "48 hours after it died it ages off like any other");
  assert.ok(b.recent.some((x) => x.id === lateSms.id), "a spine text the worker gave up on, the same way");
  assert.ok(!b.older.some((x) => x.id === late.id));
  // the rest of the list is as it was
  assert.deepEqual(b.recent.filter((x) => x.id !== late.id && x.id !== lateSms.id).map((x) => x.id),
    inbox([], SPINE, LOOK, NOW).recent.map((x) => x.id));

  // died more than 48 h ago, still in line (the worker is still down), or sent late: off the list
  for (const outbox of [[row(late, "dead", iso(-48.1))], [row(late, "pending", iso(-60))], [row(late, "failed", iso(-1))], [row(late, "sent", iso(-1))], []]) {
    assert.ok(!box(outbox).recent.some((x) => x.id === late.id), JSON.stringify(outbox));
  }
  // a row whose time won't read counts from the answer, and never takes the list down
  for (const at of [null, undefined, "", "nope", 1759780800000, { toString: 1 }, ["2026-10-06T16:00:00Z"]]) {
    assert.ok(!box([row(late, "dead", at)]).recent.some((x) => x.id === late.id), typeof at + " " + JSON.stringify(at));
  }
  // only an executed spine send: an outbox row beside anything else changes nothing
  const odd = lookFrom({ outbox: [{ proposal_id: declinedSpine.id, status: "dead", updated_at: iso(-1) }], now: NOW });
  assert.equal(isRecent(fromProposal({ ...declinedSpine, updated_at: iso(-60), expires_at: iso(-40) }, odd), NOW), false);
  // an answer inside the 48 hours whose row died earlier (clocks apart) still counts from the answer
  const d = fromProposal(delivered, lookFrom({ outbox: [row(delivered, "dead", iso(-50))], now: NOW }));
  assert.equal(isRecent(d, NOW), true);
  assert.equal(outcome(d, NOW).text, "Couldn't send: " + STALE);
});

/* ---------- the nightly billing check: invoice gaps ---------- */
const BILLING = "193d7dd0-74f9-407d-9891-8cb7aab22f82";          // agent:billing
const LIMITS = "Limits: an internal leak check, not carrier-grade justification. Prices come only from this job's own invoice lines; the rest are left unpriced.";
/* the input billing.reconcile files (contract K3), plus the fingerprint and the offer the filing door stamps */
const gapsInput = {
  job_id: FIELD1, findings_hash: "0123456789abcdef0123456789abcdef", base_rev: 41,
  rate_invoice_id: "inv-7f3a", rate_invoice_no: "1043", sent: true,
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
  hints: [
    { kind: "open_equipment_row", label: "1 equipment row has no removal date: counted to its last reading",
      refs: [{ kind: "equipment_row", id: "log-1#eq4", label: "Dehu D-4" }] },
    { kind: "photographed_not_logged", label: "Antimicrobial is in the photos but not on the invoice",
      refs: [{ kind: "photo", id: "ph-9", label: "antimicrobial (07-29)", date: "2026-07-29" }] },
  ],
  total_usd: 721.25, unpriced_count: 2, detector: "billing.reconcile@0.1", limits: LIMITS,
  invoice_fingerprint: "fedcba9876543210fedcba9876543210", offer: 0,
};
const gaps = {
  id: "bbbbbbbb-0000-4000-8000-00000000000b", operation: "invoice.review_gaps@1", action_type: "money", sms_code: 21,
  input: gapsInput, edited_params: null, proposed_by_kind: "agent", proposed_by_id: BILLING, proposed_via: "agent",
  rationale: "Add 4 lines ($721.25, 2 unpriced) to Pollen: dehu-days, labor hours, Cat 3 package\n" + LIMITS,
  evidence_refs: [{ kind: "invoice", id: "inv-7f3a", label: "Compared with 1 T&M invoice; newest is invoice 1043" }],
  job_id: FIELD1, status: "proposed", created_at: iso(-9), expires_at: iso(14 * 24 - 9), approved_at: null, updated_at: iso(-9),
  decline_reason: null, result: null, error: null,
};
const GAPS_LOOK = lookFrom({
  catalog: [...CATALOG, { name: "invoice.review_gaps", version: 1,
    description: "Add the lines the nightly billing check found documented but not billed. Execution appends one new draft invoice to the job." }],
  agents: [{ id: BILLING, name: "agent:billing" }],
  jobs: [{ id: FIELD1, title: null, customer: "Pollen", address: "1192 Bemis Ct" }],
});
/* the draft the executor writes takes the rate invoice's O&P and tax, which the
   card's figure (the lines alone) does not include: the total says so */
const OP_TAX = "; the new invoice adds this job's O&P and tax";
/* every string a card puts on screen: no null, undefined, NaN or [object …] */
const JUNK = /\bnull\b|\bundefined\b|NaN|\[object/;
function texts(c) {
  const e = c.evidence;
  return [c.title, c.chip, c.approveLabel, c.yesHint, c.job, c.by, approveConfirm(c), outcome(c, NOW).text, e.total, e.invoice,
    ...e.lines.flatMap((l) => [l.text, l.figures, l.basis, ...l.refs.map((r) => r.text)]),
    ...e.hints.flatMap((x) => [x.text, ...x.refs.map((r) => r.text)])];
}

test("invoice gaps: one card with every line's figures, the priced total, the hints, on its field job, from the billing agent, with no YES number", () => {
  const c = fromProposal(gaps, GAPS_LOOK);
  assert.deepEqual([c.lane, c.kind, c.chip, c.approveLabel], ["spine", "gaps", "Invoice gaps", "Approve and add lines"]);
  assert.equal(c.title, "Add the lines the nightly billing check found documented but not billed: 4 lines · $721.25 · 2 unpriced");
  assert.equal(c.code, 21, "op_propose numbered it");
  assert.equal(c.yesHint, "", "inbox only: roybal-notify never reads these rows");
  assert.deepEqual([c.jobTable, c.jobId, c.job, c.by], ["field", FIELD1, "Pollen, 1192 Bemis Ct", "Billing agent"]);
  const e = c.evidence;
  assert.deepEqual(e.lines.map((l) => [l.id, l.figures, l.priced]), [
    ["equip:dehu", "6 EA × $85.00 = $510.00", true],
    ["labor:hours", "3.25 HR × $65.00 = $211.25", true],
    ["cat3:containment", "no quantity · no rate", false],
    ["cat3:hepa_filter", "2 EA · no rate", false],
  ]);
  assert.equal(e.lines[2].text, "Containment Barrier/Airlock/Decon. Chamber (Basement)", "the room, when the line has one");
  assert.equal(e.lines[0].basis, "20 dehu-days documented from 6 unit rows; 14 billed on invoice 1043.");
  assert.deepEqual(e.lines[0].refs.map((r) => r.text), ["20 dehu-days from 6 unit rows, 07-28→08-04", "invoice 1043 line 3: 14 EA Dehumidifier @ $85.00"]);
  assert.deepEqual(e.lines[3].refs, []);
  // unpriced lines stay out of the total: qty × price of the priced ones, as the executor sums it
  assert.deepEqual([e.totalUsd, e.unpriced, e.total], [721.25, 2, "$721.25 + 2 lines with no rate (not in the total)" + OP_TAX]);
  assert.equal(e.invoice, "A new draft invoice, beside invoice 1043 (an invoice on this job has already gone out)");
  assert.equal(e.sent, true);
  assert.deepEqual(e.hints.map((x) => [x.text, x.refs.map((r) => r.text)]), [
    ["1 equipment row has no removal date: counted to its last reading", ["Dehu D-4"]],
    ["Antimicrobial is in the photos but not on the invoice", ["antimicrobial (07-29)"]],
  ]);
  assert.equal(e.rationale.split("\n")[0], "Add 4 lines ($721.25, 2 unpriced) to Pollen: dehu-days, labor hours, Cat 3 package");
  assert.deepEqual(e.refs.map((r) => r.text), ["Compared with 1 T&M invoice; newest is invoice 1043"]);
  // the page asks for the field job only, and the agent's name
  assert.deepEqual(needs([c]), { field: [FIELD1], board: [], agents: [BILLING], people: [], outbox: [], lanes: [] });
  // the catalog unreadable: the operation's name stands in; an unsent job, no invoice number
  assert.equal(fromProposal(gaps).title, "invoice.review_gaps: 4 lines · $721.25 · 2 unpriced");
  const quiet = fromProposal({ ...gaps, input: { ...gapsInput, sent: false, rate_invoice_no: "" } }, GAPS_LOOK).evidence;
  assert.equal(quiet.invoice, "A new draft invoice");
  // every other card carries the same fields, empty
  for (const other of [fromProposal(email, LOOK), fromPending(reminder, LOOK)]) {
    assert.deepEqual([other.evidence.lines, other.evidence.hints, other.evidence.total, other.evidence.unpriced], [[], [], "", 0]);
  }
  for (const t of texts(c)) assert.ok(!JUNK.test(t), t);
});

test("invoice gaps: the confirm names the lines, the priced total, the unpriced count and the job", () => {
  assert.equal(approveConfirm(fromProposal(gaps, GAPS_LOOK)), "Add 4 lines ($721.25, 2 unpriced) as a new draft invoice on Pollen, 1192 Bemis Ct?");
  assert.equal(approveConfirm(fromProposal(gaps)), "Add 4 lines ($721.25, 2 unpriced) as a new draft invoice on this job?", "a job the lookup missed");
  const priced = { ...gapsInput, lines: gapsInput.lines.slice(0, 1), total_usd: 510, unpriced_count: 0 };
  const one = fromProposal({ ...gaps, input: priced }, GAPS_LOOK);
  assert.equal(approveConfirm(one), "Add 1 line ($510.00) as a new draft invoice on Pollen, 1192 Bemis Ct?", "nothing unpriced: no count");
  assert.equal(one.title, "Add the lines the nightly billing check found documented but not billed: 1 line · $510.00");
  assert.equal(one.evidence.total, "$510.00" + OP_TAX);
  const big = fromProposal({ ...gaps, input: { ...priced, lines: [{ ...priced.lines[0], qty: 412, price: 12.5 }] } }, GAPS_LOOK);
  assert.equal(big.evidence.lines[0].figures, "412 EA × $12.50 = $5,150.00");
  assert.equal(approveConfirm(big), "Add 1 line ($5,150.00) as a new draft invoice on Pollen, 1192 Bemis Ct?");
});

test("invoice gaps: every amount and the total count as Postgres counts them: exact decimals, half away from zero, rounded once", () => {
  const card = (...lines) => fromProposal({ ...gaps, input: { ...gapsInput, lines } }, GAPS_LOOK);
  const line = (finding_id, qty, price, unit = "EA") => ({ finding_id, desc: "Line", qty, unit, price });
  // every total names the O&P and tax the new invoice adds; the figure before it is the lines alone
  const read = (c) => { assert.ok(c.evidence.total.endsWith(OP_TAX), c.evidence.total);
    return [c.evidence.lines.map((l) => l.figures), c.evidence.totalUsd, c.evidence.total.slice(0, -OP_TAX.length)]; };
  // round(0.25 * 12.34, 2) is 3.09 and round(1.005, 2) is 1.01; binary floats make the second 1.00
  assert.deepEqual(read(card(line("a", 0.25, 12.34, "HR"))), [["0.25 HR × $12.34 = $3.09"], 3.09, "$3.09"]);
  assert.deepEqual(read(card(line("a", 1, 1.005))), [["1 EA × $1.005 = $1.01"], 1.01, "$1.01"]);
  // products exact: 0.5 × 2.01 is 1.005 (1.00499… as a float), 3 × 1.115 is 3.345 (3.3449999… as a float)
  assert.deepEqual(read(card(line("a", 0.5, 2.01))), [["0.5 EA × $2.01 = $1.01"], 1.01, "$1.01"]);
  assert.deepEqual(read(card(line("a", 3, 1.115))), [["3 EA × $1.115 = $3.35"], 3.35, "$3.35"]);
  // the total is the exact sum rounded once, as the executor's round(sum(qty * price), 2) and the
  // invoice editor's line total count it: 3.085 + 1.005 is $4.09, not $3.09 + $1.01
  const two = card(line("a", 0.25, 12.34, "HR"), line("b", 1, 1.005));
  assert.deepEqual(read(two), [["0.25 HR × $12.34 = $3.09", "1 EA × $1.005 = $1.01"], 4.09, "$4.09"]);
  assert.equal(two.title, "Add the lines the nightly billing check found documented but not billed: 2 lines · $4.09");
  assert.equal(approveConfirm(two), "Add 2 lines ($4.09) as a new draft invoice on Pollen, 1192 Bemis Ct?");
  // half away from zero, not half up: a credit (the executor refuses one; the card still counts it right)
  assert.deepEqual(read(card(line("a", 1, -0.125))), [["1 EA × -$0.125 = -$0.13"], -0.13, "-$0.13"]);
  // a quantity and a rate show as written (to 4 places), so each line's arithmetic reads true
  assert.deepEqual(read(card(line("a", 1.005, 2, "DA"))), [["1.005 DA × $2.00 = $2.01"], 2.01, "$2.01"]);
  assert.deepEqual(read(card({ finding_id: "a", desc: "Line", qty: null, unit: "SF", price: 0.125 })),
    [["no quantity · $0.125 per SF"], 0, "$0.00"]);
});

test("invoice gaps: an edit can only drop lines, and the card shows the kept lines as the proposal holds them (the executor's rule)", () => {
  const c = fromProposal({ ...gaps, edited_params: { lines: [{ finding_id: "labor:hours", qty: 99, price: 1000 }, { finding_id: "cat3:nope" }] } }, GAPS_LOOK);
  assert.deepEqual(c.evidence.lines.map((l) => [l.id, l.figures]), [["labor:hours", "3.25 HR × $65.00 = $211.25"]], "its own content, not the edit's");
  assert.deepEqual([c.evidence.total, c.evidence.unpriced], ["$211.25" + OP_TAX, 0]);
  assert.equal(c.title, "Add the lines the nightly billing check found documented but not billed: 1 line · $211.25");
  assert.equal(approveConfirm(c), "Add 1 line ($211.25) as a new draft invoice on Pollen, 1192 Bemis Ct?");
  assert.equal(c.evidence.hints.length, 2, "hints are the proposal's, whatever the edit");
  // an edit that names no lines keeps them all
  assert.equal(fromProposal({ ...gaps, edited_params: { total_usd: 1 } }, GAPS_LOOK).evidence.lines.length, 4);
});

test("invoice gaps: what came of it, from the executor's result; superseded with no gaps left is no longer needed, and with other findings closed", () => {
  const c = fromProposal(gaps, GAPS_LOOK);
  const at = (status, result, error = null) =>
    outcome(fromProposal({ ...gaps, status, approved_at: iso(-1), updated_at: iso(-1), result, error }, GAPS_LOOK), NOW);
  const added = { status: "added", invoice_id: "5d41402a-bc4b-2a76-b971-9d911017c592", lines_added: 4, total_usd: 721.25, unpriced: 2, rev: 42 };
  assert.deepEqual(at("executed", added), { text: "Added 4 lines on a new draft invoice", tone: "ok" });
  assert.deepEqual(at("executed", { ...added, lines_added: 1 }), { text: "Added 1 line on a new draft invoice", tone: "ok" });
  assert.equal(at("executed", { ...added, lines_added: "x" }).text, "Added 4 lines on a new draft invoice", "a count that won't read: the card's lines");
  assert.deepEqual(at("executed", { status: "already_present", lines_added: 0 }), { text: "Already on the job", tone: "ok" });
  assert.deepEqual(at("executed", { status: "deleted_by_office", lines_added: 0 }), { text: "The office deleted that invoice; nothing re-added", tone: "no" });
  assert.deepEqual(at("executed", null), { text: "Done", tone: "ok" }, "a result that says nothing");
  assert.deepEqual(at("failed", null, "invoice.review_gaps: the job's invoices changed since this was proposed, so nothing was added; the nightly check files a fresh card if the work is still unbilled and the job is still one it checks (not archived, not every invoice paid)"),
    { text: "Failed: invoice.review_gaps: the job's invoices changed since this was proposed, so nothing was added; the nightly check files a fresh card if the work is still unbilled and the job is still one it checks (not archived, not every invoice paid)", tone: "bad" });
  assert.deepEqual(at("superseded", { superseded_reason: "no_gaps" }), { text: "No longer needed: the invoice covers it", tone: "no" });
  // billing_review_gaps_file's quiet night: the owner already answered tonight's findings, and this card holds others
  assert.deepEqual(at("superseded", { superseded_reason: "findings_changed" }), { text: "Closed: the nightly check's findings changed", tone: "no" });
  assert.deepEqual(at("superseded", { superseded_by: "bbbbbbbb-0000-4000-8000-00000000000c" }), { text: "Replaced by a newer ask", tone: "no" });
  assert.deepEqual(at("approved", null), { text: "Approved, queued to run", tone: "wait" });
  assert.equal(outcome({ ...c, status: "declined", evidence: { ...c.evidence, reason: "Billed it by hand" } }).text, "Declined: Billed it by hand");
  // the approve answer is the executed row (runtime sql runs inside op_proposal_approve): it lands as that outcome
  const box = inbox([], [gaps], GAPS_LOOK, NOW);
  const after = settle(box, box.waiting[0], fromProposal({ ...gaps, status: "executed", approved_at: iso(0), updated_at: iso(0), result: added }, GAPS_LOOK));
  assert.equal(outcome(after.recent[0], NOW).text, "Added 4 lines on a new draft invoice");
  assert.equal(after.recent[0].yesHint, "");
});

test("invoice gaps: a number it holds is never offered, so a text-queue ask on the same number keeps its hint", () => {
  const box = inbox([{ ...reminder, code: 21 }], [gaps], GAPS_LOOK, NOW);
  assert.deepEqual(box.waiting.map((c) => [c.kind, c.yesHint]), [["email", "or text YES 21"], ["gaps", ""]]);
  assert.equal(box.waiting.find((c) => c.kind === "gaps").code, 21, "the card keeps its number; it just doesn't offer it");
});

test("invoice gaps: a line or hint of any odd shape still reads as words, never null, undefined or NaN", () => {
  const odd = fromProposal({ ...gaps, input: { ...gapsInput, rate_invoice_no: null, sent: "yes",
    lines: [
      { finding_id: "equip:dehu", desc: "", qty: "6", unit: "", price: "85" },                // strings, no desc, no unit
      { finding_id: "equip:air_mover", desc: "Air mover", qty: NaN, unit: "EA", price: Infinity },
      { finding_id: "labor:hours", desc: "Tech", qty: null, unit: "HR", price: 65 },            // a rate but no quantity
      null, "x", 7, [],
      { finding_id: "equip:heater", desc: "Heater", qty: 0.1 + 0.2, unit: "DA", price: 100, refs: "nope" },
    ],
    hints: [{ kind: "labor_no_window", label: "" }, { kind: "", label: "" }, null, { label: "Mind the gap", refs: [{}, null, { label: "Log" }] }] } }, GAPS_LOOK);
  const e = odd.evidence;
  assert.deepEqual(e.lines.map((l) => [l.text, l.figures]), [
    ["A line", "no quantity · no rate"],
    ["Air mover", "no quantity · no rate"],
    ["Tech", "no quantity · $65.00 per HR"],
    ["A line", "no quantity · no rate"], ["A line", "no quantity · no rate"], ["A line", "no quantity · no rate"], ["A line", "no quantity · no rate"],
    ["Heater", "0.3 DA × $100.00 = $30.00"],
  ]);
  assert.deepEqual([e.totalUsd, e.unpriced], [30, 6], "the rate-only line is priced but has no amount: like the executor, it adds nothing");
  assert.deepEqual(e.hints.map((x) => x.text), ["Labor no window", "Mind the gap"]);
  assert.deepEqual(e.hints[1].refs.map((r) => r.text), ["Log"]);
  assert.equal(e.invoice, "A new draft invoice", "only sent: true says it went out");
  for (const t of texts(odd)) assert.ok(!JUNK.test(t), t);
  // no lines at all, or no input: still a card, and still words
  for (const input of [{ ...gapsInput, lines: "none", hints: {} }, null]) {
    const c = fromProposal({ ...gaps, input }, GAPS_LOOK);
    assert.deepEqual([c.evidence.lines, c.evidence.total], [[], "$0.00" + OP_TAX]);
    assert.equal(approveConfirm(c), "Add 0 lines ($0.00) as a new draft invoice on Pollen, 1192 Bemis Ct?");
    for (const t of texts(c)) assert.ok(!JUNK.test(t), t);
  }
});

/* ---------- the nightly QuickBooks match: receipts.qbo_link ---------- */
const INTEGRATIONS = "5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10";      // agent:integrations (0023's fixed id)
const ALSTON = "a628eea5-5c1e-4b7a-9d2f-3e8c1b0a7f42";              // "2156 Alston rd."
const sha = (c) => "media:" + c.repeat(64) + ":184211";
const CITI = "3176 - Citi - Home Depot Consumer Credit Card";
/* the Oct 7 read: two Citi Home Depot bank-rule expenses with no job tag, no
   ref number and no photo; the job's Spenard expense was already tagged to
   Pollen Apartments, so the matcher suggests linking the job to it */
const hd = { receipt_id: "r-1369", vendor: "Home Depot", date: "2026-09-30", amount: 1369.5, receipt_no: "1303 00001 50615",
  qbo_txn_type: "Purchase", qbo_txn_id: "10577", qbo_sync_token: "0", qbo_doc_number: "", qbo_account_name: CITI, qbo_total: 1369.5,
  changes: ["tag", "attach"], photo_refs: [sha("a")], project_ref: "412739523" };
const hd2 = { ...hd, receipt_id: "r-6788", date: "2026-09-24", amount: 67.88, receipt_no: "1303 00001 49377",
  qbo_txn_id: "10519", qbo_sync_token: "1", qbo_total: 67.88, photo_refs: [sha("b")] };
const qboInput = {
  job_id: ALSTON, job_name: "2156 Alston rd.", receipts_fingerprint: "0123456789abcdef0123456789abcdef",
  items_hash: "fedcba9876543210fedcba9876543210", offer: 0, qbo_customer_id: "112", qbo_name: "Pollen Apartments",
  link: { qbo_customer_id: "112", qbo_name: "Pollen Apartments", qbo_project_ref: "412739523", source: "suggested_tagged",
    why: "1 of this job's receipts matches a QuickBooks expense already tagged to Pollen Apartments" },
  items: [hd2, hd], total_usd: 1437.38, matcher: "receipts.qbo_match@1",
};
const qboCard = {
  id: "bbbbbbbb-0000-4000-8000-0000000000c1", operation: "receipts.qbo_link@1", action_type: "money", sms_code: 22,
  input: qboInput, edited_params: null, proposed_by_kind: "agent", proposed_by_id: INTEGRATIONS, proposed_via: "agent",
  rationale: "2 receipts on 2156 Alston rd. match QuickBooks expenses that have no job tag or photo.", evidence_refs: [],
  job_id: ALSTON, status: "proposed", created_at: iso(-9), expires_at: iso(14 * 24 - 9), approved_at: null, updated_at: iso(-9),
  decline_reason: null, result: null, error: null,
};
const QBO_DESC = "Update QuickBooks for this job's receipts. Execution queues one QuickBooks change per receipt: tag the matching expense to the job's QuickBooks project and attach the receipt photo; it never edits a tag already set and it refuses if the receipts changed since the card was filed.";
const qboLook = (o = {}) => lookFrom({
  catalog: [...CATALOG, { name: "receipts.qbo_link", version: 1, description: QBO_DESC }],
  agents: [{ id: INTEGRATIONS, name: "agent:integrations" }],
  jobs: [{ id: ALSTON, title: "2156 Alston rd.", customer: "Pollen", address: "2156 Alston Rd" }], now: NOW, ...o });
const QBO_LOOK = qboLook();
const HD_LINE = `Home Depot · Sep 30 · $1,369.50 → QuickBooks expense 10577 (${CITI}): tag to Pollen Apartments, attach the photo`;
const HD2_LINE = `Home Depot · Sep 24 · $67.88 → QuickBooks expense 10519 (${CITI}): tag to Pollen Apartments, attach the photo`;
/* every string a QuickBooks card puts on screen */
const qboTexts = (c) => [c.title, c.chip, c.approveLabel, c.yesHint, c.job, c.by, c.laneHint, approveConfirm(c), outcome(c, NOW).text,
  c.evidence.link, ...c.evidence.receipts.map((x) => x.text)];

test("QuickBooks receipts: one card per job, a line per receipt saying what its expense gets, the project link it suggests, from the integrations agent, with no YES number", () => {
  const c = fromProposal(qboCard, QBO_LOOK);
  assert.deepEqual([c.lane, c.kind, c.chip, c.approveLabel], ["spine", "qbo", "QuickBooks", "Approve: update QuickBooks"]);
  assert.equal(c.title, "Update QuickBooks for this job's receipts: 2156 Alston rd.: 2 receipts");
  assert.equal(c.code, 22, "op_propose numbered it");
  assert.equal(c.yesHint, "", "inbox only: roybal-notify never reads these rows");
  assert.deepEqual([c.jobTable, c.jobId, c.job, c.by], ["field", ALSTON, "2156 Alston rd.", "Integrations agent"]);
  assert.deepEqual(c.evidence.receipts, [{ id: "r-6788", text: HD2_LINE }, { id: "r-1369", text: HD_LINE }], "in card order");
  assert.equal(c.evidence.link, "Links this job to QuickBooks project Pollen Apartments: 1 of this job's receipts matches a QuickBooks expense already tagged to Pollen Apartments");
  assert.equal(c.evidence.rationale, qboCard.rationale);
  assert.deepEqual(c.evidence.refs, [], "photos are media markers, not links");
  assert.equal(c.laneHint, "", "no heartbeat read: nothing to say");
  // the page asks for the field job, the agent's name and the worker's heartbeat (is it serving "qbo")
  assert.deepEqual(needs([c]), { field: [ALSTON], board: [], agents: [INTEGRATIONS], people: [], outbox: [], lanes: ["qbo"] });
  // a job already linked: no link line, and the tag names its project
  const linked = fromProposal({ ...qboCard, input: { ...qboInput, link: undefined, qbo_name: "Bemis Ct" } }, QBO_LOOK);
  assert.equal(linked.evidence.link, "");
  assert.match(linked.evidence.receipts[0].text, /: tag to Bemis Ct, attach the photo$/);
  // the catalog unreadable: the operation's name stands in; the job lookup missed: the matcher's job name
  const bare = fromProposal(qboCard);
  assert.equal(bare.title, "receipts.qbo_link: 2156 Alston rd.: 2 receipts");
  assert.equal(bare.job, "2156 Alston rd.");
  assert.equal(fromProposal(qboCard, qboLook({ jobs: [{ id: ALSTON, customer: "Pollen", address: "2156 Alston Rd" }] })).job,
    "Pollen, 2156 Alston Rd", "the looked-up name wins on the meta line");
  // every other card carries the same fields, empty
  for (const other of [fromProposal(email, LOOK), fromPending(reminder, LOOK), fromProposal(gaps, GAPS_LOOK)]) {
    assert.deepEqual([other.evidence.receipts, other.evidence.link, other.outboxes, other.qboLane], [[], "", [], null]);
  }
  for (const t of qboTexts(c)) assert.ok(!JUNK.test(t), t);
});

test("QuickBooks receipts: attach-only, a store invoice the app enters, a return and several photos each read as words", () => {
  const spenard = { ...hd, receipt_id: "r-sbs", vendor: "Spenard", date: "2026-09-28", amount: 212.28, receipt_no: "700624817",
    qbo_txn_id: "10563", qbo_doc_number: "700624817", qbo_account_name: "SBS Store Credit", qbo_total: 212.28, changes: ["attach"] };
  const sherwin = { receipt_id: "r-sw", vendor: "Sherwin", date: "2026-10-02", amount: 11.13, receipt_no: "8230-1", qbo_txn_type: "Purchase",
    qbo_txn_id: "", qbo_sync_token: "", qbo_doc_number: "82301", qbo_account_name: "Sherwin Store Credit", qbo_total: null,
    changes: ["create", "attach"], photo_refs: [sha("c")], project_ref: "412739523",
    create: { account_id: "52", vendor_id: "9", payment_type: "CreditCard", credit: false, doc_number: "82301", expense_account_id: "42",
      class_id: "1000000001", txn_date: "2026-10-02", amount_abs: 11.13, memo: "Sherwin 8230-1 (from the job receipts app)" } };
  const back = { ...hd, receipt_id: "r-ret", date: "2026-10-01", amount: -45.06, qbo_txn_id: "10614", qbo_total: 45.06,
    changes: ["tag"], photo_refs: [] };
  const pages = { ...hd, receipt_id: "r-pages", photo_refs: [sha("d"), sha("e")], changes: ["attach"] };
  const c = fromProposal({ ...qboCard, input: { ...qboInput, items: [spenard, sherwin, back, pages] } }, QBO_LOOK);
  assert.deepEqual(c.evidence.receipts.map((x) => x.text), [
    "Spenard · Sep 28 · $212.28 → QuickBooks expense 10563 (ref 700624817, SBS Store Credit): attach the photo",
    "Sherwin · Oct 2 · $11.13 → a new QuickBooks expense on Sherwin Store Credit (ref 82301): enter it, tagged to Pollen Apartments, attach the photo",
    `Home Depot · Oct 1 · -$45.06 (return) → QuickBooks expense 10614 (${CITI}): tag to Pollen Apartments`,
    `Home Depot · Sep 30 · $1,369.50 → QuickBooks expense 10577 (${CITI}): attach the 2 photos`,
  ]);
  assert.equal(c.title, "Update QuickBooks for this job's receipts: 2156 Alston rd.: 4 receipts");
  assert.equal(approveConfirm(c), "Update QuickBooks for 4 receipts on 2156 Alston rd.?");
});

test("QuickBooks receipts: the confirm names how many receipts and the job", () => {
  assert.equal(approveConfirm(fromProposal(qboCard, QBO_LOOK)), "Update QuickBooks for 2 receipts on 2156 Alston rd.?");
  const one = fromProposal({ ...qboCard, input: { ...qboInput, items: [hd] } }, QBO_LOOK);
  assert.equal(approveConfirm(one), "Update QuickBooks for 1 receipt on 2156 Alston rd.?");
  assert.equal(one.title, "Update QuickBooks for this job's receipts: 2156 Alston rd.: 1 receipt");
  const nameless = fromProposal({ ...qboCard, input: { ...qboInput, job_name: "" } });
  assert.equal(approveConfirm(nameless), "Update QuickBooks for 2 receipts on this job?", "no name anywhere");
  assert.equal(nameless.title, "receipts.qbo_link: 2 receipts");
});

test("QuickBooks receipts: an edit can only drop receipts, and the card shows the kept ones as the proposal holds them (the executor's rule)", () => {
  const c = fromProposal({ ...qboCard, edited_params: { items: [{ ...hd, amount: 1, qbo_txn_id: "99999" }, { receipt_id: "r-nope" }] } }, QBO_LOOK);
  assert.deepEqual(c.evidence.receipts, [{ id: "r-1369", text: HD_LINE }], "its own content, not the edit's");
  assert.equal(approveConfirm(c), "Update QuickBooks for 1 receipt on 2156 Alston rd.?");
  assert.equal(fromProposal({ ...qboCard, edited_params: { total_usd: 1 } }, QBO_LOOK).evidence.receipts.length, 2, "an edit naming no items keeps them all");
});

test("QuickBooks receipts: what came of it is counted from its outbox rows, refusals in plain words from qbo-proxy's codes", () => {
  const ran = { queued: 3, skipped: 0, outbox_ids: ["o1", "o2", "o3"] };
  const executed = { ...qboCard, status: "executed", approved_at: iso(-2), updated_at: iso(-2), result: ran,
    input: { ...qboInput, items: [hd2, hd, { ...hd, receipt_id: "r-2790", amount: 27.9, qbo_txn_id: "10584", qbo_total: 27.9 }] } };
  // the outbox rows as the page reads them: all of this proposal's, one per receipt
  const row = (status, error = null) => ({ proposal_id: executed.id, status, error, next_attempt_at: iso(-2), created_at: iso(-2), updated_at: iso(-1) });
  const TAGGED = "tagged_other: expense 10584 is already tagged to Bemis Ct in QuickBooks";
  const at = (rows, o = {}) => outcome(fromProposal({ ...executed, ...o }, qboLook({ outbox: rows })), NOW);
  assert.deepEqual(at([row("sent"), row("sent"), row("sent")]), { text: "All 3 updated in QuickBooks", tone: "ok" });
  assert.deepEqual(at([row("sent"), row("sent"), row("dead", TAGGED)]),
    { text: "2 of 3 updated in QuickBooks; 1 refused: tagged to another job", tone: "bad" }, "the design's own example");
  assert.deepEqual(at([row("sent"), row("pending"), row("failed", "qbo_throttled: QuickBooks is throttling: 429")]),
    { text: "1 of 3 updated in QuickBooks; 2 waiting", tone: "wait" }, "between retries is still waiting");
  assert.deepEqual(at([row("pending"), row("sending"), row("pending")]), { text: "3 queued for QuickBooks", tone: "wait" });
  assert.deepEqual(at([row("dead", TAGGED), row("dead", "photo_missing: the receipt photo (page 1) is no longer in storage"),
    row("dead", "qbo_unavailable: QuickBooks 503: Service Unavailable")]),
  { text: "None of 3 updated in QuickBooks; 2 refused: tagged to another job, the receipt photo is missing; 1 failed: QuickBooks was down", tone: "bad" });
  assert.deepEqual(at([row("dead", TAGGED), row("dead", TAGGED), row("sent")]),
    { text: "1 of 3 updated in QuickBooks; 2 refused: tagged to another job", tone: "bad" }, "one reason said once");
  // every code qbo-proxy's completePurchase answers with reads as words
  const words = {
    tagged_other: "tagged to another job", partly_tagged: "only partly tagged to this job", untaggable: "the expense has no lines to tag",
    untaggable_line: "a line QuickBooks can't tag to a job", changed_in_qbo: "changed in QuickBooks since the card was filed",
    purchase_missing: "the expense is gone from QuickBooks", photo_missing: "the receipt photo is missing",
    photo_type: "the photo isn't a JPEG, PNG or PDF", photo_unreadable: "the photo couldn't be read", photo_too_big: "the photo is over 20 MB",
    upload_refused: "QuickBooks refused the photo", qbo_refused: "QuickBooks refused the change", bad_request: "the app sent QuickBooks a bad request",
    stale_object: "the expense kept changing in QuickBooks", qbo_not_connected: "QuickBooks isn't connected", qbo_throttled: "QuickBooks was too busy",
    qbo_unavailable: "QuickBooks was down", qbo_unreachable: "couldn't reach QuickBooks", storage_unavailable: "couldn't read the photo from storage",
    create_unclear: "QuickBooks didn't confirm the new expense", upload_unclear: "QuickBooks didn't confirm the photo",
    relinked: "the job's QuickBooks project changed after approval", link_unreadable: "couldn't read the job's QuickBooks link",
  };
  const one = (error) => outcome(fromProposal({ ...executed, result: { queued: 1, skipped: 0 }, input: { ...qboInput, items: [hd] } },
    qboLook({ outbox: [row("dead", error)] })), NOW);
  for (const [code, said] of Object.entries(words)) {
    assert.deepEqual(one(`${code}: what qbo-proxy said`), { text: "Not updated in QuickBooks: " + said, tone: "bad" }, code);
  }
  // an error that isn't a code: as written, clipped; none at all says so
  assert.equal(one("qbo-proxy unreachable: fetch failed").text, "Not updated in QuickBooks: qbo-proxy unreachable: fetch failed");
  assert.equal(one("x".repeat(300)).text, "Not updated in QuickBooks: " + "x".repeat(119) + "…");
  assert.equal(one(null).text, "Not updated in QuickBooks: no reason given");
  assert.equal(one("constructor: nope").text, "Not updated in QuickBooks: constructor: nope", "a prototype name is no code");
  // one receipt, done
  assert.deepEqual(outcome(fromProposal({ ...executed, result: { queued: 1 }, input: { ...qboInput, items: [hd] } },
    qboLook({ outbox: [row("sent")] })), NOW), { text: "Updated in QuickBooks", tone: "ok" });
});

test("QuickBooks receipts: a photo QuickBooks refused after the tag went in reads as tagged, photo not attached, never 'Not updated'", () => {
  const executed = { ...qboCard, status: "executed", approved_at: iso(-2), updated_at: iso(-2), result: { queued: 3, skipped: 0 },
    input: { ...qboInput, items: [hd2, hd, { ...hd, receipt_id: "r-2790", amount: 27.9, qbo_txn_id: "10584", qbo_total: 27.9 }] } };
  const row = (status, provider_status = null, error = null) => ({ proposal_id: executed.id, status, error, provider_status,
    next_attempt_at: iso(-2), created_at: iso(-2), updated_at: iso(-1) });
  const SENT = "tagged=done;attached=1";
  const at = (rows, o = {}) => outcome(fromProposal({ ...executed, ...o }, qboLook({ outbox: rows })), NOW);
  const one = at([row("sent", "tagged=done;attached=0;attach_error=qbo_refused")],
    { result: { queued: 1 }, input: { ...qboInput, items: [hd] } });
  assert.deepEqual(one, { text: "Tagged in QuickBooks; photo not attached: QuickBooks refused the photo", tone: "bad" });
  assert.deepEqual(at([row("sent", "tagged=done;attached=0;attach_error=upload_refused"), row("sent", SENT), row("sent", SENT)]),
    { text: "All 3 updated in QuickBooks; 1 photo not attached: QuickBooks refused the photo", tone: "bad" });
  assert.deepEqual(at([row("sent", "tagged=done;attached=0;attach_error=photo_type"), row("pending"),
    row("dead", null, "tagged_other: expense 10584 is already tagged to Bemis Ct in QuickBooks")]),
  { text: "1 of 3 updated in QuickBooks; 1 photo not attached: the photo isn't a JPEG, PNG or PDF; 1 waiting; 1 refused: tagged to another job", tone: "bad" });
  // a sent row whose photo went, or that had none to send, is just updated
  assert.deepEqual(at([row("sent", SENT), row("sent", "tagged=adopted;attached=0;already_attached=true"), row("sent")]),
    { text: "All 3 updated in QuickBooks", tone: "ok" });
});

test("QuickBooks receipts: the QuickBooks vendor rides on the line, so a vendor that isn't the receipt's shows before approving", () => {
  const fred = { ...hd, qbo_vendor_name: "Fred Meyer" };
  const c = fromProposal({ ...qboCard, input: { ...qboInput, items: [fred] } }, QBO_LOOK);
  assert.deepEqual(c.evidence.receipts.map((r) => r.text),
    [`Home Depot · Sep 30 · $1,369.50 → QuickBooks expense 10577 (Fred Meyer, ${CITI}): tag to Pollen Apartments, attach the photo`]);
});

test("QuickBooks receipts: just approved (rows not read yet) it says what the executor queued; the rest of its fate reads like any spine card's", () => {
  const box = inbox([], [qboCard], QBO_LOOK, NOW);
  const ran = { ...qboCard, status: "executed", approved_at: iso(0), approved_via: "inbox", updated_at: iso(0),
    result: { queued: 2, skipped: 0, outbox_ids: ["5d41402a-bc4b-4a76-b971-9d911017c592", "7d41402a-bc4b-4a76-b971-9d911017c592"] } };
  const after = settle(box, box.waiting[0], fromProposal(ran, QBO_LOOK));
  assert.deepEqual(outcome(after.recent[0], NOW), { text: "2 queued for QuickBooks", tone: "wait" });
  assert.equal(after.recent[0].yesHint, "");
  // once read, the page asks for its rows
  assert.deepEqual(needs(after.recent).outbox, [qboCard.id]);
  // every receipt already on its way from an earlier card: the executor skipped them all
  assert.deepEqual(outcome(fromProposal({ ...ran, result: { queued: 0, skipped: 2, outbox_ids: [] } }, QBO_LOOK), NOW),
    { text: "Already on its way to QuickBooks from an earlier card", tone: "ok" });
  assert.deepEqual(outcome(fromProposal({ ...ran, result: null }, QBO_LOOK), NOW), { text: "Queued for QuickBooks", tone: "wait" });
  const at = (status, result, error = null) =>
    outcome(fromProposal({ ...qboCard, status, approved_at: iso(-1), updated_at: iso(-1), result, error }, QBO_LOOK), NOW);
  const MOVED = "receipts.qbo_link: the receipts changed since this card was filed, so nothing was queued; tonight's match files a fresh card if QuickBooks still needs the change";
  assert.deepEqual(at("failed", null, MOVED), { text: "Failed: " + MOVED, tone: "bad" });
  // receipts_qbo_link_file's reasons
  assert.deepEqual(at("superseded", { superseded_reason: "nothing_to_do" }), { text: "No longer needed: QuickBooks has what it needs", tone: "no" });
  assert.deepEqual(at("superseded", { superseded_reason: "items_changed" }), { text: "Closed: the nightly QuickBooks match's findings changed", tone: "no" });
  assert.deepEqual(at("superseded", { superseded_by: "bbbbbbbb-0000-4000-8000-0000000000c2" }), { text: "Replaced by a newer ask", tone: "no" });
  assert.equal(outcome(fromProposal({ ...qboCard, status: "declined", decline_reason: "I'll tag these by hand" }, QBO_LOOK), NOW).text,
    "Declined: I'll tag these by hand");
});

test("QuickBooks receipts: the worker not serving the 'qbo' channel says so on a waiting card and on queued rows; nothing else changes", () => {
  const beat = (mins, channels) => [{ at: new Date(NOW - mins * 60e3).toISOString(), meta: { channels } }];
  assert.equal(qboLaneOf(beat(0.5, ["sms", "email", "qbo"]), NOW), true);
  assert.equal(qboLaneOf(beat(0.5, ["sms", "email"]), NOW), false, "RECEIPTS_QBO=off");
  assert.equal(qboLaneOf(beat(11, ["qbo"]), NOW), false, "a stopped worker");
  assert.equal(qboLaneOf(null, NOW), null);
  assert.equal(emailLaneOf(beat(0.5, ["qbo"]), NOW), false, "each channel on its own");
  const executed = { ...qboCard, status: "executed", approved_at: iso(-2), updated_at: iso(-2), result: { queued: 2, skipped: 0 } };
  const row = (status) => ({ proposal_id: executed.id, status, created_at: iso(-2), updated_at: iso(-1) });
  const off = qboLook({ heartbeats: beat(0.5, ["sms", "email"]) });
  const on = qboLook({ heartbeats: beat(0.5, ["sms", "email", "qbo"]) });
  const w = fromProposal(qboCard, off);
  assert.deepEqual([w.qboLane, w.laneHint], [false, QBO_OFF_WAITING]);
  assert.equal(QBO_OFF_WAITING, "QuickBooks updates are off on the worker right now: approving queues these, and they wait until updates are back on.");
  assert.equal(approveConfirm(w), "Update QuickBooks for 2 receipts on 2156 Alston rd.?", "the confirm is as it was");
  assert.equal(fromProposal(qboCard, on).laneHint, "");
  assert.equal(fromProposal(email, off).laneHint, "", "the email lane is its own: sending");
  assert.equal(fromProposal(executed, off).laneHint, "", "only a waiting card carries the line");
  const say = (rows, look) => outcome(fromProposal(executed, qboLook({ ...look, outbox: rows })), NOW);
  assert.deepEqual(say([row("pending"), row("failed")], { heartbeats: beat(0.5, ["sms"]) }), { text: QBO_OFF_QUEUED, tone: "wait" });
  assert.equal(QBO_OFF_QUEUED, "Queued, but QuickBooks updates are off on the worker: nothing goes until they're back on");
  assert.deepEqual(say([row("sent"), row("pending")], { heartbeats: beat(0.5, ["sms"]) }),
    { text: "1 of 2 updated in QuickBooks; 1 waiting (QuickBooks updates are off on the worker)", tone: "wait" });
  assert.deepEqual(say([row("sent"), row("sent")], { heartbeats: beat(0.5, ["sms"]) }), { text: "All 2 updated in QuickBooks", tone: "ok" });
  assert.deepEqual(outcome(fromProposal(executed, off), NOW), { text: QBO_OFF_QUEUED, tone: "wait" }, "just approved here, rows not read yet");
  assert.deepEqual(say([row("pending"), row("pending")], {}), { text: "2 queued for QuickBooks", tone: "wait" }, "can't tell: as before");
});

test("QuickBooks receipts: a change the worker gave up on after the card aged off comes back to Recently decided for 48 hours from then", () => {
  const late = { ...qboCard, status: "executed", created_at: iso(-61), expires_at: iso(14 * 24 - 61), approved_at: iso(-60), updated_at: iso(-60),
    result: { queued: 2, skipped: 0 } };
  const row = (status, updated_at, error = null) => ({ proposal_id: late.id, status, error, created_at: iso(-60), updated_at });
  const bare = inbox([], [late], {}, NOW);
  assert.deepEqual(bare.older.map((c) => c.id), [late.id], "answered past the 48 hours: its rows are read");
  assert.deepEqual(needs(bare.older).outbox, [late.id]);
  const box = (rows) => inbox([], [late], qboLook({ outbox: rows }), NOW);
  const b = box([row("sent", iso(-59)), row("dead", iso(-3), "changed_in_qbo: expense 10577 changed in QuickBooks since the card was filed")]);
  assert.deepEqual(b.recent.map((c) => c.id), [late.id]);
  assert.deepEqual(outcome(b.recent[0], NOW), { text: "1 of 2 updated in QuickBooks; 1 refused: changed in QuickBooks since the card was filed", tone: "bad" });
  assert.equal(isRecent(b.recent[0], Date.parse(iso(44.9))), true);
  assert.equal(isRecent(b.recent[0], Date.parse(iso(45.1))), false, "48 hours after it died it ages off");
  // the latest of its dead rows counts; none dead, or dead too long ago: off the list
  assert.equal(box([row("dead", iso(-40), "x"), row("dead", iso(-2), "y")]).recent.length, 1);
  for (const rows of [[row("sent", iso(-59)), row("sent", iso(-58))], [row("dead", iso(-49), "x")], [row("pending", iso(-60))], []]) {
    assert.equal(box(rows).recent.length, 0, JSON.stringify(rows.map((r) => r.status)));
  }
});

test("QuickBooks receipts: a number it holds is never offered, so a text-queue ask on the same number keeps its hint", () => {
  const box = inbox([{ ...reminder, code: 22 }], [qboCard], QBO_LOOK, NOW);
  assert.deepEqual(box.waiting.map((c) => [c.kind, c.yesHint]), [["email", "or text YES 22"], ["qbo", ""]]);
});

test("QuickBooks receipts: an item or link of any odd shape still reads as words, never null, undefined or NaN", () => {
  const odd = fromProposal({ ...qboCard, input: { ...qboInput, qbo_name: null, link: { qbo_customer_id: "112", why: null },
    items: [
      { receipt_id: "r1", vendor: "", date: "2026-02-30", amount: "12", changes: "tag", photo_refs: "x" },
      { receipt_id: "r2", vendor: "Lowe's", date: "2026-13-01", amount: NaN, changes: ["attach", "frob"], qbo_txn_id: null, qbo_account_name: null },
      null, "x", 7, [],
      { receipt_id: "r3", vendor: "Costco", date: "2026-10-03", amount: 0.1 + 0.2, changes: ["create"], qbo_doc_number: "", qbo_account_name: "" },
    ] } }, QBO_LOOK);
  assert.deepEqual(odd.evidence.receipts.map((x) => x.text), [
    "A receipt → QuickBooks expense: no change listed",
    "Lowe's → QuickBooks expense: attach the photo",
    "A receipt → QuickBooks expense: no change listed", "A receipt → QuickBooks expense: no change listed",
    "A receipt → QuickBooks expense: no change listed", "A receipt → QuickBooks expense: no change listed",
    "Costco · Oct 3 · $0.30 → a new QuickBooks expense: enter it, tagged to the job's QuickBooks project",
  ]);
  assert.equal(odd.evidence.link, "Links this job to QuickBooks project number 112");
  for (const t of qboTexts(odd)) assert.ok(!JUNK.test(t), t);
  // no items at all, or no input: still a card, and still words
  for (const input of [{ ...qboInput, items: "none", link: [] }, null]) {
    const c = fromProposal({ ...qboCard, input }, QBO_LOOK);
    assert.deepEqual([c.evidence.receipts, c.evidence.link], [[], ""]);
    assert.equal(approveConfirm(c), "Update QuickBooks for 0 receipts on 2156 Alston rd.?");
    for (const t of qboTexts(c)) assert.ok(!JUNK.test(t), t);
  }
  // an executed card whose rows and result won't read
  const junk = fromProposal({ ...qboCard, status: "executed", approved_at: iso(-1), updated_at: iso(-1), result: { queued: "lots" } },
    qboLook({ outbox: [{ proposal_id: qboCard.id, status: "dead", error: { code: 1 } }, { proposal_id: qboCard.id, status: null }] }));
  assert.deepEqual(outcome(junk, NOW), { text: "None of 2 updated in QuickBooks; 1 waiting; 1 failed: no reason given", tone: "bad" });
  assert.ok(!JUNK.test(outcome(junk, NOW).text));
});

/* ---------- 0025: a receipt paid in parts, a second try, a refused charge, a cancel ---------- */
const CHENA = "1885 Chena Landings Lp.";
const BOFA = "1658 - Bank of America AK Air CC";
/* Rental Zone receipt 995d2795, $351.00 on Oct 7 = Purchase 10615 $126.90 at
   checkout (Oct 2) + 10661 $224.10 at return (Oct 7), card 1658, as the
   matcher files it: the top level is the first charge, every charge in parts */
const rz = { receipt_id: "995d2795", vendor: "The Rental Zone (A Division of Airport Equipment Rentals)", date: "2026-10-07", amount: 351,
  receipt_no: "R284290", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0", qbo_doc_number: "", qbo_account_name: BOFA,
  qbo_vendor_name: "Airport Equipment Rental, Inc", qbo_total: 126.9, changes: ["tag", "attach"], photo_refs: [sha("f")],
  project_ref: "807760362", read_photo_ref: sha("f"),
  parts: [{ qbo_txn_id: "10615", qbo_sync_token: "0", qbo_total: 126.9, qbo_date: "2026-10-02", changes: ["tag", "attach"] },
    { qbo_txn_id: "10661", qbo_sync_token: "0", qbo_total: 224.1, qbo_date: "2026-10-07", changes: ["tag", "attach"] }] };
const CHENA_ID = "c8a3e0d1-1885-4c1a-9b6e-0a2f4d8c1885";
const rzInput = { ...qboInput, job_id: CHENA_ID, job_name: CHENA, qbo_customer_id: "502", qbo_name: CHENA, link: undefined, items: [rz], total_usd: 351 };
const rzCard = { ...qboCard, id: "bbbbbbbb-0000-4000-8000-0000000000c5", job_id: CHENA_ID, input: rzInput };
const RZ_LINE = "The Rental Zone (A Division of Airport Equipment Rentals) · Oct 7 · $351.00 → 2 QuickBooks charges, "
  + `10615 ($126.90, Oct 2) + 10661 ($224.10, Oct 7) (Airport Equipment Rental, Inc, ${BOFA}): tag to ${CHENA}, attach the photo`;

test("QuickBooks receipts (0025): a rental paid in two charges is one line naming both, with each charge's amount and date", () => {
  const c = fromProposal(rzCard, QBO_LOOK);
  assert.deepEqual(c.evidence.receipts, [{ id: "995d2795", text: RZ_LINE }]);
  assert.equal(approveConfirm(c), `Update QuickBooks for 1 receipt on ${CHENA}?`, "one receipt, however many charges");
  // three charges; a part with no total, date or id still reads as words
  const three = { ...rz, parts: [rz.parts[0], { qbo_txn_id: "10616", qbo_total: 94, qbo_date: "2026-10-03" },
    { qbo_txn_id: "10661", qbo_total: 130.1, qbo_date: "2026-10-07" }] };
  const odd = { ...rz, qbo_vendor_name: "", qbo_account_name: "", photo_refs: [], changes: ["tag"],
    parts: [{ qbo_txn_id: "10615", qbo_total: null, qbo_date: "10/02/2026" }, { qbo_total: NaN }, null, "x"] };
  const more = fromProposal({ ...rzCard, input: { ...rzInput, items: [three, odd] } }, QBO_LOOK);
  assert.deepEqual(more.evidence.receipts.map((x) => x.text), [
    "The Rental Zone (A Division of Airport Equipment Rentals) · Oct 7 · $351.00 → 3 QuickBooks charges, "
      + `10615 ($126.90, Oct 2) + 10616 ($94.00, Oct 3) + 10661 ($130.10, Oct 7) (Airport Equipment Rental, Inc, ${BOFA}): tag to ${CHENA}, attach the photo`,
    "The Rental Zone (A Division of Airport Equipment Rentals) · Oct 7 · $351.00 → 4 QuickBooks charges, "
      + `10615 + a charge + a charge + a charge: tag to ${CHENA}`,
  ]);
  for (const t of qboTexts(more)) assert.ok(!JUNK.test(t), t);
  // one part, or none, is no receipt in parts: the v1 line, byte for byte
  for (const parts of [[rz.parts[0]], [], null, "10615,10661"]) {
    const one = fromProposal({ ...qboCard, input: { ...qboInput, items: [{ ...hd, parts }] } }, QBO_LOOK);
    assert.deepEqual(one.evidence.receipts, [{ id: "r-1369", text: HD_LINE }], JSON.stringify(parts));
  }
  // and every v1 card reads as it did
  assert.deepEqual(fromProposal(qboCard, QBO_LOOK).evidence.receipts, [{ id: "r-6788", text: HD2_LINE }, { id: "r-1369", text: HD_LINE }]);
});

test("QuickBooks receipts (0025): a second try says so, and why the last one didn't go", () => {
  const PREV = "bbbbbbbb-0000-4000-8000-0000000000b9";
  const line = (refile, item = hd, input = qboInput) =>
    fromProposal({ ...qboCard, input: { ...input, items: [{ ...item, refile }] } }, QBO_LOOK).evidence.receipts[0].text;
  assert.equal(line({ proposal_id: PREV, error: "qbo_unavailable", why: "QuickBooks 503: Service Unavailable" }),
    HD_LINE + " · Trying again: last time QuickBooks was down");
  assert.equal(line({ proposal_id: PREV, error: "relinked", why: "the job was linked to another QuickBooks project" }),
    HD_LINE + " · Trying again: last time the job's QuickBooks project changed after approval");
  assert.equal(line({ proposal_id: null, error: "failed", why: "lease expired (held by w1)" }),
    HD_LINE + " · Trying again: last time lease expired (held by w1)", "no code: the words as they were");
  assert.equal(line({ proposal_id: PREV, error: "failed" }), HD_LINE + " · Trying again: last time it didn't go through");
  assert.equal(line({ proposal_id: PREV, error: "cancelled", why: "Branden: wrong job" }), HD_LINE + " · Trying again: last time it was cancelled");
  assert.equal(line({ error: "constructor", why: "x ".repeat(100) }), HD_LINE + " · Trying again: last time " + "x ".repeat(60).slice(0, 119) + "…");
  assert.equal(line({ proposal_id: PREV, error: "qbo_throttled" }, rz, rzInput), RZ_LINE + " · Trying again: last time QuickBooks was too busy");
  // a marker of any other shape is no second try
  for (const refile of [null, "qbo_unavailable", ["qbo_unavailable"], 7]) assert.equal(line(refile), HD_LINE, JSON.stringify(refile));
  const c = fromProposal({ ...qboCard, input: { ...qboInput, items: [{ ...hd, refile: { error: null, why: null } }] } }, QBO_LOOK);
  for (const t of qboTexts(c)) assert.ok(!JUNK.test(t), t);
});

test("QuickBooks receipts (0025): a charge refused after another was tagged is updated, and says so; a change the office cancelled says cancelled", () => {
  const executed = { ...qboCard, status: "executed", approved_at: iso(-2), updated_at: iso(-2), result: { queued: 3, skipped: 0 },
    input: { ...qboInput, items: [hd2, hd, rz] } };
  const row = (status, provider_status = null, error = null) => ({ proposal_id: executed.id, status, error, provider_status,
    next_attempt_at: iso(-2), created_at: iso(-2), updated_at: iso(-1) });
  const SENT = "tagged=done;attached=1";
  const PART = "tagged=done;attached=1;parts=10615:1,10661:0;part_error=changed_in_qbo";
  const at = (rows, o = {}) => outcome(fromProposal({ ...executed, ...o }, qboLook({ outbox: rows })), NOW);
  const alone = { result: { queued: 1 }, job_id: CHENA_ID, input: rzInput };
  assert.deepEqual(at([row("sent", PART)], alone),
    { text: "Tagged in QuickBooks; one charge refused: changed in QuickBooks since the card was filed", tone: "bad" });
  assert.deepEqual(at([row("sent", "tagged=done;attached=0;parts=10615:1,10661:0;part_error=tagged_other;attach_error=upload_refused")], alone),
    { text: "Tagged in QuickBooks; one charge refused: tagged to another job; photo not attached: QuickBooks refused the photo", tone: "bad" });
  assert.deepEqual(at([row("sent", "tagged=done;parts=10615:1,10661:0;part_error=frobbed")], alone),
    { text: "Tagged in QuickBooks; one charge refused: frobbed", tone: "bad" }, "a code this page doesn't know");
  assert.deepEqual(at([row("sent", "tagged=done;attached=2;parts=10615:1,10661:1")], alone), { text: "Updated in QuickBooks", tone: "ok" });
  assert.deepEqual(at([row("sent", SENT), row("sent", SENT), row("sent", PART)]),
    { text: "All 3 updated in QuickBooks; 1 with a charge refused: changed in QuickBooks since the card was filed", tone: "bad" });
  assert.deepEqual(at([row("sent", "tagged=done;attached=0;attach_error=photo_type"), row("sent", SENT), row("sent", PART)]),
    { text: "All 3 updated in QuickBooks; 1 photo not attached: the photo isn't a JPEG, PNG or PDF; 1 with a charge refused: changed in QuickBooks since the card was filed", tone: "bad" });
  assert.deepEqual(at([row("sent", PART), row("pending"), row("dead", null, "tagged_other: expense 10577 is already tagged to Bemis Ct in QuickBooks")]),
    { text: "1 of 3 updated in QuickBooks; 1 with a charge refused: changed in QuickBooks since the card was filed; 1 waiting; 1 refused: tagged to another job", tone: "bad" });
  // the office cancelled the queued change (outbox row marked dead, error 'cancelled: <who and why>'): its own verb, not a trouble
  assert.deepEqual(at([row("dead", null, "cancelled: marked dead by hand")], alone),
    { text: "Not updated in QuickBooks: cancelled (marked dead by hand)", tone: "no" });
  assert.deepEqual(at([row("dead", null, "cancelled: Branden, wrong job; tagged it by hand")], alone),
    { text: "Not updated in QuickBooks: cancelled (Branden, wrong job; tagged it by hand)", tone: "no" });
  assert.deepEqual(at([row("dead", null, "cancelled:")], alone), { text: "Not updated in QuickBooks: cancelled", tone: "no" });
  assert.deepEqual(at([row("sent", SENT), row("sent", SENT), row("dead", null, "cancelled: marked dead by hand")]),
    { text: "2 of 3 updated in QuickBooks; 1 cancelled: marked dead by hand", tone: "no" });
  assert.deepEqual(at([row("sent", SENT), row("pending"), row("dead", null, "cancelled: Branden")]),
    { text: "1 of 3 updated in QuickBooks; 1 waiting; 1 cancelled: Branden", tone: "wait" });
  assert.deepEqual(at([row("dead", null, "cancelled:"), row("dead", null, "qbo_unavailable: QuickBooks 503"),
    row("dead", null, "tagged_other: expense 10584 is already tagged to Bemis Ct in QuickBooks")]),
  { text: "None of 3 updated in QuickBooks; 1 refused: tagged to another job; 1 failed: QuickBooks was down; 1 cancelled", tone: "bad" });
  // a dead row with no error at all is still "no reason given", as before
  assert.deepEqual(at([row("dead", null, null)], alone), { text: "Not updated in QuickBooks: no reason given", tone: "bad" });
  for (const rows of [[row("sent", PART)], [row("dead", null, "cancelled:")]]) {
    for (const t of qboTexts(fromProposal({ ...executed, ...alone }, qboLook({ outbox: rows })))) assert.ok(!JUNK.test(t), t);
  }
});
