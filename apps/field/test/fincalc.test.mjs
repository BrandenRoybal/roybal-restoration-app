/* fincalc.js — the office assistant's money math. The totals ladder must
   match the invoice editor's recalc() (forms.js) exactly: line subtotal →
   O&P (pct/amount; contract folds O&P into the agreed figure) → RCV →
   tax on the base → minus deductible and previous payments. Plus the
   budget-vs-estimate flag behind the digest's over-budget attention line.
   Run: node test/fincalc.test.mjs */
import assert from "node:assert/strict";
import {
  lineSubtotal, invoiceTotals, money, loggedCosts, budgetBase, budgetStatus,
  ESTIMATE_STATUSES, INVOICE_STATUSES, LINE_TYPES,
} from "../js/fincalc.js";

let pass = 0;
function test(name, fn) { fn(); console.log("  ✓ " + name); pass++; }

const items = [
  { room: "Kitchen", desc: "drywall hang", qty: "10", unit: "SF", price: "2.5" },   // 25
  { room: "", desc: "labor", qty: "4", unit: "HR", price: "85" },                   // 340
];

test("lineSubtotal: qty × price over string fields, garbage → 0", () => {
  assert.equal(lineSubtotal(items), 365);
  assert.equal(lineSubtotal([{ qty: "x", price: "5" }, null]), 0);
  assert.equal(lineSubtotal([]), 0);
  assert.equal(lineSubtotal(undefined), 0);
});

test("T&M with % O&P: editor parity (base=subtotal, tax on base)", () => {
  const inv = { items, billingModel: "tm", opMode: "pct", overheadPct: "10", profitPct: "10", taxRate: "5", deductible: "100", previousPayments: "50" };
  const t = invoiceTotals(inv);
  assert.equal(t.subtotal, 365);
  assert.equal(t.overhead, 36.5);
  assert.equal(t.profit, 36.5);
  assert.equal(t.rcv, 438);
  assert.equal(t.tax, 18.25);
  assert.equal(Math.round(t.total * 100) / 100, 306.25);   // 438 + 18.25 − 100 − 50
});

test("T&M with fixed-$ O&P (amount mode)", () => {
  const inv = { items, opMode: "amount", overheadAmount: "40", profitAmount: "60" };
  const t = invoiceTotals(inv);
  assert.equal(t.overhead, 40);
  assert.equal(t.profit, 60);
  assert.equal(t.total, 465);
});

test("contract billing: the agreed amount IS the base, O&P inside it", () => {
  const inv = { items, billingModel: "contract", contractAmount: "5000", opMode: "pct", overheadPct: "10", profitPct: "10", taxRate: "2" };
  const t = invoiceTotals(inv);
  assert.equal(t.base, 5000);
  assert.equal(t.overhead, 0);
  assert.equal(t.profit, 0);
  assert.equal(t.tax, 100);
  assert.equal(t.total, 5100);
});

test("money formats for chip text", () => {
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money("bad"), "$0.00");
});

test("loggedCosts: receipts + AI receipt attachments, never the pricing source", () => {
  const p = {
    receipts: [{ vendor: "Spenard", amount: 200 }, { vendor: "HD", amount: "50.5" }],
    invoices: [{ attachments: [
      { ai: { totalAmount: 100 } },
      { ai: { totalAmount: 9999 }, isPricingSource: true },   // the imported Xactimate — not spend
      { label: "no ai digest" },
    ] }],
    reconEstimates: [{ attachments: [{ ai: { totalAmount: 25 } }] }],
  };
  assert.equal(loggedCosts(p), 375.5);
  assert.equal(loggedCosts({}), 0);
});

test("budgetBase: strongest approved estimate wins, else contractAmount, else null", () => {
  const est = (status, price) => ({ status, items: [{ qty: "1", price: String(price) }], opMode: "pct", overheadPct: "0", profitPct: "0" });
  assert.equal(budgetBase({ reconEstimates: [est("approved", 1000), est("approved", 3000), est("draft", 9000)] }), 3000);
  assert.equal(budgetBase({ contractAmount: "8000" }), 8000);
  assert.equal(budgetBase({ reconEstimates: [est("draft", 9000)] }), null);
  assert.equal(budgetBase({}), null);
});

test("budgetStatus: over only past the threshold; null without a base", () => {
  const p = { contractAmount: "1000", receipts: [{ amount: 800 }] };
  const b = budgetStatus(p, 0.9);
  assert.equal(b.over, false);
  assert.equal(b.pct, 80);
  p.receipts.push({ amount: 150 });
  const b2 = budgetStatus(p, 0.9);
  assert.equal(b2.over, true);
  assert.equal(b2.pct, 95);
  assert.equal(budgetStatus({ receipts: [{ amount: 500 }] }), null);
});

test("status enums match the spec", () => {
  assert.deepEqual(ESTIMATE_STATUSES, ["draft", "pending_approval", "approved", "rejected"]);
  assert.deepEqual(INVOICE_STATUSES, ["sent", "viewed", "partially_paid", "paid", "void"]);
  assert.deepEqual(LINE_TYPES, ["replace", "tearout", "detach_reset", "labor"]);
});

console.log(`\n${pass} fincalc checks passed.`);
