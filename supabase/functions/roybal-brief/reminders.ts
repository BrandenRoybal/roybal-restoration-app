/* ============================================================
   Morning brief — the overdue-invoice reminder lane, pure rules
   (no Deno, no network)
   ------------------------------------------------------------
   Spine step 5: the reminder the brief offers becomes an email.send
   proposal in the Approvals inbox, where approving it sends it once
   (op_proposal_approve writes one keyed outbox row; the worker sends).
   The old lane stays as the fallback and the rollback: one
   pending_actions emailSend row, sent through gmail-proxy on a YES.
   index.ts does the I/O; every decision about which lane a reminder
   takes, and what the owner is offered, lives here so it is
   Node-testable (node --test --experimental-strip-types
   reminders.test.mjs).

   The rules, in one paragraph: a reminder goes on the spine only when
   REMINDERS_LANE allows it, the worker's email lane is live
   (outbox_channel_ready('email') answers true) and op_propose takes it;
   a definite refusal (a 4xx), an address the spine's schema would
   refuse, or a job id that isn't a uuid files the old row exactly as
   before. A filing that failed on the network or with a 5xx may still
   have landed, so that reminder waits for tomorrow instead of risking
   a second ask for one invoice. A permission refusal (42501) says the
   brief's spine identity is broken, so nothing more is offered that
   day on either lane. Every reminder sits in exactly one queue: the
   7-day "already asked about this invoice" check reads both queues in
   every lane state, and offers nothing when either read fails or the
   brief's login doesn't resolve to its agent (rpc/current_agent_id),
   because then RLS hides its own proposals and the read comes back
   empty instead of failing.
   ============================================================ */

import { invoiceTotals, money, type Blob } from "./digest.ts";

export type Lane = "spine" | "text";

/** REMINDERS_LANE (a roybal-brief secret): unset/blank or "spine" = the
    spine, falling back to the old lane by itself; "text" = always the old
    pending_actions row (the roadmap's rollback). Anything else reads as
    "text" with `unknown` set so index.ts can log it: a typo lands on the
    lane that worked before step 5, never on the new one. */
export function remindersLane(raw: string | undefined | null): { lane: Lane; unknown: boolean } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "" || v === "spine") return { lane: "spine", unknown: false };
  return { lane: "text", unknown: v !== "text" };
}

/** rpc/outbox_channel_ready {"p_channel":"email"} (migration 0019). Only a
    200 that answers literally true means an approved email would go out
    now; a 404 before 0019, an error, or any other body is "not ready". */
export function laneReady(status: number, body: unknown): boolean {
  return status === 200 && body === true;
}

/* The statuses that mean "this invoice already has its ask this week".
   A declined or failed reminder is offered again the next morning, as it
   always was on the old lane. An expired spine reminder is held: it is
   the old lane's unanswered row, which keeps status 'pending' (nothing
   sweeps pending_actions) for the whole window, while op_propose sweeps
   an ignored proposal to 'expired' a day later. */
const PENDING_HOLDS = ["pending", "approved", "executed"];
const SPINE_HOLDS = ["proposed", "approved", "executing", "executed", "expired"];

/** rpc/current_agent_id (0019) under the brief's login: may the 7-day
    check trust the proposals read? Yes when it answers the brief's
    agents id (a uuid), or 404 before 0019 (no spine rows can exist then).
    A null (agent:brief disabled, or its login no longer linked) means RLS
    hides the brief's own proposals and the read answers [] instead of
    failing; that, an error or no answer offers no reminder that day. */
export function agentKnown(status: number, body: unknown): boolean {
  if (status === 404) return true;
  return status === 200 && typeof body === "string" && UUID.test(body);
}

/** The dedupe key of one invoice — `<field project id>:<invoice no | id>`,
    the formula the old rows carry as params.invoiceKey and the spine rows
    as evidence_refs {kind: "invoice", id}. */
export const invoiceKey = (p: Blob, inv: Blob) => `${p.id}:${inv.invoiceNo || inv.id || ""}`;

/** The invoices already asked about in the last 7 days, from both queues:
    pending_actions emailSend rows (params.invoiceKey) and the brief's own
    email.send proposals (evidence_refs {kind: "invoice", id}; RLS returns
    only its own after 0019, none before). Null when either read did not
    answer a list — the brief then offers no reminder that day, because a
    blind check would ask about the same invoice in a second queue. */
export function remindedKeys(pending: unknown, spine: unknown): Set<string> | null {
  if (!Array.isArray(pending) || !Array.isArray(spine)) return null;
  const keys = new Set<string>();
  for (const a of pending) {
    const k = a && PENDING_HOLDS.includes(a.status) ? String(a.params?.invoiceKey || "") : "";
    if (k) keys.add(k);
  }
  for (const r of spine) {
    if (!r || !SPINE_HOLDS.includes(r.status)) continue;
    for (const ref of Array.isArray(r.evidence_refs) ? r.evidence_refs : []) {
      if (ref && typeof ref === "object" && ref.kind === "invoice" && ref.id != null && String(ref.id)) {
        keys.add(String(ref.id));
      }
    }
  }
  return keys;
}

export type Candidate = { p: Blob; inv: Blob; key: string; days: number; balance: number };

/** Today's reminders, at most 2: chip-tracked invoices (sent, viewed,
    partially paid) past due in Alaska terms, on jobs with a customer email,
    not already asked about, oldest-overdue first. The two oldest are picked
    before the balance check, so a paid-off one leaves its slot empty — the
    brief has always counted it that way. */
export function reminderCandidates(projects: Blob[], today: string, reminded: Set<string>): Candidate[] {
  const out: Omit<Candidate, "balance">[] = [];
  for (const p of projects) {
    if (!String(p.email || "").includes("@")) continue;
    for (const inv of Array.isArray(p.invoices) ? p.invoices : []) {
      if (!["sent", "viewed", "partially_paid"].includes(inv?.status)) continue;
      if (!inv.dueDate || inv.dueDate >= today) continue;
      const key = invoiceKey(p, inv);
      if (reminded.has(key)) continue;
      out.push({ p, inv, key, days: Math.floor((Date.parse(today) - Date.parse(inv.dueDate)) / 86400000) });
    }
  }
  out.sort((a, b) => b.days - a.days);
  return out.slice(0, 2)
    .map((c) => ({ ...c, balance: invoiceTotals(c.inv).total }))
    .filter((c) => c.balance > 0);
}

/** What the owner reads after "Reply YES n — " (unchanged from the old lane). */
export const reminderLabel = (p: Blob, inv: Blob) =>
  `email the ${inv.invoiceNo || "overdue invoice"} reminder to ${p.customer || p.address || "the customer"}`;

type Mail = { subject: string; body: string };

/** The old lane's row, exactly as the brief has always inserted it. */
export function pendingReminderRow(c: Candidate, mail: Mail, code: number) {
  return {
    code, kind: "emailSend", label: reminderLabel(c.p, c.inv), job_id: c.p.id, proposed_by: "morning-brief",
    params: {
      to: String(c.p.email).trim(), subject: mail.subject, body: mail.body,
      jobId: c.p.id, invoiceKey: c.key,
    },
  };
}

/* email.send@1's `to` (0014): one bare address. The job must be a uuid,
   because proposals.job_id is one. */
export const SPINE_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rpc/op_propose body for one reminder, or why it can't go on the
    spine (the old lane takes it then). The input carries only what
    email.send@1 accepts; the invoice key rides in evidence_refs for the
    dedupe above, and the label leads the rationale so the inbox card and
    the YES reply both say what it is. */
export function spineReminder(c: Candidate, mail: Mail): { ok: true; body: Blob } | { ok: false; why: string } {
  const to = String(c.p.email).trim();
  if (!SPINE_ADDRESS.test(to)) return { ok: false, why: "the customer email isn't one plain address" };
  if (!UUID.test(String(c.p.id ?? ""))) return { ok: false, why: "the job id isn't a uuid" };
  const label = reminderLabel(c.p, c.inv);
  const open = money(c.balance);
  return {
    ok: true,
    body: {
      p_operation: "email.send",
      p_input: { to, subject: mail.subject, body: mail.body },
      p_job_id: c.p.id,
      p_rationale: `${label} (${c.days} day${c.days === 1 ? "" : "s"} past due, ${open} open)`,
      p_evidence_refs: [{
        kind: "invoice", id: c.key,
        label: `Invoice ${c.inv.invoiceNo || "(no number)"} · ${open} open · due ${c.inv.dueDate}`,
      }],
      p_proposed_via: "cron",
      p_expires_in: "24 hours",
    },
  };
}

export type Filing =
  | { kind: "filed"; row: Blob }
  | { kind: "refused"; why: string }
  | { kind: "blocked"; why: string }
  | { kind: "unsure"; why: string };

/** How rpc/op_propose answered (status 0 = the request never got an
    answer). "filed": the proposals row came back (one object, or a
    one-element array). "refused": PostgREST said no with a 4xx — nothing
    landed, so the old lane takes the reminder. "blocked": a 403 or a
    42501 in the body — not allowed, which says the brief's spine identity
    is broken (agent:brief disabled, unlinked or its grant gone), so its
    7-day check can't be trusted either and nothing more is offered that
    day, on either lane. "unsure": a 5xx, no answer, or a 2xx without the
    row — the proposal may exist, so the reminder waits for tomorrow rather
    than be asked twice. */
export function filingOutcome(status: number, body: unknown): Filing {
  const one = Array.isArray(body) && body.length === 1 ? body[0] : body;
  const row = one && typeof one === "object" && !Array.isArray(one) ? one as Blob : null;
  if (status >= 200 && status < 300) {
    return row?.id ? { kind: "filed", row } : { kind: "unsure", why: `op_propose answered ${status} without the proposal` };
  }
  const detail = row ? [row.code, row.message].filter(Boolean).map(String).join(" ").slice(0, 200) : "";
  const why = `op_propose ${status ? `answered ${status}` : "got no answer"}${detail ? `: ${detail}` : ""}`;
  if (status === 403 || (status >= 400 && String(row?.code ?? "") === "42501")) return { kind: "blocked", why };
  return status >= 400 && status < 500 ? { kind: "refused", why } : { kind: "unsure", why };
}

/** The brief's YES line for a filed proposal: its own sms_code, and only
    while the row is still proposed and unexpired. op_propose hands back
    the existing row for a repeated key whatever became of it, and a decided
    row's old code may already belong to another ask. */
export function yesLine(row: Blob, label: string, nowMs: number): { code: number; label: string } | null {
  if (!row || row.status !== "proposed") return null;
  if (!(Date.parse(String(row.expires_at ?? "")) > nowMs)) return null;
  const code = Number(row.sms_code);
  return Number.isInteger(code) && code > 0 ? { code, label } : null;
}

/** rpc/sms_codes_in_use's answer (0019: every pending_actions code, every
    live proposal's sms_code, and every spine code answered in the last 48
    hours, which a late YES may still mean), or null when it didn't answer a list — before
    0019 or in an outage — and the caller falls back to the pending codes. */
export function codesInUseList(status: number, body: unknown): number[] | null {
  if (status < 200 || status >= 300 || !Array.isArray(body)) return null;
  return body.map((c) => Number(c)).filter((c) => Number.isFinite(c));
}

/** Old-lane codes: the lowest number from 11 that nothing holds, the rule
    the brief, the SMS assistant and the QB Time sweep share. `hold` marks a
    code taken mid-run (a spine proposal this run filed). */
export function codeTaker(used: Iterable<unknown>) {
  const taken = new Set<number>();
  const hold = (c: unknown) => {
    const n = Number(c);
    if (c != null && Number.isFinite(n)) taken.add(n);
  };
  for (const c of used) hold(c);
  let next = 11;
  return {
    hold,
    take: () => {
      while (taken.has(next)) next++;
      taken.add(next);
      return next;
    },
  };
}
