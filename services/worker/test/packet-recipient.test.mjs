/* Who the carrier packet is suggested to (packet/recipient.mjs, design §12).

   recipient.mjs copies the field app's adjuster-email rules rather than
   importing them (adjustersend.js loads supa.js and config.js, which the
   worker image does not carry). This file does import the field module,
   which loads in Node without a browser, and holds the copy to it on every
   case the two are meant to agree on; then it checks what the packet adds:
   the address the last sent version went to, and skipping bounce senders
   and the connected mailbox. Data is made up. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRecipient, bareAddress, addressIn, isJunkSender, SPINE_TO } from "../packet/recipient.mjs";
import * as field from "../../../apps/field/js/adjustersend.js";
import { demoProject, DEMO_EMAILS, DEMO_ACCOUNT } from "./packet-demo.fixture.mjs";

const job = (extra = {}) => ({ customer: "Jane Sample", email: "jane.sample@example.com", adjuster: "", ...extra });
const mail = (from_addr, matched_by, received_at, direction = "in") => ({ direction, from_addr, matched_by, received_at });

/* cases with no bounce sender and no copy of our own mail: the two must agree */
const MIRROR = [
  ["nothing on file", job(), []],
  ["claim match wins over a newer plain match", job(), [
    mail("Alex Adjuster <adjuster@example.com>", "claim", "2026-10-03T18:00:00Z"),
    mail("other.person@example.org", "email", "2026-10-05T18:00:00Z"),
  ]],
  ["newest claim match of several", job(), [
    mail("first@example.com", "claim", "2026-10-01T18:00:00Z"),
    mail("second@example.com", "claim", "2026-10-04T18:00:00Z"),
  ]],
  ["no claim match: newest inbound", job(), [
    mail("older@example.org", "email", "2026-10-01T18:00:00Z"),
    mail("newer@example.org", "email", "2026-10-02T18:00:00Z"),
  ]],
  ["outbound rows never count", job(), [mail("someone@example.com", "claim", "2026-10-03T18:00:00Z", "out")]],
  ["the customer's own email is skipped", job({ adjuster: "Alex <adjuster@example.com>" }), [
    mail("Jane <JANE.SAMPLE@example.com>", "claim", "2026-10-06T18:00:00Z"),
  ]],
  ["mixed-case sender is lowered", job(), [mail("Desk <Claims.Desk@Example.COM>", "claim", "2026-10-03T18:00:00Z")]],
  ["junk-free row without a direction counts as inbound", job(), [{ from_addr: "nodir@example.com", matched_by: "email", received_at: "2026-10-03T18:00:00Z" }]],
  ["unparseable dates sort last", job(), [
    mail("nodate@example.com", "email", "not a date"),
    mail("dated@example.com", "email", "2026-10-01T18:00:00Z"),
  ]],
  ["adjuster field: the first address in free text", job({ adjuster: "Alex Adjuster (adjuster@example.com), backup b@example.com" }), []],
  ["adjuster field: trailing punctuation dropped", job({ adjuster: "email: 'adjuster@example.com'." }), []],
  ["adjuster field that is the customer's address", job({ adjuster: "jane.sample@example.com" }), []],
  ["adjuster field with no address", job({ adjuster: "Alex Adjuster, call 907-555-0101" }), []],
  ["a sender that is not an address falls to the adjuster field", job({ adjuster: "adjuster@example.com" }), [mail("Undisclosed recipients", "claim", "2026-10-03T18:00:00Z")]],
];

for (const [name, project, emails] of MIRROR) {
  test(`mirror of adjustersend.prefillTo: ${name}`, () => {
    const want = field.prefillTo(project, emails);
    const got = pickRecipient({ project, emails });
    assert.deepEqual({ to: got.to, source: got.source }, { to: want.to, source: want.source });
  });
}

test("copied helpers agree with the field module", () => {
  const samples = ["Jane <JANE@x.com>", "jane@x.com", "  'adj@example.com'. ", "a@b.c, d@e.f", "no address", "", null,
    "Alex Adjuster (adjuster@example.com)", "<bad@>", "x@y.z!"];
  for (const s of samples) {
    assert.equal(bareAddress(s), field.bareAddress(s), `bareAddress(${s})`);
    assert.equal(addressIn(s), field.addressIn(s), `addressIn(${s})`);
  }
  assert.equal(String(SPINE_TO), String(field.SPINE_TO));
});

test("the address the last sent version went to comes first", () => {
  const r = pickRecipient({ project: demoProject(), emails: DEMO_EMAILS, account: DEMO_ACCOUNT, lastSentTo: "Alex <Desk@Example.com>" });
  assert.deepEqual(r, { to: "desk@example.com", source: "last_sent" });
  // an unusable last address falls through to the email rules
  const r2 = pickRecipient({ project: demoProject(), emails: DEMO_EMAILS, lastSentTo: "not an address" });
  assert.equal(r2.source, "claim");
});

test("bounce and no-reply senders are skipped", () => {
  const emails = [
    mail("Mail Delivery Subsystem <MAILER-DAEMON@example.net>", "claim", "2026-10-06T18:00:00Z"),
    mail("no-reply@carrier.example.com", "claim", "2026-10-05T18:00:00Z"),
    mail("postmaster@example.net", "email", "2026-10-07T18:00:00Z"),
    mail("do-not-reply@example.org", "email", "2026-10-07T19:00:00Z"),
    mail("Alex Adjuster <adjuster@example.com>", "claim", "2026-10-01T18:00:00Z"),
  ];
  assert.deepEqual(pickRecipient({ project: job(), emails }), { to: "adjuster@example.com", source: "claim" });
  // the field rule would have picked the bounce: the packet's rule is stricter on purpose
  assert.equal(field.prefillTo(job(), emails).to, "mailer-daemon@example.net");
  assert.ok(isJunkSender("noreply@example.com"));
  assert.ok(isJunkSender("no-reply.claims@example.com"));
  assert.ok(!isJunkSender("noreen@example.com"));
  assert.ok(!isJunkSender("replies@example.com"));
});

test("a copy of our own email filed to the job is skipped", () => {
  const emails = [
    mail("Roybal Office <office@example.com>", "claim", "2026-10-06T18:00:00Z"),
    mail("adjuster@example.com", "email", "2026-10-02T18:00:00Z"),
  ];
  assert.deepEqual(pickRecipient({ project: job(), emails, account: DEMO_ACCOUNT }), { to: "adjuster@example.com", source: "email" });
  assert.deepEqual(pickRecipient({ project: job(), emails, account: { email: "OFFICE@example.com" } }), { to: "adjuster@example.com", source: "email" });
  // without the account it is the newest claim match
  assert.equal(pickRecipient({ project: job(), emails }).to, "office@example.com");
});

test("only junk on file falls back to the job's Adjuster field, then to nothing", () => {
  const emails = [mail("mailer-daemon@example.net", "claim", "2026-10-06T18:00:00Z")];
  assert.deepEqual(pickRecipient({ project: job({ adjuster: "Alex (adjuster@example.com)" }), emails }), { to: "adjuster@example.com", source: "adjuster" });
  assert.deepEqual(pickRecipient({ project: job(), emails }), { to: "", source: "" });
  assert.deepEqual(pickRecipient(), { to: "", source: "" });
});

test("the demo job suggests the claim-matched adjuster, not the newer bounce", () => {
  const r = pickRecipient({ project: demoProject(), emails: DEMO_EMAILS, account: DEMO_ACCOUNT });
  assert.deepEqual(r, { to: "adjuster@example.com", source: "claim" });
});
