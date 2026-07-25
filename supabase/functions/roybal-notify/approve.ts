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
    const hits = live.filter((a) => String(a.code) === String(Number(code)));
    // Two proposers now share this queue. If they ever collide on a code,
    // acting on "the newest one" could send a customer an email the owner
    // meant as a board edit — ask instead of guessing.
    if (hits.length > 1) return { hit: null, reason: "ambiguous" };
    return hits[0] ? { hit: hits[0], reason: "ok" } : { hit: null, reason: "no-such-code" };
  }
  return live.length === 1 ? { hit: live[0], reason: "ok" } : { hit: null, reason: "ambiguous" };
}

/** Is this proposal still inside its window? (expires_at ISO vs now ISO) */
export const stillLive = (a: Blob, nowIso: string) =>
  !!a && a.status === "pending" && (!a.expires_at || String(a.expires_at) > nowIso);

/** One brief line per proposal: "💬 Reply YES 12 — email the INV-4 reminder to Hansen"
    (the brief renders the same format from digest.ts — keep them matching) */
export const proposalLine = (a: Blob) => `💬 Reply YES ${a.code} — ${a.label}`;

/* ============================================================
   boardEdit — the one board write a text can trigger.
   qb-time proposes "add phase X to job Y (5.2h logged)"; a YES
   appends it to coordination_jobs.data.subtasks. The decisions
   live here (pure, testable); index.ts does the two HTTP calls.
   ============================================================ */

export type BoardEdit = { rowId: string; phase: Blob };

/** Read a boardEdit proposal's params, or throw a sentence the owner can
    understand. A malformed proposal must die here, not half-way through a write. */
export function validateBoardEdit(params: Blob): BoardEdit {
  const op = String(params?.op ?? "").trim();
  if (op !== "addPhase") throw new Error(`unsupported board edit "${op || "(none)"}" — only addPhase can be approved by text`);
  const rowId = String(params?.rowId ?? "").trim();
  if (!rowId) throw new Error("the proposal names no board job");
  const phase = (params?.phase ?? {}) as Blob;
  if (typeof phase.name !== "string" || !phase.name.trim()) throw new Error("the proposal names no phase");
  // An id-less phase is a trap, not a phase: schedule.js keys hours by st.id,
  // so it could never receive the very hours this proposal was about.
  if (typeof phase.id !== "string" || !phase.id.trim()) throw new Error("the proposed phase has no id");
  return { rowId, phase };
}

/* Names compare loosely: the owner reads "Punch list", the board may already
   carry "  punch  LIST  " — or "Punch-list", or "Trim and doors" against our
   "Trim & doors". Punctuation is noise here, so strip it: twinning a phase is
   worse than declining to add one. */
const phaseKey = (n: unknown) =>
  String(n ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter((w) => w && w !== "and").join(" ");   // "&" strips out; drop the word too

/** Append the phase, unless one by that name is already there — a proposal can
    sit 24h and someone may have added it by hand overnight; a YES must not twin
    it. null = nothing to write (treat as success, not failure). */
export function buildNextSubtasks(subtasks: Blob[] | undefined | null, phase: Blob): Blob[] | null {
  // Only absent counts as empty. A truthy non-array means the blob is malformed
  // — replacing it with [phase] would quietly delete whatever was really there.
  if (subtasks != null && !Array.isArray(subtasks)) throw new Error("that job's phase list is malformed");
  const list = subtasks ?? [];
  const key = phaseKey(phase?.name);
  if (list.some((st) => phaseKey(st?.name) === key)) return null;
  return [...list, phase];
}

/** PostgREST rev guard (the field-sync idiom): a stale write matches 0 rows.
    A row that never carried a rev counts as 0, so the first phased write can't
    be locked out by its own missing counter. */
export const revGuard = (base: number) =>
  base > 0 ? `data->>rev=eq.${base}` : `or=(data->>rev.is.null,data->>rev.eq.0)`;

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
