/* ============================================================
   QuickBooks expenses for job receipts — pure rules (no Deno, no network)
   ------------------------------------------------------------
   Receipts phase 3 (the QuickBooks link). The nightly matcher in the
   worker pairs each receipt with the QuickBooks expense (Purchase) it
   belongs to, or with the two or three card charges it was paid in; once
   the owner approves, the worker's qbo adapter asks this proxy to finish
   them: tag their lines to the job's QuickBooks project and attach the
   receipt photo. Bills (Bill: the dump tickets the office books on
   account) are only READ here (listBills, so the matcher can note them);
   nothing in this module writes a bill, and completePurchase refuses one.
   This module holds every decision that work makes, so it can be
   unit-tested from Node (node --experimental-strip-types
   purchases.test.mjs), the same split as payments.ts. index.ts only does
   the fetching.

   The rules that keep the books safe:
   • Never a second expense for something already in QuickBooks. A
     store invoice the app would enter is looked up by its number on
     that store account first, and our own earlier entry is found the
     same way (plus Intuit's requestid on the create itself).
   • Never overwrite a job tag. An expense tagged to another customer,
     or only partly tagged, is refused; one already tagged to this job
     is adopted as done.
   • A sparse Purchase update REPLACES the Line array, so the update
     sends every line exactly as read and only adds CustomerRef (in the
     line's detail) and ProjectRef (beside it, where QuickBooks keeps
     it). Accounts, classes, amounts and memos are never touched.
   • Never a write to Accounts Payable: a Bill is read, never tagged,
     never given a photo, never entered.
   • Every write is idempotent by itself: a retry adopts its own tag,
     its own "[r:<receipt id>]" attachment and its own entry, so the
     worker's outbox lane needs no lookup of its own.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Q = Record<string, any>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (v == null ? "" : String(v));
const DIGITS = /^[0-9]{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The QuickBooks transactions the matcher reads: a card or bank expense
    (Purchase), or a bill the office entered on account (Bill). Only a
    Purchase is ever written (completePurchase); a Bill is only read. */
export type TxnType = "Purchase" | "Bill";
/** A receipt paid in two or three card charges is finished as that many
    parts of one request (receipts.qbo_link items' parts[]). */
export const MAX_PARTS = 3;

/** The receipt photo gate. The app stores a display-sized JPEG (about
    0.5 MB); 20 MB bounds what one edge invocation will decode. */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
/** listPurchases reads at most this many days of expenses per call. */
export const MAX_SPAN_DAYS = 92;
/** QuickBooks returns at most 1000 rows per query page. */
export const PAGE = 1000;
/** A proven service key is trusted this long before it is checked again. */
export const SERVICE_KEY_TTL_MS = 5 * 60 * 1000;

/* ---------- errors ---------- */

/** One refusal or failure of completePurchase. `permanent` is what the
    worker's outbox lane keys on: a permanent one goes dead at once (HTTP
    409), anything else is retried with backoff (502/503). `code` leads the
    message so the inbox can say why in words. */
export class CompleteError extends Error {
  code: string;
  permanent: boolean;
  status: number;
  constructor(code: string, message: string, permanent: boolean, status?: number) {
    super(message);
    this.code = code;
    this.permanent = permanent;
    this.status = status ?? (permanent ? 409 : 502);
  }
}
export const refuse = (code: string, message: string) => new CompleteError(code, message, true);
export const retryLater = (code: string, message: string, status = 502) => new CompleteError(code, message, false, status);

/** A non-2xx answer from the QuickBooks API. The message is the one
    qboFetch always threw (status plus the first 500 characters), so every
    existing caller reads the same text; `code` is Intuit's Fault code
    (5010 = stale object, 610 = object not found). */
export class QboError extends Error {
  status: number;
  code: string;
  detail: string;
  constructor(status: number, text: string) {
    super(`QBO API ${status}: ${String(text).slice(0, 500)}`);
    const f = parseQboFault(text);
    this.status = status;
    this.code = f.code;
    this.detail = f.detail;
  }
}

/** Intuit's error body: {Fault:{Error:[{Message, Detail, code}], type}}
    (sometimes lower-case `fault`/`error`). Never throws. */
export function parseQboFault(text: string): { code: string; detail: string } {
  try {
    const j = JSON.parse(text);
    const fault = j?.Fault ?? j?.fault;
    const e = (fault?.Error ?? fault?.error ?? [])[0] ?? {};
    return { code: str(e.code), detail: str(e.Detail || e.detail || e.Message || e.message).slice(0, 300) };
  } catch (_) {
    return { code: "", detail: "" };
  }
}

/** Which QuickBooks failures are worth retrying. A 400 is a validation
    fault and will fail the same way again, except a stale object (5010),
    which the caller handles with a fresh read. Auth, throttling and server
    errors are retried; the outbox lane gives up after its max attempts. */
export function classifyQboError(e: QboError): CompleteError {
  const why = e.detail || e.message;
  if (e.code === "5010") return retryLater("stale_object", `QuickBooks says the expense changed while we wrote it: ${why}`);
  if (e.code === "610") return refuse("purchase_missing", `QuickBooks has no such expense any more: ${why}`);
  if (e.status === 429) return retryLater("qbo_throttled", `QuickBooks is throttling: ${why}`, 503);
  if ([401, 403, 408].includes(e.status) || e.status >= 500 || !e.status) return retryLater("qbo_unavailable", `QuickBooks ${e.status}: ${why}`);
  return refuse("qbo_refused", `QuickBooks refused the change (${e.status}${e.code ? " / " + e.code : ""}): ${why}`);
}

/** Anything completePurchase threw, as the reply the worker reads. */
export function toCompleteError(e: unknown): CompleteError {
  if (e instanceof CompleteError) return e;
  if (e instanceof QboError) return classifyQboError(e);
  return retryLater("qbo_unreachable", e instanceof Error ? e.message : String(e));
}

/* ---------- the 'service' caller (the worker) ---------- */

/** The bearer token of a request's Authorization header, or "". */
export function bearerOf(header: string | null | undefined): string {
  return str(header).replace(/^Bearer\s+/i, "").trim();
}

/** Equal secrets, compared without an early exit. */
export function sameKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Service keys proven by the qbo_service_ping round trip, remembered by
    their sha256 (never the key itself) for SERVICE_KEY_TTL_MS, so the
    nightly run does not ping PostgREST on every call. Only positive answers
    are kept: a refused key is asked about again next time. */
export class ProvenKeys {
  ttlMs: number;
  now: () => number;
  until: Map<string, number>;
  constructor(ttlMs = SERVICE_KEY_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.until = new Map();
  }
  has(hash: string): boolean {
    const t = this.until.get(hash) ?? 0;
    if (t > this.now()) return true;
    this.until.delete(hash);
    return false;
  }
  add(hash: string) { this.until.set(hash, this.now() + this.ttlMs); }
}

/* ---------- queries ---------- */

const escapeQ = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const paged = (q: string, start: number) => `${q} startposition ${start} maxresults ${PAGE}`;

export const projectsQuery = (start: number) => paged("select * from Customer where Job = true and Active = true", start);
export const purchasesQuery = (from: string, to: string, start: number) =>
  paged(`select * from Purchase where TxnDate >= '${escapeQ(from)}' and TxnDate <= '${escapeQ(to)}'`, start);
export const attachablesSinceQuery = (since: string, start: number) =>
  paged(`select * from Attachable where MetaData.CreateTime >= '${escapeQ(since)}'`, start);
/** listBills' read (bills are only read, never written). */
export const billsQuery = (from: string, to: string, start: number) =>
  paged(`select * from Bill where TxnDate >= '${escapeQ(from)}' and TxnDate <= '${escapeQ(to)}'`, start);
export const purchaseAttachablesQuery = (purchaseId: string) =>
  `select * from Attachable where AttachableRef.EntityRef.Type = 'Purchase' and AttachableRef.EntityRef.Value = '${escapeQ(purchaseId)}'`;
/** Store invoices: SBS enters the invoice number as DocNumber, Sherwin the
    invoice digits plus a store suffix, so a prefix finds both. The caller
    filters the account and, for a prefix hit, the amount (pickExistingCreate).
    Paged and read whole (pagedRows): the prefix runs across every account
    and year, and the bookkeeper's entry must not fall off QuickBooks'
    default first 100 rows. */
export const docNumberQuery = (doc: string, start: number) => paged(`select * from Purchase where DocNumber LIKE '${escapeQ(doc)}%'`, start);

/** The rows of one entity in a /query answer ([] when QuickBooks sends
    QueryResponse: {} for no rows). */
export function rowsOf(res: Q | null | undefined, entity: string): Q[] {
  const rows = res?.QueryResponse?.[entity];
  return Array.isArray(rows) ? rows : [];
}

/** Every row of a paged query, de-duplicated by Id (a row created while we
    page can shift a later page by one). Stops at a short page, or at
    maxPages as a guard against a server that never says it is done. */
export async function pagedRows(
  run: (q: string) => Promise<Q>, entity: string, build: (start: number) => string, maxPages = 50,
): Promise<Q[]> {
  const out: Q[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const rows = rowsOf(await run(build(page * PAGE + 1)), entity);
    for (const r of rows) {
      const id = str(r?.Id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(r);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/* ---------- listPurchases: window, compaction ---------- */

function isDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
const addDays = (s: string, n: number) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** listPurchases' {from, to}: two real dates, in order, at most
    MAX_SPAN_DAYS apart. */
export function parseWindow(body: Q): { from: string; to: string } | { error: string } {
  const from = str(body?.from).trim(), to = str(body?.to).trim();
  if (!isDate(from) || !isDate(to)) return { error: "from and to must be YYYY-MM-DD dates" };
  if (from > to) return { error: "from is after to" };
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > MAX_SPAN_DAYS) return { error: `at most ${MAX_SPAN_DAYS} days per call (asked for ${days})` };
  return { from, to };
}

/** Attachments are read by creation time, from a week before the window:
    a receipt photo is attached after the expense exists, which is on or
    after its date (bar a rare back-dated entry). */
export const attachableSince = (from: string) => `${addDays(from, -7)}T00:00:00-08:00`;

/** transaction Id → the FileNames of the Attachables linked to it, for one
    transaction type (a Purchase's and a Bill's ids are kept apart). */
export function attachmentsByPurchase(attachables: Q[], type: TxnType = "Purchase"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of attachables) {
    for (const ref of Array.isArray(a?.AttachableRef) ? a.AttachableRef : []) {
      const e = ref?.EntityRef;
      if (str(e?.type) !== type || !str(e?.value)) continue;
      const id = str(e.value);
      out.set(id, [...(out.get(id) ?? []), str(a.FileName)]);
    }
  }
  return out;
}

/** The detail object of a Purchase line (AccountBasedExpenseLineDetail or
    ItemBasedExpenseLineDetail), or null. */
function detailOf(line: Q): Q | null {
  const d = line?.[str(line?.DetailType)];
  return d && typeof d === "object" ? d : null;
}
const TAGGABLE = new Set(["AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail"]);
const taggable = (line: Q) => TAGGABLE.has(str(line?.DetailType)) && !!detailOf(line);

const compactLines = (lines: unknown) => (Array.isArray(lines) ? lines : []).map((l: Q) => {
  const d = detailOf(l) ?? {};
  return {
    id: str(l?.Id),
    amount: round2(Number(l?.Amount) || 0),
    detailType: str(l?.DetailType),
    accountId: str(d.AccountRef?.value),
    accountName: str(d.AccountRef?.name),
    classId: str(d.ClassRef?.value),
    customerId: str(d.CustomerRef?.value),
    customerName: str(d.CustomerRef?.name),
    projectRef: str(l?.ProjectRef?.value),
  };
});

/** One QuickBooks expense, cut down to what the matcher reads. Missing
    references are "" (never null) so "untagged" is one test. ProjectRef is
    read where QuickBooks keeps it: on the line, beside the detail. */
export function compactPurchase(p: Q, files: string[] = []): Q {
  const acct = p?.AccountRef ?? p?.CreditCardAccountRef ?? {};
  return {
    txnType: "Purchase",
    id: str(p?.Id),
    syncToken: str(p?.SyncToken),
    txnDate: str(p?.TxnDate),
    total: round2(Number(p?.TotalAmt) || 0),
    credit: p?.Credit === true,
    paymentType: str(p?.PaymentType),
    accountId: str(acct.value),
    accountName: str(acct.name),
    vendorId: str(p?.EntityRef?.value),
    vendorName: str(p?.EntityRef?.name),
    docNumber: str(p?.DocNumber),
    note: str(p?.PrivateNote),
    lines: compactLines(p?.Line),
    attachments: files,
    hasAttachment: files.length > 0,
  };
}

/** One QuickBooks bill in the same shape, so the matcher reads both the
    same way: the account is Accounts Payable (APAccountRef), the vendor is
    VendorRef, there is no payment type, and a bill is never a credit (a
    vendor credit is another entity, not read). The FNSB dump tickets are
    bills: DocNumber is the ticket number, one line, which the office tags
    to the job when it enters the bill. Only read: the matcher notes a
    bill, and nothing here ever writes one. */
export function compactBill(b: Q, files: string[] = []): Q {
  return {
    txnType: "Bill",
    id: str(b?.Id),
    syncToken: str(b?.SyncToken),
    txnDate: str(b?.TxnDate),
    total: round2(Number(b?.TotalAmt) || 0),
    credit: false,
    paymentType: "",
    accountId: str(b?.APAccountRef?.value),
    accountName: str(b?.APAccountRef?.name),
    vendorId: str(b?.VendorRef?.value),
    vendorName: str(b?.VendorRef?.name),
    docNumber: str(b?.DocNumber),
    note: str(b?.PrivateNote),
    lines: compactLines(b?.Line),
    attachments: files,
    hasAttachment: files.length > 0,
  };
}

/** One QuickBooks project (a Customer with Job = true) for the picker and
    the matcher's QB Time suggestion. */
export function compactProject(c: Q): Q {
  return {
    id: str(c?.Id),
    name: str(c?.DisplayName),
    fqn: str(c?.FullyQualifiedName),
    parentId: str(c?.ParentRef?.value),
    isProject: c?.IsProject === true,
  };
}

/* ---------- completePurchase: the request ---------- */

export type Create = {
  account_id: string; vendor_id: string; payment_type: string; credit: boolean; doc_number: string;
  expense_account_id: string; class_id: string; txn_date: string; amount_abs: number; memo: string;
};
export type Part = { txnId: string; expectSyncToken: string; expectTotal: number | null; changes: string[] };
export type CompleteRequest = {
  receiptId: string; jobId: string; proposalId: string; txnId: string;
  expectSyncToken: string; expectTotal: number | null; changes: string[];
  customerId: string; projectRef: string; photoRefs: string[]; fileBase: string; create: Create | null;
  // a receipt paid in two or three card charges: every charge, in order
  // (txnId, expectSyncToken and expectTotal above are then empty)
  parts: Part[] | null;
};

export const MARKER_RE = /^media:([0-9a-f]{64}):(\d+)$/;
const RECEIPT_ID = /^[\w.:~-]{1,64}$/;   // a return slip is "<receipt id>~ret"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGES = ["tag", "attach", "create"];

/** A list of changes: non-empty, each one of `allowed`, no repeats. */
const changesOf = (v: unknown, allowed: string[]): string[] | null => {
  const c = Array.isArray(v) ? v.map(str) : [];
  return c.length && c.every((x) => allowed.includes(x)) && new Set(c).size === c.length ? c : null;
};

/** The outbox payload (receipts.qbo_link@1), checked again here: the proxy
    is the last stop before QuickBooks, and a malformed row would fail the
    same way on every retry, so it is a permanent refusal. Only an expense
    (Purchase) is ever written: a bill names Accounts Payable, which this
    proxy only reads, so a Bill is refused before anything is fetched. */
export function parseCompleteRequest(b: Q): CompleteRequest {
  const bad = (m: string) => refuse("bad_request", m);
  const receiptId = str(b?.receipt_id);
  if (!RECEIPT_ID.test(receiptId)) throw bad("receipt_id is missing or not a receipt id");
  const proposalId = str(b?.proposal_id);
  if (!UUID.test(proposalId)) throw bad("proposal_id must be a uuid");
  if (str(b?.qbo_txn_type) !== "Purchase") {
    throw bad("qbo_txn_type must be 'Purchase': only an expense is written; a bill is only read, never tagged or attached to");
  }
  const changes = changesOf(b?.changes, CHANGES);
  if (!changes) throw bad("changes must be a non-empty list of tag, attach, create");
  const creating = changes.includes("create");

  const txnId = str(b?.qbo_txn_id);
  const expectSyncToken = str(b?.expect_sync_token);
  // the expense's TotalAmt at filing; the executor lets it be null
  const expectTotal = b?.expect_total == null ? null : Number(b.expect_total);

  // two or three card charges for one receipt: each is checked like a
  // one-expense item, and the top level names none of them (a qbo-proxy
  // older than parts refuses such a payload instead of tagging one charge)
  let parts: Part[] | null = null;
  if (b?.parts != null) {
    if (!Array.isArray(b.parts) || b.parts.length < 2 || b.parts.length > MAX_PARTS)
      throw bad(`parts must list 2 to ${MAX_PARTS} charges`);
    if (creating) throw bad("only card charges already in QuickBooks (never entered) come in parts");
    if (txnId || expectSyncToken) throw bad("a receipt in parts names its charges in parts, not in qbo_txn_id");
    parts = b.parts.map((x: Q, i: number) => {
      const id = str(x?.qbo_txn_id), tok = str(x?.expect_sync_token);
      const tot = x?.expect_total == null ? null : Number(x.expect_total);
      if (!DIGITS.test(id)) throw bad(`part ${i + 1} qbo_txn_id must be a QuickBooks id`);
      if (!DIGITS.test(tok)) throw bad(`part ${i + 1} expect_sync_token must be a SyncToken`);
      if (tot != null && !Number.isFinite(tot)) throw bad(`part ${i + 1} expect_total must be a number`);
      // none: a charge already tagged to the job with a document, only checked
      const ch = Array.isArray(x?.changes) && !x.changes.length ? [] : changesOf(x?.changes, ["tag", "attach"]);
      if (!ch || ch.some((c) => !changes.includes(c))) throw bad(`part ${i + 1} changes must be tag and/or attach, from the item's changes`);
      return { txnId: id, expectSyncToken: tok, expectTotal: tot == null ? null : round2(tot), changes: ch };
    });
    if (new Set(parts.map((x) => x.txnId)).size !== parts.length) throw bad("parts name the same charge twice");
    if (changes.some((c) => !parts!.some((x) => x.changes.includes(c)))) throw bad("a change no part asks for");
  } else if (creating) {
    if (txnId) throw bad("a create item carries no qbo_txn_id");
  } else {
    if (!DIGITS.test(txnId)) throw bad("qbo_txn_id must be a QuickBooks id");
    if (!DIGITS.test(expectSyncToken)) throw bad("expect_sync_token must be a SyncToken");
    if (expectTotal != null && !Number.isFinite(expectTotal)) throw bad("expect_total must be a number");
  }

  const customerId = str(b?.customer_id);
  if (customerId && !DIGITS.test(customerId)) throw bad("customer_id must be a QuickBooks id");
  if ((changes.includes("tag") || creating) && !customerId) throw bad("tagging needs customer_id");
  // the job's link is checked again before the tag (completePurchase)
  if ((changes.includes("tag") || creating) && !UUID.test(str(b?.job_id))) throw bad("tagging needs the job_id");
  const projectRef = str(b?.project_ref);
  if (projectRef && !DIGITS.test(projectRef)) throw bad("project_ref must be a QuickBooks id");

  const photoRefs = Array.isArray(b?.photo_refs) ? b.photo_refs.map(str) : [];
  if (photoRefs.length > 4 || photoRefs.some((r: string) => !MARKER_RE.test(r))) throw bad("photo_refs must be up to 4 media markers");
  if (changes.includes("attach") && !photoRefs.length) throw bad("attach needs a photo");

  let create: Create | null = null;
  if (creating) {
    const c = b?.create ?? {};
    create = {
      account_id: str(c.account_id), vendor_id: str(c.vendor_id), payment_type: str(c.payment_type) || "CreditCard",
      credit: c.credit === true, doc_number: str(c.doc_number), expense_account_id: str(c.expense_account_id),
      class_id: str(c.class_id), txn_date: str(c.txn_date), amount_abs: round2(Number(c.amount_abs)),
      memo: str(c.memo).slice(0, 3000),
    };
    if (![create.account_id, create.vendor_id, create.expense_account_id].every((v) => DIGITS.test(v)))
      throw bad("create needs account_id, vendor_id and expense_account_id");
    if (create.class_id && !DIGITS.test(create.class_id)) throw bad("create.class_id must be a QuickBooks id");
    if (create.payment_type !== "CreditCard") throw bad("create.payment_type must be CreditCard");
    if (typeof c.credit !== "boolean") throw bad("create.credit must be true or false");
    // at least 5 (the matcher's floor): the entry is looked up by this
    // number's prefix, and a shorter one starts other invoices' numbers too
    if (!/^[0-9]{5,21}$/.test(create.doc_number)) throw bad("create.doc_number must be the receipt's digits, 5 to 21 of them");
    if (create.txn_date && !isDate(create.txn_date)) throw bad("create.txn_date must be a YYYY-MM-DD date");
    if (!(create.amount_abs > 0)) throw bad("create.amount_abs must be above zero");
  }

  return {
    receiptId, jobId: str(b?.job_id), proposalId, txnId, expectSyncToken,
    expectTotal: expectTotal == null ? null : round2(expectTotal),
    changes, customerId, projectRef, photoRefs, fileBase: str(b?.file_base), create, parts,
  };
}

/* ---------- completePurchase: the tag ---------- */

export type TagPlan =
  | { action: "tag" | "adopt" | "not_needed" }
  | { action: "refuse"; code: string; message: string; customerId?: string; customerName?: string };

/** What to do about the job tag on a freshly read expense.
    - Any line tagged to a different customer: refuse 'tagged_other' (the
      tag is someone's decision; we never overwrite it).
    - Every line already ours: adopt (done before, by us or by hand).
    - Some ours, some untagged: refuse 'partly_tagged'.
    - All untagged: tag, when the item asked for it.
    With no customer (an attach-only item on a job not yet linked) the tag
    is none of our business. */
export function tagPlan(p: Q, customerId: string, wantTag: boolean): TagPlan {
  if (!customerId) return { action: "not_needed" };
  const lines: Q[] = Array.isArray(p?.Line) ? p.Line : [];
  const id = str(p?.Id);
  const refs = lines.filter(taggable).map((l) => detailOf(l)?.CustomerRef);
  const other = refs.find((r) => str(r?.value) && str(r?.value) !== customerId);
  if (other) {
    const name = str(other.name) || `customer ${str(other.value)}`;
    return { action: "refuse", code: "tagged_other", message: `expense ${id} is already tagged to ${name} in QuickBooks`,
      customerId: str(other.value), customerName: str(other.name) };
  }
  const ours = refs.filter((r) => str(r?.value) === customerId).length;
  if (!refs.length) {
    return wantTag ? { action: "refuse", code: "untaggable", message: `expense ${id} has no expense lines to tag` } : { action: "not_needed" };
  }
  if (ours === refs.length) return { action: wantTag ? "adopt" : "not_needed" };
  if (ours > 0) return { action: "refuse", code: "partly_tagged", message: `expense ${id} is tagged to this job on only ${ours} of ${refs.length} lines` };
  if (!wantTag) return { action: "not_needed" };
  if (refs.length !== lines.length) return { action: "refuse", code: "untaggable_line", message: `expense ${id} has a line QuickBooks cannot tag to a job` };
  return { action: "tag" };
}

/** The approval was for the expense as it stood when the card was filed.
    A new SyncToken alone is fine (someone attached a document or fixed a
    memo; we write from the fresh read anyway), but a new SyncToken AND a
    different total means it is no longer the expense the owner approved.
    With no total on file, a new SyncToken alone has to count. */
export function staleCheck(p: Q, expectSyncToken: string, expectTotal: number | null): CompleteError | null {
  if (!expectSyncToken) return null;                 // an entry we never saw before (store entry adopted)
  if (str(p?.SyncToken) === expectSyncToken) return null;
  const total = round2(Number(p?.TotalAmt) || 0);
  if (expectTotal == null) {
    return refuse("changed_in_qbo", `expense ${str(p?.Id)} changed in QuickBooks since the card was filed`);
  }
  if (Math.abs(total - expectTotal) > 0.005) {
    return refuse("changed_in_qbo",
      `expense ${str(p?.Id)} changed in QuickBooks since the card was filed (total now $${total.toFixed(2)}, was $${round2(expectTotal).toFixed(2)})`);
  }
  return null;
}

/** Every line as read, with the job tag added: CustomerRef inside the
    detail and, when known, ProjectRef on the line (where QuickBooks reads
    it). BillableStatus stays as read, or NotBillable when it had none.
    Nothing else changes and the input is not mutated. */
export function tagLines(lines: Q[], customerId: string, projectRef: string): Q[] {
  return lines.map((line) => {
    const out: Q = structuredClone(line);
    const d = detailOf(out);
    if (!d || !TAGGABLE.has(str(out.DetailType))) return out;
    d.CustomerRef = { value: customerId };
    if (!d.BillableStatus) d.BillableStatus = "NotBillable";
    if (projectRef) out.ProjectRef = { value: projectRef };
    return out;
  });
}

/** The sparse update that tags an expense: Id, the CURRENT SyncToken,
    PaymentType copied from the read (QuickBooks requires it on a sparse
    Purchase update), and the complete Line array (a sparse update replaces
    Line, so a line left out would be deleted). */
export function tagUpdateBody(p: Q, customerId: string, projectRef: string): Q {
  return {
    Id: str(p.Id),
    SyncToken: str(p.SyncToken),
    sparse: true,
    PaymentType: p.PaymentType,
    Line: tagLines(Array.isArray(p.Line) ? p.Line : [], customerId, projectRef),
  };
}

/* ---------- completePurchase: the store entry ('create') ---------- */

/** The marker that makes our own work findable again: in the PrivateNote of
    an expense we entered and in the FileName of a photo we attached. */
export const receiptMarker = (receiptId: string) => `[r:${receiptId}]`;

/** Intuit's requestid for the create: the same receipt on the same approval
    always sends the same id, so a retried POST is answered with the entity
    the first one made. UUID-shaped from a sha256 (Intuit's examples are
    UUIDs, and the shape stays inside any length limit). */
export async function requestIdFor(receiptId: string, proposalId: string): Promise<string> {
  const h = await sha256Hex(`receipts.qbo_link:${proposalId}:${receiptId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The expense the app enters for a store invoice nobody has entered yet:
    one line, tagged to the job, NotBillable, with the receipt marker in the
    memo. */
export function createBody(r: CompleteRequest): Q {
  const c = r.create!;
  const detail: Q = {
    AccountRef: { value: c.expense_account_id },
    CustomerRef: { value: r.customerId },
    BillableStatus: "NotBillable",
  };
  if (c.class_id) detail.ClassRef = { value: c.class_id };
  const line: Q = {
    Amount: c.amount_abs,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: detail,
  };
  if (c.memo) line.Description = c.memo;
  if (r.projectRef) line.ProjectRef = { value: r.projectRef };
  return {
    PaymentType: c.payment_type,
    AccountRef: { value: c.account_id },
    EntityRef: { value: c.vendor_id, type: "Vendor" },
    DocNumber: c.doc_number,
    ...(c.txn_date ? { TxnDate: c.txn_date } : {}),     // none: QuickBooks dates it today
    Credit: c.credit,
    PrivateNote: `${c.memo} ${receiptMarker(r.receiptId)}`.trim(),
    Line: [line],
  };
}

/** Is this store invoice already in QuickBooks (entered by hand, or by an
    earlier try of ours)? Same store account and direction (a purchase is
    never a return's entry, nor a return a purchase's), and either the same
    number, or a number that starts with ours (Sherwin's suffix) at the same
    amount. Our own marker wins a tie. */
export function pickExistingCreate(purchases: Q[], r: CompleteRequest): Q | null {
  const c = r.create!;
  // the same direction always: a return slip often prints the original
  // invoice's number, and the purchase is never the return's entry
  const onAccount = purchases.filter((p) => str(p?.AccountRef?.value) === c.account_id && (p?.Credit === true) === c.credit);
  const exact = onAccount.filter((p) => str(p?.DocNumber) === c.doc_number);
  const prefix = onAccount.filter((p) =>
    str(p?.DocNumber).startsWith(c.doc_number) &&
    Math.abs(round2(Number(p?.TotalAmt) || 0) - c.amount_abs) <= 0.005);
  const pool = exact.length ? exact : prefix;
  if (!pool.length) return null;
  const mark = receiptMarker(r.receiptId);
  return pool.find((p) => str(p?.PrivateNote).includes(mark)) ??
    [...pool].sort((a, b) => Number(a.Id) - Number(b.Id))[0];
}

/* ---------- completePurchase: the photo ---------- */

export type AttachPlan =
  | { action: "upload"; pages: number[]; ours: number }
  | { action: "adopt"; ours: number }
  | { action: "skip"; reason: "already_attached" };

/** What to attach, given the documents already linked to the expense.
    Ours (FileName carries "[r:<receipt id>]"): upload only the pages still
    missing. Someone else's document and none of ours: leave it alone (the
    bookkeeper attached the vendor's copy; not an error). Nothing: upload
    every page. */
export function attachPlan(attachables: Q[], receiptId: string, pageCount: number): AttachPlan {
  const mark = receiptMarker(receiptId);
  const names = attachables.map((a) => str(a?.FileName));
  const ours = names.filter((n) => n.includes(mark));
  if (!ours.length) {
    if (names.length) return { action: "skip", reason: "already_attached" };
    return { action: "upload", pages: Array.from({ length: pageCount }, (_, i) => i + 1), ours: 0 };
  }
  const done = new Set<number>();
  for (const n of ours) {
    const m = / p(\d+) \[r:/.exec(n);
    if (m) done.add(Number(m[1]));
  }
  // one of ours with no page number (renamed in QuickBooks): count it as page 1
  if (!done.size) done.add(1);
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  return pages.length ? { action: "upload", pages, ours: ours.length } : { action: "adopt", ours: ours.length };
}

/** The sha256 a media marker names (the field-media object key). */
export function mediaHash(ref: string): string {
  const m = MARKER_RE.exec(str(ref));
  if (!m) throw refuse("bad_request", "not a media marker");
  return m[1];
}

/** Storage answers a missing object with 404, or with 400 and a not-found
    body (the field app's downloadMedia treats both as gone). */
export function storageMissing(status: number, text: string): boolean {
  if (status === 404) return true;
  return status === 400 && /not.?found/i.test(text);
}

const MAGIC: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
};

/** A field-media object is the photo as a data URL string
    ("data:image/jpeg;base64,..."). Returns the bytes and their type, or
    refuses permanently: not a base64 data URL, a type QuickBooks should not
    get from us (only JPEG, PNG, PDF), bytes that are not that type, or more
    than maxBytes. The length is checked before decoding. */
export function parseDataUrl(text: string, maxBytes = MAX_PHOTO_BYTES): { contentType: string; bytes: Uint8Array } {
  const s = str(text);
  const comma = s.indexOf(",");
  const head = comma > 0 ? s.slice(0, comma) : "";
  const m = /^data:([\w.+-]+\/[\w.+-]+)((?:;[^;,]*)*)$/i.exec(head);
  if (!m || !/;base64$/i.test(m[2])) throw refuse("photo_unreadable", "the stored photo is not a base64 data URL");
  let contentType = m[1].toLowerCase();
  if (contentType === "image/jpg") contentType = "image/jpeg";
  if (!PHOTO_TYPES[contentType]) throw refuse("photo_type", `the stored photo is ${contentType}; only JPEG, PNG or PDF go to QuickBooks`);
  const b64 = s.slice(comma + 1).replace(/\s+/g, "");
  if (Math.floor((b64.length * 3) / 4) - 2 > maxBytes) throw refuse("photo_too_big", `the stored photo is over ${Math.round(maxBytes / 1048576)} MB`);
  let bin: string;
  try { bin = atob(b64); } catch (_) { throw refuse("photo_unreadable", "the stored photo is not valid base64"); }
  if (bin.length > maxBytes) throw refuse("photo_too_big", `the stored photo is over ${Math.round(maxBytes / 1048576)} MB`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!MAGIC[contentType].every((b, i) => bytes[i] === b)) throw refuse("photo_unreadable", `the stored photo is not really ${contentType}`);
  return { contentType, bytes };
}

/** "<file_base> p<n> [r:<receipt id>].<ext>", with characters a file name
    should not carry taken out of the base. */
export function photoFileName(fileBase: string, page: number, receiptId: string, contentType: string): string {
  const base = str(fileBase).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Receipt";
  return `${base} p${page} ${receiptMarker(receiptId)}.${PHOTO_TYPES[contentType] ?? "jpg"}`;
}

/** The file_metadata_01 part: link the new Attachable to the expense. */
export function attachMetadata(purchaseId: string, fileName: string, contentType: string): Q {
  return {
    AttachableRef: [{ EntityRef: { type: "Purchase", value: purchaseId }, IncludeOnSend: false }],
    FileName: fileName,
    ContentType: contentType,
  };
}

/** The multipart/form-data body for POST /upload: the JSON metadata part,
    then the file bytes as they are (no base64). Built by hand so the parts
    are exactly the two QuickBooks reads, and so a test can check the bytes. */
export function multipartBody(boundary: string, metadata: Q, fileName: string, contentType: string, bytes: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_metadata_01"\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_content_01"; filename="${fileName.replace(/["\r\n]/g, "")}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/** The new Attachable from an /upload answer. A Fault inside a 200 is a
    validation refusal; an answer with neither is retried (the next try
    finds the upload by its marker if it did land). */
export function uploadedAttachable(res: Q): { id: string; fileName: string } {
  const r = Array.isArray(res?.AttachableResponse) ? res.AttachableResponse[0] : null;
  const a = r?.Attachable;
  if (a?.Id) return { id: str(a.Id), fileName: str(a.FileName) };
  const e = r?.Fault?.Error?.[0];
  if (e) throw refuse("upload_refused", `QuickBooks refused the photo: ${str(e.Detail || e.Message).slice(0, 300)}`);
  throw retryLater("upload_unclear", "QuickBooks did not confirm the photo upload");
}

/* ---------- completePurchase: the whole step ---------- */

/** What completePurchase needs from the outside world (index.ts wires these
    to QuickBooks and storage; the tests wire them to a fake). */
export type CompleteIO = {
  query: (q: string) => Promise<Q>;                                   // GET /query
  getPurchase: (id: string) => Promise<Q>;                            // GET /purchase/{id} → the Purchase
  postPurchase: (body: Q, requestId?: string) => Promise<Q>;          // POST /purchase → the Purchase
  photo: (hash: string) => Promise<string | null>;                    // field-media object text; null = gone
  upload: (body: Uint8Array, contentType: string) => Promise<Q>;      // POST /upload (multipart)
  jobLink: (jobId: string) => Promise<{ qbo_customer_id: string } | null>;   // job_qbo_links, now
  boundary?: () => string;
};

export type Fault = { code: string; message: string };
export type PartReply = {
  purchaseId: string; syncToken: string;
  // refused: QuickBooks refused this charge after an earlier charge of the
  // same receipt was written; nothing was written to this one, and
  // syncToken is the one it was read with
  tagged: "done" | "adopted" | "not_needed" | "refused";
  attached: number; already_attached: boolean;
  attach_error?: Fault;
  error?: Fault;                                                      // why a refused charge was refused
};
export type CompleteReply = {
  ok: true; purchaseId: string; syncToken: string;
  tagged: "done" | "adopted" | "not_needed"; attached: number; already_attached: boolean;
  adopted: { create: boolean; tag: boolean; attach: number };
  // QuickBooks refused the photo after the tag or the entry was in: the
  // write stands (the row is sent and records the expense), the photo did not
  attach_error?: Fault;
  // a receipt paid in parts: how each charge went, in order (purchaseId and
  // syncToken above are the first charge's)
  parts?: PartReply[];
  // a receipt paid in parts whose later charge QuickBooks refused after an
  // earlier charge was written: the first such charge, as
  // "part <k> of <n> (expense <id>): <why>". The written charges stand, so
  // the answer is ok (the row is sent) and the receipt records the refusal.
  part_error?: Fault;
};

async function readPurchase(io: CompleteIO, id: string): Promise<Q> {
  try {
    const p = await io.getPurchase(id);
    if (!p?.Id) throw refuse("purchase_missing", `QuickBooks has no expense ${id}`);
    return p;
  } catch (e) {
    if (e instanceof QboError && e.code === "610") throw refuse("purchase_missing", `QuickBooks has no expense ${id} any more`);
    throw e;
  }
}

/** Read, decide, tag. A stale-object answer (someone saved the expense
    between our read and our write) gets one fresh read and one more try;
    a second one is retried later by the outbox lane. beforeWrite runs once
    the tag is decided, before it is written (the photo gate). */
async function tagStep(io: CompleteIO, id: string, r: CompleteRequest, wantTag: boolean, expectSyncToken: string,
  beforeWrite: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    const p = await readPurchase(io, id);
    const plan = tagPlan(p, r.customerId, wantTag);
    if (plan.action === "refuse") throw refuse(plan.code, plan.message);
    if (plan.action !== "tag") return { purchase: p, tagged: plan.action === "adopt" ? "adopted" as const : "not_needed" as const };
    const stale = staleCheck(p, expectSyncToken, r.expectTotal);
    if (stale) throw stale;
    await beforeWrite();
    try {
      const out = await io.postPurchase(tagUpdateBody(p, r.customerId, r.projectRef));
      return { purchase: out?.Id ? out : p, tagged: "done" as const };
    } catch (e) {
      if (!(e instanceof QboError && e.code === "5010")) throw e;
      if (attempt >= 1) throw retryLater("stale_object", `expense ${id} kept changing in QuickBooks while we tagged it`);
    }
  }
}

type Files = Map<number, { contentType: string; bytes: Uint8Array }>;

/** One approved receipt, end to end: (1) enter the store invoice when the
    item says 'create' and it is not in QuickBooks yet, (2) tag the expense
    to the job, (3) attach the photo. Each step adopts its own earlier work,
    so a retry after a lost answer finishes instead of doubling. A receipt
    paid in two or three card charges does (2) and (3) for each charge in
    turn, with the same photo and marker on each. Only an expense is ever
    written: a bill is refused (bad_request) before anything is read.

    The job's project is checked first: the card was approved for the
    project in the payload, and an office relink or unlink since (while the
    row waited on the worker, or on QuickBooks) refuses it before anything
    is read or written. Every photo page this call will upload is read and
    checked (the photo gate) before the first write, so a photo that is
    gone, or not a JPEG, PNG or PDF, refuses the whole change with nothing
    written. QuickBooks can still refuse an upload after the tag or the
    entry went in: that answers ok, with attach_error, since the write
    stands and the receipt must record it. In the same way, a charge of a
    receipt in parts that QuickBooks refuses after an earlier charge was
    written answers ok, with part_error (completeParts). */
export async function completePurchase(raw: Q, io: CompleteIO): Promise<CompleteReply> {
  const r = parseCompleteRequest(raw);
  const wantTag = r.changes.includes("tag") || r.changes.includes("create");

  // 0. the job is still linked to the project this approval tags to
  if (wantTag) {
    const link = await io.jobLink(r.jobId);
    const now = str(link?.qbo_customer_id);
    if (now !== r.customerId) {
      throw refuse("relinked", `job ${r.jobId} is ${now ? `now linked to QuickBooks project ${now}` : "no longer linked to a QuickBooks project"}` +
        ` (this approval named ${r.customerId}); nothing was written`);
    }
  }

  const files: Files = new Map();
  return r.parts ? await completeParts(r, r.parts, io, files) : await completeOne(r, io, files);
}

/** A receipt paid in parts (the job's link already checked).

    Before the first charge is written, every charge is read and its tag
    decided (one tagged to another job, partly tagged, or changed since the
    card refuses the whole receipt with nothing written), and the photo is
    read and checked once (the gate). Then each charge is finished in order.
    A retry starts again from the first charge and adopts what is done.

    A charge that fails while the charges are being finished:
    - worth retrying (QuickBooks down or throttling, a stale object twice):
      the whole receipt throws, so the outbox retries; the retry adopts
      what this try wrote.
    - refused for good, with nothing of this receipt's in the books yet (no
      earlier charge tagged, adopted, given our photo, or carrying a
      document): the whole receipt is refused, named by its charge, as the
      pre-check would have.
    - refused for good after an earlier charge was written: refusing the
      receipt would leave that write in the books with the receipt marked
      failed, so the charge is recorded as tagged "refused" (with the
      SyncToken it was read with and the error), the remaining charges are
      still finished, and the answer is ok with part_error naming the first
      refused charge. The totals (tagged, attached) leave refused charges
      out. */
async function completeParts(r: CompleteRequest, parts: Part[], io: CompleteIO, files: Files): Promise<CompleteReply> {
  const total = parts.length;
  const one = (part: Part): CompleteRequest => ({ ...r, txnId: part.txnId, expectSyncToken: part.expectSyncToken,
    expectTotal: part.expectTotal, changes: part.changes, create: null, parts: null });
  const label = (i: number, part: Part, message: string) => `part ${i + 1} of ${total} (expense ${part.txnId}): ${message}`;
  const named = (i: number, part: Part, e: unknown) => {
    const f = toCompleteError(e);
    return new CompleteError(f.code, label(i, part, f.message), f.permanent, f.status);
  };

  // the pre-check: nothing is written unless every charge can be
  const readTokens = new Map<string, string>();
  for (const [i, part] of parts.entries()) {
    try {
      const p = await readPurchase(io, part.txnId);
      readTokens.set(part.txnId, str(p.SyncToken));
      const plan = tagPlan(p, r.customerId, part.changes.includes("tag"));
      if (plan.action === "refuse") throw refuse(plan.code, plan.message);
      if (plan.action === "tag") {
        const stale = staleCheck(p, part.expectSyncToken, part.expectTotal);
        if (stale) throw stale;
      }
    } catch (e) { throw named(i, part, e); }
  }
  // the photo gate, as completeOne's: only the pages some charge will upload
  // (a charge that already carries a document, the bookkeeper's or ours,
  // needs none), so a photo gone from storage refuses only a receipt that
  // still needs it
  const pages = new Set<number>();
  for (const [i, part] of parts.entries()) {
    if (!part.changes.includes("attach")) continue;
    try {
      const plan = attachPlan(rowsOf(await io.query(purchaseAttachablesQuery(part.txnId)), "Attachable"), r.receiptId, r.photoRefs.length);
      if (plan.action === "upload") for (const n of plan.pages) pages.add(n);
    } catch (e) { throw named(i, part, e); }
  }
  await fetchPhotoPages(r, io, files, [...pages].sort((a, b) => a - b));

  const replies: PartReply[] = [];
  const adopted = { create: false, tag: false, attach: 0 };
  // something of this receipt's is in the books on an earlier charge: its
  // tag (written or adopted), a photo of ours (uploaded now or by an
  // earlier try), or a document already there
  let booksChanged = false;
  let partError: Fault | undefined;
  for (const [i, part] of parts.entries()) {
    const read = readTokens.get(part.txnId) || part.expectSyncToken;
    if (!part.changes.length) {
      replies.push({ purchaseId: part.txnId, syncToken: read, tagged: "not_needed", attached: 0, already_attached: false });
      continue;
    }
    let out: CompleteReply;
    try {
      // with an earlier charge written, a photo QuickBooks refuses here is
      // reported with that write (attach_error), not as nothing done
      out = await completeOne(one(part), io, files, booksChanged);
    } catch (e) {
      const f = toCompleteError(e);
      if (!f.permanent || !booksChanged) throw named(i, part, e);
      const error = { code: f.code, message: f.message.slice(0, 300) };
      replies.push({ purchaseId: part.txnId, syncToken: read, tagged: "refused", attached: 0, already_attached: false, error });
      partError ??= { code: f.code, message: label(i, part, f.message).slice(0, 300) };
      continue;
    }
    adopted.tag ||= out.adopted.tag;
    adopted.attach += out.adopted.attach;
    replies.push({ purchaseId: out.purchaseId, syncToken: out.syncToken, tagged: out.tagged, attached: out.attached,
      already_attached: out.already_attached, ...(out.attach_error ? { attach_error: out.attach_error } : {}) });
    booksChanged ||= out.tagged !== "not_needed" || out.attached > 0 || out.already_attached || out.adopted.attach > 0;
  }

  // replies[0] is never a refused charge: the first charge comes before any
  // write, and a refusal with nothing written threw above
  const tagged = replies.some((x) => x.tagged === "done") ? "done" as const
    : replies.some((x) => x.tagged === "adopted") ? "adopted" as const : "not_needed" as const;
  const firstError = replies.findIndex((x) => x.attach_error);
  return {
    ok: true, purchaseId: replies[0].purchaseId, syncToken: replies[0].syncToken, tagged,
    attached: replies.reduce((a, x) => a + x.attached, 0), already_attached: replies.some((x) => x.already_attached),
    adopted, parts: replies,
    ...(firstError >= 0 ? { attach_error: { code: replies[firstError].attach_error!.code,
      message: `part ${firstError + 1} of ${replies.length}: ${replies[firstError].attach_error!.message}`.slice(0, 300) } } : {}),
    ...(partError ? { part_error: partError } : {}),
  };
}

/** Read and check the photo pages not read yet (the photo gate). */
async function fetchPhotoPages(r: CompleteRequest, io: CompleteIO, files: Files, pages: number[]) {
  for (const n of pages) {
    if (files.has(n)) continue;
    const text = await io.photo(mediaHash(r.photoRefs[n - 1]));
    if (text == null) throw refuse("photo_missing", `the receipt photo (page ${n}) is no longer in storage`);
    files.set(n, parseDataUrl(text));
  }
}

/** One expense (the job's link already checked). booksChanged: an earlier
    charge of the same receipt is already written, so a photo refused here
    is reported with that write even when this expense needed no tag. */
async function completeOne(r: CompleteRequest, io: CompleteIO, files: Files, booksChanged = false): Promise<CompleteReply> {
  const adopted = { create: false, tag: false, attach: 0 };
  const wantTag = r.changes.includes("tag") || r.changes.includes("create");
  const attach = r.changes.includes("attach");
  let id = r.txnId;
  let expectSyncToken = r.expectSyncToken;
  let purchase: Q | null = null;
  let tagged: CompleteReply["tagged"] = "not_needed";

  // 1a. the store entry: theirs, or ours from an earlier try (nothing written yet)
  if (r.create) {
    const c = r.create;
    const found = pickExistingCreate(await pagedRows(io.query, "Purchase", (start) => docNumberQuery(c.doc_number, start)), r);
    if (found) {
      id = str(found.Id);
      adopted.create = true;
      expectSyncToken = "";                          // never seen at filing: nothing to be stale against
    }
  }

  // the photo gate: the attach plan for an expense that exists, and every
  // page it (or, for a new entry, which has no documents, every page) will
  // upload, read and checked. Run before the first write, or before the
  // photo step when nothing is written; a 'skip' plan reads no photo.
  let plan = null as AttachPlan | null;
  const fetchPages = (pages: number[]) => fetchPhotoPages(r, io, files, pages);
  const planFor = async (purchaseId: string) =>
    attachPlan(rowsOf(await io.query(purchaseAttachablesQuery(purchaseId)), "Attachable"), r.receiptId, r.photoRefs.length);
  let gated = false;
  const gate = async () => {
    if (gated || !attach) return;
    if (id) {
      plan = await planFor(id);
      if (plan.action === "upload") await fetchPages(plan.pages);
    } else {
      await fetchPages(r.photoRefs.map((_, i) => i + 1));
    }
    gated = true;
  };

  // 1b. a new entry
  if (r.create && !id) {
    await gate();
    purchase = await io.postPurchase(createBody(r), await requestIdFor(r.receiptId, r.proposalId));
    if (!purchase?.Id) throw retryLater("create_unclear", "QuickBooks did not return the new expense");
    id = str(purchase.Id);
    tagged = "done";
  }

  // 2. the job tag (a fresh entry of ours is tagged already)
  if (!purchase) {
    const t = await tagStep(io, id, r, wantTag, expectSyncToken, gate);
    purchase = t.purchase;
    tagged = t.tagged;
    adopted.tag = tagged === "adopted";
  }

  // 3. the photo. Once the expense carries the job's tag (written now, or
  // by an earlier try), or an earlier charge of the same receipt was
  // written, a refusal here leaves the books changed: it is reported with
  // the write instead of as nothing done.
  let attached = 0, alreadyAttached = false;
  let attachError: CompleteReply["attach_error"];
  if (attach) {
    try {
      await gate();
      const p: AttachPlan = plan ?? await planFor(id);   // a new entry: planned on its own documents
      if (p.action === "skip") alreadyAttached = true;
      else {
        adopted.attach = p.ours;
        if (p.action === "upload") {
          await fetchPages(p.pages);
          for (const n of p.pages) {
            const f = files.get(n)!;
            const fileName = photoFileName(r.fileBase, n, r.receiptId, f.contentType);
            const boundary = io.boundary ? io.boundary() : "roybal-" + crypto.randomUUID().replace(/-/g, "");
            const body = multipartBody(boundary, attachMetadata(id, fileName, f.contentType), fileName, f.contentType, f.bytes);
            uploadedAttachable(await io.upload(body, `multipart/form-data; boundary=${boundary}`));
            attached++;
          }
        }
      }
    } catch (e) {
      const f = toCompleteError(e);
      if (!f.permanent || (tagged === "not_needed" && !booksChanged)) throw e;
      attachError = { code: f.code, message: f.message.slice(0, 300) };
    }
  }

  return {
    ok: true, purchaseId: id, syncToken: str(purchase?.SyncToken), tagged,
    attached, already_attached: alreadyAttached, adopted,
    ...(attachError ? { attach_error: attachError } : {}),
  };
}
