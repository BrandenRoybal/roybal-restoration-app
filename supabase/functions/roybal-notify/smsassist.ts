/* ============================================================
   The SMS channel — pure rules (no Deno, no network)
   ------------------------------------------------------------
   Roadmap J0 (docs/architecture/08 §4): the owner texts the company
   number and the office assistant answers by text. index.ts does
   the I/O (Twilio in, roybal-ai-office turn, pending_actions rows,
   Twilio out); everything decidable without I/O lives here so it
   is Node-testable (node --experimental-strip-types smsassist.test.mjs).

   Posture, in one paragraph: only a number that resolves to the
   owner gets a turn (today OWNER_CELL / SMS_FORWARD_TO; profiles.phone
   from P1). The turn is READ + PROPOSE — the assistant never executes
   from a text. A proposal lands in pending_actions with a code, and
   the reply says "Text YES 14 to send" — the approve-by-text channel
   that already exists (approve.ts) does the rest, so a spoofed sender
   can at most read the board and queue a proposal the real owner
   still has to approve. Only kinds the approval executor can run are
   proposed; anything else is dropped before it is minted.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

/** SMS_ASSIST_ENABLED: unset/blank = on (the roadmap's rollback is
    setting it to false). Only an explicit no turns it off. */
export function smsAssistEnabled(raw: string | undefined | null): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
}

const digits10 = (n: unknown) => String(n ?? "").replace(/[^\d]/g, "").slice(-10);

/** Who is texting. "owner" when the sender's last ten digits match the
    owner's cell (OWNER_CELL, falling back to SMS_FORWARD_TO exactly as
    handleApproval does); null for everyone else. */
export function assistSender(from: string, env: { ownerCell?: string; forwardTo?: string }): "owner" | null {
  const f = digits10(from);
  if (f.length !== 10) return null;
  const owner = digits10(env.ownerCell) || digits10(env.forwardTo);
  return owner.length === 10 && owner === f ? "owner" : null;
}

/** The proposal kinds handleApproval (index.ts) can execute after a YES.
    A kind not listed here would sit in pending_actions and fail on
    approval with "unknown action kind" — so it is never minted. */
export const TEXT_EXECUTABLE_KINDS = new Set(["sendText"]);

/** Codes are unique across every LIVE proposal (the brief, the QB Time
    sweep and this lane share one queue and the owner answers them all
    with one number). Same rule as roybal-brief: start at 11, skip used. */
export function mintCodes(usedCodes: Iterable<unknown>, n: number): number[] {
  const used = new Set(Array.from(usedCodes, (c) => Number(c)).filter((c) => Number.isFinite(c)));
  const out: number[] = [];
  let next = 11;
  while (out.length < n) {
    while (used.has(next)) next++;
    used.add(next);
    out.push(next);
  }
  return out;
}

export type Proposal = { type: string; label: string; params: Blob };
export type PendingRow = { code: number; kind: string; label: string; params: Blob; proposed_by: string; job_id: null };

/** pending_actions rows for the proposals a turn produced — only the
    executable kinds, in order, with the minted codes. `codes` must be at
    least as long as the executable subset (mint after filtering). */
export function pendingRowsFor(proposals: Proposal[], codes: number[], proposedBy = "sms-assist"): PendingRow[] {
  const ok = proposals.filter((p) => p && TEXT_EXECUTABLE_KINDS.has(String(p.type)));
  return ok.slice(0, codes.length).map((p, i) => ({
    code: codes[i],
    kind: String(p.type),
    label: String(p.label || p.type).slice(0, 120),
    params: p.params && typeof p.params === "object" ? p.params : {},
    proposed_by: proposedBy,
    job_id: null,
  }));
}

/* Truncate by code point, never mid-surrogate (the same rule as clip in
   index.ts — a split emoji corrupts the send). */
const cut = (t: string, n: number) => Array.from(t).slice(0, n).join("");

/** Markdown does not survive SMS. Strip the bits a chat-trained reply
    reaches for and flatten to single spaces. */
export function plainText(t: string): string {
  return String(t ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1")
    .replace(/^\s*#+\s*/gm, "").replace(/^\s*[-*•]\s+/gm, "").replace(/`/g, "")
    .replace(/\s*\n+\s*/g, " ").replace(/[ \t]+/g, " ").trim();
}

/** "Text YES 14 to send" — one line per minted proposal. */
export const approvalLine = (row: { code: number; label: string }) => `Text YES ${row.code} to ${row.label}`;

/** The outbound text: the answer, then the approval lines, within `max`
    characters (320 = two SMS segments). The approval lines are the part
    that must survive — a truncated answer is a shorter answer, a truncated
    code is an action the owner cannot take — so the answer is cut first,
    with an ellipsis, and the lines are kept whole. */
export function composeSmsReply(reply: string, rows: Array<{ code: number; label: string }>, max = 320): string {
  const lines = rows.map(approvalLine);
  const tail = lines.length ? "\n" + lines.join("\n") : "";
  const tailLen = Array.from(tail).length;
  let body = plainText(reply);
  if (!body) body = lines.length ? "Proposal ready." : "I didn't get an answer back — try again.";
  const room = Math.max(0, max - tailLen);
  if (Array.from(body).length > room) body = cut(body, Math.max(0, room - 1)).replace(/\s+\S*$/, "") + "…";
  return (body + tail).trim();
}

/** What the owner reads when the turn could not run. */
export function failureText(kind: "capped" | "error" | "disabled"): string {
  switch (kind) {
    case "capped": return "The office assistant has used its monthly budget — it's back on the 1st. Text YES/NO still works for open proposals.";
    case "error": return "Couldn't get an answer just now — try again in a minute.";
    case "disabled": return "The office assistant is off for texts right now.";
  }
}
