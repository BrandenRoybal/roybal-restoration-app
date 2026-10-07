/* Receipt reading — the pure half (no Deno, no network).
   Run: node --experimental-strip-types receipt.test.mjs */
import assert from "node:assert/strict";
import { RECEIPT_READ_SCHEMA, RECEIPT_CATEGORIES, PAID_WITH, receiptReadText, RECEIPT_SYSTEM, normalizeReceiptRead } from "./receipt.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

test("schema: every field the field app lands is required, items carry sku and unit price", () => {
  const req = RECEIPT_READ_SCHEMA.required;
  for (const k of ["vendor", "date", "isReturn", "total", "subtotal", "tax", "cardLast4", "receiptNo", "paidWith", "category", "items", "confidence", "notes"])
    assert.ok(req.includes(k), k + " is required");
  assert.deepEqual(RECEIPT_READ_SCHEMA.properties.category.enum, [...RECEIPT_CATEGORIES]);
  assert.deepEqual(RECEIPT_READ_SCHEMA.properties.paidWith.enum, [...PAID_WITH, ""]);
  assert.deepEqual(RECEIPT_READ_SCHEMA.properties.items.items.required, ["desc", "qty", "unit", "price", "sku"]);
  assert.equal(RECEIPT_READ_SCHEMA.additionalProperties, false);
});

test("prompt: the rules that keep the cost log honest are in the text", () => {
  const t = receiptReadText(1);
  assert.match(t, /actually PAID/);
  assert.match(t, /every purchased line/);
  assert.match(t, /negative prices/);
  assert.match(t, /isReturn: true for a return/);
  assert.match(t, /equipment only for RENTALS/);
  assert.match(t, /rather than guessing/);
  assert.match(receiptReadText(3), /3 pages, page 1 first/);
  assert.match(RECEIPT_SYSTEM, /never guess a total/);
});

test("normalize: a clean read passes through rounded and trimmed", () => {
  const r = normalizeReceiptRead({
    vendor: "  The Home Depot #1234 ", date: "2026-10-03", total: 212.344, subtotal: 200, tax: 12.34,
    cardLast4: "************4558", receiptNo: " 9012 00034 ", paidWith: "card", category: "materials",
    items: [{ desc: "3/4 CDX plywood 4x8", qty: 4, unit: "sht", price: 42.5, sku: "123456" }, { desc: "", qty: 1, unit: "", price: 1, sku: "" }],
    confidence: 0.92, notes: "",
  });
  assert.equal(r.vendor, "The Home Depot #1234");
  assert.equal(r.total, 212.34);
  assert.equal(r.cardLast4, "4558");
  assert.equal(r.receiptNo, "9012 00034");
  assert.equal(r.items.length, 1, "blank lines are dropped");
  assert.deepEqual(r.items[0], { desc: "3/4 CDX plywood 4x8", qty: 4, unit: "sht", price: 42.5, sku: "123456" });
  assert.equal(r.confidence, 0.92);
});

test("normalize: garbage never reaches a money field, an unknown category becomes other", () => {
  const r = normalizeReceiptRead({
    vendor: 42, date: "10/3/26", total: "two hundred", subtotal: "$1,000.00", tax: "n/a",
    cardLast4: "none", receiptNo: null, paidWith: "bitcoin", category: "lumber",
    items: [{ desc: "thing", qty: "x", price: "4.9800" }, "not an object", null, { desc: "credit", qty: 1, price: -5 }],
    confidence: 7, notes: 12,
  });
  assert.equal(r.vendor, "42");
  assert.equal(r.date, "", "a non-ISO date is dropped (the receipt keeps today's)");
  assert.equal(r.total, null);
  assert.equal(r.subtotal, 1000);
  assert.equal(r.tax, null);
  assert.equal(r.cardLast4, "");
  assert.equal(r.receiptNo, "");
  assert.equal(r.paidWith, "");
  assert.equal(r.category, "other");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].qty, 1, "an unreadable qty is 1");
  assert.equal(r.items[0].price, 4.98);
  assert.equal(r.items[1].price, -5, "a credit keeps its sign");
  assert.equal(r.confidence, 1, "clamped");
  assert.equal(r.notes, "12");
  assert.equal(normalizeReceiptRead(null).items.length, 0);
  assert.equal(normalizeReceiptRead(undefined).total, null);
  assert.equal(normalizeReceiptRead({ total: -3 }).total, null, "a negative total is not a total");
  assert.equal(r.isReturn, false);
  assert.equal(r.refund, null);
});

test("normalize: a return slip never puts money in total, subtotal or tax; refund carries it", () => {
  const slip = normalizeReceiptRead({ vendor: "Spenard Builders Supply", isReturn: true, total: -1146.75, subtotal: 1146.75, tax: 0,
    items: [{ desc: "2in 4x8 Styrofoam 25 PSI", qty: 15, unit: "ea", price: -76.45, sku: "ISD24SM" }] });
  assert.equal(slip.isReturn, true);
  assert.equal(slip.total, null, "a phone lands total as a cost");
  assert.equal(slip.subtotal, null);
  assert.equal(slip.tax, null);
  assert.equal(slip.refund, 1146.75);
  assert.equal(slip.items[0].price, -76.45, "the lines keep their sign");
  // the model flags a return but prints the refund positive: still never a cost
  const pos = normalizeReceiptRead({ isReturn: true, total: 45.97 });
  assert.equal(pos.total, null);
  assert.equal(pos.refund, 45.97);
  // a negative total is a credit even when the flag is missing or false
  const neg = normalizeReceiptRead({ isReturn: false, total: -12 });
  assert.equal(neg.isReturn, true);
  assert.equal(neg.refund, 12);
  // a slip whose total is unreadable
  assert.equal(normalizeReceiptRead({ isReturn: true, total: null }).refund, null);
  // only a real boolean true flags a return
  assert.equal(normalizeReceiptRead({ isReturn: "yes", total: 20 }).isReturn, false);
  assert.equal(normalizeReceiptRead({ isReturn: "yes", total: 20 }).total, 20);
});

console.log(`\n${pass} receipt checks passed.`);
