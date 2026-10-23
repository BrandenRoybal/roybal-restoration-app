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
  const ask = src.indexOf("const mailCheck = emailTargets()");
  const call = src.indexOf("emailOwner(forMail, m.to)");
  // asked before the text decision (a screened lead texts when no email can go), filed after the insert
  assert.ok(ask > 0 && ask < src.indexOf("alertPlan({") && ask < insert, "whether an email can go is asked first");
  assert.ok(insert > 0 && call > insert, "the email is filed after the lead insert");
  const fn = src.slice(src.indexOf("async function emailTargets"), src.indexOf("const LOSS_TYPES"));
  assert.ok(fn.indexOf("rpc/outbox_channel_ready") > 0, "asks whether the email lane is up");
  assert.ok(fn.indexOf("rpc/outbox_channel_ready") < fn.indexOf("rest/v1/outbox?on_conflict"), "before filing");
  assert.match(fn, /EMAIL_HOURLY_MAX \* to\.length/);
  assert.match(fn, /resolution=ignore-duplicates/);
  // never fatal: the visitor's answer does not wait on Gmail going right
  assert.match(src, /emailOwner\(forMail, m\.to\)\s*\.catch\(/);
  assert.match(src, /const mailCheck = emailTargets\(\)\.catch\(/);
  // the decision waits for the email check at most 5 seconds
  assert.match(src, /Promise\.race\(\[mailCheck, new Promise<null>\(\(r\) => \{ waiting = setTimeout\(\(\) => r\(null\), 5000\); \}\)\]\)/);
});

await test("roybal-lead texts on the plan, and a repeat counts only an earlier lead that texted", () => {
  const src = readFileSync(new URL("../roybal-lead/index.ts", import.meta.url), "utf8");
  assert.match(src, /plan\.text \? sms\(\)/);
  // texted is the delivery, not the plan: saved false, stamped true once a text went
  assert.match(src, /\n    texted: false,\n/);
  assert.ok(src.indexOf("rpc/coordination_job_patch") > src.indexOf("const [textedNow, textedLater]"), "stamped after the texts");
  assert.match(src, /if \(textedNow \+ textedLater > 0\)/);
  const repeats = src.match(/countSince\(`data->>source=eq\.web[^`]*`, REPEAT_WINDOW_MS\)/g) ?? [];
  assert.equal(repeats.length, 2);
  for (const r of repeats) assert.ok(r.includes("data->>texted=eq.true"), r);
  // the flag goes after the customer's message, so the office app still reads the form's lines
  assert.ok(src.indexOf("(flag ? `\\n\\n${flag}` : \"\")") > src.indexOf("(message ? `\\n${message}` : \"\")"));
});

const REASONS = ["fake phone number (555-0142 is reserved for movies/TV)", "address is out of state (CA)"];

await test("a screened lead: tagged subject, the reasons on top, and the last line says no text went", () => {
  const { subject, body } = leadAlertEmail({ ...LEAD, screen: { kind: "scam", reasons: REASONS }, texted: false });
  assert.equal(subject, "[Likely spam] New web lead: Jane Sample — Water Damage Restoration");
  const lines = body.split("\n");
  assert.equal(lines[0], "🚩 Auto-screened as LIKELY SPAM. Why:");
  assert.equal(lines[1], "  - " + REASONS[0]);
  assert.equal(lines[2], "  - " + REASONS[1]);
  assert.ok(body.includes("If this is a real customer, just work it like any other lead."));
  assert.match(lines[lines.length - 1], /No text was sent for this one/);
  const p = leadAlertEmail({ ...LEAD, screen: { kind: "solicitation", reasons: ["toll-free number (800)"] }, texted: false });
  assert.match(p.subject, /^\[Sales pitch\] New web lead: /);
  assert.equal(p.body.split("\n")[0], "🚩 Auto-screened as a SALES PITCH, not a customer. Why:");
});

await test("a screened emergency that texted, and a repeat: the subject and the last line match what happened", () => {
  const e = leadAlertEmail({ ...LEAD, emergency: true, screen: { kind: "scam", reasons: REASONS }, texted: true });
  assert.match(e.subject, /^\[Likely spam\] 🚨 EMERGENCY web lead: Jane Sample/);
  assert.match(e.body.split("\n").pop(), /The same lead went to you by text/);
  const r = leadAlertEmail({ ...LEAD, repeat: true, texted: false });
  assert.match(r.subject, /^\[Repeat\] New web lead: /);
  assert.match(r.body.split("\n")[0], /^Repeat: this phone or email already came in/);
  assert.match(r.body.split("\n").pop(), /No text was sent for this one/);
});

await test("no screen, repeat or texted: byte for byte the email it always was", () => {
  const plain = leadAlertEmail(LEAD);
  assert.deepEqual(leadAlertEmail({ ...LEAD, texted: true }), plain);
  assert.ok(plain.body.startsWith("New lead from the website form.\n"));
  assert.match(plain.body.split("\n").pop(), /The same lead went to you by text/);
});

await test("a reason cannot add a line or a header", () => {
  const { subject, body } = leadAlertEmail({ ...LEAD, screen: { kind: "scam", reasons: ["x\r\nBcc: victim@example.com", "y\nPhone: 000"] }, texted: false });
  assert.ok(!/[\r\n]/.test(subject));
  assert.ok(body.includes("  - x Bcc: victim@example.com"));
  assert.ok(!/^Bcc:/m.test(body) && !/^Phone: 000/m.test(body));
});

console.log(`leadmail: ${pass} passed`);
