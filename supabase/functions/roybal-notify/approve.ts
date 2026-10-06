/* ============================================================
   Approve-by-text — pure rules (no Deno, no network)
   ------------------------------------------------------------
   The morning brief (and later, other organs) PROPOSES actions as
   pending_actions rows, each with a short code. The owner texts
   back "YES 12" (or just "YES" when exactly one is open) and the
   inbound webhook executes it server-side. Or the owner taps
   Approve on the admin app's Approvals tab, which posts
   decidePending to the same function. Either way the row goes
   through decide() below: one quiet-hours preflight, one guarded
   pending → approved flip, one executor, so whichever answer
   lands first is the one that counts. These are the rules for
   parsing that reply, matching it to a proposal and shaping each
   channel's answer — pure, so they're Node-testable
   (node --experimental-strip-types approve.test.mjs;
   decide.test.mjs covers the order).

   Safety posture:
   • Only the owner may approve — the owner's cell for a text, an
     owner login (role_is under the caller's JWT) for a tap. Both
     are checked by the caller.
   • Codes expire (24h default) — yesterday's YES can't fire
     today's action.
   • "YES" alone only works when exactly ONE live proposal exists;
     two or more demand the code, and the mismatch reply says so.
   • Anything that isn't clearly a YES is ignored (normal replies
     keep flowing to the message log unharmed). STOP/NO cancels.
   • A customer text approved outside the send window is refused
     and stays pending. It is never burned as failed.
   • A board edit that couldn't reach the board wrote nothing, so
     it goes back to pending to be answered again.
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

/** "couldn't reach the board" → "Couldn't reach the board": an executor's
    sentence opening a reply of its own. */
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Confirmation / error texts the webhook sends back. */
export function replyText(
  kind: "done" | "skipped" | "failed" | "none-open" | "ambiguous" | "no-such-code" | "cancelled" | "already-answered" |
    "quiet-hours" | "try-again" | "not-recorded",
  a?: Blob, detail?: string,
) {
  const code = a?.code != null ? " " + a.code : "";
  switch (kind) {
    case "done": return `✅ Done — ${a?.label || "action executed"}.`;
    // only a board edit skips: the phase it would add was already there
    case "skipped": return `✅ Phase was already on the board — nothing was added (${a?.label || "board edit"}).`;
    case "failed": return `⚠️ Couldn't do it: ${String(detail || "unknown error").slice(0, 200)}. Nothing was sent.`;
    case "none-open": return "Nothing is waiting for approval right now.";
    case "ambiguous": return "More than one action is waiting — reply YES with its number (e.g. YES 12).";
    case "no-such-code": return "That number doesn't match a live proposal — check today's brief and reply YES with the number shown.";
    case "cancelled": return `👍 Cancelled — ${a?.label || "proposal dismissed"}.`;
    // a NO whose flip matched nothing: a YES or a tap got there first
    case "already-answered": return "That one was already answered — nothing was cancelled.";
    // detail = sendWindowText(…), e.g. "7am and 8pm"
    case "quiet-hours": return `🌙 Customer texts go out between ${detail || "7am and 8pm"} Alaska time — ` +
      `text YES${code} again then. Nothing was sent; it's still waiting.`;
    // detail = the executor's sentence; the row is back at pending
    case "try-again": return `⏳ ${capFirst(String(detail || "that didn't go through"))} — text YES${code} again in a minute.`;
    // detail = the word he texted, "YES" or "NO"; the flip errored, so nothing moved
    case "not-recorded": return `Couldn't record that just now — text ${detail || "YES"}${code} again in a minute.`;
  }
}

/* ============================================================
   Quiet hours — the preflight before a YES flips anything.
   Customer texts go out 7am–8pm Alaska (SMS_QUIET_START / _END in
   index.ts, whose assertSendWindow uses these same helpers). A
   sendText for a customer audience, approved outside that window,
   is refused BEFORE the pending → approved flip and stays pending,
   to be answered again once the window opens. Until this check,
   a 9pm YES flipped the row to approved, the send guard then threw,
   and the proposal was burned as failed. Crew texts and every other
   kind go through at any hour, as the executor always treated them.
   ============================================================ */

/** 7 → "7am", 20 → "8pm", 12 → "noon", 0 and 24 → "midnight". */
export const hourLabel = (h: number) =>
  h === 0 || h === 24 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`;

/** Is this Alaska hour inside the send window? Start counts, end doesn't. */
export const inSendWindow = (hour: number, start: number, end: number) => hour >= start && hour < end;

/** "7am and 8pm", the window as the owner reads it. */
export const sendWindowText = (start: number, end: number) => `${hourLabel(start)} and ${hourLabel(end)}`;

/** Does the preflight hold this row? Only a customer sendText, only outside the window. */
export function quietHoursHold(kind: unknown, params: Blob | null | undefined, hour: number, start: number, end: number): boolean {
  return kind === "sendText" && params?.audience === "customer" && !inSendWindow(hour, start, end);
}

/* ============================================================
   decide — one answer, either channel.
   The YES/NO text (handleApproval) and the inbox tap
   (decidePending) both run a pending_actions row through here, so
   the two can't drift apart:
   • NO / Decline is a guarded flip, pending → declined.
   • YES / Approve clears the quiet-hours preflight first, then
     flips pending → approved, guarded on still-pending. Only a flip
     that landed runs the executor. A tap and a text racing for the
     same row can't both execute: the loser's flip matches zero rows
     and it reports not_open.
   • An executor throw stamps the row failed with result.error,
     guarded on still-approved: when the stamp matches nothing,
     someone settled the row first (gmail-proxy stamps its own
     executed before it answers), so the row is re-read and its
     real outcome reported.
   • An executor that throws TryAgain wrote nothing and hit
     something passing (the board didn't answer). The row goes back
     approved → pending, guarded, to be answered again; if that
     revert doesn't land it takes the failed stamp after all.
   index.ts supplies the I/O (the PATCHes, gmail-proxy, Twilio, the
   board write); the order lives here, where a test can see it.
   ============================================================ */

export type Decision = "approve" | "decline";
export type Outcome =
  | { status: "executed"; skipped?: string }
  | { status: "declined" | "not_open" | "quiet_hours" }
  | { status: "failed" | "try_again"; error: string };

/** Thrown by an executor that wrote nothing, over something that passes. */
export class TryAgain extends Error {}

export type DecideIO = {
  /** The preflight's answer for this row (quietHoursHold). */
  held: boolean;
  /** Guarded PATCH pending → `to`. Resolves true when a row landed, false when
      it matched none (a lost race); rejects when the PATCH errored. */
  flip: (to: "approved" | "declined") => Promise<boolean>;
  /** Run the approved row's action. Throws a sentence the owner can read.
      Resolves with { skipped } when there was nothing to do. */
  execute: () => Promise<unknown>;
  /** Guarded PATCH approved → pending. Resolves true when a row landed. */
  revert: () => Promise<boolean>;
  /** Guarded PATCH approved → failed with result.error. Resolves true when a row landed. */
  fail: (error: string) => Promise<boolean>;
  /** The row as it stands now, or null. */
  reread: () => Promise<Blob | null>;
};

/** Settle a best-effort step: whatever it throws is a step that didn't land. */
const quietly = async <T>(step: () => Promise<T>, otherwise: T): Promise<T> => {
  try { return await step(); } catch (_) { return otherwise; }
};

/** A flip that rejects (its PATCH errored or never answered) is not caught
    here: nobody knows whether it landed, so the caller reports it and nothing
    executes. Every later step is caught; decide() itself never throws past
    the flip. */
export async function decide(decision: Decision, io: DecideIO): Promise<Outcome> {
  if (decision === "decline") return { status: (await io.flip("declined")) ? "declined" : "not_open" };
  // a held row is never flipped: it stays pending for an answer in the window
  if (io.held) return { status: "quiet_hours" };
  // approve first (guarded on still-pending — a double YES can't fire twice)…
  if (!(await io.flip("approved"))) return { status: "not_open" };
  // …then execute. From here on every throw ends back at pending or in the
  // failed stamp, so a row can't be left sitting at "approved".
  let error: string;
  let retry = false;
  try {
    const done = (await io.execute()) as Blob | undefined;
    return done?.skipped ? { status: "executed", skipped: String(done.skipped) } : { status: "executed" };
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
    retry = e instanceof TryAgain;
  }
  if (retry && await quietly(() => io.revert(), false)) return { status: "try_again", error };
  if (!(await quietly(() => io.fail(error), false))) {
    // the row moved on without us (or the stamp errored): say what it shows
    const now = await quietly(() => io.reread(), null);
    if (now?.status === "executed") return { status: "executed" };
  }
  return { status: "failed", error };
}

/** The text back to the owner on the YES/NO path. `window` = sendWindowText(…). */
export function replyFor(decision: Decision, out: Outcome, a: Blob, window: string): string {
  if (decision === "decline") return replyText(out.status === "declined" ? "cancelled" : "already-answered", a)!;
  switch (out.status) {
    case "quiet_hours": return replyText("quiet-hours", a, window)!;
    case "not_open": return replyText("none-open")!;
    case "failed": return replyText("failed", a, out.error)!;
    case "try_again": return replyText("try-again", a, out.error)!;
    case "executed": return replyText(out.skipped ? "skipped" : "done", a)!;
    default: return replyText("done", a)!;
  }
}

/* ============================================================
   decidePending — the inbox's door (index.ts routes it).
   The Approvals tab POSTs { action:"decidePending", id, decision }
   with the owner's access token. index.ts checks the owner, then
   runs the row through decide() with the service role. The request
   check and the shape of every answer live here; the tab turns
   them into sentences. No text goes back to the owner — this
   response is the answer.
   ============================================================ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id must be a real uuid: it goes straight into a PostgREST filter. */
export function parseDecideRequest(body: Blob | null | undefined):
  { ok: true; id: string; decision: Decision } | { ok: false; message: string } {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!UUID.test(id)) return { ok: false, message: "Provide `id`, the pending action's uuid." };
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "decline")
    return { ok: false, message: 'Provide `decision`, "approve" or "decline".' };
  return { ok: true, id, decision };
}

/** Everything decidePending can answer: decide()'s outcomes plus the refusals before it. */
export type DecideAnswer =
  | Outcome
  | { status: "not_owner" | "auth" | "role_check_failed" }
  | { status: "bad_request" | "server_error"; error: string };

/** rpc/role_is('owner') under the caller's JWT, read as decidePending's first
    answer: null = the owner, carry on. Only a 200 that is literally true
    passes. A 401 is PostgREST refusing the token (expired, or signed with a
    key it no longer trusts), answered 401 so the app refreshes the token and
    asks once more. Anything else (a 5xx, or `status` 0 for a call that never
    answered) is an outage, not a verdict on who he is. Every refusal runs
    nothing. */
export function ownerGate(status: number, body: unknown): DecideAnswer | null {
  if (status === 200) return body === true ? null : { status: "not_owner" };
  if (status === 401) return { status: "auth" };
  return { status: "role_check_failed" };
}

/** HTTP code + JSON body for each answer. 200 means the decision was recorded,
    including "failed" (the error rides in `message`); everything else is
    { ok:false, error, message }. `a` = the row, once there is one; `after` =
    that row re-read once the decision settled (null when the read failed, and
    then the outcome stands in for its status); `window` = sendWindowText(…). */
export function decideResponse(out: DecideAnswer, a: Blob | null, window: string, after: Blob | null = null):
  { code: number; body: Blob } {
  const skipped = (out.status === "executed" && out.skipped) || after?.result?.skipped;
  const settled = after ?? {
    status: out.status,
    result: out.status === "failed" ? { error: out.error } : skipped ? { skipped } : null,
  };
  const action = a ? {
    id: a.id, code: a.code, kind: a.kind, label: a.label,
    status: settled.status ?? null, result: settled.result ?? null,
  } : null;
  const label = a?.label || "the action";
  const refuse = (code: number, error: string, message: string) => ({ code, body: { ok: false, error, message } });
  switch (out.status) {
    case "executed": return { code: 200, body: { ok: true, status: "executed",
      // only a board edit skips: the phase it would add was already there
      message: skipped ? "Phase was already on the board — nothing was added." : `Done — ${label}.`, action } };
    case "declined": return { code: 200, body: { ok: true, status: "declined", message: `Declined — ${label}.`, action } };
    case "failed": return { code: 200, body: { ok: true, status: "failed", message: out.error || "unknown error", action } };
    case "not_open": return refuse(404, "not_open", "Already answered, or it expired.");
    case "quiet_hours": return refuse(409, "quiet_hours",
      `Customer texts go out between ${window} Alaska time. It's still waiting; approve it then.`);
    // the row is back at pending; the executor's sentence says what didn't happen
    case "try_again": return refuse(409, "try_again", `${capFirst(out.error || "that didn't go through")}; try again in a minute.`);
    case "not_owner": return refuse(403, "not_owner", "Approvals belong to the owner's login.");
    case "auth": return refuse(401, "auth", "Your login expired. Sign in again.");
    case "role_check_failed": return refuse(503, "role_check_failed", "Couldn't check your login just now. Try again.");
    case "bad_request": return refuse(400, "bad_request", out.error);
    // the bare cause: the tab already frames a 5xx as "something went wrong on the server (…)"
    case "server_error": return refuse(500, "server_error", out.error || "unknown error");
  }
}
