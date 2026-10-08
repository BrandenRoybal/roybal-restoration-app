/* The QuickBooks matcher behind receipts.qbo_match (migration 0023, receipts
   phase 3). PURE: no I/O and no clock (today comes in), so the same rows
   always give the same answer. lanes/receipts.mjs reads the rows, calls
   matchReceipts, and writes what it returns through the two 0023 doors.

   What it decides, per live receipt on a live job:
     in_qbo     its QuickBooks expense is already tagged to the job, and has a
                document attached or the receipt has no photo to add yet:
                nothing to do (a note)
     an item    the expense needs the job tag, the photo, or both: one line
                on the job's receipts.qbo_link card, for the owner to approve
     unmatched  no expense found (a note, with the reason the office reads:
                still waiting for the bank feed, a store invoice not entered
                yet, a dump ticket booked as a bill the matcher does not read,
                the job needs its QuickBooks project, or not found)
     conflict   an expense was found but we will not write to it: two equally
                good matches, or it is tagged to another job (a note)

   Why it is conservative: QuickBooks is the books. A wrong tag moves a cost
   to someone else's job and a second expense double counts it, so a match
   needs the exact amount, the right sign, a date inside the feed's lag, and
   a second piece of evidence (the store's invoice number, the vendor, the
   same day or the card's last four), and nothing on the expense that says
   it is another store, another card or a payment (contradicts); two equally
   good expenses are left to a person; a tag already set is never changed;
   and one expense is matched to one receipt only.

   The real books (Oct 7 read) shaped the rules: Home Depot card 3176 charges
   arrive by bank rule into account 36, untagged, with no DocNumber and no
   photo (Purchase 10577); Spenard and Sherwin invoices are entered by hand
   about 9 days late with DocNumber = the invoice number (Sherwin adds digits
   after it: receipt 8066-9 is DocNumber 80669163000926), the project tag and
   the vendor's PDF; no job is linked to its QuickBooks project yet, so the
   job's link is suggested from the expenses its receipts matched, or from
   its QuickBooks Time jobcode name. */

export const MATCHER = "receipts.qbo_match@1";
export const WINDOW_DAYS = 60;       // receipts older than this are not matched again (their state is kept)
export const FEED_WAIT_DAYS = 7;     // a card charge younger than this is "waiting for the bank feed"
export const MIN_SCORE = 2;
// expense account for store entries of equipment receipts (rentals), instead of the store's own
export const EQUIPMENT_EXPENSE_ACCOUNT = "1150040005";
// the clearing account a payment to a card or a store account books to: such
// a row pays for purchases, it is not one
export const PAYMENT_CLEARING_ACCOUNT = "1150040008";

const OWNED = new Set(["queued", "done", "failed"]);          // the approval path's rows: never touched here
const NOTE_STATES = new Set(["in_qbo", "unmatched", "conflict"]);
const DIGITS = /^[0-9]{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA = /^media:[0-9a-f]{64}:[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The receipt ids both doors and qbo-proxy accept. job_receipts.id is free
// text (the app's uid()), and one odd id must not fail the whole night's note.
const RECEIPT_ID = /^[\w.:-]{1,64}$/;
const MAX_ITEMS = 50;                 // the executor's limit per card

/* Vendor families: a receipt and an expense "agree on the vendor" when both
   land in the same family. Read from the receipt's printed vendor and from
   the expense's vendor (EntityRef) name or its memo (a bank rule writes the
   card statement's text there: "THE HOME DEPOT FAIRBANKS AK - RULE"). First
   match wins, so Office Depot is caught before the bare "depot" of Home
   Depot. The keys are also what app_settings receipts.qbo_store_accounts is
   keyed by. */
export const FAMILIES = [
  ["office depot", /office\s*depot/],
  ["home depot", /home\s*depot|\bdepot\b/],
  ["spenard", /spenard|\bsbs\b|builders\s+supply/],
  ["sherwin", /sherwin/],
  ["lowes", /\blowe'?s?\b/],
  ["ferguson", /ferguson/],
  ["fnsb", /\bfnsb\b|solid\s+waste/],
  ["costco", /costco/],
  ["amazon", /amazon|\bamzn\b/],
  ["carquest", /carquest/],
  ["seamless", /seamless\s+supply/],
  ["keller", /keller\s+supply/],
  ["sentry", /sentry\s+hardware/],
  ["aih", /alaska\s+industrial|\baih\b/],
  ["samson", /samson\s+(tru-?value|hardware)/],
  ["napa", /\bnapa\b/],
  ["fred meyer", /fred\s*meyer/],
  ["walmart", /wal-?\s*mart/],
  ["florcraft", /florcraft/],
  ["c&r pipe", /\bc\s*&\s*r\s+pipe/],
  ["fairbanks block", /fairbanks\s+block/],
  ["fs&g", /\bfs\s*&\s*g\b/],
];

const str = (v) => (v == null ? "" : String(v));
const lc = (v) => str(v).trim().toLowerCase();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = (n) => Math.round(Math.abs(Number(n)) * 100);
const digitsOf = (v) => str(v).replace(/\D/g, "");
const clip = (v, n) => str(v).slice(0, n);
const idOrNull = (v) => (DIGITS.test(str(v)) ? str(v) : null);
const validDate = (s) => {
  const t = DATE.test(str(s)) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The vendor family of a name or memo, or null when it is in no family. */
export function vendorFamily(text) {
  const t = lc(text).replace(/[‘’]/g, "'");
  if (!t) return null;
  for (const [name, re] of FAMILIES) if (re.test(t)) return name;
  return null;
}

/** The receipt number agrees with an expense's DocNumber: their digits are
    equal, or the receipt's digits start the DocNumber's (Sherwin's longer
    numbers). At least 5 digits, so a check number or a short ticket never
    counts. */
export function docAgrees(receiptNo, docNumber) {
  const d = digitsOf(receiptNo);
  const D = digitsOf(docNumber);
  return d.length >= 5 && D.length >= d.length && D.startsWith(d);
}

/** How strongly one expense looks like one receipt: +3 the receipt number,
    +2 the vendor family, +1 the same date, +1 the card's last four in the
    payment account's name or the memo. */
export function scoreOf(r, p) {
  let s = 0;
  if (docAgrees(r.receipt_no, p.docNumber)) s += 3;
  const fam = vendorFamily(r.vendor);
  if (fam && (vendorFamily(p.vendorName) === fam || vendorFamily(p.note) === fam)) s += 2;
  if (str(p.txnDate) === str(r.receipt_date)) s += 1;
  const last4 = str(r.card_last4).trim();
  if (/^\d{4}$/.test(last4) && (str(p.accountName).includes(last4) || str(p.note).includes(last4))) s += 1;
  return s;
}

/** The expense says it is not this receipt's: another store (both vendor
    families known, and none of the expense's is the receipt's), another
    card (the receipt's last four is nowhere on the expense, whose card
    account's name carries a card number; a checking account's name is the
    bank's number, not the debit card's, so it never counts), a payment
    (every line on the payment clearing account), or, for a receipt charged
    to a store account, money paid from the bank (Cash or Check). Missing a
    true match only leaves the receipt unmatched; matching a wrong one tags
    and photographs someone else's expense. */
export function contradicts(r, p) {
  const fam = vendorFamily(r.vendor);
  const theirs = [vendorFamily(p.vendorName), vendorFamily(p.note)].filter(Boolean);
  if (fam && theirs.length && !theirs.includes(fam)) return true;
  const last4 = str(r.card_last4).trim();
  if (/^\d{4}$/.test(last4) && p.paymentType === "CreditCard" && /\b\d{4}\b/.test(str(p.accountName))
      && !str(p.accountName).includes(last4) && !str(p.note).includes(last4)) return true;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length && lines.every((l) => str(l.accountId) === PAYMENT_CLEARING_ACCOUNT)) return true;
  if (lc(r.paid_with) === "account" && (p.paymentType === "Cash" || p.paymentType === "Check")) return true;
  return false;
}

/** The receipts the matcher will look at tonight (live, a total, dated in
    the last WINDOW_DAYS), and the expense window listPurchases needs for
    them: from a day before the oldest, to today. Null when there are none,
    so the lane need not ask QuickBooks at all. */
export function purchaseWindow(receipts, today) {
  let from = null;
  for (const r of receipts ?? []) {
    if (!inWindow(r, today)) continue;
    if (from === null || r.receipt_date < from) from = r.receipt_date;
  }
  return from === null ? null : { from: addDays(from, -1), to: today };
}

function inWindow(r, today) {
  const amount = Number(r?.amount);
  const date = str(r?.receipt_date);
  return r?.deleted_at == null && Number.isFinite(amount) && amount !== 0 && validDate(date)
    && date >= addDays(today, -WINDOW_DAYS) && date <= today;
}

/* app_settings receipts.qbo_store_accounts → {family: config}. Anything
   malformed leaves that store off rather than half on. */
function readStoreAccounts(raw) {
  const out = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, c] of Object.entries(raw)) {
    if (!c || typeof c !== "object") continue;
    const [account, vendor, expense] = [str(c.account_id), str(c.vendor_id), str(c.expense_account_id)];
    if (!DIGITS.test(account) || !DIGITS.test(vendor) || !DIGITS.test(expense)) continue;
    const cls = str(c.class_id);
    if (cls && !DIGITS.test(cls)) continue;
    const age = Number(c.min_age_days ?? 0);
    out.set(lc(key), {
      account_id: account, vendor_id: vendor, expense_account_id: expense, class_id: cls || null,
      min_age_days: Number.isInteger(age) && age >= 0 ? age : 0,
    });
  }
  return out;
}

/** customer id → the line-level ProjectRef QuickBooks shows beside it on
    hand-tagged lines (a different id space): the most common one seen. */
function learnProjectRefs(purchases) {
  const seen = new Map();
  for (const p of purchases) {
    for (const l of p.lines ?? []) {
      const c = str(l.customerId), ref = str(l.projectRef);
      if (!DIGITS.test(c) || !DIGITS.test(ref)) continue;
      const m = seen.get(c) ?? new Map();
      m.set(ref, (m.get(ref) ?? 0) + 1);
      seen.set(c, m);
    }
  }
  const out = new Map();
  for (const [c, m] of seen) {
    out.set(c, [...m].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0][0]);
  }
  return out;
}

const hasDocument = (p) => p.hasAttachment === true || (Array.isArray(p.attachments) && p.attachments.length > 0);

/**
 * matchReceipts({receipts, purchases, links, jobs, projects, storeAccounts, today, scope})
 *   receipts       live job_receipts rows {job_id, id, vendor, receipt_date, amount, category,
 *                  paid_with, card_last4, receipt_no, photo_ref}; every live one, old ones too:
 *                  only those dated in the last WINDOW_DAYS with a total are matched, and an
 *                  older one keeps the state it had (re-noted as is), so the note door does not
 *                  take it away
 *   purchases      qbo-proxy listPurchases rows
 *   links          receipt_qbo_links rows
 *   jobs           {id, title, address, customer, qbJobcodeName, deleted, link (job_qbo_links row | null)}
 *   projects       qbo-proxy listProjects rows
 *   storeAccounts  app_settings receipts.qbo_store_accounts (null = store entry off)
 *   today          "YYYY-MM-DD" in Alaska
 *   scope          optional list of job ids: match every receipt (so one expense goes to the
 *                  same receipt as on a full run) but answer for these jobs only
 * → { notes: [rows for receipt_qbo_links_note], cards: [{job_id, job_name, input, rationale,
 *     evidence_refs}], stats: {receipts, matched, in_qbo, unmatched, conflicts, items,
 *     carried, owned: {queued, done, failed}, jobs: [job ids whose receipts were matched]} }
 */
export function matchReceipts({ receipts = [], purchases = [], links = [], jobs = [], projects = [],
  storeAccounts = null, today, scope = null } = {}) {
  if (!validDate(today)) throw new Error("matchReceipts: today must be YYYY-MM-DD");
  const inScope = scope ? new Set(scope.map(lc)) : null;
  const wanted = (jobId) => !inScope || inScope.has(lc(jobId));

  const jobById = new Map(jobs.map((j) => [lc(j.id), j]));
  const linkOf = new Map(links.map((l) => [str(l.receipt_id), l]));
  const projectById = new Map(projects.map((p) => [str(p.id), p]));
  const stores = readStoreAccounts(storeAccounts);
  const projectRefs = learnProjectRefs(purchases);
  const accountNames = new Map();
  for (const p of purchases) if (p.accountId && p.accountName && !accountNames.has(p.accountId)) accountNames.set(p.accountId, p.accountName);

  // One row per receipt id. Ids are unique among live rows (a receipt moved
  // between jobs leaves only a deleted row behind); should two live rows
  // ever share one, the first by job is kept, because the link table and
  // the note door are keyed by the id alone.
  const live = [];
  const seenIds = new Set();
  for (const r of [...receipts].sort((a, b) => byText(lc(a.job_id), lc(b.job_id)) || byText(str(a.id), str(b.id)))) {
    if (r.deleted_at != null || !RECEIPT_ID.test(str(r.id)) || seenIds.has(str(r.id))) continue;
    seenIds.add(str(r.id));
    live.push({ ...r, id: str(r.id), job_id: lc(r.job_id) });
  }
  const liveIds = new Set(live.map((r) => r.id));

  // An expense another receipt holds: approved (queued, done), or noted in
  // QuickBooks for a receipt that is still live (one whose receipt is gone
  // is removed by tonight's note, so it holds nothing).
  const claimedBy = new Map();
  for (const l of links) {
    const txn = str(l.qbo_txn_id);
    if (!txn) continue;
    if (l.state === "queued" || l.state === "done" || (l.state === "in_qbo" && liveIds.has(str(l.receipt_id)))) {
      claimedBy.set(`${str(l.qbo_txn_type) || "Purchase"}:${txn}`, str(l.receipt_id));
    }
  }

  const stats = { receipts: 0, matched: 0, in_qbo: 0, unmatched: 0, conflicts: 0, items: 0, carried: 0,
    owned: { queued: 0, done: 0, failed: 0 }, jobs: [] };
  const notes = [];
  const eligible = [];
  for (const r of live) {
    const link = linkOf.get(r.id);
    const job = jobById.get(r.job_id);
    if (link && OWNED.has(link.state)) {
      if (wanted(r.job_id)) stats.owned[link.state] += 1;
      continue;
    }
    if (!job || job.deleted === true || !UUID.test(r.job_id)) continue;
    if (inWindow(r, today)) { eligible.push(r); continue; }
    // Older (or dated ahead, or no total): keep what it was, unchanged.
    if (link && NOTE_STATES.has(link.state) && Number(r.amount) !== 0 && wanted(r.job_id)) {
      notes.push(carry(link, r.job_id));
      stats.carried += 1;
    }
  }

  // ---- 1. which expense each receipt is ----
  for (const r of eligible) {
    const abs = cents(r.amount);
    const credit = Number(r.amount) < 0;
    const lo = addDays(r.receipt_date, -1), hi = addDays(r.receipt_date, 3);
    r.cands = [];
    for (const p of purchases) {
      if (!DIGITS.test(str(p.id)) || !DIGITS.test(str(p.syncToken))) continue;
      if (cents(p.total) !== abs || (p.credit === true) !== credit) continue;
      if (!(str(p.txnDate) >= lo && str(p.txnDate) <= hi)) continue;
      const holder = claimedBy.get(`Purchase:${p.id}`);
      if (holder && holder !== r.id) continue;
      if (contradicts(r, p)) continue;
      const score = scoreOf(r, p);
      if (score >= MIN_SCORE) r.cands.push({ p, score });
    }
    r.best = r.cands.reduce((m, c) => Math.max(m, c.score), 0);
  }
  // The surest receipts choose first, so a weak match never takes the
  // expense a strong one needs; ties go by date, then id (the same order
  // every night).
  const taken = new Set();
  for (const r of [...eligible].sort((a, b) => b.best - a.best || byText(a.receipt_date, b.receipt_date) || byText(a.id, b.id))) {
    const left = r.cands.filter((c) => !taken.has(c.p.id));
    if (!left.length) continue;
    const top = Math.max(...left.map((c) => c.score));
    const tops = left.filter((c) => c.score === top);
    if (tops.length > 1) {
      r.ambiguous = tops.map((c) => c.p.id).sort(byText);
      continue;
    }
    r.match = tops[0].p;
    taken.add(r.match.id);
  }

  // ---- 2. per job: its QuickBooks project, then each receipt's state ----
  const byJob = new Map();
  for (const r of eligible) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);
  const cards = [];
  for (const [jobId, rs] of [...byJob].sort((a, b) => byText(a[0], b[0]))) {
    if (!wanted(jobId)) continue;
    stats.jobs.push(jobId);
    const job = jobById.get(jobId);
    const jobName = clip(str(job.title).trim() || str(job.address).trim() || str(job.customer).trim(), 160);
    const project = jobProject(job, rs, projectById, projectRefs);
    const items = [];

    for (const r of rs) {
      stats.receipts += 1;
      const photo = MEDIA.test(str(r.photo_ref)) ? [str(r.photo_ref)] : [];
      const base = { receipt_id: r.id, job_id: jobId, amount: round2(r.amount), receipt_date: r.receipt_date };

      if (r.ambiguous) {
        notes.push({ ...base, state: "conflict", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
          qbo_customer_id: null, detail: { reason: "ambiguous", candidates: r.ambiguous.slice(0, 5) } });
        stats.conflicts += 1;
        continue;
      }

      if (r.match) {
        stats.matched += 1;
        const m = r.match;
        const lines = Array.isArray(m.lines) ? m.lines : [];
        const tagged = lines.filter((l) => str(l.customerId));
        const other = project.id ? tagged.find((l) => str(l.customerId) !== project.id) : null;
        const txn = { qbo_txn_type: "Purchase", qbo_txn_id: m.id, qbo_sync_token: m.syncToken };
        const qboDetail = compact({ qbo_doc_number: str(m.docNumber), qbo_account_name: str(m.accountName), qbo_total: round2(m.total) });
        const needAttach = !hasDocument(m) && photo.length > 0;

        if (other) {
          notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: idOrNull(other.customerId),
            detail: { reason: "tagged_other", ...compact({ qbo_customer_name: str(other.customerName) }), ...qboDetail } });
          stats.conflicts += 1;
          continue;
        }
        if (tagged.length && tagged.length < lines.length) {
          notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: idOrNull(tagged[0].customerId),
            detail: { reason: "partly_tagged", ...qboDetail } });
          stats.conflicts += 1;
          continue;
        }
        // Untagged with no project to tag it to, or tagged to customers we
        // cannot check against a job that has no project: the office links
        // the job first, and nothing goes on the card meanwhile. Not even
        // the photo: an attach approved now would mark the receipt done, and
        // the tag would never be offered once the job is linked (nor would
        // a tag the books give another job ever show as a conflict).
        if (!project.id) {
          notes.push({ ...base, state: "unmatched", ...txn, qbo_customer_id: tagged.length ? idOrNull(tagged[0].customerId) : null,
            detail: { reason: "needs_job_link", ...qboDetail } });
          stats.unmatched += 1;
          continue;
        }
        const changes = [...(tagged.length ? [] : ["tag"]), ...(needAttach ? ["attach"] : [])];
        if (!changes.length) {
          notes.push({ ...base, state: "in_qbo", ...txn, qbo_customer_id: project.id, detail: qboDetail });
          stats.in_qbo += 1;
          continue;
        }
        items.push(item(r, m, changes, photo, changes.includes("tag") ? project.ref : null));
        continue;
      }

      // No expense found: why, in the words the office reads.
      const pw = lc(r.paid_with);
      const age = daysFrom(r.receipt_date, today);
      let reason = "not_found";
      if (pw === "card") {
        reason = age <= FEED_WAIT_DAYS ? "waiting_feed" : "not_found";
      } else if (pw === "account") {
        // The office books dump tickets as Bills, which listPurchases does
        // not read: not finding one says nothing about whether it is entered
        reason = lc(r.category) === "dump" || vendorFamily(r.vendor) === "fnsb" ? "bill_not_checked" : "store_not_entered";
        const store = stores.get(vendorFamily(r.vendor) ?? "");
        if (store && lc(r.category) !== "dump") {
          const doc = digitsOf(r.receipt_no);
          if (!project.id) {
            reason = "needs_job_link";
          } else if (age >= store.min_age_days && doc.length >= 5 && doc.length <= 21) {
            // at least 5 digits, docAgrees' floor: qbo-proxy finds the
            // bookkeeper's own entry by this number's prefix, and a shorter
            // one starts other invoices' numbers too
            items.push(createItem(r, store, doc, photo, project.ref, accountNames.get(store.account_id) ?? ""));
            continue;
          }
        }
      }
      notes.push({ ...base, state: "unmatched", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
        qbo_customer_id: null, detail: { reason } });
      stats.unmatched += 1;
    }

    if (!items.length) continue;
    items.sort((a, b) => byText(a.date, b.date) || byText(a.receipt_id, b.receipt_id));
    const kept = items.slice(0, MAX_ITEMS);   // the rest wait for the next card
    stats.items += kept.length;
    const tags = kept.some((i) => i.changes.includes("tag") || i.changes.includes("create"));
    const input = {
      job_id: jobId,
      job_name: jobName,
      qbo_customer_id: tags ? project.id : "",
      qbo_name: tags ? project.name : "",
      ...(project.suggestion ? { link: project.suggestion } : {}),
      items: kept,
      total_usd: round2(kept.reduce((s, i) => s + Math.abs(i.amount), 0)),
      matcher: MATCHER,
    };
    cards.push({ job_id: jobId, job_name: jobName, input, rationale: rationaleOf(jobName, kept), evidence_refs: [] });
  }

  notes.sort((a, b) => byText(a.receipt_id, b.receipt_id));
  return { notes, cards, stats };
}

/* The job's QuickBooks project: its link when it has one; otherwise a
   suggestion the card carries (approving it links the job): the one customer
   tonight's matched expenses for this job are already tagged to, or else the
   one project named exactly like the job's QuickBooks Time jobcode. */
function jobProject(job, rs, projectById, projectRefs) {
  const nameOf = (id, fallback = "") => clip(str(projectById.get(id)?.name) || fallback, 160);
  const link = job.link && DIGITS.test(str(job.link.qbo_customer_id)) ? job.link : null;
  if (link) {
    const id = str(link.qbo_customer_id);
    return { id, name: clip(str(link.qbo_name) || nameOf(id), 160), ref: idOrNull(link.qbo_project_ref) ?? projectRefs.get(id) ?? null, suggestion: null };
  }
  const tagged = new Map();     // customer id → [count of matched expenses, a line's customer name]
  for (const r of rs) {
    if (!r.match) continue;
    const ids = new Set();
    for (const l of r.match.lines ?? []) {
      if (!str(l.customerId)) continue;
      ids.add(str(l.customerId));
      if (!tagged.has(str(l.customerId))) tagged.set(str(l.customerId), [0, str(l.customerName)]);
    }
    for (const id of ids) tagged.get(id)[0] += 1;
  }
  const none = { id: "", name: "", ref: null, suggestion: null };
  const jobcode = lc(job.qbJobcodeName);
  const named = jobcode
    ? [...projectById.values()].filter((p) => p.isProject === true && lc(p.name) === jobcode && DIGITS.test(str(p.id)))
    : [];
  let id = null, source = null, why = "";
  if (tagged.size === 1) {
    const [[cid, [n, lineName]]] = [...tagged];
    // Only a project listProjects returns (active, Job = true): a line tagged
    // to the parent customer, or to a sub-customer that is not a project,
    // would link the job to it and tag every untagged expense there
    if (DIGITS.test(cid) && projectById.get(cid)?.isProject === true) {
      // the jobcode names another project: a person decides
      if (named.length === 1 && str(named[0].id) !== cid) return none;
      id = cid;
      source = "suggested_tagged";
      why = `${n} of this job's receipts ${n === 1 ? "matches a QuickBooks expense" : "match QuickBooks expenses"} already tagged to ${nameOf(cid, lineName) || `customer ${cid}`}`;
    }
  }
  if (!id && named.length === 1) {
    id = str(named[0].id);
    source = "suggested_qbtime";
    why = `the job's QuickBooks Time jobcode is "${str(job.qbJobcodeName).trim()}", the same name as this project`;
  }
  if (!id) return none;
  const lineName = tagged.get(id)?.[1] ?? "";
  const name = nameOf(id, lineName);
  const ref = projectRefs.get(id) ?? null;
  return { id, name, ref, suggestion: { qbo_customer_id: id, qbo_name: name, qbo_project_ref: ref, source, why } };
}

/** One line of the card: a matched expense and what it needs. */
function item(r, m, changes, photo, projectRef) {
  return {
    receipt_id: r.id,
    vendor: clip(r.vendor, 200),
    date: r.receipt_date,
    amount: round2(r.amount),
    receipt_no: clip(r.receipt_no, 200),
    qbo_txn_type: "Purchase",
    qbo_txn_id: m.id,
    qbo_sync_token: m.syncToken,
    qbo_doc_number: clip(m.docNumber, 200),
    qbo_account_name: clip(m.accountName, 200),
    qbo_vendor_name: clip(m.vendorName, 200),
    qbo_total: round2(m.total),
    changes,
    photo_refs: changes.includes("attach") ? photo : [],
    project_ref: projectRef,
    read_photo_ref: readPhoto(r),
  };
}

/** The receipt's photo_ref as read: the filing door files the card only
    while job_receipts still holds it (and the amount and date), so a photo
    retaken during the run is never the one attached. */
const readPhoto = (r) => (r.photo_ref == null ? null : str(r.photo_ref));

/** A store invoice nobody entered yet, entered by the app (only when
    app_settings receipts.qbo_store_accounts names the store). qbo-proxy
    looks for the bookkeeper's own entry of the same invoice first and adopts
    it, so this never doubles one. */
function createItem(r, store, doc, photo, projectRef, accountName) {
  const amount = round2(r.amount);
  const equipment = lc(r.category) === "equipment";
  return {
    receipt_id: r.id,
    vendor: clip(r.vendor, 200),
    date: r.receipt_date,
    amount,
    receipt_no: clip(r.receipt_no, 200),
    qbo_txn_type: "Purchase",
    qbo_txn_id: "",
    qbo_sync_token: "",
    qbo_doc_number: doc,
    qbo_account_name: clip(accountName, 200),
    qbo_total: null,
    changes: photo.length ? ["create", "attach"] : ["create"],
    photo_refs: photo,
    project_ref: projectRef,
    read_photo_ref: readPhoto(r),
    create: {
      account_id: store.account_id,
      vendor_id: store.vendor_id,
      payment_type: "CreditCard",
      credit: amount < 0,
      doc_number: doc,
      expense_account_id: equipment ? EQUIPMENT_EXPENSE_ACCOUNT : store.expense_account_id,
      class_id: store.class_id,
      txn_date: r.receipt_date,
      amount_abs: Math.abs(amount),
      memo: clip(`${str(r.vendor).trim()} ${str(r.receipt_no).trim()} (from the job receipts app)`.replace(/\s+/g, " ").trim(), 4000),
    },
  };
}

/** An older receipt's row, written back as it is (only the job it is on now). */
function carry(link, jobId) {
  return {
    receipt_id: str(link.receipt_id),
    job_id: jobId,
    state: link.state,
    qbo_txn_type: link.qbo_txn_type ?? null,
    qbo_txn_id: link.qbo_txn_id ?? null,
    qbo_sync_token: link.qbo_sync_token ?? null,
    qbo_customer_id: link.qbo_customer_id ?? null,
    amount: link.amount == null ? null : Number(link.amount),
    receipt_date: link.receipt_date ?? null,
    detail: link.detail && typeof link.detail === "object" ? link.detail : {},
  };
}

/** The card's one sentence. */
function rationaleOf(jobName, items) {
  const on = jobName || "this job";
  const creates = items.filter((i) => i.changes.includes("create")).length;
  const fixes = items.length - creates;
  const parts = [];
  if (fixes) {
    parts.push(fixes === 1
      ? `1 receipt on ${on} matches a QuickBooks expense that has no job tag or photo`
      : `${fixes} receipts on ${on} match QuickBooks expenses that have no job tag or photo`);
  }
  if (creates) {
    const lead = fixes ? "" : ` on ${on}`;
    parts.push(creates === 1
      ? `1 store invoice${lead} is not in QuickBooks yet`
      : `${creates} store invoices${lead} are not in QuickBooks yet`);
  }
  return `${parts.join("; ")}.`;
}

/** Drops empty strings, so a note's detail holds only what it knows. */
function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null && !Number.isNaN(v)));
}
