/* ============================================================
   Financial math — pure module (no DOM, no imports)
   ------------------------------------------------------------
   The invoice/estimate totals ladder EXACTLY as the invoice
   editor computes it (forms.js recalc): line subtotal → O&P
   (pct or fixed $; contract billing folds O&P into the agreed
   figure) → RCV → tax on the base → minus deductible and
   previous payments. Shared by the office assistant's confirm
   chips so a chip's confirmation math never drifts from what
   the editor shows. Also: the budget-vs-estimate flag.
   ============================================================ */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const ESTIMATE_STATUSES = ["draft", "pending_approval", "approved", "rejected"];
export const INVOICE_STATUSES = ["sent", "viewed", "partially_paid", "paid", "void"];
export const LINE_TYPES = ["replace", "tearout", "detach_reset", "labor"];

/** Σ qty × price over line items (the editor's "Line Item Total"). */
export function lineSubtotal(items) {
  return (items || []).reduce((a, it) => a + num(it && it.qty) * num(it && it.price), 0);
}

/** The full totals ladder for an invoice/estimate record (forms.js parity):
    T&M: base = line subtotal, O&P from pct or fixed $; contract: base = the
    agreed contractAmount, O&P inside it. tax rides the base. */
export function invoiceTotals(inv) {
  const subtotal = lineSubtotal(inv.items);
  const contract = inv.billingModel === "contract";
  const amtMode = inv.opMode === "amount";
  const base = contract ? num(inv.contractAmount) : subtotal;
  const overhead = contract ? 0 : (amtMode ? num(inv.overheadAmount) : subtotal * (num(inv.overheadPct) / 100));
  const profit = contract ? 0 : (amtMode ? num(inv.profitAmount) : subtotal * (num(inv.profitPct) / 100));
  const rcv = base + overhead + profit;
  const tax = base * (num(inv.taxRate) / 100);
  const total = rcv + tax - num(inv.deductible) - num(inv.previousPayments);
  return { subtotal, base, overhead, profit, rcv, tax, total };
}

/** money for chip text: 1234.5 → "$1,234.50" */
export const money = (n) =>
  "$" + (Math.round(num(n) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- budget vs estimate (the budgetAlert flag) ----------
   Logged costs = structured job receipts + AI-recognized receipt
   attachments on invoices/estimates (never the imported pricing
   source — that's the estimate itself, not spend). The budget
   base is the strongest approved figure we have: an approved
   estimate's total, else the job's contract amount. */
export function loggedCosts(p) {
  let sum = 0;
  for (const r of p.receipts || []) sum += num(r && r.amount);
  for (const key of ["invoices", "reconEstimates"]) {
    for (const inv of p[key] || []) {
      for (const att of (inv && inv.attachments) || []) {
        if (!att || !att.ai || att.isPricingSource) continue;
        sum += num(att.ai.totalAmount);
      }
    }
  }
  return sum;
}

export function budgetBase(p) {
  const approved = (p.reconEstimates || []).filter((e) => e && e.status === "approved");
  if (approved.length) return Math.max(...approved.map((e) => invoiceTotals(e).total));
  const contract = num(p.contractAmount);
  return contract > 0 ? contract : null;
}

/** null when there's nothing to compare against; otherwise
    { costs, base, pct, over } — over = costs exceed threshold × base. */
export function budgetStatus(p, threshold = 0.9) {
  const base = budgetBase(p);
  if (base == null || base <= 0) return null;
  const costs = loggedCosts(p);
  const pct = costs / base;
  return { costs, base, pct: Math.round(pct * 100), over: pct > threshold };
}
