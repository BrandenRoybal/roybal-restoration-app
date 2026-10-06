/* Approve-by-text rules — unit tests (no Deno, no network), plus the pure
   half of the Approvals inbox's decidePending (request check, answers).
   The order decide() runs in is tested in decide.test.mjs.
   Run: node --experimental-strip-types approve.test.mjs */
import assert from "node:assert/strict";
import {
  parseApproval, matchProposal, stillLive, proposalLine, replyText,
  validateBoardEdit, buildNextSubtasks, revGuard,
  hourLabel, inSendWindow, sendWindowText, quietHoursHold, replyFor,
  parseDecideRequest, decideResponse, ownerGate,
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
  assert.equal(parseApproval("yes send the hansen one").yes, false);   // free text ≠ approval
  assert.equal(parseApproval("can you check on the Hebert job?").yes, false);
  assert.equal(parseApproval("").yes, false);
});

test("NO / STOP / CANCEL parse as declines", () => {
  assert.deepEqual(parseApproval("no 12"), { yes: false, no: true, code: "12" });
  assert.deepEqual(parseApproval("STOP"), { yes: false, no: true, code: null });
  assert.deepEqual(parseApproval("cancel 4"), { yes: false, no: true, code: "4" });
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

const phase = (name, id = "p-new") => ({ id, name, durationDays: null, lagDays: 0, estimatedHours: 5.2, crewIds: [] });
const edit = (over = {}) => ({ op: "addPhase", rowId: "job-1", phase: phase("Punch list"), entryIds: ["e1"], ...over });

test("a well-formed addPhase proposal validates", () => {
  const v = validateBoardEdit(edit());
  assert.equal(v.rowId, "job-1");
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
  const after = { ...a, status: "executed", result: { rowId: "job-1", skipped: "phase already exists" } };
  assert.equal(decideResponse({ status: "executed" }, a, w, after).body.message, skip);
  // a phase that was added is Done
  assert.equal(decideResponse({ status: "executed" }, a, w, { ...a, status: "executed", result: { rowId: "job-1", rev: 4 } }).body.message,
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

console.log(`\n${pass} approve-by-text checks passed.`);
