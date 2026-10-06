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
            signed-in owner. job_id has no foreign key: job.set_stage
            names a coordination_jobs row, while the brief's reminder
            and the adjuster email name a field_projects one, so the
            page looks a spine job up in both tables (uuids don't
            collide). Since step 5, "YES n" by text reaches these rows
            too (roybal-notify's handleApproval matches sms_code), and a
            waiting spine card offers it the way a text-queue card does.
            An email here goes out through the worker, which sends only
            while its heartbeat lists the "email" channel; the page
            reads the newest heartbeat so a card can say when sending
            is off. A send the worker gave up on stays in Recently
            decided for 48 hours from when it did (its outbox row's last
            update), however old the approval, so "Couldn't send" is seen.

   The office page (apps/admin/js/approvals.js) reads both queues and
   the names around them; everything that decides what a card says
   lives here so node:test can pin it (approvals.test.mjs): one card
   shape for both lanes, which cards are waiting / recently decided /
   expired and in what order, the outcome line, the request each
   button sends, and a sentence for every refusal either server can
   give.

   Nothing in the field app imports this file, and it imports nothing,
   so it can't name an export that isn't there. It is no longer new,
   though: the field service worker (sw.js) can hand the office one
   load of an older cached copy after a deploy, paired with a newer
   apps/admin/js/approvals.js. So the page calls no export added after
   step 4; what step 5 added rides on calls it already made (fields on
   the card, lookFrom's options, needs' and inbox's answers), and an
   older copy just leaves the new lines off.
   ============================================================ */

const TZ = "America/Anchorage";
export const RECENT_MS = 48 * 3600 * 1000;      // "Recently decided" reaches back this far
export const EXPIRED_MS = 7 * 86400 * 1000;     // and the expired count this far
/* a heartbeat older than this is a worker that stopped: worker_liveness_check's
   alarm threshold, and outbox_channel_ready's (migration 0019) */
export const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

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
/* Every map here is read with a key a row supplied, and any signed-in login
   can file a text-queue ask, so only an OWN key counts: a kind, proposer or
   stage of "constructor" or "__proto__" is simply unknown, never one of
   Object.prototype's members. put() writes the same way (a plain assignment
   to "__proto__" would swap the map's prototype instead). Not Object.hasOwn:
   Safari before 15.4 lacks it, and a throw here would leave off every row. */
const hasOwn = (map, k) => Object.prototype.hasOwnProperty.call(map, k);
const own = (map, k) =>
  map && typeof map === "object" && (typeof k === "string" || typeof k === "number") && hasOwn(map, k) ? map[k] : undefined;
const put = (map, k, v) => Object.defineProperty(map, k, { value: v, enumerable: true, writable: true, configurable: true });
export const stageLabel = (id) => own(STAGES, id) || str(id);

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
   may carry a label and a link. Only an https link becomes a link, and it
   carries the host it really opens: the label is whatever the proposer
   wrote ("QuickBooks invoice INV-4" can point anywhere), so the card shows
   the host first, then the label. URL() gives the host as the browser will
   dial it: past any "mail.google.com@" userinfo, and punycode for a
   look-alike. */
function linkOf(u) {
  if (!/^https:\/\//i.test(u)) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname ? { url: u, host: url.hostname } : null;
  } catch { return null; }
}
/* A link's label that ends in its own "(quickbooks.intuit.com)" or
   "[opens mail.google.com]", or opens with "opens mail.google.com —", reads
   as the host it opens; the card prints the real one, so a host-like chunk
   there goes. The label is read as the screen shows it: NFKC folds the
   fullwidth brackets and dots, and format characters (zero-width spaces,
   direction marks) go, as does punctuation trailing the chunk. A filename
   ("(INV-4.pdf)") isn't a host and stays. Only the last 300 characters are
   looked at, a few chunks at most, and nothing here backtracks: labels are
   anyone's words, and one sized to stall a regex would stall the tab. */
const OPEN = "([{<\u3010\u2768\u27EE", CLOSE = ")]}>\u3011\u2769\u27EF";      // and 【】 ❨❩ ⟮⟯, which read as brackets
const TRAILING = /[\s.,;:!?\u2026\u2800]/u;                               // \u2800: the braille blank
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;             // zero-width, direction marks, variation selectors, fillers
const FILE_EXT = /^(?:pdf|jpe?g|png|gif|heic|heif|webp|tiff?|docx?|xlsx?|pptx?|csv|txt|rtf|odt|json|xml|eml|msg|dwg|dxf|kmz|kml|mp4|mov|m4a|mp3|wav|zip|esx)$/i;
const HOST_RUN = /(?:[\p{L}\p{N}-]+[.\u3002])+(\p{L}{2,})/gu;   // NFKC leaves the ideographic full stop
function hostish(t) {
  if (/:\/\/|\bwww\./i.test(t)) return true;
  for (const m of t.matchAll(HOST_RUN)) if (!FILE_EXT.test(m[1])) return true;
  return false;
}
function rtrim(s) {
  let i = s.length;
  while (i > 0 && TRAILING.test(s[i - 1])) i--;
  return s.slice(0, i);
}
/* The bracketed chunk that closes s (nesting counted), within its last 300 characters. */
function closingChunk(s) {
  if (!CLOSE.includes(s[s.length - 1])) return null;
  let depth = 0;
  for (let i = s.length - 1; i >= Math.max(0, s.length - 300); i--) {
    if (CLOSE.includes(s[i])) depth++;
    else if (OPEN.includes(s[i]) && --depth === 0) return { start: i, inner: s.slice(i + 1, -1) };
  }
  return null;
}
const LEAD = /^opens\s+(\S{1,253})\s*[\u2014\u2013:-]?\s*/iu;
export function labelOf(label) {
  const said = str(label);
  let s = said.normalize("NFKC").replace(INVISIBLE, "");
  let cut = false;
  const lead = LEAD.exec(s.slice(0, 300));
  if (lead && hostish(lead[1])) { s = s.slice(lead[0].length); cut = true; }
  for (let n = 0; n < 5; n++) {
    const c = closingChunk(rtrim(s));
    if (!c || !hostish(c.inner)) break;
    s = s.slice(0, c.start);
    cut = true;
  }
  // nothing claimed a host: the label shows exactly as written
  return cut ? rtrim(s).trim() : said;
}
function refsOf(v) {
  const list = Array.isArray(v) ? v : [];
  return list.slice(0, 10).map((x) => {
    if (typeof x === "string" || typeof x === "number") {
      const t = str(x);
      const link = linkOf(t);
      return { text: link ? labelOf(t) || link.url : t, url: link ? link.url : "", host: link ? link.host : "" };
    }
    const o = obj(x);
    const link = [o.url, o.href].map(str).map(linkOf).find(Boolean) || null;
    const said = [o.label, o.title, o.name, o.description, o.summary].map(str).find(Boolean) || "";
    const named = link ? labelOf(said) : said;
    const kindId = [str(o.kind || o.type), str(o.id || o.ref)].filter(Boolean).join(" ");
    const typed = link ? labelOf(kindId) : kindId;              // whatever text ends up beside the link
    const text = named || typed || (link && link.url) || JSON.stringify(o).slice(0, 200);
    return { text, url: link ? link.url : "", host: link ? link.host : "" };
  }).filter((r) => r.text && r.text !== "{}");
}

/* ---------- one card shape for both lanes ---------- */
/* card: { key, lane, id, code, kind, chip, title, approveLabel, yesHint,
           jobId, jobTable ("field" | "board" | "either": the table(s) the
           page looks jobId up in), job, by, byKind, byId, status, createdAt,
           expiresAt, decidedAt, answeredAt, evidence, result, error, outbox,
           emailLane (a spine email only: true / false while the worker is /
           isn't sending email, null when the page couldn't tell), laneHint
           (the line a waiting card shows about that, or ""),
           answeredHere (set by decidedText: this tab just answered it; the
           page sets it too while this tab's answer to it is still out) }
   look: { jobs: {id: name}, ops: {"email.send@1": description},
           people: {id: name}, outbox: {proposalId: outbox row},
           emailLane: true | false | null } */

/* What a spine email says while the worker isn't sending email, in the
   words roybal-notify texts back when a YES lands in that state ("It's
   queued, but email sending is off on the worker: it waits up to 48 hours
   for that to come back, then it isn't sent."). The 48 is the worker's
   EMAIL_MAX_AGE_HOURS default: an email row older than that when it would
   first go out is marked dead, not sent, so no line here promises more. */
export const LANE_OFF_WAITING = "Email sending is off on the worker right now: approving queues this, and it waits up to 48 hours for sending to come back, then it isn't sent.";
export const LANE_OFF_QUEUED = "Queued, but email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent";
export const LANE_OFF_FAILED = "Send failed, and email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent";

/** One pending_actions row → a card. */
export function fromPending(row, look = {}) {
  const r = obj(row), p = obj(r.params), res = obj(r.result);
  const kind = own(TEXT_KIND, r.kind) || "other";
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
    jobId, jobTable, job: own(look.jobs, jobId) || "",
    by: own(PROPOSERS, r.proposed_by) || str(r.proposed_by), byKind: "", byId: "",
    status: str(r.status), createdAt: str(r.created_at), expiresAt: str(r.expires_at),
    // pending_actions keeps no decision time, only when it ran: a decline or
    // a failure sorts by when it was asked and says so ("asked", not "answered")
    decidedAt: str(r.executed_at || r.created_at), answeredAt: str(r.executed_at),
    evidence: {
      to: str(p.to), cc: "", subject: str(p.subject), body: str(p.body),
      message: str(p.message), audience: str(p.audience),
      phase: str(phase.name), hours: Number.isFinite(hours) && hours > 0 ? hours : null,
      stage: "", rationale: "", refs: [], reason: "",
    },
    result: res, error: str(res.error), outbox: null,
    // the text queue's email goes out through gmail-proxy, not the worker
    emailLane: null, laneHint: "",
  };
}

/** One proposals row → a card. The input it shows is what would run:
    input with edited_params on top (op_execute's merge). */
export function fromProposal(row, look = {}) {
  const r = obj(row);
  const name = opName(r.operation);
  const kind = own(SPINE_KIND, name) || "other";
  const edited = obj(r.edited_params);
  const input = { ...obj(r.input), ...edited };
  // job.set_stage moves the job its params name (op_exec_job_set_stage reads
  // the merged input's job_id), and op_propose lets proposals.job_id differ
  // from it, so the card, the lookup and the confirm name that job; the
  // row's own job_id only stands in when the params name none
  const jobId = kind === "stage" ? str(edited.job_id ?? obj(r.input).job_id) || str(r.job_id) : str(r.job_id);
  const job = own(look.jobs, jobId) || "";
  const what = firstSentence(own(look.ops, str(r.operation)) || own(look.ops, name)) || name || "An ask";
  const key = kind === "email" || kind === "text" ? str(input.to) : kind === "stage" ? stageLabel(input.stage) : "";
  const byId = str(r.proposed_by_id);
  const status = str(r.status);
  // proposals_sms_code_seq numbers a row while it is proposed (unique only
  // among those, then free for reuse), so only a waiting row offers its number
  const code = Number(r.sms_code) || null;
  const sending = own(look, "emailLane");
  const emailLane = kind === "email" && (sending === true || sending === false) ? sending : null;
  return {
    key: "spine:" + str(r.id), lane: "spine", id: str(r.id), code, kind,
    chip: KINDS[kind].chip || name || "Ask",
    title: key ? `${what}: ${key}` : what,
    approveLabel: KINDS[kind].approve,
    yesHint: code && status === "proposed" ? `or text YES ${code}` : "",
    // job.set_stage moves a board job; anything else may name either table
    jobId, jobTable: kind === "stage" ? "board" : "either", job,
    by: proposerName(r.proposed_by_kind, own(look.people, byId)),
    byKind: str(r.proposed_by_kind), byId,
    status, createdAt: str(r.created_at), expiresAt: str(r.expires_at),
    decidedAt: str(r.approved_at || r.updated_at || r.created_at),
    answeredAt: str(r.approved_at || r.updated_at),     // a decline is the row's last update
    evidence: {
      to: str(input.to), cc: str(input.cc), subject: str(input.subject),
      body: kind === "email" ? str(input.body) : "",
      message: kind === "text" ? str(input.body) : "", audience: "",
      phase: "", hours: null, stage: kind === "stage" ? stageLabel(input.stage) : "",
      rationale: str(r.rationale), refs: refsOf(r.evidence_refs),
      reason: str(r.decline_reason),
    },
    result: obj(r.result), error: str(r.error),
    outbox: own(look.outbox, str(r.id)) || null,
    emailLane,
    laneHint: emailLane === false && status === "proposed" ? LANE_OFF_WAITING : "",
  };
}
const PROPOSER_KINDS = { human: "Someone in the office", agent: "An agent", policy: "A policy",
  integration: "An integration", system: "The system" };
function proposerName(kind, name) {
  return name || own(PROPOSER_KINDS, kind) || "";
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
/* When the worker gave up on a spine send (its outbox row went 'dead': the
   row's last update), else NaN. Only a string time counts: this runs over
   every card, outside cardsOf's guard. */
function diedAt(c) {
  const o = c.lane === "spine" && c.status === "executed" ? obj(c.outbox) : {};
  return o.status === "dead" && typeof o.updated_at === "string" ? ms(o.updated_at) : NaN;
}
/* The time a card counts as recent from: its answer, or when its send died
   if that came later. The worker can give up on an email long after the
   approval (it waited past its 48 hours with sending off, then the worker
   came back), and "Couldn't send" must still be seen then. */
function recentAt(c) {
  const at = ms(c.decidedAt), died = diedAt(c);
  return Number.isFinite(died) && !(died < at) ? died : at;
}
/** Answered within the last 48 hours, or a spine send whose outbox row
    died within them, however long ago it was answered. */
export const isRecent = (c, now = Date.now()) =>
  DECIDED[c.lane].includes(c.status) && recentAt(c) >= now - RECENT_MS;

/* A row that won't make a card (a field of a shape no producer writes, in
   an ask filed by hand) is left off with a console warning: it never takes
   the rest of the list down with it. One that may still be waiting is
   counted too (skip), so the page can say an ask is missing: a raw row that
   is open and unexpired, or one so odd its status and expiry won't read. */
function cardsOf(rows, make, lane, look, now, skip) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    try { out.push(make(r, look)); }
    catch (e) {
      const id = r && typeof r.id === "string" ? r.id : "no id";
      console.warn(`Approvals: left off a ${lane} row that didn't read (${id}): ${e && e.message ? e.message : e}`);
      let open = true;
      try { open = r.status === (lane === "text" ? "pending" : "proposed") && Date.parse(r.expires_at) > now; } catch { /* can't tell: count it */ }
      if (open) skip[lane]++;
    }
  }
  return out;
}

/** Both queues' rows → { waiting (soonest expiry first), recent (newest
    answer first; a send that died since counts from then), expired (a
    count), skipped ({text, spine}: rows that may be waiting but wouldn't
    make a card), older (the spine sends answered before the 48 hours, not
    on recent: one whose outbox row died since comes back to it, so the page
    reads their outbox rows, and the names they'd show with, too) }. */
export function inbox(pendingRows, proposalRows, look = {}, now = Date.now()) {
  const skipped = { text: 0, spine: 0 };
  const cards = [...cardsOf(pendingRows, fromPending, "text", look, now, skipped),
    ...cardsOf(proposalRows, fromProposal, "spine", look, now, skipped)];
  const waiting = unclash(cards.filter((c) => isLive(c, now)))
    .sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || ms(a.createdAt) - ms(b.createdAt));
  const recent = cards.filter((c) => isRecent(c, now))
    .sort((a, b) => recentAt(b) - recentAt(a));
  const older = cards.filter((c) => c.lane === "spine" && c.status === "executed" &&
    (c.kind === "email" || c.kind === "text") && !isRecent(c, now));
  return { waiting, recent, expired: cards.filter((c) => isExpired(c, now)).length, skipped, older };
}
/* One number live on both queues at once can't be answered by text:
   roybal-notify reads the same live rows, answers "code-clash" and runs
   neither. So neither card offers it; a tap here still answers each.
   sms_codes_in_use keeps new numbers apart; rows minted before it can
   still collide. Two text-queue rows on one number are today's guard
   (matchProposal) and are left as they were. */
function unclash(waiting) {
  const lanes = new Map();                         // number → the lanes offering it
  for (const c of waiting) if (c.yesHint && c.code) lanes.set(c.code, (lanes.get(c.code) || new Set()).add(c.lane));
  return waiting.map((c) => (c.yesHint && c.code && lanes.get(c.code).size > 1 ? { ...c, yesHint: "" } : c));
}
/** The line for asks that may be waiting but couldn't be shown. A text-queue
    ask can still be answered by text (the producer texted him its code), and
    so can a spine one the brief texted him; one that wasn't texted can't be. */
export function skippedLine(skipped) {
  const s = obj(skipped);
  const text = Number(s.text) || 0, spine = Number(s.spine) || 0, n = text + spine;
  if (n <= 0) return "";
  const head = `${n} ${n === 1 ? "ask" : "asks"} couldn't be shown here.`;
  if (!spine) return `${head} Answer ${n === 1 ? "it" : "them"} by text, or tell Claude.`;
  return `${head} Any that came to you by text can be answered there; otherwise tell Claude.`;
}

/** The ids the page must name for the cards it shows: job ids per table
    (uuids only: one bad id would sink an in.() read; "either" goes to
    both), proposers per kind, the spine sends whose outbox row says how
    delivery went, and lanes: ["email"] when a spine email is waiting or
    was sent, so the page reads the worker's heartbeat. */
export function needs(cards) {
  const out = { field: new Set(), board: new Set(), agents: new Set(), people: new Set(), outbox: new Set(), lanes: new Set() };
  for (const c of cards || []) {
    if (UUID.test(c.jobId)) {
      if (c.jobTable === "field" || c.jobTable === "either") out.field.add(c.jobId);
      if (c.jobTable === "board" || c.jobTable === "either") out.board.add(c.jobId);
    }
    if (c.lane !== "spine") continue;
    if (UUID.test(c.byId) && c.byKind === "agent") out.agents.add(c.byId);
    if (UUID.test(c.byId) && c.byKind === "human") out.people.add(c.byId);
    if (c.status === "executed" && (c.kind === "email" || c.kind === "text")) out.outbox.add(c.id);
    if (c.kind === "email" && (c.status === "proposed" || c.status === "executed")) out.lanes.add("email");
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

/** The newest worker_heartbeats row ({at, meta}, read newest first) → is the
    worker sending email: true when it beat within HEARTBEAT_FRESH_MS and
    its meta.channels lists "email"; false when it didn't (or no worker has
    ever beaten: outbox_channel_ready's rule); null when the read failed or
    the row won't read, which says nothing new on any card. */
export function emailLaneOf(heartbeats, now = Date.now()) {
  if (!Array.isArray(heartbeats)) return null;
  if (!heartbeats.length) return false;
  const row = obj(heartbeats[0]);
  const at = ms(row.at);
  const channels = obj(row.meta).channels;
  if (!Number.isFinite(at) || !Array.isArray(channels)) return null;
  return at > now - HEARTBEAT_FRESH_MS && channels.includes("email");
}

/** The lookup reads → the `look` the cards are built with. jobs are
    {id, title, customer, address}; outbox rows newest first; heartbeats
    the newest worker_heartbeats row as read (null: not read, or the read
    failed), judged at now. */
export function lookFrom({ catalog = [], agents = [], profiles = [], jobs = [], outbox = [], heartbeats = null, now = Date.now() } = {}) {
  const look = { jobs: {}, ops: {}, people: {}, outbox: {}, emailLane: emailLaneOf(heartbeats, now) };
  for (const j of jobs) if (j && j.id) put(look.jobs, str(j.id), jobName(j));
  for (const o of catalog) {
    if (!o || !o.name) continue;
    put(look.ops, `${o.name}@${o.version}`, str(o.description));
    if (!own(look.ops, str(o.name))) put(look.ops, str(o.name), str(o.description));
  }
  for (const a of agents) if (a && a.id && agentName(a.name)) put(look.people, str(a.id), agentName(a.name));
  for (const p of profiles) if (p && p.id && str(p.full_name)) put(look.people, str(p.id), str(p.full_name));
  for (const o of outbox) if (o && o.proposal_id && !own(look.outbox, str(o.proposal_id))) put(look.outbox, str(o.proposal_id), o);
  return look;
}

/* ---------- Alaska time ---------- */
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const tidy = (s) => s.replace(/[  ]/g, " ");       // ICU puts a narrow space before AM
/* An instant's Alaska calendar date as a day number (days since 1970-01-01).
   Two of them differ by the calendar days between, whatever the clock did:
   "24 h ago" lands on the wrong date next to the 23- and 25-hour DST days. */
function akDayNo(t) {
  const d = {};
  for (const { type, value } of DAY.formatToParts(t)) d[type] = Number(value);
  return Date.UTC(d.year, d.month - 1, d.day) / 86400000;
}
/** "7:02 AM" today, "yesterday 7:02 AM", else "Mon, Oct 5, 7:02 AM" — Alaska time. */
export function akTime(iso, now = Date.now()) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const back = akDayNo(now) - akDayNo(t);
  if (back === 0) return tidy(CLOCK.format(t));
  if (back === 1) return "yesterday " + tidy(CLOCK.format(t));
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
  return own({ sending: "Sending", sent: "Sent", delivered: "Delivered", failed: "Send failed, retrying",
    dead: "Couldn't send" + (str(o && o.error) ? ": " + str(o.error) : "") }, st) || "";
}
/* A text-queue row goes pending → approved → executed / failed inside the one
   request that answered it. Seen at 'approved', it may be mid-run (a YES text
   being handled right now, a tap on another phone, or this tab's own answer
   still out), so it waits a few minutes from when this tab first saw it so;
   still 'approved' after that, its request died before it could say how it
   went. */
export const WAIT_MS = 3 * 60 * 1000;
export const NEVER_REPORTED = "Approved, but it never reported back. Check whether it went out before sending it again.";
export const NEVER_REPORTED_PHASE = "Approved, but it never reported back. Check the board before approving it again.";
/** The outcome line on a Recently decided card: { text, tone: ok|no|bad|wait }.
    seenAt: when this tab first saw a text-queue row at 'approved' (the page
    keeps it, sawApproved); a card answeredHere (this tab's answer, landed or
    still out) waits whatever the time. */
export function outcome(c, now = Date.now(), seenAt = now) {
  const failed = { text: "Failed: " + (c.error || "no reason given"), tone: "bad" };
  if (c.status === "declined") {
    const why = c.lane === "spine" ? c.evidence.reason : "";
    return { text: "Declined" + (why ? ": " + why : ""), tone: "no" };
  }
  if (c.status === "failed") return failed;
  if (c.lane === "text") {
    if (c.status === "approved") {
      if (c.error) return failed;
      const phase = c.kind === "phase";
      if (c.answeredHere || now - (Number.isFinite(seenAt) ? seenAt : now) <= WAIT_MS) {
        return { text: phase ? "Approved — adding the phase" : "Approved — waiting to hear how it went", tone: "wait" };
      }
      return { text: phase ? NEVER_REPORTED_PHASE : NEVER_REPORTED, tone: "bad" };
    }
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
        // still in line (or between retries) while the worker isn't sending
        // email: it waits for that, not for its turn. Read as "queued" too
        // when no outbox row was read, as the line below already does.
        if (c.emailLane === false && (!d || st === "pending" || st === "failed")) {
          return { text: st === "failed" ? LANE_OFF_FAILED : LANE_OFF_QUEUED, tone: "wait" };
        }
        return { text: d || "Queued to send", tone: st === "dead" ? "bad" : st === "sent" || st === "delivered" ? "ok" : "wait" };
      }
      if (c.kind === "stage") return { text: "Moved to " + (stageLabel(c.result.to) || c.evidence.stage), tone: "ok" };
      return { text: "Done", tone: "ok" };
    }
  }
  return { text: cap(c.status), tone: "no" };
}
/** The page's record of when it first saw each text-queue row at 'approved'
    (seen: a Map, card key → ms, kept across refreshes) brought up to date with
    the cards just read: a new one starts now, and one no longer 'approved'
    drops out, so a row approved again later (a board retry put it back to
    pending) waits afresh. That only works while the reads are continuous:
    prevRead is when the text queue was last read before this one, and after a
    gap longer than READ_GAP_MS (the office was on another tab, the window was
    hidden) a revert and a fresh approval may have come and gone unseen, so
    a board phase still 'approved' starts over at now. Only a board phase
    can go back to pending (roybal-notify's retry when the board didn't
    answer); an email or a text never does, so its first sighting stands.
    Waiting a little longer misleads nobody; "never reported back" on a run
    seconds old does. A clock that went backwards is a gap too, and a
    sighting in the future is never kept. Returns seen. */
export const READ_GAP_MS = 150 * 1000;           // three 45 s refreshes missed in a row
export function sawApproved(seen, cards, now = Date.now(), prevRead = NaN) {
  const gap = Number.isFinite(prevRead) && (now - prevRead > READ_GAP_MS || now < prevRead);
  const still = new Set();
  for (const c of cards || []) {
    if (c.lane !== "text" || c.status !== "approved") continue;
    still.add(c.key);
    if (!seen.has(c.key) || seen.get(c.key) > now || (gap && c.kind === "phase")) seen.set(c.key, now);
  }
  for (const k of [...seen.keys()]) if (!still.has(k)) seen.delete(k);
  return seen;
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
const REFRESH = "Refresh to see whether it went through.";
/* 409s keep the row open; the server's message says when (the window is
   roybal-notify's SMS_QUIET_START/END, so these fallbacks name no hours) */
const STILL_WAITING = {
  quiet_hours: "Customer texts can't go out at this hour. This one is still waiting: approve it again once texting hours open.",
  try_again: "That didn't go through just now, and nothing changed. Try again in a minute.",
};

/** roybal-notify decidePending → { ok: true, status, message, action? } (the
    decision was recorded: executed, declined, or failed with why; action is
    the row as the server re-read it after, {status, result}), or { ok: false,
    error, gone } where gone means the row is no longer open. Until the
    function carries decidePending, its router answers 400 "Unknown action…";
    that, or a 404 that isn't not_open, means "answer this one by text". A 5xx
    may have come after the row was approved, so it says to refresh instead:
    a YES by then could no longer reach it. */
export function pendingAnswer(status, body, c, decision) {
  const b = body && typeof body === "object" ? body : null;
  const msg = str(b && b.message);
  const err = str(b && b.error);
  if (status === 200 && b && b.ok === true && str(b.status)) {
    const out = { ok: true, status: str(b.status), message: msg };
    if (b.action && typeof b.action === "object") out.action = { status: str(b.action.status), result: obj(b.action.result) };
    return out;
  }
  if (status === 404 && err === "not_open") return { ok: false, error: GONE, gone: true };
  // a 404 that isn't not_open is the gateway's "no such function"
  if ((status === 400 && /unknown action/i.test(err || msg)) || status === 404) {
    return { ok: false, error: `The server can't take this answer from the app yet. ${textInstead(c, decision)}` };
  }
  // role_is couldn't answer (nothing ran yet): its message says to try again
  if (status === 503 && err === "role_check_failed") return { ok: false, error: msg || "Couldn't check your login just now. Try again." };
  if (status >= 500 && !b) return { ok: false, error: `The server didn't answer. ${REFRESH}` };
  if (status >= 500) return { ok: false, error: `Something went wrong on the server (${status}${msg || err ? ": " + (msg || err) : ""}). ${REFRESH}` };
  if (status === 400) return { ok: false, error: `The server didn't accept this request${msg ? ": " + msg.replace(/\.$/, "") : ""}. Nothing changed.` };
  // role_is turned the token down even after callFunction's refresh-and-retry
  if (status === 401 && err === "auth") return { ok: false, error: "Your login expired. Sign in again." };
  if (status === 401) return { ok: false, error: SIGNED_OUT };
  if (status === 403) return { ok: false, error: "Only the owner's login can answer this." };
  if (status === 409 || own(STILL_WAITING, err)) {
    return { ok: false, error: msg || own(STILL_WAITING, err) || STILL_WAITING.quiet_hours };
  }
  return { ok: false, error: msg || err || `Couldn't record that (${status}).` };
}

/** op_proposal_approve / op_proposal_decline → { ok: true, row } or
    { ok: false, error, gone, declineOnly }. PostgREST puts the SQLSTATE in
    body.code and maps 55000 and P0002 to a 500, so the code decides, not the
    status. P0002 is two things: "no proposal x" (it's gone), and
    op_catalog_lookup's "no live operation x@1" (its catalog version was
    deprecated while it waited: still open, but only Decline can answer it,
    since op_proposal_decline never looks at the catalog). */
export function spineAnswer(status, body) {
  const b = body && typeof body === "object" ? body : null;
  if (status >= 200 && status < 300 && b && b.id) return { ok: true, row: b };
  const code = str(b && b.code);
  const msg = str(b && b.message).replace(/^op spine:\s*/i, "");
  if (code === "42501") return { ok: false, error: "Your login isn't allowed to answer this one." };
  if (code === "P0002" && /no live operation/i.test(msg)) {
    return { ok: false, error: "This kind of ask was retired before you answered it. Decline it; nothing was sent.", declineOnly: true };
  }
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

/** A text-queue card after decidePending recorded the decision. The row as
    the server re-read it after (answer.action) wins over the card's copy, so
    a phase that was already on the board says so now, not at the next
    refresh. One exception: a re-read still at 'approved' (it raced the
    executed stamp, or a stamp didn't land) never overrides a final answer:
    the request that ran it knows how it went. */
const FINAL = ["executed", "declined", "failed"];
export function decidedText(c, answer, now = Date.now()) {
  const a = obj(answer.action);
  const at = new Date(now).toISOString();
  const status = a.status === "approved" && FINAL.includes(answer.status) ? answer.status
    : DECIDED.text.includes(a.status) ? a.status : answer.status;
  const result = { ...c.result, ...obj(a.result) };
  if (answer.status === "failed" && !str(result.error) && str(answer.message)) result.error = str(answer.message);
  return { ...c, status, decidedAt: at, answeredAt: at, answeredHere: true, error: str(result.error) || c.error, result };
}
/** The lists after one card was answered: off Waiting, onto the top of Recently decided. */
export function settle(box, card, done) {
  return { ...box, waiting: box.waiting.filter((c) => c.key !== card.key),
    recent: [done, ...box.recent.filter((c) => c.key !== card.key)] };
}
