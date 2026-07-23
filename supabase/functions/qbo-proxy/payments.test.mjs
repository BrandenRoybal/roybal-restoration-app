/* QBO payment-sync rules — unit tests (no Deno, no network).
   Run: node --experimental-strip-types payments.test.mjs */
import assert from "node:assert/strict";
import { applyBalanceToInvoice, trackedInvoices } from "./payments.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
const TODAY = "2026-07-23";

test("first sight, nothing paid: baseline only, no phantom payment", () => {
  const r = applyBalanceToInvoice({ invoiceNo: "INV-1", status: "sent" }, { totalAmt: 5000, balance: 5000 }, TODAY);
  assert.equal(r.event, null);
  assert.equal(r.changed, true);                       // bookkeeping (qboBalance) initialized
  assert.equal(r.inv.qboBalance, 5000);
  assert.equal(r.inv.status, "sent");
  assert.equal(r.inv.payments, undefined);
});

test("first sight with QBO already part-paid and NO local records: payment recorded", () => {
  const r = applyBalanceToInvoice({ invoiceNo: "INV-2", status: "sent" }, { totalAmt: 5000, balance: 3000 }, TODAY);
  assert.equal(r.event.amount, 2000);
  assert.equal(r.event.paidInFull, false);
  assert.equal(r.inv.status, "partially_paid");
  assert.deepEqual(r.inv.payments, [{ amount: 2000, date: TODAY, method: "QuickBooks" }]);
  assert.equal(r.inv.previousPayments, 2000);
});

test("first sight of a hand-reconciled invoice: ADOPT the balance, never double-count", () => {
  const inv = { invoiceNo: "INV-3", status: "partially_paid", previousPayments: 2000,
    payments: [{ amount: 2000, date: "2026-07-01", method: "check" }] };
  const r = applyBalanceToInvoice(inv, { totalAmt: 5000, balance: 3000 }, TODAY);
  assert.equal(r.event, null);                         // office already recorded that $2,000
  assert.equal(r.inv.qboBalance, 3000);
  assert.equal(r.inv.previousPayments, 2000);
  assert.equal(r.inv.payments.length, 1);
});

test("subsequent balance drop: exact delta recorded, paid at zero", () => {
  const inv = { invoiceNo: "INV-4", status: "partially_paid", qboBalance: 3000, previousPayments: 2000,
    payments: [{ amount: 2000, date: "2026-07-01", method: "QuickBooks" }] };
  const r = applyBalanceToInvoice(inv, { totalAmt: 5000, balance: 0 }, TODAY);
  assert.equal(r.event.amount, 3000);
  assert.equal(r.event.paidInFull, true);
  assert.equal(r.inv.status, "paid");
  assert.equal(r.inv.previousPayments, 5000);
  assert.equal(r.inv.payments.length, 2);
});

test("unchanged balance: no write (no rev churn)", () => {
  const r = applyBalanceToInvoice({ invoiceNo: "INV-5", status: "sent", qboBalance: 5000 }, { totalAmt: 5000, balance: 5000 }, TODAY);
  assert.equal(r.changed, false);
  assert.equal(r.event, null);
});

test("void invoices are never touched", () => {
  assert.equal(applyBalanceToInvoice({ status: "void" }, { totalAmt: 100, balance: 0 }, TODAY), null);
});

test("zero balance on an unpaid invoice flips status even without a delta", () => {
  // e.g. adopted baseline was already 0 but status never advanced
  const r = applyBalanceToInvoice({ invoiceNo: "INV-6", status: "sent", qboBalance: 0,
    payments: [{ amount: 5000, date: "2026-07-01", method: "check" }], previousPayments: 5000 },
  { totalAmt: 5000, balance: 0 }, TODAY);
  assert.equal(r.inv.status, "paid");
  assert.equal(r.event.paidInFull, true);
  assert.equal(r.event.amount, 0);
});

test("a balance INCREASE (invoice edited up in QBO) records nothing", () => {
  const r = applyBalanceToInvoice({ invoiceNo: "INV-7", status: "sent", qboBalance: 3000 }, { totalAmt: 6000, balance: 6000 }, TODAY);
  assert.equal(r.event, null);
  assert.equal(r.inv.qboBalance, 6000);                // baseline follows; future drops are exact
  assert.equal(r.changed, true);
});

test("cents survive rounding", () => {
  const r = applyBalanceToInvoice({ invoiceNo: "INV-8", status: "sent", qboBalance: 1000.10 }, { totalAmt: 1000.10, balance: 0.03 }, TODAY);
  assert.equal(r.inv.payments[0].amount, 1000.07);
  assert.equal(r.inv.status, "partially_paid");        // 3 cents outstanding is still outstanding
});

test("trackedInvoices: only pushed, non-void, not settled-and-known", () => {
  const p = { invoices: [
    { invoiceNo: "A", qboInvoiceId: "1", status: "sent" },
    { invoiceNo: "B", status: "sent" },                              // never pushed
    { invoiceNo: "C", qboInvoiceId: "3", status: "void" },           // void
    { invoiceNo: "D", qboInvoiceId: "4", status: "paid", qboBalance: 0 },   // settled + known
    { invoiceNo: "E", qboInvoiceId: "5", status: "paid" },           // paid by hand — still verify once
  ] };
  assert.deepEqual(trackedInvoices(p).map((i) => i.invoiceNo), ["A", "E"]);
  assert.deepEqual(trackedInvoices({}), []);
});

console.log(`\n${pass} payment-sync checks passed.`);
