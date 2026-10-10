/* QuickBooks expenses for job receipts — tests (no Deno, no network).
   Run: node --experimental-strip-types --test supabase/functions/qbo-proxy/purchases.test.mjs
   (picked up by `npm run fn:test`)

   The fixtures are real QuickBooks JSON read on 2026-10-08 (Meridian
   connector, read-only): Purchase 10577 (Home Depot bank-rule expense, no
   tag, no photo), 10563 (Spenard invoice, tagged to project 112 with its
   ProjectRef, vendor PDF attached) and 10566 (Sherwin invoice, the store's
   longer DocNumber), and the Attachables linked to them. Customer rows keep
   the real shape with the homeowner names and contact fields taken out.

   Sections: the pure rules in purchases.ts; completePurchase end to end
   against an in-memory QuickBooks; then index.ts itself, as
   roybal-notify/decide.test.mjs does it: a resolve hook stands in for the
   two URL imports (serve hands the handler back, createClient returns a
   fake qbo_tokens table), Deno.env is a plain object and fetch is one
   stubbed world, so nothing leaves the process. */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  CompleteError, QboError, ProvenKeys, parseQboFault, classifyQboError, toCompleteError, bearerOf, sameKey,
  rowsOf, pagedRows, PAGE, projectsQuery, purchasesQuery, attachablesSinceQuery, purchaseAttachablesQuery, docNumberQuery,
  parseWindow, attachableSince, attachmentsByPurchase, compactPurchase, compactProject,
  billsQuery, compactBill,
  parseCompleteRequest, tagPlan, staleCheck, tagLines, tagUpdateBody, receiptMarker, requestIdFor, createBody,
  pickExistingCreate, attachPlan, mediaHash, storageMissing, parseDataUrl, photoFileName, attachMetadata,
  multipartBody, uploadedAttachable, completePurchase, MAX_PHOTO_BYTES,
} from "./purchases.ts";

/* ---------- real QuickBooks JSON ---------- */

const PX = { any: [{ name: "{http://schema.intuit.com/finance/v3}NameValue", declaredType: "com.intuit.schema.finance.v3.NameValue",
  scope: "javax.xml.bind.JAXBElement$GlobalScope", value: { Name: "TxnType", Value: "54" }, nil: false, globalScope: true, typeSubstituted: false }] };

const P10577 = {
  AccountRef: { value: "36", name: "3176 - Citi - Home Depot Consumer Credit Card" }, PaymentType: "CreditCard",
  EntityRef: { value: "25", name: "Home Depot", type: "Vendor" }, Credit: false, TotalAmt: 1369.5, PurchaseEx: PX,
  domain: "QBO", sparse: false, Id: "10577", SyncToken: "0",
  MetaData: { CreateTime: "2026-10-02T08:35:51-07:00", LastUpdatedTime: "2026-10-02T08:35:51-07:00" }, CustomField: [],
  TxnDate: "2026-09-30", CurrencyRef: { value: "USD", name: "United States Dollar" }, PrivateNote: "THE HOME DEPOT FAIRBANKS AK - RULE",
  Line: [{ Id: "1", Description: "THE HOME DEPOT FAIRBANKS AK - RULE", Amount: 1369.5, DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ClassRef: { value: "1000000001", name: "Construction" },
      AccountRef: { value: "42", name: "Cost of Goods Sold:Materials COGS" }, BillableStatus: "NotBillable", TaxCodeRef: { value: "NON" } },
    CustomExtensions: [] }],
};

const P10563 = {
  AccountRef: { value: "53", name: "Spenard Builders (SBS) - Store Credit" }, PaymentMethodRef: { value: "17" }, PaymentType: "CreditCard",
  EntityRef: { value: "65", name: "Spenard Building Supply", type: "Vendor" }, Credit: false, TotalAmt: 212.28, PurchaseEx: PX,
  domain: "QBO", sparse: false, Id: "10563", SyncToken: "1",
  MetaData: { CreateTime: "2026-10-02T08:04:42-07:00", LastUpdatedTime: "2026-10-02T08:05:11-07:00" }, CustomField: [],
  DocNumber: "700624817", TxnDate: "2026-09-28", CurrencyRef: { value: "USD", name: "United States Dollar" }, PrivateNote: "Materials purchased",
  Line: [{ Id: "1", Description: "Materials purchased", Amount: 212.28, DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { CustomerRef: { value: "112", name: "Pollen Apartments" }, ClassRef: { value: "1000000001", name: "Construction" },
      AccountRef: { value: "42", name: "Cost of Goods Sold:Materials COGS" }, BillableStatus: "NotBillable", TaxCodeRef: { value: "NON" } },
    ProjectRef: { value: "412739523" }, CustomExtensions: [] }],
};

const P10566 = {
  AccountRef: { value: "52", name: "Sherwin Williams Store Credit Account" }, PaymentMethodRef: { value: "17" }, PaymentType: "CreditCard",
  EntityRef: { value: "9", name: "Sherwin Williams", type: "Vendor" }, Credit: false, TotalAmt: 36, PurchaseEx: PX,
  domain: "QBO", sparse: false, Id: "10566", SyncToken: "2",
  MetaData: { CreateTime: "2026-10-02T08:15:13-07:00", LastUpdatedTime: "2026-10-02T08:15:52-07:00" }, CustomField: [],
  DocNumber: "80669163000926", TxnDate: "2026-09-28", CurrencyRef: { value: "USD", name: "United States Dollar" }, PrivateNote: "Job materials",
  Line: [{ Id: "1", Description: "Job materials", Amount: 36, DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { CustomerRef: { value: "112", name: "Pollen Apartments" }, ClassRef: { value: "1000000001", name: "Construction" },
      AccountRef: { value: "42", name: "Cost of Goods Sold:Materials COGS" }, BillableStatus: "NotBillable", TaxCodeRef: { value: "NON" } },
    ProjectRef: { value: "412739523" }, CustomExtensions: [] }],
};

const A10563 = { FileName: "SBS - InvNo 700624817.pdf", FileAccessUri: "/v3/company/9341452443180806/download/1000004701", Size: 37542,
  ContentType: "application/pdf", documentId: "bd751eab-42b3-4867-9da9-22fe77140e8c", domain: "QBO", sparse: false, Id: "1000004701", SyncToken: "1",
  MetaData: { CreateTime: "2026-10-02T08:04:38-07:00", LastUpdatedTime: "2026-10-02T08:04:42-07:00" },
  AttachableRef: [{ EntityRef: { value: "10563", type: "Purchase" }, IncludeOnSend: false }] };
const A10566 = { FileName: "SW InvNo 80669163000926.pdf", FileAccessUri: "/v3/company/9341452443180806/download/1000004711", Size: 14084,
  ContentType: "application/pdf", documentId: "b206e01b-ce49-4b12-8617-3355b47f9333", domain: "QBO", sparse: false, Id: "1000004711", SyncToken: "1",
  MetaData: { CreateTime: "2026-10-02T08:15:11-07:00", LastUpdatedTime: "2026-10-02T08:15:13-07:00" },
  AttachableRef: [{ EntityRef: { value: "10566", type: "Purchase" }, IncludeOnSend: false }] };
/* A dump ticket booked as a bill: the shape of Bill 10625 (FNSB, read
   2026-10-10), here as it was before anyone tagged it. */
const B10625 = {
  SalesTermRef: { value: "3" }, DueDate: "2026-11-30", Balance: 34.04, domain: "QBO", sparse: false, Id: "10625", SyncToken: "0",
  MetaData: { CreateTime: "2026-10-08T08:41:46-07:00", LastUpdatedTime: "2026-10-08T08:41:46-07:00" },
  DocNumber: "01286734", TxnDate: "2026-10-01", CurrencyRef: { value: "USD", name: "United States Dollar" },
  PrivateNote: "CONSTRUCTION MATRL", LinkedTxn: [],
  Line: [{ Id: "1", LineNum: 1, Description: "CONSTRUCTION MATRL", Amount: 34.04, LinkedTxn: [], DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ClassRef: { value: "1000000001", name: "Operations:Construction" },
      AccountRef: { value: "226", name: "Cost of Goods Sold:Waste disposal (Customer)" }, BillableStatus: "NotBillable", TaxCodeRef: { value: "NON" } },
    CustomExtensions: [] }],
  VendorRef: { value: "355", name: "FNSB Solid Waste" }, APAccountRef: { value: "99", name: "Accounts Payable (A/P)" }, TotalAmt: 34.04,
};
const A10625 = { FileName: "FNSB 01286734.jpg", Id: "1000004901", ContentType: "image/jpeg",
  AttachableRef: [{ EntityRef: { value: "10625", type: "Bill" }, IncludeOnSend: false }] };

/* One rental paid as two card charges (read 2026-10-10): Rental Zone
   receipt $351.00 = 10615 ($126.90 at checkout) + 10661 ($224.10 at return). */
const rental = (id, date, total, created) => ({
  AccountRef: { value: "37", name: "1658 - Bank of America AK Air CC" }, PaymentType: "CreditCard",
  EntityRef: { value: "83", name: "Airport Equipment Rental, Inc", type: "Vendor" }, Credit: false, TotalAmt: total, PurchaseEx: PX,
  domain: "QBO", sparse: false, Id: id, SyncToken: "0", MetaData: { CreateTime: created, LastUpdatedTime: created }, CustomField: [],
  TxnDate: date, CurrencyRef: { value: "USD", name: "United States Dollar" }, PrivateNote: "AIRPORT EQUIPMENT RENTAL FAIRBANKS    AK - RULE",
  Line: [{ Id: "1", Description: "AIRPORT EQUIPMENT RENTAL FAIRBANKS    AK - RULE", Amount: total, DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ClassRef: { value: "1000000001", name: "Construction" },
      AccountRef: { value: "1150040005", name: "Cost of Goods Sold:Equipment Rental" }, BillableStatus: "NotBillable", TaxCodeRef: { value: "NON" } },
    CustomExtensions: [] }],
});
const P10615 = rental("10615", "2026-10-02", 126.9, "2026-10-06T07:22:52-07:00");
const P10661 = rental("10661", "2026-10-07", 224.1, "2026-10-09T01:09:04-07:00");

// an uploaded photo with no link (the QuickBooks UI leaves these behind)
const A_ORPHAN = { FileName: "IMG_9547.jpg", Id: "1000004291", ContentType: "image/jpeg" };

const CUSTOMERS = [
  { Taxable: false, Job: true, BillWithParent: true, ParentRef: { value: "443" }, Level: 1, IsProject: true, Id: "444", SyncToken: "1",
    FullyQualifiedName: "Parent 443:1192 Bemis Ct.", DisplayName: "1192 Bemis Ct.", PrintOnCheckName: "1192 Bemis Ct.", Active: true },
  { Taxable: false, Job: true, BillWithParent: true, ParentRef: { value: "513" }, Level: 1, IsProject: false, Id: "514", SyncToken: "0",
    FullyQualifiedName: "Parent 513:330 Brighton", DisplayName: "330 Brighton", Active: true },
  { Taxable: false, Job: true, BillWithParent: true, ParentRef: { value: "514" }, Level: 2, IsProject: true, Id: "515", SyncToken: "0",
    FullyQualifiedName: "Parent 513:330 Brighton:330 Brighton", DisplayName: "330 Brighton", Active: true },
  { Taxable: false, Job: true, BillWithParent: true, ParentRef: { value: "111" }, Level: 1, IsProject: true, Id: "112", SyncToken: "2",
    FullyQualifiedName: "Parent 111:Pollen Apartments", DisplayName: "Pollen Apartments", PrintOnCheckName: "Pollen Apartments", Active: true },
];

/* ---------- a receipt and its photo ---------- */

const RECEIPT = "3f9b2c1e-7a4d-4e8b-9c0f-1a2b3c4d5e6f";
const PROPOSAL = "c0ffee00-1111-4222-8333-444455556666";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x0d, 0x0a, 0x80, 0xff, 0xd9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const SHA1 = "a".repeat(64), SHA2 = "b".repeat(64);
const marker = (sha, text) => `media:${sha}:${text.length}`;
const PHOTO1 = dataUrl("image/jpeg", JPEG), PHOTO2 = dataUrl("image/png", PNG);

/** The outbox payload the executor writes for the 10577 receipt
    (DESIGN "Outbox payload"). */
const payload = (o = {}) => ({
  receipt_id: RECEIPT, job_id: "a628eea5-0000-4000-8000-000000000001", proposal_id: PROPOSAL,
  qbo_txn_type: "Purchase", qbo_txn_id: "10577", expect_sync_token: "0", expect_total: 1369.5,
  changes: ["tag", "attach"], customer_id: "112", project_ref: "412739523",
  photo_refs: [marker(SHA1, PHOTO1)], file_base: "Home Depot 2026-09-30 1303-00001-50615",
  ...o,
});
const CREATE = { account_id: "53", vendor_id: "65", payment_type: "CreditCard", credit: false, doc_number: "700665392",
  expense_account_id: "42", class_id: "1000000001", txn_date: "2026-10-03", amount_abs: 1146.75,
  memo: "Spenard 700665392 (from the job receipts app)" };
const createPayload = (o = {}) => payload({ qbo_txn_id: "", expect_sync_token: "", expect_total: 0,
  changes: ["create", "attach"], create: CREATE, file_base: "Spenard 2026-10-03 700665392", ...o });

/** A dump ticket's bill as an outbox payload would name it. Never sent by
    the executor (a bill is only noted); the proxy refuses it unread. */
const billPayload = (o = {}) => payload({ qbo_txn_type: "Bill", qbo_txn_id: "10625", expect_sync_token: "0", expect_total: 34.04,
  file_base: "FNSB 2026-10-01 01286734", ...o });
/** The Rental Zone receipt: two charges, the top level names neither. */
const RZ = "995d2795-0000-4000-8000-000000000001";
const RZ_JOB = "b1885000-0000-4000-8000-000000000001";
const PART = (id, total, o = {}) => ({ qbo_txn_id: id, expect_sync_token: "0", expect_total: total, changes: ["tag", "attach"], ...o });
const partsPayload = (o = {}) => payload({ receipt_id: RZ, job_id: RZ_JOB, qbo_txn_id: "", expect_sync_token: "", expect_total: 351,
  customer_id: "502", project_ref: "807760362", file_base: "Rental Zone 2026-10-07 R284290",
  parts: [PART("10615", 126.9), PART("10661", 224.1)], ...o });

const fault = (code, detail = "x") => JSON.stringify({ Fault: { Error: [{ Message: "m", Detail: detail, code }], type: "ValidationFault" } });
const enc = (s) => new TextEncoder().encode(s);
const latin1 = (u8) => Buffer.from(u8).toString("latin1");

/* ============================================================
   errors
   ============================================================ */

test("QboError keeps qboFetch's old message and reads Intuit's Fault code", () => {
  const e = new QboError(400, fault("5010", "Stale Object Error : You and admin were working on this at the same time."));
  assert.equal(e.message.startsWith("QBO API 400: {\"Fault\""), true);
  assert.equal(e.code, "5010");
  assert.match(e.detail, /Stale Object/);
  assert.deepEqual(parseQboFault("<html>bad gateway</html>"), { code: "", detail: "" });
  assert.equal(parseQboFault(JSON.stringify({ fault: { error: [{ code: "3200", message: "AuthenticationFailed" }] } })).code, "3200");
});

test("classifyQboError: validation refusals are permanent, the rest is retried", () => {
  const c = (status, code) => classifyQboError(new QboError(status, code ? fault(code) : "oops"));
  assert.equal(c(400, "6000").permanent, true);
  assert.equal(c(400, "6000").code, "qbo_refused");
  assert.equal(c(400, "610").code, "purchase_missing");
  assert.equal(c(400, "610").permanent, true);
  assert.equal(c(400, "5010").permanent, false);
  assert.equal(c(400, "5010").code, "stale_object");
  for (const s of [401, 403, 408, 500, 503]) assert.equal(c(s).permanent, false, `HTTP ${s} is worth a retry`);
  assert.equal(c(429).status, 503);
  assert.equal(c(400, "6000").status, 409);
  assert.equal(c(500).status, 502);
});

test("toCompleteError: a CompleteError passes through, a network error is retried", () => {
  const mine = new CompleteError("tagged_other", "x", true);
  assert.equal(toCompleteError(mine), mine);
  const net = toCompleteError(new TypeError("fetch failed"));
  assert.equal(net.permanent, false);
  assert.equal(net.code, "qbo_unreachable");
});

/* ============================================================
   the 'service' caller
   ============================================================ */

test("bearerOf and sameKey", () => {
  assert.equal(bearerOf("Bearer sb_secret_abc "), "sb_secret_abc");
  assert.equal(bearerOf("bearer x.y.z"), "x.y.z");
  assert.equal(bearerOf(null), "");
  assert.equal(sameKey("sb_secret_abc", "sb_secret_abc"), true);
  assert.equal(sameKey("sb_secret_abc", "sb_secret_abd"), false);
  assert.equal(sameKey("sb_secret_ab", "sb_secret_abc"), false);
  assert.equal(sameKey("", ""), false, "an unset key never matches an empty bearer");
});

test("ProvenKeys remembers a yes for five minutes, then asks again", () => {
  let t = 1_000_000;
  const k = new ProvenKeys(undefined, () => t);
  assert.equal(k.has("h"), false);
  k.add("h");
  t += 4 * 60 * 1000;
  assert.equal(k.has("h"), true);
  t += 61 * 1000;
  assert.equal(k.has("h"), false);
  assert.equal(k.until.size, 0, "an expired entry is dropped");
});

/* ============================================================
   queries and paging
   ============================================================ */

test("query text: the paged reads, the attachment lookup, the store-invoice prefix", () => {
  assert.equal(projectsQuery(1), "select * from Customer where Job = true and Active = true startposition 1 maxresults 1000");
  assert.equal(purchasesQuery("2026-09-01", "2026-10-08", 1001),
    "select * from Purchase where TxnDate >= '2026-09-01' and TxnDate <= '2026-10-08' startposition 1001 maxresults 1000");
  assert.equal(attachablesSinceQuery("2026-08-25T00:00:00-08:00", 1),
    "select * from Attachable where MetaData.CreateTime >= '2026-08-25T00:00:00-08:00' startposition 1 maxresults 1000");
  assert.equal(purchaseAttachablesQuery("10577"),
    "select * from Attachable where AttachableRef.EntityRef.Type = 'Purchase' and AttachableRef.EntityRef.Value = '10577'");
  // paged like the window reads: a prefix across every account and year can pass QuickBooks' default 100 rows
  assert.equal(docNumberQuery("80669", 1), "select * from Purchase where DocNumber LIKE '80669%' startposition 1 maxresults 1000");
  assert.equal(docNumberQuery("o'x", 1001), "select * from Purchase where DocNumber LIKE 'o\\'x%' startposition 1001 maxresults 1000");
});

test("rowsOf: an empty QueryResponse is no rows", () => {
  assert.deepEqual(rowsOf({ QueryResponse: {} }, "Purchase"), []);
  assert.deepEqual(rowsOf(null, "Purchase"), []);
  assert.deepEqual(rowsOf({ QueryResponse: { Purchase: [P10577] } }, "Purchase"), [P10577]);
});

test("pagedRows: follows full pages, stops at a short one, drops a repeated Id", async () => {
  const all = Array.from({ length: PAGE + 3 }, (_, i) => ({ Id: String(i + 1) }));
  const asked = [];
  const run = async (q) => {
    asked.push(q);
    const start = Number(/startposition (\d+)/.exec(q)[1]);
    const rows = all.slice(start - 1, start - 1 + PAGE);
    // a row created mid-read shifts page 2 back by one: Id 1000 comes twice
    return { QueryResponse: { Purchase: start > 1 ? [all[PAGE - 1], ...rows] : rows } };
  };
  const rows = await pagedRows(run, "Purchase", (s) => purchasesQuery("2026-09-01", "2026-09-30", s));
  assert.equal(rows.length, PAGE + 3);
  assert.equal(new Set(rows.map((r) => r.Id)).size, PAGE + 3);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /startposition 1001 maxresults 1000$/);
});

test("pagedRows: a server that never ends is cut off", async () => {
  let n = 0;
  const run = async () => ({ QueryResponse: { Customer: Array.from({ length: PAGE }, () => ({ Id: String(++n) })) } });
  const rows = await pagedRows(run, "Customer", projectsQuery, 3);
  assert.equal(rows.length, 3 * PAGE);
});

/* ============================================================
   listPurchases: window, attachments, compaction
   ============================================================ */

test("parseWindow: real dates, in order, at most 92 days", () => {
  assert.deepEqual(parseWindow({ from: "2026-07-08", to: "2026-10-08" }), { from: "2026-07-08", to: "2026-10-08" });
  assert.match(parseWindow({ from: "2026-07-07", to: "2026-10-08" }).error, /at most 92 days/);
  assert.match(parseWindow({ from: "2026-10-08", to: "2026-10-07" }).error, /after/);
  assert.match(parseWindow({ from: "2026-02-30", to: "2026-03-01" }).error, /YYYY-MM-DD/);
  assert.match(parseWindow({ from: "10/1/2026", to: "2026-10-08" }).error, /YYYY-MM-DD/);
  assert.match(parseWindow({}).error, /YYYY-MM-DD/);
  assert.deepEqual(parseWindow({ from: "2026-10-08", to: "2026-10-08" }), { from: "2026-10-08", to: "2026-10-08" });
});

test("attachableSince: a week before the window, in the design's fixed offset", () => {
  assert.equal(attachableSince("2026-09-01"), "2026-08-25T00:00:00-08:00");
  assert.equal(attachableSince("2026-03-03"), "2026-02-24T00:00:00-08:00");
});

test("attachmentsByPurchase: only links to a Purchase count", () => {
  const bill = { FileName: "01283215.jpg", AttachableRef: [{ EntityRef: { value: "10470", type: "Bill" } }] };
  const m = attachmentsByPurchase([A10563, A10566, A_ORPHAN, bill]);
  assert.deepEqual([...m.keys()].sort(), ["10563", "10566"]);
  assert.deepEqual(m.get("10563"), ["SBS - InvNo 700624817.pdf"]);
});

test("compactPurchase: the untagged Home Depot bank-rule expense (10577)", () => {
  assert.deepEqual(compactPurchase(P10577, []), {
    txnType: "Purchase", id: "10577", syncToken: "0", txnDate: "2026-09-30", total: 1369.5, credit: false, paymentType: "CreditCard",
    accountId: "36", accountName: "3176 - Citi - Home Depot Consumer Credit Card", vendorId: "25", vendorName: "Home Depot",
    docNumber: "", note: "THE HOME DEPOT FAIRBANKS AK - RULE",
    lines: [{ id: "1", amount: 1369.5, detailType: "AccountBasedExpenseLineDetail", accountId: "42",
      accountName: "Cost of Goods Sold:Materials COGS", classId: "1000000001", customerId: "", customerName: "", projectRef: "" }],
    attachments: [], hasAttachment: false,
  });
});

test("compactPurchase: a tagged store invoice carries its line-level ProjectRef and file", () => {
  const c = compactPurchase(P10563, ["SBS - InvNo 700624817.pdf"]);
  assert.equal(c.docNumber, "700624817");
  assert.equal(c.accountId, "53");
  assert.deepEqual(c.lines[0], { id: "1", amount: 212.28, detailType: "AccountBasedExpenseLineDetail", accountId: "42",
    accountName: "Cost of Goods Sold:Materials COGS", classId: "1000000001", customerId: "112", customerName: "Pollen Apartments",
    projectRef: "412739523" });
  assert.equal(c.hasAttachment, true);
  assert.deepEqual(c.attachments, ["SBS - InvNo 700624817.pdf"]);
});

test("compactPurchase: a return is credit=true with a positive total; odd rows do not throw", () => {
  const ret = { ...P10577, Id: "10548", Credit: true, TotalAmt: 41.97 };
  assert.equal(compactPurchase(ret).credit, true);
  assert.equal(compactPurchase(ret).total, 41.97);
  const bare = compactPurchase({ Id: "1" });
  assert.deepEqual(bare.lines, []);
  assert.equal(bare.accountId, "");
  const item = compactPurchase({ Id: "2", Line: [{ Id: "1", Amount: 5, DetailType: "ItemBasedExpenseLineDetail",
    ItemBasedExpenseLineDetail: { ItemRef: { value: "7" }, CustomerRef: { value: "444", name: "1192 Bemis Ct." } } }] });
  assert.equal(item.lines[0].customerId, "444");
  assert.equal(item.lines[0].accountId, "");
});

test("compactProject: id, name, fqn, parent, and whether QuickBooks calls it a project", () => {
  assert.deepEqual(CUSTOMERS.map(compactProject), [
    { id: "444", name: "1192 Bemis Ct.", fqn: "Parent 443:1192 Bemis Ct.", parentId: "443", isProject: true },
    { id: "514", name: "330 Brighton", fqn: "Parent 513:330 Brighton", parentId: "513", isProject: false },
    { id: "515", name: "330 Brighton", fqn: "Parent 513:330 Brighton:330 Brighton", parentId: "514", isProject: true },
    { id: "112", name: "Pollen Apartments", fqn: "Parent 111:Pollen Apartments", parentId: "111", isProject: true },
  ]);
});

/* ============================================================
   completePurchase: the request
   ============================================================ */

test("parseCompleteRequest: the 10577 payload reads as written", () => {
  const r = parseCompleteRequest(payload());
  assert.deepEqual(r, {
    receiptId: RECEIPT, jobId: "a628eea5-0000-4000-8000-000000000001", proposalId: PROPOSAL, txnId: "10577",
    expectSyncToken: "0", expectTotal: 1369.5, changes: ["tag", "attach"], customerId: "112", projectRef: "412739523",
    photoRefs: [marker(SHA1, PHOTO1)], fileBase: "Home Depot 2026-09-30 1303-00001-50615", create: null, parts: null,
  });
  assert.equal(parseCompleteRequest(payload({ project_ref: null })).projectRef, "");
  assert.equal(parseCompleteRequest(payload({ changes: ["attach"], customer_id: "" })).customerId, "");
});

test("parseCompleteRequest: a store entry reads as written", () => {
  const r = parseCompleteRequest(createPayload());
  assert.equal(r.txnId, "");
  assert.deepEqual(r.create, { ...CREATE });
  // the executor's payload carries qbo_total as expect_total, null for a new entry
  assert.equal(parseCompleteRequest(createPayload({ expect_total: null })).expectTotal, null);
});

test("parseCompleteRequest: a return slip's receipt id (\"<receipt id>~ret\") reads as written", () => {
  const id = "1e676fb6-0000-4000-8000-000000000001~ret";
  assert.equal(parseCompleteRequest(payload({ receipt_id: id })).receiptId, id);
});

test("parseCompleteRequest: an attach-only item needs no job (no link is checked); a 5-digit store number is enough", () => {
  assert.equal(parseCompleteRequest(payload({ changes: ["attach"], customer_id: "", job_id: "" })).jobId, "");
  assert.equal(parseCompleteRequest(createPayload({ create: { ...CREATE, doc_number: "80669" } })).create.doc_number, "80669");
});

test("parseCompleteRequest: what the executor lets be null is accepted", () => {
  assert.equal(parseCompleteRequest(payload({ expect_total: null })).expectTotal, null);
  const c = parseCompleteRequest(createPayload({ create: { ...CREATE, payment_type: null, txn_date: null, class_id: null } })).create;
  assert.equal(c.payment_type, "CreditCard");
  assert.equal(c.txn_date, "");
  assert.equal(c.class_id, "");
});

test("parseCompleteRequest: every malformed payload is a permanent bad_request", () => {
  const bad = [
    payload({ receipt_id: "" }), payload({ receipt_id: "has space" }), payload({ receipt_id: "x".repeat(65) }),
    payload({ proposal_id: "p1" }), payload({ qbo_txn_type: "Invoice" }), payload({ qbo_txn_type: "" }),
    createPayload({ qbo_txn_type: "Bill" }),
    payload({ changes: [] }), payload({ changes: ["tag", "tag"] }), payload({ changes: ["delete"] }), payload({ changes: "tag" }),
    payload({ qbo_txn_id: "" }), payload({ qbo_txn_id: "10577; drop" }), payload({ expect_sync_token: "" }),
    payload({ expect_total: "lots" }), payload({ customer_id: "" }), payload({ customer_id: "Pollen" }),
    payload({ project_ref: "abc" }), payload({ photo_refs: [] }), payload({ photo_refs: ["data:image/jpeg;base64,AA"] }),
    payload({ photo_refs: Array(5).fill(marker(SHA1, PHOTO1)) }),
    createPayload({ qbo_txn_id: "10577" }), createPayload({ customer_id: "" }),
    createPayload({ create: { ...CREATE, payment_type: "Cash" } }), createPayload({ create: { ...CREATE, credit: "no" } }),
    createPayload({ create: { ...CREATE, doc_number: "8066-9" } }), createPayload({ create: { ...CREATE, doc_number: "8066" } }),
    createPayload({ create: { ...CREATE, amount_abs: 0 } }), payload({ job_id: "" }), createPayload({ job_id: "job-1" }),
    createPayload({ create: { ...CREATE, txn_date: "2026-13-01" } }), createPayload({ create: { ...CREATE, vendor_id: "" } }),
    createPayload({ create: { ...CREATE, class_id: "Construction" } }),
  ];
  for (const b of bad) {
    assert.throws(() => parseCompleteRequest(b), (e) => e instanceof CompleteError && e.code === "bad_request" && e.permanent && e.status === 409,
      JSON.stringify(b).slice(0, 160));
  }
});

/* ============================================================
   completePurchase: the tag
   ============================================================ */

test("tagLines keeps every line and only adds CustomerRef and ProjectRef", () => {
  const two = { ...P10577, Line: [P10577.Line[0], { ...structuredClone(P10577.Line[0]), Id: "2", Amount: 12.5,
    AccountBasedExpenseLineDetail: { AccountRef: { value: "65", name: "Tools" }, ClassRef: { value: "801076" } } }] };
  const before = structuredClone(two.Line);
  const out = tagLines(two.Line, "112", "412739523");
  assert.deepEqual(two.Line, before, "the read is not mutated");
  assert.equal(out.length, 2);
  for (let i = 0; i < out.length; i++) {
    const got = structuredClone(out[i]);
    assert.deepEqual(got.AccountBasedExpenseLineDetail.CustomerRef, { value: "112" });
    assert.deepEqual(got.ProjectRef, { value: "412739523" });
    delete got.AccountBasedExpenseLineDetail.CustomerRef;
    delete got.ProjectRef;
    const want = structuredClone(before[i]);
    // the only other change: a line with no BillableStatus gets NotBillable
    if (!want.AccountBasedExpenseLineDetail.BillableStatus) want.AccountBasedExpenseLineDetail.BillableStatus = "NotBillable";
    assert.deepEqual(got, want, `line ${i + 1} changed beyond the tag`);
  }
  assert.equal(out[0].AccountBasedExpenseLineDetail.BillableStatus, "NotBillable", "as read");
  assert.equal(out[1].Amount, 12.5);
  assert.equal(out[1].AccountBasedExpenseLineDetail.AccountRef.value, "65");
});

test("tagLines: no ProjectRef when it is not known; a Billable line stays Billable; item lines tag too", () => {
  const [l] = tagLines(P10577.Line, "444", "");
  assert.equal("ProjectRef" in l, false);
  const billable = structuredClone(P10577.Line[0]);
  billable.AccountBasedExpenseLineDetail.BillableStatus = "Billable";
  assert.equal(tagLines([billable], "444", "")[0].AccountBasedExpenseLineDetail.BillableStatus, "Billable");
  const item = { Id: "3", Amount: 9, DetailType: "ItemBasedExpenseLineDetail", ItemBasedExpenseLineDetail: { ItemRef: { value: "7" }, Qty: 1 } };
  const [t] = tagLines([item], "444", "788830886");
  assert.deepEqual(t.ItemBasedExpenseLineDetail, { ItemRef: { value: "7" }, Qty: 1, CustomerRef: { value: "444" }, BillableStatus: "NotBillable" });
  assert.deepEqual(t.ProjectRef, { value: "788830886" });
});

test("tagUpdateBody: Id, the current SyncToken, PaymentType from the read, the whole Line, nothing else", () => {
  const b = tagUpdateBody({ ...P10577, SyncToken: "4" }, "112", "412739523");
  assert.deepEqual(Object.keys(b).sort(), ["Id", "Line", "PaymentType", "SyncToken", "sparse"]);
  assert.equal(b.Id, "10577");
  assert.equal(b.SyncToken, "4");
  assert.equal(b.sparse, true);
  assert.equal(b.PaymentType, "CreditCard");
  assert.deepEqual(b.Line, tagLines(P10577.Line, "112", "412739523"));
  // the shape QuickBooks holds on a hand-tagged line (10563) is what we write
  const tagged = b.Line[0];
  assert.deepEqual(tagged.ProjectRef, P10563.Line[0].ProjectRef);
  assert.equal(tagged.AccountBasedExpenseLineDetail.CustomerRef.value, P10563.Line[0].AccountBasedExpenseLineDetail.CustomerRef.value);
});

test("tagPlan: untagged → tag; ours → adopt; someone else's → tagged_other with the name", () => {
  assert.deepEqual(tagPlan(P10577, "112", true), { action: "tag" });
  assert.deepEqual(tagPlan(P10563, "112", true), { action: "adopt" });
  const other = tagPlan(P10563, "444", true);
  assert.equal(other.action, "refuse");
  assert.equal(other.code, "tagged_other");
  assert.match(other.message, /Pollen Apartments/);
  assert.equal(other.customerId, "112");
  // the tag is never overwritten, even for an attach-only item
  assert.equal(tagPlan(P10563, "444", false).code, "tagged_other");
});

test("tagPlan: mixed lines are refused as partly_tagged; one other-tagged line wins over mixed", () => {
  const mixed = { ...P10563, Line: [P10563.Line[0], { ...P10577.Line[0], Id: "2" }] };
  const p = tagPlan(mixed, "112", true);
  assert.equal(p.code, "partly_tagged");
  assert.match(p.message, /1 of 2 lines/);
  assert.equal(tagPlan(mixed, "112", false).code, "partly_tagged");
  const oursAndOther = { ...P10563, Line: [P10563.Line[0], { ...structuredClone(P10563.Line[0]), Id: "2",
    AccountBasedExpenseLineDetail: { ...P10563.Line[0].AccountBasedExpenseLineDetail, CustomerRef: { value: "444", name: "1192 Bemis Ct." } } }] };
  assert.equal(tagPlan(oursAndOther, "112", true).code, "tagged_other");
});

test("tagPlan: attach-only needs no tag; no customer means no tag questions at all", () => {
  assert.deepEqual(tagPlan(P10577, "112", false), { action: "not_needed" });
  assert.deepEqual(tagPlan(P10563, "112", false), { action: "not_needed" });
  assert.deepEqual(tagPlan(P10563, "", false), { action: "not_needed" });
});

test("tagPlan: an expense with nothing taggable is refused, not half-tagged", () => {
  assert.equal(tagPlan({ Id: "9", Line: [] }, "112", true).code, "untaggable");
  const odd = { Id: "9", Line: [P10577.Line[0], { Id: "2", Amount: 0, DetailType: "TDSLineDetail", TDSLineDetail: {} }] };
  assert.equal(tagPlan(odd, "112", true).code, "untaggable_line");
});

test("staleCheck: a new SyncToken alone is fine; a new SyncToken and a new total is not", () => {
  assert.equal(staleCheck(P10577, "0", 1369.5), null);
  assert.equal(staleCheck({ ...P10577, SyncToken: "1", PrivateNote: "fixed memo" }, "0", 1369.5), null);
  assert.equal(staleCheck({ ...P10577, SyncToken: "1" }, "0", 1369.504), null, "cents, not float noise");
  const moved = staleCheck({ ...P10577, SyncToken: "1", TotalAmt: 1400 }, "0", 1369.5);
  assert.equal(moved.code, "changed_in_qbo");
  assert.equal(moved.permanent, true);
  assert.match(moved.message, /\$1400\.00, was \$1369\.50/);
  // same SyncToken cannot have a new total; and an entry never seen at filing has no expectation
  assert.equal(staleCheck({ ...P10577, TotalAmt: 1 }, "0", 1369.5), null);
  assert.equal(staleCheck({ ...P10577, SyncToken: "9", TotalAmt: 1 }, "", 0), null);
});

test("staleCheck: with no total on file, a new SyncToken alone is refused", () => {
  assert.equal(staleCheck(P10577, "0", null), null);
  const moved = staleCheck({ ...P10577, SyncToken: "1" }, "0", null);
  assert.equal(moved.code, "changed_in_qbo");
  assert.equal(moved.permanent, true);
});

/* ============================================================
   completePurchase: the store entry
   ============================================================ */

test("createBody: one tagged, NotBillable line and the receipt marker in the memo", () => {
  const b = createBody(parseCompleteRequest(createPayload()));
  assert.deepEqual(b, {
    PaymentType: "CreditCard",
    AccountRef: { value: "53" },
    EntityRef: { value: "65", type: "Vendor" },
    DocNumber: "700665392",
    TxnDate: "2026-10-03",
    Credit: false,
    PrivateNote: `Spenard 700665392 (from the job receipts app) [r:${RECEIPT}]`,
    Line: [{
      Amount: 1146.75, DetailType: "AccountBasedExpenseLineDetail", Description: "Spenard 700665392 (from the job receipts app)",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "42" }, CustomerRef: { value: "112" }, BillableStatus: "NotBillable",
        ClassRef: { value: "1000000001" } },
      ProjectRef: { value: "412739523" },
    }],
  });
  const ret = createBody(parseCompleteRequest(createPayload({ project_ref: "", create: { ...CREATE, credit: true, class_id: "", txn_date: null } })));
  assert.equal(ret.Credit, true);
  assert.equal("TxnDate" in ret, false, "no date: QuickBooks dates it today");
  assert.equal("ProjectRef" in ret.Line[0], false);
  assert.equal("ClassRef" in ret.Line[0].AccountBasedExpenseLineDetail, false);
  assert.equal(receiptMarker("r1"), "[r:r1]");
});

test("requestIdFor: one id per receipt per approval, UUID-shaped", async () => {
  const a = await requestIdFor(RECEIPT, PROPOSAL);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(await requestIdFor(RECEIPT, PROPOSAL), a, "a retry sends the same id");
  assert.notEqual(await requestIdFor("other-receipt", PROPOSAL), a);
  assert.notEqual(await requestIdFor(RECEIPT, "c0ffee00-1111-4222-8333-444455556667"), a);
});

test("pickExistingCreate: same number on the same store account is the same invoice", () => {
  const r = parseCompleteRequest(createPayload({ create: { ...CREATE, doc_number: "700624817", amount_abs: 212.28 } }));
  assert.equal(pickExistingCreate([P10563], r).Id, "10563");
  // the same number on another account is not it
  assert.equal(pickExistingCreate([{ ...P10563, AccountRef: { value: "36" } }], r), null);
  // an exact number wins even at a different amount (a misread total)
  const misread = parseCompleteRequest(createPayload({ create: { ...CREATE, doc_number: "700624817", amount_abs: 21.28 } }));
  assert.equal(pickExistingCreate([P10563], misread).Id, "10563");
});

test("pickExistingCreate: a return slip printing the original invoice's number never adopts the purchase", () => {
  // the return of 1146.75 on Spenard 700665392: QuickBooks holds the purchase (a debit) under that number
  const purchase = { ...P10563, Id: "10644", TotalAmt: 1146.75, DocNumber: "700665392", Credit: false };
  const ret = parseCompleteRequest(createPayload({ create: { ...CREATE, credit: true } }));
  assert.equal(pickExistingCreate([purchase], ret), null);
  const entered = { ...purchase, Id: "10700", Credit: true };
  assert.equal(pickExistingCreate([purchase, entered], ret).Id, "10700", "the credit itself is adopted");
  // and a purchase never adopts a credit of the same number
  assert.equal(pickExistingCreate([entered], parseCompleteRequest(createPayload())), null);
});

test("pickExistingCreate: Sherwin's longer DocNumber matches by prefix only at the same amount and direction", () => {
  const sw = (o = {}) => parseCompleteRequest(createPayload({ create: { ...CREATE, account_id: "52", vendor_id: "9", doc_number: "80669", amount_abs: 36, ...o } }));
  assert.equal(pickExistingCreate([P10566], sw()).Id, "10566");
  assert.equal(pickExistingCreate([P10566], sw({ amount_abs: 36.5 })), null);
  assert.equal(pickExistingCreate([P10566], sw({ credit: true })), null);
});

test("pickExistingCreate: our own earlier entry wins a tie", () => {
  const r = parseCompleteRequest(createPayload());
  const theirs = { ...P10563, Id: "20001", DocNumber: "700665392", TotalAmt: 1146.75, PrivateNote: "Materials purchased" };
  const ours = { ...theirs, Id: "20002", PrivateNote: `Spenard 700665392 (from the job receipts app) [r:${RECEIPT}]` };
  assert.equal(pickExistingCreate([theirs, ours], r).Id, "20002");
  assert.equal(pickExistingCreate([{ ...theirs, Id: "20009" }, theirs], r).Id, "20001", "else the oldest");
  assert.equal(pickExistingCreate([], r), null);
});

/* ============================================================
   completePurchase: the photo
   ============================================================ */

test("attachPlan: nothing linked → upload every page", () => {
  assert.deepEqual(attachPlan([], RECEIPT, 1), { action: "upload", pages: [1], ours: 0 });
  assert.deepEqual(attachPlan([], RECEIPT, 3), { action: "upload", pages: [1, 2, 3], ours: 0 });
});

test("attachPlan: the bookkeeper's document is left alone (not an error)", () => {
  assert.deepEqual(attachPlan([A10563], RECEIPT, 1), { action: "skip", reason: "already_attached" });
  // another receipt's photo of ours is someone else's document too
  assert.deepEqual(attachPlan([{ FileName: "Home Depot p1 [r:another].jpg" }], RECEIPT, 1), { action: "skip", reason: "already_attached" });
});

test("attachPlan: our own upload is adopted, and only missing pages go up", () => {
  const p1 = { FileName: `Home Depot 2026-09-30 p1 [r:${RECEIPT}].jpg` };
  const p3 = { FileName: `Home Depot 2026-09-30 p3 [r:${RECEIPT}].jpg` };
  assert.deepEqual(attachPlan([p1], RECEIPT, 1), { action: "adopt", ours: 1 });
  assert.deepEqual(attachPlan([p1, A10563], RECEIPT, 1), { action: "adopt", ours: 1 });
  assert.deepEqual(attachPlan([p1, p3], RECEIPT, 3), { action: "upload", pages: [2], ours: 2 });
  // renamed in QuickBooks but still carrying the marker: counted as page 1
  assert.deepEqual(attachPlan([{ FileName: `receipt [r:${RECEIPT}].jpg` }], RECEIPT, 2), { action: "upload", pages: [2], ours: 1 });
});

test("mediaHash and storageMissing", () => {
  assert.equal(mediaHash(marker(SHA1, PHOTO1)), SHA1);
  assert.throws(() => mediaHash("media:xyz:1"), (e) => e.code === "bad_request");
  assert.equal(storageMissing(404, ""), true);
  assert.equal(storageMissing(400, '{"statusCode":"404","error":"not_found","message":"Object not found"}'), true);
  assert.equal(storageMissing(400, '{"error":"InvalidJWT"}'), false, "a bad key is not a missing photo");
  assert.equal(storageMissing(500, "not found"), false);
});

test("parseDataUrl: JPEG, PNG and PDF data URLs become their bytes", () => {
  const j = parseDataUrl(PHOTO1);
  assert.equal(j.contentType, "image/jpeg");
  assert.deepEqual([...j.bytes], [...JPEG]);
  assert.equal(parseDataUrl(PHOTO2).contentType, "image/png");
  assert.deepEqual([...parseDataUrl(dataUrl("application/pdf", PDF)).bytes], [...PDF]);
  // image/jpg is JPEG; a charset parameter and line breaks are tolerated
  assert.equal(parseDataUrl(dataUrl("image/jpg", JPEG)).contentType, "image/jpeg");
  const b64 = Buffer.from(JPEG).toString("base64");
  assert.deepEqual([...parseDataUrl(`data:image/jpeg;charset=utf-8;base64,${b64.slice(0, 8)}\n${b64.slice(8)}`).bytes], [...JPEG]);
});

test("parseDataUrl: the type gate", () => {
  const code = (t) => { try { parseDataUrl(t); return "ok"; } catch (e) { assert.equal(e.permanent, true); return e.code; } };
  assert.equal(code(dataUrl("image/gif", Uint8Array.from([0x47, 0x49, 0x46]))), "photo_type");
  assert.equal(code(dataUrl("image/heic", JPEG)), "photo_type");
  assert.equal(code(dataUrl("text/html", enc("<script>"))), "photo_type");
  assert.equal(code("data:image/jpeg,%FF%D8"), "photo_unreadable", "not base64");
  assert.equal(code("/9j/4AAQSkZJRg=="), "photo_unreadable", "bare base64 is not a data URL");
  assert.equal(code("data:image/jpeg;base64,@@@@"), "photo_unreadable");
  assert.equal(code(dataUrl("image/jpeg", PNG)), "photo_unreadable", "the bytes must be what the URL says");
  assert.equal(code(dataUrl("image/png", JPEG)), "photo_unreadable");
});

test("parseDataUrl: the size gate, checked before decoding", () => {
  const big = new Uint8Array(64);
  big.set(JPEG);
  assert.equal(parseDataUrl(dataUrl("image/jpeg", big), 64).bytes.length, 64);
  assert.throws(() => parseDataUrl(dataUrl("image/jpeg", new Uint8Array(65).fill(0xff)), 64), (e) => e.code === "photo_too_big");
  // ~21 MB of base64 text is refused without being decoded
  const t0 = Date.now();
  assert.throws(() => parseDataUrl("data:image/jpeg;base64," + "/".repeat(Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 16)),
    (e) => e.code === "photo_too_big" && /20 MB/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
});

test("photoFileName: '<file_base> p<n> [r:<receipt id>].<ext>', base cleaned", () => {
  assert.equal(photoFileName("Home Depot 2026-09-30 1303-00001-50615", 1, RECEIPT, "image/jpeg"),
    `Home Depot 2026-09-30 1303-00001-50615 p1 [r:${RECEIPT}].jpg`);
  assert.equal(photoFileName('C&R "Pipe"/Supply: 10/06', 2, "r1", "image/png"), "C&R Pipe Supply 10 06 p2 [r:r1].png");
  assert.equal(photoFileName("", 1, "r1", "application/pdf"), "Receipt p1 [r:r1].pdf");
  assert.equal(photoFileName("x".repeat(300), 1, "r1", "image/jpeg").length, 120 + " p1 [r:r1].jpg".length);
});

test("attachMetadata: linked to the Purchase, not sent with the customer's copy", () => {
  assert.deepEqual(attachMetadata("10577", "a.jpg", "image/jpeg"), {
    AttachableRef: [{ EntityRef: { type: "Purchase", value: "10577" }, IncludeOnSend: false }],
    FileName: "a.jpg", ContentType: "image/jpeg",
  });
});

test("multipartBody: the exact bytes QuickBooks /upload reads, file bytes raw", () => {
  const meta = attachMetadata("10577", `HD p1 [r:${RECEIPT}].jpg`, "image/jpeg");
  const body = multipartBody("B0UND", meta, `HD p1 [r:${RECEIPT}].jpg`, "image/jpeg", JPEG);
  const head =
    "--B0UND\r\n" +
    'Content-Disposition: form-data; name="file_metadata_01"\r\n' +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(meta) + "\r\n" +
    "--B0UND\r\n" +
    `Content-Disposition: form-data; name="file_content_01"; filename="HD p1 [r:${RECEIPT}].jpg"\r\n` +
    "Content-Type: image/jpeg\r\n\r\n";
  const h = enc(head);
  assert.deepEqual([...body.slice(0, h.length)], [...h]);
  assert.deepEqual([...body.slice(h.length, h.length + JPEG.length)], [...JPEG], "0xFF stays one byte, not UTF-8");
  assert.equal(latin1(body.slice(h.length + JPEG.length)), "\r\n--B0UND--\r\n");
  assert.equal(body.length, h.length + JPEG.length + "\r\n--B0UND--\r\n".length);
});

test("multipartBody: a quote in a file name cannot break the header", () => {
  const body = latin1(multipartBody("B", {}, 'a"b\r\nc.jpg', "image/jpeg", JPEG));
  assert.match(body, /filename="abc\.jpg"\r\n/);
});

test("uploadedAttachable: the new id, a Fault refused, silence retried", () => {
  assert.deepEqual(uploadedAttachable({ AttachableResponse: [{ Attachable: { Id: "1000009001", FileName: "a.jpg" } }], time: "t" }),
    { id: "1000009001", fileName: "a.jpg" });
  assert.throws(() => uploadedAttachable({ AttachableResponse: [{ Fault: { Error: [{ Message: "m", Detail: "File too large", code: "6000" }] } }] }),
    (e) => e.code === "upload_refused" && e.permanent && /File too large/.test(e.message));
  assert.throws(() => uploadedAttachable({}), (e) => e.code === "upload_unclear" && !e.permanent);
});

/* ============================================================
   completePurchase end to end, against an in-memory QuickBooks
   ============================================================ */

/** A QuickBooks with a few expenses and attachments, and the I/O
    completePurchase is given. A sparse update checks the SyncToken the way
    QuickBooks does (5010 on a stale one) and replaces Line; `edits` makes
    someone else save the expense right after each of our next reads. */
const JOB = "a628eea5-0000-4000-8000-000000000001";
function qbo({ purchases = [P10577], attachables = [], photos = { [SHA1]: PHOTO1 }, links = { [JOB]: "112" },
  uploadFails = null } = {}) {
  const w = {
    purchases: new Map(purchases.map((p) => [String(p.Id), structuredClone(p)])),
    attachables: structuredClone(attachables), photos, links, calls: [], posts: [], uploads: [], edits: 0, nextId: 10700,
  };
  w.io = {
    query: async (q) => {
      w.calls.push("query");
      let m = /AttachableRef\.EntityRef\.Type = '(\w+)' and AttachableRef\.EntityRef\.Value = '(\d+)'/.exec(q);
      if (m) return { QueryResponse: { Attachable: w.attachables.filter((a) => (a.AttachableRef ?? []).some((r) =>
        r.EntityRef?.type === m[1] && r.EntityRef?.value === m[2])) } };
      m = /DocNumber LIKE '(\d+)%'/.exec(q);
      if (m) return { QueryResponse: { Purchase: [...w.purchases.values()].filter((p) => String(p.DocNumber ?? "").startsWith(m[1])) } };
      throw new Error("unexpected query " + q);
    },
    getPurchase: async (id) => {
      w.calls.push("get:" + id);
      const p = w.purchases.get(id);
      if (!p) throw new QboError(400, fault("610", "Object Not Found : Something you're trying to use has been made inactive or deleted."));
      const read = structuredClone(p);
      if (w.edits > 0) { w.edits--; p.SyncToken = String(Number(p.SyncToken) + 1); }
      return read;
    },
    postPurchase: async (body, requestId) => {
      w.posts.push({ body: structuredClone(body), requestId });
      if (body.Id) {
        w.calls.push("update:" + body.Id);
        const p = w.purchases.get(body.Id);
        if (body.SyncToken !== p.SyncToken) throw new QboError(400, fault("5010", "Stale Object Error"));
        Object.assign(p, { Line: body.Line, SyncToken: String(Number(p.SyncToken) + 1) });
        return structuredClone(p);
      }
      w.calls.push("create");
      const p = { ...structuredClone(body), Id: String(w.nextId++), SyncToken: "0",
        TotalAmt: body.Line.reduce((a, l) => a + l.Amount, 0) };
      w.purchases.set(p.Id, p);
      return structuredClone(p);
    },
    photo: async (hash) => { w.calls.push("photo"); return w.photos[hash] ?? null; },
    upload: async (body, contentType) => {
      w.calls.push("upload");
      if (uploadFails) throw uploadFails;
      const text = latin1(body);
      const meta = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4, text.indexOf("\r\n--B")));
      w.uploads.push({ body, contentType, meta });
      const a = { Id: String(1000009000 + w.uploads.length), FileName: meta.FileName, ContentType: meta.ContentType, AttachableRef: meta.AttachableRef };
      w.attachables.push(a);
      return { AttachableResponse: [{ Attachable: a }], time: "2026-10-08T07:50:00-07:00" };
    },
    jobLink: async (jobId) => (w.links[jobId] ? { qbo_customer_id: w.links[jobId] } : null),
    boundary: () => "B" + w.uploads.length,
  };
  return w;
}
const fails = async (p, check) => {
  try { await p; } catch (e) { check(e); return; }
  assert.fail("expected a refusal");
};

test("10577: tags every line to the job and attaches the photo", async () => {
  const w = qbo();
  const r = await completePurchase(payload(), w.io);
  assert.deepEqual(r, { ok: true, purchaseId: "10577", syncToken: "1", tagged: "done", attached: 1, already_attached: false,
    adopted: { create: false, tag: false, attach: 0 } });
  // the photo is read and checked once the tag is decided, before it is written
  assert.deepEqual(w.calls, ["get:10577", "query", "photo", "update:10577", "upload"]);
  assert.deepEqual(w.posts[0].body, tagUpdateBody(P10577, "112", "412739523"));
  assert.equal(w.posts[0].requestId, undefined, "an update needs no requestid: the SyncToken guards it");
  const line = w.purchases.get("10577").Line[0];
  assert.deepEqual(line.AccountBasedExpenseLineDetail.CustomerRef, { value: "112" });
  assert.deepEqual(line.ProjectRef, { value: "412739523" });
  assert.equal(line.AccountBasedExpenseLineDetail.AccountRef.value, "42", "account untouched");
  assert.equal(line.AccountBasedExpenseLineDetail.ClassRef.value, "1000000001", "class untouched");
  assert.equal(line.Amount, 1369.5, "amount untouched");
  const up = w.uploads[0];
  assert.equal(up.contentType, "multipart/form-data; boundary=B0");
  assert.deepEqual(up.meta, attachMetadata("10577", `Home Depot 2026-09-30 1303-00001-50615 p1 [r:${RECEIPT}].jpg`, "image/jpeg"));
  assert.ok(latin1(up.body).includes(latin1(JPEG)), "the photo's bytes are in the body");
});

test("the same approval again (a retry after a lost answer) changes nothing and reports adoption", async () => {
  const w = qbo();
  await completePurchase(payload(), w.io);
  w.calls.length = 0;
  // the outbox payload still says SyncToken 0; QuickBooks is at 1 now, same total
  const r = await completePurchase(payload(), w.io);
  assert.deepEqual(r, { ok: true, purchaseId: "10577", syncToken: "1", tagged: "adopted", attached: 0, already_attached: false,
    adopted: { create: false, tag: true, attach: 1 } });
  assert.deepEqual(w.calls, ["get:10577", "query"]);
  assert.equal(w.posts.length, 1);
  assert.equal(w.uploads.length, 1);
});

test("a stale object (someone saved between our read and write) gets one fresh read and one more try", async () => {
  const w = qbo();
  w.edits = 1;
  const r = await completePurchase(payload({ changes: ["tag"] }), w.io);
  assert.equal(r.tagged, "done");
  assert.deepEqual(w.calls, ["get:10577", "update:10577", "get:10577", "update:10577"]);
  assert.equal(w.posts[1].body.SyncToken, "1", "the retry writes on the fresh SyncToken");
});

test("stale twice: retried later by the outbox lane, nothing written", async () => {
  const w = qbo();
  w.edits = 2;
  await fails(completePurchase(payload(), w.io), (e) => {
    assert.equal(e.code, "stale_object");
    assert.equal(e.permanent, false);
    assert.equal(e.status, 502);
  });
  assert.equal(w.purchases.get("10577").Line[0].AccountBasedExpenseLineDetail.CustomerRef, undefined);
  assert.equal(w.uploads.length, 0);
});

test("changed in QuickBooks since filing (new SyncToken and new total): refused, nothing written", async () => {
  const w = qbo({ purchases: [{ ...P10577, SyncToken: "3", TotalAmt: 1400 }] });
  await fails(completePurchase(payload(), w.io), (e) => {
    assert.equal(e.code, "changed_in_qbo");
    assert.equal(e.permanent, true);
    assert.equal(e.status, 409);
  });
  assert.deepEqual(w.calls, ["get:10577"]);
});

test("a new SyncToken with the same total (a memo fixed, a doc attached) still tags", async () => {
  const w = qbo({ purchases: [{ ...P10577, SyncToken: "2", PrivateNote: "fixed" }] });
  const r = await completePurchase(payload({ changes: ["tag"] }), w.io);
  assert.equal(r.tagged, "done");
  assert.equal(w.posts[0].body.SyncToken, "2");
});

test("tagged to another job: refused with the customer's name, the photo is not attached", async () => {
  const w = qbo({ purchases: [P10563], links: { [JOB]: "444" } });
  await fails(completePurchase(payload({ qbo_txn_id: "10563", expect_sync_token: "1", expect_total: 212.28, customer_id: "444" }), w.io), (e) => {
    assert.equal(e.code, "tagged_other");
    assert.equal(e.permanent, true);
    assert.match(e.message, /Pollen Apartments/);
  });
  assert.deepEqual(w.calls, ["get:10563"]);
});

test("partly tagged: refused", async () => {
  const mixed = { ...P10563, Line: [P10563.Line[0], { ...P10577.Line[0], Id: "2" }] };
  const w = qbo({ purchases: [mixed] });
  await fails(completePurchase(payload({ qbo_txn_id: "10563", expect_sync_token: "1", expect_total: 212.28 }), w.io),
    (e) => assert.equal(e.code, "partly_tagged"));
  assert.equal(w.posts.length, 0);
});

test("attach-only on the hand-entered Spenard invoice: tag not needed, the vendor PDF is left alone", async () => {
  const w = qbo({ purchases: [P10563], attachables: [A10563] });
  const r = await completePurchase(payload({ qbo_txn_id: "10563", expect_sync_token: "1", expect_total: 212.28, changes: ["attach"] }), w.io);
  assert.deepEqual(r, { ok: true, purchaseId: "10563", syncToken: "1", tagged: "not_needed", attached: 0, already_attached: true,
    adopted: { create: false, tag: false, attach: 0 } });
  assert.deepEqual(w.calls, ["get:10563", "query"]);
});

test("attach-only on a job with no QuickBooks link: no tag questions asked", async () => {
  const w = qbo();
  const r = await completePurchase(payload({ changes: ["attach"], customer_id: "", project_ref: null }), w.io);
  assert.equal(r.tagged, "not_needed");
  assert.equal(r.attached, 1);
  assert.equal(w.posts.length, 0);
});

test("the photo is gone from storage: refused as photo_missing, nothing uploaded", async () => {
  const w = qbo({ photos: {} });
  await fails(completePurchase(payload({ changes: ["attach"] }), w.io), (e) => {
    assert.equal(e.code, "photo_missing");
    assert.equal(e.permanent, true);
  });
  assert.equal(w.uploads.length, 0);
});

test("two pages: every page passes the gate before the first upload", async () => {
  const w = qbo({ photos: { [SHA1]: PHOTO1, [SHA2]: dataUrl("image/gif", Uint8Array.from([0x47, 0x49, 0x46])) } });
  await fails(completePurchase(payload({ changes: ["attach"], photo_refs: [marker(SHA1, PHOTO1), marker(SHA2, "x")] }), w.io),
    (e) => assert.equal(e.code, "photo_type"));
  assert.equal(w.uploads.length, 0);
  // fixed: both go up, in order, numbered
  w.photos[SHA2] = PHOTO2;
  const r = await completePurchase(payload({ changes: ["attach"], photo_refs: [marker(SHA1, PHOTO1), marker(SHA2, PHOTO2)] }), w.io);
  assert.equal(r.attached, 2);
  assert.deepEqual(w.uploads.map((u) => u.meta.FileName),
    [`Home Depot 2026-09-30 1303-00001-50615 p1 [r:${RECEIPT}].jpg`, `Home Depot 2026-09-30 1303-00001-50615 p2 [r:${RECEIPT}].png`]);
});

test("a photo that cannot go (HEIC) refuses a tag + attach before the tag is written", async () => {
  const heic = dataUrl("image/heic", Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const w = qbo({ photos: { [SHA1]: heic } });
  await fails(completePurchase(payload(), w.io), (e) => {
    assert.equal(e.code, "photo_type");
    assert.equal(e.permanent, true);
  });
  assert.equal(w.posts.length, 0, "the expense is not tagged");
  assert.equal(w.purchases.get("10577").Line[0].AccountBasedExpenseLineDetail.CustomerRef, undefined);
  assert.deepEqual(w.calls, ["get:10577", "query", "photo"]);
  // and a photo gone from storage the same way
  const gone = qbo({ photos: {} });
  await fails(completePurchase(payload(), gone.io), (e) => assert.equal(e.code, "photo_missing"));
  assert.equal(gone.posts.length, 0);
});

test("a photo that cannot go refuses a store entry before the expense is created", async () => {
  const heic = dataUrl("image/heic", Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const w = qbo({ purchases: [P10563], photos: { [SHA1]: heic } });
  await fails(completePurchase(createPayload(), w.io), (e) => assert.equal(e.code, "photo_type"));
  assert.equal(w.posts.length, 0, "no expense is created");
  assert.deepEqual(w.calls, ["query", "photo"]);
});

test("an expense that already has the bookkeeper's document reads no photo, and still tags", async () => {
  const w = qbo({ attachables: [{ ...A10563, AttachableRef: [{ EntityRef: { type: "Purchase", value: "10577" } }] }], photos: {} });
  const r = await completePurchase(payload(), w.io);
  assert.equal(r.tagged, "done");
  assert.equal(r.already_attached, true);
  assert.deepEqual(w.calls, ["get:10577", "query", "update:10577"]);
});

test("QuickBooks refuses the upload after the tag or the new entry went in: ok, with the write and attach_error", async () => {
  const refused = new QboError(400, fault("2010", "Unsupported file"));
  let w = qbo({ uploadFails: refused });
  let r = await completePurchase(payload(), w.io);
  assert.equal(r.ok, true);
  assert.equal(r.purchaseId, "10577");
  assert.equal(r.syncToken, "1");
  assert.equal(r.tagged, "done");
  assert.equal(r.attached, 0);
  assert.equal(r.attach_error.code, "qbo_refused");
  assert.match(r.attach_error.message, /Unsupported file/);
  // a new store entry: its id comes back, so the receipt records the expense the app created
  w = qbo({ purchases: [P10563], uploadFails: refused });
  r = await completePurchase(createPayload(), w.io);
  assert.equal(r.purchaseId, "10700");
  assert.equal(r.tagged, "done");
  assert.equal(r.attach_error.code, "qbo_refused");
  // a Fault inside a 200 the same way
  w = qbo();
  w.io.upload = async () => ({ AttachableResponse: [{ Fault: { Error: [{ Message: "m", Detail: "bad file" }] } }] });
  r = await completePurchase(payload(), w.io);
  assert.equal(r.attach_error.code, "upload_refused");
  // nothing written (attach only): still a refusal; a retryable trouble is still retried
  w = qbo({ uploadFails: refused });
  await fails(completePurchase(payload({ changes: ["attach"], customer_id: "", job_id: "" }), w.io),
    (e) => assert.equal(toCompleteError(e).code, "qbo_refused"));
  w = qbo({ uploadFails: new QboError(503, "down") });
  await fails(completePurchase(payload(), w.io), (e) => assert.equal(toCompleteError(e).permanent, false));
});

test("the job relinked or unlinked since the approval: refused as relinked before QuickBooks is read", async () => {
  for (const links of [{ [JOB]: "445" }, {}]) {
    const w = qbo({ links });
    await fails(completePurchase(payload(), w.io), (e) => {
      assert.equal(e.code, "relinked");
      assert.equal(e.permanent, true);
      assert.match(e.message, links[JOB] ? /now linked to QuickBooks project 445 \(this approval named 112\); nothing was written/
        : /no longer linked to a QuickBooks project/);
    });
    assert.deepEqual(w.calls, []);
  }
  const c = qbo({ purchases: [P10563], links: { [JOB]: "445" } });
  await fails(completePurchase(createPayload(), c.io), (e) => assert.equal(e.code, "relinked"));
  assert.deepEqual(c.calls, []);
  // attach only asks nothing of the link
  const a = qbo({ links: {} });
  assert.equal((await completePurchase(payload({ changes: ["attach"], customer_id: "" }), a.io)).attached, 1);
});

test("store entry: the number lookup reads every page, so the bookkeeper's entry past the first page is found", async () => {
  const w = qbo({ purchases: [P10563] });
  const pages = [];
  const theirs = { ...structuredClone(P10563), Id: "10699", DocNumber: "700665392", AccountRef: { value: "53" }, TotalAmt: 1146.75 };
  w.io.query = async (q) => {
    w.calls.push("query");
    const m = /startposition (\d+)/.exec(q);
    if (/DocNumber LIKE/.test(q)) {
      pages.push(Number(m[1]));
      if (m[1] === "1") return { QueryResponse: { Purchase: Array.from({ length: PAGE }, (_, i) => ({ Id: String(20000 + i), DocNumber: "7006" + i, AccountRef: { value: "53" } })) } };
      return { QueryResponse: { Purchase: [theirs] } };
    }
    return { QueryResponse: {} };
  };
  w.purchases.set("10699", theirs);
  const r = await completePurchase(createPayload(), w.io);
  assert.deepEqual(pages, [1, PAGE + 1]);
  assert.equal(r.purchaseId, "10699");
  assert.equal(r.adopted.create, true);
  assert.equal(w.calls.includes("create"), false);
});

test("the expense was deleted in QuickBooks: refused as purchase_missing", async () => {
  const w = qbo({ purchases: [] });
  await fails(completePurchase(payload(), w.io), (e) => {
    assert.equal(e.code, "purchase_missing");
    assert.equal(e.permanent, true);
  });
});

test("a malformed payload never reaches QuickBooks", async () => {
  const w = qbo();
  await fails(completePurchase(payload({ customer_id: "" }), w.io), (e) => assert.equal(e.code, "bad_request"));
  assert.deepEqual(w.calls, []);
});

test("store entry: not in QuickBooks yet → one new expense, with the requestid, then the photo", async () => {
  const w = qbo({ purchases: [P10563] });
  const r = await completePurchase(createPayload(), w.io);
  assert.deepEqual(r, { ok: true, purchaseId: "10700", syncToken: "0", tagged: "done", attached: 1, already_attached: false,
    adopted: { create: false, tag: false, attach: 0 } });
  assert.deepEqual(w.calls, ["query", "photo", "create", "query", "upload"]);
  assert.deepEqual(w.posts[0].body, createBody(parseCompleteRequest(createPayload())));
  assert.equal(w.posts[0].requestId, await requestIdFor(RECEIPT, PROPOSAL));
  assert.equal(w.uploads[0].meta.AttachableRef[0].EntityRef.value, "10700");
});

test("store entry retried after a lost answer: our own entry is found by its number, never a second one", async () => {
  const w = qbo({ purchases: [P10563] });
  await completePurchase(createPayload(), w.io);
  w.calls.length = 0;
  const r = await completePurchase(createPayload(), w.io);
  assert.equal(r.purchaseId, "10700");
  assert.equal(r.tagged, "adopted");
  assert.deepEqual(r.adopted, { create: true, tag: true, attach: 1 });
  assert.deepEqual(w.calls, ["query", "get:10700", "query"]);
  assert.equal(w.posts.length, 1);
});

test("store entry the bookkeeper already made (Sherwin 10566, longer DocNumber): adopted, tag and PDF left as they are", async () => {
  const w = qbo({ purchases: [P10566], attachables: [A10566] });
  const r = await completePurchase(createPayload({ create: { ...CREATE, account_id: "52", vendor_id: "9", doc_number: "80669",
    amount_abs: 36, txn_date: "2026-09-28" } }), w.io);
  assert.deepEqual(r, { ok: true, purchaseId: "10566", syncToken: "2", tagged: "adopted", attached: 0, already_attached: true,
    adopted: { create: true, tag: true, attach: 0 } });
  assert.equal(w.posts.length, 0);
});

test("store entry adopted but untagged: tagged without a staleness test (it was never seen at filing)", async () => {
  const untagged = { ...structuredClone(P10577), Id: "10601", SyncToken: "5", AccountRef: { value: "53" }, DocNumber: "700665392", TotalAmt: 1146.75 };
  const w = qbo({ purchases: [untagged] });
  const r = await completePurchase(createPayload({ changes: ["create"] }), w.io);
  assert.equal(r.tagged, "done");
  assert.equal(r.adopted.create, true);
  assert.equal(w.posts[0].body.Id, "10601");
});

test("store entry adopted but tagged to another job: refused", async () => {
  const w = qbo({ purchases: [{ ...P10563, DocNumber: "700665392" }], links: { [JOB]: "444" } });
  await fails(completePurchase(createPayload({ customer_id: "444" }), w.io), (e) => assert.equal(e.code, "tagged_other"));
  assert.equal(w.posts.length, 0);
});

/* ============================================================
   bills (a dump ticket) and receipts paid in parts (a rental)
   ============================================================ */

test("billsQuery: the window, paged like the expenses", () => {
  assert.equal(billsQuery("2026-09-01", "2026-10-08", 1),
    "select * from Bill where TxnDate >= '2026-09-01' and TxnDate <= '2026-10-08' startposition 1 maxresults 1000");
});

test("attachmentsByPurchase: with 'Bill', only links to a bill count", () => {
  const m = attachmentsByPurchase([A10563, A10625, A_ORPHAN], "Bill");
  assert.deepEqual([...m.keys()], ["10625"]);
  assert.deepEqual(m.get("10625"), ["FNSB 01286734.jpg"]);
});

test("compactBill: the FNSB dump ticket reads like an expense, with its vendor and A/P account", () => {
  assert.deepEqual(compactBill(B10625, ["FNSB 01286734.jpg"]), {
    txnType: "Bill", id: "10625", syncToken: "0", txnDate: "2026-10-01", total: 34.04, credit: false, paymentType: "",
    accountId: "99", accountName: "Accounts Payable (A/P)", vendorId: "355", vendorName: "FNSB Solid Waste",
    docNumber: "01286734", note: "CONSTRUCTION MATRL",
    lines: [{ id: "1", amount: 34.04, detailType: "AccountBasedExpenseLineDetail", accountId: "226",
      accountName: "Cost of Goods Sold:Waste disposal (Customer)", classId: "1000000001", customerId: "", customerName: "", projectRef: "" }],
    attachments: ["FNSB 01286734.jpg"], hasAttachment: true,
  });
  assert.deepEqual(compactBill({ Id: "1" }).lines, [], "an odd row does not throw");
});

test("parseCompleteRequest: a bill is only read, never written: every Bill payload is a permanent bad_request", () => {
  for (const b of [billPayload(), billPayload({ changes: ["attach"], customer_id: "" }), billPayload({ changes: ["tag"] }),
    billPayload({ qbo_txn_id: "", changes: ["create", "attach"], create: CREATE })]) {
    assert.throws(() => parseCompleteRequest(b), (e) => e instanceof CompleteError && e.code === "bad_request" && e.permanent &&
      e.status === 409 && /a bill is only read/.test(e.message), JSON.stringify(b.changes));
  }
});

test("parseCompleteRequest: a receipt in two charges reads each charge; the top level names none", () => {
  const r = parseCompleteRequest(partsPayload());
  assert.equal(r.txnId, "");
  assert.deepEqual(r.parts, [
    { txnId: "10615", expectSyncToken: "0", expectTotal: 126.9, changes: ["tag", "attach"] },
    { txnId: "10661", expectSyncToken: "0", expectTotal: 224.1, changes: ["tag", "attach"] },
  ]);
  // a charge already tagged by hand needs only the photo
  const mixed = parseCompleteRequest(partsPayload({ parts: [PART("10615", 126.9, { changes: ["attach"] }), PART("10661", 224.1)] }));
  assert.deepEqual(mixed.parts.map((x) => x.changes), [["attach"], ["tag", "attach"]]);
});

test("parseCompleteRequest: every malformed receipt in parts is a permanent bad_request", () => {
  const bad = [
    partsPayload({ parts: [PART("10615", 126.9)] }),
    partsPayload({ parts: [PART("1", 1), PART("2", 1), PART("3", 1), PART("4", 1)] }),
    partsPayload({ parts: "10615,10661" }),
    partsPayload({ parts: [PART("10615", 126.9), PART("10615", 126.9)] }),
    partsPayload({ qbo_txn_id: "10615" }), partsPayload({ expect_sync_token: "0" }),
    partsPayload({ qbo_txn_type: "Bill" }),
    partsPayload({ changes: ["create", "attach"], create: CREATE }),
    partsPayload({ parts: [PART("10615", 126.9, { qbo_txn_id: "" }), PART("10661", 224.1)] }),
    partsPayload({ parts: [PART("10615", 126.9, { expect_sync_token: "" }), PART("10661", 224.1)] }),
    partsPayload({ parts: [PART("10615", "lots"), PART("10661", 224.1)] }),
    partsPayload({ parts: [PART("10615", 126.9, { changes: ["create"] }), PART("10661", 224.1)] }),
    partsPayload({ changes: ["tag"], parts: [PART("10615", 126.9, { changes: ["tag", "attach"] }), PART("10661", 224.1, { changes: ["tag"] })] }),
    partsPayload({ parts: [PART("10615", 126.9, { changes: ["tag"] }), PART("10661", 224.1, { changes: ["tag"] })] }),
  ];
  for (const b of bad) {
    assert.throws(() => parseCompleteRequest(b), (e) => e instanceof CompleteError && e.code === "bad_request" && e.permanent,
      JSON.stringify(b.parts ?? b).slice(0, 160));
  }
});

test("a v1 payload sent to this proxy without parts still names one expense (nothing changed for old rows)", () => {
  const r = parseCompleteRequest(payload());
  assert.equal(r.txnId, "10577");
  assert.equal(r.parts, null);
});

test("tagUpdateBody and attachMetadata only ever name an expense", () => {
  assert.deepEqual(Object.keys(tagUpdateBody(P10577, "112", "412739523")), ["Id", "SyncToken", "sparse", "PaymentType", "Line"]);
  assert.equal(attachMetadata("10625", "a.jpg", "image/jpeg").AttachableRef[0].EntityRef.type, "Purchase");
});

test("a bill: completePurchase refuses it as bad_request before anything is read or written", async () => {
  // an expense with the bill's id is in the books too: it is not touched either
  const same = { ...structuredClone(P10577), Id: "10625" };
  for (const b of [billPayload(), billPayload({ changes: ["attach"], customer_id: "" })]) {
    const w = qbo({ purchases: [same], links: { [JOB]: "112" } });
    const link = w.io.jobLink;
    w.io.jobLink = async (job) => { w.calls.push("jobLink"); return link(job); };
    await fails(completePurchase(b, w.io), (e) => {
      assert.equal(e.code, "bad_request");
      assert.ok(e.permanent);
      assert.equal(e.status, 409);
      assert.match(e.message, /a bill is only read/);
    });
    assert.deepEqual(w.calls, [], "nothing fetched: no job link, no read, no photo");
    assert.equal(w.posts.length, 0);
    assert.equal(w.uploads.length, 0);
    assert.equal(w.purchases.get("10625").SyncToken, "0");
  }
});

test("two charges: each read and checked first, then each tagged and given the same photo", async () => {
  const w = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "502" } });
  const r = await completePurchase(partsPayload(), w.io);
  assert.equal(r.ok, true);
  assert.equal(r.part_error, undefined);
  assert.equal(r.purchaseId, "10615");
  assert.equal(r.tagged, "done");
  assert.equal(r.attached, 2);
  assert.deepEqual(r.parts, [
    { purchaseId: "10615", syncToken: "1", tagged: "done", attached: 1, already_attached: false },
    { purchaseId: "10661", syncToken: "1", tagged: "done", attached: 1, already_attached: false },
  ]);
  assert.deepEqual(w.calls, ["get:10615", "get:10661", "photo",
    "get:10615", "query", "update:10615", "upload", "get:10661", "query", "update:10661", "upload"], "the photo is read once");
  for (const id of ["10615", "10661"]) {
    const line = w.purchases.get(id).Line[0];
    assert.deepEqual(line.AccountBasedExpenseLineDetail.CustomerRef, { value: "502" });
    assert.deepEqual(line.ProjectRef, { value: "807760362" });
  }
  assert.deepEqual(w.uploads.map((u) => [u.meta.AttachableRef[0].EntityRef.value, u.meta.FileName]), [
    ["10615", `Rental Zone 2026-10-07 R284290 p1 [r:${RZ}].jpg`],
    ["10661", `Rental Zone 2026-10-07 R284290 p1 [r:${RZ}].jpg`],
  ]);
  // a retry after a lost answer adopts both and writes nothing
  const posts = w.posts.length, ups = w.uploads.length;
  const again = await completePurchase(partsPayload(), w.io);
  assert.equal(again.tagged, "adopted");
  assert.deepEqual(again.adopted, { create: false, tag: true, attach: 2 });
  assert.equal(w.posts.length, posts);
  assert.equal(w.uploads.length, ups);
});

test("two charges: the second tagged to another job refuses the whole receipt with nothing written", async () => {
  const other = structuredClone(P10661);
  other.Line[0].AccountBasedExpenseLineDetail.CustomerRef = { value: "444", name: "1192 Bemis Ct." };
  const w = qbo({ purchases: [P10615, other], links: { [RZ_JOB]: "502" } });
  await fails(completePurchase(partsPayload(), w.io), (e) => {
    assert.equal(e.code, "tagged_other");
    assert.ok(e.permanent);
    assert.match(e.message, /^part 2 of 2 \(expense 10661\): expense 10661 is already tagged to 1192 Bemis Ct\./);
  });
  assert.equal(w.posts.length, 0);
  assert.equal(w.uploads.length, 0);
  assert.equal(w.purchases.get("10615").SyncToken, "0");
});

test("two charges: one changed since the card (new total) refuses before anything is written", async () => {
  const changed = { ...structuredClone(P10661), SyncToken: "1", TotalAmt: 230 };
  const w = qbo({ purchases: [P10615, changed], links: { [RZ_JOB]: "502" } });
  await fails(completePurchase(partsPayload(), w.io), (e) => {
    assert.equal(e.code, "changed_in_qbo");
    assert.match(e.message, /^part 2 of 2 \(expense 10661\)/);
  });
  assert.equal(w.posts.length, 0);
});

test("two charges: the photo gone refuses before anything is written; a relink refuses before anything is read", async () => {
  const w = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "502" }, photos: {} });
  await fails(completePurchase(partsPayload(), w.io), (e) => assert.equal(e.code, "photo_missing"));
  assert.equal(w.posts.length, 0);
  const moved = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "444" } });
  await fails(completePurchase(partsPayload(), moved.io), (e) => assert.equal(e.code, "relinked"));
  assert.deepEqual(moved.calls, []);
});

test("two charges: a charge QuickBooks no longer has is purchase_missing, named", async () => {
  const w = qbo({ purchases: [P10615], links: { [RZ_JOB]: "502" } });
  await fails(completePurchase(partsPayload(), w.io), (e) => {
    assert.equal(e.code, "purchase_missing");
    assert.match(e.message, /^part 2 of 2 \(expense 10661\): QuickBooks has no expense 10661/);
  });
  assert.equal(w.posts.length, 0);
});

test("two charges: an upload refused on the second charge is reported with the writes, not as nothing done", async () => {
  const refused = new QboError(400, fault("6000", "File too large"));
  const w = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "502" } });
  let n = 0;
  const up = w.io.upload;
  w.io.upload = async (...a) => { if (++n === 2) throw refused; return up(...a); };
  const r = await completePurchase(partsPayload(), w.io);
  assert.equal(r.ok, true);
  assert.equal(r.attached, 1);
  assert.equal(r.parts[1].tagged, "done");
  assert.equal(r.attach_error.code, r.parts[1].attach_error.code);
  assert.match(r.attach_error.message, /^part 2 of 2: /);
});

test("two charges: the first already tagged by hand needs only the photo; the second is tagged", async () => {
  const mine = structuredClone(P10615);
  mine.Line[0].AccountBasedExpenseLineDetail.CustomerRef = { value: "502" };
  mine.SyncToken = "3";
  const w = qbo({ purchases: [mine, P10661], links: { [RZ_JOB]: "502" } });
  const r = await completePurchase(partsPayload({ parts: [PART("10615", 126.9, { expect_sync_token: "3", changes: ["attach"] }),
    PART("10661", 224.1)] }), w.io);
  assert.deepEqual(r.parts.map((x) => [x.tagged, x.attached]), [["not_needed", 1], ["done", 1]]);
  assert.equal(w.posts.length, 1);
});

/* A charge refused after an earlier one was written (TASK: part_error). */

/** QuickBooks refuses the tag update of one expense, every time. The
    default is a validation fault (400, permanent); a 503 is worth retrying. */
const refuseUpdateOf = (w, id, f = new QboError(400, fault("6000", "A business validation error has occurred"))) => {
  const post = w.io.postPurchase;
  w.io.postPurchase = async (body, requestId) => {
    if (body.Id === id) { w.calls.push("refused:" + id); throw f; }
    return post(body, requestId);
  };
  return post;
};
const REFUSED_6000 = "QuickBooks refused the change (400 / 6000): A business validation error has occurred";

test("two charges: the second refused for good after the first was tagged and given the photo: ok, with part_error", async () => {
  const w = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "502" } });
  refuseUpdateOf(w, "10661");
  const r = await completePurchase(partsPayload(), w.io);
  assert.deepEqual(r, {
    ok: true, purchaseId: "10615", syncToken: "1", tagged: "done", attached: 1, already_attached: false,
    adopted: { create: false, tag: false, attach: 0 },
    parts: [
      { purchaseId: "10615", syncToken: "1", tagged: "done", attached: 1, already_attached: false },
      // the token it was read with, so the adapter's parts=<id>:<token> still reads
      { purchaseId: "10661", syncToken: "0", tagged: "refused", attached: 0, already_attached: false,
        error: { code: "qbo_refused", message: REFUSED_6000 } },
    ],
    part_error: { code: "qbo_refused", message: `part 2 of 2 (expense 10661): ${REFUSED_6000}` },
  });
  // nothing more was written for the second charge: refused at its tag, before its photo
  assert.deepEqual(w.calls, ["get:10615", "get:10661", "photo",
    "get:10615", "query", "update:10615", "upload", "get:10661", "query", "refused:10661"]);
  assert.equal(w.posts.length, 1);
  assert.deepEqual(w.uploads.map((u) => u.meta.AttachableRef[0].EntityRef.value), ["10615"]);
  assert.equal(w.purchases.get("10661").SyncToken, "0");
  assert.equal(w.purchases.get("10661").Line[0].AccountBasedExpenseLineDetail.CustomerRef, undefined);
});

test("three charges: the second refused, the third still finished; part_error names the first refused charge", async () => {
  const P10662 = rental("10662", "2026-10-08", 15, "2026-10-09T02:00:00-07:00");
  const three = partsPayload({ parts: [PART("10615", 126.9), PART("10661", 224.1), PART("10662", 15)] });
  const w = qbo({ purchases: [P10615, P10661, P10662], links: { [RZ_JOB]: "502" } });
  refuseUpdateOf(w, "10661");
  const r = await completePurchase(three, w.io);
  assert.equal(r.ok, true);
  assert.deepEqual(r.parts.map((x) => [x.purchaseId, x.syncToken, x.tagged, x.attached]),
    [["10615", "1", "done", 1], ["10661", "0", "refused", 0], ["10662", "1", "done", 1]]);
  assert.equal(r.attached, 2, "the refused charge counts for nothing");
  assert.equal(r.tagged, "done");
  assert.deepEqual(r.part_error, { code: "qbo_refused", message: `part 2 of 3 (expense 10661): ${REFUSED_6000}` });
  // the second and the third both refused: still the second, and both recorded
  const both = qbo({ purchases: [P10615, P10661, P10662], links: { [RZ_JOB]: "502" } });
  refuseUpdateOf(both, "10661");
  refuseUpdateOf(both, "10662", new QboError(400, fault("6140", "Duplicate Document Number Error")));
  const r2 = await completePurchase(three, both.io);
  assert.deepEqual(r2.parts.map((x) => [x.tagged, x.error?.message.slice(0, 38) ?? ""]),
    [["done", ""], ["refused", "QuickBooks refused the change (400 / 6"], ["refused", "QuickBooks refused the change (400 / 6"]]);
  assert.match(r2.parts[2].error.message, /6140/);
  assert.deepEqual(r2.part_error, { code: "qbo_refused", message: `part 2 of 3 (expense 10661): ${REFUSED_6000}` });
  assert.equal(r2.attached, 1);
  assert.equal(both.posts.length, 1);
});

test("two charges: the second refused when the first needed nothing and nothing of ours is there: the whole receipt is refused", async () => {
  // 10615 tagged to the job by hand, with the bookkeeper's document: only checked
  const done = structuredClone(P10615);
  done.Line[0].AccountBasedExpenseLineDetail.CustomerRef = { value: "502" };
  const doc = { FileName: "Rental Zone checkout.pdf", Id: "1000004999", ContentType: "application/pdf",
    AttachableRef: [{ EntityRef: { value: "10615", type: "Purchase" }, IncludeOnSend: false }] };
  const w = qbo({ purchases: [done, P10661], attachables: [doc], links: { [RZ_JOB]: "502" } });
  refuseUpdateOf(w, "10661");
  await fails(completePurchase(partsPayload({ parts: [PART("10615", 126.9, { changes: [] }), PART("10661", 224.1)] }), w.io), (e) => {
    assert.ok(e instanceof CompleteError);
    assert.equal(e.code, "qbo_refused");
    assert.ok(e.permanent);
    assert.equal(e.status, 409);
    assert.equal(e.message, `part 2 of 2 (expense 10661): ${REFUSED_6000}`);
  });
  assert.equal(w.posts.length, 0);
  assert.equal(w.uploads.length, 0);
  assert.equal(w.purchases.get("10661").SyncToken, "0");
});

test("two charges: QuickBooks down on the second after the first was written: retried; the retry adopts the first and finishes", async () => {
  const w = qbo({ purchases: [P10615, P10661], links: { [RZ_JOB]: "502" } });
  const post = refuseUpdateOf(w, "10661", new QboError(503, "Service Unavailable"));
  await fails(completePurchase(partsPayload(), w.io), (e) => {
    assert.ok(e instanceof CompleteError);
    assert.equal(e.code, "qbo_unavailable");
    assert.equal(e.permanent, false);
    assert.equal(e.status, 502);
    assert.match(e.message, /^part 2 of 2 \(expense 10661\): QuickBooks 503/);
  });
  assert.equal(w.purchases.get("10615").SyncToken, "1", "the first charge's tag is in");
  assert.equal(w.uploads.length, 1);
  // the outbox retries the same row once QuickBooks is back
  w.io.postPurchase = post;
  w.calls.length = 0;
  const r = await completePurchase(partsPayload(), w.io);
  assert.equal(r.ok, true);
  assert.equal(r.part_error, undefined);
  assert.equal(r.tagged, "done");
  assert.deepEqual(r.parts, [
    { purchaseId: "10615", syncToken: "1", tagged: "adopted", attached: 0, already_attached: false },
    { purchaseId: "10661", syncToken: "1", tagged: "done", attached: 1, already_attached: false },
  ]);
  assert.deepEqual(r.adopted, { create: false, tag: true, attach: 1 });
  assert.deepEqual(w.calls, ["get:10615", "get:10661", "photo",
    "get:10615", "query", "get:10661", "query", "update:10661", "upload"], "nothing written twice to the first charge");
  assert.equal(w.posts.filter((x) => x.body.Id === "10615").length, 1);
  assert.deepEqual(w.uploads.map((u) => u.meta.AttachableRef[0].EntityRef.value), ["10615", "10661"]);
});

/* ============================================================
   index.ts itself: the gate, the token refresh, the replies
   ============================================================ */

const SERVE = "data:text/javascript," + encodeURIComponent("export const serve = (h) => { globalThis.__qboProxy = h; };");
const SUPA = "data:text/javascript," + encodeURIComponent("export const createClient = (...a) => globalThis.__qboFakeDb(...a);");
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "https://deno.land/std@0.177.0/http/server.ts") return { url: ${JSON.stringify(SERVE)}, shortCircuit: true };
  if (spec === "https://esm.sh/@supabase/supabase-js@2") return { url: ${JSON.stringify(SUPA)}, shortCircuit: true };
  return next(spec, ctx);
}`));

const SB = "https://stub.supabase.test";
const REALM = "9341452443180806";
const OWN_KEY = "sb_secret_own_function_key";
const ENV = {
  SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon-legacy-key", SUPABASE_SERVICE_ROLE_KEY: OWN_KEY,
  QBO_CLIENT_ID: "client", QBO_CLIENT_SECRET: "secret", CRON_SECRET: "cron",
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

/** The one qbo_tokens row, and the slice of supabase-js getConnection uses:
    the newest-row read, the conditional update, the re-read. `race` lets
    another caller rotate the pair between our refresh and our write. */
const db = { row: null, race: null, updates: [], links: {} };
globalThis.__qboFakeDb = () => ({
  from: (table) => {
    const q = { table, filters: [], patch: null };
    const run = async () => {
      if (q.table === "job_qbo_links") {
        const job = (q.filters.find(([k]) => k === "job_id") ?? [])[1];
        return { data: db.links[job] ? { qbo_customer_id: db.links[job] } : null, error: null };
      }
      if (q.table !== "qbo_tokens") return { data: null, error: null };
      const hit = () => db.row && q.filters.every(([k, v]) => db.row[k] === v);
      if (q.patch) {
        if (db.race) { Object.assign(db.row, db.race); db.race = null; }
        db.updates.push({ patch: q.patch, filters: q.filters });
        if (!hit()) return { data: [], error: null };
        Object.assign(db.row, q.patch);
        return { data: [{ id: db.row.id }], error: null };
      }
      return hit() ? { data: { ...db.row }, error: null } : { data: null, error: { message: "no rows" } };
    };
    const b = {
      select: () => b, order: () => b, limit: () => b, insert: () => b,
      eq: (k, v) => { q.filters.push([k, v]); return b; },
      update: (patch) => { q.patch = patch; return b; },
      single: run, maybeSingle: run,
      then: (ok, bad) => run().then(ok, bad),
    };
    return b;
  },
  auth: { getUser: async () => ({ data: { user: null }, error: { message: "not a user" } }) },
});

const freshToken = (o = {}) => ({ id: "tok1", realm_id: REALM, access_token: "AT0", refresh_token: "RT0",
  expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: "2026-10-07T14:30:02Z", ...o });

/** One stubbed outside world for index.ts: Intuit's token endpoint,
    QuickBooks (reads + writes recorded), PostgREST's ping and storage. */
const net = { pings: [], qbo: [], refreshes: 0, pingAnswer: () => new Response("true", { status: 200 }), purchases: [], attachables: [] };
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers ?? {});
  if (url.href === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
    net.refreshes++;
    return J({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600 });
  }
  if (url.href === `${SB}/rest/v1/rpc/qbo_service_ping`) {
    net.pings.push(headers.get("authorization"));
    return net.pingAnswer(headers.get("authorization"));
  }
  if (url.href.startsWith(`${SB}/storage/v1/object/field-media/`)) {
    return url.pathname.endsWith(SHA1) ? new Response(PHOTO1, { status: 200 }) : J({ statusCode: "404", error: "not_found", message: "Object not found" }, 400);
  }
  if (url.origin === "https://quickbooks.api.intuit.com" && url.pathname.startsWith(`/v3/company/${REALM}/`)) {
    const path = url.pathname.slice(`/v3/company/${REALM}`.length);
    net.qbo.push({ method: init.method ?? "GET", path, query: url.searchParams.get("query"), auth: headers.get("authorization"),
      minor: url.searchParams.get("minorversion") });
    if (path === "/query") {
      const q = url.searchParams.get("query");
      const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1);
      const page = (rows) => rows.slice(start - 1, start - 1 + 1000);
      if (/from Customer/.test(q)) return J({ QueryResponse: { Customer: page(CUSTOMERS) } });
      if (/from Purchase where TxnDate/.test(q)) return J({ QueryResponse: { Purchase: page(net.purchases) } });
      if (/from Bill where TxnDate/.test(q)) return J({ QueryResponse: { Bill: page(net.bills) } });
      if (/from Attachable where MetaData/.test(q)) return J({ QueryResponse: { Attachable: page(net.attachables) } });
      if (/AttachableRef\.EntityRef\.Value = '(\d+)'/.test(q)) return J({ QueryResponse: {} });
    }
    if (path === "/purchase/10577") return J({ Purchase: P10577 });
    if (path === "/purchase/10563") return J({ Purchase: P10563 });
    if (path.startsWith("/purchase/")) return J({ Fault: JSON.parse(fault("610")).Fault }, 400);
    if (path === "/purchase" && init.method === "POST") {
      const b = JSON.parse(init.body);
      return J({ Purchase: { ...P10577, Line: b.Line, SyncToken: "1" } });
    }
    if (path === "/upload") return J({ AttachableResponse: [{ Attachable: { Id: "1000009001", FileName: "x" } }] });
  }
  throw new Error("unexpected fetch " + url.href);
};

await import("./index.ts");
const handler = globalThis.__qboProxy;

async function call(body, key, extra = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (key) { headers.authorization = `Bearer ${key}`; headers.apikey = key; }
  const res = await handler(new Request("https://fn.test/functions/v1/qbo-proxy", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const reset = () => {
  db.row = freshToken(); db.race = null; db.updates.length = 0; db.links = { [JOB]: "112" };
  net.pings.length = 0; net.qbo.length = 0; net.refreshes = 0;
  net.pingAnswer = () => new Response("true", { status: 200 });
  net.purchases = [P10577, P10563, P10566]; net.attachables = [A10563, A10566, A_ORPHAN, A10625]; net.bills = [B10625];
};

test("index.ts: the function's own service key reads purchases, with no ping", async () => {
  reset();
  const r = await call({ action: "listPurchases", from: "2026-09-01", to: "2026-10-08" }, OWN_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.purchases.map((p) => [p.id, p.hasAttachment]), [["10577", false], ["10563", true], ["10566", true]]);
  assert.deepEqual(r.body.purchases[2].attachments, ["SW InvNo 80669163000926.pdf"]);
  assert.deepEqual(r.body.data, { purchases: r.body.purchases }, "the same result under data, for qbo.js-style readers");
  assert.equal(net.pings.length, 0);
  assert.deepEqual(net.qbo.map((c) => c.query), [
    "select * from Purchase where TxnDate >= '2026-09-01' and TxnDate <= '2026-10-08' startposition 1 maxresults 1000",
    "select * from Attachable where MetaData.CreateTime >= '2026-08-25T00:00:00-08:00' startposition 1 maxresults 1000",
  ]);
  assert.ok(net.qbo.every((c) => c.auth === "Bearer AT0" && c.minor === "70"));
});

test("index.ts: listBills reads the window's bills with their own documents, for the service key only", async () => {
  reset();
  const r = await call({ action: "listBills", from: "2026-09-01", to: "2026-10-08" }, OWN_KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.bills.map((b) => [b.txnType, b.id, b.docNumber, b.vendorName, b.attachments]),
    [["Bill", "10625", "01286734", "FNSB Solid Waste", ["FNSB 01286734.jpg"]]]);
  assert.deepEqual(net.qbo.map((c) => c.query), [
    "select * from Bill where TxnDate >= '2026-09-01' and TxnDate <= '2026-10-08' startposition 1 maxresults 1000",
    "select * from Attachable where MetaData.CreateTime >= '2026-08-25T00:00:00-08:00' startposition 1 maxresults 1000",
  ]);
  const listed = await call({ action: "listPurchases", from: "2026-09-01", to: "2026-10-08" }, OWN_KEY);
  assert.ok(listed.body.purchases.every((p) => p.txnType === "Purchase" && !p.attachments.includes("FNSB 01286734.jpg")),
    "a bill's document is not an expense's");
  assert.equal((await call({ action: "listBills", from: "2026-06-01", to: "2026-10-08" }, OWN_KEY)).status, 400);
});

test("index.ts: completePurchase refuses a bill with 409 bad_request; QuickBooks is never called", async () => {
  reset();
  const r = await call({ action: "completePurchase", ...billPayload() }, OWN_KEY);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "bad_request");
  assert.equal(r.body.permanent, true);
  assert.match(r.body.error, /^bad_request: .*a bill is only read/);
  assert.deepEqual(net.qbo, [], "no read, no write: not /bill, not /purchase, not /upload");
});

test("index.ts: listPurchases pages past 1000 expenses", async () => {
  reset();
  net.purchases = Array.from({ length: 1002 }, (_, i) => ({ ...P10577, Id: String(20000 + i) }));
  const r = await call({ action: "listPurchases", from: "2026-09-01", to: "2026-10-08" }, OWN_KEY);
  assert.equal(r.body.purchases.length, 1002);
  assert.equal(net.qbo.filter((c) => /from Purchase/.test(c.query)).length, 2);
});

test("index.ts: another sb_secret_ key is admitted only after PostgREST says it is the service role, then remembered", async () => {
  reset();
  const other = "sb_secret_worker_key_2";
  const r1 = await call({ action: "listProjects" }, other);
  assert.equal(r1.status, 200);
  // by name, compacted (the sub-customer 514 stays in, marked isProject false)
  assert.deepEqual(r1.body.projects.map((p) => [p.id, p.name, p.isProject]),
    [["444", "1192 Bemis Ct.", true], ["514", "330 Brighton", false], ["515", "330 Brighton", true], ["112", "Pollen Apartments", true]]);
  assert.deepEqual(r1.body.data.projects, r1.body.projects);
  assert.deepEqual(net.pings, [`Bearer ${other}`]);
  await call({ action: "listProjects" }, other);
  assert.equal(net.pings.length, 1, "a proven key is not pinged again within five minutes");
});

test("index.ts: an sb_secret_ key PostgREST refuses gets nothing, and is asked about again next time", async () => {
  reset();
  net.pingAnswer = () => J({ code: "42501", message: "permission denied for function qbo_service_ping" }, 403);
  const bad = "sb_secret_not_the_service_role";
  for (const action of ["listPurchases", "listBills", "completePurchase"]) {
    const r = await call({ action, from: "2026-09-01", to: "2026-09-02" }, bad);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /server-only/);
  }
  assert.equal(net.pings.length, 3);
  assert.equal(net.qbo.length, 0);
  // a 200 that is not exactly true proves nothing either
  net.pingAnswer = () => new Response('"true"', { status: 200 });
  assert.equal((await call({ action: "listPurchases", from: "2026-09-01", to: "2026-09-02" }, "sb_secret_other")).status, 401);
});

test("index.ts: the publishable key, a user JWT and no key at all are refused the server-only actions", async () => {
  reset();
  for (const key of ["sb_publishable_shipped_in_config_js", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln", ""]) {
    for (const action of ["listPurchases", "listBills", "completePurchase"]) {
      const r = await call({ action, from: "2026-09-01", to: "2026-09-02" }, key);
      assert.equal(r.status, 401, `${action} with ${key.slice(0, 14) || "no key"}`);
    }
  }
  assert.equal(net.pings.length, 0, "only an sb_secret_ key is ever pinged");
  assert.equal(net.qbo.length, 0);
  // listProjects falls through to the user checks: no user behind the publishable key
  const r = await call({ action: "listProjects" }, "sb_publishable_shipped_in_config_js");
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Sign in/);
});

test("index.ts: the cron secret does not open the service actions", async () => {
  reset();
  const r = await call({ action: "completePurchase" }, "", { "x-cron-secret": "cron" });
  assert.equal(r.status, 401);
});

test("index.ts: listPurchases refuses a bad window with 400", async () => {
  reset();
  const r = await call({ action: "listPurchases", from: "2026-06-01", to: "2026-10-08" }, OWN_KEY);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /92 days/);
  assert.equal(net.qbo.length, 0);
});

test("index.ts: completePurchase replies with the result at the top level (and under data)", async () => {
  reset();
  const r = await call({ action: "completePurchase", ...payload() }, OWN_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.purchaseId, "10577");
  assert.equal(r.body.syncToken, "1");
  assert.equal(r.body.tagged, "done");
  assert.equal(r.body.attached, 1);
  assert.equal(r.body.data.purchaseId, "10577");
  const upload = net.qbo.find((c) => c.path === "/upload");
  assert.equal(upload.method, "POST");
  assert.equal(upload.minor, "70");
});

test("index.ts: a permanent refusal is HTTP 409 {ok:false, error, code, permanent:true}", async () => {
  reset();
  db.links[JOB] = "444";
  const r = await call({ action: "completePurchase", ...payload({ qbo_txn_id: "10563", expect_sync_token: "1", expect_total: 212.28, customer_id: "444" }) }, OWN_KEY);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "tagged_other");
  assert.equal(r.body.permanent, true);
  assert.match(r.body.error, /^tagged_other: expense 10563 is already tagged to Pollen Apartments/);
  const gone = await call({ action: "completePurchase", ...payload({ qbo_txn_id: "999", customer_id: "444" }) }, OWN_KEY);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, "purchase_missing");
});

test("index.ts: the tag is checked against job_qbo_links as it is now; a relink since the approval is a 409 with nothing sent", async () => {
  reset();
  db.links[JOB] = "445";
  const r = await call({ action: "completePurchase", ...payload() }, OWN_KEY);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "relinked");
  assert.equal(r.body.permanent, true);
  assert.equal(net.qbo.length, 0);
});

test("index.ts: QuickBooks not connected is retried (503), not dead", async () => {
  reset();
  db.row = null;
  const r = await call({ action: "completePurchase", ...payload() }, OWN_KEY);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "qbo_not_connected");
  assert.equal(r.body.permanent, false);
});

test("index.ts: an expiring token is refreshed and written back on the old refresh token only", async () => {
  reset();
  db.row = freshToken({ expires_at: new Date(Date.now() + 60e3).toISOString() });
  await call({ action: "listProjects" }, OWN_KEY);
  assert.equal(net.refreshes, 1);
  assert.deepEqual(db.updates[0].filters, [["id", "tok1"], ["refresh_token", "RT0"]]);
  assert.equal(db.row.refresh_token, "RT-new");
  assert.ok(net.qbo.every((c) => c.auth === "Bearer AT-new"));
});

test("index.ts: a refresh that loses the race keeps the winner's pair and uses the winner's token", async () => {
  reset();
  db.row = freshToken({ expires_at: new Date(Date.now() + 60e3).toISOString() });
  db.race = { access_token: "AT-winner", refresh_token: "RT-winner" };
  await call({ action: "listProjects" }, OWN_KEY);
  assert.equal(db.row.refresh_token, "RT-winner", "our pair did not overwrite theirs");
  assert.equal(db.row.access_token, "AT-winner");
  assert.ok(net.qbo.length > 0 && net.qbo.every((c) => c.auth === "Bearer AT-winner"));
});
