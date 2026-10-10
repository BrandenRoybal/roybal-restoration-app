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
            waiting spine card offers it the way a text-queue card does,
            all but the nightly billing check's invoice gaps and the
            nightly QuickBooks match's receipts cards: roybal-notify
            never reads those, so they are answered here only.
            An email here goes out through the worker, which sends only
            while its heartbeat lists the "email" channel; the page
            reads the newest heartbeat so a card can say when sending
            is off. A send the worker gave up on stays in Recently
            decided for 48 hours from when it did (its outbox row's last
            update), however old the approval, so "Couldn't send" is seen.
            A QuickBooks receipts card (receipts.qbo_link) works the same
            way with one outbox row per receipt on the "qbo" channel:
            "executed" only means they were queued, so its outcome counts
            those rows (updated, waiting, refused and why).
            A carrier packet card (packet.send, filed by the worker's
            packet lane as agent:documents) is the adjuster email with the
            job's packet PDF attached. It is inbox only like those two (filed
            with no number, and none is ever offered), it goes out on the
            worker's "packet" channel, so its lane line reads that channel,
            and what came of it is its one outbox row ("Sent from Gmail",
            "Couldn't send: …"). Its To is never filed: the card carries
            the suggestion (suggested_to, and the phrase saying where it
            came from), and the office page sends the To and Cc he confirms
            with the approval, in a request it builds itself.

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
   older copy just leaves the new lines off. The carrier packet card
   rides the same way (kind "packet", its suggestion, email and PDF
   link on the card's evidence, the "packet" lane in needs' answer,
   look.packetLane); an older copy makes it a plain card (kind
   "other"), which the page still recognises by its operation.
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
  gaps: { chip: "Invoice gaps", approve: "Approve and add lines" },
  qbo: { chip: "QuickBooks", approve: "Approve: update QuickBooks" },
  packet: { chip: "Carrier packet", approve: "Approve and send" },
  other: { chip: "", approve: "Approve" },
};
const TEXT_KIND = { emailSend: "email", sendText: "text", boardEdit: "phase" };
const SPINE_KIND = { "email.send": "email", "sms.send": "text", "job.set_stage": "stage", "invoice.review_gaps": "gaps",
  "receipts.qbo_link": "qbo", "packet.send": "packet" };
/* the spine kinds roybal-notify never reads (its INBOX_ONLY_FILTER): no YES
   number on them. A carrier packet is filed with none (carrier_packet_file
   clears it), and none is offered even if one turns up: a YES can't carry
   the To he confirms here, so the executor would refuse it. */
const INBOX_ONLY = ["gaps", "qbo", "packet"];
/* the spine kinds whose approval writes outbox rows the worker delivers: what
   came of one is in those rows, not in the proposal */
const SENDS = ["email", "text", "qbo", "packet"];
/* what each queue calls an answered row */
const DECIDED = {
  text: ["approved", "executed", "failed", "declined"],
  spine: ["approved", "executing", "executed", "failed", "declined", "superseded"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
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
           isn't sending email, null when the page couldn't tell; for a
           carrier packet, the same for the "packet" channel), laneHint
           (the line a waiting card shows about that, or ""),
           answeredHere (set by decidedText: this tab just answered it; the
           page sets it too while this tab's answer to it is still out),
           qboLane (a QuickBooks receipts card only: the emailLane of the
           "qbo" channel), outboxes (a QuickBooks receipts card only: every
           outbox row of its proposal, one per receipt; [] elsewhere) }
   evidence carries every kind's fields, empty where they don't apply; an
   invoice-gaps card fills lines, hints, total, totalUsd, unpriced, sent and
   invoice (gapsOf); a QuickBooks receipts card fills receipts and link
   (qboOf); a carrier packet fills suggestedTo, suggestedFrom, filename,
   pdf and pdfHost (packetOf), and subject and body as an email does
   look: { jobs: {id: name}, ops: {"email.send@1": description},
           people: {id: name}, outbox: {proposalId: newest outbox row},
           outboxes: {proposalId: [its outbox rows]},
           emailLane, qboLane, packetLane: true | false | null } */

/* What a spine email says while the worker isn't sending email, in the
   words roybal-notify texts back when a YES lands in that state ("It's
   queued, but email sending is off on the worker: it waits up to 48 hours
   for that to come back, then it isn't sent."). The 48 is the worker's
   EMAIL_MAX_AGE_HOURS default: an email row older than that when it would
   first go out is marked dead, not sent, so no line here promises more. */
export const LANE_OFF_WAITING = "Email sending is off on the worker right now: approving queues this, and it waits up to 48 hours for sending to come back, then it isn't sent.";
export const LANE_OFF_QUEUED = "Queued, but email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent";
export const LANE_OFF_FAILED = "Send failed, and email sending is off on the worker: it waits up to 48 hours for that, then it isn't sent";
/* The same for a QuickBooks receipts card while the worker isn't serving the
   "qbo" channel (RECEIPTS_QBO=off, or a worker that stopped). Its rows have
   no age limit: they wait, and go when the channel is back. */
export const QBO_OFF_WAITING = "QuickBooks updates are off on the worker right now: approving queues these, and they wait until updates are back on.";
export const QBO_OFF_QUEUED = "Queued, but QuickBooks updates are off on the worker: nothing goes until they're back on";

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
      stage: "", rationale: "", refs: [], reason: "", ...noGaps(), ...noQbo(), ...noPacket(),
    },
    result: res, error: str(res.error), outbox: null, outboxes: [],
    // the text queue's email goes out through gmail-proxy, not the worker
    emailLane: null, qboLane: null, laneHint: "",
  };
}

/* ---------- invoice gaps (the nightly billing check) ---------- */
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const RATE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/* Figures the way Postgres counts them. A JSON number is the decimal its
   text spells (String(n) is what JSON.stringify writes and numeric reads), so
   each is taken as that exact decimal, [digits, places]; products and sums
   stay exact, and rounding is half away from zero, once, as round(numeric, n)
   does. Binary floats drift: 1.005 * 100 is 100.49999999999999, so
   Math.round gives 1.00 where Postgres gives 1.01. A quantity and a rate
   show as written (to 4 places), so "3 EA × $1.115 = $3.35" adds up. */
const decimal = (n) => {        // a finite number
  const [, sign, whole, frac = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  const places = frac.length - Number(exp);
  const digits = BigInt(whole + frac) * 10n ** BigInt(Math.max(0, -places));
  return [sign ? -digits : digits, Math.max(0, places)];
};
const times = ([a, p], [b, q]) => [a * b, p + q];
const plus = ([a, p], [b, q]) => (p >= q ? [a + b * 10n ** BigInt(p - q), p] : [a * 10n ** BigInt(q - p) + b, q]);
const roundTo = ([d, places], to) => {
  if (places <= to) return Number(d) / 10 ** places;
  const unit = 10n ** BigInt(places - to), mag = d < 0n ? -d : d;
  const q = mag / unit + (2n * (mag % unit) >= unit ? 1n : 0n);
  return Number(d < 0n ? -q : q) / 10 ** to;
};
const cents = (x) => roundTo(x, 2);
const shown = (n) => roundTo(decimal(n), 4);
const plural = (n, one) => `${n} ${n === 1 ? one : one + "s"}`;
const noGaps = () => ({ lines: [], hints: [], total: "", totalUsd: 0, unpriced: 0, sent: false, invoice: "" });
// after an invoice-gaps total: the draft the executor writes carries this job's O&P and tax on top
const GAPS_OP_TAX = "; the new invoice adds this job's O&P and tax";

/* An invoice.review_gaps row (billing.reconcile files it; input shape:
   reconcile.js reconcileJob) → what approving adds, as text. The lines are
   the ones op_exec_invoice_review_gaps would write: the proposal's own, less
   any an edit dropped (an edit may only drop lines, and their content always
   comes from the input). Each reads "4 DA × $85.00 = $340.00"; one with no
   rate on this job reads "no rate" and stays out of the total, which is the
   priced lines' qty × price summed exactly and rounded to the cent once, as
   the executor's round(sum(qty * price), 2) counts it. That is the lines
   alone: the executor gives the draft the rate invoice's percentage O&P and
   tax rate (never its fixed-dollar O&P), so the total says the new invoice
   adds them (the confirm keeps K11's words: $X is what the lines add). Hints
   (what the check noticed but never adds) follow. Every figure is formatted
   here, so the page prints no null, NaN or undefined. */
function gapsOf(r) {
  const input = obj(r.input);
  const pick = obj(r.edited_params).lines;
  const keep = Array.isArray(pick) ? new Set(pick.map((l) => str(obj(l).finding_id))) : null;
  let sum = [0n, 0], unpriced = 0;
  const lines = arr(input.lines).map(obj).filter((l) => !keep || keep.has(str(l.finding_id))).slice(0, 40).map((l) => {
    const qty = num(l.qty), price = num(l.price), unit = str(l.unit), room = str(l.room);
    const many = qty == null ? "no quantity" : `${shown(qty)}${unit ? " " + unit : ""}`;
    let figures;
    if (price == null) { unpriced++; figures = `${many} · no rate`; }
    else if (qty == null) figures = `no quantity · ${RATE.format(shown(price))}${unit ? " per " + unit : ""}`;
    else {
      const amount = times(decimal(qty), decimal(price));
      sum = plus(sum, amount);
      figures = `${many} × ${RATE.format(shown(price))} = ${USD.format(cents(amount))}`;
    }
    return { id: str(l.finding_id), text: (str(l.desc) || "A line") + (room ? ` (${room})` : ""), figures,
      basis: str(l.basis), priced: price != null, refs: refsOf(l.refs) };
  });
  const totalUsd = cents(sum);
  const hints = arr(input.hints).slice(0, 20).map(obj)
    .map((h) => ({ text: str(h.label) || cap(str(h.kind).replace(/_/g, " ")), refs: refsOf(h.refs) }))
    .filter((h) => h.text);
  const sent = input.sent === true;
  const no = str(input.rate_invoice_no);
  return {
    lines, hints, totalUsd, unpriced, sent,
    total: USD.format(totalUsd) + (unpriced ? ` + ${plural(unpriced, "line")} with no rate (not in the total)` : "") + GAPS_OP_TAX,
    invoice: "A new draft invoice" + (no ? `, beside invoice ${no}` : "") + (sent ? " (an invoice on this job has already gone out)" : ""),
  };
}

/* ---------- QuickBooks receipts (the nightly QuickBooks match) ---------- */
const noQbo = () => ({ receipts: [], link: "" });
/* "2026-09-30" → "Sep 30": the receipt's own calendar date, never shifted by a timezone */
const DATE_ONLY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
function dayOf(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? DATE_ONLY.format(d) : "";
}

/* A receipts.qbo_link row (receipts.qbo_match files it; input shape:
   services/worker/lanes/qbomatch.mjs) → what approving does, one line per
   receipt: "Home Depot · Sep 30 · $1,369.50 → QuickBooks expense 10577
   (3176 - Citi - Home Depot Consumer Credit Card): tag to Pollen
   Apartments, attach the photo". The receipts are the ones
   op_exec_receipts_qbo_link would queue: the proposal's own, less any an
   edit dropped (an edit may only drop items, each kept exactly as filed,
   so the content always comes from the input). A card that also links the
   job to a QuickBooks project (the job had none; approving is the pick)
   says so and why. Every figure is formatted here, so the page prints no
   null, NaN or undefined. */
function qboOf(r) {
  const input = obj(r.input);
  const pick = obj(r.edited_params).items;
  const keep = Array.isArray(pick) ? new Set(pick.map((i) => str(obj(i).receipt_id))) : null;
  const link = obj(input.link);
  const project = str(input.qbo_name) || str(link.qbo_name) || "the job's QuickBooks project";
  const receipts = arr(input.items).map(obj).filter((i) => !keep || keep.has(str(i.receipt_id))).slice(0, 50).map((i) => {
    const amount = num(i.amount);
    const money = amount == null ? "" : USD.format(cents(decimal(amount))) + (amount < 0 ? " (return)" : "");
    const head = [str(i.vendor) || "A receipt", dayOf(i.date), money].filter(Boolean).join(" · ");
    const changes = arr(i.changes).map(str);
    const doc = str(i.qbo_doc_number), account = str(i.qbo_account_name), txn = str(i.qbo_txn_id);
    const vendor = str(i.qbo_vendor_name);
    const create = changes.includes("create");
    // where it goes: the expense already in QuickBooks (its id, then the
    // vendor, the ref number and the account QuickBooks shows it under, so a
    // vendor that isn't the receipt's shows before approving), or the one
    // approving enters
    const about = [vendor, doc && "ref " + doc, account].filter(Boolean).join(", ");
    const target = create
      ? "a new QuickBooks expense" + (account ? ` on ${account}` : "") + (doc ? ` (ref ${doc})` : "")
      : "QuickBooks expense" + (txn ? " " + txn : "") + (about ? ` (${about})` : "");
    // what it gets: entering a store invoice tags its one line as it goes
    const photos = arr(i.photo_refs).length;
    const what = [
      create ? `enter it, tagged to ${project}` : changes.includes("tag") ? `tag to ${project}` : "",
      changes.includes("attach") ? (photos > 1 ? `attach the ${photos} photos` : "attach the photo") : "",
    ].filter(Boolean).join(", ") || "no change listed";
    return { id: str(i.receipt_id), text: `${head} → ${target}: ${what}` };
  });
  const linking = str(link.qbo_customer_id) || str(link.qbo_name);
  const why = str(link.why);
  return {
    receipts,
    link: linking ? `Links this job to QuickBooks project ${str(link.qbo_name) || "number " + str(link.qbo_customer_id)}${why ? ": " + why : ""}` : "",
  };
}

/* ---------- carrier packets (the worker's packet lane) ---------- */
const noPacket = () => ({ suggestedTo: "", suggestedFrom: "", filename: "", pdf: "", pdfHost: "" });
/* The evidence ref that opens the packet PDF (the lane's signed link): one
   marked kind "pdf", else an https link whose path is a .pdf, else the first
   https link. Only a link linkOf takes counts, carrying the host it really
   opens, as every evidence link does. */
function pdfRef(refs) {
  const links = arr(refs).slice(0, 10).map((x) => {
    const o = typeof x === "string" ? { url: x } : obj(x);
    const link = [o.url, o.href].map(str).map(linkOf).find(Boolean);
    return link ? { ...link, marked: /^pdf$/i.test(str(o.kind || o.type)) } : null;
  }).filter(Boolean);
  const isPdf = (u) => { try { return /\.pdf$/i.test(new URL(u).pathname); } catch { return false; } };
  return links.find((l) => l.marked) || links.find((l) => isPdf(l.url)) || links[0] || null;
}
/* A packet.send row (carrier_packet_file files it; input: subject, body,
   filename, suggested_to, suggested_from, packet_version_id, offer) → what
   the card shows beside the email. The suggestion is read from the filed
   input only: an edit is the To he confirmed, which evidence.to shows once
   the card is approved. The schema makes each a string; anything else
   reads as nothing, never as "[object Object]" in the To field. */
function packetOf(r) {
  const input = obj(r.input);
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const pdf = pdfRef(r.evidence_refs);
  return { suggestedTo: text(input.suggested_to), suggestedFrom: text(input.suggested_from), filename: text(input.filename),
    pdf: pdf ? pdf.url : "", pdfHost: pdf ? pdf.host : "" };
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
  // a QuickBooks receipts card carries the job's name as the matcher read
  // it, for when the lookup can't name the job
  const jobNamed = kind === "qbo" ? str(obj(r.input).job_name) : "";
  const job = own(look.jobs, jobId) || jobNamed;
  const what = firstSentence(own(look.ops, str(r.operation)) || own(look.ops, name)) || name || "An ask";
  const gaps = kind === "gaps" ? gapsOf(r) : noGaps();
  const qbo = kind === "qbo" ? qboOf(r) : noQbo();
  const packet = kind === "packet" ? packetOf(r) : noPacket();
  const key = kind === "email" || kind === "text" ? str(input.to) : kind === "stage" ? stageLabel(input.stage)
    : kind === "gaps" ? `${plural(gaps.lines.length, "line")} · ${USD.format(gaps.totalUsd)}${gaps.unpriced ? ` · ${gaps.unpriced} unpriced` : ""}`
    : kind === "qbo" ? [jobNamed || job, plural(qbo.receipts.length, "receipt")].filter(Boolean).join(": ")
    // the packet's number, version, claim and name, as the attachment is called
    : kind === "packet" ? packet.filename.replace(/\.pdf$/i, "") : "";
  const byId = str(r.proposed_by_id);
  const status = str(r.status);
  // proposals_sms_code_seq numbers a row while it is proposed (unique only
  // among those, then free for reuse), so only a waiting row offers its number
  const code = Number(r.sms_code) || null;
  // a carrier packet is an email too, sent on the worker's own "packet" channel
  const sending = own(look, kind === "packet" ? "packetLane" : "emailLane"), serving = own(look, "qboLane");
  const emailLane = (kind === "email" || kind === "packet") && (sending === true || sending === false) ? sending : null;
  const qboLane = kind === "qbo" && (serving === true || serving === false) ? serving : null;
  return {
    key: "spine:" + str(r.id), lane: "spine", id: str(r.id), code, kind,
    chip: KINDS[kind].chip || name || "Ask",
    title: key ? `${what}: ${key}` : what,
    approveLabel: KINDS[kind].approve,
    // invoice gaps, QuickBooks receipts and carrier packets are answered
    // here only: roybal-notify reads none of the first two, so a YES with
    // their number would answer like no such number, and a packet needs
    // the To typed on this card
    yesHint: code && status === "proposed" && !INBOX_ONLY.includes(kind) ? `or text YES ${code}` : "",
    // job.set_stage moves a board job; invoice gaps, receipts and carrier
    // packets are on a field job; anything else may name either table
    jobId, jobTable: kind === "stage" ? "board" : kind === "gaps" || kind === "qbo" || kind === "packet" ? "field" : "either", job,
    by: proposerName(r.proposed_by_kind, own(look.people, byId)),
    byKind: str(r.proposed_by_kind), byId,
    status, createdAt: str(r.created_at), expiresAt: str(r.expires_at),
    decidedAt: str(r.approved_at || r.updated_at || r.created_at),
    answeredAt: str(r.approved_at || r.updated_at),     // a decline is the row's last update
    evidence: {
      to: str(input.to), cc: str(input.cc), subject: str(input.subject),
      body: kind === "email" || kind === "packet" ? str(input.body) : "",
      message: kind === "text" ? str(input.body) : "", audience: "",
      phase: "", hours: null, stage: kind === "stage" ? stageLabel(input.stage) : "",
      rationale: str(r.rationale), refs: refsOf(r.evidence_refs),
      reason: str(r.decline_reason), ...gaps, ...qbo, ...packet,
    },
    result: obj(r.result), error: str(r.error),
    outbox: own(look.outbox, str(r.id)) || null,
    outboxes: kind === "qbo" ? arr(own(look.outboxes, str(r.id))) : [],
    emailLane, qboLane,
    laneHint: status !== "proposed" ? "" : emailLane === false ? LANE_OFF_WAITING : qboLane === false ? QBO_OFF_WAITING : "",
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
   row's last update), else NaN; for a QuickBooks receipts card, the latest
   of its rows that did. Only a string time counts: this runs over every
   card, outside cardsOf's guard. */
function diedAt(c) {
  if (c.lane !== "spine" || c.status !== "executed") return NaN;
  let at = NaN;
  for (const o of (c.kind === "qbo" ? arr(c.outboxes) : [c.outbox]).map(obj)) {
    const t = o.status === "dead" && typeof o.updated_at === "string" ? ms(o.updated_at) : NaN;
    if (Number.isFinite(t) && !(t <= at)) at = t;
  }
  return at;
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
    SENDS.includes(c.kind) && !isRecent(c, now));
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
    both), proposers per kind, the spine sends whose outbox rows say how
    delivery went (a QuickBooks receipts card's too), and lanes: "email"
    when a spine email is waiting or was sent, "qbo" when a QuickBooks
    receipts card is, "packet" when a carrier packet is, so the page reads
    the worker's heartbeat. */
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
    if (c.status === "executed" && SENDS.includes(c.kind)) out.outbox.add(c.id);
    // each kind's lane is the worker channel of the same name
    if ((c.kind === "email" || c.kind === "qbo" || c.kind === "packet") && (c.status === "proposed" || c.status === "executed")) out.lanes.add(c.kind);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

/** The newest worker_heartbeats row ({at, meta}, read newest first) → is the
    worker sending email: true when it beat within HEARTBEAT_FRESH_MS and
    its meta.channels lists "email"; false when it didn't (or no worker has
    ever beaten: outbox_channel_ready's rule); null when the read failed or
    the row won't read, which says nothing new on any card. */
export function emailLaneOf(heartbeats, now = Date.now()) { return laneOf(heartbeats, "email", now); }
/** The same for the "qbo" channel: is the worker delivering QuickBooks
    receipts changes (RECEIPTS_QBO=off drops it). */
export function qboLaneOf(heartbeats, now = Date.now()) { return laneOf(heartbeats, "qbo", now); }
function laneOf(heartbeats, channel, now) {
  if (!Array.isArray(heartbeats)) return null;
  if (!heartbeats.length) return false;
  const row = obj(heartbeats[0]);
  const at = ms(row.at);
  const channels = obj(row.meta).channels;
  if (!Number.isFinite(at) || !Array.isArray(channels)) return null;
  return at > now - HEARTBEAT_FRESH_MS && channels.includes(channel);
}

/** The lookup reads → the `look` the cards are built with. jobs are
    {id, title, customer, address}; outbox rows newest first (outbox keeps
    each proposal's newest, outboxes all of them: a QuickBooks receipts
    card has one per receipt); heartbeats the newest worker_heartbeats row
    as read (null: not read, or the read failed), judged at now. */
export function lookFrom({ catalog = [], agents = [], profiles = [], jobs = [], outbox = [], heartbeats = null, now = Date.now() } = {}) {
  // packetLane: is the worker serving the "packet" channel (email on, and
  // CARRIER_PACKET not off). No export of its own: the page reads it here.
  const look = { jobs: {}, ops: {}, people: {}, outbox: {}, outboxes: {},
    emailLane: emailLaneOf(heartbeats, now), qboLane: qboLaneOf(heartbeats, now), packetLane: laneOf(heartbeats, "packet", now) };
  for (const j of jobs) if (j && j.id) put(look.jobs, str(j.id), jobName(j));
  for (const o of catalog) {
    if (!o || !o.name) continue;
    put(look.ops, `${o.name}@${o.version}`, str(o.description));
    if (!own(look.ops, str(o.name))) put(look.ops, str(o.name), str(o.description));
  }
  for (const a of agents) if (a && a.id && agentName(a.name)) put(look.people, str(a.id), agentName(a.name));
  for (const p of profiles) if (p && p.id && str(p.full_name)) put(look.people, str(p.id), str(p.full_name));
  for (const o of outbox) {
    if (!o || !o.proposal_id) continue;
    const p = str(o.proposal_id);
    if (!own(look.outbox, p)) { put(look.outbox, p, o); put(look.outboxes, p, []); }
    own(look.outboxes, p).push(o);
  }
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
/** A spine send's outbox row → its delivery state, when it was readable. A
    carrier packet goes from the office Gmail account, and once the worker
    has handed it to Gmail that is all there is to know ("delivered" is the
    same news), so both read as sent from there. */
function delivery(o, now, kind) {
  const st = str(o && o.status);
  if (st === "pending") {
    const at = ms(o.next_attempt_at);
    return at > now + 60000 ? `Queued, goes out ${akTime(o.next_attempt_at, now)}` : "Queued to send";
  }
  if (kind === "packet" && (st === "sent" || st === "delivered")) return "Sent from Gmail";
  return own({ sending: "Sending", sent: "Sent", delivered: "Delivered", failed: "Send failed, retrying",
    dead: "Couldn't send" + (str(o && o.error) ? ": " + str(o.error) : "") }, st) || "";
}
/* What qbo-proxy's completePurchase answered, in words. An outbox row the
   worker gave up on keeps that answer as its error, which starts with the
   code ("tagged_other: expense 10577 is already tagged to …"). Refusals
   are QuickBooks or the card saying no (retrying can't help: the row died
   at once); the rest are troubles that outlasted the worker's retries. */
export const QBO_REFUSED = {
  tagged_other: "tagged to another job", partly_tagged: "only partly tagged to this job",
  untaggable: "the expense has no lines to tag", untaggable_line: "a line QuickBooks can't tag to a job",
  changed_in_qbo: "changed in QuickBooks since the card was filed", purchase_missing: "the expense is gone from QuickBooks",
  photo_missing: "the receipt photo is missing", photo_type: "the photo isn't a JPEG, PNG or PDF",
  photo_unreadable: "the photo couldn't be read", photo_too_big: "the photo is over 20 MB",
  upload_refused: "QuickBooks refused the photo", qbo_refused: "QuickBooks refused the change",
  bad_request: "the app sent QuickBooks a bad request",
  relinked: "the job's QuickBooks project changed after approval",
};
const QBO_FAILED = {
  stale_object: "the expense kept changing in QuickBooks", qbo_not_connected: "QuickBooks isn't connected",
  qbo_throttled: "QuickBooks was too busy", qbo_unavailable: "QuickBooks was down", qbo_unreachable: "couldn't reach QuickBooks",
  storage_unavailable: "couldn't read the photo from storage", create_unclear: "QuickBooks didn't confirm the new expense",
  upload_unclear: "QuickBooks didn't confirm the photo", link_unreadable: "couldn't read the job's QuickBooks link",
};
/* A dead row's error → ["refused" | "failed", words]. An error that doesn't
   start with a known code (the worker couldn't reach qbo-proxy, a row
   cancelled by hand) shows as written, clipped. */
function qboWhy(error) {
  const e = typeof error === "string" ? error.trim() : "", code = (/^([a-z_]+):/.exec(e) || [])[1] || "";
  if (own(QBO_REFUSED, code)) return ["refused", own(QBO_REFUSED, code)];
  if (own(QBO_FAILED, code)) return ["failed", own(QBO_FAILED, code)];
  return ["failed", e ? (e.length > 120 ? e.slice(0, 119) + "…" : e) : "no reason given"];
}
/* A sent row whose photo QuickBooks refused after the tag (or the new
   store entry) went in: the worker marks it attach_error=<code> in its
   provider status. The change is in the books; the photo isn't. "" when
   the photo went (or none was asked for). */
function photoRefused(o) {
  const code = (/(?:^|;)attach_error=([a-z_]+)/.exec(str(o.provider_status)) || [])[1] || "";
  if (!code) return "";
  if (code === "qbo_refused") return "QuickBooks refused the photo";
  return own(QBO_REFUSED, code) || own(QBO_FAILED, code) || code.replace(/_/g, " ");
}
/* An executed QuickBooks receipts card → how its outbox rows went: "All 3
   updated in QuickBooks", "1 of 3 updated in QuickBooks; 2 waiting", "2 of 3
   updated in QuickBooks; 1 refused: tagged to another job", "Tagged in
   QuickBooks; photo not attached: …". Before its rows are read (just
   approved here) it counts what the executor queued. */
function qboOutcome(c) {
  const rows = arr(c.outboxes).map(obj);
  const queued = Number(c.result.queued), skipped = Number(c.result.skipped);
  const n = Math.max(rows.length, Number.isInteger(queued) && queued > 0 ? queued : 0);
  if (!n) {
    // every receipt was already queued or done by an earlier card for the same expense
    if (Number.isInteger(skipped) && skipped > 0) return { text: "Already on its way to QuickBooks from an earlier card", tone: "ok" };
    return { text: c.qboLane === false ? QBO_OFF_QUEUED : "Queued for QuickBooks", tone: "wait" };
  }
  const sent = rows.filter((o) => o.status === "sent" || o.status === "delivered");
  const done = sent.length;
  const dead = rows.filter((o) => o.status === "dead");
  const waiting = n - done - dead.length;
  const unattached = sent.map(photoRefused).filter(Boolean);
  const noPhoto = unattached.length
    ? `${unattached.length === 1 ? "1 photo" : `${unattached.length} photos`} not attached: ${[...new Set(unattached)].join(", ")}` : "";
  if (done === n && n === 1 && noPhoto) return { text: "Tagged in QuickBooks; photo not attached: " + unattached[0], tone: "bad" };
  if (done === n) {
    const all = n === 1 ? "Updated in QuickBooks" : `All ${n} updated in QuickBooks`;
    return noPhoto ? { text: `${all}; ${noPhoto}`, tone: "bad" } : { text: all, tone: "ok" };
  }
  // still in line (or between retries) while the worker isn't serving "qbo": it waits for that
  const off = c.qboLane === false;
  if (!dead.length && !done) return { text: off ? QBO_OFF_QUEUED : n === 1 ? "Queued for QuickBooks" : `${n} queued for QuickBooks`, tone: "wait" };
  if (n === 1 && dead.length) return { text: "Not updated in QuickBooks: " + qboWhy(dead[0].error)[1], tone: "bad" };
  const parts = [done ? `${done} of ${n} updated in QuickBooks` : `None of ${n} updated in QuickBooks`];
  if (noPhoto) parts.push(noPhoto);
  if (waiting > 0) parts.push(`${waiting} waiting` + (off ? " (QuickBooks updates are off on the worker)" : ""));
  for (const verb of ["refused", "failed"]) {
    const why = dead.map((o) => qboWhy(o.error)).filter(([v]) => v === verb).map(([, w]) => w);
    if (why.length) parts.push(`${why.length} ${verb}: ${[...new Set(why)].join(", ")}`);
  }
  return { text: parts.join("; "), tone: dead.length || noPhoto ? "bad" : "wait" };
}

/* Why the packet lane withdrew a card: the gate's reasons
   (docs/Carrier_Packet_Design.md §4) that take an approvable PDF away, so a
   voided invoice or a cleared certificate never leaves one behind. */
const WITHDRAWN = {
  deleted: "the job was deleted", archived: "the job was archived",
  not_water: "the job isn't a water mitigation job now",
  excluded: "the certificate or the invoices were unticked on the job's packet page",
  not_certified: "the Certificate of Drying isn't signed now", no_invoice: "the job has no numbered invoice now",
  unchecked_fills: "meter readings on the Moisture Map need checking",
  unread_meter_photos: "meter photos on an empty reading need reading",
};

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
    if (c.status === "superseded") {
      // billing_review_gaps_file's reasons: nothing left to add (no_gaps), or
      // the night's findings no longer match this card's (findings_changed);
      // receipts_qbo_link_file's: QuickBooks needs nothing more for the job
      // (nothing_to_do), or the owner answered tonight's items on another
      // card (items_changed); carrier_packet_withdraw's: the job no longer
      // gets a packet (withdrawn, and the gate's reason why)
      const why = c.result.superseded_reason;
      return { text: why === "no_gaps" ? "No longer needed: the invoice covers it"
        : why === "findings_changed" ? "Closed: the nightly check's findings changed"
        : why === "nothing_to_do" ? "No longer needed: QuickBooks has what it needs"
        : why === "items_changed" ? "Closed: the nightly QuickBooks match's findings changed"
        : why === "withdrawn" ? "Withdrawn: " + (own(WITHDRAWN, str(c.result.reason)) || "the job no longer gets a carrier packet")
        : "Replaced by a newer ask", tone: "no" };
    }
    if (c.status === "executed") {
      if (c.kind === "email" || c.kind === "text" || c.kind === "packet") {
        const d = delivery(c.outbox, now, c.kind);
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
      // "executed" only says the changes were queued: the outbox rows say how they went
      if (c.kind === "qbo") return qboOutcome(c);
      if (c.kind === "gaps") {
        // op_exec_invoice_review_gaps's result.status; only added wrote the job
        const st = str(c.result.status), n = Number(c.result.lines_added);
        if (st === "added") return { text: `Added ${plural(Number.isInteger(n) && n > 0 ? n : arr(c.evidence.lines).length, "line")} on a new draft invoice`, tone: "ok" };
        if (st === "already_present") return { text: "Already on the job", tone: "ok" };
        if (st === "deleted_by_office") return { text: "The office deleted that invoice; nothing re-added", tone: "no" };
      }
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
  if (c.kind === "gaps") {
    const n = arr(e.lines).length, open = Number(e.unpriced) || 0;
    return `Add ${plural(n, "line")} (${USD.format(Number(e.totalUsd) || 0)}${open ? `, ${open} unpriced` : ""}) as a new draft invoice on ${c.job || "this job"}?`;
  }
  if (c.kind === "qbo") return `Update QuickBooks for ${plural(arr(e.receipts).length, "receipt")} on ${c.job || "this job"}?`;
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
