/* The website lead's email alert (leadmail.ts) and how roybal-lead files it.
   Run: node --experimental-strip-types supabase/functions/_shared/leadmail.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  alertRecipients, akWhen, leadAlertEmail, leadAlertRows,
  LEAD_ALERT_OPERATION, DEFAULT_LEAD_ALERT_TO, ADMIN_URL,
} from "./leadmail.ts";
// the worker builds the message from these rows; its own checks must pass them
import { buildRfc822, validAddresses } from "../../../services/worker/rfc822.mjs";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };

const LEAD = {
  id: "0b5e8c1e-6f0a-4d6e-9a43-2f1c7e5d9a10",
  customer: "Jane Sample",
  phone: "(907) 555-0142",
  email: "jane.sample@example.com",
  address: "123 Example St, North Pole, AK",
  service: "Water Damage Restoration",
  message: "Water heater let go overnight.\nCarpet in two bedrooms is soaked.",
  emergency: false,
  createdAt: "2026-10-21T17:32:50.000Z",
};

await test("recipients: unset is the owner, a list is lowercased and deduped, off is none", () => {
  assert.deepEqual(alertRecipients(undefined), { to: [DEFAULT_LEAD_ALERT_TO], rejected: 0 });
  assert.deepEqual(alertRecipients("   "), { to: [DEFAULT_LEAD_ALERT_TO], rejected: 0 });
  assert.deepEqual(alertRecipients("Branden@RoybalConstruction.com, me@example.com; me@example.com"),
    { to: ["branden@roybalconstruction.com", "me@example.com"], rejected: 0 });
  assert.deepEqual(alertRecipients("off"), { to: [], rejected: 0 });
  assert.deepEqual(alertRecipients("OFF"), { to: [], rejected: 0 });
  assert.deepEqual(alertRecipients("not-an-address, me@example.com"), { to: ["me@example.com"], rejected: 1 });
  assert.deepEqual(alertRecipients("nope"), { to: [], rejected: 1 });
});

await test("the received stamp is Alaska time with its zone, daylight and standard", () => {
  assert.equal(akWhen("2026-10-21T17:32:50.000Z"), "Wed, Oct 21, 2026, 9:32 AM AKDT");
  assert.equal(akWhen("2026-12-02T03:05:00.000Z"), "Tue, Dec 1, 2026, 6:05 PM AKST");
  assert.equal(akWhen(""), "");
  assert.equal(akWhen("not a date"), "");
});

await test("the email carries every field the form sent, the message word for word, and the lead's link", () => {
  const { subject, body } = leadAlertEmail(LEAD);
  assert.equal(subject, "New web lead: Jane Sample — Water Damage Restoration");
  for (const want of [
    "Received: Wed, Oct 21, 2026, 9:32 AM AKDT",
    "Name: Jane Sample",
    "Phone: (907) 555-0142",
    "Email: jane.sample@example.com",
    "Address: 123 Example St, North Pole, AK",
    "Service requested: Water Damage Restoration",
    "Their message:\nWater heater let go overnight.\nCarpet in two bedrooms is soaked.",
    ADMIN_URL + "#/leads/0b5e8c1e-6f0a-4d6e-9a43-2f1c7e5d9a10",
  ]) assert.ok(body.includes(want), "missing: " + want);
  assert.ok(!/EMERGENCY/.test(body));
});

await test("an emergency says so in the subject and the first line", () => {
  const { subject, body } = leadAlertEmail({ ...LEAD, emergency: true });
  assert.match(subject, /^🚨 EMERGENCY web lead: Jane Sample/);
  assert.match(body.split("\n")[0], /ACTIVE EMERGENCY/);
});

await test("blank fields say not given; a form sent without a message says so", () => {
  const { subject, body } = leadAlertEmail({ id: "x1", customer: "Sam", phone: "9075550100", createdAt: LEAD.createdAt });
  assert.equal(subject, "New web lead: Sam");
  assert.ok(body.includes("Email: not given"));
  assert.ok(body.includes("Address: not given"));
  assert.ok(!body.includes("Service requested"));
  assert.ok(body.includes("(none: they sent their contact details only)"));
});

await test("a line break typed into a field cannot start a header or a fake field line", () => {
  const sneaky = { ...LEAD, customer: "Eve\r\nBcc: victim@example.com", address: "1 Main\nPhone: 000", service: "Mold\r\nX: y" };
  const { subject, body } = leadAlertEmail(sneaky);
  assert.ok(!/[\r\n]/.test(subject));
  assert.equal(subject, "New web lead: Eve Bcc: victim@example.com — Mold X: y");
  assert.ok(body.includes("Address: 1 Main Phone: 000"));
  assert.ok(!/^Phone: 000/m.test(body));
  // control characters dropped from the message, its line breaks kept
  const m = leadAlertEmail({ ...LEAD, message: "one\u0007\r\ntwo\u0000" }).body;
  assert.ok(m.includes("Their message:\none\ntwo\n"));
});

await test("one outbox row per address, keyed to the lead and the address, for the email lane", () => {
  const rows = leadAlertRows(LEAD, ["branden@roybalconstruction.com", "me@example.com"]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.channel, "email");
    assert.equal(r.operation, LEAD_ALERT_OPERATION);
    assert.equal(r.principal_kind, "system");
    assert.deepEqual(Object.keys(r.payload).sort(), ["body", "subject", "to"]);
  }
  assert.equal(rows[0].payload.to, "branden@roybalconstruction.com");
  assert.equal(rows[0].idempotency_key, "lead-alert:" + LEAD.id + ":branden@roybalconstruction.com");
  assert.equal(rows[1].idempotency_key, "lead-alert:" + LEAD.id + ":me@example.com");
  assert.deepEqual(leadAlertRows(LEAD, []), []);
});

await test("the worker's email lane would send the row as it is: a valid to, a subject, a body, one clean header block", () => {
  const [row] = leadAlertRows({ ...LEAD, customer: "Eve\r\nBcc: victim@example.com" }, ["branden@roybalconstruction.com"]);
  const p = row.payload;
  assert.ok(validAddresses(p.to));
  assert.ok(p.subject && p.body);
  const { raw } = buildRfc822({ to: p.to, from: "branden@roybalconstruction.com", subject: p.subject, body: p.body });
  const head = raw.split("\r\n\r\n")[0];
  assert.ok(!/^Bcc:/mi.test(head));
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);   // the em dash makes it encoded
  assert.equal(head.split("\r\n").filter((l) => l.startsWith("To: ")).length, 1);
});

await test("roybal-lead files the email after the lead is saved, only while the email lane is up, capped per hour", () => {
  const src = readFileSync(new URL("../roybal-lead/index.ts", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/_shared\/leadmail\.ts"/);
  const insert = src.indexOf("/rest/v1/coordination_jobs`");
  const call = src.indexOf("emailOwner({");
  assert.ok(insert > 0 && call > insert, "the email is filed after the lead insert");
  const fn = src.slice(src.indexOf("async function emailOwner"), src.indexOf("const LOSS_TYPES"));
  assert.ok(fn.indexOf("rpc/outbox_channel_ready") > 0, "asks whether the email lane is up");
  assert.ok(fn.indexOf("rpc/outbox_channel_ready") < fn.indexOf("rest/v1/outbox?on_conflict"), "before filing");
  assert.match(fn, /EMAIL_HOURLY_MAX \* to\.length/);
  assert.match(fn, /resolution=ignore-duplicates/);
  // never fatal: the visitor's answer does not wait on Gmail going right
  assert.match(src, /emailOwner\(\{[^)]*\}\)\s*\.catch\(/);
});

console.log(`leadmail: ${pass} passed`);
