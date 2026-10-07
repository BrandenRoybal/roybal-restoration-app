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

   Since spine step 5 a YES also reaches the spine's proposals
   (public.proposals, numbered by sms_code). The reply is matched
   across BOTH queues at once (matchAcross), so a bare YES still
   means "the one thing a text offered", and a number that two asks
   share runs neither. A spine ask no text offered (the job page's
   adjuster email) is only ever answered by its number. A spine hit
   is approved through
   op_proposal_approve, never decide(): the row lock there is what
   makes a second YES, or a YES racing an inbox tap, approve once.
   The spine half's rules (labels, the answer → text mapping) sit
   at the bottom of this file.

   Safety posture:
   • Only the owner may approve — the owner's cell for a text, an
     owner login (role_is under the caller's JWT) for a tap. Both
     are checked by the caller.
   • Codes expire (24h default) — yesterday's YES can't fire
     today's action.
   • "YES" alone only works when exactly ONE live ask that a text
     offered exists (every pending_actions row, and the brief's spine
     rows: offeredByText); two or more demand the code, and the
     mismatch reply says so. A spine ask offered only on a screen
     always demands its number: a bare "ok" meant for the assistant
     must never send the adjuster an email.
   • An invoice-gaps ask (invoice.review_gaps) is the inbox's alone:
     the text channel never reads one (INBOX_ONLY_FILTER).
   • Anything that isn't clearly a YES is ignored (normal replies
     keep flowing to the message log unharmed). STOP/NO cancels.
   • A customer text approved outside the send window is refused
     and stays pending. It is never burned as failed.
   • A board edit that couldn't reach the board wrote nothing, so
     it goes back to pending to be answered again.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

/** "YES", "yes 12", "yes12", "y 12", "approve 12" → { yes, code } ; "no 12"/"stop" → { no, code }.
    The number may sit right against the word ("YES1" is how a thumb types
    it); a letter may not ("yesterday", "nope" stay chatter). */
export function parseApproval(text: string): { yes: boolean; no: boolean; code: string | null } {
  const t = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  const m = t.match(/^(yes|y|approve|ok|no|n|cancel|stop)(?![a-z_])[\s#-]*(\d{1,4})?$/);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a boardEdit proposal's params, or throw a sentence the owner can
    understand. A malformed proposal must die here, not half-way through a write. */
export function validateBoardEdit(params: Blob): BoardEdit {
  const op = String(params?.op ?? "").trim();
  if (op !== "addPhase") throw new Error(`unsupported board edit "${op || "(none)"}" — only addPhase can be approved by text`);
  const rowId = String(params?.rowId ?? "").trim();
  if (!rowId) throw new Error("the proposal names no board job");
  // coordination_jobs.id is a uuid (qb-time files job.id). Anything else can
  // never match a job, and PostgREST answers it 400, every time it's asked.
  if (!UUID.test(rowId)) throw new Error("the proposal names no valid board job");
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

/** Is a failed board read worth answering again? Only an outage (a 5xx) or a
    rate limit (429) passes. Any other refusal is the same answer next time, so
    a TryAgain would bounce the row back to pending forever. (A read that never
    answered at all is retryable too; index.ts sees that as a throw.) */
export const retryableStatus = (status: number) => status >= 500 || status === 429;

/** "couldn't reach the board" → "Couldn't reach the board": an executor's
    sentence opening a reply of its own. */
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Confirmation / error texts the webhook sends back. */
export function replyText(
  kind: "done" | "skipped" | "failed" | "none-open" | "ambiguous" | "no-such-code" | "cancelled" | "already-answered" |
    "quiet-hours" | "quiet-hours-expires" | "try-again" | "not-recorded" | "code-clash" | "needs-number",
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
    // one number on a live row in each queue (matchAcross): neither runs, and
    // the inbox, which shows both cards side by side, is where to pick
    case "code-clash": return `Two asks share number ${a?.code ?? ""} — answer this one from the Approvals tab in the office app.`;
    // a bare YES/NO whose one live ask no text offered (matchAcross): it
    // names that ask and the number that answers it, and nothing runs
    case "needs-number": return `Reply YES${code} to approve "${a?.label || "this ask"}" (or NO${code}).`;
    case "cancelled": return `👍 Cancelled — ${a?.label || "proposal dismissed"}.`;
    // a NO whose flip matched nothing: a YES or a tap got there first
    case "already-answered": return "That one was already answered — nothing was cancelled.";
    // detail = sendWindowText(…), e.g. "7am and 8pm"
    case "quiet-hours": return `🌙 Customer texts go out between ${detail || "7am and 8pm"} Alaska time — ` +
      `text YES${code} again then. Nothing was sent; it's still waiting.`;
    // the same hold, for a row that expires before the window opens: "then" never comes
    case "quiet-hours-expires": return `🌙 Customer texts go out between ${detail || "7am and 8pm"} Alaska time, ` +
      `and this one expires before then, so it won't go out. Nothing was sent.`;
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
   to be answered again once the window opens (when the row expires
   before then, the answer says it won't go out). Until this check,
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

/** The Alaska hour (0–23) at an instant; index.ts's anchorageHour is this at now. */
const AK_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Anchorage", hour: "numeric", hourCycle: "h23" });
export const alaskaHour = (d: Date) => Number(AK_HOUR.format(d));

const HOUR_MS = 3_600_000;

/** When the send window next opens, seen from `at` outside it: the first
    top of an hour after `at` that inSendWindow calls open, today's or
    tomorrow's. Alaska sits a whole number of hours off UTC, so the top of
    an hour is the same instant there and here. Stepping an hour at a time
    and asking the same question the preflight asks is exact whatever the
    hours are set to: across a DST change, for a start hour the clock skips
    that night, or a start like 7.5. null when the window never opens (a
    start at or after its end). */
export function windowOpensAt(at: Date, start: number, end: number): Date | null {
  let t = Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
  for (let i = 0; i < 49; i++) {
    t += HOUR_MS;
    if (inSendWindow(alaskaHour(new Date(t)), start, end)) return new Date(t);
  }
  return null;
}

/** Will a held row expire before the window opens? Then "approve it then"
    is a promise nobody can keep. A row with no expiry never lapses
    (stillLive's rule), and neither does one whose expiry won't parse. */
export function expiresBeforeWindow(expiresAt: unknown, at: Date, start: number, end: number): boolean {
  if (expiresAt == null || expiresAt === "") return false;
  const exp = Date.parse(String(expiresAt));
  if (!Number.isFinite(exp)) return false;
  const opens = windowOpensAt(at, start, end);
  return !opens || exp <= opens.getTime();
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
     revert doesn't land it takes the failed stamp after all. Nor
     is it sent when another live row has taken the same code
     meanwhile (a row at approved doesn't hold its code), since
     two live rows on one code would leave a YES ambiguous.
   index.ts supplies the I/O (the PATCHes, gmail-proxy, Twilio, the
   board write); the order lives here, where a test can see it.
   ============================================================ */

export type Decision = "approve" | "decline";
export type Outcome =
  | { status: "executed"; skipped?: string }
  | { status: "declined" | "not_open" }
  | { status: "quiet_hours"; expiresFirst?: boolean }
  | { status: "failed" | "try_again"; error: string };

/** Thrown by an executor that wrote nothing, over something that passes. */
export class TryAgain extends Error {}

export type DecideIO = {
  /** The preflight's answer for this row (quietHoursHold). */
  held: boolean;
  /** Held, and the row expires before the window opens (expiresBeforeWindow). */
  expiresFirst?: boolean;
  /** Guarded PATCH pending → `to`. Resolves true when a row landed, false when
      it matched none (a lost race); rejects when the PATCH errored. */
  flip: (to: "approved" | "declined") => Promise<boolean>;
  /** Run the approved row's action. Throws a sentence the owner can read.
      Resolves with { skipped } when there was nothing to do. */
  execute: () => Promise<unknown>;
  /** Guarded PATCH approved → pending. Resolves true when a row landed, false
      when it matched none or was not sent, "taken" when it was not sent
      because another live row now holds the code. */
  revert: () => Promise<boolean | "taken">;
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
  // (and when it expires before the window opens, the answer has to say so)
  if (io.held) return io.expiresFirst ? { status: "quiet_hours", expiresFirst: true } : { status: "quiet_hours" };
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
  if (retry) {
    const back = await quietly<boolean | "taken">(() => io.revert(), false);
    if (back === true) return { status: "try_again", error };
    // the same YES would now run the newer ask, so the answer can't read as "try again"
    if (back === "taken") error = `${error}; its YES number now belongs to a newer ask, so this one is closed`;
  }
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
    case "quiet_hours": return replyText(out.expiresFirst ? "quiet-hours-expires" : "quiet-hours", a, window)!;
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
  // a skip is known even when its executed stamp didn't land and the re-read
  // still shows the row at approved with no result
  const result = skipped ? { ...(settled.result ?? {}), skipped } : settled.result ?? null;
  const action = a ? {
    id: a.id, code: a.code, kind: a.kind, label: a.label,
    status: settled.status ?? null, result,
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
    // the row stays pending either way; only one of them can still be approved in the window
    case "quiet_hours": return refuse(409, "quiet_hours", out.expiresFirst
      ? `Customer texts only go out between ${window} Alaska time, and this one expires before then. Nothing was sent.`
      : `Customer texts go out between ${window} Alaska time. It's still waiting; approve it then.`);
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

/* ============================================================
   The spine lane — "YES 4" on a public.proposals row.
   Spine step 5: the morning brief's reminder (and the adjuster
   email) can be a spine proposal instead of a pending_actions row.
   handleApproval (index.ts) reads both queues and hands them to
   matchAcross; a spine hit is approved through
   rpc/op_proposal_approve as the owner's profile (p_via "sms"),
   or declined through rpc/op_proposal_decline. Neither runs
   decide(): the spine's own row lock and its "approving twice is
   approving once" return are what keep an inbox tap and a text,
   or two texts, to one outbox row. Only the brief texts its spine
   asks; the adjuster email is offered on the job page, so a bare
   YES never reaches it (offeredByText). What lives here is how a
   reply is matched, what a spine row is called in a text, which
   sentence each answer gets, and the GET /version answer that
   tells the brief and set-gmail-secret.sh this build reads the
   spine at all (VERSION_ANSWER).
   ============================================================ */

export type MatchReason = "ok" | "none-open" | "ambiguous" | "no-such-code" | "code-clash" | "needs-number";
export type Lane = "text" | "spine";

/** GET …/roybal-notify/version (index.ts routes it, no key needed:
    verify_jwt is off). This build answers a YES across both queues, so
    "answers" names them. roybal-brief probes it before it files a reminder
    on the spine, and set-gmail-secret.sh before it turns the email lane
    on: a 200 whose `answers` includes "spine" is the only yes. The build
    before step 5 answers any GET 405 "Use POST". The shape is a contract
    those two read, so it changes only with them. */
export const VERSION_ANSWER = { ok: true, function: "roybal-notify", answers: ["text", "spine"] } as const;

/** Was this spine ask offered by text, so a bare YES or NO can mean it?
    Only the brief's are (proposed_via 'cron': its "💬 Reply YES n" lines).
    The rest (the job page's adjuster email, 'ui'; chip, mcp, voice …) were
    offered on a screen that shows the number, and nothing about them
    reached his phone. Every pending_actions row was texted (the brief,
    qb-time and the SMS assistant all send their "YES n" lines), so the
    text lane needs no such test. */
export const offeredByText = (r: Blob) => r?.proposed_via === "cron";

/** The spine asks a text never answers, as a PostgREST filter both spine
    reads append (the live read and the late lookup, index.ts; `*` is
    LIKE's `%`). An invoice.review_gaps proposal (0021) is money whose
    lines and evidence show only in the inbox, and a 160-character label
    can't carry them, so neither "YES n" nor a bare YES ever reaches one:
    its number answers like a number no ask holds, and its fate is never
    quoted back. It is filed proposed_via 'agent' besides, so one that got
    past this filter still couldn't be a bare YES's (offeredByText). */
export const INBOX_ONLY_FILTER = "&operation=not.like.invoice.review_gaps*";

/** Pick the ask a reply refers to across both queues. `text` = live
    pending_actions rows (status 'pending'), `spine` = live proposals
    (status 'proposed', with an sms_code, read with proposed_via), both
    read unexpired. The hit is the row exactly as read, tagged by `lane`
    beside it, so a text-lane hit goes on to decide() untouched. A number
    held by a live row in each queue is a code-clash and runs neither
    (sms_codes_in_use keeps new codes apart; rows minted before it can
    still collide). A bare YES or NO acts only when exactly one row a text
    offered (offeredByText) is live across both; the spine rows no text
    offered are left out of that count, since "ok" to the assistant must
    not send the adjuster email. When one of those is all there is, the
    answer is needs-number with that row as `ask` (named, never run); two
    or more is ambiguous. */
export function matchAcross(text: Blob[], spine: Blob[], code: string | null):
  { lane: Lane | null; hit: Blob | null; reason: MatchReason; ask?: Blob } {
  const t = (text || []).filter((a) => a && a.status === "pending");
  const s = (spine || []).filter((r) => r && r.status === "proposed" && r.sms_code != null);
  if (!t.length && !s.length) return { lane: null, hit: null, reason: "none-open" };
  if (code != null) {
    const n = String(Number(code));
    const th = t.filter((a) => String(a.code) === n);
    const sh = s.filter((r) => String(r.sms_code) === n);
    if (th.length && sh.length) return { lane: null, hit: null, reason: "code-clash" };
    // two text rows on one code is today's guard (matchProposal); two spine
    // rows can't be (a unique index), but the same answer holds if they were
    if (th.length > 1 || sh.length > 1) return { lane: null, hit: null, reason: "ambiguous" };
    if (th[0]) return { lane: "text", hit: th[0], reason: "ok" };
    if (sh[0]) return { lane: "spine", hit: sh[0], reason: "ok" };
    return { lane: null, hit: null, reason: "no-such-code" };
  }
  const texted = s.filter(offeredByText);
  if (t.length + texted.length === 1) {
    return t[0] ? { lane: "text", hit: t[0], reason: "ok" } : { lane: "spine", hit: texted[0], reason: "ok" };
  }
  if (t.length + texted.length > 1) return { lane: null, hit: null, reason: "ambiguous" };
  // nothing a text offered is live: only a number answers what is
  return s.length === 1
    ? { lane: null, hit: null, reason: "needs-number", ask: s[0] }
    : { lane: null, hit: null, reason: "ambiguous" };
}

/** "email.send@1" → "email.send": proposals store the operation versioned. */
export const opName = (operation: unknown) => String(operation ?? "").split("@")[0].trim();

/** Clip by code point, never mid-surrogate (clip in index.ts, cut in smsassist.ts). */
const clipTo = (t: string, n: number) => Array.from(t).slice(0, n).join("");

/** What a spine row is called in a text. The spine has no label column; its
    rationale's first line is the sentence its proposer wrote for a person
    (the brief's "email the INV-4 reminder to Hebard (5 days past due, …)").
    A trailing period is dropped because every reply adds its own. Without
    one, the operation says what it would do. */
export function spineLabel(row: Blob): string {
  const first = String(row?.rationale ?? "").trim().split(/\r?\n/)[0].trim();
  const said = clipTo(first, 160).trim().replace(/\.+$/, "").trim();
  if (said) return said;
  const input = { ...(row?.input ?? {}), ...(row?.edited_params ?? {}) } as Blob;
  const field = (k: string) => String(input[k] ?? "").trim();
  const op = opName(row?.operation);
  if (op === "email.send" && field("to")) return clipTo(`email ${field("to")}`, 160);
  if (op === "sms.send" && field("to")) return clipTo(`text ${field("to")}`, 160);
  if (op === "job.set_stage" && field("stage")) return clipTo(`move the job to ${field("stage")}`, 160);
  return op || "this ask";
}

/** The owner's principal for a service-role approval: the answer to
    profiles?role=eq.owner&select=id&limit=2. op_proposal_approve from the
    service role must name who it acts for, and a text proves only that the
    owner's cell sent it, so exactly one owner profile or nothing runs. */
export function ownerPrincipal(status: number, body: unknown): { ok: true; id: string } | { ok: false; why: string } {
  if (status !== 200) return { ok: false, why: `the owner profile read failed (${status})` };
  if (!Array.isArray(body)) return { ok: false, why: "the owner profile read answered no list" };
  if (body.length !== 1) return { ok: false, why: body.length ? `${body.length} owner profiles, not one` : "no owner profile" };
  const id = String((body[0] as Blob)?.id ?? "");
  return UUID.test(id) ? { ok: true, id } : { ok: false, why: "the owner profile has no id" };
}

/** rpc/outbox_channel_ready {"p_channel":"email"}: only a 200 literal true is
    a live lane and a literal false a lane known to be off. Anything else (a
    404 before migration 0019, an outage) is unknown, and the wording then
    promises nothing about when. */
export type EmailLane = "ready" | "off" | "unknown";
export function emailLane(status: number, body: unknown): EmailLane {
  if (status !== 200) return "unknown";
  return body === true ? "ready" : body === false ? "off" : "unknown";
}

/** outbox?proposal_id=eq.<id>&select=status,error: what became of this
    email. sent = the worker sent it (sent or delivered); dead = the worker
    gave up on it for good (a permanent Gmail refusal, too many tries, or
    past EMAIL_MAX_AGE_HOURS), `error` saying why; waiting = anything else
    (pending, sending, failed and still retrying). A read that failed or
    won't parse is waiting too, so the text says it goes out once rather
    than that it went, or that it never will. */
export type OutboxState = { state: "sent" } | { state: "dead"; error: string } | { state: "waiting" };
const WAITING: OutboxState = { state: "waiting" };

/** outbox.error as a reply quotes it: trimmed, 160 characters, its closing
    period dropped (the sentence adds its own); nothing there = "it gave up". */
const deadReason = (e: unknown) =>
  clipTo(String(e ?? "").trim(), 160).trim().replace(/\.+$/, "").trim() || "it gave up";

export function outboxState(rows: unknown): OutboxState {
  if (!Array.isArray(rows)) return WAITING;
  const st = (r: unknown) => String((r as Blob)?.status ?? "");
  if (rows.some((r) => ["sent", "delivered"].includes(st(r)))) return { state: "sent" };
  const dead = rows.find((r) => st(r) === "dead") as Blob | undefined;
  return dead ? { state: "dead", error: deadReason(dead.error) } : WAITING;
}

/** Statuses a spine row reaches once someone approved it, before or after it ran. */
export const APPROVED_STATUSES = ["approved", "executing", "executed"];

const errText = (e: unknown) => clipTo(String(e || "unknown error"), 200);
const expiredText = (label: string) => `That one expired — ${label}. Nothing was sent.`;
const declinedText = (label: string) => `That one was declined — ${label}. Nothing was sent.`;
/* An email still waiting with the worker's email lane known off may never
   go out (the worker drops one that waited past 48 hours), so it says that
   instead of promising "it goes out once". */
const alreadyApproved = (label: string, outbox: OutboxState = WAITING, lane: EmailLane = "unknown") =>
  outbox.state === "dead"
    ? `That one was approved, but the email couldn't be sent: ${outbox.error}. Nothing went out.`
    : outbox.state === "sent"
    ? `That one was already approved — ${label}. It went out once.`
    : lane === "off"
    ? `That one was already approved — ${label}. It's queued, but email sending is off on the worker: ` +
      "it waits up to 48 hours for that to come back, then it isn't sent."
    : `That one was already approved — ${label}. It goes out once.`;

/** A spine row someone already answered: the late YES (no live row holds the
    number, but a proposal with that sms_code was answered in the last 48h)
    and the YES that lost the row lock to an inbox tap. `outbox` = its email's
    outbox state (outboxState), read only for an approved email, and `lane`
    the worker's email lane (emailLane), read only when that email is still
    waiting. null =
    nothing to say about it (still live, or superseded), and the caller's own
    answer stands. */
export function spineLateText(row: Blob, nowIso: string, outbox: OutboxState = WAITING,
  lane: EmailLane = "unknown"): string | null {
  const s = String(row?.status ?? "");
  const label = spineLabel(row);
  if (APPROVED_STATUSES.includes(s)) {
    return opName(row.operation) === "email.send" ? alreadyApproved(label, outbox, lane) : alreadyApproved(label);
  }
  if (s === "declined") return declinedText(label);
  // a stale row stays 'proposed' until the next op_propose sweeps it
  const lapsed = s === "proposed" && Date.parse(String(row?.expires_at ?? "")) <= Date.parse(nowIso);
  if (s === "expired" || lapsed) return expiredText(label);
  if (s === "failed") return `That one was approved, but it didn't run: ${errText(row.error)}`;
  return null;
}

/** When a spine row was answered, as an instant: its approval, else the
    moment it lapsed (a stale row stays 'proposed' until a sweep), else its
    last update (the decline, or the sweep). NaN when none of them parses. */
export function spineDecidedAt(row: Blob): number {
  const at = row?.approved_at ?? (row?.status === "proposed" ? row?.expires_at : row?.updated_at);
  return Date.parse(String(at ?? ""));
}

/** Does a late spine answer still speak for this number? `text` = the
    newest pending_actions row created on the same code in the same 48h
    (pending_actions?code=eq.N&created_at=gte.…, newest first), or none.
    The two number spaces can hand out one number in turn: a spine ask
    answered at 8am frees its code, and a text-lane ask minted on it at 2pm
    is what a YES on it means after that. So the spine answers only when it
    was decided after that row was created, or there is no such row; a time
    that won't parse on either side leaves the matcher's own text. */
export function spineOutranks(row: Blob, text: Blob | null | undefined): boolean {
  if (!text) return true;
  const decided = spineDecidedAt(row);
  const created = Date.parse(String(text.created_at ?? ""));
  return Number.isFinite(decided) && Number.isFinite(created) && decided > created;
}

/** The receipt a spine approval by text leaves in capture_events, the same
    one the old lane's YES left (gmail-proxy's email_send row, captured_by
    approve-by-text): roybal-brief's Sunday report (weekly.ts) counts
    assist_action and email_send rows captured_by approve-by-text as "actions
    approved by text from the truck". `nowIso` stamps processed_at, the
    column that report's read filters on. */
export function spineReceipt(row: Blob, nowIso: string): Blob {
  return {
    source_type: "assist_action", form_key: opName(row?.operation), captured_by: "approve-by-text",
    status: "extracted", processed_at: nowIso,
    raw_payload: { proposal_id: row?.id ?? null, via: "sms" },
    result: { status: row?.status ?? null },
  };
}

/** What op_proposal_approve / op_proposal_decline answered, read as one
    outcome. PostgREST answers the row as one JSON object (a one-element list
    is read the same way), or an error whose body.code is the SQLSTATE:
    55000 = not open (the message says "expired at" or "is <status>"), 42501 =
    not allowed, P0002 = no such proposal or no live operation. The code
    decides, never the HTTP status.
    • approved — this text approved it (approved_via 'sms'); it ran or queued
    • answered — another door approved it first: approve returns the row
      unchanged, carrying that door's approved_via
    • cancelled — the decline landed; already-answered — a NO that found
      the row settled
    • expired / declined / closed — a YES the row lock turned away
    • not-recorded — anything else: nothing is known to have moved */
export type SpineVerdict =
  | { status: "approved" | "answered" | "cancelled"; row: Blob }
  | { status: "already-answered" | "expired" | "declined" | "closed" }
  | { status: "not-recorded"; why: string };

export function spineVerdict(decision: Decision, status: number, body: unknown): SpineVerdict {
  const one = Array.isArray(body) ? (body.length === 1 ? body[0] : null) : body;
  const b = one && typeof one === "object" ? (one as Blob) : null;
  if (status >= 200 && status < 300) {
    if (!b || typeof b.id !== "string" || !b.id) return { status: "not-recorded", why: `${status} without the proposal` };
    if (decision === "decline") return b.status === "declined" ? { status: "cancelled", row: b } : { status: "already-answered" };
    return b.approved_via === "sms" ? { status: "approved", row: b } : { status: "answered", row: b };
  }
  const code = String(b?.code ?? "");
  const msg = String(b?.message ?? "");
  if (code === "55000") {
    if (decision === "decline") return { status: "already-answered" };
    if (/expired/i.test(msg)) return { status: "expired" };
    if (/\bis declined\b/i.test(msg)) return { status: "declined" };
    return { status: "closed" };
  }
  return { status: "not-recorded", why: `${status}${code ? " " + code : ""}${msg ? ": " + msg : ""}` };
}

/** The text back for a spine decision. `a` = { code: sms_code, label:
    spineLabel(row) } of the row the YES matched; `word` = "YES" or "NO", for
    the not-recorded text. `lane` = the email lane, read only after this text
    approved an email; `outbox` = its outbox state, read only for an email
    someone else approved; `nowIso` = the reply's clock. "Approved" never
    says "Done" for a message: approving queues it, and the worker sends it.
    With the lane off it says how long it waits: the worker marks an email
    that waited past EMAIL_MAX_AGE_HOURS (48) dead, never sent late. */
export function spineReply(
  v: SpineVerdict, a: Blob, word: string,
  ctx: { lane?: EmailLane; outbox?: OutboxState; nowIso?: string } = {},
): string {
  const label = a?.label || "this ask";
  switch (v.status) {
    case "approved": {
      const r = v.row;
      if (r.status === "failed") return `⚠️ Approved, but it didn't run — ${label}: ${errText(r.error)}`;
      const op = opName(r.operation);
      if (op === "email.send") {
        if (ctx.lane === "ready") return `✅ Approved — ${label}. It's queued and goes out in a minute.`;
        if (ctx.lane === "off") return `✅ Approved — ${label}. It's queued, but email sending is off on the worker: ` +
          `it waits up to 48 hours for that to come back, then it isn't sent.`;
        return `✅ Approved — ${label}. It's queued to send.`;
      }
      if (op === "sms.send") return `✅ Approved — ${label}. It's queued to send.`;
      if (r.status === "executed") return replyText("done", { label })!;
      // a worker-runtime operation (none in the catalog yet) waits in jobs_queue
      return `✅ Approved — ${label}. It's queued to run.`;
    }
    case "answered": return spineLateText(v.row, ctx.nowIso ?? new Date().toISOString(), ctx.outbox, ctx.lane) ?? alreadyApproved(label);
    case "cancelled": return replyText("cancelled", { label })!;
    case "already-answered": return replyText("already-answered")!;
    case "expired": return expiredText(label);
    case "declined": return declinedText(label);
    // superseded while it waited: replaced, never run
    case "closed": return "That one was already answered — nothing was sent.";
    case "not-recorded": return replyText("not-recorded", a, word)!;
  }
}
