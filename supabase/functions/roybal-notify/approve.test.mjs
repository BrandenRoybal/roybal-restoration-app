/* Approve-by-text rules — unit tests (no Deno, no network).
   Run: node --experimental-strip-types approve.test.mjs */
import assert from "node:assert/strict";
import {
  parseApproval, matchProposal, stillLive, proposalLine, replyText,
  validateBoardEdit, buildNextSubtasks, revGuard,
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

console.log(`\n${pass} approve-by-text checks passed.`);
