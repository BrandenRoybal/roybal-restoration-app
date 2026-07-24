/* ============================================================
   Weekly "what the AI did" report — pure builder (no Deno/network)
   ------------------------------------------------------------
   Every Sunday morning the owner gets ONE text summarizing what the
   operations brain actually DID during the week — every automated
   action leaves a capture_events receipt, and this reads them back.
   Deterministic, LLM-free, unit-tested (weekly.test.mjs).
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

const money = (n: number) => "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface WeeklyInput {
  events: Blob[];            // capture_events rows from the last 7 days
  emailsFiled: number;       // inbound email_messages in the window
  emailsSent: number;        // outbound email_messages in the window
  weekLabel: string;         // "Jul 18 – Jul 24"
}

/** One SMS-sized week-in-review. */
export function buildWeekly({ events, emailsFiled, emailsSent, weekLabel }: WeeklyInput) {
  const by = (t: string) => events.filter((e) => e?.source_type === t);
  const lines: string[] = [];

  // 💰 payments the QuickBooks loop recorded
  const payRuns = by("qbo_payments");
  const payments = payRuns.flatMap((e) => (e.result?.payments as Blob[]) || []);
  const payTotal = payments.reduce((a, p) => a + n(p.amount), 0);
  if (payments.length) {
    lines.push(`💰 recorded ${payments.length} payment${payments.length === 1 ? "" : "s"} from QuickBooks — ${money(payTotal)}` +
      (payments.some((p) => p.paidInFull) ? ` (${payments.filter((p) => p.paidInFull).length} paid in full)` : ""));
  }

  // 📧 the email lane
  if (emailsFiled || emailsSent) {
    const bits = [];
    if (emailsFiled) bits.push(`filed ${emailsFiled} job email${emailsFiled === 1 ? "" : "s"}`);
    if (emailsSent) bits.push(`sent ${emailsSent} you approved`);
    lines.push(`📧 ${bits.join(", ")}`);
  }

  // ✅ chips + approve-by-text the owner confirmed (assistant-executed writes)
  const chipRuns = events.filter((e) => ["assist_action", "email_send"].includes(String(e?.source_type)));
  const approved = chipRuns.filter((e) => e.captured_by === "approve-by-text").length;
  if (approved) lines.push(`✅ ${approved} action${approved === 1 ? "" : "s"} approved by text from the truck`);

  // ☀️ briefs + scans that ran on schedule
  const briefs = by("daily_brief").length;
  const scans = by("email_pull").length;
  const ops: string[] = [];
  if (briefs) ops.push(`${briefs} morning brief${briefs === 1 ? "" : "s"}`);
  if (payRuns.length) ops.push(`${payRuns.length} payment check${payRuns.length === 1 ? "" : "s"}`);
  if (scans) ops.push(`${scans} inbox scan${scans === 1 ? "" : "s"}`);
  if (ops.length) lines.push(`🤖 on schedule: ${ops.join(", ")}`);

  // 📞 after-hours calls the receptionist took
  const calls = by("phone_call").length;
  if (calls) lines.push(`📞 answered ${calls} after-hours call${calls === 1 ? "" : "s"}`);

  const head = `🗞️ Roybal week in review — ${weekLabel}`;
  if (!lines.length) {
    return { text: `${head}\nQuiet week: the automations ran, nothing needed your attention.`, items: 0 };
  }
  return { text: [head, ...lines].join("\n").slice(0, 1200), items: lines.length };
}
