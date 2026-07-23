/* Morning-brief digest — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/roybal-brief/digest.test.mjs */
import assert from "node:assert/strict";
import { buildBrief, budgetStatus, daysBefore } from "./digest.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const TODAY = "2026-07-23";
const base = { today: TODAY, pretty: "Thu, Jul 23", portalWaiting: null, boardJobs: [], projects: [] };
const proj = (o) => ({ customer: "Henderson", _rowUpdated: TODAY + "T08:00:00Z", ...o });

test("quiet day: friendly all-clear, zero flags", () => {
  const b = buildBrief({ ...base, projects: [proj({})] });
  assert.equal(b.flags, 0);
  assert.match(b.text, /All quiet: 1 jobs on file/);
});

test("overdue invoices: chip-tracked only, oldest first, balance shown", () => {
  const b = buildBrief({ ...base, projects: [proj({
    invoices: [
      { invoiceNo: "INV-1", status: "sent", dueDate: "2026-07-10", items: [{ qty: "1", price: "5000" }] },
      { invoiceNo: "INV-2", status: "paid", dueDate: "2026-07-01", items: [{ qty: "1", price: "9000" }] },   // paid → ignored
      { invoiceNo: "INV-3", dueDate: "2026-06-01", items: [{ qty: "1", price: "7000" }] },                    // no status (hand-typed) → ignored
    ],
  })] });
  assert.match(b.text, /💵 1 overdue: INV-1 Henderson \$5,000 \(13d\)/);
  assert.doesNotMatch(b.text, /INV-2|INV-3/);
});

test("budget-hot rides the approved estimate; questions surface missing drying logs", () => {
  const b = buildBrief({ ...base, projects: [proj({
    reconEstimates: [{ status: "approved", items: [{ qty: "1", price: "1000" }], opMode: "pct", overheadPct: "0", profitPct: "0" }],
    receipts: [{ amount: 950 }],
    dryingLogs: [{ date: "2026-07-20", equipment: [{ placed: "2026-07-10" }] }],   // gear out, no log in 3 days
  })] });
  assert.match(b.text, /📈 budget hot: Henderson at 95%/);
  assert.match(b.text, /🌀 equipment out 7d\+/);
  assert.match(b.text, /❓ No drying log since 07-20 on Henderson — is the crew on it\?/);
  assert.ok(b.flags >= 3);
});

test("board slips + materials near start + portal count", () => {
  const b = buildBrief({ ...base, portalWaiting: 2, boardJobs: [
    { title: "Doe — water", stage: "in_progress", targetDate: "2026-07-20" },
    { title: "Smith — remodel", stage: "scheduled", startDate: "2026-07-25", materials: "none" },
    { title: "Done job", stage: "done", targetDate: "2026-01-01" },                 // done → ignored
    { title: "Far out", stage: "scheduled", startDate: "2026-08-20", materials: "none" }, // >3d → ignored
  ] });
  assert.match(b.text, /📅 past target: Doe — water/);
  assert.doesNotMatch(b.text, /Done job|Far out/);
  assert.match(b.text, /🧱 starts soon, materials not ordered: Smith — remodel/);
  assert.match(b.text, /📨 2 customer portal messages waiting/);
});

test("stale jobs become questions, capped at 3 questions total", () => {
  const stale = (n) => proj({ customer: "Stale" + n, _rowUpdated: "2026-06-01T00:00:00Z" });
  const b = buildBrief({ ...base, projects: [stale(1), stale(2)] });
  assert.match(b.text, /❓ Stale1 untouched 52d — on hold, or done and unclosed\?/);
  const qCount = (b.text.match(/❓/g) || []).length;
  assert.ok(qCount <= 3);
});

test("payments the loop recorded yesterday/today show as 💰 received", () => {
  const b = buildBrief({ ...base, projects: [proj({
    invoices: [
      { invoiceNo: "INV-1", status: "paid", payments: [{ amount: 5000, date: "2026-07-23", method: "QuickBooks" }] },
      { invoiceNo: "INV-2", status: "partially_paid", payments: [{ amount: 1200.5, date: "2026-07-22", method: "QuickBooks" }] },
      { invoiceNo: "INV-3", status: "paid", payments: [{ amount: 900, date: "2026-07-10", method: "QuickBooks" }] },   // old → ignored
      { invoiceNo: "INV-4", status: "paid", payments: [{ amount: 700, date: "2026-07-23", method: "check" }] },        // hand-recorded → ignored
    ],
  })] });
  assert.match(b.text, /💰 received: INV-1 Henderson \$5,000 — PAID IN FULL/);
  assert.match(b.text, /INV-2 Henderson \$1,201/);   // brief money() rounds to whole dollars
  assert.doesNotMatch(b.text, /INV-3|INV-4/);
});

test("text stays under the 1200-char cap even with many flags", () => {
  const many = Array.from({ length: 40 }, (_, i) => proj({
    customer: "Job" + i,
    invoices: [{ invoiceNo: "INV-1", status: "sent", dueDate: "2026-07-01", items: [{ qty: "1", price: "1000" }] }],
  }));
  const b = buildBrief({ ...base, projects: many });
  assert.ok(b.text.length <= 1200);
});

test("helpers: daysBefore + budgetStatus null without a base", () => {
  assert.equal(daysBefore(TODAY, "2026-07-20"), 3);
  assert.equal(daysBefore(TODAY, "garbage"), null);
  assert.equal(budgetStatus({ receipts: [{ amount: 500 }] }), null);
});

console.log(`\n${pass} digest checks passed.`);
