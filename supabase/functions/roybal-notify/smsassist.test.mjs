/* The SMS channel rules — unit tests (no Deno, no network).
   Run: node --experimental-strip-types --test supabase/functions/roybal-notify/smsassist.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  smsAssistEnabled, assistSender, TEXT_EXECUTABLE_KINDS, mintCodes, pendingRowsFor,
  plainText, approvalLine, composeSmsReply, failureText,
} from "./smsassist.ts";

test("the flag is on unless explicitly off — the roadmap's rollback is SMS_ASSIST_ENABLED=false", () => {
  assert.equal(smsAssistEnabled(undefined), true);
  assert.equal(smsAssistEnabled(""), true);
  assert.equal(smsAssistEnabled("true"), true);
  assert.equal(smsAssistEnabled("false"), false);
  assert.equal(smsAssistEnabled(" OFF "), false);
  assert.equal(smsAssistEnabled("0"), false);
});

test("only the owner's number resolves; formatting differences don't matter", () => {
  const env = { ownerCell: "+19075551234", forwardTo: "+19075559999" };
  assert.equal(assistSender("+19075551234", env), "owner");
  assert.equal(assistSender("907-555-1234", env), "owner");
  assert.equal(assistSender("+19075559999", env), null, "SMS_FORWARD_TO is the fallback, not a second owner");
  assert.equal(assistSender("+19075550000", env), null);
  assert.equal(assistSender("", env), null);
  assert.equal(assistSender("+19075559999", { forwardTo: "+19075559999" }), "owner", "falls back to SMS_FORWARD_TO when OWNER_CELL is unset — as handleApproval does");
  assert.equal(assistSender("+19075551234", {}), null, "no owner configured = nobody is the owner");
});

test("codes skip everything live in the shared queue and start at 11", () => {
  assert.deepEqual(mintCodes([], 2), [11, 12]);
  assert.deepEqual(mintCodes([11, "12", 14], 3), [13, 15, 16]);
  assert.deepEqual(mintCodes(["garbage", null], 1), [11]);
  assert.deepEqual(mintCodes([], 0), []);
});

test("only kinds the approval executor can run are minted", () => {
  const proposals = [
    { type: "sendText", label: "Text Mike he's on Kertzmann tomorrow", params: { to: "+19075550001", message: "You're on Kertzmann tomorrow, 7am.", audience: "crew" } },
    { type: "boardWrite", label: "Move Hansen to Thursday", params: { job: "Hansen", startDate: "2026-09-17" } },
    { type: "sendText", label: "Text Sarah the ETA", params: { to: "+19075550002", message: "On our way, 20 min.", audience: "customer" } },
  ];
  assert.ok(TEXT_EXECUTABLE_KINDS.has("sendText"));
  assert.ok(!TEXT_EXECUTABLE_KINDS.has("boardWrite"), "a board write from a text is J3's job, not J0's");
  const rows = pendingRowsFor(proposals, mintCodes([11], 2));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.code), [12, 13]);
  assert.deepEqual(rows.map((r) => r.kind), ["sendText", "sendText"]);
  assert.equal(rows[0].proposed_by, "sms-assist");
  assert.equal(rows[0].params.to, "+19075550001");
  assert.equal(rows[1].label, "Text Sarah the ETA");
  assert.equal(rows[0].job_id, null);
  // fewer codes than proposals = fewer rows, never an undefined code
  assert.equal(pendingRowsFor(proposals, [11]).length, 1);
});

test("markdown is flattened for SMS", () => {
  assert.equal(plainText("**Two** things:\n- Hansen slips to Thu\n- Mike is *free*\n\n`done`"), "Two things: Hansen slips to Thu Mike is *free* done");
  assert.equal(plainText("## Heading\ntext"), "Heading text");
  assert.equal(plainText("   "), "");
});

test("the reply carries the approval lines, whole, inside 320 characters", () => {
  const rows = [{ code: 14, label: "text Mike he's on Kertzmann tomorrow" }];
  const short = composeSmsReply("Sure — here's the text for Mike.", rows);
  assert.equal(short, "Sure — here's the text for Mike.\nText YES 14 to text Mike he's on Kertzmann tomorrow");
  assert.equal(approvalLine(rows[0]), "Text YES 14 to text Mike he's on Kertzmann tomorrow");

  const long = composeSmsReply("word ".repeat(120), rows);
  assert.ok(Array.from(long).length <= 320, `fits two segments (${long.length})`);
  assert.ok(long.endsWith("Text YES 14 to text Mike he's on Kertzmann tomorrow"), "the code line is the last thing and is intact");
  assert.ok(long.includes("…\n"), "the answer, not the code, is what got cut");

  // no proposals: the answer alone, cut if it must be
  const plain = composeSmsReply("x".repeat(400), []);
  assert.equal(Array.from(plain).length, 320);
  assert.ok(plain.endsWith("…"));

  // an empty answer with a proposal still tells the owner what to do
  assert.equal(composeSmsReply("", rows), "Proposal ready.\nText YES 14 to text Mike he's on Kertzmann tomorrow");
  assert.equal(composeSmsReply("", []), "I didn't get an answer back — try again.");
});

test("emoji never split at the cut", () => {
  const emoji = "🔥".repeat(400);
  const out = composeSmsReply(emoji, []);
  assert.ok(Array.from(out).every((ch) => ch === "🔥" || ch === "…"), "no half-surrogates");
});

test("failure texts exist for every outcome the I/O layer can hit", () => {
  for (const k of ["capped", "error", "disabled"]) assert.ok(failureText(k).length > 20, k);
});

/* ---------- the I/O layer's posture, read from the source ----------
   index.ts cannot be imported here (Deno module with a top-level serve),
   so — as authgate.test.mjs does — the security-relevant shape is asserted
   against the text. A failure here is a posture regression. */
const here = dirname(fileURLToPath(import.meta.url));
const notifySrc = readFileSync(join(here, "index.ts"), "utf8");
const officeSrc = readFileSync(join(here, "..", "roybal-ai-office", "index.ts"), "utf8");

test("the SMS turn only runs for the resolved owner, after the signature check and the YES/NO early return", () => {
  const sig = notifySrc.indexOf("twilioSignatureValid(req, params)");
  const approval = notifySrc.indexOf("await handleApproval(from, text, admin)");
  const assist = notifySrc.indexOf('assistSender(from, {');
  assert.ok(sig > 0 && approval > sig && assist > approval, "signature → approval → assist, in that order");
  assert.match(notifySrc, /smsAssistEnabled\(Deno\.env\.get\("SMS_ASSIST_ENABLED"\)\)/, "the rollback flag is honoured");
  assert.match(notifySrc, /=== "owner"/, "only the owner gets a turn");
});

test("the office function's cron-secret door admits exactly one action on one surface", () => {
  const door = officeSrc.slice(officeSrc.indexOf("x-cron-secret"), officeSrc.indexOf("x-cron-secret") + 900);
  assert.match(door, /action !== "fieldAssist"/, "fieldAssist only");
  assert.match(door, /app !== "sms"/, "the sms surface only");
  assert.match(door, /SERVICE_KEY/, "runs as the service role, paired correctly (isNewFormatKey)");
  // and the surface itself can only propose what a YES can execute
});

test("the sms surface proposes only what approve-by-text can execute", async () => {
  const { ACTIONSETS, TOOLSETS, PERSONAS } = await import("../_shared/personas/index.ts");
  assert.deepEqual(ACTIONSETS.sms, [...TEXT_EXECUTABLE_KINDS]);
  assert.ok(TOOLSETS.sms.length >= 5, "the owner by text reads what the owner at the desk reads");
  assert.match(PERSONAS.sms, /YES/, "the register knows approval is by YES <code>");
});
