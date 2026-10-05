/* receiptcalc.js — the job page's running material total, category
   normalisation (shared with the office assistant's free-text receipts and
   mirrored by migration 0015's reconcile_job_receipts), and how an AI read
   lands on a receipt without undoing a crew member's corrections.
   Run: node test/receiptcalc.test.mjs */
import assert from "node:assert/strict";
import {
  RECEIPT_CATEGORIES, RECEIPT_CATEGORY_KEYS, receiptCategory, receiptCategoryLabel, amountNum, itemsTotal,
  receiptTotals, receiptTileLine, vendorKey, applyReceiptRead, fmtMoney, PAID_WITH,
} from "../js/receiptcalc.js";
import { loggedCosts } from "../js/fincalc.js";
import { newReceipt, FORMS, formCount } from "../js/model.js";

let pass = 0;
function test(name, fn) { fn(); console.log("  ✓ " + name); pass++; }

test("the four categories the plan names, in order", () => {
  assert.deepEqual(RECEIPT_CATEGORY_KEYS, ["materials", "equipment", "dump", "other"]);
  assert.equal(RECEIPT_CATEGORIES[1].label, "Equipment rental");
  assert.ok(PAID_WITH.some((o) => o.value === "account"), "store account is a payment method (phase 3 keys off it)");
});

test("amountNum: money strings the way people and readers write them", () => {
  assert.equal(amountNum("$1,234.50"), 1234.5);
  assert.equal(amountNum(" 12 "), 12);
  assert.equal(amountNum(12.3), 12.3);
  assert.equal(amountNum(".5"), 0.5);
  assert.equal(amountNum("twelve"), 0);
  assert.equal(amountNum(""), 0);
  assert.equal(amountNum(null), 0);
  assert.equal(amountNum(NaN), 0);
});

test("receiptCategory: keys pass through, free text maps, blanks are other", () => {
  assert.equal(receiptCategory("materials"), "materials");
  assert.equal(receiptCategory("Equipment Rental"), "equipment");
  assert.equal(receiptCategory("dehu rental"), "equipment");
  assert.equal(receiptCategory("dump"), "dump");
  assert.equal(receiptCategory("Fairbanks landfill"), "dump");
  assert.equal(receiptCategory("Materials"), "materials");
  assert.equal(receiptCategory("lumber"), "materials");
  assert.equal(receiptCategory("sub"), "other");
  assert.equal(receiptCategory(""), "other");
  assert.equal(receiptCategory(undefined), "other");
  assert.equal(receiptCategoryLabel("dump fees"), "Dump fees");
});

test("receiptTotals: by category and vendor, assistant receipts included", () => {
  const p = { receipts: [
    { vendor: "THE HOME DEPOT #1234", amount: "100.10", category: "materials" },
    { vendor: "Home Depot", amount: 50, category: "Materials" },          // the assistant's free text
    { vendor: "Spenard Builders", amount: "1000.00", category: "materials" },
    { vendor: "Alaska Rent-All", amount: "200", category: "equipment" },
    { vendor: "FNSB Landfill", amount: "35.5", category: "dump" },
    { vendor: "", amount: "x", category: "" },                              // garbage amount, no vendor
    null,
  ] };
  const t = receiptTotals(p);
  assert.equal(t.total, 1385.6);
  assert.equal(t.count, 6);
  assert.equal(t.byCategory.materials.total, 1150.1);
  assert.equal(t.byCategory.materials.count, 3);
  assert.equal(t.byCategory.equipment.total, 200);
  assert.equal(t.byCategory.dump.total, 35.5);
  assert.equal(t.byCategory.other.count, 1);
  assert.deepEqual(t.vendors.map((v) => v.vendor), ["Spenard Builders", "Alaska Rent-All", "THE HOME DEPOT #1234", "FNSB Landfill", "Unknown vendor"]);
  assert.equal(t.vendors[2].total, 150.1, "store numbers and THE fold into one vendor");
  assert.equal(t.vendors[2].count, 2);
  assert.deepEqual(receiptTotals({}), { total: 0, count: 0, byCategory: {
    materials: { total: 0, count: 0 }, equipment: { total: 0, count: 0 }, dump: { total: 0, count: 0 }, other: { total: 0, count: 0 } }, vendors: [] });
  // the budget flag (fincalc.js) sums the same array to the same figure —
  // amounts are stored as plain numbers/strings (the form's number inputs and
  // applyReceiptRead never write "$" or ","), so the two can't drift
  assert.equal(loggedCosts(p), 1385.6);
  assert.equal(receiptTotals({ receipts: [{ amount: "$1,234.50" }] }).total, 1234.5, "a hand-typed $ amount still counts here");
});

test("vendorKey folds store numbers, THE, and punctuation", () => {
  assert.equal(vendorKey("THE HOME DEPOT #1234"), "home depot");
  assert.equal(vendorKey("Home Depot"), "home depot");
  assert.equal(vendorKey("Sherwin-Williams"), "sherwin williams");
  assert.equal(vendorKey(""), "unknown");
});

test("tile line: money and count, empty when nothing is logged", () => {
  assert.equal(receiptTileLine({ receipts: [] }), "");
  assert.equal(receiptTileLine({}), "");
  assert.equal(receiptTileLine({ receipts: [{ amount: 12 }] }), "$12.00 · 1 receipt");
  assert.equal(receiptTileLine({ receipts: [{ amount: 1000 }, { amount: 234.5 }] }), "$1,234.50 · 2 receipts");
  assert.equal(fmtMoney(-5), "−$5.00");
});

test("itemsTotal: qty × price, strings tolerated", () => {
  assert.equal(itemsTotal([{ qty: "2", price: "10.5" }, { qty: 1, price: "$4" }, null]), 25);
  assert.equal(itemsTotal(undefined), 0);
});

test("newReceipt: the shape the assistant, narrative and budget flag already read", () => {
  const r = newReceipt();
  assert.ok(r.id && r.createdAt);
  assert.equal(r.category, "materials", "a snapped receipt is materials until the crew says otherwise");
  assert.equal(typeof r.vendor, "string");
  assert.equal(r.amount, "");
  assert.deepEqual(r.items, []);
  assert.equal(r.photo, "");
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  const f = FORMS.find((x) => x.key === "receipts");
  assert.ok(f && f.multi, "Receipts is a multi-instance form tile on both job kinds");
  assert.deepEqual(f.types, ["restoration", "construction"]);
  assert.equal(formCount({ receipts: [r, r] }, "receipts"), 2);
});

const read = {
  vendor: "The Home Depot #1234", date: "2026-10-03", total: 212.34, subtotal: 200, tax: 12.34,
  cardLast4: "xxxx-4558", receiptNo: "9012 00034", paidWith: "card", category: "Materials",
  items: [{ desc: "3/4 CDX plywood", qty: 4, unit: "sht", price: 42.5, sku: "123456" }, { desc: "", qty: 1, price: 1 }, { desc: "Kilz primer gal", qty: 1, unit: "ea", price: 30 }],
  confidence: 0.9, notes: "Receipt partly faded at the bottom.",
};

test("applyReceiptRead fills a fresh receipt completely", () => {
  const r = newReceipt();
  const changed = applyReceiptRead(r, read);
  assert.equal(r.vendor, "The Home Depot #1234");
  assert.equal(r.date, "2026-10-03", "the printed date beats today's default");
  assert.equal(r.amount, "212.34");
  assert.equal(r.subtotal, "200");
  assert.equal(r.tax, "12.34");
  assert.equal(r.cardLast4, "4558");
  assert.equal(r.receiptNo, "9012 00034");
  assert.equal(r.paidWith, "card");
  assert.equal(r.category, "materials");
  assert.equal(r.items.length, 2, "blank-description lines are dropped");
  assert.equal(r.items[0].desc, "3/4 CDX plywood");
  assert.equal(r.items[0].qty, "4");
  assert.equal(r.items[0].price, "42.5");
  assert.equal(r.items[0].sku, "123456");
  assert.ok(r.items[0].id);
  assert.equal(r.notes, "Receipt partly faded at the bottom.");
  assert.ok(changed.includes("vendor") && changed.includes("amount") && changed.includes("items"));
  assert.equal(itemsTotal(r.items), 200);
});

test("a re-read never undoes a hand correction unless told to overwrite", () => {
  const r = newReceipt();
  applyReceiptRead(r, read);
  r.ai = { at: "2026-10-03T20:00:00Z" };
  r.vendor = "Home Depot"; r.amount = "215.00"; r.category = "other"; r.date = "2026-10-02";
  r.items = [{ id: "a", desc: "my line", qty: "1", unit: "", price: "215" }];
  const changed = applyReceiptRead(r, read);
  assert.deepEqual(changed, [], "nothing blank, nothing changes");
  assert.equal(r.vendor, "Home Depot");
  assert.equal(r.amount, "215.00");
  assert.equal(r.category, "other");
  assert.equal(r.date, "2026-10-02");
  assert.equal(r.items[0].desc, "my line");
  applyReceiptRead(r, read, { overwrite: true });
  assert.equal(r.vendor, "The Home Depot #1234");
  assert.equal(r.amount, "212.34");
  assert.equal(r.category, "materials");
  assert.equal(r.items.length, 2);
});

test("applyReceiptRead tolerates a thin or garbled read", () => {
  const r = newReceipt();
  const changed = applyReceiptRead(r, { vendor: "", total: "n/a", date: "10/3/26", items: "nope", cardLast4: null, paidWith: "bitcoin" });
  assert.deepEqual(changed, []);
  assert.equal(r.amount, "");
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.paidWith, "");
  assert.deepEqual(applyReceiptRead(null, read), []);
  assert.deepEqual(applyReceiptRead(r, null), []);
});

console.log(`\n${pass} receiptcalc checks passed.`);
