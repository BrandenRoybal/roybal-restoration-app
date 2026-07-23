/* ============================================================
   QBO payment sync — pure rules (no Deno, no network)
   ------------------------------------------------------------
   Every night the proxy asks QuickBooks for the Balance on each
   invoice the app pushed. This module decides what that balance
   MEANS for the app's copy of the invoice — so the rules can be
   unit-tested from Node (node --experimental-strip-types
   payments.test.mjs), exactly like the brief's digest.ts.

   The invariants:
   • QuickBooks Balance is the ground truth for money RECEIVED.
     A balance drop since the last look = a payment; we append it
     to payments[] (method "QuickBooks"), grow previousPayments,
     and move status forward (partially_paid → paid). Never void,
     never backward.
   • NEVER double-count the office's hand-recorded payments: the
     first time we see an invoice that already carries recorded
     payments, we ADOPT the current QBO balance as the baseline
     instead of recording the historical difference. From then on
     deltas are exact.
   • A run that learns nothing new writes nothing (no rev churn).
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Inv = Record<string, any>;

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface QboBalance { totalAmt: number; balance: number }
export interface PaymentEvent { amount: number; paidInFull: boolean }

/** Apply one QBO balance reading to one invoice. Returns null when the
    invoice must not be touched (void), else the updated copy, whether a
    write is warranted, and the payment event (if any) for the audit trail
    and the morning brief. `todayISO` is the ALASKA calendar date. */
export function applyBalanceToInvoice(inv: Inv, qbo: QboBalance, todayISO: string):
  { inv: Inv; changed: boolean; event: PaymentEvent | null } | null {
  if (!inv || inv.status === "void") return null;
  const bal = round2(num(qbo.balance));
  const total = round2(num(qbo.totalAmt));

  const prevRaw = Number(inv.qboBalance);
  const prevBal = Number.isFinite(prevRaw) ? round2(prevRaw) : null;
  const handRecorded = (inv.payments || []).length > 0 || num(inv.previousPayments) > 0;
  // first sight of a hand-reconciled invoice: adopt, don't re-record history
  const baseline = prevBal != null ? prevBal : (handRecorded ? bal : total);

  const delta = round2(baseline - bal);
  const out: Inv = { ...inv, qboBalance: bal, qboBalanceAt: todayISO };
  let event: PaymentEvent | null = null;

  if (delta > 0.005) {
    out.payments = [...(inv.payments || []), { amount: delta, date: todayISO, method: "QuickBooks" }];
    out.previousPayments = round2(num(inv.previousPayments) + delta);
    out.status = bal <= 0.005 ? "paid" : "partially_paid";
    event = { amount: delta, paidInFull: bal <= 0.005 };
  } else if (bal <= 0.005 && total > 0 && inv.status !== "paid") {
    out.status = "paid";                 // zero balance however it got there
    event = { amount: 0, paidInFull: true };
  }

  const changed = event != null || prevBal == null || prevBal !== bal;
  return { inv: out, changed, event };
}

/** Which invoices on a project are worth asking QuickBooks about. */
export function trackedInvoices(projectData: Inv): Inv[] {
  return (projectData?.invoices || []).filter((inv: Inv) =>
    inv && inv.qboInvoiceId && inv.status !== "void" &&
    !(inv.status === "paid" && Number(inv.qboBalance) === 0));
}
