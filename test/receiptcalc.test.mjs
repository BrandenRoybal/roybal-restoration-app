/* receiptcalc.js — the job page's running material total, category
   normalisation (shared with the office assistant's free-text receipts and
   mirrored by migration 0015's reconcile_job_receipts), and how an AI read
   lands on a receipt without undoing a crew member's corrections.
   Run: node test/receiptcalc.test.mjs */
import assert from "node:assert/strict";
import {
  RECEIPT_CATEGORIES, RECEIPT_CATEGORY_KEYS, receiptCategory, receiptCategoryLabel, amountNum, itemsTotal, receiptAmount,
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
  assert.deepEqual(receiptTotals({}), { total: 0, count: 0, returns: 0, credits: 0, byCategory: {
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
  // phase 2: the office's return windows are keyed by it, so the obvious
  // spellings of one store must land on one key
  assert.equal(vendorKey("THE HOME DEPOT 1234"), "home depot", "a store number with no #");
  assert.equal(vendorKey(" The Home Depot"), "home depot", "a leading space no longer keeps THE");
  assert.equal(vendorKey("Lowe's #2345"), "lowes");
  assert.equal(vendorKey("Lowes"), "lowes");
  assert.equal(vendorKey("Home Depot Pro"), "home depot pro", "a different store stays different");
  assert.equal(vendorKey("84 Lumber"), "84 lumber", "leading digits are part of the name");
  assert.equal(vendorKey("Highway 2 Hardware"), "highway 2 hardware");
  assert.equal(vendorKey("#1234"), "unknown");
});

test("returns (kind: return, negative amount) net the totals and count apart", () => {
  const p = { receipts: [
    { id: "R1", vendor: "Home Depot", amount: "200.00", category: "materials" },
    { id: "R2", vendor: "Spenard", amount: "100", category: "materials" },
    { id: "C1", kind: "return", returnOf: "R1", vendor: "Home Depot", amount: "-45.97", category: "materials" },
  ] };
  const t = receiptTotals(p);
  assert.equal(t.total, 254.03);
  assert.equal(t.count, 2, "purchases only");
  assert.equal(t.returns, 1);
  assert.equal(t.credits, -45.97);
  assert.equal(t.byCategory.materials.total, 254.03);
  assert.equal(t.byCategory.materials.count, 2);
  assert.equal(t.vendors.find((v) => v.vendor === "Home Depot").total, 154.03);
  assert.equal(t.vendors.find((v) => v.vendor === "Home Depot").count, 1);
  assert.equal(loggedCosts(p), 254.03, "the budget flag nets the credit the same way");
  assert.equal(receiptTileLine(p), "$254.03 · 2 receipts · 1 return");
  assert.equal(receiptTileLine({ receipts: [p.receipts[2]] }), "−$45.97 · 1 return", "a job holding only a credit still shows it");
  assert.equal(formCount(p, "receipts"), 2, "the tile badge counts receipts, not returns");
});

test("a return retyped as a positive total on an older phone still counts as money back", () => {
  const p = { receipts: [
    { id: "R1", vendor: "Home Depot", amount: "200.00", category: "materials" },
    { id: "C1", kind: "return", returnOf: "R1", vendor: "Home Depot", amount: "45.97", category: "materials" },
  ] };
  assert.equal(receiptAmount(p.receipts[1]), -45.97);
  assert.equal(receiptTotals(p).total, 154.03);
  assert.equal(receiptTotals(p).credits, -45.97);
  assert.equal(loggedCosts(p), 154.03, "the budget flag reads it the same way");
  assert.equal(receiptAmount({ amount: "-12.00" }), -12, "an ordinary negative entry is left as typed");
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
