/* Email-lane matching + RFC-2822 rules — unit tests (no Deno, no network).
   Run: node --experimental-strip-types emailmatch.test.mjs */
import assert from "node:assert/strict";
import { matchEmailToJob, addressOf, buildRfc822, extractText, headerOf } from "./emailmatch.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const JOBS = [
  { id: "p1", customer: "Jeff Hebard", email: "jeff.hebard@gmail.com", claimNo: "CL-88421" },
  { id: "p2", customer: "Ana Diaz", email: "", claimNo: "77-1002-X" },
  { id: "p3", customer: "Sam Rowe", email: "sam@rowe.com", claimNo: "" },
  { id: "p4", customer: "Old Job", email: "old@x.com", claimNo: "CL-1", archivedAt: "2026-01-01" },
];

test("addressOf handles display names, bare addresses, garbage", () => {
  assert.equal(addressOf('Jeff Hebard <Jeff.Hebard@Gmail.com>'), "jeff.hebard@gmail.com");
  assert.equal(addressOf("sam@rowe.com"), "sam@rowe.com");
  assert.equal(addressOf("no address here"), "");
});

test("sender = customer email on file → match", () => {
  const m = matchEmailToJob({ from: "Jeff <jeff.hebard@gmail.com>", subject: "hi", text: "" }, JOBS);
  assert.deepEqual(m, { projectId: "p1", matchedBy: "customer-email" });
});

test("claim # in the subject → match, tolerant of formatting", () => {
  const m = matchEmailToJob({ from: "adjuster@bigco.com", subject: "RE: claim 77 1002 X — Diaz loss", text: "" }, JOBS);
  assert.deepEqual(m, { projectId: "p2", matchedBy: "claim" });
});

test("claim # buried in the body still matches", () => {
  const m = matchEmailToJob({ from: "someone@carrier.com", subject: "docs needed", text: "Regarding CL-88421, please send the drying logs." }, JOBS);
  assert.deepEqual(m, { projectId: "p1", matchedBy: "claim" });
});

test("customer full name in the subject → match; single word never does", () => {
  const m = matchEmailToJob({ from: "x@y.com", subject: "Sam Rowe kitchen schedule", text: "" }, JOBS);
  assert.deepEqual(m, { projectId: "p3", matchedBy: "customer-name" });
  assert.equal(matchEmailToJob({ from: "x@y.com", subject: "Sam called", text: "" }, JOBS), null);
});

test("no match → null (the email never enters the app)", () => {
  assert.equal(matchEmailToJob({ from: "spam@list.com", subject: "50% off shingles", text: "buy now" }, JOBS), null);
});

test("ambiguity refuses to file", () => {
  const twins = [...JOBS, { id: "p5", customer: "Jeff Hebard", email: "other@x.com", claimNo: "" }];
  assert.equal(matchEmailToJob({ from: "x@y.com", subject: "Jeff Hebard estimate", text: "" }, twins), null);
});

test("archived jobs never match", () => {
  assert.equal(matchEmailToJob({ from: "old@x.com", subject: "", text: "" }, JOBS), null);
});

test("short claim numbers can't false-match", () => {
  // CL-1 normalizes to "CL1" (3 chars) — below the 4-char floor
  const m = matchEmailToJob({ from: "x@y.com", subject: "cl1 misc", text: "" }, [{ id: "px", customer: "X", claimNo: "CL-1" }]);
  assert.equal(m, null);
});

test("buildRfc822: headers, threading, base64url with no padding", () => {
  const { raw, base64url } = buildRfc822({
    to: "adjuster@carrier.com", from: "branden@roybalconstruction.com",
    subject: "Hebard — drying logs", body: "Logs attached below.\n— Roybal",
    inReplyTo: "<abc@mail.gmail.com>",
  });
  assert.match(raw, /^From: branden@roybalconstruction\.com\r\n/);
  assert.match(raw, /To: adjuster@carrier\.com/);
  assert.match(raw, /In-Reply-To: <abc@mail\.gmail\.com>/);
  assert.match(raw, /References: <abc@mail\.gmail\.com>/);
  assert.doesNotMatch(base64url, /[+/=]/);
  // subject newline injection can't mint a new header LINE (it flattens
  // into the subject text, which is harmless)
  const inj = buildRfc822({ to: "a@b.c", from: "x@y.z", subject: "hi\r\nBcc: evil@x.com", body: "" });
  assert.doesNotMatch(inj.raw, /\r\nBcc:/);
  assert.match(inj.raw, /Subject: hi Bcc: evil@x\.com/);
});

test("extractText: text/plain part wins; html falls back stripped", () => {
  const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const plain = { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/html", body: { data: b64url("<b>bold</b>") } },
    { mimeType: "text/plain", body: { data: b64url("just text") } },
  ] };
  assert.equal(extractText(plain), "just text");
  const htmlOnly = { mimeType: "text/html", body: { data: b64url("<p>Hello <b>there</b>&nbsp;friend</p>") } };
  assert.equal(extractText(htmlOnly), "Hello there friend");
});

test("headerOf is case-insensitive", () => {
  const payload = { headers: [{ name: "Message-ID", value: "<m1@x>" }, { name: "SUBJECT", value: "s" }] };
  assert.equal(headerOf(payload, "message-id"), "<m1@x>");
  assert.equal(headerOf(payload, "Subject"), "s");
});

console.log(`\n${pass} email-lane checks passed.`);
