/* ============================================================
   Approvals inbox — pure logic for the office Approvals tab
   (operations spine, step 4). No DOM, no network.
   ------------------------------------------------------------
   The owner answers asks from two queues on one list:

     text   public.pending_actions, the "text YES 12" queue. The
            morning brief files emailSend (an overdue-invoice
            reminder; job_id is a field_projects id), the QuickBooks
            Time sweep files boardEdit (add a phase; job_id and
            params.rowId are a coordination_jobs id) and the text
            assistant files sendText (no job). Only the service role
            may change these rows, so the tab answers them through
            roybal-notify's decidePending, which runs the same
            executor a YES text does.
     spine  public.proposals (migrations 0004, 0013, 0014), answered
            with op_proposal_approve / op_proposal_decline as the
            signed-in owner. job_id has no foreign key; it is a
            coordination_jobs id when it is anything. "YES n" by text
            does not reach these rows yet, so a spine card never
            offers it, sms_code or not.

   The office page (apps/admin/js/approvals.js) reads both queues and
   the names around them; everything that decides what a card says
   lives here so node:test can pin it (approvals.test.mjs): one card
   shape for both lanes, which cards are waiting / recently decided /
   expired and in what order, the outcome line, the request each
   button sends, and a sentence for every refusal either server can
   give.

   Nothing in the field app imports this file. It is new, so the
   office browser can't hold a stale cached copy of it (sw.js), and
   it imports nothing, so it can't name an export that isn't there.
   ============================================================ */

const TZ = "America/Anchorage";
export const RECENT_MS = 48 * 3600 * 1000;      // "Recently decided" reaches back this far
export const EXPIRED_MS = 7 * 86400 * 1000;     // and the expired count this far

/* proposed_by on the text queue: one label per producer */
const PROPOSERS = { "morning-brief": "Morning brief", "qb-time": "QuickBooks Time", "sms-assist": "Text assistant" };
/* mirrors apps/board/js/board.js STAGES — same ids, same labels */
const STAGES = { lead: "Leads / Bids", scheduled: "Scheduled", in_progress: "In Progress", on_hold: "On Hold", final: "Final / Punch", done: "Complete" };
const KINDS = {
  email: { chip: "Email", approve: "Approve and send" },
  text: { chip: "Text", approve: "Approve and send" },
  phase: { chip: "Board phase", approve: "Approve and add phase" },
  stage: { chip: "Job stage", approve: "Approve and move job" },
  other: { chip: "", approve: "Approve" },
};
const TEXT_KIND = { emailSend: "email", sendText: "text", boardEdit: "phase" };
const SPINE_KIND = { "email.send": "email", "sms.send": "text", "job.set_stage": "stage" };
/* what each queue calls an answered row */
const DECIDED = {
  text: ["approved", "executed", "failed", "declined"],
  spine: ["approved", "executing", "executed", "failed", "declined", "superseded"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (v == null ? "" : String(v)).trim();
const ms = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : NaN; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const opName = (operation) => str(operation).split("@")[0];
export const stageLabel = (id) => STAGES[id] || str(id);

/** "Send one email. Execution writes…" → "Send one email"; a trailing
    "(coordination_jobs.data.stage)" is for developers, so it goes too. */
export function firstSentence(desc) {
  const s = str(desc).split(/\.\s/)[0].replace(/\.$/, "");
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** A job's name from a field_projects or coordination_jobs row read as
    {title, customer, address}: "Pollen, 1192 Bemis Ct". */
export function jobName(j) {
  const r = obj(j);
  return str(r.title) || [str(r.customer), str(r.address)].filter(Boolean).join(", ");
}
/** agents.name is a lane id ("agent:brief"); a card says "Brief agent". */
export function agentName(name) {
  const s = str(name).replace(/^agent:/, "").replace(/[-_]+/g, " ");
  return s ? cap(s) + " agent" : "";
}

/* evidence_refs has no defined shape (0004): a string, or an object that
   may carry a label and a link. Only an https link becomes a link. */
function refsOf(v) {
  const list = Array.isArray(v) ? v : [];
  return list.slice(0, 10).map((x) => {
    if (typeof x === "string" || typeof x === "number") {
      const t = str(x);
      return { text: t, url: /^https:\/\//i.test(t) ? t : "" };
    }
    const o = obj(x);
    const url = [o.url, o.href].map(str).find((u) => /^https:\/\//i.test(u)) || "";
    const named = [o.label, o.title, o.name, o.description, o.summary].map(str).find(Boolean);
    const typed = [str(o.kind || o.type), str(o.id || o.ref)].filter(Boolean).join(" ");
    const text = named || typed || url || JSON.stringify(o).slice(0, 200);
    return { text, url };
  }).filter((r) => r.text && r.text !== "{}");
}

/* ---------- one card shape for both lanes ---------- */
/* card: { key, lane, id, code, kind, chip, title, approveLabel, yesHint,
           jobId, jobTable, job, by, byKind, byId, status, createdAt,
           expiresAt, decidedAt, answeredAt, evidence, result, error, outbox }
   look: { jobs: {id: name}, ops: {"email.send@1": description},
           people: {id: name}, outbox: {proposalId: outbox row} } */

/** One pending_actions row → a card. */
export function fromPending(row, look = {}) {
  const r = obj(row), p = obj(r.params), res = obj(r.result);
  const kind = TEXT_KIND[r.kind] || "other";
  // boardEdit names a coordination_jobs row; the brief's emailSend a field job
  const jobTable = kind === "phase" ? "board" : "field";
  const jobId = kind === "phase" ? str(p.rowId || r.job_id) : str(r.job_id || p.jobId);
  const phase = obj(p.phase);
  const hours = Number(phase.estimatedHours);
  const code = Number(r.code) || null;
  return {
    key: "text:" + str(r.id), lane: "text", id: str(r.id), code, kind,
    chip: KINDS[kind].chip || str(r.kind) || "Ask",
    title: cap(str(r.label)) || str(r.kind) || "An ask",
    approveLabel: KINDS[kind].approve,
    yesHint: code ? `or text YES ${code}` : "",
    jobId, jobTable, job: obj(look.jobs)[jobId] || "",
    by: PROPOSERS[r.proposed_by] || str(r.proposed_by), byKind: "", byId: "",
    status: str(r.status), createdAt: r.created_at || "", expiresAt: r.expires_at || "",
    // pending_actions keeps no decision time, only when it ran: a decline or
    // a failure sorts by when it was asked and says so ("asked", not "answered")
    decidedAt: r.executed_at || r.created_at || "", answeredAt: r.executed_at || "",
    evidence: {
      to: str(p.to), cc: "", subject: str(p.subject), body: str(p.body),
      message: str(p.message), audience: str(p.audience),
      phase: str(phase.name), hours: Number.isFinite(hours) && hours > 0 ? hours : null,
      stage: "", rationale: "", refs: [], reason: "",
    },
    result: res, error: str(res.error), outbox: null,
  };
}

/** One proposals row → a card. The input it shows is what would run:
    input with edited_params on top (op_execute's merge). */
export function fromProposal(row, look = {}) {
  const r = obj(row);
  const name = opName(r.operation);
  const kind = SPINE_KIND[name] || "other";
  const input = { ...obj(r.input), ...obj(r.edited_params) };
  const jobId = str(r.job_id || (kind === "stage" ? input.job_id : ""));
  const job = obj(look.jobs)[jobId] || "";
  const ops = obj(look.ops);
  const what = firstSentence(ops[str(r.operation)] || ops[name]) || name || "An ask";
  const key = kind === "email" || kind === "text" ? str(input.to) : kind === "stage" ? stageLabel(input.stage) : "";
  const byId = str(r.proposed_by_id);
  return {
    key: "spine:" + str(r.id), lane: "spine", id: str(r.id), code: null, kind,
    chip: KINDS[kind].chip || name || "Ask",
    title: key ? `${what}: ${key}` : what,
    approveLabel: KINDS[kind].approve,
    yesHint: "",                         // YES by text doesn't reach the spine yet
    jobId, jobTable: "board", job,
    by: proposerName(r.proposed_by_kind, obj(look.people)[byId]),
    byKind: str(r.proposed_by_kind), byId,
    status: str(r.status), createdAt: r.created_at || "", expiresAt: r.expires_at || "",
    decidedAt: r.approved_at || r.updated_at || r.created_at || "",
    answeredAt: r.approved_at || r.updated_at || "",    // a decline is the row's last update
    evidence: {
      to: str(input.to), cc: str(input.cc), subject: str(input.subject),
      body: kind === "email" ? str(input.body) : "",
      message: kind === "text" ? str(input.body) : "", audience: "",
      phase: "", hours: null, stage: kind === "stage" ? stageLabel(input.stage) : "",
      rationale: str(r.rationale), refs: refsOf(r.evidence_refs),
      reason: str(r.decline_reason),
    },
    result: obj(r.result), error: str(r.error),
    outbox: obj(look.outbox)[str(r.id)] || null,
  };
}
function proposerName(kind, name) {
  if (name) return name;
  return { human: "Someone in the office", agent: "An agent", policy: "A policy",
    integration: "An integration", system: "The system" }[kind] || "";
}

/* ---------- which list a card is on ---------- */
const openStatus = (c) => (c.lane === "text" ? "pending" : "proposed");
/** Waiting on the owner: still open and not past its expiry. Nothing
    sweeps either queue on a schedule, so an open row past expires_at
    is expired whatever its status says. */
export const isLive = (c, now = Date.now()) => c.status === openStatus(c) && ms(c.expiresAt) > now;
/** Expired without an answer within the last 7 days. */
export const isExpired = (c, now = Date.now()) =>
  (c.status === "expired" || (c.status === openStatus(c) && ms(c.expiresAt) <= now)) &&
  ms(c.expiresAt) > now - EXPIRED_MS;
/** Answered within the last 48 hours. */
export const isRecent = (c, now = Date.now()) =>
  DECIDED[c.lane].includes(c.status) && ms(c.decidedAt) >= now - RECENT_MS;

/** Both queues' rows → { waiting (soonest expiry first), recent (newest
    answer first), expired (a count) }. */
export function inbox(pendingRows, proposalRows, look = {}, now = Date.now()) {
  const cards = [
    ...(Array.isArray(pendingRows) ? pendingRows : []).map((r) => fromPending(r, look)),
    ...(Array.isArray(proposalRows) ? proposalRows : []).map((r) => fromProposal(r, look)),
  ];
  const waiting = cards.filter((c) => isLive(c, now))
    .sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || ms(a.createdAt) - ms(b.createdAt));
  const recent = cards.filter((c) => isRecent(c, now))
    .sort((a, b) => ms(b.decidedAt) - ms(a.decidedAt));
  return { waiting, recent, expired: cards.filter((c) => isExpired(c, now)).length };
}

/** The ids the page must name for the cards it shows: job ids per table
    (uuids only: one bad id would sink an in.() read), proposers per
    kind, and the spine sends whose outbox row says how delivery went. */
export function needs(cards) {
  const out = { field: new Set(), board: new Set(), agents: new Set(), people: new Set(), outbox: new Set() };
  for (const c of cards || []) {
    if (UUID.test(c.jobId)) out[c.jobTable].add(c.jobId);
    if (c.lane !== "spine") continue;
    if (UUID.test(c.byId) && c.byKind === "agent") out.agents.add(c.byId);
    if (UUID.test(c.byId) && c.byKind === "human") out.people.add(c.byId);
    if (c.status === "executed" && (c.kind === "email" || c.kind === "text")) out.outbox.add(c.id);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

/** The lookup reads → the `look` the cards are built with. jobs are
    {id, title, customer, address}; outbox rows newest first. */
export function lookFrom({ catalog = [], agents = [], profiles = [], jobs = [], outbox = [] } = {}) {
  const look = { jobs: {}, ops: {}, people: {}, outbox: {} };
  for (const j of jobs) if (j && j.id) look.jobs[j.id] = jobName(j);
  for (const o of catalog) {
    if (!o || !o.name) continue;
    look.ops[`${o.name}@${o.version}`] = str(o.description);
    if (!look.ops[o.name]) look.ops[o.name] = str(o.description);
  }
  for (const a of agents) if (a && a.id && agentName(a.name)) look.people[a.id] = agentName(a.name);
  for (const p of profiles) if (p && p.id && str(p.full_name)) look.people[p.id] = str(p.full_name);
  for (const o of outbox) if (o && o.proposal_id && !look.outbox[o.proposal_id]) look.outbox[o.proposal_id] = o;
  return look;
}

/* ---------- Alaska time ---------- */
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const tidy = (s) => s.replace(/[  ]/g, " ");       // ICU puts a narrow space before AM
/** "7:02 AM" today, "yesterday 7:02 AM", else "Mon, Oct 5, 7:02 AM" — Alaska time. */
export function akTime(iso, now = Date.now()) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const day = DAY.format(t);
  if (day === DAY.format(now)) return tidy(CLOCK.format(t));
  if (day === DAY.format(now - 86400000)) return "yesterday " + tidy(CLOCK.format(t));
  return tidy(FULL.format(t));
}
/** "expires in 5 h" (whole hours, rounded down: it never overstates the time left). */
export function expiresIn(iso, now = Date.now()) {
  const m = Math.floor((ms(iso) - now) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "expires in under a minute";
  if (m < 60) return `expires in ${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `expires in ${hrs} h` : `expires in ${Math.floor(hrs / 24)} days`;
}
export const expiredLine = (n) =>
  n > 0 ? `${n} ${n === 1 ? "ask" : "asks"} expired without an answer in the last 7 days` : "";

/* ---------- what came of it ---------- */
/** A spine send's outbox row → its delivery state, when it was readable. */
function delivery(o, now) {
  const st = str(o && o.status);
  if (st === "pending") {
    const at = ms(o.next_attempt_at);
    return at > now + 60000 ? `Queued, goes out ${akTime(o.next_attempt_at, now)}` : "Queued to send";
  }
  return { sending: "Sending", sent: "Sent", delivered: "Delivered", failed: "Send failed, retrying",
    dead: "Couldn't send" + (str(o && o.error) ? ": " + str(o.error) : "") }[st] || "";
}
/** The outcome line on a Recently decided card: { text, tone: ok|no|bad|wait }. */
export function outcome(c, now = Date.now()) {
  const failed = { text: "Failed: " + (c.error || "no reason given"), tone: "bad" };
  if (c.status === "declined") {
    const why = c.lane === "spine" ? c.evidence.reason : "";
    return { text: "Declined" + (why ? ": " + why : ""), tone: "no" };
  }
  if (c.status === "failed") return failed;
  if (c.lane === "text") {
    if (c.status === "approved") return { text: "Approved, still running", tone: "wait" };
    if (c.status === "executed") {
      if (c.kind === "phase") return { text: c.result.skipped ? "Phase was already on the board" : "Phase added", tone: "ok" };
      return { text: c.kind === "other" ? "Done" : "Sent", tone: "ok" };
    }
  } else {
    if (c.status === "approved" || c.status === "executing") return { text: "Approved, queued to run", tone: "wait" };
    if (c.status === "superseded") return { text: "Replaced by a newer ask", tone: "no" };
    if (c.status === "executed") {
      if (c.kind === "email" || c.kind === "text") {
        const d = delivery(c.outbox, now);
        const st = str(c.outbox && c.outbox.status);
        return { text: d || "Queued to send", tone: st === "dead" ? "bad" : st === "sent" || st === "delivered" ? "ok" : "wait" };
      }
      if (c.kind === "stage") return { text: "Moved to " + (stageLabel(c.result.to) || c.evidence.stage), tone: "ok" };
      return { text: "Done", tone: "ok" };
    }
  }
  return { text: cap(c.status), tone: "no" };
}

/* ---------- the buttons ---------- */
/** The one confirm() before Approve, naming what it does. */
export function approveConfirm(c) {
  const e = c.evidence;
  if (c.kind === "email") return `Send this email to ${e.to || "the customer"}?`;
  if (c.kind === "text") return `Send this text to ${e.to || "them"}?`;
  if (c.kind === "phase") return `Add the phase "${e.phase || "this phase"}" to ${c.job || "this job"} on the board?`;
  if (c.kind === "stage") return `Move ${c.job || "this job"} to ${e.stage || "the new stage"} on the board?`;
  return `Approve: ${c.title}?`;
}
/** Decline on the text queue asks once; on the spine it asks for a reason. */
export const declineConfirm = (c) => `Decline "${c.title}"? Nothing is sent or changed.`;
export const declinePrompt = (c) => `Decline "${c.title}"?\n\nA reason, if you want to give one (optional):`;

/** What a button sends: an edge-function call for the text queue, an RPC for the spine. */
export function decisionRequest(c, decision, reason = "") {
  if (c.lane === "text") return { fn: "roybal-notify", body: { action: "decidePending", id: c.id, decision } };
  if (decision === "approve") return { rpc: "op_proposal_approve", body: { p_proposal_id: c.id, p_via: "inbox" } };
  return { rpc: "op_proposal_decline", body: { p_proposal_id: c.id, p_reason: str(reason) || null } };
}

/* ---------- every answer either server can give → a sentence ---------- */
export const NO_CONNECTION = "No connection. Try again when you're online.";
export const SIGNED_OUT = "Your sign-in has expired. Sign out, sign back in, and try again.";
const GONE = "Already answered, or it expired.";
const textInstead = (c, decision) =>
  decision === "decline" ? `Text NO ${c.code} to decline it.` : `Text YES ${c.code} to approve it.`;

/** roybal-notify decidePending → { ok: true, status, message } (the decision
    was recorded: executed, declined, or failed with why), or { ok: false,
    error, gone } where gone means the row is no longer open. Until the
    function carries decidePending, its router answers 400 "Unknown action…";
    that, a 404 that isn't not_open, or a 5xx with no JSON means "answer
    this one by text". */
export function pendingAnswer(status, body, c, decision) {
  const b = body && typeof body === "object" ? body : null;
  const msg = str(b && b.message);
  const err = str(b && b.error);
  if (status === 200 && b && b.ok === true && str(b.status)) return { ok: true, status: str(b.status), message: msg };
  if (status === 404 && err === "not_open") return { ok: false, error: GONE, gone: true };
  // a 404 that isn't not_open is the gateway's "no such function"
  if ((status === 400 && /unknown action/i.test(err || msg)) || status === 404 || (status >= 500 && !b)) {
    return { ok: false, error: `The server can't take this answer from the app yet. ${textInstead(c, decision)}` };
  }
  if (status >= 500) return { ok: false, error: `Something went wrong on the server (${status}${msg || err ? ": " + (msg || err) : ""}). ${textInstead(c, decision)}` };
  if (status === 400) return { ok: false, error: `The server didn't accept this request${msg ? ": " + msg.replace(/\.$/, "") : ""}. Nothing changed.` };
  if (status === 401) return { ok: false, error: SIGNED_OUT };
  if (status === 403) return { ok: false, error: "Only the owner's login can answer this." };
  if (status === 409 || err === "quiet_hours") {
    return { ok: false, error: "Customer texts go out only between 7 AM and 8 PM Alaska time. This one is still waiting: approve it again after 7 AM." };
  }
  return { ok: false, error: msg || err || `Couldn't record that (${status}).` };
}

/** op_proposal_approve / op_proposal_decline → { ok: true, row } or
    { ok: false, error, gone }. PostgREST puts the SQLSTATE in body.code
    and maps 55000 and P0002 to a 500, so the code decides, not the status. */
export function spineAnswer(status, body) {
  const b = body && typeof body === "object" ? body : null;
  if (status >= 200 && status < 300 && b && b.id) return { ok: true, row: b };
  const code = str(b && b.code);
  const msg = str(b && b.message).replace(/^op spine:\s*/i, "");
  if (code === "42501") return { ok: false, error: "Your login isn't allowed to answer this one." };
  if (code === "P0002") return { ok: false, error: "This ask no longer exists.", gone: true };
  if (code === "55000") return { ok: false, error: GONE, gone: true };
  if (code === "22023") return { ok: false, error: `The server refused this as invalid${msg ? ": " + msg : ""}. Nothing changed.` };
  if (/^PGRST30[123]$/.test(code) || status === 401) return { ok: false, error: SIGNED_OUT };
  if (code === "PGRST202" || code === "PGRST205" || status === 404) {
    return { ok: false, error: "The server doesn't have the approvals update yet. Nothing changed." };
  }
  if (/^PGRST/.test(code)) return { ok: false, error: `The server couldn't run that (${code}). Nothing changed.` };
  if (status >= 200 && status < 300) return { ok: false, error: "The server answered, but not with the ask. Refresh to see where it stands." };
  return { ok: false, error: msg || `Couldn't record that (${status}).` };
}

/** A text-queue card after decidePending recorded the decision. */
export function decidedText(c, answer, now = Date.now()) {
  const failed = answer.status === "failed";
  const at = new Date(now).toISOString();
  return { ...c, status: answer.status, decidedAt: at, answeredAt: at,
    error: failed ? answer.message || c.error : c.error,
    result: failed ? { ...c.result, error: answer.message } : c.result };
}
/** The lists after one card was answered: off Waiting, onto the top of Recently decided. */
export function settle(box, card, done) {
  return { ...box, waiting: box.waiting.filter((c) => c.key !== card.key),
    recent: [done, ...box.recent.filter((c) => c.key !== card.key)] };
}
