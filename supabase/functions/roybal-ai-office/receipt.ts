/* Receipt reading — the pure half (no Deno, no network).
   The 🧾 Receipts tile snaps a receipt; `receiptRead` (index.ts) sends the
   page images here-shaped and the field app lands the result on the receipt
   (receiptcalc.js applyReceiptRead). Everything the model returns passes
   through normalizeReceiptRead so a thin or garbled read can never put a
   non-number in a money field or an unknown category on a row.
   Tested by receipt.test.mjs. */

export const RECEIPT_CATEGORIES = ["materials", "equipment", "dump", "other"] as const;
export const PAID_WITH = ["card", "account", "cash", "personal"] as const;

export const RECEIPT_READ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["vendor", "date", "isReturn", "total", "subtotal", "tax", "cardLast4", "receiptNo", "paidWith", "category", "items", "confidence", "notes"],
  properties: {
    vendor: { type: "string", description: "The store or vendor as printed, e.g. 'The Home Depot #1234', 'Spenard Builders Supply', 'FNSB Landfill'; empty if unreadable" },
    date: { type: "string", description: "The purchase date printed on the receipt, ISO YYYY-MM-DD; empty if not printed" },
    isReturn: { type: "boolean", description: "true when this is a RETURN / refund / credit slip or credit memo (money back to the buyer), false for a purchase" },
    total: { type: ["number", "null"], description: "The TOTAL actually paid, in dollars (after tax, after any discount); on a return slip the refund total, negative; null if unreadable" },
    subtotal: { type: ["number", "null"], description: "The pre-tax subtotal in dollars; null if not printed" },
    tax: { type: ["number", "null"], description: "Sales tax in dollars; null if none printed (Fairbanks has no sales tax — most receipts show none)" },
    cardLast4: { type: "string", description: "Last four digits of the card used, if printed (e.g. from '************4558'); empty otherwise" },
    receiptNo: { type: "string", description: "The receipt / transaction / invoice number printed on it; empty if none" },
    paidWith: { type: "string", enum: ["card", "account", "cash", "personal", ""], description: "card = a credit/debit card; account = charged to a store/house account (an invoice or 'charge' slip, no card); cash; personal only when the receipt itself says so; empty when unclear" },
    category: { type: "string", enum: ["materials", "equipment", "dump", "other"], description: "materials = building materials/supplies/tools/paint; equipment = equipment or tool RENTAL; dump = landfill, transfer station or disposal fees; other = anything else (fuel, food, permits)" },
    items: {
      type: "array",
      description: "EVERY line item on the receipt in printed order (returns/credits as negative prices; skip subtotal/tax/total/payment lines)",
      items: {
        type: "object", additionalProperties: false,
        required: ["desc", "qty", "unit", "price", "sku"],
        properties: {
          desc: { type: "string", description: "The item description as printed, expanded where obvious (e.g. '3/4 CDX 4X8' → '3/4\" CDX plywood 4x8')" },
          qty: { type: "number", description: "Quantity; 1 when not printed" },
          unit: { type: "string", description: "ea, sht, lf, bf, gal, box, bag, hr, day… empty when not printed" },
          price: { type: ["number", "null"], description: "UNIT price in dollars (the line total divided by qty when only a line total is printed); null if unreadable" },
          sku: { type: "string", description: "SKU / item / UPC number printed with the line; empty if none" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How readable the receipt was overall" },
    notes: { type: "string", description: "One line on anything a person should check — faded total, cut-off lines, a return slip, a second receipt in the photo; empty when nothing" },
  },
} as const;

export const RECEIPT_SYSTEM =
  "You are the bookkeeper at Roybal Construction, LLC (restoration and construction, Fairbanks Alaska) transcribing a " +
  "purchase receipt a crew member photographed at the counter, so the job's material cost is right and the office can " +
  "find any item later for a return. Transcribe ONLY what is printed — never guess a total or invent a line. " +
  "Call `receipt` with the structured result.";

export function receiptReadText(pageCount: number): string {
  return (
    `Read this receipt${pageCount > 1 ? ` (${pageCount} pages, page 1 first)` : ""} for the job's cost log.\n` +
    "RULES:\n" +
    "- vendor: the store name as printed (keep the store number, e.g. 'The Home Depot #1234').\n" +
    "- total: the amount actually PAID (the final TOTAL, after tax and discounts). subtotal and tax only when printed.\n" +
    "- isReturn: true for a return / refund / credit slip or credit memo; then total is the refund as a NEGATIVE number " +
    "and the returned lines are negative prices.\n" +
    "- items: every purchased line in printed order, with the UNIT price. A quantity of 3 @ 4.98 is qty 3, price 4.98. " +
    "A line printed only as an extended amount is price = amount ÷ qty. Returns and credits are negative prices. " +
    "Skip subtotal, tax, total, change, payment and loyalty lines.\n" +
    "- cardLast4 from a masked card number; receiptNo from the transaction / receipt / invoice number.\n" +
    "- paidWith: 'account' when it is a charge/house-account slip or an invoice (no card line), 'card' when a card line is printed.\n" +
    "- category: equipment only for RENTALS; dump for landfill / transfer-station / disposal fees; materials for supplies and tools; else other.\n" +
    "- Unreadable parts: leave the field empty/null and say so in notes rather than guessing."
  );
}

type Item = { desc: string; qty: number; unit: string; price: number | null; sku: string };
export type ReceiptRead = {
  vendor: string; date: string; total: number | null; subtotal: number | null; tax: number | null;
  /** A return slip: total, subtotal and tax are null (a phone lands total as a
      cost, so a refund must never reach it) and refund carries the slip's
      total as a positive number, null when unreadable. */
  isReturn: boolean; refund: number | null;
  cardLast4: string; receiptNo: string; paidWith: string; category: string; items: Item[];
  confidence: number; notes: string;
};

const money = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === "string") {
    const s = v.replace(/[$,\s]/g, "");
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  return null;
};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);

/** Clamp a model result to the shape the field app expects. Never throws. */
export function normalizeReceiptRead(input: unknown): ReceiptRead {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const date = str(o.date, 10);
  const items: Item[] = (Array.isArray(o.items) ? o.items : []).slice(0, 200)
    .map((it) => (it && typeof it === "object" ? it : {}) as Record<string, unknown>)
    .map((it) => ({
      desc: str(it.desc, 200),
      qty: (() => { const q = money(it.qty); return q != null && q > 0 ? q : 1; })(),
      unit: str(it.unit, 12),
      price: money(it.price),
      sku: str(it.sku, 40),
    }))
    .filter((it) => it.desc);
  const cat = str(o.category, 20).toLowerCase();
  const paid = str(o.paidWith, 20).toLowerCase();
  const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0;
  const total = money(o.total);
  // a negative total is a credit whatever the flag says; a phone before v206
  // ignores isReturn and drops a null total, as it always dropped a negative one
  const isReturn = o.isReturn === true || (total != null && total < 0);
  return {
    vendor: str(o.vendor, 120),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    total: isReturn ? null : total,
    subtotal: isReturn ? null : money(o.subtotal),
    tax: isReturn ? null : money(o.tax),
    isReturn,
    refund: isReturn && total != null && total !== 0 ? Math.abs(total) : null,
    cardLast4: str(o.cardLast4, 40).replace(/\D/g, "").slice(-4),
    receiptNo: str(o.receiptNo, 40),
    paidWith: (PAID_WITH as readonly string[]).includes(paid) ? paid : "",
    category: (RECEIPT_CATEGORIES as readonly string[]).includes(cat) ? cat : "other",
    items,
    confidence: conf,
    notes: str(o.notes, 400),
  };
}
