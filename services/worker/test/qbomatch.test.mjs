import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchReceipts, purchaseWindow, vendorFamily, docAgrees, scoreOf, contradicts, MATCHER, EQUIPMENT_EXPENSE_ACCOUNT,
  PAYMENT_CLEARING_ACCOUNT } from "../lanes/qbomatch.mjs";
import * as oct7 from "./qbo-oct7.fixture.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = fs.readFileSync(path.join(REPO, "supabase/migrations/0023_receipts_qbo_link.sql"), "utf8");

/* ---- what the database will hold the worker's output to ----
   The card's input is checked three times before anything reaches
   QuickBooks: op_validate_input against the catalog's input_schema (0013;
   type, required, additionalProperties, enum, pattern, maxLength), the
   executor's own item checks (op_exec_receipts_qbo_link, which looks inside
   items[] and link), and qbo-proxy's completePurchase. The note rows go
   through receipt_qbo_links_note, which refuses the whole call over one bad
   row. These mirrors are run on every result below, so a card the worker
   builds is a card the database accepts. The schema is read from the
   migration itself, not copied. */
const INPUT_SCHEMA = JSON.parse(
  /'(\{"type": "object", "additionalProperties": false,[\s\S]*?\}\}\})',\n/.exec(MIGRATION)[1]);

const ID = /^[0-9]{1,20}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MEDIA = /^media:[0-9a-f]{64}:[0-9]+$/;
const jsonType = (v) => (v == null ? "null" : Array.isArray(v) ? "array" : typeof v);
const calendarDate = (s) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function opValidateInput(schema, input) {
  if (jsonType(input) !== "object") return ["input must be a JSON object"];
  const problems = [];
  for (const k of schema.required ?? []) if (input[k] == null) problems.push(`${k} is required`);
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(input)) if (!(k in (schema.properties ?? {}))) problems.push(`${k} is not a known field`);
  }
  for (const [k, prop] of Object.entries(schema.properties ?? {})) {
    const v = input[k];
    if (v == null) continue;
    const got = jsonType(v);
    if (prop.type && !(got === prop.type || (prop.type === "integer" && got === "number" && Number.isInteger(v)))) {
      problems.push(`${k} must be ${prop.type}, got ${got}`);
      continue;
    }
    if (prop.enum && !prop.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) problems.push(`${k} not in enum`);
    if (got === "string" && prop.pattern && !new RegExp(prop.pattern).test(v)) problems.push(`${k} does not match ${prop.pattern}`);
    if (got === "string" && prop.maxLength && [...v].length > prop.maxLength) problems.push(`${k} is too long`);
  }
  return problems;
}

function executorProblems(input) {
  const p = [];
  const cust = input.qbo_customer_id;
  if (jsonType(cust) !== "string" || !/^([0-9]{1,20})?$/.test(cust)) p.push("qbo_customer_id");
  const items = input.items;
  if (jsonType(items) !== "array" || items.length < 1 || items.length > 50) return [...p, "items must hold 1 to 50"];
  const ids = [];
  items.forEach((it, n) => {
    const i = n + 1;
    if (jsonType(it) !== "object") { p.push(`item ${i} is not an object`); return; }
    if (jsonType(it.receipt_id) !== "string" || it.receipt_id.length < 1 || it.receipt_id.length > 64) p.push(`item ${i} receipt_id`);
    else if (ids.includes(it.receipt_id)) p.push(`receipt ${it.receipt_id} twice`);
    else ids.push(it.receipt_id);
    let ch = jsonType(it.changes) === "array" && it.changes.length ? it.changes : null;
    if (!ch || !ch.every((c) => typeof c === "string") || new Set(ch).size !== ch.length
        || !ch.every((c) => ["tag", "attach", "create"].includes(c)) || (ch.includes("create") && ch.includes("tag"))) {
      p.push(`item ${i} changes`);
      ch = [];
    }
    if (it.qbo_txn_type !== "Purchase") p.push(`item ${i} qbo_txn_type`);
    if (ch.includes("create")) {
      if (String(it.qbo_txn_id ?? "") !== "" || String(it.qbo_sync_token ?? "") !== "") p.push(`item ${i} create names a txn`);
      const c = it.create;
      if (jsonType(c) !== "object") p.push(`item ${i} create object`);
      else {
        for (const k of ["account_id", "vendor_id", "expense_account_id"]) if (jsonType(c[k]) !== "string" || !ID.test(c[k])) p.push(`item ${i} create ${k}`);
        if (!["string", "null"].includes(jsonType(c.class_id)) || (c.class_id != null && !ID.test(c.class_id))) p.push(`item ${i} create class_id`);
        if (jsonType(c.doc_number) !== "string" || !/^[0-9]{5,21}$/.test(c.doc_number)) p.push(`item ${i} create doc_number`);
        if (jsonType(c.credit) !== "boolean") p.push(`item ${i} create credit`);
        if (jsonType(c.payment_type) !== "null" && c.payment_type !== "CreditCard") p.push(`item ${i} create payment_type`);
        if (!["string", "null"].includes(jsonType(c.txn_date)) || (c.txn_date != null && !DATE.test(c.txn_date))) p.push(`item ${i} create txn_date`);
        if (jsonType(c.amount_abs) !== "number" || c.amount_abs <= 0) p.push(`item ${i} create amount_abs`);
        if (!["string", "null"].includes(jsonType(c.memo)) || String(c.memo ?? "").length > 4000) p.push(`item ${i} create memo`);
      }
    } else {
      if (jsonType(it.qbo_txn_id) !== "string" || !ID.test(it.qbo_txn_id)) p.push(`item ${i} qbo_txn_id`);
      if (jsonType(it.qbo_sync_token) !== "string" || !ID.test(it.qbo_sync_token)) p.push(`item ${i} qbo_sync_token`);
      if (jsonType(it.create) !== "null") p.push(`item ${i} create without the change`);
    }
    if ((ch.includes("tag") || ch.includes("create")) && cust === "") p.push(`item ${i} tags with no project`);
    if (jsonType(it.amount) !== "number") p.push(`item ${i} amount`);
    if (!["number", "null"].includes(jsonType(it.qbo_total))) p.push(`item ${i} qbo_total`);
    if (!["string", "null"].includes(jsonType(it.date)) || (it.date != null && !calendarDate(it.date))) p.push(`item ${i} date`);
    if (!["string", "null"].includes(jsonType(it.project_ref)) || (it.project_ref != null && !ID.test(it.project_ref))) p.push(`item ${i} project_ref`);
    if (jsonType(it.photo_refs) !== "array" || it.photo_refs.length > 4 || it.photo_refs.some((r) => typeof r !== "string" || !MEDIA.test(r))) {
      p.push(`item ${i} photo_refs`);
    }
    for (const k of ["vendor", "receipt_no", "qbo_doc_number", "qbo_account_name", "qbo_vendor_name"]) {
      if (!["string", "null"].includes(jsonType(it[k])) || String(it[k] ?? "").length > 200) p.push(`item ${i} ${k}`);
    }
    // the filing door's: the photo the worker read, a string or null, never left out
    if (!("read_photo_ref" in it) || !["string", "null"].includes(jsonType(it.read_photo_ref))) p.push(`item ${i} read_photo_ref`);
    // qbo-proxy's completePurchase on top: its receipt id shape, and a photo to attach
    if (!/^[\w.:~-]{1,64}$/.test(it.receipt_id)) p.push(`item ${i} receipt_id for qbo-proxy`);
    if (ch.includes("attach") && !(it.photo_refs?.length >= 1)) p.push(`item ${i} attach with no photo`);
  });
  const link = input.link;
  if (!["object", "null"].includes(jsonType(link))) p.push("link must be an object");
  else if (link) {
    if (jsonType(link.qbo_customer_id) !== "string" || !ID.test(link.qbo_customer_id)) p.push("link qbo_customer_id");
    else if (cust !== "" && link.qbo_customer_id !== cust) p.push("link names another project");
    if (!["suggested_tagged", "suggested_qbtime"].includes(link.source)) p.push("link source");
    if (!["string", "null"].includes(jsonType(link.qbo_project_ref)) || (link.qbo_project_ref != null && !ID.test(link.qbo_project_ref))) p.push("link qbo_project_ref");
    if (!["string", "null"].includes(jsonType(link.qbo_name))) p.push("link qbo_name");
  }
  return p;
}

function noteProblems(jobIds, rows) {
  const p = [];
  if (jobIds.length > 1000) p.push("too many jobs");
  if (rows.length > 5000) p.push("too many rows");
  const ids = [];
  const jobs = new Set(jobIds.map((j) => j.toLowerCase()));
  rows.forEach((r, n) => {
    const i = n + 1;
    if (jsonType(r) !== "object") { p.push(`row ${i} not an object`); return; }
    if (jsonType(r.receipt_id) !== "string" || r.receipt_id.length < 1 || r.receipt_id.length > 64) p.push(`row ${i} receipt_id`);
    else if (ids.includes(r.receipt_id)) p.push(`receipt ${r.receipt_id} twice`);
    else ids.push(r.receipt_id);
    if (jsonType(r.job_id) !== "string" || !UUID.test(r.job_id)) p.push(`row ${i} job_id`);
    else if (!jobs.has(r.job_id.toLowerCase())) p.push(`row ${i} job outside the call`);
    if (!["in_qbo", "unmatched", "conflict"].includes(r.state)) p.push(`row ${i} state`);
    if (jsonType(r.qbo_txn_type) !== "null" && r.qbo_txn_type !== "Purchase") p.push(`row ${i} qbo_txn_type`);
    for (const k of ["qbo_txn_id", "qbo_sync_token", "qbo_customer_id"]) {
      if (!["string", "null"].includes(jsonType(r[k])) || !/^([0-9]{1,20})?$/.test(r[k] ?? "")) p.push(`row ${i} ${k}`);
    }
    if (r.state === "in_qbo" && (!r.qbo_txn_type || !r.qbo_txn_id)) p.push(`row ${i} in_qbo names no expense`);
    if (!["number", "null"].includes(jsonType(r.amount))) p.push(`row ${i} amount`);
    if (!["string", "null"].includes(jsonType(r.receipt_date)) || (r.receipt_date != null && !calendarDate(r.receipt_date))) p.push(`row ${i} receipt_date`);
    if (!["object", "null"].includes(jsonType(r.detail))) p.push(`row ${i} detail`);
  });
  return p;
}

/** Every card and every note of a result, through the database's checks. */
function check(res, jobIds) {
  const wire = JSON.parse(JSON.stringify(res));   // what PostgREST is sent: no undefined, no NaN
  assert.deepEqual(wire.notes, res.notes, "notes survive JSON");
  assert.deepEqual(noteProblems(jobIds, res.notes), []);
  for (const card of res.cards) {
    assert.deepEqual(wire.cards.find((c) => c.job_id === card.job_id), card, "cards survive JSON");
    assert.equal(card.input.job_id, card.job_id);
    assert.equal(card.input.job_name, card.job_name);
    // the door stamps these three; nothing else is added before op_propose
    const stamped = { ...card.input, receipts_fingerprint: "0".repeat(32), items_hash: "f".repeat(32), offer: 0 };
    assert.deepEqual(opValidateInput(INPUT_SCHEMA, stamped), [], `input_schema: job ${card.job_id}`);
    assert.deepEqual(executorProblems(card.input), [], `executor: job ${card.job_id}`);
    assert.equal(card.input.total_usd, Math.round(card.input.items.reduce((s, i) => s + Math.abs(i.amount), 0) * 100) / 100);
    assert.ok(typeof card.rationale === "string" && card.rationale.endsWith("."));
    assert.deepEqual(card.evidence_refs, []);
  }
  const noted = new Set(res.notes.map((n) => n.receipt_id));
  for (const card of res.cards) {
    for (const it of card.input.items) {
      // a receipt is noted or on a card, never both (a needs_job_link one waits for the link, photo and all)
      assert.equal(noted.has(it.receipt_id), false, `${it.receipt_id} is both noted and on a card`);
    }
  }
  return res;
}

/* ---- the real shapes (DESIGN, from the Oct 7 read; ids are real) ---- */

const TODAY = "2026-10-08";
const ALSTON = "a628eea5-0000-4000-8000-000000000001";   // "2156 Alston rd."
const OTHER = "0b32c79a-0000-4000-8000-000000000002";
const photo = (n) => `media:${n.toString(16).padStart(2, "0").repeat(32)}:${1000 + n}`;
const LINK = { job_id: ALSTON, qbo_customer_id: "112", qbo_project_ref: "412739523", qbo_name: "Pollen Apartments", source: "picked" };
const job = (over = {}) => ({ id: ALSTON, title: "", address: "2156 Alston rd.", customer: "", qbJobcodeName: "", deleted: false, link: null, ...over });
const line = (over = {}) => ({ id: "1", amount: 0, detailType: "AccountBasedExpenseLineDetail", accountId: "42",
  accountName: "Cost of Goods Sold:Materials COGS", classId: "1000000001", customerId: "", customerName: "", projectRef: "", ...over });
const POLLEN = { customerId: "112", customerName: "Pollen Apartments", projectRef: "412739523" };

// Home Depot, card 3176 → Purchase 10577: arrived by bank rule, untagged, no photo
const hd = (over = {}) => ({ job_id: ALSTON, id: "r1", vendor: "The Home Depot #1303", receipt_date: "2026-09-30", amount: 1369.5,
  category: "materials", paid_with: "card", card_last4: "3176", receipt_no: "1303 00001 50615", photo_ref: photo(1), ...over });
const p10577 = (over = {}) => ({ id: "10577", syncToken: "0", txnDate: "2026-09-30", total: 1369.5, credit: false,
  paymentType: "CreditCard", accountId: "36", accountName: "3176 - Citi - Home Depot Consumer Credit Card", vendorId: "25",
  vendorName: "Home Depot", docNumber: "", note: "THE HOME DEPOT FAIRBANKS AK - RULE",
  lines: [line({ amount: 1369.5 })], attachments: [], hasAttachment: false, ...over });
// Spenard on account → Purchase 10563: entered by hand, DocNumber = invoice, tagged 112, the vendor's PDF
const sbs = (over = {}) => ({ job_id: ALSTON, id: "r2", vendor: "Spenard Builders Supply", receipt_date: "2026-09-28", amount: 212.28,
  category: "materials", paid_with: "account", card_last4: "", receipt_no: "700624817", photo_ref: photo(2), ...over });
const p10563 = (over = {}) => ({ id: "10563", syncToken: "1", txnDate: "2026-09-28", total: 212.28, credit: false,
  paymentType: "CreditCard", accountId: "53", accountName: "Spenard Builders (SBS) - Store Credit", vendorId: "65",
  vendorName: "Spenard Building Supply", docNumber: "700624817", note: "Materials purchased",
  lines: [line({ amount: 212.28, ...POLLEN })], attachments: ["SBS - InvNo 700624817.pdf"], hasAttachment: true, ...over });
// Sherwin on account → Purchase 10566: DocNumber is the receipt's digits and more
const sw = (over = {}) => ({ job_id: ALSTON, id: "r3", vendor: "Sherwin-Williams Fairbanks Store 708285", receipt_date: "2026-09-28",
  amount: 36, category: "materials", paid_with: "account", card_last4: "", receipt_no: "8066-9", photo_ref: photo(3), ...over });
const p10566 = (over = {}) => ({ id: "10566", syncToken: "2", txnDate: "2026-09-28", total: 36, credit: false,
  paymentType: "CreditCard", accountId: "52", accountName: "Sherwin Williams Store Credit Account", vendorId: "9",
  vendorName: "Sherwin Williams", docNumber: "80669163000926", note: "Job materials",
  lines: [line({ amount: 36, ...POLLEN })], attachments: ["SW_InvNo_80669163000926.pdf"], hasAttachment: true, ...over });

// The shape DESIGN's store entry section gives (not set by 0023: off until the owner says so)
const STORES = {
  spenard: { account_id: "53", vendor_id: "65", doc: "exact", expense_account_id: "42", class_id: "1000000001", min_age_days: 0 },
  sherwin: { account_id: "52", vendor_id: "9", doc: "prefix", expense_account_id: "42", class_id: "1000000001", min_age_days: 0 },
};

function run(over = {}) {
  const args = { receipts: [], purchases: [], links: [], jobs: [job()], projects: oct7.PROJECTS, storeAccounts: null, today: TODAY, ...over };
  return check(matchReceipts(args), args.jobs.map((j) => j.id));
}
const noteOf = (res, id) => res.notes.find((n) => n.receipt_id === id);
const cardOf = (res, jobId = ALSTON) => res.cards.find((c) => c.job_id === jobId);
const itemsOf = (res, jobId = ALSTON) => cardOf(res, jobId)?.input.items ?? [];
const reasons = (res) => Object.fromEntries(res.notes.filter((n) => n.state !== "in_qbo").map((n) => [n.receipt_id, n.detail.reason]));

test("the mirrors refuse what the database refuses, so a passing card is not a vacuous pass", () => {
  const good = { job_id: "a628eea5-0000-4000-8000-000000000001", job_name: "2156 Alston rd.", qbo_customer_id: "112", qbo_name: "Pollen",
    items: [{ receipt_id: "r1", vendor: "Home Depot", date: "2026-09-30", amount: 1, receipt_no: "", qbo_txn_type: "Purchase",
      qbo_txn_id: "10577", qbo_sync_token: "0", qbo_doc_number: "", qbo_account_name: "", qbo_total: 1, changes: ["tag"],
      photo_refs: [], project_ref: null, read_photo_ref: null }],
    total_usd: 1, matcher: "receipts.qbo_match@1" };
  const stamped = (i) => ({ ...i, receipts_fingerprint: "0".repeat(32), items_hash: "f".repeat(32), offer: 0 });
  assert.deepEqual(opValidateInput(INPUT_SCHEMA, stamped(good)), []);
  assert.deepEqual(executorProblems(good), []);
  assert.notDeepEqual(opValidateInput(INPUT_SCHEMA, good), []);                                   // unstamped
  assert.notDeepEqual(opValidateInput(INPUT_SCHEMA, stamped({ ...good, extra: 1 })), []);
  assert.notDeepEqual(opValidateInput(INPUT_SCHEMA, stamped({ ...good, matcher: "qbo_match@1" })), []);
  assert.notDeepEqual(opValidateInput(INPUT_SCHEMA, stamped({ ...good, qbo_customer_id: "C112" })), []);
  const item = (over) => ({ ...good, items: [{ ...good.items[0], ...over }] });
  for (const bad of [{ changes: ["create", "tag"] }, { changes: [] }, { qbo_sync_token: null }, { amount: "1" },
    { photo_refs: ["https://x"] }, { changes: ["attach"] }, { date: "2026-02-30" }, { project_ref: 412 },
    { qbo_vendor_name: "v".repeat(201) }, { read_photo_ref: 1 }]) {
    assert.notDeepEqual(executorProblems(item(bad)), [], JSON.stringify(bad));
  }
  const { read_photo_ref: _, ...unread } = good.items[0];
  assert.notDeepEqual(executorProblems({ ...good, items: [unread] }), []);                        // the door refuses it left out
  const create = { account_id: "53", vendor_id: "65", payment_type: "CreditCard", credit: false, doc_number: "70062",
    expense_account_id: "42", class_id: null, txn_date: null, amount_abs: 1, memo: "" };
  const entry = (doc) => item({ qbo_txn_id: "", qbo_sync_token: "", changes: ["create"], create: { ...create, doc_number: doc } });
  assert.deepEqual(executorProblems(entry("70062")), []);
  assert.notDeepEqual(executorProblems(entry("7006")), []);                                       // under 5 digits
  assert.notDeepEqual(executorProblems({ ...good, qbo_customer_id: "" }), []);                    // a tag with no project
  assert.notDeepEqual(executorProblems({ ...good, link: { qbo_customer_id: "399", source: "suggested_tagged" } }), []);
  const row = { receipt_id: "r1", job_id: ALSTON, state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "1", qbo_sync_token: "0",
    qbo_customer_id: "112", amount: 1, receipt_date: "2026-09-30", detail: {} };
  assert.deepEqual(noteProblems([ALSTON], [row]), []);
  assert.notDeepEqual(noteProblems([OTHER], [row]), []);
  assert.notDeepEqual(noteProblems([ALSTON], [{ ...row, qbo_txn_id: null }]), []);
  assert.notDeepEqual(noteProblems([ALSTON], [row, row]), []);
});

/* ---- the pieces ---- */

test("vendorFamily reads a receipt's printed vendor, an expense's vendor name and a bank rule's memo into one family", () => {
  for (const [text, fam] of [
    ["The Home Depot #1303", "home depot"], ["THE HOME DEPOT FAIRBANKS AK - RULE", "home depot"], ["Home Depot", "home depot"],
    ["HOMEDEPOT.COM", "home depot"], ["Office Depot #1124", "office depot"],
    ["Spenard Builders Supply", "spenard"], ["Spenard Building Supply", "spenard"], ["SBS - InvNo 700624817", "spenard"],
    ["Sherwin-Williams Fairbanks Store 708285", "sherwin"], ["Sherwin Williams", "sherwin"],
    ["Lowe's", "lowes"], ["LOWES #01234", "lowes"],
    ["FNSB Solid Waste Division #001", "fnsb"], ["Solid Waste Transfer", "fnsb"],
    ["AMZN Mktp US", "amazon"], ["Amazon.com", "amazon"],
    ["C & R Pipe and Steel, Inc.", "c&r pipe"], ["Fairbanks Block & Building Materials", "fairbanks block"],
    ["FS&G Aggregate Inc.", "fs&g"], ["Alaska Industrial Hardware", "aih"], ["Fred Meyer #0071", "fred meyer"], ["Wal-Mart", "walmart"],
    // QuickBooks' own names for the same stores (Oct 10)
    ["Pipe and Steel", "c&r pipe"], ["Pipe & Steel", "c&r pipe"],
    ["Browns Electrical Supply", "browns electric"], ["Brown Electric", "browns electric"], ["BROWN'S ELECTRICAL SUPPLY FAIRBANKS AK", "browns electric"],
    ["TESCO - FAIRBANKS (2346)", "tesco"], ["Tesco", "tesco"],
    ["The Rental Zone (A Division of Airport Equipment Rentals)", "airport equipment"], ["Airport Equipment Rental, Inc", "airport equipment"],
    ["AIRPORT EQUIPMENT RENTAL FAIRBANKS    AK - RULE", "airport equipment"],
  ]) assert.equal(vendorFamily(text), fam, text);
  for (const text of ["", null, undefined, "Joe's Plumbing", "Tesoro 2Go", "Depotted Plants", "Steel Pipe and Steel Supply", "Charlie Brown Plumbing"]) {
    assert.equal(vendorFamily(text), null, String(text));
  }
});

test("docAgrees: equal digits, or the receipt's digits starting a longer DocNumber (Sherwin), never under 5 digits", () => {
  assert.equal(docAgrees("700624817", "700624817"), true);
  assert.equal(docAgrees("8066-9", "80669163000926"), true);       // receipt 8066-9 is DocNumber 80669163000926
  assert.equal(docAgrees("8230-1", "82301163001026"), true);
  assert.equal(docAgrees("700624817", "700624818"), false);
  assert.equal(docAgrees("80669163000926", "80669"), false);       // a shorter DocNumber is not the receipt's
  assert.equal(docAgrees("1234", "1234"), false);                  // a check number or short ticket proves nothing
  assert.equal(docAgrees("1303 00001 50615", ""), false);          // the bank-rule expenses carry no DocNumber
  assert.equal(docAgrees("", ""), false);
});

test("scoreOf: +3 receipt number, +2 vendor family, +1 same date, +1 the card's last four in the account name or memo", () => {
  assert.equal(scoreOf(hd(), p10577()), 2 + 1 + 1);
  assert.equal(scoreOf(sbs(), p10563()), 3 + 2 + 1);
  assert.equal(scoreOf(sw(), p10566()), 3 + 2 + 1);
  assert.equal(scoreOf(hd({ receipt_date: "2026-10-01" }), p10577()), 2 + 1);
  assert.equal(scoreOf(hd({ card_last4: "0442" }), p10577()), 2 + 1);
  assert.equal(scoreOf(hd({ card_last4: "" }), p10577({ note: "" , vendorName: "" })), 1);
  assert.equal(scoreOf(hd({ card_last4: "3176" }), p10577({ accountName: "Checking", note: "card 3176" })), 2 + 1 + 1);
  assert.equal(scoreOf(hd(), p10563()), 0);
});

test("contradicts: another store, another card, a payment, or a store-account receipt paid from the bank is never a candidate", () => {
  const bought = (id) => oct7.PURCHASES.find((p) => p.id === id);
  // the true matches agree
  for (const [r, p] of [[hd(), p10577()], [sbs(), p10563()], [sw(), p10566()]]) assert.equal(contradicts(r, p), false, p.id);
  // a Lowe's receipt on debit 4558 and a Fred Meyer charge on Checking with 4558 in its memo: two stores
  const lowes = hd({ vendor: "Lowe's #2563", receipt_date: "2026-10-01", amount: 25, card_last4: "4558", receipt_no: "" });
  const fred = p10577({ id: "20001", txnDate: "2026-10-01", total: 25, paymentType: "Cash", accountId: "9", accountName: "8992-MMB- Checking",
    vendorName: "", note: "4558 VSA PUR FRED MEYER #0071 FAIRBANKS AK", lines: [line({ amount: 25 })] });
  assert.equal(scoreOf(lowes, fred), 2);
  assert.equal(contradicts(lowes, fred), true);
  // a Home Depot receipt on card 0442 and a Home Depot charge on the Citi 3176 card
  assert.equal(scoreOf(hd({ card_last4: "0442" }), p10577()), 3);
  assert.equal(contradicts(hd({ card_last4: "0442" }), p10577()), true);
  // the card account's name carries the card (Amazon 0687 on account 240); a checking account's number is not a card
  assert.equal(contradicts(hd({ card_last4: "0687" }), p10577({ accountId: "240", accountName: "1674 US Bank - Amazon (0687)" })), false);
  assert.equal(contradicts(hd({ card_last4: "4558" }), p10577({ paymentType: "Cash", accountName: "8992-MMB- Checking", note: "" })), false);
  assert.equal(contradicts(hd({ card_last4: "4558" }), p10577({ accountName: "Sherwin Williams Store Credit Account", note: "" })), false);
  // Sherwin and Spenard payments on account, from Checking, all lines on the clearing account
  const swPaid = sw({ receipt_date: "2026-09-30", amount: 632.92, receipt_no: "" });
  const sbsPaid = sbs({ receipt_date: "2026-09-29", amount: 1136.54, receipt_no: "" });
  assert.equal(scoreOf(swPaid, bought("10570")), 3);
  assert.equal(contradicts(swPaid, bought("10570")), true);
  assert.equal(contradicts(sbsPaid, bought("10565")), true);
  assert.equal(contradicts(hd({ paid_with: "card" }), p10577({ lines: [line({ accountId: PAYMENT_CLEARING_ACCOUNT })] })), true);
  assert.equal(contradicts(sbs({ receipt_no: "" }), p10563({ paymentType: "Check", docNumber: "" })), true);
  assert.equal(contradicts(sbs({ receipt_no: "700624818" }), p10563({ paymentType: "Check" })), true);   // another invoice's number
  assert.equal(contradicts(hd({ paid_with: "card" }), p10577({ paymentType: "Cash", accountName: "ATM Cash Clearing" })), false);
});

test("an invoice the slip reader marked \"account\" but the bank paid is a candidate when the expense names it: its invoice number, or the bank account the receipt says paid it", () => {
  // FS&G 209998, stamped PAID and charged to debit card 4558 on Oct 6: QuickBooks 10621, DocNumber 209998
  const fsg = sbs({ id: "fsg", vendor: "FS&G Aggregate Inc.", receipt_date: "2026-10-03", amount: 100.98, receipt_no: "209998" });
  const p10621 = p10577({ id: "10621", syncToken: "2", txnDate: "2026-10-06", total: 100.98, paymentType: "Cash", accountId: "9",
    accountName: "8992-MMB- Checking", vendorName: "FS&G Aggregate, Inc", docNumber: "209998",
    note: "4558 VSA PUR F S G AGGREGATE INC FAIRBANKS AK - RULE", lines: [line({ amount: 100.98, customerId: "502", projectRef: "807760362" })],
    attachments: ["IMG_9702.jpg"], hasAttachment: true });
  assert.equal(contradicts(fsg, p10621), false);
  assert.equal(scoreOf(fsg, p10621), 3 + 2);
  // FBX Electric invoice 1065, paid by ACH from ****8992: QuickBooks 10662 on 8992 checking, under another payee's name
  const fbx = sbs({ id: "fbx", vendor: "FBX Electric LLC", receipt_date: "2026-10-09", amount: 784, card_last4: "8992", receipt_no: "1065" });
  const p10662 = p10577({ id: "10662", txnDate: "2026-10-09", total: 784, paymentType: "Cash", accountId: "9", accountName: "8992-MMB- Checking",
    vendorName: "Vinny Fanelli", docNumber: "", note: "", lines: [line({ amount: 784, customerId: "502", projectRef: "807760362" })],
    attachments: ["Invoice 1065.pdf"], hasAttachment: true });
  assert.equal(contradicts(fbx, p10662), false);
  assert.equal(scoreOf(fbx, p10662), 1 + 1);
  // neither: still a store receipt paid from the bank, which it is not
  assert.equal(contradicts({ ...fbx, card_last4: "" }, p10662), true);
  assert.equal(contradicts({ ...fbx, card_last4: "4558" }, p10662), true);
  assert.equal(contradicts({ ...fsg, receipt_no: "209999" }, p10621), true);

  const chena = job({ id: OTHER, address: "1885 Chena Landings Lp." });
  const res = run({ receipts: [{ ...fsg, job_id: OTHER }, { ...fbx, job_id: OTHER }], purchases: [p10621, p10662], jobs: [chena],
    today: "2026-10-10" });
  assert.deepEqual(res.notes.map((n) => [n.receipt_id, n.state, n.qbo_txn_id, n.qbo_customer_id]),
    [["fbx", "in_qbo", "10662", "502"], ["fsg", "in_qbo", "10621", "502"]]);
  assert.deepEqual(res.cards, []);
});

test("a store invoice QuickBooks dates up to two weeks off is still the receipt's when its DocNumber carries the receipt number and the store agrees", () => {
  // Spenard 700653391: the receipt reads Oct 5, the bookkeeper entered the invoice dated Oct 2 (10630, tagged 517)
  const beech = job({ id: OTHER, address: "292 Beechwood St." });
  const r = sbs({ id: "sbs-0391", job_id: OTHER, receipt_date: "2026-10-05", amount: 87.77, receipt_no: "700653391" });
  const p10630 = p10563({ id: "10630", syncToken: "1", txnDate: "2026-10-02", total: 87.77, docNumber: "700653391",
    lines: [line({ amount: 87.77, customerId: "517", customerName: "292 Beechwood St. - Stevens", projectRef: "815364056" })] });
  const state = (p, over = {}) => {
    const n = noteOf(run({ receipts: [{ ...r, ...over }], purchases: [p], jobs: [beech] }), "sbs-0391");
    return n.state === "in_qbo" ? `in_qbo ${n.qbo_txn_id}` : n.detail.reason;
  };
  assert.equal(state(p10630), "in_qbo 10630");
  assert.equal(state({ ...p10630, txnDate: "2026-09-21" }), "in_qbo 10630");             // 14 days before
  assert.equal(state({ ...p10630, txnDate: "2026-10-19" }), "in_qbo 10630");             // 14 days after (the lane never reads past today)
  assert.equal(state({ ...p10630, txnDate: "2026-09-20" }), "store_not_entered");        // 15 days: too far
  assert.equal(state({ ...p10630, txnDate: "2026-10-20" }), "store_not_entered");
  assert.equal(state({ ...p10630, docNumber: "700653392" }), "store_not_entered");      // another invoice
  assert.equal(state({ ...p10630, docNumber: "" }), "store_not_entered");               // no invoice number to go by
  // the receipt number must name a store: a receipt with no vendor family gets no slack
  assert.equal(state(p10630, { vendor: "Joe's Lumber" }), "store_not_entered");
  // inside the usual -1..+3 days nothing changed: the same expense with no DocNumber still matches on store + date
  assert.equal(state({ ...p10630, txnDate: "2026-10-05", docNumber: "" }), "in_qbo 10630");
  // and the window QuickBooks is asked for reaches back that far
  assert.deepEqual(purchaseWindow([r], TODAY), { from: "2026-09-21", to: TODAY });
});

test("C & R Pipe and Steel is \"Pipe and Steel\" in QuickBooks: its debit-card charge matches, and a job with no project waits for its link", () => {
  const brighton = job({ id: OTHER, address: "330 Brighton" });
  const r = hd({ id: "cr-1006", job_id: OTHER, vendor: "C & R Pipe and Steel, Inc.", receipt_date: "2026-10-06", amount: 622,
    card_last4: "0442", receipt_no: "1044131" });
  // 10646: Cash from 8992 checking (card 0442 is a debit card there), tagged by hand to customer 514, which is not a project
  const p10646 = p10577({ id: "10646", txnDate: "2026-10-06", total: 622, paymentType: "Cash", accountId: "9", accountName: "8992-MMB- Checking",
    vendorName: "Pipe and Steel", docNumber: "ZZ35725D8WZ2", note: "Pipe and steel", lines: [line({ amount: 622, customerId: "514",
      customerName: "330 Brighton - Kertzmann" })], attachments: ["IMG_9690.jpg"], hasAttachment: true });
  assert.equal(scoreOf(r, p10646), 2 + 1);
  assert.equal(contradicts(r, p10646), false);
  const res = run({ receipts: [r], purchases: [p10646], jobs: [brighton] });
  assert.deepEqual(noteOf(res, "cr-1006"), { receipt_id: "cr-1006", job_id: OTHER, amount: 622, receipt_date: "2026-10-06",
    state: "unmatched", qbo_txn_type: "Purchase", qbo_txn_id: "10646", qbo_sync_token: "0", qbo_customer_id: "514",
    detail: { reason: "needs_job_link", qbo_doc_number: "ZZ35725D8WZ2", qbo_account_name: "8992-MMB- Checking", qbo_total: 622 } });
  assert.deepEqual(res.cards, []);
});

test("a return slip (\"<receipt id>~ret\") gets its row like any receipt, and matches the store's credit", () => {
  const ret = sbs({ id: "1e676fb6-0000-4000-8000-000000000001~ret", receipt_date: "2026-10-07", amount: -1146.75, receipt_no: "700665392" });
  let res = run({ receipts: [ret], jobs: [job({ link: LINK })] });
  assert.equal(noteOf(res, ret.id).detail.reason, "store_not_entered");
  const credit = p10563({ id: "10700", txnDate: "2026-10-09", total: 1146.75, credit: true, docNumber: "700665392",
    lines: [line({ amount: 1146.75 })], attachments: [], hasAttachment: false });
  res = run({ receipts: [ret], purchases: [credit], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.receipt_id, i.qbo_txn_id, i.changes.join("+")]), [[ret.id, "10700", "tag+attach"]]);
});

test("a contradicted expense is no match: the receipt stays unmatched instead of tagging and photographing someone else's expense", () => {
  const bought = (id) => oct7.PURCHASES.find((p) => p.id === id);
  let res = run({ receipts: [hd({ card_last4: "0442" })], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
  assert.equal(noteOf(res, "r1").detail.reason, "waiting_feed");
  res = run({ receipts: [sw({ receipt_date: "2026-09-30", amount: 632.92, receipt_no: "" }),
    sbs({ receipt_date: "2026-09-29", amount: 1136.54, receipt_no: "" })],
  purchases: [bought("10570"), bought("10565")], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
  assert.deepEqual(reasons(res), { r2: "store_not_entered", r3: "store_not_entered" });
  const lowes = hd({ vendor: "Lowe's #2563", receipt_date: "2026-10-01", amount: 25, card_last4: "4558", receipt_no: "" });
  const fred = p10577({ id: "20001", txnDate: "2026-10-01", total: 25, paymentType: "Cash", accountId: "9", accountName: "8992-MMB- Checking",
    vendorName: "", note: "4558 VSA PUR FRED MEYER #0071 FAIRBANKS AK", lines: [line({ amount: 25 })] });
  res = run({ receipts: [lowes], purchases: [fred], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
});

test("purchaseWindow asks QuickBooks from 14 days before the oldest receipt it will match to today, and not at all when there is none", () => {
  assert.equal(purchaseWindow([], TODAY), null);
  assert.equal(purchaseWindow([hd({ amount: 0 }), hd({ deleted_at: "2026-10-01T00:00:00Z" }), hd({ receipt_date: "2026-07-01" }),
    hd({ receipt_date: "2026-10-09" }), hd({ receipt_date: null })], TODAY), null);
  assert.deepEqual(purchaseWindow([hd(), sbs(), hd({ receipt_date: "2026-07-01" })], TODAY), { from: "2026-09-14", to: TODAY });
  assert.deepEqual(purchaseWindow([hd({ receipt_date: "2026-08-09" })], TODAY), { from: "2026-07-26", to: TODAY });   // 60 days back
  assert.equal(purchaseWindow([hd({ receipt_date: "2026-08-08" })], TODAY), null);
  assert.deepEqual(purchaseWindow(oct7.RECEIPTS, oct7.TODAY), { from: "2026-09-04", to: "2026-10-08" });
});

test("matchReceipts needs today as a date", () => {
  assert.throws(() => matchReceipts({ today: "10/08/2026" }), /today/);
  assert.throws(() => matchReceipts({}), /today/);
});

/* ---- the real shapes ---- */

test("Purchase 10577 (Home Depot by bank rule, untagged, no photo) on a linked job: one tag + attach item, exactly as the executor reads it", () => {
  const res = run({ receipts: [hd()], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.notes, []);
  assert.equal(res.cards.length, 1);
  assert.deepEqual(res.cards[0], {
    job_id: ALSTON,
    job_name: "2156 Alston rd.",
    input: {
      job_id: ALSTON, job_name: "2156 Alston rd.", qbo_customer_id: "112", qbo_name: "Pollen Apartments",
      items: [{
        receipt_id: "r1", vendor: "The Home Depot #1303", date: "2026-09-30", amount: 1369.5, receipt_no: "1303 00001 50615",
        qbo_txn_type: "Purchase", qbo_txn_id: "10577", qbo_sync_token: "0", qbo_doc_number: "",
        qbo_account_name: "3176 - Citi - Home Depot Consumer Credit Card", qbo_vendor_name: "Home Depot", qbo_total: 1369.5,
        changes: ["tag", "attach"], photo_refs: [photo(1)], project_ref: "412739523", read_photo_ref: photo(1),
      }],
      total_usd: 1369.5,
      matcher: MATCHER,
    },
    rationale: "1 receipt on 2156 Alston rd. matches a QuickBooks expense that has no job tag or photo.",
    evidence_refs: [],
  });
  assert.equal(MATCHER, "receipts.qbo_match@1");
});

test("Purchase 10563 (Spenard, tagged 112, PDF attached) is in_qbo, and its tag suggests the unlinked job's project for the Home Depot item", () => {
  const res = run({ receipts: [hd(), sbs()], purchases: [p10577(), p10563()] });
  assert.deepEqual(noteOf(res, "r2"), {
    receipt_id: "r2", job_id: ALSTON, amount: 212.28, receipt_date: "2026-09-28", state: "in_qbo",
    qbo_txn_type: "Purchase", qbo_txn_id: "10563", qbo_sync_token: "1", qbo_customer_id: "112",
    detail: { qbo_doc_number: "700624817", qbo_account_name: "Spenard Builders (SBS) - Store Credit", qbo_total: 212.28 },
  });
  const card = cardOf(res);
  assert.deepEqual(card.input.link, {
    qbo_customer_id: "112", qbo_name: "Pollen Apartments", qbo_project_ref: "412739523", source: "suggested_tagged",
    why: "1 of this job's receipts matches a QuickBooks expense already tagged to Pollen Apartments",
  });
  assert.equal(card.input.qbo_customer_id, "112");
  assert.equal(card.input.qbo_name, "Pollen Apartments");
  assert.deepEqual(card.input.items.map((i) => [i.receipt_id, i.qbo_txn_id, i.changes, i.project_ref]),
    [["r1", "10577", ["tag", "attach"], "412739523"]]);
});

test("Sherwin receipt 8066-9 is Purchase 10566 (DocNumber 80669163000926) by the digits' prefix: in_qbo", () => {
  const res = run({ receipts: [sw()], purchases: [p10566()] });
  assert.deepEqual(res.cards, []);
  assert.equal(noteOf(res, "r3").state, "in_qbo");
  assert.equal(noteOf(res, "r3").qbo_txn_id, "10566");
  assert.equal(noteOf(res, "r3").qbo_sync_token, "2");
  assert.equal(noteOf(res, "r3").qbo_customer_id, "112");
  assert.equal(noteOf(res, "r3").detail.qbo_doc_number, "80669163000926");
});

test("an amount collision is decided by the vendor: a Spenard expense at $67.88 never takes the Home Depot receipt at $67.88", () => {
  // In the books 10560 is $67.87, a cent off; here it is $67.88 on the same day to make the collision.
  const p10519 = p10577({ id: "10519", txnDate: "2026-09-28", total: 67.88, lines: [line({ amount: 67.88 })] });
  const p10560 = p10563({ id: "10560", syncToken: "0", txnDate: "2026-09-28", total: 67.88, docNumber: "700602163",
    lines: [line({ amount: 67.88, ...POLLEN })], attachments: ["SBS_InvNo_700602163.pdf"] });
  const hdR = hd({ id: "r03", receipt_date: "2026-09-28", amount: 67.88, receipt_no: "1303 00002 79356" });
  let res = run({ receipts: [hdR], purchases: [p10560, p10519], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => i.qbo_txn_id), ["10519"]);
  // and the Spenard receipt of the same amount still finds its own invoice
  const sbsR = sbs({ id: "r04", amount: 67.88, receipt_no: "700602163" });
  res = run({ receipts: [sbsR, hdR], purchases: [p10560, p10519], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.receipt_id, i.qbo_txn_id]), [["r03", "10519"]]);
  assert.equal(noteOf(res, "r04").state, "in_qbo");
  assert.equal(noteOf(res, "r04").qbo_txn_id, "10560");
});

test("unmatched reasons: a card charge waits two weeks for the bank feed, an account receipt is a store invoice not entered (a dump ticket a bill not checked), the rest are not found", () => {
  const res = run({
    receipts: [
      hd({ id: "hd-0805", receipt_date: "2026-10-05", amount: 8.8, receipt_no: "1303 00001 59293" }),
      hd({ id: "cr-1006", vendor: "C & R Pipe and Steel, Inc.", receipt_date: "2026-10-06", amount: 622, card_last4: "0442", receipt_no: "1044131" }),
      hd({ id: "fnsb", vendor: "FNSB Solid Waste Division #001", receipt_date: "2026-10-01", amount: 34.04, category: "dump",
        paid_with: "account", card_last4: "", receipt_no: "01286734" }),
      hd({ id: "card-14d", receipt_date: "2026-09-24", amount: 11 }),
      hd({ id: "card-15d", receipt_date: "2026-09-23", amount: 12 }),
      hd({ id: "cash", paid_with: "cash", amount: 13 }),
      hd({ id: "personal", paid_with: "personal", amount: 14 }),
      hd({ id: "blank", paid_with: "", amount: 15 }),
    ],
    purchases: [p10577()],
    jobs: [job({ link: LINK })],
  });
  assert.deepEqual(reasons(res), {
    "hd-0805": "waiting_feed", "cr-1006": "waiting_feed", fnsb: "bill_not_checked",
    "card-14d": "waiting_feed", "card-15d": "not_found", cash: "not_found", personal: "not_found", blank: "not_found",
  });
  assert.deepEqual(noteOf(res, "hd-0805"), {
    receipt_id: "hd-0805", job_id: ALSTON, amount: 8.8, receipt_date: "2026-10-05", state: "unmatched",
    qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null, qbo_customer_id: null, detail: { reason: "waiting_feed" },
  });
  assert.deepEqual(res.cards, []);
});

test("QuickBooks Time: a job whose jobcode is named exactly like one project (1192 Bemis Ct. = 444) is suggested that project", () => {
  const bemis = job({ id: OTHER, address: "1192 Bemis Ct", qbJobcodeName: "  1192 BEMIS CT. " });
  const res = run({ receipts: [hd({ job_id: OTHER })], purchases: [p10577()], jobs: [bemis] });
  const card = cardOf(res, OTHER);
  assert.deepEqual(card.input.link, {
    qbo_customer_id: "444", qbo_name: "1192 Bemis Ct.", qbo_project_ref: null, source: "suggested_qbtime",
    why: "the job's QuickBooks Time jobcode is \"1192 BEMIS CT.\", the same name as this project",
  });
  assert.equal(card.input.qbo_customer_id, "444");
  assert.deepEqual(card.input.items[0].changes, ["tag", "attach"]);
  assert.equal(card.input.items[0].project_ref, null);   // nothing tagged to 444 was seen, so its ProjectRef is unknown

  // a ProjectRef seen beside 444 on any pulled line is learned
  const seen = p10563({ id: "10001", txnDate: "2026-09-01", lines: [line({ customerId: "444", projectRef: "418000001" })] });
  const learned = run({ receipts: [hd({ job_id: OTHER })], purchases: [p10577(), seen], jobs: [bemis] });
  assert.equal(cardOf(learned, OTHER).input.link.qbo_project_ref, "418000001");
  assert.equal(cardOf(learned, OTHER).input.items[0].project_ref, "418000001");
});

test("no QuickBooks Time suggestion from a name two projects share, or from a sub-customer that is not a project", () => {
  const twins = [...oct7.PROJECTS, { id: "900", name: "1192 Bemis Ct.", fqn: "", parentId: "899", isProject: true }];
  let res = run({ receipts: [hd({ job_id: OTHER })], purchases: [p10577()], projects: twins,
    jobs: [job({ id: OTHER, qbJobcodeName: "1192 Bemis Ct." })] });
  assert.equal(noteOf(res, "r1").detail.reason, "needs_job_link");
  res = run({ receipts: [hd({ job_id: OTHER })], purchases: [p10577()], jobs: [job({ id: OTHER, qbJobcodeName: "330 Brighton Sub" })] });
  assert.equal(noteOf(res, "r1").detail.reason, "needs_job_link");
});

test("the tagged suggestion needs every matched expense on one project, and no jobcode naming another", () => {
  let res = run({ receipts: [hd(), sbs()], purchases: [p10577(), p10563()], jobs: [job({ qbJobcodeName: "Pollen Apartments" })] });
  assert.equal(cardOf(res).input.link.source, "suggested_tagged");
  assert.equal(cardOf(res).input.link.qbo_customer_id, "112");
  // the jobcode names another project (444): a person decides, so nothing is suggested
  res = run({ receipts: [hd(), sbs()], purchases: [p10577(), p10563()], jobs: [job({ qbJobcodeName: "1192 Bemis Ct." })] });
  assert.deepEqual(reasons(res), { r1: "needs_job_link", r2: "needs_job_link" });
  assert.equal(noteOf(res, "r2").qbo_customer_id, "112");
  assert.deepEqual(res.cards, []);

  // tagged to two customers: no suggestion, so nothing tags; both stay unmatched with the tag they carry
  const cindy = p10566({ lines: [line({ amount: 36, customerId: "399", customerName: "264 Cindy dr.", projectRef: "" })] });
  res = run({ receipts: [hd(), sbs(), sw()], purchases: [p10577(), p10563(), cindy] });
  assert.deepEqual(reasons(res), { r1: "needs_job_link", r2: "needs_job_link", r3: "needs_job_link" });
  assert.equal(noteOf(res, "r2").qbo_customer_id, "112");
  assert.equal(noteOf(res, "r3").qbo_customer_id, "399");
  assert.equal(noteOf(res, "r1").qbo_customer_id, null);
  assert.deepEqual(res.cards, []);
});

test("a line tagged to the parent customer (111), or to a sub-customer that is not a project (514), suggests no link", () => {
  // the real books: 10509 ($349.46, Home Depot) is tagged to 111 alone; its project is 112 Pollen Apartments
  const p10509 = oct7.PURCHASES.find((p) => p.id === "10509");
  const r10509 = hd({ id: "r0", receipt_date: "2026-09-25", amount: 349.46, receipt_no: "" });
  let res = run({ receipts: [r10509, hd()], purchases: [p10509, oct7.PURCHASES.find((p) => p.id === "10577")] });
  assert.deepEqual(reasons(res), { r0: "needs_job_link", r1: "needs_job_link" });
  assert.equal(noteOf(res, "r0").qbo_customer_id, "111");
  assert.deepEqual(res.cards, []);
  // the jobcode then decides: 112, and the expense tagged to the parent is not this job's to change
  res = run({ receipts: [r10509, hd()], purchases: [p10509, oct7.PURCHASES.find((p) => p.id === "10577")],
    jobs: [job({ qbJobcodeName: "Pollen Apartments" })] });
  assert.equal(cardOf(res).input.link.source, "suggested_qbtime");
  assert.equal(cardOf(res).input.link.qbo_customer_id, "112");
  assert.equal(noteOf(res, "r0").detail.reason, "tagged_other");
  assert.deepEqual(itemsOf(res).map((i) => [i.receipt_id, i.changes]), [["r1", ["tag", "attach"]]]);
  // a sub-customer that is not a project, or one listProjects did not return (inactive)
  for (const customerId of ["514", "9999"]) {
    res = run({ receipts: [hd()], purchases: [p10577({ attachments: ["x.pdf"], hasAttachment: true,
      lines: [line({ amount: 1369.5, customerId, customerName: "Brighton" })] })] });
    assert.deepEqual(reasons(res), { r1: "needs_job_link" }, customerId);
    assert.deepEqual(res.cards, [], customerId);
  }
});

/* ---- the hard filters ---- */

test("a candidate needs the exact cents, the receipt's sign, and a date from a day before to three days after", () => {
  const cases = [
    [{}, true],
    [{ total: 1369.49 }, false], [{ total: 1369.51 }, false],
    [{ credit: true }, false],
    [{ txnDate: "2026-09-29" }, true], [{ txnDate: "2026-09-28" }, false],
    [{ txnDate: "2026-10-03" }, true], [{ txnDate: "2026-10-04" }, false],
    [{ id: "P-1" }, false], [{ syncToken: "" }, false],
  ];
  for (const [over, matches] of cases) {
    const res = run({ receipts: [hd()], purchases: [p10577(over)], jobs: [job({ link: LINK })] });
    assert.equal(itemsOf(res).length, matches ? 1 : 0, JSON.stringify(over));
    if (!matches) assert.equal(noteOf(res, "r1").detail.reason, "waiting_feed", JSON.stringify(over));
  }
});

test("a return (negative receipt) matches only a credit, and a credit never matches a purchase", () => {
  const ret = hd({ id: "ret", receipt_date: "2026-10-02", amount: -45.06, receipt_no: "1303 00002 87987" });
  const charge = p10577({ id: "10614", txnDate: "2026-10-02", total: 45.06, lines: [line({ amount: 45.06 })] });
  const credit = p10577({ id: "10615", txnDate: "2026-10-02", total: 45.06, credit: true, lines: [line({ amount: 45.06 })] });
  let res = run({ receipts: [ret], purchases: [charge, credit], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.qbo_txn_id, i.amount, i.qbo_total]), [["10615", -45.06, 45.06]]);
  assert.equal(cardOf(res).input.total_usd, 45.06);
  res = run({ receipts: [hd({ id: "buy", receipt_date: "2026-10-02", amount: 45.06 })], purchases: [credit], jobs: [job({ link: LINK })] });
  assert.equal(itemsOf(res).length, 0);
});

test("a score under 2 is no match: the amount and the date alone prove nothing", () => {
  const stranger = hd({ vendor: "Joe's Plumbing", card_last4: "", receipt_no: "" });
  let res = run({ receipts: [stranger], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.equal(noteOf(res, "r1").detail.reason, "waiting_feed");
  // the card's last four and the same day make 2
  res = run({ receipts: [{ ...stranger, card_last4: "3176" }], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.equal(itemsOf(res).length, 1);
});

test("an expense another live receipt holds in_qbo, or one approved (queued, done), is never offered to a second receipt", () => {
  const done10577 = p10577({ lines: [line({ amount: 1369.5, ...POLLEN })], attachments: ["x [r:r9].jpg"], hasAttachment: true });
  const r9 = hd({ id: "r9", job_id: OTHER });
  const holds = (state, receipt_id = "r9") => ({ receipt_id, job_id: OTHER, state, qbo_txn_type: "Purchase", qbo_txn_id: "10577",
    qbo_sync_token: "0", qbo_customer_id: "112", amount: 1369.5, receipt_date: "2026-09-30", detail: {} });
  const jobs = [job({ link: LINK }), job({ id: OTHER, link: { ...LINK, job_id: OTHER } })];

  // r1 would win the tie by id; r9's in_qbo row keeps the expense with r9
  let res = run({ receipts: [hd(), r9], purchases: [done10577], links: [holds("in_qbo")], jobs });
  assert.equal(noteOf(res, "r9").state, "in_qbo");
  assert.equal(noteOf(res, "r1").detail.reason, "waiting_feed");
  // without the row, the earlier id takes it
  res = run({ receipts: [hd(), r9], purchases: [done10577], jobs });
  assert.equal(noteOf(res, "r1").state, "in_qbo");
  assert.equal(noteOf(res, "r9").detail.reason, "waiting_feed");

  // an in_qbo row whose receipt is gone holds nothing (tonight's note removes it); a failed one never held
  for (const state of ["in_qbo", "failed"]) {
    res = run({ receipts: [hd()], purchases: [p10577()], links: [holds(state, "gone")], jobs });
    assert.deepEqual(itemsOf(res).map((i) => i.qbo_txn_id), ["10577"], state);
  }
  // an approved one holds it even when its receipt is gone: QuickBooks already has, or is getting, that write
  for (const state of ["queued", "done"]) {
    res = run({ receipts: [hd()], purchases: [p10577()], links: [holds(state, "gone")], jobs });
    assert.equal(noteOf(res, "r1").detail.reason, "waiting_feed", state);
  }
});

test("one expense goes to one receipt: the surest receipt chooses first, then the earlier date and id", () => {
  // r0 sorts first but only agrees on the vendor (2); r5 has the vendor, the day and the card (4)
  const weak = hd({ id: "r0", receipt_date: "2026-09-28", card_last4: "" });
  const strong = hd({ id: "r5" });
  let res = run({ receipts: [weak, strong], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => i.receipt_id), ["r5"]);
  assert.equal(noteOf(res, "r0").detail.reason, "waiting_feed");
  // two equal receipts, one expense: the earlier id, the same every night
  res = run({ receipts: [hd({ id: "r7" }), hd({ id: "r6" })], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => i.receipt_id), ["r6"]);
  assert.equal(noteOf(res, "r7").detail.reason, "waiting_feed");
});

/* ---- what is never written ---- */

test("two equally good expenses: a conflict (ambiguous) naming both, and no write", () => {
  const twin = p10577({ id: "10578" });
  const res = run({ receipts: [hd()], purchases: [twin, p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
  assert.deepEqual(noteOf(res, "r1"), {
    receipt_id: "r1", job_id: ALSTON, amount: 1369.5, receipt_date: "2026-09-30", state: "conflict",
    qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null, qbo_customer_id: null,
    detail: { reason: "ambiguous", candidates: ["10577", "10578"] },
  });
  assert.equal(res.stats.conflicts, 1);
});

test("an expense tagged to another job is a conflict (tagged_other) with that customer; a tag already set is never changed", () => {
  const cindy = p10577({ lines: [line({ amount: 1369.5, customerId: "399", customerName: "264 Cindy dr." })] });
  const res = run({ receipts: [hd()], purchases: [cindy], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
  assert.deepEqual(noteOf(res, "r1"), {
    receipt_id: "r1", job_id: ALSTON, amount: 1369.5, receipt_date: "2026-09-30", state: "conflict",
    qbo_txn_type: "Purchase", qbo_txn_id: "10577", qbo_sync_token: "0", qbo_customer_id: "399",
    detail: { reason: "tagged_other", qbo_customer_name: "264 Cindy dr.",
      qbo_account_name: "3176 - Citi - Home Depot Consumer Credit Card", qbo_total: 1369.5 },
  });
});

test("an expense with some lines tagged and some not is a conflict (partly_tagged)", () => {
  const split = p10577({ lines: [line({ amount: 1000, ...POLLEN }), line({ id: "2", amount: 369.5 })] });
  const res = run({ receipts: [hd()], purchases: [split], jobs: [job({ link: LINK })] });
  assert.deepEqual(res.cards, []);
  assert.equal(noteOf(res, "r1").state, "conflict");
  assert.equal(noteOf(res, "r1").detail.reason, "partly_tagged");
  assert.equal(noteOf(res, "r1").qbo_customer_id, "112");
});

test("needs_job_link: a job with no project and no suggestion gets nothing on a card, not even the photo, until it is linked", () => {
  let res = run({ receipts: [hd()], purchases: [p10577()] });
  assert.deepEqual(noteOf(res, "r1"), {
    receipt_id: "r1", job_id: ALSTON, amount: 1369.5, receipt_date: "2026-09-30", state: "unmatched",
    qbo_txn_type: "Purchase", qbo_txn_id: "10577", qbo_sync_token: "0", qbo_customer_id: null,
    detail: { reason: "needs_job_link", qbo_account_name: "3176 - Citi - Home Depot Consumer Credit Card", qbo_total: 1369.5 },
  });
  // an attach approved now would leave the receipt done, and its tag never offered once the job is linked
  assert.deepEqual(res.cards, []);
  // linked, the same night files the tag and the photo together
  res = run({ receipts: [hd()], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => i.changes), [["tag", "attach"]]);
  // two expenses the books tag to two other jobs, neither with a document: nothing goes on them
  const tagged = (id, customerId, txnDate, total) => p10577({ id, txnDate, total, lines: [line({ amount: total, customerId })] });
  res = run({ receipts: [hd({ id: "r1", receipt_date: "2026-09-29", amount: 40 }), hd({ id: "r2", receipt_date: "2026-09-29", amount: 41 })],
    purchases: [tagged("801", "112", "2026-09-29", 40), tagged("802", "517", "2026-09-29", 41)] });
  assert.deepEqual(reasons(res), { r1: "needs_job_link", r2: "needs_job_link" });
  assert.deepEqual(res.notes.map((n) => n.qbo_customer_id), ["112", "517"]);
  assert.deepEqual(res.cards, []);
  // no photo, or the expense already has a document: nothing to approve
  res = run({ receipts: [hd({ photo_ref: null })], purchases: [p10577()] });
  assert.deepEqual(res.cards, []);
  res = run({ receipts: [hd()], purchases: [p10577({ attachments: ["statement.pdf"], hasAttachment: true })] });
  assert.deepEqual(res.cards, []);
  assert.equal(noteOf(res, "r1").detail.reason, "needs_job_link");
});

test("a photo not yet offloaded (no media marker) means tag only; a document already there means no attach", () => {
  let res = run({ receipts: [hd({ photo_ref: null })], purchases: [p10577()], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.changes, i.photo_refs, i.read_photo_ref]), [[["tag"], [], null]]);
  // the photo as read rides on a tag-only item too, so the door can tell it arrived since
  res = run({ receipts: [hd()], purchases: [p10577({ attachments: ["receipt.jpg"], hasAttachment: true })], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.photo_refs, i.read_photo_ref]), [[[], photo(1)]]);
  res = run({ receipts: [hd()], purchases: [p10577({ attachments: ["receipt.jpg"], hasAttachment: true })], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.changes, i.photo_refs]), [[["tag"], []]]);
  // tagged to the job already, no document: attach only, and no project_ref (nothing is tagged)
  res = run({ receipts: [hd()], purchases: [p10577({ lines: [line({ amount: 1369.5, ...POLLEN })] })], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.changes, i.project_ref]), [[["attach"], null]]);
  assert.equal(cardOf(res).input.qbo_customer_id, "");
});

test("receipts the approval path owns (queued, done, failed) are skipped and counted; their notes are the door's to keep", () => {
  const owned = (state) => ({ receipt_id: "r1", job_id: ALSTON, state, qbo_txn_type: "Purchase", qbo_txn_id: "10577",
    qbo_sync_token: "0", qbo_customer_id: "112", amount: 1369.5, receipt_date: "2026-09-30", detail: {} });
  for (const state of ["queued", "done", "failed"]) {
    const res = run({ receipts: [hd(), hd({ id: "r2" })], purchases: [p10577()], links: [owned(state)], jobs: [job({ link: LINK })] });
    assert.equal(noteOf(res, "r1"), undefined, state);
    assert.equal(res.stats.owned[state], 1, state);
    // a failed row no longer holds its expense, so the twin receipt may take it
    assert.deepEqual(itemsOf(res).map((i) => i.receipt_id), state === "failed" ? ["r2"] : [], state);
  }
});

test("an older receipt keeps its row as it was (on the job it is on now), so the note door does not remove it; a $0 receipt gets none", () => {
  const old = hd({ id: "old", receipt_date: "2026-07-01", amount: 99 });
  const ahead = hd({ id: "ahead", receipt_date: "2026-10-09", amount: 98 });
  const zero = hd({ id: "zero", amount: 0 });
  const was = (receipt_id, over = {}) => ({ receipt_id, job_id: OTHER, state: "unmatched", qbo_txn_type: null, qbo_txn_id: null,
    qbo_sync_token: null, qbo_customer_id: null, amount: 99, receipt_date: "2026-07-01", detail: { reason: "not_found" },
    changes: [], proposal_id: null, outbox_id: null, updated_at: "2026-07-02T00:00:00Z", ...over });
  const res = run({ receipts: [old, ahead, zero, hd({ id: "bare", receipt_date: "2026-06-01" })],
    links: [was("old"), was("ahead", { state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10001", qbo_sync_token: "3",
      qbo_customer_id: "112", amount: "98.00", receipt_date: "2026-10-09", detail: { qbo_total: 98 } }), was("zero")] });
  assert.deepEqual(res.notes, [
    { receipt_id: "ahead", job_id: ALSTON, state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10001", qbo_sync_token: "3",
      qbo_customer_id: "112", amount: 98, receipt_date: "2026-10-09", detail: { qbo_total: 98 } },
    { receipt_id: "old", job_id: ALSTON, state: "unmatched", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null,
      qbo_customer_id: null, amount: 99, receipt_date: "2026-07-01", detail: { reason: "not_found" } },
  ]);
  assert.equal(res.stats.carried, 2);
  assert.deepEqual(res.stats.jobs, []);   // nothing was matched, so no door call is owed
});

test("receipts on a missing, deleted or malformed job, deleted receipts, odd ids and a second live row of one id are left out", () => {
  const res = run({
    receipts: [
      hd({ id: "r1" }),
      hd({ id: "r1", job_id: "ffffffff-0000-4000-8000-000000000009" }),   // the same id on a later job: the first by job wins
      hd({ id: "gone", deleted_at: "2026-10-01T00:00:00Z" }),
      hd({ id: "nojob", job_id: "12345678-0000-4000-8000-000000000000" }),
      hd({ id: "trashed", job_id: OTHER }),
      hd({ id: "bad-job", job_id: "not-a-uuid" }),
      hd({ id: "has space", amount: 5 }),
      hd({ id: "x".repeat(65), amount: 6 }),
    ],
    purchases: [p10577()],
    jobs: [job({ link: LINK }), job({ id: OTHER, deleted: true }), job({ id: "ffffffff-0000-4000-8000-000000000009" }),
      job({ id: "not-a-uuid" })],
  });
  assert.deepEqual(res.notes, []);
  assert.deepEqual(res.cards.map((c) => [c.job_id, c.input.items.map((i) => i.receipt_id)]), [[ALSTON, ["r1"]]]);
  assert.deepEqual(res.stats.jobs, [ALSTON]);
});

/* ---- store entry (built, off until app_settings names a store) ---- */

test("store entry is off without app_settings: a Spenard receipt nobody entered is store_not_entered", () => {
  const res = run({ receipts: [sbs()], jobs: [job({ link: LINK })] });
  assert.equal(noteOf(res, "r2").detail.reason, "store_not_entered");
  assert.deepEqual(res.cards, []);
});

test("store entry on: an unentered Spenard invoice on a linked job becomes a create + attach item the executor and qbo-proxy accept", () => {
  const res = run({ receipts: [sbs()], jobs: [job({ link: LINK })], storeAccounts: STORES });
  assert.deepEqual(res.notes, []);
  const card = cardOf(res);
  assert.equal(card.input.qbo_customer_id, "112");
  assert.deepEqual(card.input.items, [{
    receipt_id: "r2", vendor: "Spenard Builders Supply", date: "2026-09-28", amount: 212.28, receipt_no: "700624817",
    qbo_txn_type: "Purchase", qbo_txn_id: "", qbo_sync_token: "", qbo_doc_number: "700624817", qbo_account_name: "",
    qbo_total: null, changes: ["create", "attach"], photo_refs: [photo(2)], project_ref: "412739523", read_photo_ref: photo(2),
    create: {
      account_id: "53", vendor_id: "65", payment_type: "CreditCard", credit: false, doc_number: "700624817",
      expense_account_id: "42", class_id: "1000000001", txn_date: "2026-09-28", amount_abs: 212.28,
      memo: "Spenard Builders Supply 700624817 (from the job receipts app)",
    },
  }]);
  assert.equal(card.rationale, "1 store invoice on 2156 Alston rd. is not in QuickBooks yet.");
});

test("store entry: Sherwin's number goes as its digits, equipment books to the rental account, a return is a credit, no photo is create only", () => {
  const res = run({
    receipts: [
      sw({ id: "a", receipt_no: "8230-1" }),
      sbs({ id: "b", category: "equipment", receipt_no: "700611111" }),
      sbs({ id: "c", amount: -20, receipt_no: "700622222", photo_ref: null }),
    ],
    purchases: [p10563({ id: "10002", txnDate: "2026-08-15" })],   // names account 53, so the store entry shows its account
    jobs: [job({ link: LINK })], storeAccounts: STORES,
  });
  const byId = Object.fromEntries(itemsOf(res).map((i) => [i.receipt_id, i]));
  assert.equal(byId.a.create.doc_number, "82301");
  assert.equal(byId.a.qbo_doc_number, "82301");
  assert.equal(byId.a.create.account_id, "52");
  assert.equal(byId.b.create.expense_account_id, EQUIPMENT_EXPENSE_ACCOUNT);
  assert.equal(byId.b.qbo_account_name, "Spenard Builders (SBS) - Store Credit");
  assert.equal(byId.c.create.credit, true);
  assert.equal(byId.c.create.amount_abs, 20);
  assert.deepEqual(byId.c.changes, ["create"]);
  assert.deepEqual(byId.c.photo_refs, []);
});

test("store entry never enters a dump ticket, waits min_age_days, needs the job's project, and ignores a malformed store", () => {
  const withFnsb = { ...STORES, fnsb: { account_id: "9", vendor_id: "70", expense_account_id: "42" } };
  const dump = sbs({ id: "dump", vendor: "FNSB Solid Waste Division #001", category: "dump", receipt_no: "01286734" });
  let res = run({ receipts: [dump], jobs: [job({ link: LINK })], storeAccounts: withFnsb });
  assert.equal(noteOf(res, "dump").detail.reason, "bill_not_checked");

  const waiting = { spenard: { ...STORES.spenard, min_age_days: 14 } };
  res = run({ receipts: [sbs()], jobs: [job({ link: LINK })], storeAccounts: waiting });   // 10 days old
  assert.equal(noteOf(res, "r2").detail.reason, "store_not_entered");
  res = run({ receipts: [sbs({ receipt_date: "2026-09-24" })], jobs: [job({ link: LINK })], storeAccounts: waiting });
  assert.deepEqual(itemsOf(res)[0].changes, ["create", "attach"]);

  res = run({ receipts: [sbs()], storeAccounts: STORES });
  assert.equal(noteOf(res, "r2").detail.reason, "needs_job_link");

  for (const bad of [{ spenard: { ...STORES.spenard, account_id: "SBS" } }, { spenard: { ...STORES.spenard, class_id: "x" } },
    { spenard: null }, [STORES.spenard], "on"]) {
    res = run({ receipts: [sbs()], jobs: [job({ link: LINK })], storeAccounts: bad });
    assert.equal(noteOf(res, "r2").detail.reason, "store_not_entered", JSON.stringify(bad));
  }
  // a receipt number with no digits cannot be looked up, so it is not entered; nor can one under 5 digits,
  // whose prefix starts other invoices' numbers too
  for (const receipt_no of ["n/a", "70", "806-6"]) {
    res = run({ receipts: [sbs({ receipt_no })], jobs: [job({ link: LINK })], storeAccounts: STORES });
    assert.equal(noteOf(res, "r2").detail.reason, "store_not_entered", receipt_no);
    assert.deepEqual(res.cards, [], receipt_no);
  }
  res = run({ receipts: [sbs({ receipt_no: "70062" })], jobs: [job({ link: LINK })], storeAccounts: STORES });
  assert.equal(itemsOf(res)[0].create.doc_number, "70062");
});

/* ---- cards ---- */

test("a card holds at most 50 items, by date then receipt id, and its total is the sum of what it holds", () => {
  const receipts = [], purchases = [];
  for (let n = 0; n < 55; n++) {
    const day = `2026-09-${String(10 + (n % 20)).padStart(2, "0")}`;
    const amount = 10 + n + 0.1;
    receipts.push(hd({ id: `r${String(99 - n).padStart(2, "0")}`, receipt_date: day, amount }));
    purchases.push(p10577({ id: String(20000 + n), txnDate: day, total: amount, lines: [line({ amount })] }));
  }
  const res = run({ receipts, purchases, jobs: [job({ link: LINK })] });
  const items = itemsOf(res);
  assert.equal(items.length, 50);
  const order = [...receipts].sort((a, b) => (a.receipt_date < b.receipt_date ? -1 : a.receipt_date > b.receipt_date ? 1 : a.id < b.id ? -1 : 1));
  assert.deepEqual(items.map((i) => i.receipt_id), order.slice(0, 50).map((r) => r.id));
  assert.equal(res.stats.items, 50);
  assert.equal(cardOf(res).rationale, "50 receipts on 2156 Alston rd. match QuickBooks expenses that have no job tag or photo.");
});

test("the job's name is its title, else its address, else its customer, cut to 160", () => {
  const name = (over) => cardOf(run({ receipts: [hd()], purchases: [p10577()], jobs: [job({ link: LINK, ...over })] })).job_name;
  assert.equal(name({ title: "Pollen apt 4 water" }), "Pollen apt 4 water");
  assert.equal(name({}), "2156 Alston rd.");
  assert.equal(name({ address: "", customer: "Pollen" }), "Pollen");
  assert.equal(name({ title: "x".repeat(200) }).length, 160);
  assert.equal(cardOf(run({ receipts: [hd()], purchases: [p10577()], jobs: [job({ link: LINK, address: "" })] })).rationale,
    "1 receipt on this job matches a QuickBooks expense that has no job tag or photo.");
});

test("scope: every receipt is matched, so an expense goes where a full run would send it, but only the named jobs are answered for", () => {
  const strong = hd();                                                   // ALSTON, score 4
  const weak = hd({ id: "r0", job_id: OTHER, receipt_date: "2026-09-28", card_last4: "" });   // OTHER, score 2
  const jobs = [job({ link: LINK }), job({ id: OTHER, link: { ...LINK, job_id: OTHER } })];
  const res = matchReceipts({ receipts: [strong, weak], purchases: [p10577()], jobs, projects: oct7.PROJECTS, today: TODAY, scope: [OTHER.toUpperCase()] });
  check(res, [OTHER]);
  assert.deepEqual(res.cards, []);
  assert.deepEqual(res.notes.map((n) => [n.receipt_id, n.detail.reason]), [["r0", "waiting_feed"]]);
  assert.deepEqual(res.stats.jobs, [OTHER]);
});

test("the same rows in any order give the same answer", () => {
  const args = { receipts: oct7.RECEIPTS, purchases: oct7.PURCHASES, jobs: oct7.JOB_ROWS, projects: oct7.PROJECTS, today: oct7.TODAY, storeAccounts: STORES };
  const a = matchReceipts(args);
  const b = matchReceipts({ ...args, receipts: [...args.receipts].reverse(), purchases: [...args.purchases].reverse(),
    jobs: [...args.jobs].reverse(), projects: [...args.projects].reverse() });
  assert.deepEqual(b, a);
  assert.deepEqual(a.notes.map((n) => n.receipt_id), [...a.notes.map((n) => n.receipt_id)].sort());
});

/* ---- the Oct 7 books, as they were read ---- */

test("Oct 7: the five untagged Home Depot charges become tag + attach items on 2156 Alston rd., suggested to Pollen Apartments (112)", () => {
  const args = { receipts: oct7.RECEIPTS, purchases: oct7.PURCHASES, links: [], jobs: oct7.JOB_ROWS, projects: oct7.PROJECTS,
    storeAccounts: null, today: oct7.TODAY };
  const res = check(matchReceipts(args), oct7.JOB_ROWS.map((j) => j.id));

  assert.equal(res.cards.length, 1);
  const [card] = res.cards;
  assert.equal(card.job_id, oct7.JOBS.alston);
  assert.ok(card.job_id.startsWith("a628eea5"));
  assert.deepEqual(card.input.link, {
    qbo_customer_id: "112", qbo_name: "Pollen Apartments", qbo_project_ref: "412739523", source: "suggested_tagged",
    why: "4 of this job's receipts match QuickBooks expenses already tagged to Pollen Apartments",
  });
  assert.equal(card.input.qbo_customer_id, "112");
  assert.deepEqual(card.input.items.map((i) => [i.qbo_txn_id, i.amount, i.changes.join("+"), i.project_ref, i.photo_refs.length]), [
    ["10519", 67.88, "tag+attach", "412739523", 1],
    ["10520", 1747.68, "tag+attach", "412739523", 1],
    ["10577", 1369.5, "tag+attach", "412739523", 1],
    ["10584", 27.9, "tag+attach", "412739523", 1],
    ["10614", 45.06, "tag+attach", "412739523", 1],
  ]);
  assert.equal(card.input.total_usd, 3258.02);
  assert.equal(card.rationale, "5 receipts on 2156 Alston rd. match QuickBooks expenses that have no job tag or photo.");

  // the four store invoices the bookkeeper entered by hand are already right
  const inQbo = res.notes.filter((n) => n.state === "in_qbo");
  assert.deepEqual(inQbo.map((n) => n.qbo_txn_id).sort(), ["10489", "10563", "10566", "10568"]);
  for (const n of inQbo) assert.equal(n.qbo_customer_id, "112");

  // and the misses say why
  const vendorOf = Object.fromEntries(oct7.RECEIPTS.map((r) => [r.id, `${r.vendor.split(" ")[0]} ${r.amount}`]));
  const misses = res.notes.filter((n) => n.state !== "in_qbo").map((n) => [vendorOf[n.receipt_id], n.detail.reason]);
  assert.deepEqual(misses, [
    ["Spenard 6.99", "store_not_entered"],
    ["FNSB 34.04", "bill_not_checked"],                  // booked as a Bill, which the matcher does not read
    ["Spenard 44.71", "store_not_entered"],
    ["Sherwin-Williams 11.13", "store_not_entered"],     // 8230-1: not entered by Oct 7
    ["Spenard 130.03", "store_not_entered"],
    ["FS&G 100.98", "store_not_entered"],
    ["The 8.8", "waiting_feed"],                           // Home Depot, Oct 5
    ["Spenard 36.06", "store_not_entered"],
    ["Spenard 38.07", "store_not_entered"],
    ["Spenard 87.77", "store_not_entered"],
    ["The 161.78", "waiting_feed"],                        // Home Depot, Oct 5
    ["Spenard 585.55", "store_not_entered"],
    ["Spenard 28.32", "store_not_entered"],
    ["Spenard 68.1", "store_not_entered"],
    ["C 622", "waiting_feed"],                             // C & R Pipe, card 0442
    ["Spenard 431.34", "store_not_entered"],
    ["Fairbanks 956.23", "waiting_feed"],                  // Fairbanks Block, card 0442
    ["Spenard 1146.75", "store_not_entered"],
  ]);
  assert.equal(noteOf(res, "r25"), undefined);           // the $0.00 Spenard slip
  assert.deepEqual({ ...res.stats, jobs: res.stats.jobs.length }, {
    receipts: 27, matched: 9, in_qbo: 4, unmatched: 18, conflicts: 0, items: 5, carried: 0,
    owned: { queued: 0, done: 0, failed: 0 }, jobs: 5,
  });
});

test("Oct 7 with store entry on: Alston's unentered Spenard and Sherwin invoices join its card; jobs with no project wait for a link", () => {
  const res = check(matchReceipts({ receipts: oct7.RECEIPTS, purchases: oct7.PURCHASES, jobs: oct7.JOB_ROWS, projects: oct7.PROJECTS,
    storeAccounts: STORES, today: oct7.TODAY }), oct7.JOB_ROWS.map((j) => j.id));
  const [card] = res.cards;
  assert.equal(res.cards.length, 1);
  assert.deepEqual(card.input.items.filter((i) => i.changes.includes("create")).map((i) => [i.receipt_id, i.create.doc_number, i.create.account_id]), [
    ["r07", "700643368", "53"], ["r11", "700641116", "53"], ["r12", "82301", "52"], ["r17", "700655224", "53"], ["r18", "700653400", "53"],
  ]);
  assert.equal(card.input.items.length, 10);
  assert.equal(card.rationale, "5 receipts on 2156 Alston rd. match QuickBooks expenses that have no job tag or photo; 5 store invoices are not in QuickBooks yet.");
  assert.deepEqual(res.notes.filter((n) => n.detail.reason === "needs_job_link").map((n) => n.receipt_id),
    ["r14", "r19", "r21", "r22", "r23", "r26", "r28"]);
  assert.equal(noteOf(res, "r10").detail.reason, "bill_not_checked");   // FNSB is a dump ticket (a Bill)
  assert.equal(noteOf(res, "r15").detail.reason, "store_not_entered");   // FS&G is not a configured store
});

test("the fixture holds no email address or phone number", () => {
  const text = fs.readFileSync(new URL("./qbo-oct7.fixture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/);
  assert.doesNotMatch(text, /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/);
});
