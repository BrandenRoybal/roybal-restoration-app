import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchReceipts, purchaseWindow, vendorFamily, docAgrees, scoreOf, contradicts, canonical, MATCHER, EQUIPMENT_EXPENSE_ACCOUNT,
  PAYMENT_CLEARING_ACCOUNT, KEEP_FAILED } from "../lanes/qbomatch.mjs";
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

/** jsonb's text of a value where the SQL compares text (#>>, ->>): a string as is, null as null. */
const textOf = (v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));

/* 0025 replaced the executor and the note door (v2). The executor still
   queues Purchases only (a bill is only noted), and adds: an item in parts
   (2 or 3 charges, distinct, the first the item's own id and token, each
   part's changes within the item's and together covering them, |totals|
   adding up to the receipt), a second try's refile marker, read_photo_ref
   text or null. The note door takes Purchase, Bill or null, and parts on a
   Purchase row only (2 or 3 charges, distinct, the first the row's own). */
function itemProblemsV2(it, i, ch) {
  const p = [];
  const parts = it.parts;
  if (jsonType(parts) !== "null") {
    if (jsonType(parts) !== "array" || parts.length < 2 || parts.length > 3) p.push(`item ${i} parts must list 2 or 3 charges`);
    else if (it.qbo_txn_type !== "Purchase" || ch.includes("create")) p.push(`item ${i} parts on a bill or an entry`);
    else {
      const ids = [], all = [];
      let sum = 0, sumOk = true;
      parts.forEach((x, n) => {
        const j = n + 1;
        if (jsonType(x) !== "object") { p.push(`item ${i} part ${j} is not an object`); sumOk = false; return; }
        if (jsonType(x.qbo_txn_id) !== "string" || !ID.test(x.qbo_txn_id)) p.push(`item ${i} part ${j} qbo_txn_id`);
        else if (ids.includes(x.qbo_txn_id)) p.push(`item ${i} names charge ${x.qbo_txn_id} twice`);
        else ids.push(x.qbo_txn_id);
        if (jsonType(x.qbo_sync_token) !== "string" || !ID.test(x.qbo_sync_token)) p.push(`item ${i} part ${j} qbo_sync_token`);
        if (jsonType(x.qbo_total) !== "number") { p.push(`item ${i} part ${j} qbo_total`); sumOk = false; } else sum += Math.round(Math.abs(x.qbo_total) * 100);
        if (!["string", "null"].includes(jsonType(x.qbo_date)) || (x.qbo_date != null && !DATE.test(x.qbo_date))) p.push(`item ${i} part ${j} qbo_date`);
        const pch = jsonType(x.changes) === "array" ? x.changes : null;
        if (!pch || !pch.every((c) => typeof c === "string") || new Set(pch).size !== pch.length
            || !pch.every((c) => ["tag", "attach"].includes(c)) || !pch.every((c) => ch.includes(c))) {
          p.push(`item ${i} part ${j} changes`);
        } else all.push(...pch);
      });
      if (textOf(parts[0]?.qbo_txn_id) !== textOf(it.qbo_txn_id) || textOf(parts[0]?.qbo_sync_token) !== textOf(it.qbo_sync_token)) {
        p.push(`item ${i} first part must be the charge the item names`);
      }
      if (!ch.every((c) => all.includes(c))) p.push(`item ${i} asks for a change no part asks for`);
      if (sumOk && jsonType(it.amount) === "number" && sum !== Math.round(Math.abs(it.amount) * 100)) p.push(`item ${i} parts do not add up`);
    }
  }
  const rf = it.refile;
  if (!["object", "null"].includes(jsonType(rf)) || (jsonType(rf) === "object" && (
    !["string", "null"].includes(jsonType(rf.proposal_id)) || (rf.proposal_id != null && !UUID.test(rf.proposal_id))
    || jsonType(rf.error) !== "string" || [...rf.error].length > 60
    || !["string", "null"].includes(jsonType(rf.why)) || [...String(rf.why ?? "")].length > 200))) {
    p.push(`item ${i} refile`);
  }
  if (!["string", "null"].includes(jsonType(it.read_photo_ref))) p.push(`item ${i} read_photo_ref`);
  return p;
}

function notePartsProblems(r, i) {
  const p = [];
  if (jsonType(r.parts) === "null") return p;
  if (jsonType(r.parts) !== "array" || r.parts.length < 2 || r.parts.length > 3) return [`row ${i} parts must list 2 or 3 charges`];
  if (r.qbo_txn_type !== "Purchase") return [`row ${i} comes in parts but is not a Purchase`];
  const ids = [];
  r.parts.forEach((x, n) => {
    if (jsonType(x) !== "object" || jsonType(x.qbo_txn_id) !== "string" || !ID.test(x.qbo_txn_id)
        || jsonType(x.qbo_sync_token) !== "string" || !ID.test(x.qbo_sync_token)
        || !["number", "null"].includes(jsonType(x.qbo_total))
        || !["string", "null"].includes(jsonType(x.qbo_date)) || (x.qbo_date != null && !DATE.test(x.qbo_date))) {
      p.push(`row ${i} part ${n + 1}`);
    } else if (ids.includes(x.qbo_txn_id)) p.push(`row ${i} names charge ${x.qbo_txn_id} twice`);
    else ids.push(x.qbo_txn_id);
  });
  if (textOf(r.parts[0]?.qbo_txn_id) !== textOf(r.qbo_txn_id) || textOf(r.parts[0]?.qbo_sync_token) !== textOf(r.qbo_sync_token)) {
    p.push(`row ${i} first part must be the charge the row names`);
  }
  return p;
}

function executorProblems(input, v2 = false) {
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
    if (v2) p.push(...itemProblemsV2(it, i, ch));
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

function noteProblems(jobIds, rows, v2 = false) {
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
    if (jsonType(r.qbo_txn_type) !== "null" && !(v2 ? ["Purchase", "Bill"] : ["Purchase"]).includes(r.qbo_txn_type)) p.push(`row ${i} qbo_txn_type`);
    if (v2) p.push(...notePartsProblems(r, i));
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

/** Every card and every note of a result, through the database's checks:
    0023's (v1), or 0025's (v2). */
function check(res, jobIds, v2 = false) {
  const wire = JSON.parse(JSON.stringify(res));   // what PostgREST is sent: no undefined, no NaN
  assert.deepEqual(wire.notes, res.notes, "notes survive JSON");
  assert.deepEqual(noteProblems(jobIds, res.notes, v2), []);
  const items = res.cards.flatMap((c) => c.input.items);
  if (v2) {
    // a note naming one transaction says it has no parts, so the 0025 door
    // drops a row's old ones instead of keeping them
    for (const n of res.notes) if (n.qbo_txn_id) assert.ok("parts" in n, `${n.receipt_id} names a transaction but not its parts`);
  } else {
    // a v1 database never sees what 0025 added
    for (const x of [...res.notes, ...items]) {
      assert.equal("parts" in x, false, `${x.receipt_id} has parts in v1`);
      assert.equal("refile" in x, false, `${x.receipt_id} has refile in v1`);
      assert.notEqual(x.qbo_txn_type, "Bill", `${x.receipt_id} names a bill in v1`);
    }
  }
  for (const card of res.cards) {
    assert.deepEqual(wire.cards.find((c) => c.job_id === card.job_id), card, "cards survive JSON");
    assert.equal(card.input.job_id, card.job_id);
    assert.equal(card.input.job_name, card.job_name);
    // the door stamps these three; nothing else is added before op_propose
    const stamped = { ...card.input, receipts_fingerprint: "0".repeat(32), items_hash: "f".repeat(32), offer: 0 };
    assert.deepEqual(opValidateInput(INPUT_SCHEMA, stamped), [], `input_schema: job ${card.job_id}`);
    assert.deepEqual(executorProblems(card.input, v2), [], `executor: job ${card.job_id}`);
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
  return check(matchReceipts(args), args.jobs.map((j) => j.id), args.v2 === true);
}
/** A run on a database with 0025 whose bills were read (none, unless given). */
const runV2 = (over = {}) => run({ v2: true, bills: [], ...over });
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

test("the 0025 mirrors take what 0025 takes and refuse what it refuses: a bill is noted only, a receipt in parts, a second try", () => {
  const PROP = "66666666-6666-4666-8666-666666666666";
  const part = (id, total, over = {}) => ({ qbo_txn_id: id, qbo_sync_token: "0", qbo_total: total, qbo_date: "2026-10-02", changes: ["tag", "attach"], ...over });
  const good = { job_id: OTHER, job_name: "1885 Chena Landings Lp.", qbo_customer_id: "502", qbo_name: "1885 Chena Landings Lp.",
    items: [{ receipt_id: "995d2795", vendor: "The Rental Zone", date: "2026-10-07", amount: 351, receipt_no: "R284290",
      qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0", qbo_doc_number: "", qbo_account_name: "", qbo_total: 126.9,
      changes: ["tag", "attach"], photo_refs: [photo(5)], project_ref: null, read_photo_ref: photo(5),
      parts: [part("10615", 126.9), part("10661", 224.1)], refile: { proposal_id: PROP, error: "qbo_throttled", why: "slow down" } }],
    total_usd: 351, matcher: MATCHER };
  assert.deepEqual(executorProblems(good, true), []);
  // v1's executor reads none of it, so a v1 worker must never send it (check() holds v1 results to that)
  const item = (over) => ({ ...good, items: [{ ...good.items[0], ...over }] });
  for (const over of [{ parts: null }, { refile: null }, { refile: { proposal_id: null, error: "failed" } }, { read_photo_ref: null },
    { parts: [part("10615", 126.9), part("10661", 224.1, { changes: [] })] },                       // a charge only checked
    { parts: [part("10615", 126.9), part("10616", 94), part("10661", 130.1)] },                     // three
    { amount: -351, parts: [part("10615", -126.9), part("10661", -224.1)] }]) {                     // |totals| add up
    assert.deepEqual(executorProblems(item(over), true), [], JSON.stringify(over));
  }
  for (const over of [
    { qbo_txn_type: "Bill" },                                                                        // a bill is only noted
    { parts: [part("10615", 351)] },                                                                 // one part
    { parts: [part("10615", 100), part("10661", 100), part("1", 100), part("2", 51)] },              // four
    { parts: [part("10615", 126.9), part("10615", 224.1)] },                                         // the same charge twice
    { parts: [part("10661", 224.1), part("10615", 126.9)] },                                         // the first is not the item's
    { parts: [part("10615", 126.9, { qbo_sync_token: "1" }), part("10661", 224.1)] },                // nor its token
    { parts: [part("10615", 126.9), part("10661", 224.0)] },                                         // a cent short
    { parts: [part("10615", 126.9, { changes: ["tag"] }), part("10661", 224.1, { changes: ["tag"] })] },   // attach asked of none
    { parts: [part("10615", 126.9), part("10661", 224.1, { changes: ["create"] })] },
    { changes: ["tag"], photo_refs: [], parts: [part("10615", 126.9), part("10661", 224.1)] },      // a part asks more than the item
    { parts: [part("10615", 126.9), part("10661", 224.1, { qbo_date: "10/07/2026" })] },
    { parts: [part("10615", 126.9), part("10661", "224.10")] },
    { parts: "10615,10661" },
    { refile: { proposal_id: "p-1", error: "x" } }, { refile: { proposal_id: PROP } },
    { refile: { proposal_id: PROP, error: "e".repeat(61) } }, { refile: { proposal_id: PROP, error: "x", why: "w".repeat(201) } },
    { refile: "again" }, { read_photo_ref: 7 }]) {
    assert.notDeepEqual(executorProblems(item(over), true), [], JSON.stringify(over));
  }
  const create = { account_id: "53", vendor_id: "65", payment_type: "CreditCard", credit: false, doc_number: "70062",
    expense_account_id: "42", class_id: null, txn_date: null, amount_abs: 351, memo: "" };
  assert.notDeepEqual(executorProblems(item({ qbo_txn_id: "", qbo_sync_token: "", changes: ["create", "attach"], create }), true), []);

  const row = { receipt_id: "r1", job_id: ALSTON, state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0",
    qbo_customer_id: "502", amount: 351, receipt_date: "2026-10-07", detail: {}, parts: null };
  const note = (over) => noteProblems([ALSTON], [{ ...row, ...over }], true);
  const noted = (id, total) => ({ qbo_txn_id: id, qbo_sync_token: "0", qbo_total: total, qbo_date: "2026-10-02" });
  for (const over of [{}, { qbo_txn_type: "Bill", qbo_txn_id: "10625" }, { parts: [noted("10615", 126.9), noted("10661", 224.1)] },
    { parts: [noted("10615", null), { ...noted("10661", 224.1), qbo_date: null }] }, { state: "conflict", qbo_txn_type: null, qbo_txn_id: null }]) {
    assert.deepEqual(note(over), [], JSON.stringify(over));
  }
  assert.notDeepEqual(noteProblems([ALSTON], [{ ...row, qbo_txn_type: "Bill" }]), [], "v1's door takes no bill");
  for (const over of [{ qbo_txn_type: "Invoice" }, { qbo_txn_type: "Bill", parts: [noted("10615", 126.9), noted("10661", 224.1)] },
    { parts: [noted("10615", 351)] }, { parts: [noted("10615", 126.9), noted("10615", 224.1)] },
    { parts: [noted("10661", 224.1), noted("10615", 126.9)] }, { parts: [noted("10615", 126.9), { ...noted("10661", 224.1), qbo_sync_token: 0 }] },
    { parts: {} }]) {
    assert.notDeepEqual(note(over), [], JSON.stringify(over));
  }
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

test("an invoice the slip reader marked \"account\" but the bank paid is a candidate when the expense names it: its invoice number, or the bank account the receipt says paid it (which alone never scores)", () => {
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
  // but 8992 is on every checking expense's account name: it tells this one
  // from any other checking expense of $784 that day not at all, so it scores
  // nothing and the same day alone is not enough (the safe failure)
  assert.equal(scoreOf(fbx, p10662), 1);
  // neither: still a store receipt paid from the bank, which it is not
  assert.equal(contradicts({ ...fbx, card_last4: "" }, p10662), true);
  assert.equal(contradicts({ ...fbx, card_last4: "4558" }, p10662), true);
  assert.equal(contradicts({ ...fsg, receipt_no: "209999" }, p10621), true);
  // the bank account's own four digits, exactly: a partial or longer read is no exception
  assert.equal(contradicts({ ...fbx, card_last4: "992" }, p10662), true);
  assert.equal(contradicts({ ...fbx, card_last4: "89921" }, p10662), true);
  // a debit card's four digits in the memo are not the bank account named
  assert.equal(contradicts({ ...fsg, receipt_no: "209999", card_last4: "4558" }, p10621), true);
  // a check or ACH receipt against an unrelated checking expense of the same
  // amount on the same day (a payroll advance): never a candidate
  const advance = p10577({ id: "10423", txnDate: "2026-09-18", total: 500, paymentType: "Cash", accountId: "9",
    accountName: "8992-MMB- Checking", vendorName: "", docNumber: "", note: "", lines: [line({ amount: 500, accountId: "231" })],
    attachments: [], hasAttachment: false });
  const ach = sbs({ id: "ach", vendor: "Interior Contracting", receipt_date: "2026-09-18", amount: 500, card_last4: "8992", receipt_no: "" });
  assert.equal(scoreOf(ach, advance), 1);
  assert.equal(noteOf(run({ receipts: [ach], purchases: [advance], jobs: [job({ link: LINK })], today: "2026-10-10" }), "ach").state,
    "unmatched");

  const chena = job({ id: OTHER, address: "1885 Chena Landings Lp." });
  const res = run({ receipts: [{ ...fsg, job_id: OTHER }, { ...fbx, job_id: OTHER }], purchases: [p10621, p10662], jobs: [chena],
    today: "2026-10-10" });
  assert.deepEqual(res.notes.map((n) => [n.receipt_id, n.state, n.qbo_txn_id, n.qbo_customer_id]),
    [["fbx", "unmatched", null, null], ["fsg", "in_qbo", "10621", "502"]]);
  assert.deepEqual(res.cards, []);
});

test("a check or ACH receipt matches a checking expense the office already finished for its job (tagged to the job's linked customer, a document attached): a note, never a card", () => {
  const chena = job({ id: OTHER, address: "1885 Chena Landings Lp.", link: { job_id: OTHER, qbo_customer_id: "502",
    qbo_project_ref: "807760362", qbo_name: "1885 Chena Landings Lp. - Huffman", source: "picked" } });
  // FBX Electric invoice 1065, paid by ACH from ****8992: QuickBooks 10662, under the owner's name, finished by the office
  const fbx = sbs({ id: "fbx", job_id: OTHER, vendor: "FBX Electric LLC", receipt_date: "2026-10-09", amount: 784, card_last4: "8992",
    receipt_no: "1065" });
  const p10662 = p10577({ id: "10662", txnDate: "2026-10-09", total: 784, paymentType: "Cash", accountId: "9", accountName: "8992-MMB- Checking",
    vendorName: "Vinny Fanelli", docNumber: "", note: "", lines: [line({ amount: 784, customerId: "502", projectRef: "807760362" })],
    attachments: ["Invoice 1065.pdf"], hasAttachment: true });
  assert.equal(scoreOf(fbx, p10662, "502"), 2);
  assert.equal(scoreOf(fbx, p10662, "112"), 1);
  assert.equal(scoreOf(fbx, p10662), 1);
  let res = run({ receipts: [fbx], purchases: [p10662], jobs: [chena], today: "2026-10-10" });
  assert.deepEqual([noteOf(res, "fbx").state, noteOf(res, "fbx").qbo_txn_id, noteOf(res, "fbx").qbo_customer_id], ["in_qbo", "10662", "502"]);
  assert.deepEqual(res.cards, []);
  // untagged, tagged to another job, partly tagged, or without its document:
  // the bank account names nothing, the same day alone is not enough
  for (const p of [
    { ...p10662, lines: [line({ amount: 784 })] },
    { ...p10662, lines: [line({ amount: 784, customerId: "517", projectRef: "815364056" })] },
    { ...p10662, lines: [line({ amount: 500, customerId: "502" }), line({ id: "2", amount: 284 })] },
    { ...p10662, attachments: [], hasAttachment: false },
  ]) {
    res = run({ receipts: [fbx], purchases: [p], jobs: [chena], today: "2026-10-10" });
    assert.equal(noteOf(res, "fbx").state, "unmatched");
    assert.deepEqual(res.cards, []);
  }
  // and a job with no link has no customer to finish it for
  res = run({ receipts: [fbx], purchases: [p10662], jobs: [{ ...chena, link: null }], today: "2026-10-10" });
  assert.equal(noteOf(res, "fbx").state, "unmatched");
});

test("a card charge's DocNumber may be the bank's reference: it rules a receipt out only when it is the store's own numbering", () => {
  // Citi fills the Home Depot charges with 7 digits: 10519 "5020046" is receipt "1303 00002 79356"
  const r = hd({ id: "hd-0928", receipt_date: "2026-09-28", amount: 67.88, receipt_no: "1303 00002 79356" });
  const p10519 = p10577({ id: "10519", syncToken: "2", txnDate: "2026-09-28", total: 67.88, docNumber: "5020046",
    lines: [line({ amount: 67.88, ...POLLEN })], attachments: ["IMG_9661.jpeg"], hasAttachment: true });
  assert.equal(contradicts(r, p10519), false);
  let res = run({ receipts: [r], purchases: [p10519], jobs: [job({ link: LINK })] });
  assert.deepEqual([noteOf(res, "hd-0928").state, noteOf(res, "hd-0928").qbo_txn_id], ["in_qbo", "10519"]);
  // untagged with no photo, it goes on the card
  const bare = { ...p10519, lines: [line({ amount: 67.88 })], attachments: [], hasAttachment: false };
  res = run({ receipts: [r], purchases: [bare], jobs: [job({ link: LINK })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.qbo_txn_id, i.changes.join("+")]), [["10519", "tag+attach"]]);
  // a number as long as the receipt's is the store's own: Home Depot rental
  // deposits 193594 and 193615, $50 each on card 1674 a day apart
  const rental = hd({ id: "hd-rent", receipt_date: "2026-09-18", amount: 50, card_last4: "1674", receipt_no: "193615" });
  const deposit = (id, doc, date) => p10577({ id, txnDate: date, total: 50, accountId: "240", accountName: "1674 US Bank - Amazon (0687)",
    docNumber: doc, note: "Deposit on equipment rental", lines: [line({ amount: 50 })] });
  assert.equal(contradicts(rental, deposit("10456", "193594", "2026-09-17")), true);
  assert.equal(contradicts(rental, deposit("10454", "193615", "2026-09-18")), false);
  // on an account, or against a bill, a different number is another invoice whatever its length
  assert.equal(contradicts(sbs(), p10563({ docNumber: "7006248" })), true);
  assert.equal(contradicts(sbs({ paid_with: "card", card_last4: "" }), p10563({ docNumber: "7006248" })), false);
  assert.equal(contradicts(sbs({ paid_with: "", card_last4: "" }), p10563({ docNumber: "7006248" })), false);
  assert.equal(contradicts(sbs({ paid_with: "", card_last4: "" }), { ...p10563({ docNumber: "7006248" }), txnType: "Bill" }), true);
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
  // and the expense must be that store's: by its vendor, or by its memo
  assert.equal(state({ ...p10630, txnDate: "2026-09-22", vendorName: "Vinny Fanelli", note: "" }), "store_not_entered");
  assert.equal(state({ ...p10630, txnDate: "2026-09-22", vendorName: "", note: "SPENARD BUILDERS SUPPLY" }), "in_qbo 10630");
  // Sherwin's longer DocNumber agrees by its prefix; a number under 5 digits never does
  assert.equal(state({ ...p10630, txnDate: "2026-09-25", docNumber: "7006533910926" }), "in_qbo 10630");
  assert.equal(state({ ...p10630, txnDate: "2026-09-25", docNumber: "3391" }, { receipt_no: "3391" }), "store_not_entered");
  // only for an invoice on an account: a card charge's date is the bank's,
  // and a rental agreement's number repeats on each week's charge
  assert.equal(state({ ...p10630, txnDate: "2026-09-28", paymentType: "CreditCard", accountName: "1674 US Bank" },
    { paid_with: "card", card_last4: "1674" }), "waiting_feed");
  assert.equal(state({ ...p10630, txnDate: "2026-10-05", paymentType: "CreditCard", accountName: "1674 US Bank" },
    { paid_with: "card", card_last4: "1674" }), "in_qbo 10630");
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

/* ---- 0025 (v2): bills, a receipt in parts, second tries ---- */

const CHENA = { job_id: OTHER, qbo_customer_id: "502", qbo_project_ref: "807760362", qbo_name: "1885 Chena Landings Lp.", source: "picked" };
const chena = (over = {}) => job({ id: OTHER, address: "1885 Chena Landings Lp.", link: CHENA, ...over });
// FNSB dump ticket 01286734 → Bill 10625 (read Oct 10): entered by the office
// a week late, DocNumber the ticket number, tagged to the job, the ticket's photo
const dump = (over = {}) => ({ job_id: ALSTON, id: "fnsb", vendor: "FNSB Solid Waste Division #001", receipt_date: "2026-10-01",
  amount: 34.04, category: "dump", paid_with: "account", card_last4: "", receipt_no: "01286734", photo_ref: photo(4), ...over });
const b10625 = (over = {}) => ({ id: "10625", syncToken: "0", txnDate: "2026-10-01", total: 34.04, credit: false, paymentType: "",
  accountId: "99", accountName: "Accounts Payable (A/P)", vendorId: "355", vendorName: "FNSB Solid Waste", docNumber: "01286734",
  note: "CONSTRUCTION MATRL", lines: [line({ amount: 34.04, accountId: "226", ...POLLEN })], attachments: ["FNSB 01286734.jpg"],
  hasAttachment: true, ...over });
const BILL_DETAIL = { qbo_doc_number: "01286734", qbo_account_name: "Accounts Payable (A/P)", qbo_total: 34.04 };
// Rental Zone receipt 995d2795 (job 1885 Chena Landings), $351.00 on 10/07 =
// Purchase 10615 $126.90 at checkout (10/02) + 10661 $224.10 at return
// (10/07), both by bank rule on card 1658, untagged, no photo
const RENTAL_TODAY = "2026-10-10";
const rental = (over = {}) => ({ job_id: OTHER, id: "995d2795", vendor: "The Rental Zone (A Division of Airport Equipment Rentals)",
  receipt_date: "2026-10-07", amount: 351, category: "equipment", paid_with: "card", card_last4: "1658", receipt_no: "R284290",
  photo_ref: photo(5), ...over });
const charge = (id, txnDate, total, over = {}) => p10577({ id, syncToken: "0", txnDate, total, accountId: "37",
  accountName: "1658 - Bank of America AK Air CC", vendorId: "83", vendorName: "Airport Equipment Rental, Inc", docNumber: "",
  note: "AIRPORT EQUIPMENT RENTAL FAIRBANKS    AK - RULE", lines: [line({ amount: total, accountId: EQUIPMENT_EXPENSE_ACCOUNT })], ...over });
const p10615 = (over) => charge("10615", "2026-10-02", 126.9, over);
const p10661 = (over) => charge("10661", "2026-10-07", 224.1, over);
const rentalRun = (over = {}) => runV2({ receipts: [rental()], purchases: [p10615(), p10661()], jobs: [chena()], today: RENTAL_TODAY, ...over });
// a failed update of r1 (Home Depot 10577): the 0025 executor's queued row,
// then the outbox_qbo_link_result trigger's error
const PROP1 = "11111111-1111-4111-8111-111111111111";   // the card whose approval queued it
const PROP2 = "22222222-2222-4222-8222-222222222222";   // the card that held its second try
const failedRow = (detail = {}, over = {}) => ({ receipt_id: "r1", job_id: ALSTON, state: "failed", qbo_txn_type: "Purchase",
  qbo_txn_id: "10577", qbo_sync_token: "0", qbo_customer_id: "112", amount: 1369.5, receipt_date: "2026-09-30", parts: null,
  proposal_id: PROP1, detail: { vendor: "The Home Depot #1303", qbo_total: 1369.5, read_photo_ref: photo(1),
    failed_at: "2026-10-07T15:00:00Z", ...detail }, ...over });
const again = (links, over = {}) => runV2({ receipts: [hd()], purchases: [p10577()], links, jobs: [job({ link: LINK })], ...over });
const kept = (res, why) => {
  assert.deepEqual(res.cards, [], why);
  assert.equal(noteOf(res, "r1"), undefined, why);
  assert.equal(res.stats.owned.failed, 1, why);
};

test("a dump ticket is its bill by ticket number, and a bill is only noted: tagged to the job in_qbo (photo or not), untagged a conflict the office tags by hand", () => {
  const linked = [job({ link: LINK })];
  let res = runV2({ receipts: [dump(), hd()], purchases: [p10577()], bills: [b10625()], jobs: linked });
  assert.deepEqual(noteOf(res, "fnsb"), { receipt_id: "fnsb", job_id: ALSTON, amount: 34.04, receipt_date: "2026-10-01", state: "in_qbo",
    qbo_txn_type: "Bill", qbo_txn_id: "10625", qbo_sync_token: "0", parts: null, qbo_customer_id: "112", detail: BILL_DETAIL });
  assert.deepEqual(itemsOf(res).map((i) => i.receipt_id), ["r1"]);       // the card holds the expense only
  // no document on the bill: still in QuickBooks; nothing attaches to a bill
  res = runV2({ receipts: [dump()], bills: [b10625({ attachments: [], hasAttachment: false })], jobs: linked });
  assert.equal(noteOf(res, "fnsb").state, "in_qbo");
  assert.deepEqual(res.cards, []);
  // untagged: a conflict, never an item, not even the photo
  const untagged = b10625({ lines: [line({ amount: 34.04, accountId: "226" })], attachments: [], hasAttachment: false });
  res = runV2({ receipts: [dump()], bills: [untagged], jobs: linked });
  assert.deepEqual(noteOf(res, "fnsb"), { receipt_id: "fnsb", job_id: ALSTON, amount: 34.04, receipt_date: "2026-10-01", state: "conflict",
    qbo_txn_type: "Bill", qbo_txn_id: "10625", qbo_sync_token: "0", parts: null, qbo_customer_id: null,
    detail: { reason: "bill_untagged", ...BILL_DETAIL } });
  assert.deepEqual(res.cards, []);
  assert.equal(res.stats.conflicts, 1);
  // tagged to another customer, partly tagged, or on a job with no project: as an expense would be, naming the bill
  const state = (bill, jobs = linked) => {
    const n = noteOf(runV2({ receipts: [dump()], bills: [bill], jobs }), "fnsb");
    return [n.state, n.detail.reason, n.qbo_txn_type, n.qbo_txn_id, n.qbo_customer_id];
  };
  assert.deepEqual(state(b10625({ lines: [line({ amount: 34.04, customerId: "399", customerName: "264 Cindy dr." })] })),
    ["conflict", "tagged_other", "Bill", "10625", "399"]);
  assert.deepEqual(state(b10625({ lines: [line({ amount: 30, ...POLLEN }), line({ id: "2", amount: 4.04 })] })),
    ["conflict", "partly_tagged", "Bill", "10625", "112"]);
  assert.deepEqual(state(untagged, [job()]), ["unmatched", "needs_job_link", "Bill", "10625", null]);
  // never in parts: a bill is one transaction, and a split reads card charges only
  assert.equal(rentalRun({ bills: [charge("10700", "2026-10-03", 126.9), charge("10701", "2026-10-07", 224.1)].map((b) => ({ ...b, paymentType: "" })) })
    .cards[0].input.items[0].parts.map((p) => p.qbo_txn_id).join(), "10615,10661");
});

test("no bill found: bill_not_entered when the bills were read, bill_not_checked when they were not (or in v1); another ticket's bill is not this ticket's", () => {
  const linked = [job({ link: LINK })];
  const reason = (over) => noteOf(runV2({ receipts: [dump()], jobs: linked, ...over }), "fnsb").detail.reason;
  assert.equal(reason({}), "bill_not_entered");
  assert.equal(reason({ bills: null }), "bill_not_checked");
  assert.equal(noteOf(run({ receipts: [dump()], bills: [b10625()], jobs: linked }), "fnsb").detail.reason, "bill_not_checked");   // v1 reads none
  // the borough charges by the 20 lb, so another ticket of the same amount the same day is common: only the ticket's own number counts
  for (const docNumber of ["01286735", "", "1286", "02286734"]) {
    assert.equal(reason({ bills: [b10625({ docNumber })] }), "bill_not_entered", docNumber);
  }
  // a zero dropped on either side is the same ticket
  assert.equal(noteOf(runV2({ receipts: [dump({ receipt_no: "1286734" })], bills: [b10625()], jobs: linked }), "fnsb").state, "in_qbo");
  // a receipt paid at the counter is never a bill
  const counter = hd({ id: "c1", vendor: "FNSB Solid Waste", receipt_date: "2026-10-01", amount: 34.04, receipt_no: "01286734", card_last4: "" });
  assert.equal(noteOf(runV2({ receipts: [counter], bills: [b10625()], jobs: linked }), "c1").detail.reason, "waiting_feed");
});

test("the bills not read tonight: a receipt matched to a bill (in_qbo or conflict) keeps its row as it is, never re-noted bill_not_checked", () => {
  const was = (over = {}) => ({ receipt_id: "fnsb", job_id: ALSTON, state: "in_qbo", qbo_txn_type: "Bill", qbo_txn_id: "10625",
    qbo_sync_token: "0", qbo_customer_id: "112", amount: 34.04, receipt_date: "2026-10-01", detail: BILL_DETAIL, parts: null,
    proposal_id: null, ...over });
  const linked = [job({ link: LINK })];
  for (const row of [was(), was({ state: "conflict", qbo_customer_id: null, detail: { reason: "bill_untagged", ...BILL_DETAIL } })]) {
    const res = runV2({ receipts: [dump()], bills: null, links: [row], jobs: linked });
    const { proposal_id: _, ...asWas } = row;
    assert.deepEqual(noteOf(res, "fnsb"), asWas, row.state);
    assert.equal(res.stats.carried, 1, row.state);
    assert.equal(res.stats.receipts, 0, "carried, not matched");
  }
  // a manual run for another job carries nothing of this one
  assert.deepEqual(matchReceipts({ receipts: [dump()], bills: null, links: [was()], jobs: linked, today: TODAY, v2: true, scope: [OTHER] }).notes, []);
  // with the bills read it is matched again
  let res = runV2({ receipts: [dump()], bills: [b10625({ lines: [line({ amount: 34.04 })] })], links: [was()], jobs: linked });
  assert.equal(noteOf(res, "fnsb").detail.reason, "bill_untagged");
  // a row that names no bill is not kept: the ticket reads bill_not_checked
  res = runV2({ receipts: [dump()], bills: null, jobs: linked, links: [was({ state: "unmatched", qbo_txn_type: null, qbo_txn_id: null,
    qbo_sync_token: null, qbo_customer_id: null, detail: { reason: "bill_not_entered" } })] });
  assert.equal(noteOf(res, "fnsb").detail.reason, "bill_not_checked");
});

test("Rental Zone 995d2795, $351.00 paid as 10615 at checkout and 10661 at return: ONE item whose top level is the first charge, every charge in parts", () => {
  const res = rentalRun();
  assert.deepEqual(res.notes, []);
  assert.deepEqual(itemsOf(res, OTHER), [{
    receipt_id: "995d2795", vendor: "The Rental Zone (A Division of Airport Equipment Rentals)", date: "2026-10-07", amount: 351,
    receipt_no: "R284290", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0", qbo_doc_number: "",
    qbo_account_name: "1658 - Bank of America AK Air CC", qbo_vendor_name: "Airport Equipment Rental, Inc", qbo_total: 126.9,
    changes: ["tag", "attach"], photo_refs: [photo(5)], project_ref: "807760362", read_photo_ref: photo(5),
    parts: [
      { qbo_txn_id: "10615", qbo_sync_token: "0", qbo_total: 126.9, qbo_date: "2026-10-02", changes: ["tag", "attach"] },
      { qbo_txn_id: "10661", qbo_sync_token: "0", qbo_total: 224.1, qbo_date: "2026-10-07", changes: ["tag", "attach"] },
    ],
  }]);
  assert.equal(cardOf(res, OTHER).input.qbo_customer_id, "502");
  assert.equal(cardOf(res, OTHER).input.total_usd, 351);
  assert.equal(res.stats.matched, 1);
  // no photo yet: each charge is tagged only
  assert.deepEqual(itemsOf(rentalRun({ receipts: [rental({ photo_ref: null })] }), OTHER).map((i) => [i.changes, i.parts.map((p) => p.changes)]),
    [[["tag"], [["tag"], ["tag"]]]]);
  // the job has no project yet: a note naming every charge, the receipt's total in its detail
  assert.deepEqual(noteOf(rentalRun({ jobs: [chena({ link: null })] }), "995d2795"), {
    receipt_id: "995d2795", job_id: OTHER, amount: 351, receipt_date: "2026-10-07", state: "unmatched",
    qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0", qbo_customer_id: null,
    parts: [{ qbo_txn_id: "10615", qbo_sync_token: "0", qbo_total: 126.9, qbo_date: "2026-10-02" },
      { qbo_txn_id: "10661", qbo_sync_token: "0", qbo_total: 224.1, qbo_date: "2026-10-07" }],
    detail: { reason: "needs_job_link", qbo_account_name: "1658 - Bank of America AK Air CC", qbo_total: 351 },
  });
});

test("two sets that add up to the receipt, or one set two receipts could use: a conflict (ambiguous_split) naming the charges, and no write", () => {
  let res = rentalRun({ purchases: [p10615(), p10661(), charge("10700", "2026-10-03", 200), charge("10701", "2026-10-07", 151)] });
  assert.deepEqual(res.cards, []);
  assert.deepEqual(noteOf(res, "995d2795"), { receipt_id: "995d2795", job_id: OTHER, amount: 351, receipt_date: "2026-10-07",
    state: "conflict", qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null, qbo_customer_id: null,
    detail: { reason: "ambiguous_split", candidates: ["10615", "10661", "10700", "10701"] } });
  res = rentalRun({ receipts: [rental(), rental({ id: "995d2796" })] });
  assert.deepEqual(res.notes.map((n) => [n.receipt_id, n.detail.reason, n.detail.candidates]),
    [["995d2795", "ambiguous_split", ["10615", "10661"]], ["995d2796", "ambiguous_split", ["10615", "10661"]]]);
  assert.deepEqual(res.cards, []);
  // a charge one receipt could be on its own is never used to make up another's total
  res = rentalRun({ receipts: [rental(), rental({ id: "rz-out", receipt_date: "2026-10-02", amount: 126.9 })] });
  assert.deepEqual(itemsOf(res, OTHER).map((i) => [i.receipt_id, i.qbo_txn_id, "parts" in i]), [["rz-out", "10615", false]]);
  assert.equal(noteOf(res, "995d2795").detail.reason, "waiting_feed");
});

test("a receipt in parts only when every guard holds: equipment, by card, 3 days old, untouched charges of one account, the last on the receipt's day", () => {
  const outcome = (over) => {
    const res = rentalRun(over);
    const n = noteOf(res, "995d2795");
    return n ? n.detail.reason : itemsOf(res, OTHER).map((i) => (i.parts ?? []).map((p) => p.qbo_txn_id).join("+")).join();
  };
  assert.equal(outcome({}), "10615+10661");
  // two days old: the closing charge may not have posted, so a look-alike set could still show
  assert.equal(outcome({ today: "2026-10-09" }), "waiting_feed");
  assert.equal(outcome({ receipts: [rental({ category: "materials" })] }), "waiting_feed");
  assert.equal(outcome({ receipts: [rental({ card_last4: "" })] }), "waiting_feed");
  assert.equal(outcome({ receipts: [rental({ card_last4: "3176" })] }), "waiting_feed");                  // another card
  assert.equal(outcome({ receipts: [rental({ paid_with: "account" })] }), "store_not_entered");
  // a charge someone touched: a DocNumber naming another agreement, a job tag (even this job's), a document
  for (const touched of [p10615({ docNumber: "284100" }), p10615({ lines: [line({ amount: 126.9, accountId: "1150040005", customerId: "502" })] }),
    p10615({ attachments: ["agreement.pdf"], hasAttachment: true })]) {
    assert.equal(outcome({ purchases: [touched, p10661()] }), "waiting_feed", JSON.stringify(touched.docNumber + touched.attachments));
  }
  assert.equal(outcome({ purchases: [p10615({ docNumber: "284290" }), p10661()] }), "10615+10661");   // the receipt's own number is no harm
  assert.equal(outcome({ purchases: [p10615(), p10661({ accountId: "240" })] }), "waiting_feed");      // two accounts
  assert.equal(outcome({ purchases: [p10615(), p10661({ txnDate: "2026-10-05" })] }), "waiting_feed"); // no charge at return
  assert.equal(outcome({ purchases: [p10615({ txnDate: "2026-09-22" }), p10661()] }), "waiting_feed"); // checkout over 14 days before
  assert.equal(outcome({ purchases: [p10615({ credit: true }), p10661()] }), "waiting_feed");
  assert.equal(outcome({ purchases: [p10615({ vendorName: "Home Depot", note: "" }), p10661()] }), "waiting_feed");
  // a charge another receipt holds
  const held = { receipt_id: "r9", job_id: ALSTON, state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10615", qbo_sync_token: "0",
    qbo_customer_id: "112", amount: 126.9, receipt_date: "2026-10-02", detail: {}, parts: null };
  assert.equal(outcome({ receipts: [rental(), hd({ id: "r9", amount: 1 })], links: [held], jobs: [chena(), job({ link: LINK })] }), "waiting_feed");
  // switched off: splits false, the bills not read (the default follows them), or v1
  assert.equal(outcome({ splits: false }), "waiting_feed");
  assert.equal(outcome({ bills: null }), "waiting_feed");
  assert.equal(outcome({ bills: null, splits: true }), "10615+10661");      // only listBills failed: the lane keeps splits on
  assert.equal(noteOf(run({ receipts: [rental()], purchases: [p10615(), p10661()], jobs: [chena()], today: RENTAL_TODAY }), "995d2795").detail.reason,
    "waiting_feed");
});

test("a second try: a KEEP_FAILED refusal keeps the failed row while nothing moved; anything moved goes on a new card, marked refile", () => {
  assert.ok(KEEP_FAILED.has("cancelled"));
  const changed = { error: "changed_in_qbo: Purchase 10577 changed in QuickBooks since the card was filed" };
  kept(again([failedRow(changed)]), "nothing moved");
  // the same refusal, but the expense's SyncToken moved: a second try on a new card
  let res = again([failedRow(changed)], { purchases: [p10577({ syncToken: "3" })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.receipt_id, i.qbo_sync_token, i.refile]),
    [["r1", "3", { proposal_id: PROP1, error: "changed_in_qbo", why: "Purchase 10577 changed in QuickBooks since the card was filed" }]]);
  assert.equal(cardOf(res).rationale,
    "1 receipt on 2156 Alston rd. matches a QuickBooks expense that has no job tag or photo; 1 is a second try after the last update failed.");
  assert.equal(res.stats.owned.failed, 0);
  // the receipt's date, its photo, or the job's project moved: the same
  for (const [what, over] of [["date", { receipts: [hd({ receipt_date: "2026-10-01" })] }], ["photo", { receipts: [hd({ photo_ref: photo(9) })] }],
    ["project", { jobs: [job({ link: { ...LINK, qbo_customer_id: "272", qbo_project_ref: null } })] }]]) {
    assert.deepEqual(itemsOf(again([failedRow(changed)], over)).map((i) => i.refile?.error), ["changed_in_qbo"], what);
  }
  // marked dead by hand: cancelled, kept until something moves
  for (const error of ["cancelled: marked dead by hand", "cancelled: Branden, booked by hand on 10/8"]) kept(again([failedRow({ error })]), error);
  assert.deepEqual(itemsOf(again([failedRow({ error: "cancelled: marked dead by hand" })], { purchases: [p10577({ syncToken: "1" })] }))
    .map((i) => i.refile), [{ proposal_id: PROP1, error: "cancelled", why: "marked dead by hand" }]);
  // any other failure goes again at once, to the same expense
  res = again([failedRow({ error: "qbo_throttled: QuickBooks asked us to slow down" })]);
  assert.deepEqual(itemsOf(res).map((i) => [i.qbo_txn_id, i.refile]),
    [["10577", { proposal_id: PROP1, error: "qbo_throttled", why: "QuickBooks asked us to slow down" }]]);
  // a failed row whose transaction is not tonight's match (another expense, or none): kept, someone may have changed the books on purpose
  kept(again([failedRow({ error: "qbo_throttled: x" }, { qbo_txn_id: "10500" })]), "another expense");
  kept(again([failedRow({ error: "qbo_throttled: x" })], { purchases: [] }), "none");
  // QuickBooks has it right now (the office fixed it by hand): a note replaces the failed row
  res = again([failedRow(changed)], { purchases: [p10577({ syncToken: "4", lines: [line({ amount: 1369.5, ...POLLEN })], attachments: ["r.jpg"], hasAttachment: true })] });
  assert.deepEqual([noteOf(res, "r1").state, noteOf(res, "r1").parts, res.cards.length, res.stats.owned.failed], ["in_qbo", null, 0, 0]);
  // a store invoice whose entry failed is entered again, marked the same way
  res = runV2({ receipts: [sbs()], jobs: [job({ link: LINK })], storeAccounts: STORES,
    links: [failedRow({ error: "qbo_unavailable: QuickBooks is down" }, { receipt_id: "r2", qbo_txn_id: null, qbo_sync_token: null, amount: 212.28,
      receipt_date: "2026-09-28", detail: { read_photo_ref: photo(2), error: "qbo_unavailable: QuickBooks is down" } })] });
  assert.deepEqual(itemsOf(res).map((i) => [i.changes, i.refile.error]), [[["create", "attach"], "qbo_unavailable"]]);
});

test("one automatic retry per code: a second try that dies of the same code is kept; another code, or anything moved, goes again", () => {
  // the queued row of a second try keeps its marker (detail.refile); the trigger then writes the new error
  const second = (error, refileError) => failedRow({ error, refile: { proposal_id: PROP1, error: refileError, why: "QuickBooks asked us to slow down" } },
    { proposal_id: PROP2 });
  kept(again([second("qbo_throttled: QuickBooks asked us to slow down", "qbo_throttled")]), "the same code twice");
  kept(again([second("QuickBooks went away", "failed")]), "no code, twice");
  assert.deepEqual(itemsOf(again([second("qbo_unavailable: QuickBooks is down", "qbo_throttled")])).map((i) => i.refile),
    [{ proposal_id: PROP2, error: "qbo_unavailable", why: "QuickBooks is down" }]);
  assert.deepEqual(itemsOf(again([second("qbo_throttled: QuickBooks asked us to slow down", "qbo_throttled")], { purchases: [p10577({ syncToken: "1" })] }))
    .map((i) => i.refile.error), ["qbo_throttled"]);
});

test("a declined second try stays declined while it is the same item; anything different goes on the new card", () => {
  const f = failedRow({ error: "qbo_throttled: QuickBooks asked us to slow down", refiled_proposal_id: PROP2.toUpperCase() });
  const [it] = itemsOf(again([f]));
  assert.deepEqual(it.refile, { proposal_id: PROP1, error: "qbo_throttled", why: "QuickBooks asked us to slow down" });
  const other = { ...it, receipt_id: "r9", qbo_txn_id: "10999", refile: undefined };
  const card = (status, items) => new Map([[PROP2, { status, items: JSON.parse(JSON.stringify(items)) }]]);
  // the owner declined the card that held it (another receipt's line beside it), or approved that card without it
  for (const status of ["declined", "executed"]) kept(again([f], { answered: card(status, [other, it]) }), status);
  // keys in another order are the same item (jsonb keeps its own order)
  const shuffled = Object.fromEntries(Object.entries(it).reverse());
  assert.equal(canonical(shuffled), canonical(it));
  kept(again([f], { answered: card("declined", [shuffled]) }), "shuffled");
  // still open, or expired, superseded, failed: tonight's card is the try
  for (const status of ["proposed", "expired", "superseded", "failed"]) {
    assert.deepEqual(itemsOf(again([f], { answered: card(status, [it]) })).map((i) => i.receipt_id), ["r1"], status);
  }
  // something moved since the owner said no: the expense's SyncToken, the photo, the charge
  for (const [what, over] of [["token", { purchases: [p10577({ syncToken: "1" })] }], ["photo", { receipts: [hd({ photo_ref: photo(9) })] }],
    ["document", { purchases: [p10577({ attachments: ["statement.pdf"], hasAttachment: true })] }]]) {
    assert.deepEqual(itemsOf(again([f], { answered: card("declined", [it]), ...over })).map((i) => i.receipt_id), ["r1"], what);
  }
  // a declined card that never held this receipt, or a card other than the one stamped, is no answer
  assert.equal(itemsOf(again([f], { answered: card("declined", [other]) })).length, 1);
  assert.equal(itemsOf(again([{ ...f, detail: { ...f.detail, refiled_proposal_id: PROP1 } }], { answered: card("declined", [it]) })).length, 1);
});

test("the second try's marker: the failed row's card, its code, and its words without the code, collapsed and cut to 120", () => {
  const marker = (error, over = {}) => itemsOf(again([failedRow({ error }, over)], { purchases: [p10577({ syncToken: "1" })] }))[0].refile;
  assert.deepEqual(marker("bad_request:   receipt_id\n  must be  text "), { proposal_id: PROP1, error: "bad_request", why: "receipt_id must be text" });
  assert.deepEqual(marker("QuickBooks went away"), { proposal_id: PROP1, error: "failed", why: "QuickBooks went away" });
  assert.deepEqual(marker(""), { proposal_id: PROP1, error: "failed" });
  assert.deepEqual(marker("qbo_throttled:  "), { proposal_id: PROP1, error: "qbo_throttled" });
  assert.equal(marker(`qbo_refused: ${"x".repeat(300)}`).why, "x".repeat(120));
  // cut by characters: never half of one (jsonb refuses a lone surrogate)
  const why = marker(`qbo_unavailable: ${"a".repeat(119)}\u{1F69A} and more`).why;
  assert.equal(why, `${"a".repeat(119)}\u{1F69A}`);
  assert.equal([...why].length, 120);
  // the card id as the door compares it (lowercase); a row with none is still tried, unstamped
  assert.equal(marker("qbo_throttled: x", { proposal_id: PROP1.toUpperCase() }).proposal_id, PROP1);
  assert.deepEqual(marker("qbo_throttled: x", { proposal_id: null }), { proposal_id: null, error: "qbo_throttled", why: "x" });
});

test("a photo refusal on a row queued before 0025 (no read_photo_ref) is tried once more; one that recorded the photo is kept while it is the same", () => {
  const legacy = (error) => {
    const f = failedRow({ error });
    delete f.detail.read_photo_ref;
    return f;
  };
  for (const code of ["photo_missing", "photo_type", "photo_unreadable", "photo_too_big", "upload_refused"]) {
    assert.ok(KEEP_FAILED.has(code));
    assert.deepEqual(itemsOf(again([legacy(`${code}: the photo`)])).map((i) => [i.refile.error, i.read_photo_ref]), [[code, photo(1)]], code);
    kept(again([failedRow({ error: `${code}: the photo` })]), code);
    assert.equal(itemsOf(again([failedRow({ error: `${code}: the photo` })], { receipts: [hd({ photo_ref: photo(9) })] })).length, 1, code);
  }
  // a refusal that was not about the photo is kept on such a row
  kept(again([legacy("tagged_other: Purchase 10577 is tagged to 264 Cindy dr.")]), "tagged_other");
});

test("v1 (no 0025): no bill, no parts, no second try, no key 0025 added; a failed receipt stays held and its expense is free", () => {
  const res = run({ receipts: [hd(), dump(), rental({ job_id: ALSTON }), hd({ id: "r2" })], purchases: [p10577(), p10615(), p10661()],
    bills: [b10625()], links: [failedRow({ error: "qbo_throttled: x", refiled_proposal_id: PROP2 })], jobs: [job({ link: LINK })],
    today: "2026-10-10", answered: new Map([[PROP2, { status: "declined", items: [] }]]), splits: true });
  // check() held every note and item to 0023: no parts, refile or Bill
  assert.equal(res.stats.owned.failed, 1);
  assert.equal(noteOf(res, "fnsb").detail.reason, "bill_not_checked");
  assert.equal(noteOf(res, "995d2795").detail.reason, "waiting_feed");
  assert.deepEqual(itemsOf(res).map((i) => [i.receipt_id, i.qbo_txn_id]), [["r2", "10577"]]);
  assert.deepEqual(Object.keys(itemsOf(res)[0]), ["receipt_id", "vendor", "date", "amount", "receipt_no", "qbo_txn_type", "qbo_txn_id",
    "qbo_sync_token", "qbo_doc_number", "qbo_account_name", "qbo_vendor_name", "qbo_total", "changes", "photo_refs", "project_ref", "read_photo_ref"]);
});

/** The filing door's items hash: md5 of jsonb_build_array(items, link, qbo_customer_id)::text, jsonb's
    text being keys shortest first then by their bytes, ", " and ": " between. */
function jsonbText(v) {
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined)
      .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText(v[k])}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}
const itemsHash = (input) => crypto.createHash("md5")
  .update(jsonbText([input.items, input.link ?? null, input.qbo_customer_id ?? null])).digest("hex");

test("an ordinary Purchase item is the same JSON with 0025 as without, so its card hashes the same and a card the owner declined is not offered again", () => {
  const args = { receipts: oct7.RECEIPTS, purchases: oct7.PURCHASES, links: [], jobs: oct7.JOB_ROWS, projects: oct7.PROJECTS,
    storeAccounts: null, today: oct7.TODAY };
  const ids = oct7.JOB_ROWS.map((j) => j.id);
  const v1 = check(matchReceipts(args), ids).cards;
  const v2 = check(matchReceipts({ ...args, v2: true, bills: [] }), ids, true).cards;
  assert.deepEqual(v2, v1);
  assert.equal(JSON.stringify(v2[0].input.items), JSON.stringify(v1[0].input.items));    // key order too
  // the hash the v1 worker's Alston card was filed under (the matcher at the branch's base, through jsonbText)
  assert.equal(itemsHash(v1[0].input), "3c0e3330ab3318fc1346978da2ab57e9");
  assert.equal(itemsHash(v2[0].input), "3c0e3330ab3318fc1346978da2ab57e9");
  // and one line on its own
  const one = (v2on) => matchReceipts({ receipts: [hd()], purchases: [p10577()], jobs: [job({ link: LINK })], projects: oct7.PROJECTS,
    today: TODAY, ...(v2on ? { v2: true, bills: [] } : {}) }).cards[0].input.items;
  assert.equal(JSON.stringify(one(true)), JSON.stringify(one(false)));
  assert.equal(crypto.createHash("md5").update(jsonbText(one(true))).digest("hex"), crypto.createHash("md5").update(jsonbText(one(false))).digest("hex"));
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
