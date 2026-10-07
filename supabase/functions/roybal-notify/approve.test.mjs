/* Approve-by-text rules — unit tests (no Deno, no network), plus the pure
   half of the Approvals inbox's decidePending (request check, answers),
   and the spine lane's rules (step 5: one YES across both queues, a bare
   YES only for an ask a text offered, the spine row's label, the text for
   every op_proposal_* answer, and the GET /version answer).
   The order decide() runs in, and a YES driven through index.ts against a
   stubbed PostgREST, are tested in decide.test.mjs.
   Run: node --experimental-strip-types approve.test.mjs */
import assert from "node:assert/strict";
import {
  parseApproval, matchProposal, stillLive, proposalLine, replyText,
  validateBoardEdit, buildNextSubtasks, revGuard,
  hourLabel, inSendWindow, sendWindowText, quietHoursHold, replyFor,
  alaskaHour, windowOpensAt, expiresBeforeWindow, retryableStatus,
  parseDecideRequest, decideResponse, ownerGate,
  matchAcross, offeredByText, VERSION_ANSWER, INBOX_ONLY_FILTER, spineLabel, opName, ownerPrincipal, emailLane, outboxState,
  spineLateText, spineDecidedAt, spineOutranks, spineReceipt, spineVerdict, spineReply,
} from "./approve.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

test("YES in its many forms parses; chatter does not", () => {
  assert.deepEqual(parseApproval("YES 12"), { yes: true, no: false, code: "12" });
  assert.deepEqual(parseApproval("yes"), { yes: true, no: false, code: null });
  assert.deepEqual(parseApproval("  Y 7 "), { yes: true, no: false, code: "7" });
  assert.deepEqual(parseApproval("approve 3"), { yes: true, no: false, code: "3" });
  assert.deepEqual(parseApproval("ok"), { yes: true, no: false, code: null });
  assert.deepEqual(parseApproval("YES #12"), { yes: true, no: false, code: "12" });
  assert.deepEqual(parseApproval("Yes 12."), { yes: true, no: false, code: "12" });
  assert.deepEqual(parseApproval("yes1"), { yes: true, no: false, code: "1" });   // no space, as thumbs type it
  assert.deepEqual(parseApproval("YES12"), { yes: true, no: false, code: "12" });
  assert.deepEqual(parseApproval("Y7"), { yes: true, no: false, code: "7" });
  assert.equal(parseApproval("yesterday").yes, false);                  // a letter after the word is chatter
  assert.equal(parseApproval("okay").yes, false);
  assert.equal(parseApproval("yes1 and the other one").yes, false);
  assert.equal(parseApproval("yes 12345").yes, false);                  // codes are 1–4 digits
  assert.equal(parseApproval("yes send the hansen one").yes, false);   // free text ≠ approval
  assert.equal(parseApproval("can you check on the Hebert job?").yes, false);
  assert.equal(parseApproval("").yes, false);
});

test("NO / STOP / CANCEL parse as declines", () => {
  assert.deepEqual(parseApproval("no 12"), { yes: false, no: true, code: "12" });
  assert.deepEqual(parseApproval("STOP"), { yes: false, no: true, code: null });
  assert.deepEqual(parseApproval("cancel 4"), { yes: false, no: true, code: "4" });
  assert.deepEqual(parseApproval("no1"), { yes: false, no: true, code: "1" });
  assert.deepEqual(parseApproval("N12"), { yes: false, no: true, code: "12" });
  assert.equal(parseApproval("nope").no, false);
  assert.equal(parseApproval("not yet").no, false);
});

const open = (rows) => rows.map((r) => ({ status: "pending", ...r }));

test("explicit code matches exactly; leading zeros tolerated", () => {
  const rows = open([{ code: 12, label: "a" }, { code: 13, label: "b" }]);
  assert.equal(matchProposal(rows, "12").hit.label, "a");
  assert.equal(matchProposal(rows, "012").hit.label, "a");
  assert.equal(matchProposal(rows, "99").reason, "no-such-code");
});

test("bare YES works only when exactly one proposal is live", () => {
  assert.equal(matchProposal(open([{ code: 12 }]), null).reason, "ok");
  assert.equal(matchProposal(open([{ code: 12 }, { code: 13 }]), null).reason, "ambiguous");
  assert.equal(matchProposal([], null).reason, "none-open");
  assert.equal(matchProposal([{ code: 12, status: "executed" }], null).reason, "none-open");
});

test("expiry: yesterday's proposal is not live today", () => {
  const a = { status: "pending", expires_at: "2026-07-23T15:00:00Z" };
  assert.equal(stillLive(a, "2026-07-23T14:59:00Z"), true);
  assert.equal(stillLive(a, "2026-07-23T15:01:00Z"), false);
  assert.equal(stillLive({ status: "executed" }, "2026-07-23T00:00:00Z"), false);
});

test("proposal + reply lines read like a human wrote them", () => {
  assert.equal(proposalLine({ code: 12, label: "email the INV-4 reminder to Hebard" }),
    "💬 Reply YES 12 — email the INV-4 reminder to Hebard");
  assert.match(replyText("done", { label: "emailed the reminder" }), /^✅ Done — emailed the reminder\./);
  assert.match(replyText("failed", undefined, "quiet hours"), /Nothing was sent/);
  assert.match(replyText("ambiguous"), /YES with its number/);
});

/* ---------- boardEdit ---------- */

const JOB = "7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5";   // coordination_jobs.id is a uuid
const phase = (name, id = "p-new") => ({ id, name, durationDays: null, lagDays: 0, estimatedHours: 5.2, crewIds: [] });
const edit = (over = {}) => ({ op: "addPhase", rowId: JOB, phase: phase("Punch list"), entryIds: ["e1"], ...over });

test("a well-formed addPhase proposal validates", () => {
  const v = validateBoardEdit(edit());
  assert.equal(v.rowId, JOB);
  assert.equal(validateBoardEdit(edit({ rowId: ` ${JOB.toUpperCase()} ` })).rowId, JOB.toUpperCase());
  assert.equal(v.phase.name, "Punch list");
  assert.equal(v.phase.estimatedHours, 5.2);
});

test("anything but addPhase, or a proposal missing its job/phase, is refused", () => {
  assert.throws(() => validateBoardEdit(edit({ op: "deleteJob" })), /only addPhase/);
  assert.throws(() => validateBoardEdit(edit({ op: "" })), /only addPhase/);
  assert.throws(() => validateBoardEdit({}), /only addPhase/);
  assert.throws(() => validateBoardEdit(edit({ rowId: "  " })), /no board job/);
  assert.throws(() => validateBoardEdit(edit({ phase: phase("   ") })), /no phase/);
  assert.throws(() => validateBoardEdit(edit({ phase: undefined })), /no phase/);
});

test("a board job that isn't a uuid is refused before any read (PostgREST would 400 it every time)", () => {
  for (const rowId of ["job-1", "12", JOB + "0", JOB.slice(1), `${JOB}&deleted=eq.false`, 12, { id: JOB }]) {
    assert.throws(() => validateBoardEdit(edit({ rowId })), /^Error: the proposal names no valid board job$/, JSON.stringify(rowId));
  }
});

test("only an outage or a rate limit makes a failed board read worth answering again", () => {
  for (const s of [500, 502, 503, 504, 429]) assert.equal(retryableStatus(s), true, String(s));
  // the same answer next time: retrying would bounce the row back to pending forever
  for (const s of [400, 401, 403, 404, 406, 416, 200, 204]) assert.equal(retryableStatus(s), false, String(s));
});

test("append lands at the end and leaves the existing phases alone", () => {
  const existing = [{ id: "a", name: "Demo" }, { id: "b", name: "Drywall" }];
  const next = buildNextSubtasks(existing, phase("Punch list"));
  assert.equal(next.length, 3);
  assert.equal(next[2].name, "Punch list");
  assert.deepEqual(existing, [{ id: "a", name: "Demo" }, { id: "b", name: "Drywall" }]);  // not mutated
  // (an empty list is allowed HERE — index.ts refuses to give an unphased job
  //  its first phase by text, because that opts it into the scheduler)
  assert.equal(buildNextSubtasks(undefined, phase("Punch list")).length, 1);
  assert.equal(buildNextSubtasks(null, phase("Punch list")).length, 1);
});

test("a malformed phase list is refused, never silently replaced", () => {
  // {...data, subtasks:[phase]} would have DELETED whatever was really there
  assert.throws(() => buildNextSubtasks({ a: 1 }, phase("Punch list")), /malformed/);
  assert.throws(() => buildNextSubtasks("oops", phase("Punch list")), /malformed/);
});

test("a phase with no usable id is refused (hours could never reach it)", () => {
  assert.throws(() => validateBoardEdit(edit({ phase: { name: "Punch list" } })), /no id/);
  assert.throws(() => validateBoardEdit(edit({ phase: phase("Punch list", "  ") })), /no id/);
  // a non-string name must not slip through String() coercion as "[object Object]"
  assert.throws(() => validateBoardEdit(edit({ phase: { id: "p", name: {} } })), /no phase/);
});

test("a name already on the board is never twinned, however it was typed", () => {
  const has = (name) => buildNextSubtasks([{ id: "a", name }], phase("Punch list"));
  assert.equal(has("Punch list"), null);
  assert.equal(has("punch list"), null);
  assert.equal(has("  PUNCH List  "), null);
  assert.equal(has("Punch   list"), null);          // collapsed inner whitespace
  assert.equal(has("Punch-list"), null);            // punctuation is noise
  assert.equal(has("Punch listing").length, 2);     // near miss is still a new phase
  // the matcher emits "&" names; a board typed with "and" is the same phase
  assert.equal(buildNextSubtasks([{ id: "a", name: "Trim and doors" }],
    { id: "p", name: "Trim & doors" }), null);
});

test("a code shared by two live proposals is ambiguous, never a coin flip", () => {
  const live = [
    { code: 11, status: "pending", label: "add phase Punch list", expires_at: "2999-01-01" },
    { code: 11, status: "pending", label: "email the INV-4 reminder", expires_at: "2999-01-01" },
  ];
  const m = matchProposal(live, "11");
  assert.equal(m.hit, null);
  assert.equal(m.reason, "ambiguous", "acting on one would fire the wrong action");
});

test("rev guard: a job with no rev yet matches null-or-0, a revved one matches exactly", () => {
  assert.equal(revGuard(0), "or=(data->>rev.is.null,data->>rev.eq.0)");
  assert.equal(revGuard(7), "data->>rev=eq.7");
});

/* ---------- quiet hours: the preflight before a YES flips anything ---------- */

test("the send window counts its start hour, not its end hour", () => {
  assert.equal(inSendWindow(7, 7, 20), true);
  assert.equal(inSendWindow(19, 7, 20), true);
  assert.equal(inSendWindow(20, 7, 20), false);
  assert.equal(inSendWindow(6, 7, 20), false);
  assert.equal(inSendWindow(0, 7, 20), false);
});

test("hours read the way sendSms has always printed them", () => {
  assert.equal(hourLabel(7), "7am");
  assert.equal(hourLabel(20), "8pm");
  assert.equal(hourLabel(13), "1pm");
  assert.equal(hourLabel(12), "noon");
  assert.equal(hourLabel(0), "midnight");
  assert.equal(hourLabel(24), "midnight");
  assert.equal(sendWindowText(7, 20), "7am and 8pm");
});

test("only a customer text outside the window is held", () => {
  const cust = { to: "+19075551234", message: "We're on our way", audience: "customer" };
  assert.equal(quietHoursHold("sendText", cust, 21, 7, 20), true, "a 9pm YES");
  assert.equal(quietHoursHold("sendText", cust, 6, 7, 20), true);
  assert.equal(quietHoursHold("sendText", cust, 20, 7, 20), true, "8pm is already outside");
  assert.equal(quietHoursHold("sendText", cust, 7, 7, 20), false);
  assert.equal(quietHoursHold("sendText", cust, 19, 7, 20), false);
  assert.equal(quietHoursHold("sendText", { ...cust, audience: "crew" }, 21, 7, 20), false, "crew texts go at any hour");
  // only an explicit customer audience is gated, exactly as the executor's own guard is
  assert.equal(quietHoursHold("sendText", { to: "+19075551234", message: "x" }, 21, 7, 20), false);
  assert.equal(quietHoursHold("sendText", null, 21, 7, 20), false);
  assert.equal(quietHoursHold("emailSend", { audience: "customer" }, 23, 7, 20), false, "only texts have a window");
  assert.equal(quietHoursHold("boardEdit", {}, 3, 7, 20), false);
  assert.equal(quietHoursHold("sendText", cust, 21, 6, 22), false, "the window is SMS_QUIET_START/END, not a constant");
});

test("the quiet-hours reply names the window and the code to text again", () => {
  const t = replyText("quiet-hours", { code: 14, label: "text Mike the start time" }, sendWindowText(7, 20));
  assert.match(t, /between 7am and 8pm Alaska time/);
  assert.match(t, /text YES 14 again then/);
  assert.match(t, /Nothing was sent; it's still waiting/);
});

/* When the window next opens, and whether a held row lapses first. July
   is AKDT (UTC-8), so 7am there is 15:00Z; January is AKST (UTC-9), 16:00Z. */
const at = (iso) => new Date(iso);

test("the Alaska clock reads both offsets", () => {
  assert.equal(alaskaHour(at("2026-07-02T05:30:00Z")), 21);   // 9:30pm AKDT
  assert.equal(alaskaHour(at("2026-01-15T06:30:00Z")), 21);   // 9:30pm AKST
  assert.equal(alaskaHour(at("2026-07-01T08:00:00Z")), 0);    // midnight is 0, not 24
});

test("the window next opens at the top of the start hour, tomorrow's in the evening, today's before dawn", () => {
  const iso = (d) => d.toISOString();
  assert.equal(iso(windowOpensAt(at("2026-07-02T05:30:00Z"), 7, 20)), "2026-07-02T15:00:00.000Z", "9:30pm → 7am tomorrow");
  assert.equal(iso(windowOpensAt(at("2026-07-02T13:15:00Z"), 7, 20)), "2026-07-02T15:00:00.000Z", "5:15am → 7am today");
  assert.equal(iso(windowOpensAt(at("2026-07-02T08:00:00Z"), 7, 20)), "2026-07-02T15:00:00.000Z", "midnight → 7am today");
  assert.equal(iso(windowOpensAt(at("2026-07-02T04:00:00Z"), 7, 20)), "2026-07-02T15:00:00.000Z", "8pm sharp → 7am tomorrow");
  assert.equal(iso(windowOpensAt(at("2026-01-15T06:30:00Z"), 7, 20)), "2026-01-15T16:00:00.000Z", "winter: 7am AKST");
  assert.equal(iso(windowOpensAt(at("2026-07-02T05:30:00Z"), 6, 20)), "2026-07-02T14:00:00.000Z", "SMS_QUIET_START, not a constant");
});

test("the window's opening lands on 7am across both DST changes", () => {
  // spring forward (Mar 8, 2am AKST → 3am AKDT): 9:30pm Saturday to 7am is 9 real hours, not 10
  const spring = windowOpensAt(at("2026-03-08T06:30:00Z"), 7, 20);
  assert.equal(spring.toISOString(), "2026-03-08T15:00:00.000Z");
  assert.equal(alaskaHour(spring), 7);
  // fall back (Nov 1, 2am AKDT → 1am AKST): 11 real hours, not 10
  const fall = windowOpensAt(at("2026-11-01T05:30:00Z"), 7, 20);
  assert.equal(fall.toISOString(), "2026-11-01T16:00:00.000Z");
  assert.equal(alaskaHour(fall), 7);
});

test("the window's opening is whatever the preflight would call open: a skipped start hour, a fractional start, no window", () => {
  // start 2am on the spring-forward night: 2am never happens, the window opens at 3am AKDT
  const skipped = windowOpensAt(at("2026-03-08T09:00:00Z"), 2, 20);
  assert.equal(skipped.toISOString(), "2026-03-08T11:00:00.000Z");
  assert.equal(inSendWindow(alaskaHour(skipped), 2, 20), true);
  // a start of 7.25 is only open from the 8 o'clock hour on (inSendWindow compares whole hours)
  assert.equal(windowOpensAt(at("2026-07-02T05:30:00Z"), 7.25, 20).toISOString(), "2026-07-02T16:00:00.000Z");
  // a start at or after its end never opens, so nothing held can be approved "then"
  assert.equal(windowOpensAt(at("2026-07-02T05:30:00Z"), 20, 20), null);
  assert.equal(expiresBeforeWindow("2999-01-01T00:00:00Z", at("2026-07-02T05:30:00Z"), 20, 20), true);
});

test("a held row expires first only when its expiry falls at or before the window opens", () => {
  const nine = at("2026-07-02T05:30:00Z");                    // 9:30pm AKDT; opens 15:00Z
  assert.equal(expiresBeforeWindow("2026-07-02T10:00:00Z", nine, 7, 20), true, "2am: gone before 7am");
  assert.equal(expiresBeforeWindow("2026-07-02T15:00:00Z", nine, 7, 20), true, "7:00:00 sharp is already not live");
  assert.equal(expiresBeforeWindow("2026-07-02T15:00:01Z", nine, 7, 20), false);
  assert.equal(expiresBeforeWindow("2026-07-02T17:00:00+00:00", nine, 7, 20), false, "9am: approve it then");
  // no expiry (stillLive's never-expires) and junk are not "expires first"
  for (const e of [null, undefined, "", "soon"]) assert.equal(expiresBeforeWindow(e, nine, 7, 20), false, String(e));
  // the start hour decides: a 10am window makes a 9am expiry lapse
  assert.equal(expiresBeforeWindow("2026-07-02T17:00:00Z", nine, 10, 20), true);
});

test("a held row that expires before the window says it won't go out, never 'approve it then'", () => {
  const a = { code: 14, label: "text the Hebards the start time" };
  const t = replyFor("approve", { status: "quiet_hours", expiresFirst: true }, a, sendWindowText(7, 20));
  assert.equal(t, "🌙 Customer texts go out between 7am and 8pm Alaska time, and this one expires before then, so it won't go out. Nothing was sent.");
  assert.doesNotMatch(t, /YES 14|still waiting/);
  // the hours come from the window, never a constant
  assert.match(replyFor("approve", { status: "quiet_hours", expiresFirst: true }, a, sendWindowText(6, 22)), /between 6am and 10pm Alaska time/);
  assert.equal(replyFor("approve", { status: "quiet_hours", expiresFirst: false }, a, sendWindowText(7, 20)),
    replyText("quiet-hours", a, sendWindowText(7, 20)));
  const q = decideResponse({ status: "quiet_hours", expiresFirst: true }, a, sendWindowText(7, 20));
  assert.deepEqual(q, { code: 409, body: { ok: false, error: "quiet_hours",
    message: "Customer texts only go out between 7am and 8pm Alaska time, and this one expires before then. Nothing was sent." } });
  assert.match(decideResponse({ status: "quiet_hours", expiresFirst: true }, a, sendWindowText(6, 22)).body.message, /between 6am and 10pm/);
  assert.match(decideResponse({ status: "quiet_hours" }, a, sendWindowText(7, 20)).body.message, /It's still waiting; approve it then\./);
});

test("each decide() outcome gets the text reply the YES/NO path has always sent", () => {
  const a = { code: 12, label: "email the INV-4 reminder to Hebard" };
  const w = sendWindowText(7, 20);
  assert.equal(replyFor("approve", { status: "executed" }, a, w), replyText("done", a));
  assert.equal(replyFor("approve", { status: "not_open" }, a, w), replyText("none-open"));
  assert.equal(replyFor("approve", { status: "failed", error: "that job is no longer on the board" }, a, w),
    replyText("failed", a, "that job is no longer on the board"));
  assert.equal(replyFor("approve", { status: "quiet_hours" }, a, w), replyText("quiet-hours", a, w));
  assert.equal(replyFor("decline", { status: "declined" }, a, w), replyText("cancelled", a));
});

test("a NO that didn't land says so instead of 'Cancelled'", () => {
  const a = { code: 12, label: "email the INV-4 reminder to Hebard" };
  // a YES or a tap got there first: the row may already have run
  assert.equal(replyFor("decline", { status: "not_open" }, a, sendWindowText(7, 20)),
    "That one was already answered — nothing was cancelled.");
});

test("a board that couldn't be reached: nothing added, text the same YES again", () => {
  const a = { code: 13, label: "add phase Punch list to Pollen" };
  const t = replyFor("approve", { status: "try_again", error: "couldn't reach the board just now. Nothing was added" }, a, "");
  assert.equal(t, "⏳ Couldn't reach the board just now. Nothing was added — text YES 13 again in a minute.");
});

test("a phase that was already on the board says nothing was added, on the text too", () => {
  const a = { code: 13, label: "add phase Punch list to Pollen" };
  assert.equal(replyFor("approve", { status: "executed", skipped: "phase already exists" }, a, ""),
    "✅ Phase was already on the board — nothing was added (add phase Punch list to Pollen).");
});

test("a YES or NO that couldn't be recorded asks for the same word again", () => {
  const a = { code: 12, label: "x" };
  assert.equal(replyText("not-recorded", a, "YES"), "Couldn't record that just now — text YES 12 again in a minute.");
  // a NO must never be told to text YES
  assert.equal(replyText("not-recorded", a, "NO"), "Couldn't record that just now — text NO 12 again in a minute.");
});

/* ---------- decidePending: the request, and every answer ---------- */

const ID = "3f2c9a8e-5b1d-4c7e-9f0a-1b2c3d4e5f60";

test("a decide request needs a real uuid and approve or decline", () => {
  assert.deepEqual(parseDecideRequest({ id: ID, decision: "approve" }), { ok: true, id: ID, decision: "approve" });
  assert.deepEqual(parseDecideRequest({ id: ` ${ID.toUpperCase()} `, decision: "decline" }),
    { ok: true, id: ID.toUpperCase(), decision: "decline" });
  // the id goes straight into a PostgREST filter, so nothing but a uuid gets through
  for (const id of [undefined, null, "", "12", ID + "0", `${ID}&status=eq.executed`, "not-a-uuid", 12, { id: ID }]) {
    const r = parseDecideRequest({ id, decision: "approve" });
    assert.equal(r.ok, false, `id ${JSON.stringify(id)}`);
    assert.match(r.message, /`id`/);
  }
  for (const decision of [undefined, "", "yes", "APPROVE", "approved", "no", true]) {
    const r = parseDecideRequest({ id: ID, decision });
    assert.equal(r.ok, false, `decision ${JSON.stringify(decision)}`);
    assert.match(r.message, /"approve" or "decline"/);
  }
  assert.equal(parseDecideRequest(null).ok, false);
  assert.equal(parseDecideRequest(undefined).ok, false);
});

test("decidePending: 200 when the decision was recorded, { ok:false, error, message } otherwise", () => {
  const a = { id: ID, code: 12, kind: "emailSend", label: "email the INV-4 reminder to Hebard",
    params: { to: "hebard@example.com", body: "…" }, status: "pending" };
  const action = { id: ID, code: 12, kind: "emailSend", label: "email the INV-4 reminder to Hebard" };
  const w = sendWindowText(7, 20);
  // `after` = the row re-read once the decision settled
  const sent = { ...a, status: "executed", result: { gmailId: "g1", threadId: "t1" } };
  assert.deepEqual(decideResponse({ status: "executed" }, a, w, sent),
    { code: 200, body: { ok: true, status: "executed", message: "Done — email the INV-4 reminder to Hebard.",
      action: { ...action, status: "executed", result: { gmailId: "g1", threadId: "t1" } } } });
  assert.deepEqual(decideResponse({ status: "declined" }, a, w, { ...a, status: "declined", result: null }),
    { code: 200, body: { ok: true, status: "declined", message: "Declined — email the INV-4 reminder to Hebard.",
      action: { ...action, status: "declined", result: null } } });
  // failed is still a recorded decision; the error rides in message
  assert.deepEqual(decideResponse({ status: "failed", error: "Invalid 'to' address" }, a, w,
    { ...a, status: "failed", result: { error: "Invalid 'to' address" } }),
    { code: 200, body: { ok: true, status: "failed", message: "Invalid 'to' address",
      action: { ...action, status: "failed", result: { error: "Invalid 'to' address" } } } });
  assert.deepEqual(decideResponse({ status: "not_open" }, a, w),
    { code: 404, body: { ok: false, error: "not_open", message: "Already answered, or it expired." } });
  const q = decideResponse({ status: "quiet_hours" }, a, w);
  assert.equal(q.code, 409);
  assert.equal(q.body.error, "quiet_hours");
  assert.match(q.body.message, /between 7am and 8pm Alaska time\. It's still waiting/);
  assert.deepEqual(decideResponse({ status: "not_owner" }, null, w),
    { code: 403, body: { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." } });
  assert.deepEqual(decideResponse({ status: "bad_request", error: "Provide `id`, the pending action's uuid." }, null, w),
    { code: 400, body: { ok: false, error: "bad_request", message: "Provide `id`, the pending action's uuid." } });
  assert.deepEqual(decideResponse({ status: "server_error", error: "pending_actions read failed (503)" }, null, w),
    { code: 500, body: { ok: false, error: "server_error", message: "pending_actions read failed (503)" } });
  // a skip whose executed stamp didn't land: the re-read still says approved, but the answer knows it skipped
  const phaseRow = { id: ID, code: 13, kind: "boardEdit", label: "add Punch list to Hebard", status: "pending" };
  const stale = decideResponse({ status: "executed", skipped: "phase already exists" }, phaseRow, w,
    { ...phaseRow, status: "approved", result: null });
  assert.equal(stale.body.message, "Phase was already on the board — nothing was added.");
  assert.deepEqual(stale.body.action.result, { skipped: "phase already exists" });
  // the row's params (the email body, the customer's number) never ride back
  assert.equal(JSON.stringify(decideResponse({ status: "executed" }, a, w)).includes("hebard@example.com"), false);
  assert.equal(JSON.stringify(decideResponse({ status: "executed" }, a, w, { ...sent, params: a.params })).includes("hebard@example.com"), false);
});

test("decidePending: a 200's action is the row after the decision, or the outcome when that read failed", () => {
  const a = { id: ID, code: 12, kind: "emailSend", label: "email the INV-4 reminder to Hebard", status: "pending", result: null };
  const w = sendWindowText(7, 20);
  const act = (out, after) => decideResponse(out, a, w, after).body.action;
  // the read failed: never "pending", which is what the row said before
  assert.deepEqual([act({ status: "executed" }).status, act({ status: "executed" }).result], ["executed", null]);
  assert.deepEqual([act({ status: "declined" }).status, act({ status: "declined" }).result], ["declined", null]);
  assert.deepEqual(act({ status: "failed", error: "twilio 400" }).result, { error: "twilio 400" });
  // the read says what really happened, even when it differs from the outcome
  assert.equal(act({ status: "failed", error: "x" }, { ...a, status: "approved", result: null }).status, "approved");
});

test("decidePending: a phase already on the board says nothing was added", () => {
  const a = { id: ID, code: 13, kind: "boardEdit", label: "add phase Punch list to Pollen", status: "pending" };
  const w = sendWindowText(7, 20);
  const skip = "Phase was already on the board — nothing was added.";
  // from decide()'s outcome…
  const r = decideResponse({ status: "executed", skipped: "phase already exists" }, a, w);
  assert.equal(r.body.message, skip);
  assert.deepEqual(r.body.action.result, { skipped: "phase already exists" });
  // …or from the re-read row's stamp
  const after = { ...a, status: "executed", result: { rowId: JOB, skipped: "phase already exists" } };
  assert.equal(decideResponse({ status: "executed" }, a, w, after).body.message, skip);
  // a phase that was added is Done
  assert.equal(decideResponse({ status: "executed" }, a, w, { ...a, status: "executed", result: { rowId: JOB, rev: 4 } }).body.message,
    "Done — add phase Punch list to Pollen.");
});

test("decidePending: the board didn't answer is 409 try_again, still pending", () => {
  const a = { id: ID, code: 13, kind: "boardEdit", label: "add phase Punch list to Pollen" };
  assert.deepEqual(decideResponse({ status: "try_again", error: "couldn't reach the board just now. Nothing was added" }, a, ""),
    { code: 409, body: { ok: false, error: "try_again",
      message: "Couldn't reach the board just now. Nothing was added; try again in a minute." } });
});

test("role_is: only a 200 literal true is the owner; a refused token is 401, an outage 503", () => {
  assert.equal(ownerGate(200, true), null);
  for (const body of [false, null, "true", 1, {}, [true]]) {
    assert.deepEqual(ownerGate(200, body), { status: "not_owner" }, JSON.stringify(body));
  }
  assert.deepEqual(ownerGate(401, null), { status: "auth" });
  // a 403 from PostgREST, a 5xx, a 204, or no answer at all (0): not a verdict on who he is
  for (const s of [0, 204, 403, 404, 500, 502, 503, 504]) assert.deepEqual(ownerGate(s, null), { status: "role_check_failed" }, String(s));
  const w = sendWindowText(7, 20);
  assert.deepEqual(decideResponse({ status: "auth" }, null, w),
    { code: 401, body: { ok: false, error: "auth", message: "Your login expired. Sign in again." } });
  assert.deepEqual(decideResponse({ status: "role_check_failed" }, null, w),
    { code: 503, body: { ok: false, error: "role_check_failed", message: "Couldn't check your login just now. Try again." } });
  assert.deepEqual(decideResponse({ status: "not_owner" }, null, w),
    { code: 403, body: { ok: false, error: "not_owner", message: "Approvals belong to the owner's login." } });
});

/* ---------- the spine lane (step 5): one YES across both queues ---------- */

const txt = (code, o = {}) => ({ code, status: "pending", label: `text-lane ${code}`, ...o });
/** A spine row as handleApproval reads it; by default the brief's reminder,
    which the brief texted (proposed_via 'cron'). */
const sp = (sms_code, o = {}) => ({ id: `sp-${sms_code}`, sms_code, status: "proposed", operation: "email.send@1",
  rationale: `spine ${sms_code}`, input: { to: "a@b.co", subject: "s", body: "b" }, proposed_via: "cron", ...o });
/** The job page's adjuster email: a spine ask no text ever offered. */
const ui = (sms_code, o = {}) => sp(sms_code, { proposed_via: "ui", rationale: "Claim documentation email to the adjuster for claim CLM-77 — Hebard", ...o });

test("a number names the one live ask that holds it, in whichever queue", () => {
  const text = [txt(12), txt(13)];
  const spine = [sp(4), sp(5)];
  const t = matchAcross(text, spine, "12");
  assert.deepEqual([t.lane, t.reason], ["text", "ok"]);
  assert.equal(t.hit, text[0], "the text-lane row goes on to decide() exactly as read");
  const s = matchAcross(text, spine, "04");
  assert.deepEqual([s.lane, s.reason], ["spine", "ok"]);
  assert.equal(s.hit, spine[0]);
  assert.deepEqual(matchAcross(text, spine, "99"), { lane: null, hit: null, reason: "no-such-code" });
  // only live rows count: a settled text row, an answered spine row, a spine row with no number
  assert.equal(matchAcross([txt(12, { status: "executed" })], [sp(4, { status: "executed" })], "4").reason, "none-open");
  assert.equal(matchAcross([txt(12)], [sp(4, { status: "executed" })], "4").reason, "no-such-code");
  assert.equal(matchAcross([], [sp(null)], null).reason, "none-open");
  assert.equal(matchAcross([], [], "12").reason, "none-open", "nothing live at all reads as today's 'nothing waiting'");
});

test("a number held in both queues is a code clash, and two text rows on one number stay ambiguous", () => {
  const m = matchAcross([txt(12)], [sp(12)], "12");
  assert.deepEqual(m, { lane: null, hit: null, reason: "code-clash" });
  assert.equal(matchAcross([txt(12), txt(12, { label: "twin" })], [sp(12)], "12").reason, "code-clash");
  assert.equal(matchAcross([txt(12), txt(12, { label: "twin" })], [], "12").reason, "ambiguous");
  assert.equal(matchAcross([], [sp(7), sp(7, { id: "dup" })], "7").reason, "ambiguous");
  assert.equal(replyText("code-clash", { code: 12 }),
    "Two asks share number 12 — answer this one from the Approvals tab in the office app.");
});

test("a bare YES acts only when exactly one ask is live across both queues", () => {
  assert.equal(matchAcross([txt(12)], [sp(4)], null).reason, "ambiguous");
  const one = matchAcross([txt(12, { status: "declined" })], [sp(4)], null);
  assert.deepEqual([one.lane, one.hit.sms_code, one.reason], ["spine", 4, "ok"]);
  assert.equal(matchAcross([txt(12)], [], null).lane, "text");
  // the text lane alone answers exactly as matchProposal always has
  for (const [rows, code] of [[[txt(12), txt(13)], "13"], [[txt(12)], null], [[txt(12), txt(13)], null], [[], "5"], [[txt(12)], "99"]]) {
    const a = matchAcross(rows, [], code), b = matchProposal(rows, code);
    assert.deepEqual([a.hit, a.reason], [b.hit, b.reason], JSON.stringify([rows.map((r) => r.code), code]));
  }
});

test("a bare YES or NO never acts on a spine ask no text offered; it names the ask and its number instead", () => {
  // the adjuster email alone: nothing runs, and the answer says which number does
  const only = ui(4);
  assert.deepEqual(matchAcross([], [only], null), { lane: null, hit: null, reason: "needs-number", ask: only });
  assert.equal(replyText("needs-number", { code: 4, label: spineLabel(only) }),
    'Reply YES 4 to approve "Claim documentation email to the adjuster for claim CLM-77 — Hebard" (or NO 4).');
  // a text-lane ask beside it: the bare YES is the text-lane ask's, as it was before step 5
  const t = matchAcross([txt(12)], [ui(4)], null);
  assert.deepEqual([t.lane, t.hit.code, t.reason], ["text", 12, "ok"]);
  // the brief's texted reminder beside it: the reminder's
  const c = matchAcross([], [ui(4), sp(5)], null);
  assert.deepEqual([c.lane, c.hit.sms_code, c.reason], ["spine", 5, "ok"]);
  // the brief's reminder alone: a bare YES is its answer
  const b = matchAcross([], [sp(5)], null);
  assert.deepEqual([b.lane, b.hit.sms_code, b.reason], ["spine", 5, "ok"]);
  // YES n still reaches the adjuster email, and every coded rule holds for it
  const n = matchAcross([txt(12)], [ui(4)], "4");
  assert.deepEqual([n.lane, n.hit.sms_code, n.hit.proposed_via, n.reason], ["spine", 4, "ui", "ok"]);
  assert.equal(matchAcross([txt(4)], [ui(4)], "4").reason, "code-clash");
  assert.equal(matchAcross([], [ui(4)], "9").reason, "no-such-code");
  // two offered asks, or two screen-only asks and nothing offered, demand the number
  assert.equal(matchAcross([txt(12)], [sp(5), ui(4)], null).reason, "ambiguous");
  assert.equal(matchAcross([], [ui(4), ui(6)], null).reason, "ambiguous");
  // a row read without proposed_via is not one a text offered
  assert.equal(matchAcross([], [sp(4, { proposed_via: undefined })], null).reason, "needs-number");
  // a settled or unnumbered screen ask is not live at all
  assert.equal(matchAcross([], [ui(4, { status: "executed" }), ui(null)], null).reason, "none-open");
});

test("only the brief's spine rows were offered by text", () => {
  assert.equal(offeredByText({ proposed_via: "cron" }), true);
  for (const via of ["ui", "chip", "agent", "sms", "mcp", "voice", "", null, undefined]) {
    assert.equal(offeredByText({ proposed_via: via }), false, String(via));
  }
  assert.equal(offeredByText(null), false);
});

test("GET /version answers the exact shape the brief and set-gmail-secret.sh read", () => {
  assert.equal(JSON.stringify(VERSION_ANSWER), '{"ok":true,"function":"roybal-notify","answers":["text","spine"]}');
  assert.ok(VERSION_ANSWER.answers.includes("spine"));
});

test("a spine row is called by its rationale's first line, else by what it would do", () => {
  assert.equal(spineLabel({ rationale: "email the INV-4 reminder to Hebard (5 days past due, $1,200.00 open)" }),
    "email the INV-4 reminder to Hebard (5 days past due, $1,200.00 open)");
  assert.equal(spineLabel({ rationale: "  Claim documentation email to the adjuster.  \nThe packet is linked." }),
    "Claim documentation email to the adjuster", "first line, trimmed, its period dropped (every reply adds one)");
  assert.equal(spineLabel({ rationale: "x".repeat(300) }).length, 160);
  assert.equal(Array.from(spineLabel({ rationale: "🔥".repeat(200) })).length, 160, "clipped by code point");
  const op = (operation, input, o = {}) => spineLabel({ operation, input, rationale: "", ...o });
  assert.equal(op("email.send@1", { to: "adj@carrier.com" }), "email adj@carrier.com");
  assert.equal(op("email.send@1", { to: "old@x.co" }, { edited_params: { to: "new@x.co" } }), "email new@x.co", "an edit is what runs");
  assert.equal(op("sms.send@1", { to: "+19075557777" }), "text +19075557777");
  assert.equal(op("job.set_stage@1", { stage: "scheduled" }, { rationale: null }), "move the job to scheduled");
  assert.equal(op("invoice.add_line@2", {}), "invoice.add_line");
  assert.equal(op("email.send@1", {}), "email.send", "no address to name: the operation");
  assert.equal(spineLabel({ rationale: " . " , operation: "sms.send@1", input: {} }), "sms.send");
  assert.equal(opName("email.send@1"), "email.send");
  assert.equal(opName(undefined), "");
});

/** The nightly billing check's ask (0021): money, filed proposed_via 'agent',
    its rationale's first line the dollar summary, then its limits. */
const GAPS_WHY = "Add 2 lines ($325.08, 1 unpriced) to Doe: dehu-days, labor hours";
const gaps = (sms_code, o = {}) => sp(sms_code, { operation: "invoice.review_gaps@1", proposed_via: "agent",
  rationale: `${GAPS_WHY}\nLimits: an internal leak check, not carrier-grade justification.`,
  input: { job_id: "j1", lines: [], total_usd: 325.08, unpriced_count: 1 }, ...o });

test("an invoice-gaps ask is the inbox's: both spine reads carry one filter that leaves it out", () => {
  assert.equal(INBOX_ONLY_FILTER, "&operation=not.like.invoice.review_gaps*");
  // it rides the query string as written: one more filter, nothing to encode
  const q = new URLSearchParams(`status=eq.proposed&sms_code=not.is.null${INBOX_ONLY_FILTER}&select=id`);
  assert.deepEqual([...q.keys()], ["status", "sms_code", "operation", "select"]);
  assert.equal(q.get("operation"), "not.like.invoice.review_gaps*", "PostgREST reads * as LIKE's %");
  assert.equal(encodeURIComponent(q.get("operation")), q.get("operation"));
});

test("an invoice-gaps row that ever reached the matcher is named by its dollar line, and a bare YES never runs it", () => {
  const g = gaps(7);
  assert.equal(offeredByText(g), false, "proposed_via 'agent': no text offered it");
  assert.equal(spineLabel(g), GAPS_WHY, "the first line; the limits stay in the inbox");
  assert.equal(spineLabel(gaps(7, { rationale: `${GAPS_WHY}.` })), GAPS_WHY);
  assert.equal(spineLabel(gaps(7, { rationale: "" })), "invoice.review_gaps", "no rationale: the operation");
  assert.ok(Array.from(spineLabel(gaps(7, { rationale: "x".repeat(400) }))).length <= 160);
  // a bare YES never runs it, alone or beside the asks a text did offer
  assert.equal(matchAcross([], [g], null).reason, "needs-number");
  const r = matchAcross([], [g, sp(4)], null);
  assert.deepEqual([r.lane, r.hit.sms_code, r.reason], ["spine", 4, "ok"], "the brief's reminder is the bare YES's");
  const t = matchAcross([txt(12)], [g], null);
  assert.deepEqual([t.lane, t.hit.code, t.reason], ["text", 12, "ok"]);
});

test("the owner's principal is exactly one owner profile", () => {
  const OWNER = "5b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
  assert.deepEqual(ownerPrincipal(200, [{ id: OWNER }]), { ok: true, id: OWNER });
  assert.deepEqual(ownerPrincipal(200, []), { ok: false, why: "no owner profile" });
  assert.deepEqual(ownerPrincipal(200, [{ id: OWNER }, { id: OWNER }]), { ok: false, why: "2 owner profiles, not one" });
  assert.equal(ownerPrincipal(200, [{ id: "owner" }]).ok, false, "only a uuid can name a principal");
  assert.equal(ownerPrincipal(200, [{}]).ok, false);
  assert.equal(ownerPrincipal(200, { id: OWNER }).ok, false, "a list, or nothing");
  assert.equal(ownerPrincipal(200, null).ok, false);
  for (const s of [0, 401, 404, 500, 503]) assert.equal(ownerPrincipal(s, [{ id: OWNER }]).ok, false, String(s));
});

test("the email lane is ready only on a 200 literal true, off only on a literal false", () => {
  assert.equal(emailLane(200, true), "ready");
  assert.equal(emailLane(200, false), "off");
  for (const b of ["true", 1, null, [true], {}]) assert.equal(emailLane(200, b), "unknown", JSON.stringify(b));
  for (const s of [0, 404, 500, 503]) assert.equal(emailLane(s, true), "unknown", String(s));
});

test("an email's outbox row reads three ways: sent, dead (and why), or still waiting", () => {
  assert.deepEqual(outboxState([{ status: "pending" }, { status: "sent" }]), { state: "sent" });
  assert.deepEqual(outboxState([{ status: "delivered" }]), { state: "sent" });
  assert.deepEqual(outboxState([{ status: "dead", error: "Gmail refused the address: 550 no such user" }]),
    { state: "dead", error: "Gmail refused the address: 550 no such user" });
  assert.deepEqual(outboxState([{ status: "dead", error: "  this email waited 50 hours in line, so it was not sent.  " }]),
    { state: "dead", error: "this email waited 50 hours in line, so it was not sent" }, "trimmed, its closing period dropped");
  assert.equal(outboxState([{ status: "dead", error: "x".repeat(400) }]).error.length, 160);
  assert.equal(Array.from(outboxState([{ status: "dead", error: "🔥".repeat(200) }]).error).length, 160, "clipped by code point");
  for (const error of [null, undefined, "", "   ", "."]) {
    assert.deepEqual(outboxState([{ status: "dead", error }]), { state: "dead", error: "it gave up" }, JSON.stringify(error));
  }
  // a sent row outranks a dead twin (one key per proposal, but the read allows five)
  assert.deepEqual(outboxState([{ status: "dead", error: "e" }, { status: "sent" }]), { state: "sent" });
  for (const r of [[], [{ status: "pending" }], [{ status: "sending" }], [{ status: "failed", error: "Gmail API 503" }],
    null, { status: "sent" }, { status: "dead" }, "dead"]) {
    assert.deepEqual(outboxState(r), { state: "waiting" }, JSON.stringify(r));
  }
});

test("a spine row someone already answered gets the sentence its status earns", () => {
  const now = "2026-10-06T18:00:00.000Z";
  const row = (o) => sp(4, { rationale: "email the INV-4 reminder to Hebard", ...o });
  const SENT = { state: "sent" }, WAITS = { state: "waiting" };
  const DEAD = { state: "dead", error: "Gmail refused the address: 550 no such user" };
  for (const status of ["approved", "executing", "executed"]) {
    assert.equal(spineLateText(row({ status }), now), "That one was already approved — email the INV-4 reminder to Hebard. It goes out once.");
    assert.equal(spineLateText(row({ status }), now, WAITS), "That one was already approved — email the INV-4 reminder to Hebard. It goes out once.");
    assert.equal(spineLateText(row({ status }), now, SENT), "That one was already approved — email the INV-4 reminder to Hebard. It went out once.");
    // still waiting with email sending off on the worker: no "it goes out once"
    assert.equal(spineLateText(row({ status }), now, WAITS, "off"),
      "That one was already approved — email the INV-4 reminder to Hebard. It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.");
    assert.equal(spineLateText(row({ status }), now, WAITS, "ready"), "That one was already approved — email the INV-4 reminder to Hebard. It goes out once.");
    assert.equal(spineLateText(row({ status }), now, SENT, "off"), "That one was already approved — email the INV-4 reminder to Hebard. It went out once.");
    assert.equal(spineLateText(row({ status }), now, DEAD),
      "That one was approved, but the email couldn't be sent: Gmail refused the address: 550 no such user. Nothing went out.");
  }
  assert.equal(spineLateText(row({ status: "executed" }), now, { state: "dead", error: "it gave up" }),
    "That one was approved, but the email couldn't be sent: it gave up. Nothing went out.");
  // only an email has an outbox row to have gone out by, or to have died
  assert.match(spineLateText(row({ status: "executed", operation: "job.set_stage@1" }), now, SENT), /It goes out once\.$/);
  assert.match(spineLateText(row({ status: "executed", operation: "job.set_stage@1" }), now, DEAD), /^That one was already approved — .*It goes out once\.$/);
  // the outbox says nothing about a row that was never approved
  assert.equal(spineLateText(row({ status: "declined" }), now, DEAD), "That one was declined — email the INV-4 reminder to Hebard. Nothing was sent.");
  assert.equal(spineLateText(row({ status: "declined" }), now), "That one was declined — email the INV-4 reminder to Hebard. Nothing was sent.");
  assert.equal(spineLateText(row({ status: "expired" }), now), "That one expired — email the INV-4 reminder to Hebard. Nothing was sent.");
  assert.equal(spineLateText(row({ status: "proposed", expires_at: "2026-10-06T17:59:59+00:00" }), now),
    "That one expired — email the INV-4 reminder to Hebard. Nothing was sent.", "a stale row stays 'proposed' until a sweep");
  assert.equal(spineLateText(row({ status: "proposed", expires_at: "2026-10-06T18:00:01Z" }), now), null, "still live: not late");
  assert.equal(spineLateText(row({ status: "failed", error: "outbox insert refused" }), now),
    "That one was approved, but it didn't run: outbox insert refused");
  assert.equal(spineLateText(row({ status: "superseded" }), now), null);
});

test("op_proposal_approve / _decline answers read as one outcome; the SQLSTATE decides, not the HTTP status", () => {
  const row = sp(4, { status: "executed", approved_via: "sms" });
  assert.deepEqual(spineVerdict("approve", 200, row), { status: "approved", row });
  assert.deepEqual(spineVerdict("approve", 200, [row]), { status: "approved", row }, "a one-element list is the row");
  const tapped = { ...row, approved_via: "inbox" };
  assert.deepEqual(spineVerdict("approve", 200, tapped), { status: "answered", row: tapped });
  assert.deepEqual(spineVerdict("approve", 200, { ...row, approved_via: null }).status, "answered");
  assert.deepEqual(spineVerdict("decline", 200, { ...row, status: "declined" }).status, "cancelled");
  assert.deepEqual(spineVerdict("decline", 200, row), { status: "already-answered" });
  const pg = (code, message) => ({ code, message, details: null, hint: null });
  assert.deepEqual(spineVerdict("approve", 500, pg("55000", "op spine: proposal x expired at 2026-10-05 18:00:00+00")), { status: "expired" });
  assert.deepEqual(spineVerdict("approve", 500, pg("55000", "op spine: proposal x is expired")), { status: "expired" });
  assert.deepEqual(spineVerdict("approve", 500, pg("55000", "op spine: proposal x is declined")), { status: "declined" });
  assert.deepEqual(spineVerdict("approve", 500, pg("55000", "op spine: proposal x is superseded")), { status: "closed" });
  assert.deepEqual(spineVerdict("decline", 500, pg("55000", "op spine: proposal x is executed; only a proposed row can be declined")),
    { status: "already-answered" });
  for (const [s, b] of [[403, pg("42501", "op spine: no")], [500, pg("P0002", "op spine: no proposal x")], [502, null],
    [200, null], [200, []], [200, [row, row]], [200, { status: "executed" }], [0, null]]) {
    assert.equal(spineVerdict("approve", s, b).status, "not-recorded", JSON.stringify([s, b]));
  }
  assert.match(spineVerdict("approve", 403, pg("42501", "op spine: no")).why, /42501/);
});

test("every spine answer has its exact text", () => {
  const a = { code: 4, label: "email the INV-4 reminder to Hebard" };
  const done = (o) => ({ status: "approved", row: sp(4, { status: "executed", approved_via: "sms", ...o }) });
  assert.equal(spineReply(done(), a, "YES", { lane: "ready" }), "✅ Approved — email the INV-4 reminder to Hebard. It's queued and goes out in a minute.");
  assert.equal(spineReply(done(), a, "YES", { lane: "off" }),
    "✅ Approved — email the INV-4 reminder to Hebard. It's queued, but email sending is off on the worker: " +
    "it waits up to 48 hours for that to come back, then it isn't sent.");
  // the worker kills an email older than EMAIL_MAX_AGE_HOURS: no reply promises an open-ended wait
  for (const lane of ["ready", "off", "unknown", undefined]) assert.doesNotMatch(spineReply(done(), a, "YES", { lane }), /until that's back/);
  assert.equal(spineReply(done(), a, "YES", { lane: "unknown" }), "✅ Approved — email the INV-4 reminder to Hebard. It's queued to send.");
  assert.equal(spineReply(done(), a, "YES"), "✅ Approved — email the INV-4 reminder to Hebard. It's queued to send.");
  assert.equal(spineReply(done({ operation: "sms.send@1" }), a, "YES", { lane: "ready" }), "✅ Approved — email the INV-4 reminder to Hebard. It's queued to send.");
  assert.equal(spineReply(done({ operation: "job.set_stage@1" }), a, "YES"), "✅ Done — email the INV-4 reminder to Hebard.");
  assert.equal(spineReply(done({ operation: "job.set_stage@1", status: "approved" }), a, "YES"), "✅ Approved — email the INV-4 reminder to Hebard. It's queued to run.");
  assert.equal(spineReply(done({ status: "failed", error: "outbox insert refused" }), a, "YES", { lane: "ready" }),
    "⚠️ Approved, but it didn't run — email the INV-4 reminder to Hebard: outbox insert refused");
  assert.match(spineReply(done({ status: "failed", error: "e".repeat(500) }), a, "YES"), /: e{200}$/);
  // approving never says "Done" for a message: it queued it
  assert.doesNotMatch(spineReply(done(), a, "YES", { lane: "ready" }), /Done/);
  const tapped = { status: "answered", row: sp(4, { status: "executed", approved_via: "inbox", rationale: a.label }) };
  assert.equal(spineReply(tapped, a, "YES"), "That one was already approved — email the INV-4 reminder to Hebard. It goes out once.");
  assert.equal(spineReply(tapped, a, "YES", { outbox: { state: "sent" } }), "That one was already approved — email the INV-4 reminder to Hebard. It went out once.");
  assert.equal(spineReply(tapped, a, "YES", { outbox: { state: "waiting" } }), "That one was already approved — email the INV-4 reminder to Hebard. It goes out once.");
  assert.equal(spineReply(tapped, a, "YES", { outbox: { state: "dead", error: "Gmail refused the address: 550" } }),
    "That one was approved, but the email couldn't be sent: Gmail refused the address: 550. Nothing went out.");
  assert.equal(spineReply({ status: "cancelled", row: sp(4) }, a, "NO"), "👍 Cancelled — email the INV-4 reminder to Hebard.");
  assert.equal(spineReply({ status: "already-answered" }, a, "NO"), "That one was already answered — nothing was cancelled.");
  assert.equal(spineReply({ status: "expired" }, a, "YES"), "That one expired — email the INV-4 reminder to Hebard. Nothing was sent.");
  assert.equal(spineReply({ status: "declined" }, a, "YES"), "That one was declined — email the INV-4 reminder to Hebard. Nothing was sent.");
  assert.equal(spineReply({ status: "closed" }, a, "YES"), "That one was already answered — nothing was sent.");
  assert.equal(spineReply({ status: "not-recorded", why: "x" }, a, "YES"), "Couldn't record that just now — text YES 4 again in a minute.");
  assert.equal(spineReply({ status: "not-recorded", why: "x" }, a, "NO"), "Couldn't record that just now — text NO 4 again in a minute.");
});

test("a late spine answer speaks for its number only when the spine row was answered after any text-lane ask on it was created", () => {
  const approved = sp(29, { status: "executed", approved_at: "2026-10-06T08:00:00Z", updated_at: "2026-10-06T08:00:01Z" });
  const declined = sp(29, { status: "declined", approved_at: null, updated_at: "2026-10-06T08:00:00Z" });
  const lapsed = sp(29, { status: "proposed", approved_at: null, updated_at: "2026-10-05T08:00:00Z", expires_at: "2026-10-06T08:00:00Z" });
  // when each was answered: the approval, else the lapse of a stale 'proposed' row, else its last update
  assert.equal(spineDecidedAt(approved), Date.parse("2026-10-06T08:00:00Z"));
  assert.equal(spineDecidedAt(declined), Date.parse("2026-10-06T08:00:00Z"));
  assert.equal(spineDecidedAt(lapsed), Date.parse("2026-10-06T08:00:00Z"));
  assert.ok(Number.isNaN(spineDecidedAt({ status: "declined" })));
  for (const row of [approved, declined, lapsed]) {
    assert.equal(spineOutranks(row, null), true, `${row.status}: no text-lane row, the spine answers`);
    assert.equal(spineOutranks(row, undefined), true);
    assert.equal(spineOutranks(row, { created_at: "2026-10-06T07:59:59Z" }), true, `${row.status}: the text row came first`);
    assert.equal(spineOutranks(row, { created_at: "2026-10-06T14:00:00Z" }), false, `${row.status}: minted on the freed number later`);
    assert.equal(spineOutranks(row, { created_at: "2026-10-06T08:00:00Z" }), false, `${row.status}: a tie is not "after"`);
    assert.equal(spineOutranks(row, { created_at: null }), false, "a text row with no readable time keeps the matcher's text");
  }
  assert.equal(spineOutranks({ status: "declined" }, { created_at: "2026-10-06T07:00:00Z" }), false, "nor a spine row with none");
});

test("a spine approval by text leaves the old lane's capture_events receipt, the one the Sunday report counts", () => {
  const now = "2026-10-06T18:00:00.000Z";
  const r = spineReceipt(sp(4, { status: "executed", approved_via: "sms" }), now);
  assert.deepEqual(r, {
    source_type: "assist_action", form_key: "email.send", captured_by: "approve-by-text",
    status: "extracted", processed_at: now,
    raw_payload: { proposal_id: "sp-4", via: "sms" },
    result: { status: "executed" },
  });
  assert.equal(spineReceipt(sp(5, { operation: "job.set_stage@1" }), now).form_key, "job.set_stage", "the operation without @version");
  // the report's own filter (weekly.ts): assist_action or email_send, captured_by approve-by-text
  assert.ok(["assist_action", "email_send"].includes(r.source_type) && r.captured_by === "approve-by-text");
});

console.log(`\n${pass} approve-by-text checks passed.`);
