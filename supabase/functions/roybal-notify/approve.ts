/* ============================================================
   Approve-by-text — pure rules (no Deno, no network)
   ------------------------------------------------------------
   The morning brief (and later, other organs) PROPOSES actions as
   pending_actions rows, each with a short code. The owner texts
   back "YES 12" (or just "YES" when exactly one is open) and the
   inbound webhook executes it server-side. These are the rules for
   parsing that reply and matching it to a proposal — pure, so
   they're Node-testable (node --experimental-strip-types
   approve.test.mjs).

   Safety posture:
   • Only the owner's cell may approve — checked by the caller.
   • Codes expire (24h default) — yesterday's YES can't fire
     today's action.
   • "YES" alone only works when exactly ONE live proposal exists;
     two or more demand the code, and the mismatch reply says so.
   • Anything that isn't clearly a YES is ignored (normal replies
     keep flowing to the message log unharmed). STOP/NO cancels.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

/** "YES", "yes 12", "y 12", "approve 12" → { yes, code } ; "no 12"/"stop" → { no, code } */
export function parseApproval(text: string): { yes: boolean; no: boolean; code: string | null } {
  const t = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  const m = t.match(/^(yes|y|approve|ok|no|n|cancel|stop)\b[\s#-]*(\d{1,4})?$/);
  if (!m) return { yes: false, no: false, code: null };
  const yes = ["yes", "y", "approve", "ok"].includes(m[1]);
  return { yes, no: !yes, code: m[2] ?? null };
}

/** Pick the proposal a reply refers to. `open` = live pending rows
    (status 'pending', not expired), newest first. */
export function matchProposal(open: Blob[], code: string | null):
  { hit: Blob | null; reason: "ok" | "none-open" | "ambiguous" | "no-such-code" } {
  const live = (open || []).filter((a) => a && a.status === "pending");
  if (!live.length) return { hit: null, reason: "none-open" };
  if (code != null) {
    const hit = live.find((a) => String(a.code) === String(Number(code)));
    return hit ? { hit, reason: "ok" } : { hit: null, reason: "no-such-code" };
  }
  return live.length === 1 ? { hit: live[0], reason: "ok" } : { hit: null, reason: "ambiguous" };
}

/** Is this proposal still inside its window? (expires_at ISO vs now ISO) */
export const stillLive = (a: Blob, nowIso: string) =>
  !!a && a.status === "pending" && (!a.expires_at || String(a.expires_at) > nowIso);

/** One brief line per proposal: "💬 Reply YES 12 — email the INV-4 reminder to Hansen"
    (the brief renders the same format from digest.ts — keep them matching) */
export const proposalLine = (a: Blob) => `💬 Reply YES ${a.code} — ${a.label}`;

/** Confirmation / error texts the webhook sends back. */
export function replyText(kind: "done" | "failed" | "none-open" | "ambiguous" | "no-such-code" | "cancelled", a?: Blob, detail?: string) {
  switch (kind) {
    case "done": return `✅ Done — ${a?.label || "action executed"}.`;
    case "failed": return `⚠️ Couldn't do it: ${String(detail || "unknown error").slice(0, 200)}. Nothing was sent.`;
    case "none-open": return "Nothing is waiting for approval right now.";
    case "ambiguous": return "More than one action is waiting — reply YES with its number (e.g. YES 12).";
    case "no-such-code": return "That number doesn't match a live proposal — check today's brief and reply YES with the number shown.";
    case "cancelled": return `👍 Cancelled — ${a?.label || "proposal dismissed"}.`;
  }
}
