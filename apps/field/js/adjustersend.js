/* ============================================================
   Roybal Field Forms — the adjuster email, approve to send
   (operations spine, step 5)
   ------------------------------------------------------------
   The narrative page drafts the claim-submission email and appends
   the packet and photo links itself (app.js). For the OWNER, and only
   while the worker's email lane is live, the draft panel also gets a
   To field and "Send for approval": that files an email.send proposal
   under his own login (op_propose), and the panel then offers
   "Approve and send" / "Decline" right there. The same ask waits in
   the office Approvals tab and answers "YES n" by text; whichever
   door he uses first counts, and the spine sends it once (the
   proposal's row lock, the outbox idempotency key). Any answer that
   comes back approved (this tap, another door first, or the same
   email filed and approved earlier) reads that email's outbox row
   before saying where it stands: it went out, it couldn't be sent
   (the worker gave up on it), or it's on its way, with the email
   lane saying whether that wait can run out.

   A crew login, the owner while the lane is off, and any check that
   fails or doesn't answer all get the panel exactly as it was: Copy
   and Open in Email, nothing else. These checks only decide what to
   offer; the server gates stay the real ones (op_propose's role
   check, the proposals RLS, op_check_approver). A draft whose packet
   link didn't publish offers no send at all, only why.

   The recipient comes from records, never from the draft: the newest
   inbound email filed to this job that isn't the customer's (one
   matched on the claim number first), else an address typed into the
   job's Adjuster field, else blank for him to type. Either way he
   sees it, and can change it, before anything is filed.

   app.js loads this file on demand, so a phone whose cache missed it
   still opens the page, with the old panel. The pure half (the
   address rules, the request bodies, every answer the spine can give
   and its sentence) is pinned by test/adjustersend.test.mjs.
   ============================================================ */
import { h } from "./core.js";
import { SYNC_ENABLED } from "./config.js";
import { rest, isSignedIn, currentEmail } from "./supa.js";

const TZ = "America/Anchorage";
/* email.send@1's `to` (0014): ONE bare address, no list, no "Name <a@b>".
   JS's \s covers every character POSIX [:space:] does and a few more, so
   an address this accepts the server accepts too. */
export const SPINE_TO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX = { to: 320, subject: 300, body: 100000 };          // email.send@1's maxLengths
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* An adjuster can take a few days to get to it; the YES code and the
   Approvals card stay live this long. */
export const EXPIRES_IN = "72 hours";
export const SIGNED_OUT = "Your sign-in has expired. Sign out, sign back in, and try again.";

const str = (v) => (v == null ? "" : String(v)).trim();
const lc = (v) => str(v).toLowerCase();
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const ms = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : NaN; };
/* one line for a rationale: a claim # pasted from a PDF can carry control
   bytes and line breaks, and the text reply quotes the rationale's first line */
const oneLine = (v) => str(v).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();

/* ---------- addresses ---------- */
/* The local part keeps every RFC 5322 atext character (' ` { } | / = ? and
   the rest), so kelly.o'brien@… stays whole instead of turning into a
   different, valid-looking brien@…; the domain stops at quotes and braces.
   Both stop at whitespace, @ and the separators <>()[],;:". */
const TOKEN = /[^\s<>()[\]@,;:"]+@[^\s<>()[\]{}@,;:"'`]+/g;
const SEPARATOR = /[\s<>()[\],;:"]/;
/* only quotes AROUND an address go (and a sentence's closing punctuation) */
const unwrap = (a) => a.replace(/^['`‘’“”]+/, "").replace(/['`‘’“”.!?]+$/, "");
/** The first address in free text ("Jane Doe (jane@carrier.com), 907…"),
    surrounding quotes and trailing sentence punctuation dropped; "" when
    none passes SPINE_TO. */
export function addressIn(text) {
  for (const m of String(text ?? "").matchAll(TOKEN)) {
    const a = unwrap(m[0]);
    if (SPINE_TO.test(a) && a.length <= MAX.to) return a;
  }
  return "";
}
/** "Jane <JANE@x.com>" or "jane@x.com" → "jane@x.com"; "" when none. A value
    that already is one bare address (gmail-proxy stores from_addr that way,
    apostrophes and all) comes back whole, never re-cut by the free-text scan. */
export function bareAddress(v) {
  const s = str(v);
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (m && SPINE_TO.test(m[1])) return lc(m[1]);
  const whole = unwrap(s);
  if (!SEPARATOR.test(s) && SPINE_TO.test(whole) && whole.length <= MAX.to) return lc(whole);
  return lc(addressIn(s));
}

/** Who the email goes to, from records only. `emails` are this job's inbound
    email_messages rows ({from_addr, matched_by, received_at}). The customer's
    own address (project.email) never counts: it's the adjuster's email.
    → { to, source: "claim" | "email" | "adjuster" | "", at } */
export function prefillTo(project, emails) {
  const p = obj(project);
  const customer = bareAddress(p.email);
  const usable = (a) => !!a && SPINE_TO.test(a) && a.length <= MAX.to && a !== customer;
  const newest = (r) => { const t = ms(r.received_at); return Number.isFinite(t) ? t : -Infinity; };
  const rows = arr(emails).map(obj).filter((r) => !r.direction || r.direction === "in")
    .sort((a, b) => newest(b) - newest(a));
  const pick = (want) => rows.find((r) => want(r) && usable(bareAddress(r.from_addr)));
  const hit = pick((r) => r.matched_by === "claim") || pick(() => true);
  if (hit) return { to: bareAddress(hit.from_addr), source: hit.matched_by === "claim" ? "claim" : "email", at: str(hit.received_at) };
  const typed = addressIn(p.adjuster);
  if (typed && usable(lc(typed))) return { to: typed, source: "adjuster", at: "" };
  return { to: "", source: "", at: "" };
}

/** The To field before filing → { ok: true, to } or { ok: false, error }. */
export function checkAddress(v) {
  const to = str(v);
  if (!to) return { ok: false, error: "Type the adjuster's email address." };
  if ((to.match(/@/g) || []).length > 1 || /[,;]/.test(to)) return { ok: false, error: "One address only: this sends to a single adjuster." };
  // any angle bracket, not only a <name> pair: the worker refuses a stray one for good (rfc822.mjs validAddresses)
  if (/[<>]/.test(to)) return { ok: false, error: "Just the address, without the name." };
  if (!SPINE_TO.test(to)) return { ok: false, error: "That doesn't look like an email address." };
  if (to.length > MAX.to) return { ok: false, error: "That address is too long." };
  return { ok: true, to };
}
/** The subject and body as edited → "" or what's wrong. */
export function checkDraft(subject, body) {
  if (!str(subject)) return "The subject is empty.";
  if (str(subject).length > MAX.subject) return `The subject is too long (${MAX.subject} characters at most).`;
  if (!str(body)) return "The email is empty.";
  if (String(body).length > MAX.body) return "The email is too long to send this way.";
  return "";
}

/* ---------- the proposal ---------- */
/** What the Approvals card's "Why" line and the YES text say this ask is. */
export function rationaleFor(project) {
  const p = obj(project);
  const claim = oneLine(p.claimNo);
  const who = oneLine(p.customer) || oneLine(p.address);
  return `Claim documentation email to the adjuster${claim ? ` for claim ${claim}` : ""}${who ? ` — ${who}` : ""}`;
}
const REFS = [["packet", "Job packet"], ["photos", "Job photos"], ["contents", "Contents photos"]];
/** The live share links the body carries, as the card's evidence links:
    {packet, photos, contents} URLs → [{label, url}], https only, in that order. */
export function linkRefs(links) {
  const l = obj(links);
  return REFS.filter(([k]) => /^https:\/\//i.test(str(l[k]))).map(([k, label]) => ({ label, url: str(l[k]) }));
}
/** The op_propose body. Sent with supa.js's rest(), not its private rpc():
    that one adds p_build, which op_propose has no parameter for. */
export function proposeBody({ project, to, subject, body, links }) {
  return {
    p_operation: "email.send",
    p_input: { to: str(to), subject: str(subject), body: String(body ?? "") },
    p_job_id: str(obj(project).id),
    p_rationale: rationaleFor(project),
    p_evidence_refs: linkRefs(links),
    p_proposed_via: "ui",
    p_expires_in: EXPIRES_IN,
  };
}
/** "chip": answered in the app, beside the draft (the inbox says "inbox"). */
export const approveRequest = (id) => ({ rpc: "op_proposal_approve", body: { p_proposal_id: id, p_via: "chip" } });
export const declineRequest = (id, reason = "") =>
  ({ rpc: "op_proposal_decline", body: { p_proposal_id: id, p_reason: str(reason) || null } });

/** What would run: op_execute merges edited_params over input. */
const inputOf = (row) => ({ ...obj(obj(row).input), ...obj(obj(row).edited_params) });
const toOf = (row) => str(inputOf(row).to);

/** This job's open asks (rows from the proposals read) against the email
    about to be filed. `same`: the identical email to the same address, still
    waiting, which the panel shows instead of filing (op_propose would hand
    the same row back today anyway). `other`: a different email to that
    address, still waiting; approving both would send both, so he's asked. */
export function matchOpen(rows, to, subject, body, now = Date.now()) {
  const want = lc(to);
  const live = arr(rows).map(obj).filter((r) => r.status === "proposed" && ms(r.expires_at) > now && lc(toOf(r)) === want);
  const same = live.find((r) => { const i = inputOf(r); return str(i.subject) === str(subject) && String(i.body ?? "") === String(body ?? ""); }) || null;
  const other = live.find((r) => r !== same) || null;
  return { same, other };
}

/** Where a proposal row stands, as this panel treats it. */
export function rowState(row, now = Date.now()) {
  const r = obj(row);
  if (r.status === "proposed") return ms(r.expires_at) > now ? "waiting" : "expired";
  if (["approved", "executing", "executed"].includes(r.status)) return "approved";
  if (["declined", "superseded", "expired", "failed"].includes(r.status)) return r.status === "superseded" ? "declined" : r.status;
  return "other";
}

/* ---------- every answer the three RPCs can give ----------
   Read the way the office Approvals tab reads them (approvals.js
   spineAnswer): PostgREST puts the SQLSTATE in body.code and maps 55000
   and P0002 to a 500, so the code decides, not the status. A function
   returning one row comes back as an object; a one-element array is
   taken too. → { ok: true, row } or { ok: false, why, status, code, message } */
export function answerOf(status, body) {
  const b = obj(Array.isArray(body) && body.length === 1 ? body[0] : body);
  if (status >= 200 && status < 300 && str(b.id)) return { ok: true, row: b };
  const code = str(b.code);
  const message = str(b.message).replace(/^op spine:\s*/i, "");
  const no = (why) => ({ ok: false, why, status, code, message });
  if (code === "42501") return no("forbidden");
  if (code === "P0002" && /no live operation/i.test(message)) return no("retired");
  if (code === "P0002") return no("gone");
  if (code === "55000") return no(/expired/i.test(message) ? "expired" : "answered");
  if (code === "22023") return no("invalid");
  if (/^PGRST30[123]$/.test(code) || status === 401) return no("signedout");
  if (code === "PGRST202" || code === "PGRST205" || status === 404) return no("old");
  if (status >= 200 && status < 300) return no("odd");
  return no("server");
}
/* "op spine: proposal <id> is declined; only a proposed row…" → "declined" */
const answeredAs = (message) => (str(message).match(/\bis (approved|executing|executed|failed|declined|superseded)\b/) || [])[1] || "";
const APPROVED = ["approved", "executing", "executed"];

/* ---------- what became of an approved email ----------
   The worker marks an email it gave up on dead (a permanent Gmail
   refusal, too many tries, or past EMAIL_MAX_AGE_HOURS, 48), so a line
   about an approved email says it went, or that it goes out, only
   from its outbox row and the lane, in the YES reply's words
   (roybal-notify's approve.ts says the same by text). */
/** outbox.error as the line quotes it: trimmed, 160 characters, its
    closing period dropped (the sentence adds its own); nothing there =
    "it gave up". roybal-notify's replies quote it the same way. */
const deadReason = (e) => Array.from(str(e)).slice(0, 160).join("").trim().replace(/\.+$/, "").trim() || "it gave up";
/** outbox rows for one proposal ({status, error}) → { state: "sent" } (sent
    or delivered), { state: "dead", error } (the worker gave up on it for
    good), else { state: "waiting" }: pending, sending, failed and still
    retrying, no row yet, or a read that failed, so a blip never says it
    went. Read the way roybal-notify's outboxState reads them. */
export function outboxState(rows) {
  const list = arr(rows).map(obj);
  if (list.some((r) => r.status === "sent" || r.status === "delivered")) return { state: "sent" };
  const dead = list.find((r) => r.status === "dead");
  return dead ? { state: "dead", error: deadReason(dead.error) } : { state: "waiting" };
}
const LANE_OFF = "It's queued, but email sending is off on the worker: it waits up to 48 hours for that to come back, then it isn't sent.";
export const deadLine = (outbox) => `That one was approved, but the email couldn't be sent: ${obj(outbox).error || "it gave up"}. Nothing went out.`;
/* the sentence after "…already approved". `lane` is what
   outbox_channel_ready('email') said: true, false, or null when it couldn't */
const goesOut = (outbox, lane) => obj(outbox).state === "sent" ? "It went out once." : lane === false ? LANE_OFF : "It goes out once.";
/** An email approved before this tap, as its outbox state and the lane say
    it stands. `by`: "by text", "in the Approvals tab", or "" when the
    answer doesn't say which door. */
export function elsewhereLine(by, outbox, lane) {
  if (obj(outbox).state === "dead") return deadLine(outbox);
  return `That one was already approved${by ? " " + by : ""}. ${goesOut(outbox, lane)}`;
}

/** A refusal → its sentence. action: "file" | "approve" | "decline".
    `after` ({outbox, lane}): for a decline that found the email approved
    elsewhere first, what its outbox row and the lane say. */
export function refusal(action, ans, after = {}) {
  const a = obj(ans);
  const then = obj(after);
  const m = a.message ? ": " + a.message.replace(/\.$/, "") : "";
  const was = answeredAs(a.message);
  if (a.why === "signedout") return SIGNED_OUT;
  if (action === "file") {
    if (a.why === "network") return "Couldn't reach the server, so it may not have been filed. Trying again is safe: the same email is only filed once.";
    if (a.why === "forbidden") return "Your login can't send email for approval. Nothing was filed.";
    if (a.why === "invalid") return `The server refused this email${m}. Nothing was filed.`;
    if (a.why === "retired") return "Email sending isn't set up on the server right now. Nothing was filed.";
    if (a.why === "old") return "The server doesn't have email approvals yet. Nothing was filed; copy it or open it in your mail app instead.";
    if (a.why === "odd") return "The server answered, but not with the ask. Check the Approvals tab before trying again.";
    return `The server couldn't file it (${a.status}${m}). Trying again is safe: the same email is only filed once.`;
  }
  if (a.why === "network") {
    return action === "approve"
      ? "Couldn't reach the server. Trying again is safe: it sends once, however many times it's approved."
      : "Couldn't reach the server. Try again.";
  }
  if (a.why === "forbidden") return "Your login isn't allowed to answer this one.";
  if (a.why === "expired") return "That one expired — nothing was sent.";
  if (a.why === "gone") return "This ask no longer exists. Nothing was sent.";
  if (a.why === "answered") {
    if (was === "declined" || was === "superseded") return "That one was declined — nothing was sent.";
    if (action === "decline" && was === "failed") return "That one was approved, but it didn't run. Nothing was cancelled.";
    if (action === "decline" && APPROVED.includes(was)) return elsewhereLine("", then.outbox, then.lane);
    return action === "decline" ? "That one was already answered — nothing was cancelled." : "That one was already answered. Check the Approvals tab.";
  }
  if (a.why === "retired") return "This kind of ask was retired before you answered it. Decline it; nothing was sent.";
  if (a.why === "invalid") return `The server refused this as invalid${m}. Nothing changed.`;
  if (a.why === "old") return "The server doesn't have the approvals update yet. Nothing changed.";
  if (a.why === "odd") return "The server answered, but not with the ask. Check the Approvals tab to see where it stands.";
  return `The server couldn't run that (${a.status}${m}). Nothing changed.`;
}

/* ---------- the panel's wording ---------- */
function akFormat(iso, opts) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).format(new Date(t)); } catch { return ""; }
}
const akDay = (iso) => akFormat(iso, { month: "short", day: "numeric" });
const akWhen = (iso) => akFormat(iso, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Under the To field: where the address came from, so he checks the right thing. */
export function sourceLine(setup) {
  const s = obj(setup);
  const day = akDay(s.at);
  const on = day ? ` (${day})` : "";
  if (s.source === "claim") return `From the newest email about this claim${on}. Check it's the adjuster's.`;
  if (s.source === "email") return `From the newest email filed to this job that isn't the customer's${on}. Check it's the adjuster's.`;
  if (s.source === "adjuster") return "From the job's Adjuster field.";
  return "No adjuster address on file yet. Type it in.";
}
export const approveConfirm = (to) => `Send this email to ${to || "the adjuster"}?`;
export const declinePrompt = (to) => `Decline the email to ${to || "the adjuster"}?\n\nA reason, if you want to give one (optional):`;
export function dupConfirm(row, to) {
  const when = akWhen(obj(row).created_at);
  return `Another email to ${to} is already waiting for approval on this job${when ? ` (asked ${when})` : ""}. Approving both would send both.\n\nSend this one for approval too?`;
}
export const uncheckedConfirm = (to) =>
  `Couldn't check whether an email to ${to} is already waiting for approval on this job.\n\nSend this one for approval anyway?`;
export const waitingLine = (row) => `⏳ Waiting for approval — the email to ${toOf(row)}.`;
/** The other doors, beside the buttons. The YES number is the row's own
    sms_code, and only while it waits (a decided row's code is reused). */
export function doorsLine(row) {
  const r = obj(row);
  const code = Number(r.sms_code);
  const yes = r.status === "proposed" && Number.isInteger(code) && code > 0 ? `, or text YES ${code}` : "";
  return `or approve it from the Approvals tab${yes}`;
}
/** The door that approved a row before this tap, as a line names it: "by
    text", "in the Approvals tab", or "" (this panel's own "chip", or a door
    no line names). */
export function approvedBy(row) {
  const via = obj(row).approved_via;
  return via === "sms" ? "by text" : via === "inbox" ? "in the Approvals tab" : "";
}
/** After Approve. `lane` is outbox_channel_ready('email') read just after:
    true, false, or null when it couldn't say; `outbox` is the email's outbox
    state (outboxState) read beside it. A row someone answered first by text
    or in the inbox comes back as it was (approving twice is approving once)
    and says so, and how its email stands. An outbox row that already went
    out, or died, was approved before this tap too, whichever door (another
    phone's panel), and says that. A read that failed is "waiting": the lane
    decides the words, and it never says it went. The worker marks an email
    that waited past EMAIL_MAX_AGE_HOURS (48) dead rather than send it late,
    so no lane-off line promises an open-ended wait (the YES reply's words). */
export function approvedLine(row, lane, outbox = null) {
  const r = obj(row);
  if (r.status === "failed") return `⚠️ Approved, but it didn't run: ${str(r.error) || "no reason given"}`;
  const by = approvedBy(r);
  if (by) return elsewhereLine(by, outbox, lane);
  const o = obj(outbox);
  if (o.state === "dead") return deadLine(o);
  const to = toOf(r);
  if (o.state === "sent") return `✅ Approved — the email to ${to}. It went out once.`;
  if (lane === true) return `✅ Approved — the email to ${to} is queued and goes out in a minute.`;
  if (lane === false) return `✅ Approved — the email to ${to}. ${LANE_OFF}`;
  return `✅ Approved — the email to ${to} is queued to send.`;
}
/** op_propose handed back a row that isn't waiting: the same email (same
    address, subject and body, same Alaska day) was filed before and answered.
    `after` ({outbox, lane}) for one approved then: what its outbox row and
    the lane say, as approvedLine reads them. */
export function filedNote(row, now = Date.now(), after = {}) {
  const st = rowState(row, now);
  const { outbox, lane } = obj(after);
  if (st === "approved" && obj(outbox).state === "dead") {
    return `This exact email was approved earlier, but it couldn't be sent: ${obj(outbox).error || "it gave up"}. Nothing went out. Change it to ask again.`;
  }
  if (st === "approved") return `This exact email was already approved. ${goesOut(outbox, lane)}`;
  if (st === "declined") return "This exact email was declined earlier today, so it wasn't filed again. Change it to ask again.";
  if (st === "expired") return "This exact email expired unanswered, so it wasn't filed again. Change it to ask again.";
  if (st === "failed") return `This exact email was approved earlier, but it didn't run: ${str(obj(row).error) || "no reason given"}. Change it to ask again.`;
  return "The server answered, but not with the ask. Check the Approvals tab before trying again.";
}
export const DECLINED = "👍 Declined — nothing was sent. Change it and send it for approval again if you want.";
export const NO_PACKET = "The packet link didn't publish, so this email can't go for approval: it would reach the adjuster without the packet. " +
  "Tap ✉️ Adjuster email to draft it again (that retries the link), or use Copy.";

/* ---------- network ---------- */
/* Is this the owner's login? true / false once role_is said so (kept per
   login for the page's life), null when it couldn't say: a blip is never
   kept, so the next draft asks again. Not magicplan.js's callerRole(),
   which keeps a failed check as "no role". */
let owner = { who: "", is: null };
export async function isOwner() {
  const who = currentEmail();
  if (owner.who !== who) owner = { who, is: null };
  if (owner.is !== null) return owner.is;
  const mine = owner;
  try {
    const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: ["owner"] }) });
    if (res.status !== 200) return null;
    const yes = await res.json().catch(() => null);
    if (yes === true || yes === false) { mine.is = yes; return yes; }
    return null;
  } catch { return null; }
}
/** Would an email queued now go out? Only a 200 with a literal true is yes;
    false is a 200 with a literal false; anything else (no 0019 on the
    server yet, a 5xx, no connection) is null, which offers nothing. */
export async function emailLane() {
  try {
    const res = await rest("rpc/outbox_channel_ready", { method: "POST", body: JSON.stringify({ p_channel: "email" }) });
    if (res.status !== 200) return null;
    const v = await res.json().catch(() => null);
    return v === true ? true : v === false ? false : null;
  } catch { return null; }
}
/** What became of an approved email: its newest outbox row (the owner reads
    every one, outbox_read_office), as outboxState reads it. Never throws; a
    read that failed is "waiting", which never says it went. */
export async function outboxOf(id) {
  try {
    const res = await rest(`outbox?proposal_id=eq.${encodeURIComponent(str(id))}&select=status,error&order=created_at.desc&limit=1`, { method: "GET" });
    return outboxState(res.ok ? await res.json().catch(() => null) : null);
  } catch { return outboxState(null); }
}
async function jobInbound(jobId) {
  const res = await rest(`email_messages?job_id=eq.${encodeURIComponent(jobId)}&direction=eq.in&order=received_at.desc&limit=20` +
    "&select=from_addr,matched_by,received_at", { method: "GET" });
  if (!res.ok) throw new Error("email read failed (" + res.status + ")");
  return res.json();
}
/** This job's waiting email asks (owner RLS reads them all). Throws when
    the read fails; the panel then asks before filing. */
export async function openAsks(jobId, now = Date.now()) {
  const res = await rest(`proposals?operation=like.email.send@*&job_id=eq.${encodeURIComponent(jobId)}&status=eq.proposed` +
    `&expires_at=gt.${encodeURIComponent(new Date(now).toISOString())}` +
    "&select=id,input,edited_params,status,sms_code,expires_at,created_at&order=created_at.desc&limit=20", { method: "GET" });
  if (!res.ok) throw new Error("proposals read failed (" + res.status + ")");
  return arr(await res.json());
}
async function call(rpc, body) {
  let res;
  try { res = await rest("rpc/" + rpc, { method: "POST", body: JSON.stringify(body) }); }
  catch { return { ok: false, why: isSignedIn() ? "network" : "signedout", status: 0, code: "", message: "" }; }
  const json = await res.json().catch(() => null);
  return answerOf(res.status, json);
}
export const fileAsk = (body) => call("op_propose", body);
export const approveAsk = (id) => { const q = approveRequest(id); return call(q.rpc, q.body); };
export const declineAsk = (id, reason) => { const q = declineRequest(id, reason); return call(q.rpc, q.body); };

/** Should the draft panel offer approve-to-send? → null (offer nothing: the
    panel stays exactly as it was) or the To prefill { to, source, at }.
    Never throws. The job id must be a uuid: proposals.job_id is one. */
export async function sendSetup(project) {
  try {
    const p = obj(project);
    if (!SYNC_ENABLED || !isSignedIn() || !UUID.test(str(p.id))) return null;
    if ((await isOwner()) !== true) return null;
    if ((await emailLane()) !== true) return null;
    let emails = [];
    try { emails = await jobInbound(p.id); } catch { emails = []; }   // no prefill, still offered
    return prefillTo(p, emails);
  } catch { return null; }
}

/* ---------- the section under the draft ----------
   subj / bodyTa are the panel's own subject input and body textarea: what
   gets filed is what he sees, as edited. Once filed they lock, so the
   draft on screen can't drift from the ask waiting on his yes; a decline
   (or an answer that leaves nothing waiting) unlocks them. */
const FIELD = "width:100%;padding:8px 10px;border:1px solid #cdd5df;border-radius:10px;font-size:13px";
const SECTION = "border-top:1px solid #dfe5ee;margin-top:10px;padding-top:10px";
export function sendSection({ project, subj, bodyTa, setup, links }) {
  /* The packet is the email's whole point and the draft says it's linked
     below: with no packet link (its publish failed; app.js only toasts)
     there's nothing to file, just why, and Copy above still works. */
  if (!/^https:\/\//i.test(str(obj(links).packet))) {
    return h("div", { class: "adjuster-send", style: SECTION }, h("div", { class: "warn", style: "margin:0" }, NO_PACKET));
  }
  const s = obj(setup);
  const toInp = h("input", { type: "email", value: str(s.to), placeholder: "adjuster@carrier.com", autocomplete: "off", autocapitalize: "off", spellcheck: "false", style: FIELD });
  const note = h("div", { style: "font-size:13px;margin-top:8px", hidden: true });
  const actions = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px" });
  const err = h("div", { class: "warn", role: "alert", hidden: true, style: "margin:8px 0 0" });
  const sendBtn = h("button", { class: "btn btn--sm btn--primary" }, "Send for approval");
  const approveBtn = h("button", { class: "btn btn--sm btn--primary" }, "Approve and send");
  const declineBtn = h("button", { class: "btn btn--sm btn--ghost" }, "Decline");
  let row = null, busy = false;

  const say = (el, text) => { el.textContent = text || ""; el.hidden = !text; };
  const lock = (on) => { for (const el of [toInp, subj, bodyTa]) if (el) el.readOnly = on; };
  const compose = (text = "") => { row = null; lock(false); say(note, text); actions.replaceChildren(sendBtn); };
  const waiting = (r) => {
    row = r; lock(true); say(note, waitingLine(r));
    approveBtn.disabled = declineBtn.disabled = false;
    actions.replaceChildren(approveBtn, declineBtn, h("span", { class: "subtle", style: "font-size:12px;margin:0" }, doorsLine(r)));
  };
  const done = (text) => { lock(true); say(note, text); actions.replaceChildren(); };
  /* a row that came back answered: approved stays locked, anything else
     unlocks, and so does an approved email that couldn't be sent (`after`:
     its {outbox, lane}), so he can change it and ask again */
  const settled = (r, text, after = {}) =>
    (rowState(r) === "approved" && obj(obj(after).outbox).state !== "dead" ? done(text) : compose(text));
  /* an approved email: its outbox row and the lane, read side by side for
     the line that says where it stands (neither read throws) */
  const delivery = async (id) => { const [outbox, lane] = await Promise.all([outboxOf(id), emailLane()]); return { outbox, lane }; };
  const working = (btn, on) => {
    for (const b of [sendBtn, approveBtn, declineBtn]) b.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = "Working…"; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  };

  sendBtn.addEventListener("click", async () => {
    if (busy) return;
    say(err, "");
    const chk = checkAddress(toInp.value);
    if (!chk.ok) return say(err, chk.error);
    const subject = str(subj.value), body = bodyTa.value;
    const bad = checkDraft(subject, body);
    if (bad) return say(err, bad);
    busy = true; working(sendBtn, true); lock(true);
    try {
      let open = null;
      try { open = await openAsks(project.id); } catch { open = null; }
      const m = open ? matchOpen(open, chk.to, subject, body) : null;
      if (m && m.same) return waiting(m.same);
      const ask = !m ? uncheckedConfirm(chk.to) : m.other ? dupConfirm(m.other, chk.to) : "";
      if (ask && !confirm(ask)) return compose();
      const ans = await fileAsk(proposeBody({ project, to: chk.to, subject, body, links }));
      if (!ans.ok) { compose(); return say(err, refusal("file", ans)); }
      if (rowState(ans.row) === "waiting") return waiting(ans.row);
      const after = rowState(ans.row) === "approved" ? await delivery(ans.row.id) : {};
      settled(ans.row, filedNote(ans.row, Date.now(), after), after);
    } finally { busy = false; working(sendBtn, false); }
  });

  approveBtn.addEventListener("click", async () => {
    if (busy || !row) return;
    say(err, "");
    if (!confirm(approveConfirm(toOf(row)))) return;
    busy = true; working(approveBtn, true);
    const ans = await approveAsk(row.id);                                   // never throws
    const st = ans.ok ? rowState(ans.row) : "";
    /* the lane says when this approval goes out; one approved at another
       door first may have gone out, or died, since: its outbox row says */
    const after = st === "approved" ? await delivery(ans.row.id) : {};
    busy = false; working(approveBtn, false);
    if (ans.ok) {
      if (st === "approved") return settled(ans.row, approvedLine(ans.row, after.lane, after.outbox), after);
      if (st === "failed") return compose(approvedLine(ans.row, null));
      if (st === "waiting") return say(err, refusal("approve", { why: "odd" }));
      return compose(filedNote(ans.row));
    }
    const was = answeredAs(ans.message);
    if (ans.why === "expired" || ans.why === "gone" || was === "declined" || was === "superseded") return compose(refusal("approve", ans));
    say(err, refusal("approve", ans));
    if (ans.why === "retired") approveBtn.disabled = true;                  // only Decline can answer it now
  });

  declineBtn.addEventListener("click", async () => {
    if (busy || !row) return;
    say(err, "");
    const reason = prompt(declinePrompt(toOf(row)), "");
    if (reason === null) return;
    busy = true; working(declineBtn, true);
    const ans = await declineAsk(row.id, reason);                           // never throws
    const was = ans.ok ? "" : answeredAs(ans.message);
    /* approved at another door first: where that email stands now */
    const after = ans.why === "answered" && APPROVED.includes(was) ? await delivery(row.id) : {};
    busy = false; working(declineBtn, false);
    if (ans.ok) return ans.row.status === "declined" ? compose(DECLINED) : settled(ans.row, filedNote(ans.row));
    if (ans.why === "expired" || ans.why === "gone" || was === "declined" || was === "superseded" || was === "failed") {
      return compose(refusal("decline", ans));
    }
    if (ans.why === "answered" && was) return done(refusal("decline", ans, after));   // approved elsewhere first
    say(err, refusal("decline", ans));
  });

  compose();
  return h("div", { class: "adjuster-send", style: SECTION },
    h("div", { style: "font-weight:600;font-size:13px;margin-bottom:6px" }, "Or send it from the office email once you approve it:"),
    h("label", { style: "display:block;font-size:12px;font-weight:600;margin-bottom:2px" }, "To", toInp),
    h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 0" }, sourceLine(s)),
    note, actions, err);
}
