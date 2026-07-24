/* Weekly report builder — unit tests (no Deno, no network).
   Run: node --experimental-strip-types weekly.test.mjs */
import assert from "node:assert/strict";
import { buildWeekly } from "./weekly.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
const base = { events: [], emailsFiled: 0, emailsSent: 0, weekLabel: "Jul 18 – Jul 24" };

test("quiet week reads calm, not broken", () => {
  const w = buildWeekly(base);
  assert.match(w.text, /Quiet week/);
  assert.equal(w.items, 0);
});

test("payments roll up with a dollar total and paid-in-full count", () => {
  const w = buildWeekly({ ...base, events: [
    { source_type: "qbo_payments", result: { payments: [
      { amount: 5000, paidInFull: true }, { amount: 1200.4, paidInFull: false }] } },
    { source_type: "qbo_payments", result: { payments: [{ amount: 800, paidInFull: true }] } },
  ] });
  assert.match(w.text, /💰 recorded 3 payments from QuickBooks — \$7,000 \(2 paid in full\)/);
});

test("email lane + schedule + calls + text approvals all report", () => {
  const w = buildWeekly({
    ...base, emailsFiled: 9, emailsSent: 4,
    events: [
      ...Array.from({ length: 7 }, () => ({ source_type: "daily_brief" })),
      ...Array.from({ length: 12 }, () => ({ source_type: "email_pull" })),
      { source_type: "email_send", captured_by: "approve-by-text" },
      { source_type: "email_send", captured_by: "branden@roybalconstruction.com" },
      { source_type: "phone_call" },
    ],
  });
  assert.match(w.text, /📧 filed 9 job emails, sent 4 you approved/);
  assert.match(w.text, /✅ 1 action approved by text/);
  assert.match(w.text, /🤖 on schedule: 7 morning briefs, 12 inbox scans/);
  assert.match(w.text, /📞 answered 1 after-hours call/);
  assert.ok(w.text.length <= 1200);
});

console.log(`\n${pass} weekly checks passed.`);
