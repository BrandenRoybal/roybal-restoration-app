/* Approve-by-text rules — unit tests (no Deno, no network).
   Run: node --experimental-strip-types approve.test.mjs */
import assert from "node:assert/strict";
import { parseApproval, matchProposal, stillLive, proposalLine, replyText } from "./approve.ts";

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

console.log(`\n${pass} approve-by-text checks passed.`);
