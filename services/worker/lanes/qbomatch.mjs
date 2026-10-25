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
                yet, a dump ticket whose bill is not entered yet, the job
                needs its QuickBooks project, a duplicate of another receipt
                on the job, or not found)
     conflict   an expense was found but we will not write to it: two equally
                good matches, or it is tagged to another job (a note); or,
                with store entry on, an invoice it would enter that
                QuickBooks or another receipt may already hold (maybe_entered);
                or a store's credit found without the slip's number, or a
                check found by its payee's name, untagged (credit_untagged,
                check_untagged: the office tags it by hand)

   A duplicate: two live receipts on one job with the same store, receipt
   number (5 digits or more), total and date are one slip entered twice (a
   crew's mistake: Spenard 700687087, $155.26, on 2156 Alston rd., Oct 12).
   The one that holds an expense (matched tonight, or on the approval path)
   stands for the slip, else the first by id; each other one that found no
   expense of its own is unmatched, reason "duplicate" (detail.duplicate_of),
   never "store_not_entered", which would tell the office to enter it, and
   never a store entry. The date must agree: a rental agreement's number
   repeats on each week's charge.

   Store entry never enters an invoice QuickBooks may already hold
   (maybeEntered): a transaction of the same direction whose DocNumber names
   it on ANY account (qbo-proxy only adopts an entry on the store's own
   account, and would post a second expense beside one on another), one from
   the store or on its account at its amount within DOC_DATE_SLACK under any
   number (a misread number, a debit-card charge the slip reader called
   "account"), whoever holds it; or another live receipt for the same slip
   on another job or day. A person looks instead.

   A return (a negative total, the app's "<receipt id>~ret" among them)
   matches only a credit (Credit = true), by the same rules. A return slip
   often prints the invoice it returns, which the reader takes for the
   slip's number, while the bookkeeper enters the store's credit under the
   credit memo's own number: when the slip's number names a purchase of the
   same store on the same job (returnedPurchase), the two numbers
   disagreeing does not rule the credit out (creditForReturn). Such a match
   rests on the store, the exact amount, the sign and the date, and is only
   ever noted or given the slip's photo, never tagged, and it never
   suggests the job's link. Store entry never enters a return: its slip's
   number is often the invoice it returns, not the credit memo's.

   A sub's invoice paid by a QuickBooks check the office writes days later
   is found by the check's payee, the receipt's vendor by name (checkTo).
   When the check's DocNumber does not name the invoice, or it is dated past
   the usual days, the match rests on the payee's name, the exact amount
   and two weeks of dates (byPayee), and the same rule holds as for a
   return: it is only ever noted or given the invoice's photo, never
   tagged (untagged, check_untagged), and it never suggests the job's link.
   A sub paid the same sum for two jobs' draws would otherwise have one
   job's check tagged to the other.

   An "expense" here is a QuickBooks Purchase (a card charge, or a store
   invoice entered against the store's account) or, from migration 0025, a
   Bill (a vendor's invoice entered to pay later: the FNSB dump tickets).
   A bill is only ever noted, never put on a card: every FNSB bill so far
   was entered tagged to the job with the ticket's photo, and nothing here
   writes to Accounts Payable. Tagged to the job it is in_qbo (a document or
   not); untagged it is a conflict (bill_untagged) the office tags by hand.
   Also from 0025 (v2):
     two or three charges  an equipment receipt paid by card with no single
                expense of its total is matched to the 2 or 3 untouched
                charges of the same card and store that add up to it to the
                cent (a rental: charged at checkout, the balance at return),
                when exactly one such set exists, its last charge is the
                receipt's day, and no other receipt could use those charges
                (splitSets)
     a second try  a receipt whose QuickBooks update failed is matched again,
                to the same expense or charges only: a note replaces the
                failed row, and an item goes on a new card (carrying refile)
                unless the failure would come back the same (a refusal on
                the KEEP_FAILED list, or the very failure the last second try
                died of) and nothing it depends on moved, or the owner
                already declined this same second try

   Why it is conservative: QuickBooks is the books. A wrong tag moves a cost
   to someone else's job and a second expense double counts it, so a match
   needs the exact amount, the right sign, a date inside the feed's lag, and
   a second piece of evidence (the store's invoice number, the vendor, the
   same day or the card's last four; for a QuickBooks check, its payee by
   name, checkTo), and nothing on the expense that says it is another
   store, another card or a payment (contradicts); two equally good
   expenses are left to a person; a tag already set is never changed; and
   one expense is matched to one receipt only.

   The real books (Oct 7 read) shaped the rules: Home Depot card 3176 charges
   arrive by bank rule into account 36, untagged, with no DocNumber and no
   photo (Purchase 10577); Spenard and Sherwin invoices are entered by hand
   about 9 days late with DocNumber = the invoice number (Sherwin adds digits
   after it: receipt 8066-9 is DocNumber 80669163000926), the project tag and
   the vendor's PDF; no job is linked to its QuickBooks project yet, so the
   job's link is suggested from the expenses its receipts matched, or from
   its QuickBooks Time jobcode name. Until the owner approves that link, a
   check or ACH receipt on the job may still be matched to an expense the
   office finished by hand for the project the matches suggest (step 1a):
   a note only, never a card, and never counted toward the suggestion. */

export const MATCHER = "receipts.qbo_match@1";
export const WINDOW_DAYS = 60;       // receipts older than this are not matched again (their state is kept)
// a card charge younger than this is "waiting for the bank feed": the Citi
// Home Depot card arrives in 2 or 3 days, the US Bank card up to 11 and
// checking up to 9 (Oct 2026)
export const FEED_WAIT_DAYS = 14;
// how far a store invoice's QuickBooks date may sit from the receipt's when
// its DocNumber carries the receipt number and the store is the same: the
// bookkeeper dates it by the invoice, the crew's slip may be the pick-up day
// (Spenard 700653391: receipt Oct 5, QuickBooks Oct 2). Only for a receipt
// charged to an account: a card charge's date comes from the bank, and a
// rental agreement's number repeats on each week's charge (Home Depot 193615)
export const DOC_DATE_SLACK = 14;
// how many days after the receipt a QuickBooks check to its payee may be
// dated: the office writes the check when the invoice comes in, by hand, so
// its date is the day written, never the invoice's (Aaron Wall $5,385: the
// invoice Oct 9, check 438 = Purchase 10701 Oct 13). Never earlier than the
// usual day before. Only for a check whose payee is the receipt's vendor by
// name (checkTo)
export const CHECK_DAYS = 14;
export const MIN_SCORE = 2;
// expense account for store entries of equipment receipts (rentals), instead of the store's own
export const EQUIPMENT_EXPENSE_ACCOUNT = "1150040005";
// the clearing account a payment to a card or a store account books to: such
// a row pays for purchases, it is not one
export const PAYMENT_CLEARING_ACCOUNT = "1150040008";

// The approval path's rows: never touched here. Before 0025 a failed row is
// held too; with 0025 (v2) a failed receipt is matched again (refile).
const OWNED = new Set(["queued", "done", "failed"]);
const OWNED_V2 = new Set(["queued", "done"]);
// A refusal that would come back the same if nothing it depends on moved:
// the receipt stays failed until the expense, the job's project, the
// receipt or its photo changes. "cancelled" is a change a person marked
// dead by hand (0025: error 'cancelled: <who and why>'); "entered_elsewhere"
// is qbo-proxy refusing a store entry whose invoice is already booked on
// another account. Every other failure (a relinked job, a bad request a
// qbo-proxy fix answers, trouble that outlasted the retries) goes on a new
// card at once, once per code: a second try that dies of the same code is
// kept too. Either way only to the same expense or charges.
export const KEEP_FAILED = new Set(["tagged_other", "partly_tagged", "untaggable", "untaggable_line", "purchase_missing",
  "changed_in_qbo", "photo_missing", "photo_type", "photo_unreadable", "photo_too_big", "upload_refused", "qbo_refused",
  "entered_elsewhere", "cancelled"]);
// Refusals about the photo: a row queued before 0025 did not record the
// photo the card read, so whether it moved since cannot be told, and it is
// tried once more (the 0025 executor records it on the new row)
const PHOTO_CODES = new Set(["photo_missing", "photo_type", "photo_unreadable", "photo_too_big", "upload_refused"]);
// A card that holds a second try and was answered: what it held is the
// owner's word on that try
const ANSWERED = new Set(["declined", "executed"]);
// Two or three charges that add up to one receipt: at most this many
// charges are looked at per receipt (more is too many to be sure of), and
// a charge may be dated up to SPLIT_DAYS before the receipt (a rental's
// first charge is at checkout, the receipt at return)
export const MAX_PARTS = 3;
export const SPLIT_POOL = 40;
export const SPLIT_DAYS = 14;
export const SPLIT_MIN_AGE = 3;
const NOTE_STATES = new Set(["in_qbo", "unmatched", "conflict"]);
const DIGITS = /^[0-9]{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA = /^media:[0-9a-f]{64}:[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The receipt ids both doors and qbo-proxy accept. job_receipts.id is free
// text (the app's uid(); a return slip is "<receipt id>~ret"), and one odd id
// must not fail the whole night's note.
const RECEIPT_ID = /^[\w.:~-]{1,64}$/;
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
  ["c&r pipe", /\bc\s*&\s*r\s+pipe|^pipe\s+(and|&)\s+steel\b/],   // QuickBooks names the vendor "Pipe and Steel"
  ["fairbanks block", /fairbanks\s+block/],
  ["fs&g", /\bfs\s*&\s*g\b/],
  ["browns electric", /\bbrown'?s?\s+electric/],              // "Browns Electrical Supply"; QuickBooks: "Brown Electric"
  ["tesco", /\btesco\b/],
  ["airport equipment", /airport\s+equipment|rental\s+zone/],  // The Rental Zone is its division
];

const str = (v) => (v == null ? "" : String(v));
const lc = (v) => str(v).trim().toLowerCase();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = (n) => Math.round(Math.abs(Number(n)) * 100);
const digitsOf = (v) => str(v).replace(/\D/g, "");
const clip = (v, n) => str(v).slice(0, n);
/** The refusal code a failed row's error starts with ("tagged_other: …"). */
export const codeOf = (err) => (/^cancell?ed\b/i.test(str(err).trim()) ? "cancelled"
  : (/^([a-z_]+):/.exec(str(err).trim()) || [])[1] || "");
const txnKey = (type, id) => `${str(type) || "Purchase"}:${str(id)}`;
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const detailOf = (l) => (isObject(l?.detail) ? l.detail : {});
/** JSON with every object's keys in order: two items compare by what they say. */
export const canonical = (v) => JSON.stringify(v, (_, x) => (isObject(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
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

/** Levenshtein distance between two digit strings (at most 21 digits each). */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length > 21 || b.length > 21) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The receipt number agrees with an expense's DocNumber: their digits are
    equal, or the receipt's digits start the DocNumber's (Sherwin's longer
    numbers). At least 5 digits, so a check number or a short ticket never
    counts. */
export function docAgrees(receiptNo, docNumber) {
  const d = docDigits(receiptNo);
  const D = docDigits(docNumber);
  return d.length >= 5 && D.length >= d.length && D.startsWith(d);
}

/** A number's digits without leading zeros: an FNSB ticket prints
    "01286734", and a zero dropped on either side is the same ticket. */
const docDigits = (v) => digitsOf(v).replace(/^0+/, "");

/** A dump ticket: the crew's category, or the borough's transfer station. */
const dumpTicket = (r) => lc(r.category) === "dump" || vendorFamily(r.vendor) === "fnsb";

/** The expense's DocNumber is another invoice's: both it and the receipt
    carry a number of 5 digits or more, they disagree, and the DocNumber is
    the store's own numbering: typed in from an invoice on an account, a
    bill, or as long as the receipt's number (another rental agreement,
    another ticket). Only a DocNumber that is a number (a bank's reference
    like "ZZ35725D8WZ2" is not one). A card charge's DocNumber may be the
    bank's reference instead: Citi fills the Home Depot charges with 7
    digits ("5020046") beside the 14 of the receipt ("1303 00002 79356"),
    which says nothing about which purchase it is. */
function otherInvoice(r, p) {
  const doc = str(p.docNumber).trim();
  if (!/^[0-9][0-9 -]*$/.test(doc)) return false;
  const mine = docDigits(r.receipt_no), theirs = docDigits(doc);
  if (mine.length < 5 || theirs.length < 5 || docAgrees(r.receipt_no, doc)) return false;
  return lc(r.paid_with) === "account" || p.txnType === "Bill" || mine.length === theirs.length;
}

/* The words of a payee's name: lowercase letters and digits, without the
   words a business name adds (Inc., LLC, the…), each once, in order, so
   "Wall, Aaron" and "AARON WALL LLC" are both "Aaron Wall". */
const NAME_FILLER = new Set(["inc", "llc", "co", "corp", "corporation", "company", "ltd", "the"]);
const nameWords = (v) => [...new Set(lc(v).replace(/[.'‘’]/g, "").split(/[^a-z0-9]+/)
  .filter((w) => w && !NAME_FILLER.has(w)))].sort(byText);

/** The expense is a QuickBooks check (PaymentType Check) written to the
    receipt's vendor: the payee's name is the receipt's vendor word for word
    (in any order, the business words aside), two words at least, and
    neither is a store (a vendor family keeps the store rules, where a check
    to the store pays its account). Only for a receipt the reader called an
    invoice ("account") or could not tell (""): one paid at the counter is
    not paid by a check written later. A sub's invoice paid by check: the
    vendor's name is the second piece of evidence (+2), and the check may be
    dated up to CHECK_DAYS after the receipt. The check number is not used:
    the app keeps no check number, and the receipt's number is the payee's
    invoice number, which a short check number can equal by chance. A check
    found this way alone (byPayee) never suggests the job's link
    (jobProject) and is never tagged (check_untagged). */
export function checkTo(r, p) {
  if (p.paymentType !== "Check" || !["account", ""].includes(lc(r.paid_with))) return false;
  if (vendorFamily(r.vendor) || vendorFamily(p.vendorName)) return false;
  const mine = nameWords(r.vendor);
  return mine.length >= 2 && mine.join(" ") === nameWords(p.vendorName).join(" ");
}

/** How strongly one expense looks like one receipt: +3 the receipt number,
    +2 the vendor family (for a check, its payee by name: checkTo), +1
    the same date, +1 the card's last four in the
    card account's name or the memo. A checking account's name carries the
    bank account's number, which every expense paid from it shares: it tells
    one checking expense from another not at all, so it scores nothing (a
    check or ACH receipt "paid from ****8992" would otherwise match any
    checking expense of its amount on its day), except on an expense the
    office already finished for this receipt's job: every line tagged to the
    job's linked QuickBooks customer (jobCustomer) and a document attached.
    That match only ever notes it in QuickBooks, and writes nothing (FBX
    Electric invoice 1065: QuickBooks 10662, $784 by ACH under the owner's
    name, tagged to 1885 Chena Landings with "Invoice 1065.pdf"). A job not
    linked yet has no jobCustomer here; matchReceipts' step 1a passes the
    project its other receipts' matches suggest, for a receipt nothing else
    matched. */
export function scoreOf(r, p, jobCustomer = "") {
  let s = 0;
  if (docAgrees(r.receipt_no, p.docNumber)) s += 3;
  const fam = vendorFamily(r.vendor);
  if (fam && (vendorFamily(p.vendorName) === fam || vendorFamily(p.note) === fam)) s += 2;
  else if (checkTo(r, p)) s += 2;
  if (str(p.txnDate) === str(r.receipt_date)) s += 1;
  const last4 = str(r.card_last4).trim();
  if (/^\d{4}$/.test(last4)
      && ((p.paymentType === "CreditCard" && str(p.accountName).includes(last4)) || str(p.note).includes(last4)
        || (str(p.accountName).includes(last4) && finishedFor(p, jobCustomer)))) s += 1;
  return s;
}

/** Every line tagged to this customer, and a document attached: nothing
    left for a card to do on the expense. */
function finishedFor(p, customerId) {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  return DIGITS.test(str(customerId)) && lines.length > 0 && lines.every((l) => str(l.customerId) === str(customerId))
    && hasDocument(p);
}

/** The expense says it is not this receipt's: a bill for a receipt paid at
    the counter, a bill for a dump ticket whose ticket number it does not
    carry, a DocNumber that is another invoice's number, another store (both vendor
    families known, and none of the expense's is the receipt's), another
    card (the receipt's last four is nowhere on the expense, whose card
    account's name carries a card number; a checking account's name is the
    bank's number, not the debit card's, so it never counts), a payment
    (every line on the payment clearing account), or, for a receipt charged
    to a store account, money paid from the bank (Cash or Check) unless the
    expense names this very invoice (its DocNumber carries the receipt
    number) or the bank account the receipt says paid it (its last four in
    the account's name), or it is a check to the receipt's vendor by name
    (checkTo: Aaron Wall's invoice, check 438): the slip reader calls any
    invoice with no card on it "account", so an invoice paid by debit card
    or ACH reads that way too (FS&G 209998, FBX Electric 1065). Missing a
    true match only leaves the receipt unmatched; matching a wrong one tags
    and photographs someone else's expense. */
export function contradicts(r, p) {
  // a bill is paid later: a receipt paid at the counter (by card, in cash,
  // or on someone's own card) is never one
  if (p.txnType === "Bill" && ["card", "cash", "personal"].includes(lc(r.paid_with))) return true;
  // a dump ticket's bill always carries the ticket number, and the borough
  // charges by the 20 lb, so another ticket of the same amount the same day
  // is common: only the ticket's own number makes a bill its ticket's
  if (p.txnType === "Bill" && dumpTicket(r) && !docAgrees(r.receipt_no, p.docNumber)) return true;
  // the expense names another invoice (or ticket, or rental agreement)
  if (otherInvoice(r, p)) return true;
  const fam = vendorFamily(r.vendor);
  const theirs = [vendorFamily(p.vendorName), vendorFamily(p.note)].filter(Boolean);
  if (fam && theirs.length && !theirs.includes(fam)) return true;
  const last4 = str(r.card_last4).trim();
  if (/^\d{4}$/.test(last4) && p.paymentType === "CreditCard" && /\b\d{4}\b/.test(str(p.accountName))
      && !str(p.accountName).includes(last4) && !str(p.note).includes(last4)) return true;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length && lines.every((l) => str(l.accountId) === PAYMENT_CLEARING_ACCOUNT)) return true;
  if (lc(r.paid_with) === "account" && (p.paymentType === "Cash" || p.paymentType === "Check")
      && !docAgrees(r.receipt_no, p.docNumber)
      && !(/^\d{4}$/.test(last4) && str(p.accountName).includes(last4))
      && !checkTo(r, p)) return true;
  return false;
}

/** The store a receipt was printed by, to tell two receipts apart: its
    vendor family, or its printed vendor as written when it is in none. */
const storeKey = (r) => vendorFamily(r.vendor) ?? lc(r.vendor).replace(/\s+/g, " ");

/** Two receipts carry the same slip: the same store, the same receipt
    number (5 digits or more, docAgrees' floor, leading zeros aside) and the
    same total, sign and all. The date is the caller's to compare. */
export function sameSlip(a, b) {
  const no = docDigits(a?.receipt_no);
  return no.length >= 5 && no === docDigits(b?.receipt_no) && storeKey(a) !== "" && storeKey(a) === storeKey(b)
    && Number.isFinite(Number(a.amount)) && Math.round(Number(a.amount) * 100) === Math.round(Number(b.amount) * 100);
}

/** Why store entry must not enter this invoice although no expense matched
    it, or null. Every transaction of the receipt's direction (a purchase is
    never a return's entry) that is it or may be:
      - its DocNumber names this invoice, on any account (qbo-proxy's
        pickExistingCreate rule: the same number at any amount, or a longer
        number starting with it at the same amount), unless it is another
        store's: qbo-proxy adopts only an entry on the store's own account,
        and would post a second expense beside one on another;
      - or it is from this store (vendor or memo) or on the store's account,
        at this amount, dated within DOC_DATE_SLACK, under any number or
        none (a misread receipt number; a debit-card charge from checking
        the slip reader called "account").
    Whoever holds it: another receipt may (the same slip entered twice, or a
    receipt since deleted that still holds it). And every other live receipt
    for the same slip that is not this one's duplicate (the same job and
    day): on another job, or another day, it may be entering it too. */
function maybeEntered(r, store, txns, live) {
  const credit = Number(r.amount) < 0;
  const fam = vendorFamily(r.vendor);
  const no = docDigits(r.receipt_no);
  const candidates = txns.filter((p) => {
    if ((p.credit === true) !== credit || !DIGITS.test(str(p.id))) return false;
    const theirs = [vendorFamily(p.vendorName), vendorFamily(p.note)].filter(Boolean);
    const doc = docDigits(p.docNumber);
    if (no.length >= 5 && !(fam && theirs.length && !theirs.includes(fam))
        && (doc === no || (doc.startsWith(no) && cents(p.total) === cents(r.amount)))) return true;
    return cents(p.total) === cents(r.amount) && validDate(str(p.txnDate))
      && Math.abs(daysFrom(r.receipt_date, str(p.txnDate))) <= DOC_DATE_SLACK
      && ((fam && theirs.includes(fam)) || str(p.accountId) === store.account_id);
  }).map((p) => txnKey(p.txnType, p.id));
  const receipts = live.filter((s) => s.id !== r.id && sameSlip(r, s) && !(s.job_id === r.job_id && s.receipt_date === r.receipt_date))
    .map((s) => s.id);
  if (!candidates.length && !receipts.length) return null;
  const ids = [...new Set(candidates)].sort(byText).map((k) => k.slice(k.indexOf(":") + 1));
  return compact({ candidates: ids.length ? ids.slice(0, 5) : null, receipts: receipts.length ? receipts.sort(byText).slice(0, 5) : null });
}

/** The purchase a return's slip number names, or null. A store's return
    slip prints the invoice it returns, and the reader may take that for the
    slip's own number (the Spenard Styrofoam slip of Oct 7: "7066665392", a
    misread of invoice 700665392), while the bookkeeper enters the store's
    credit under the credit memo's own number (Purchase 10688, DocNumber
    800053082). Only for a return (a negative total) charged to a store
    account: a live receipt on the same job, from the same store, a purchase
    dated on or before the return of at least the refund, whose number is
    the slip's (docAgrees either way) or, both 9 digits or more, the same
    number with up to two digits misread. It only ever stops the slip's
    number from ruling out the store's credit (creditForReturn); it never
    counts as the credit's number. */
export function returnedPurchase(r, receipts) {
  const fam = vendorFamily(r?.vendor);
  const mine = docDigits(r?.receipt_no);
  if (!(Number(r?.amount) < 0) || lc(r?.paid_with) !== "account" || !fam || mine.length < 5 || !validDate(str(r?.receipt_date))) return null;
  for (const q of receipts ?? []) {
    if (q?.deleted_at != null || lc(q.job_id) !== lc(r.job_id) || !(Number(q.amount) > 0) || cents(q.amount) < cents(r.amount)) continue;
    if (vendorFamily(q.vendor) !== fam || !validDate(str(q.receipt_date)) || str(q.receipt_date) > str(r.receipt_date)) continue;
    const theirs = docDigits(q.receipt_no);
    if (theirs.length < 5) continue;
    if (docAgrees(r.receipt_no, q.receipt_no) || docAgrees(q.receipt_no, r.receipt_no)
        || (mine.length >= 9 && theirs.length >= 9 && editDistance(mine, theirs) <= 2)) return q;
  }
  return null;
}

/** A store's credit that may be a return's although its DocNumber is not
    the slip's number: the return's slip number names the purchase it
    returns (returnedPurchase), so the credit memo's own number disagreeing
    with it says nothing. Everything else still holds: a credit (the sign is
    checked before), the same store by the credit's vendor or memo, and
    nothing on it contradicts the return once the slip's number is set
    aside (another store, a payment on the store account). The date stays
    a day before to three days after: DOC_DATE_SLACK needs the number. */
export function creditForReturn(r, p) {
  const fam = vendorFamily(r.vendor);
  return p.credit === true && p.txnType !== "Bill" && Number(r.amount) < 0 && !!fam
    && (vendorFamily(p.vendorName) === fam || vendorFamily(p.note) === fam)
    && !contradicts({ ...r, receipt_no: "" }, p);
}

/** The expense names this invoice: its DocNumber carries the receipt number
    and both are the same store. What lets an expense dated up to
    DOC_DATE_SLACK days away be this receipt's. */
export function sameInvoice(r, p) {
  const fam = vendorFamily(r.vendor);
  return !!fam && docAgrees(r.receipt_no, p.docNumber)
    && (vendorFamily(p.vendorName) === fam || vendorFamily(p.note) === fam);
}

/** The receipts the matcher will look at tonight (live, a total, dated in
    the last WINDOW_DAYS), and the expense window listPurchases needs for
    them: from DOC_DATE_SLACK days before the oldest (a store invoice may be
    dated that early), to today. Null when there are none, so the lane need
    not ask QuickBooks at all. */
export function purchaseWindow(receipts, today) {
  let from = null;
  for (const r of receipts ?? []) {
    if (!inWindow(r, today)) continue;
    if (from === null || r.receipt_date < from) from = r.receipt_date;
  }
  return from === null ? null : { from: addDays(from, -DOC_DATE_SLACK), to: today };
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
 *   bills          qbo-proxy listBills rows, or null when they were not read (v1, an older
 *                  qbo-proxy, or listBills failing tonight): no bill is matched, a dump ticket
 *                  reads bill_not_checked, and a receipt whose row names a bill (in_qbo or
 *                  conflict) keeps that row as it is
 *   splits         look for receipts paid in two or three charges (v2 only; default: the
 *                  bills were read). The lane turns it off only for a qbo-proxy older than
 *                  parts, which could not deliver them
 *   answered       Map(lowercase proposal id → {status, items}): the cards failed rows name
 *                  in detail.refiled_proposal_id; a declined or executed one that held this
 *                  very second try keeps the failed row (v2)
 *   links          receipt_qbo_links rows
 *   jobs           {id, title, address, customer, qbJobcodeName, deleted, link (job_qbo_links row | null)}
 *   projects       qbo-proxy listProjects rows
 *   storeAccounts  app_settings receipts.qbo_store_accounts (null = store entry off)
 *   today          "YYYY-MM-DD" in Alaska
 *   scope          optional list of job ids: match every receipt (so one expense goes to the
 *                  same receipt as on a full run) but answer for these jobs only
 *   v2             the database has migration 0025 (bills, receipts in parts, re-filing);
 *                  false gives exactly the 0023 answers
 * → { notes: [rows for receipt_qbo_links_note], cards: [{job_id, job_name, input, rationale,
 *     evidence_refs}], stats: {receipts, matched, in_qbo, unmatched, conflicts, items,
 *     carried, owned: {queued, done, failed}, jobs: [job ids whose receipts were matched]} }
 */
export function matchReceipts({ receipts = [], purchases = [], bills = null, links = [], jobs = [], projects = [],
  storeAccounts = null, today, scope = null, v2 = false, splits = Array.isArray(bills) && v2 === true,
  answered = new Map() } = {}) {
  if (!validDate(today)) throw new Error("matchReceipts: today must be YYYY-MM-DD");
  const billsRead = v2 === true && Array.isArray(bills);
  const splitsOn = v2 === true && splits === true;
  const cardsAnswered = answered instanceof Map ? answered : new Map();
  const owned = v2 === true ? OWNED_V2 : OWNED;
  // v2: a note naming one transaction says it has no parts, so a row that
  // was a receipt in parts drops them (the 0025 door keeps a row's parts
  // when the key is left out); v1 knows nothing of parts
  const noParts = v2 === true ? { parts: null } : {};
  // every transaction a receipt may be: the expenses, and the bills when read
  const txns = [
    ...purchases.map((p) => ({ ...p, txnType: "Purchase" })),
    ...(billsRead ? bills.map((b) => ({ ...b, txnType: "Bill", credit: false, paymentType: "" })) : []),
  ];
  const inScope = scope ? new Set(scope.map(lc)) : null;
  const wanted = (jobId) => !inScope || inScope.has(lc(jobId));

  const jobById = new Map(jobs.map((j) => [lc(j.id), j]));
  const linkOf = new Map(links.map((l) => [str(l.receipt_id), l]));
  const projectById = new Map(projects.map((p) => [str(p.id), p]));
  const stores = readStoreAccounts(storeAccounts);
  const projectRefs = learnProjectRefs(txns);
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
  // is removed by tonight's note, so it holds nothing). A receipt in parts
  // holds every one of its charges.
  // From 0025 a failed receipt that is still live holds its transactions
  // too: it is matched again tonight and may need them back, and no other
  // receipt takes a charge whose update was refused.
  // A step 1a note (in_qbo, detail.job_link) holds nothing: step 1a works
  // its match out again each night, and a receipt uploaded since that the
  // expense names must find it in step 1, which keeps step 1a off it.
  // A check noted in_qbo by its payee's name alone (detail.by_payee) holds
  // it only against a receipt the name alone reaches too (nameHeld): any
  // other that may be it, such as one whose invoice number the check's
  // DocNumber carries, dated in its usual days, takes it, as on a fresh
  // run, however its vendor reads.
  const claimedBy = new Map();
  const nameHeld = new Map();
  for (const l of links) {
    const live = liveIds.has(str(l.receipt_id));
    const viaSuggestion = l.state === "in_qbo" && !!detailOf(l).job_link;
    if (!(l.state === "queued" || l.state === "done" || (l.state === "in_qbo" && live && !viaSuggestion)
        || (v2 === true && l.state === "failed" && live))) continue;
    const held = l.state === "in_qbo" && detailOf(l).by_payee === true ? nameHeld : claimedBy;
    if (str(l.qbo_txn_id)) held.set(txnKey(l.qbo_txn_type, l.qbo_txn_id), str(l.receipt_id));
    for (const part of Array.isArray(l.parts) ? l.parts : []) {
      if (str(part?.qbo_txn_id)) held.set(txnKey(l.qbo_txn_type, part.qbo_txn_id), str(l.receipt_id));
    }
  }

  const stats = { receipts: 0, matched: 0, in_qbo: 0, unmatched: 0, conflicts: 0, items: 0, carried: 0,
    owned: { queued: 0, done: 0, failed: 0 }, jobs: [] };
  const notes = [];
  const eligible = [];
  for (const r of live) {
    const link = linkOf.get(r.id);
    const job = jobById.get(r.job_id);
    if (link && owned.has(link.state)) {
      if (wanted(r.job_id)) stats.owned[link.state] += 1;
      continue;
    }
    const failed = link?.state === "failed";      // v2 only: v1 holds it above
    if (!job || job.deleted === true || !UUID.test(r.job_id)) {
      if (failed && wanted(r.job_id)) stats.owned.failed += 1;
      continue;
    }
    if (inWindow(r, today)) {
      // The bills were not read tonight: a receipt matched to a bill keeps
      // that row as it is (one bad night never drops a matched ticket), and
      // takes no expense meanwhile
      if (v2 === true && !billsRead && link && str(link.qbo_txn_type) === "Bill"
          && (link.state === "in_qbo" || link.state === "conflict")) {
        if (wanted(r.job_id)) {
          notes.push(carry(link, r.job_id, v2));
          stats.carried += 1;
        }
        continue;
      }
      if (failed) r.failedLink = link;
      eligible.push(r);
      continue;
    }
    if (failed) {
      if (wanted(r.job_id)) stats.owned.failed += 1;
      continue;
    }
    // Older (or dated ahead, or no total): keep what it was, unchanged.
    if (link && NOTE_STATES.has(link.state) && Number(r.amount) !== 0 && wanted(r.job_id)) {
      notes.push(carry(link, r.job_id, v2));
      stats.carried += 1;
    }
  }

  // The transaction may be this receipt's: the exact amount and sign, a
  // date inside the feed's lag (or a store invoice's DOC_DATE_SLACK), no
  // other receipt holds it, and nothing on it says it is another's.
  // A check to the receipt's vendor by name may be dated up to CHECK_DAYS
  // after it (checkTo). Returns null, or {byStore}: byStore is a return's
  // store credit under the credit memo's own number (creditForReturn), only
  // when the caller passes the purchase the slip names (returned): step 1
  // does, step 1a never does.
  // A check rests on its payee's name (payeeOnly) when its DocNumber does
  // not name the receipt's invoice, or it is dated past the usual three
  // days (only checkTo lets it in).
  const payeeOnly = (r, p) => !docAgrees(r.receipt_no, p.docNumber) || str(p.txnDate) > addDays(r.receipt_date, 3);
  const admissible = (r, p, returned = null) => {
    if (!DIGITS.test(str(p.id)) || !DIGITS.test(str(p.syncToken))) return null;
    if (cents(p.total) !== cents(r.amount) || (p.credit === true) !== (Number(r.amount) < 0)) return null;
    const d = str(p.txnDate);
    const lo = addDays(r.receipt_date, -1), hi = addDays(r.receipt_date, 3);
    const wideLo = addDays(r.receipt_date, -DOC_DATE_SLACK), wideHi = addDays(r.receipt_date, DOC_DATE_SLACK);
    const slack = lc(r.paid_with) === "account";     // DOC_DATE_SLACK: an invoice on an account only
    const checkHi = addDays(r.receipt_date, CHECK_DAYS);
    if (!(d >= lo && d <= hi) && !(slack && d >= wideLo && d <= wideHi && sameInvoice(r, p))
        && !(d > hi && d <= checkHi && checkTo(r, p))) return null;
    const holder = claimedBy.get(txnKey(p.txnType, p.id));
    if (holder && holder !== r.id) return null;
    const byName = nameHeld.get(txnKey(p.txnType, p.id));
    if (byName && byName !== r.id && checkTo(r, p) && payeeOnly(r, p)) return null;
    if (!contradicts(r, p)) return { byStore: false };
    return returned && creditForReturn(r, p) ? { byStore: true } : null;
  };

  // The first by id of a receipt's twins among rs (the same slip on the
  // same job and day, as step 1c reads it), or its own id. Where receipts
  // are counted against an expense, a slip entered twice counts once: it
  // finds its expense, and step 1c calls the other copy a duplicate.
  const firstTwin = (r, rs) => rs.filter((s) => s.id === r.id || (s.job_id === r.job_id
    && str(s.receipt_date) === str(r.receipt_date) && sameSlip(r, s))).map((s) => s.id).sort(byText)[0];

  // ---- 1. which expense each receipt is ----
  for (const r of eligible) {
    // the job's linked QuickBooks customer (a picked or approved link only:
    // a suggestion is made from the matches, after them; step 1a)
    const link = jobById.get(r.job_id)?.link;
    const jobCustomer = link && DIGITS.test(str(link.qbo_customer_id)) ? str(link.qbo_customer_id) : "";
    // a return whose slip number is the invoice it returns (returnedPurchase)
    const returned = Number(r.amount) < 0 ? returnedPurchase(r, live) : null;
    r.cands = [];
    for (const p of txns) {
      const ok = admissible(r, p, returned);
      if (!ok) continue;
      const score = scoreOf(r, p, jobCustomer);
      if (score < MIN_SCORE) continue;
      // byPayee: a check that rests on its payee's name (payeeOnly)
      const check = checkTo(r, p);
      r.cands.push({ p, score, check, byStore: ok.byStore, byPayee: check && payeeOnly(r, p) });
    }
    r.best = r.cands.reduce((m, c) => Math.max(m, c.score), 0);
  }
  // A check two receipts could be by its payee is neither's: a sub paid the
  // same sum twice (two jobs' equal draws) is not told apart by the name and
  // two weeks of dates, so a person decides (a conflict for each). The same
  // invoice entered twice is one payee's claim, not two (firstTwin). Only a
  // match that rests on the payee's name (byPayee) is held back so: a check
  // whose DocNumber names the invoice, dated in the usual window, is that
  // receipt's, though it still counts against one that could be it by the
  // name alone
  const checkSeekers = new Map();       // txn key → the slips that could be it
  for (const r of eligible) {
    for (const c of r.cands) {
      if (!c.check) continue;
      const k = txnKey(c.p.txnType, c.p.id);
      checkSeekers.set(k, (checkSeekers.get(k) ?? new Set()).add(firstTwin(r, eligible)));
    }
  }
  const shared = (c) => c.byPayee && (checkSeekers.get(txnKey(c.p.txnType, c.p.id))?.size ?? 0) > 1;
  // A receipt in QuickBooks on an expense it can no longer be tonight
  // (deleted, voided or changed there since: not among its candidates)
  // takes no check by its payee's name in its place: the sub's next equal
  // check is another invoice's. It still counts against another receipt
  // the name reaches (checkSeekers, counted before). Left with nothing
  // else, it keeps its row as it is, as an older receipt does, and a twin
  // of it reads as its duplicate (step 1c)
  for (const r of [...eligible]) {
    const own = linkOf.get(r.id);
    if (own?.state !== "in_qbo" || r.cands.some((c) => txnKey(c.p.txnType, c.p.id) === txnKey(own.qbo_txn_type, own.qbo_txn_id))
        || !r.cands.some((c) => c.byPayee)) continue;
    r.cands = r.cands.filter((c) => !c.byPayee);
    r.best = r.cands.reduce((m, c) => Math.max(m, c.score), 0);
    if (r.cands.length) continue;
    eligible.splice(eligible.indexOf(r), 1);
    if (wanted(r.job_id)) {
      notes.push(carry(own, r.job_id, v2));
      stats.carried += 1;
    }
  }
  // A slip one of its twins already holds an expense for (matched tonight,
  // or its row: queued, done, failed or in_qbo) takes no check of its own:
  // a sub's next equal check is another invoice's, and step 1c calls this
  // copy a duplicate
  const slipHeld = (r) => live.some((s) => s.id !== r.id && s.job_id === r.job_id && str(s.receipt_date) === str(r.receipt_date)
    && sameSlip(r, s) && (!!s.match || ["queued", "done", "failed", "in_qbo"].includes(str(linkOf.get(s.id)?.state))));
  // The surest receipts choose first, so a weak match never takes the
  // expense a strong one needs; ties go by date, then id (the same order
  // every night).
  const taken = new Set();
  for (const r of [...eligible].sort((a, b) => b.best - a.best || byText(a.receipt_date, b.receipt_date) || byText(a.id, b.id))) {
    const left = r.cands.filter((c) => !taken.has(txnKey(c.p.txnType, c.p.id)) && !(c.check && slipHeld(r)));
    if (!left.length) continue;
    const top = Math.max(...left.map((c) => c.score));
    const tops = left.filter((c) => c.score === top);
    if (tops.length > 1 || tops.some(shared)) {
      r.ambiguous = tops.map((c) => c.p.id).sort(byText);
      continue;
    }
    r.match = tops[0].p;
    r.byStore = tops[0].byStore === true;
    r.byPayee = tops[0].byPayee === true;
    taken.add(txnKey(r.match.txnType, r.match.id));
  }

  // ---- 1a. a receipt on a job whose project is only suggested ----
  // The checking account's last four counts only on an expense the office
  // finished for the job's customer (scoreOf), and a job not linked yet has
  // none in step 1. Its card may suggest one already: every expense step 1
  // matched for the job is tagged by hand to one active project
  // (suggested_tagged; jobProject). For a receipt step 1 found no candidate
  // for, that project stands in for the link, on an expense finished for it
  // only (every line tagged to it, a document attached), so the match is
  // only ever noted in_qbo, never put on a card: what the job gets once the
  // card links it. The suggestion is read from step 1's matches and never
  // counts what this step matches (viaSuggestion), so a match here cannot
  // vouch for itself. An expense any receipt could be in step 1, or two
  // receipts could be here (a slip entered twice is one), is no one's; a
  // receipt with two such expenses, or whose last update failed, is left
  // as step 1 left it. Never from a QuickBooks Time suggestion: a jobcode's
  // name is not the books saying so. (FBX Electric 1065, $784 by ACH:
  // QuickBooks 10662, tagged by hand to 1885 Chena Landings with its PDF
  // while the job waited for its link.)
  {
    const candOf = new Set();
    for (const r of eligible) for (const c of r.cands) candOf.add(txnKey(c.p.txnType, c.p.id));
    const byJobPre = new Map();
    for (const r of eligible) byJobPre.set(r.job_id, [...(byJobPre.get(r.job_id) ?? []), r]);
    const suggested = new Map();      // job id → the project step 1's tagged matches suggest
    for (const [jobId, rs] of byJobPre) {
      const job = jobById.get(jobId);
      if (job.link && DIGITS.test(str(job.link.qbo_customer_id))) continue;
      const pr = jobProject(job, rs, projectById, projectRefs);
      if (pr.suggestion?.source === "suggested_tagged" && DIGITS.test(pr.id)) suggested.set(jobId, pr.id);
    }
    const looking = eligible.filter((r) => !r.cands.length && !r.match && !r.failedLink && suggested.has(r.job_id));
    const wants = new Map();          // txn key → the slips here that could be it (a twin counts once)
    for (const r of looking) {
      const customer = suggested.get(r.job_id);
      r.suggestedCands = txns.filter((p) => p.txnType === "Purchase" && !taken.has(txnKey(p.txnType, p.id))
        && !candOf.has(txnKey(p.txnType, p.id)) && finishedFor(p, customer) && admissible(r, p)
        && scoreOf(r, p, customer) >= MIN_SCORE);
      r.slip = firstTwin(r, looking);
      for (const p of r.suggestedCands) wants.set(txnKey(p.txnType, p.id), (wants.get(txnKey(p.txnType, p.id)) ?? new Set()).add(r.slip));
    }
    for (const r of looking) {
      const [p, ...more] = r.suggestedCands;
      // the first twin takes it; step 1c calls the other a duplicate of it
      if (!p || more.length || wants.get(txnKey(p.txnType, p.id)).size !== 1 || r.slip !== r.id
          || taken.has(txnKey(p.txnType, p.id))) continue;
      r.match = p;
      r.viaSuggestion = suggested.get(r.job_id);
      taken.add(txnKey(p.txnType, p.id));
    }
  }

  // ---- 1b. a card receipt paid in two or three charges (v2, splits on) ----
  // Only a receipt no single expense could be, and only charges no receipt
  // matched or could match tonight: a charge one receipt might be is never
  // used to make up another's total. Never a bill (splitSets reads
  // Purchases only).
  if (splitsOn) {
    const candOf = new Set();
    for (const r of eligible) for (const c of r.cands) candOf.add(txnKey(c.p.txnType, c.p.id));
    // a receipt whose last update failed is offered its own charges again,
    // never a new set (a person may have split the charge on purpose)
    const failedParts = (r) => (Array.isArray(r.failedLink?.parts) ? r.failedLink.parts.map((x) => str(x?.qbo_txn_id)).sort(byText) : null);
    const looking = eligible.filter((r) => !r.cands.length && !r.match && (!r.failedLink || failedParts(r)));
    const free = (r) => (p) => {
      const k = txnKey(p.txnType, p.id);
      if (taken.has(k) || candOf.has(k)) return false;
      const holder = claimedBy.get(k);
      return !holder || holder === r.id;
    };
    for (const r of looking) {
      const own = failedParts(r);
      if (own) {
        // its own recorded charges as they are now (a charge written before
        // the failure carries the job's tag or our photo, so it is no longer
        // "untouched"); step 2 sorts out tagged elsewhere, partly tagged,
        // nothing left to do, or a second try for what is missing
        const got = r.failedLink.parts.map((x) => txns.find((p) => p.txnType === "Purchase" && str(p.id) === str(x?.qbo_txn_id)));
        const sum = got.reduce((a, p) => a + (p ? cents(p.total) : 0), 0);
        r.splitSets = got.length >= 2 && got.every((p) => p && (p.credit === true) === (Number(r.amount) < 0) && free(r)(p))
          && sum === cents(r.amount) ? [got] : [];
        continue;
      }
      // every receipt's sets, a young one's too: a receipt younger than
      // SPLIT_MIN_AGE is never given a split (its own closing charge may not
      // have posted), but the charges it could be are no one else's
      r.splitSets = splitSets(r, txns, today, free(r), true);
    }
    // a charge in two receipts' sets is neither's
    const usedBy = new Map();
    for (const r of looking) {
      if (!Array.isArray(r.splitSets)) continue;
      for (const k of new Set(r.splitSets.flat().map((p) => txnKey(p.txnType, p.id)))) usedBy.set(k, (usedBy.get(k) ?? 0) + 1);
    }
    for (const r of looking) {
      const sets = r.splitSets;
      if (sets === null || (Array.isArray(sets) && !sets.length)) continue;
      if (daysFrom(str(r.receipt_date), today) < SPLIT_MIN_AGE) continue;
      const only = Array.isArray(sets) && sets.length === 1 ? sets[0] : null;
      const own = failedParts(r);
      if (own && !(only && only.map((p) => str(p.id)).sort(byText).join(",") === own.join(","))) continue;
      if (only && only.every((p) => usedBy.get(txnKey(p.txnType, p.id)) === 1)) {
        r.split = only;
        for (const p of only) taken.add(txnKey(p.txnType, p.id));
      } else {
        const ids = sets === "capped" ? [] : [...new Set(sets.flat().map((p) => p.id))].sort(byText);
        r.ambiguousSplit = ids;
      }
    }
  }

  // ---- 1c. a receipt entered twice (the same slip on the same job and day) ----
  // The twin that holds an expense stands for the slip: matched tonight (to
  // one expense or a set of charges), on the approval path (queued, done, or
  // failed and tried again tonight), or not looked at again with its row as
  // it was; else the first by id. Every other twin that found no expense of
  // its own is a duplicate of it (step 2 notes it; never a store entry). A
  // twin that is ambiguous holds nothing, as it has no expense either.
  const eligibleById = new Map(eligible.map((r) => [r.id, r]));
  const holds = (s) => {
    const e = eligibleById.get(s.id);
    if (e) return !!(e.match || e.split || e.failedLink);
    return ["queued", "done", "failed", "in_qbo"].includes(str(linkOf.get(s.id)?.state));
  };
  const liveByJob = new Map();
  for (const s of live) liveByJob.set(s.job_id, [...(liveByJob.get(s.job_id) ?? []), s]);
  for (const r of eligible) {
    if (r.match || r.split || r.ambiguous || r.ambiguousSplit) continue;
    const twins = (liveByJob.get(r.job_id) ?? []).filter((s) => s.id !== r.id && str(s.receipt_date) === str(r.receipt_date) && sameSlip(r, s));
    if (!twins.length) continue;
    const first = [r, ...twins].sort((a, b) => Number(holds(b)) - Number(holds(a)) || byText(a.id, b.id))[0];
    if (first.id !== r.id) r.duplicateOf = first.id;
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
    const declinedDrops = new Map();   // declined card id → {card, items dropped because it held them}

    for (const r of rs) {
      stats.receipts += 1;
      const photo = MEDIA.test(str(r.photo_ref)) ? [str(r.photo_ref)] : [];
      const base = { receipt_id: r.id, job_id: jobId, amount: round2(r.amount), receipt_date: r.receipt_date };
      // A receipt whose last update named a transaction is matched again only
      // to that same transaction (or those same charges): anything else (a
      // new expense, a new set, none found) keeps the failed row for a person,
      // since someone may have changed the books on purpose.
      const f = r.failedLink;
      if (f && str(f.qbo_txn_id)) {
        const had = txnsOf(f);
        const now = r.match ? [txnKey(r.match.txnType, r.match.id)] : r.split ? r.split.map((x) => txnKey(x.txnType, x.id)) : [];
        if ([...new Set(now)].sort(byText).join(",") !== had.join(",")) { stats.owned.failed += 1; continue; }
      }
      // An item for a receipt whose last update failed is a second try on a
      // new card (it carries refile), unless the failed row is kept for a
      // person: the failure would come back the same (a KEEP_FAILED refusal,
      // or the very code the last second try died of: one automatic retry
      // per code) and nothing it depends on moved; or the card that held
      // this try was declined, or executed without it, and tonight's item
      // is that one exactly (anything moved makes it another item).
      const pushItem = (it) => {
        const f = r.failedLink;
        if (f) {
          const d = detailOf(f);
          const code = codeOf(d.error);
          const again = isObject(d.refile) && str(d.refile.error) === errorCode(code);
          if ((KEEP_FAILED.has(code) || again) && !movedSince(f, it, project.id, code)) { stats.owned.failed += 1; return; }
          it.refile = refileOf(f, code);
          const card = cardsAnswered.get(lc(d.refiled_proposal_id));
          if (card && ANSWERED.has(str(card.status)) && Array.isArray(card.items)
              && card.items.some((x) => str(x?.receipt_id) === it.receipt_id && canonical(x) === canonical(it))) {
            stats.owned.failed += 1;
            if (str(card.status) === "declined") {
              const k = lc(d.refiled_proposal_id);
              const got = declinedDrops.get(k) ?? { card, items: [] };
              got.items.push(it);
              declinedDrops.set(k, got);
            }
            return;
          }
        }
        items.push(it);
      };

      if (r.ambiguous || r.ambiguousSplit) {
        const reason = r.ambiguous ? "ambiguous" : "ambiguous_split";
        notes.push({ ...base, state: "conflict", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
          qbo_customer_id: null, detail: { reason, candidates: (r.ambiguous ?? r.ambiguousSplit).slice(0, 5) } });
        stats.conflicts += 1;
        continue;
      }

      // Step 1a's match rests on the project step 1 suggested for the job.
      // The project read here is that one (the suggestion never counts step
      // 1a's matches), unless a receipt in parts tried again tonight (step
      // 1b, after 1a) brought back a charge its failed update tagged to
      // another project; then the receipt stays as step 1 left it.
      if (r.viaSuggestion && r.viaSuggestion !== project.id) r.match = null;

      if (r.match || r.split) {
        stats.matched += 1;
        // one expense (or bill), or the charges of a receipt in parts: the
        // first part stands for the receipt where one transaction is shown
        const ms = r.match ? [r.match] : r.split;
        const m = ms[0];
        const linesOf = (x) => (Array.isArray(x.lines) ? x.lines : []);
        const taggedOf = (x) => linesOf(x).filter((l) => str(l.customerId));
        const other = project.id ? ms.flatMap(taggedOf).find((l) => str(l.customerId) !== project.id) : null;
        const partly = ms.find((x) => taggedOf(x).length && taggedOf(x).length < linesOf(x).length);
        const anyTagged = ms.flatMap(taggedOf);
        const txn = { qbo_txn_type: m.txnType, qbo_txn_id: m.id, qbo_sync_token: m.syncToken,
          ...(r.split ? { parts: r.split.map(partOf) } : noParts) };
        const qboDetail = compact({ qbo_doc_number: str(m.docNumber), qbo_account_name: str(m.accountName),
          qbo_total: round2(ms.reduce((a, x) => a + Number(x.total), 0)) });

        if (other) {
          notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: idOrNull(other.customerId),
            detail: { reason: "tagged_other", ...compact({ qbo_customer_name: str(other.customerName) }), ...qboDetail } });
          stats.conflicts += 1;
          continue;
        }
        if (partly) {
          notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: idOrNull(taggedOf(partly)[0].customerId),
            detail: { reason: "partly_tagged", ...qboDetail } });
          stats.conflicts += 1;
          continue;
        }
        // A match the receipt's number does not name is never tagged from
        // here: a store's credit found without the slip's number
        // (creditForReturn), or a check found by its payee's name (byPayee).
        // Untagged, the office tags it by hand; tagged to the job it is
        // noted, or given the receipt's photo
        if ((r.byStore || r.byPayee) && !anyTagged.length) {
          notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: null,
            detail: { reason: r.byStore ? "credit_untagged" : "check_untagged", ...qboDetail } });
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
          notes.push({ ...base, state: "unmatched", ...txn, qbo_customer_id: anyTagged.length ? idOrNull(anyTagged[0].customerId) : null,
            detail: { reason: "needs_job_link", ...qboDetail } });
          stats.unmatched += 1;
          continue;
        }
        // A bill is only read: tagged to the job it is in QuickBooks, with a
        // document or not (the office enters each FNSB bill with its ticket);
        // untagged, the office tags it by hand. Nothing here writes to
        // Accounts Payable, so a bill never goes on a card.
        if (m.txnType === "Bill") {
          if (taggedOf(m).length) {
            notes.push({ ...base, state: "in_qbo", ...txn, qbo_customer_id: project.id, detail: qboDetail });
            stats.in_qbo += 1;
          } else {
            notes.push({ ...base, state: "conflict", ...txn, qbo_customer_id: null, detail: { reason: "bill_untagged", ...qboDetail } });
            stats.conflicts += 1;
          }
          continue;
        }
        const changesOf = (x) => [...(taggedOf(x).length ? [] : ["tag"]), ...(!hasDocument(x) && photo.length ? ["attach"] : [])];
        const changes = ["tag", "attach"].filter((c) => ms.some((x) => changesOf(x).includes(c)));
        if (!changes.length) {
          // a step 1a match says so: in QuickBooks on the project the job's
          // card suggests, which the owner has not approved yet; and a check
          // found by its payee's name, which holds it against the name only
          notes.push({ ...base, state: "in_qbo", ...txn, qbo_customer_id: project.id,
            detail: r.viaSuggestion ? { ...qboDetail, job_link: "suggested_tagged" } : r.byPayee ? { ...qboDetail, by_payee: true } : qboDetail });
          stats.in_qbo += 1;
          continue;
        }
        const it = item(r, m, changes, photo, changes.includes("tag") ? project.ref : null);
        // every charge is listed (the receipt holds them all); one already
        // tagged to the job with a document has no changes and is only checked
        if (r.split) it.parts = r.split.map((x) => ({ ...partOf(x), changes: changesOf(x) }));
        pushItem(it);
        continue;
      }

      // No expense found: why, in the words the office reads. A second
      // receipt for a slip another receipt on the job stands for is a
      // duplicate, whatever it was paid with: not "not in QuickBooks yet",
      // and never entered.
      if (r.duplicateOf) {
        notes.push({ ...base, state: "unmatched", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
          qbo_customer_id: null, detail: { reason: "duplicate", duplicate_of: r.duplicateOf } });
        stats.unmatched += 1;
        continue;
      }
      const pw = lc(r.paid_with);
      const age = daysFrom(r.receipt_date, today);
      let reason = "not_found";
      if (pw === "card") {
        reason = age <= FEED_WAIT_DAYS ? "waiting_feed" : "not_found";
      } else if (pw === "account") {
        // The office books dump tickets as Bills, about a week late: with the
        // bills read, none found means not entered yet; without them (an
        // older qbo-proxy) not finding one says nothing either way
        const dump = lc(r.category) === "dump" || vendorFamily(r.vendor) === "fnsb";
        reason = dump ? (billsRead ? "bill_not_entered" : "bill_not_checked") : "store_not_entered";
        const store = stores.get(vendorFamily(r.vendor) ?? "");
        // the office may have booked the invoice as a bill under another
        // number: never enter one beside a bill from the store at its amount
        const billed = txns.some((b) => b.txnType === "Bill" && cents(b.total) === cents(r.amount)
          && (vendorFamily(b.vendorName) ?? "") === (vendorFamily(r.vendor) ?? "-")
          && Math.abs(daysFrom(str(r.receipt_date), str(b.txnDate))) <= DOC_DATE_SLACK);
        if (store && lc(r.category) !== "dump" && !billed && Number(r.amount) > 0) {
          const doc = digitsOf(r.receipt_no);
          if (!project.id) {
            reason = "needs_job_link";
          } else if (age >= store.min_age_days && doc.length >= 5 && doc.length <= 21) {
            // at least 5 digits, docAgrees' floor: qbo-proxy finds the
            // bookkeeper's own entry by this number's prefix, and a shorter
            // one starts other invoices' numbers too. Never beside an entry
            // QuickBooks may already hold, on any account, or a receipt
            // that may be entering it: a person looks (maybeEntered)
            const seen = maybeEntered(r, store, txns, live);
            if (seen) {
              notes.push({ ...base, state: "conflict", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
                qbo_customer_id: null, detail: { reason: "maybe_entered", ...seen } });
              stats.conflicts += 1;
              continue;
            }
            pushItem(createItem(r, store, doc, photo, project.ref, accountNames.get(store.account_id) ?? ""));
            continue;
          }
        }
      }
      notes.push({ ...base, state: "unmatched", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
        qbo_customer_id: null, detail: { reason } });
      stats.unmatched += 1;
    }

    // A declined card that held a second try beside other lines: when
    // tonight's card would be that same card again (the other lines
    // unchanged too), it is filed unchanged, so the filing door finds the
    // owner's answer and stays quiet. Filing it without the declined try
    // would ask him again about the rest.
    for (const { card, items: dropped } of declinedDrops.values()) {
      if (!items.length) break;
      const all = [...items, ...dropped];
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (same(all.map(canonical).sort(), card.items.map(canonical).sort())) {
        items.splice(0, items.length, ...all);
        break;
      }
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

  // The note door writes one row at a time, and holds one expense to one
  // receipt as it goes (receipt_qbo_links_txn_key): a row that gives up an
  // expense its receipt holds in QuickBooks goes first, so the receipt
  // taking that expense tonight is not written claimed_by_other by the row
  // it replaces
  const gives = (n) => {
    const l = linkOf.get(n.receipt_id);
    if (l?.state !== "in_qbo" || !str(l.qbo_txn_id)) return false;
    const now = n.state === "in_qbo" ? txnsOf(n) : [];
    return txnsOf(l).some((k) => !now.includes(k));
  };
  const giving = new Set(notes.filter(gives).map((n) => n.receipt_id));
  notes.sort((a, b) => Number(giving.has(b.receipt_id)) - Number(giving.has(a.receipt_id)) || byText(a.receipt_id, b.receipt_id));
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
    // a step 1a match leans on this very suggestion: it never counts toward
    // it; nor does a match that does not name the receipt: a return's
    // credit found without the slip's number, or a check found by its
    // payee's name. Their tag is a person's, on a match the books never
    // confirmed, and approving the card would link the job to it
    if (r.viaSuggestion || r.byStore || r.byPayee) continue;
    const ms = r.match ? [r.match] : r.split ?? [];
    if (!ms.length) continue;
    const ids = new Set();
    for (const l of ms.flatMap((m) => m.lines ?? [])) {
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
    qbo_txn_type: "Purchase",       // a bill is only ever noted
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

/** Every transaction a link row names (its id and its parts), as keys. */
function txnsOf(l) {
  const keys = [txnKey(l.qbo_txn_type, l.qbo_txn_id)];
  for (const p of Array.isArray(l.parts) ? l.parts : []) keys.push(txnKey(l.qbo_txn_type, p?.qbo_txn_id));
  return [...new Set(keys)].sort(byText);
}

/** One charge of a receipt in parts, as the card, the note and the link row
    keep it. */
function partOf(p) {
  return { qbo_txn_id: str(p.id), qbo_sync_token: str(p.syncToken), qbo_total: round2(p.total), qbo_date: str(p.txnDate) };
}

/** Did anything a failed update depended on move since? The transaction
    (or every charge) and its SyncToken, the job's project, the receipt's
    total and date, and its photo: as the row recorded it (0025 on), or, on
    a row queued before 0025, always for a refusal about the photo (code). */
function movedSince(f, it, projectId, code) {
  const parts = (x) => (Array.isArray(x) ? x.map((p) => `${str(p?.qbo_txn_id)}:${str(p?.qbo_sync_token)}`).sort().join(",") : "");
  if (str(f.qbo_txn_type || "Purchase") !== str(it.qbo_txn_type)) return true;
  if (str(f.qbo_txn_id) !== str(it.qbo_txn_id) || str(f.qbo_sync_token) !== str(it.qbo_sync_token)) return true;
  if (parts(f.parts) !== parts(it.parts)) return true;
  // the project only matters to a tag (an attach-only card names none)
  if ((it.changes.includes("tag") || it.changes.includes("create")) && str(f.qbo_customer_id) !== str(projectId)) return true;
  if (f.amount == null || Math.abs(Number(f.amount) - Number(it.amount)) > 0.005) return true;
  if (str(f.receipt_date) !== str(it.date)) return true;
  const d = detailOf(f);
  if (Object.hasOwn(d, "read_photo_ref")) return (d.read_photo_ref ?? null) !== (it.read_photo_ref ?? null);
  return PHOTO_CODES.has(code);
}

/** The code a second try is marked with (the executor takes 60 characters). */
const errorCode = (code) => (code || "failed").slice(0, 60);

/** A second try's marker: the failed row's card, its code, and its words
    without the code (whitespace collapsed, at most 120 characters; left out
    when there are none). The executor keeps it on the queued row
    (detail.refile), so the next failure knows it was a second try. */
function refileOf(f, code) {
  const err = str(detailOf(f).error).trim();
  const why = Array.from((code ? err.slice(code.length + 1) : err).replace(/\s+/g, " ").trim()).slice(0, 120).join("");
  return {
    proposal_id: UUID.test(str(f.proposal_id)) ? str(f.proposal_id).toLowerCase() : null,
    error: errorCode(code),
    ...(why ? { why } : {}),
  };
}

/** The sets of 2 to MAX_PARTS card charges one rental receipt may have
    been paid in (charged at checkout, the balance at return). Looked for
    only on an equipment receipt paid by card, with its last four and a
    known store, SPLIT_MIN_AGE days old or more (by then its closing charge
    has posted, so a look-alike set shows as a second set, not the only
    one). Every charge: a Purchase the same sign as the receipt and smaller
    than it, from the receipt's store (vendor family) on the receipt's card
    (its last four on the card account's name or the memo), on one and the
    same account, dated from SPLIT_DAYS before the receipt to 3 days after,
    untouched by anyone (no job tag on any line, no document, no DocNumber
    or the receipt's own number), not contradicted and free (ok). The latest
    is the closing charge, dated a day before the receipt to 3 days after.
    Together they add up to the receipt to the cent. [] when there are none;
    "capped" when the pool is too big to be sure; null when the receipt is
    not one to look for. anyAge: look on a younger receipt too (the matcher
    counts its sets against others', and never splits it). */
export function splitSets(r, txns, today, ok, anyAge = false) {
  const last4 = str(r.card_last4).trim();
  const fam = vendorFamily(r.vendor);
  const abs = cents(r.amount);
  const date = str(r.receipt_date);
  if (lc(r.category) !== "equipment" || lc(r.paid_with) !== "card" || !/^\d{4}$/.test(last4) || !fam || !abs
      || !validDate(date) || (!anyAge && daysFrom(date, today) < SPLIT_MIN_AGE)) return null;
  const credit = Number(r.amount) < 0;
  const lo = addDays(date, -SPLIT_DAYS), hi = addDays(date, 3), closeLo = addDays(date, -1);
  const untouched = (p) => !(p.lines ?? []).some((l) => str(l.customerId)) && !hasDocument(p)
    && (!str(p.docNumber).trim() || docAgrees(r.receipt_no, p.docNumber));
  const pool = txns.filter((p) => p.txnType === "Purchase" && DIGITS.test(str(p.id)) && DIGITS.test(str(p.syncToken))
    && (p.credit === true) === credit && cents(p.total) > 0 && cents(p.total) < abs
    && str(p.txnDate) >= lo && str(p.txnDate) <= hi
    && (vendorFamily(p.vendorName) === fam || vendorFamily(p.note) === fam)
    && ((p.paymentType === "CreditCard" && str(p.accountName).includes(last4)) || str(p.note).includes(last4))
    && untouched(p) && !contradicts(r, p) && ok(p))
    .sort((a, b) => byText(str(a.txnDate), str(b.txnDate)) || byText(str(a.id), str(b.id)));
  if (pool.length > SPLIT_POOL) return "capped";
  const sets = [];
  const walk = (start, chosen, sum) => {
    // sorted by date: the last one chosen is the closing charge
    if (chosen.length >= 2 && sum === abs) {
      if (str(chosen[chosen.length - 1].txnDate) >= closeLo) sets.push([...chosen]);
      return;
    }
    if (chosen.length === MAX_PARTS || sum >= abs) return;
    for (let i = start; i < pool.length; i++) {
      const p = pool[i];
      if (chosen.length && str(p.accountId) !== str(chosen[0].accountId)) continue;
      chosen.push(p);
      walk(i + 1, chosen, sum + cents(p.total));
      chosen.pop();
    }
  };
  walk(0, [], 0);
  return sets;
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

/** A row written back as it is (only the job it is on now): an older
    receipt's, or one matched to a bill on a night the bills were not read.
    v2: a row naming a transaction says its parts, null for one. */
function carry(link, jobId, v2) {
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
    ...(v2 === true && str(link.qbo_txn_id) ? { parts: Array.isArray(link.parts) ? link.parts : null } : {}),
  };
}

/** The card's one sentence. */
function rationaleOf(jobName, items) {
  const on = jobName || "this job";
  const creates = items.filter((i) => i.changes.includes("create")).length;
  const fixes = items.length - creates;
  const again = items.filter((i) => i.refile).length;
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
  if (again) parts.push(again === 1 ? "1 is a second try after the last update failed" : `${again} are second tries after the last update failed`);
  return `${parts.join("; ")}.`;
}

/** Drops empty strings, so a note's detail holds only what it knows. */
function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null && !Number.isNaN(v)));
}
