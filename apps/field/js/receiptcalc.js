/* ============================================================
   Job receipts — pure math (no DOM, no imports)
   ------------------------------------------------------------
   The running material total on the job page, by category, over
   project.receipts[] — the same array the office assistant's
   receiptLog chip writes and the budget flag (fincalc.js
   loggedCosts) sums, so a snapped receipt and a chip-logged one
   count the same way. Categories are normalised here from
   whatever text a receipt carries (the assistant writes free
   text; the field form writes the keys below). Migration 0015
   (reconcile_job_receipts) mirrors the same rules in SQL so the
   job_receipts table and the job page agree.
   ============================================================ */

export const RECEIPT_CATEGORIES = [
  { value: "materials", label: "Materials",        icon: "🪵" },
  { value: "equipment", label: "Equipment rental", icon: "🚜" },
  { value: "dump",      label: "Dump fees",        icon: "🗑" },
  { value: "other",     label: "Other",            icon: "🧾" },
];
export const RECEIPT_CATEGORY_KEYS = RECEIPT_CATEGORIES.map((c) => c.value);
export const receiptCategoryLabel = (v) => RECEIPT_CATEGORIES.find((c) => c.value === receiptCategory(v))?.label || "Other";

/* How the receipt was paid. Nothing reads it yet; the QuickBooks link
   (plan phase 3) keys off it — a card or bank buy waits for the feed
   charge, a store-account buy becomes its own expense. */
export const PAID_WITH = [
  { value: "card",     label: "Company card" },
  { value: "account",  label: "Store account" },
  { value: "cash",     label: "Cash" },
  { value: "personal", label: "Personal card (reimburse)" },
];

/** "$1,234.50" / " 12 " / 12 → 1234.5 / 12 / 12; anything else → 0 */
export function amountNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Free-text or keyed category → one of RECEIPT_CATEGORY_KEYS.
    Keep in step with reconcile_job_receipts (migration 0015). */
export function receiptCategory(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "other";
  if (RECEIPT_CATEGORY_KEYS.includes(s)) return s;
  if (/equip|rental|rent\b/.test(s)) return "equipment";
  if (/dump|landfill|disposal|transfer station|tipping/.test(s)) return "dump";
  if (/material|lumber|supply|supplies|hardware|paint|plumb|electric/.test(s)) return "materials";
  return "other";
}

/** The receipt's total: `amount` (what the budget flag sums). */
export const receiptAmount = (r) => amountNum(r && r.amount);

/** Σ qty × price over the receipt's line items (a drift check against the
    printed total, never the total itself — a receipt's total is what was paid). */
export function itemsTotal(items) {
  return (items || []).reduce((a, it) => a + amountNum(it && it.qty) * amountNum(it && it.price), 0);
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Running totals over a job's receipts:
    { total, count, returns, credits, byCategory: { materials: {total, count}, … }, vendors: [{vendor, total, count}] }
    A return logged in the office (kind "return", plan phase 2) is its own
    element with a negative amount: every total nets it, `credits` sums
    them, and the counts count purchases (`count`) and returns (`returns`)
    apart — "3 receipts" for two buys and a return would misstate it. */
export function receiptTotals(p) {
  const out = { total: 0, count: 0, returns: 0, credits: 0, byCategory: {}, vendors: [] };
  for (const k of RECEIPT_CATEGORY_KEYS) out.byCategory[k] = { total: 0, count: 0 };
  const byVendor = new Map();
  for (const r of (p && p.receipts) || []) {
    if (!r) continue;
    const amt = receiptAmount(r);
    const cat = receiptCategory(r.category);
    const ret = r.kind === "return";
    out.total += amt;
    if (ret) { out.returns++; out.credits += amt; } else out.count++;
    out.byCategory[cat].total += amt; if (!ret) out.byCategory[cat].count++;
    const key = vendorKey(r.vendor);
    const v = byVendor.get(key) || { vendor: String(r.vendor || "").trim() || "Unknown vendor", total: 0, count: 0 };
    v.total += amt; if (!ret) v.count++;
    byVendor.set(key, v);
  }
  out.total = r2(out.total);
  out.credits = r2(out.credits);
  for (const k of RECEIPT_CATEGORY_KEYS) out.byCategory[k].total = r2(out.byCategory[k].total);
  out.vendors = [...byVendor.values()].map((v) => ({ ...v, total: r2(v.total) })).sort((a, b) => b.total - a.total);
  return out;
}

/** "THE HOME DEPOT #1234", "Home Depot 1234" and "Home Depot" group together,
    and so do "Lowe's" and "Lowes". The office's vendor return windows
    (public.receipt_vendors, migration 0018) are keyed by it. */
export function vendorKey(v) {
  return String(v || "").trim().toLowerCase().replace(/^the\s+/, "").replace(/\s*#\s*\d+.*$/, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/ \d{3,}$/, "") || "unknown";
}

/** The job tile's second line, or "" when nothing is logged yet. */
export function receiptTileLine(p) {
  const t = receiptTotals(p);
  if (!t.count && !t.returns) return "";
  const parts = [fmtMoney(t.total)];
  if (t.count) parts.push(`${t.count} receipt${t.count === 1 ? "" : "s"}`);
  if (t.returns) parts.push(`${t.returns} return${t.returns === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export const fmtMoney = (n) => {
  const v = r2(amountNum(n));
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/* ---------- applying an AI read ----------
   The reader returns { vendor, date, total, subtotal, tax, cardLast4,
   receiptNo, paidWith, category, items:[{desc, qty, unit, price}],
   confidence, notes }. Default: fill only what the crew left blank, so a
   re-read after a hand correction never undoes it; overwrite:true replaces
   everything the reader returned (the "Read again" confirm path). Items are
   taken when the receipt has none, or on overwrite. Returns the list of
   fields that changed. */
export function applyReceiptRead(r, read, { overwrite = false } = {}) {
  const changed = [];
  if (!r || !read) return changed;
  const blank = (k) => r[k] == null || String(r[k]).trim() === "";
  const setText = (k, v, max = 120) => {
    const s = String(v ?? "").trim().slice(0, max);
    if (!s) return;
    if (overwrite || blank(k)) { if (r[k] !== s) { r[k] = s; changed.push(k); } }
  };
  const setMoney = (k, v) => {
    const n = typeof v === "number" ? v : amountNum(v);
    if (!(n > 0)) return;
    if (overwrite || blank(k) || amountNum(r[k]) === 0) {
      const s = String(r2(n));
      if (r[k] !== s) { r[k] = s; changed.push(k); }
    }
  };
  setText("vendor", read.vendor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(read.date || ""))) {
    // a fresh receipt carries today's date — the printed one wins once
    if (overwrite || blank("date") || !r.ai) { if (r.date !== read.date) { r.date = read.date; changed.push("date"); } }
  }
  setMoney("amount", read.total);
  setMoney("subtotal", read.subtotal);
  setMoney("tax", read.tax);
  setText("cardLast4", String(read.cardLast4 || "").replace(/\D/g, "").slice(-4), 4);
  setText("receiptNo", read.receiptNo, 40);
  if (read.paidWith && PAID_WITH.some((o) => o.value === read.paidWith) && (overwrite || blank("paidWith"))) {
    if (r.paidWith !== read.paidWith) { r.paidWith = read.paidWith; changed.push("paidWith"); }
  }
  if (read.category && (overwrite || !r.ai)) {
    const c = receiptCategory(read.category);
    if (r.category !== c) { r.category = c; changed.push("category"); }
  }
  const items = Array.isArray(read.items) ? read.items.filter((it) => it && String(it.desc || "").trim()) : [];
  if (items.length && (overwrite || !(r.items || []).length)) {
    r.items = items.slice(0, 200).map((it) => ({
      id: it.id || ("ri-" + Math.random().toString(36).slice(2, 10)),
      desc: String(it.desc || "").trim().slice(0, 200),
      qty: it.qty == null || it.qty === "" ? "1" : String(amountNum(it.qty) || 1),
      unit: String(it.unit || "").trim().slice(0, 12),
      price: it.price == null ? "" : String(r2(amountNum(it.price))),
      sku: String(it.sku || "").trim().slice(0, 40),
    }));
    changed.push("items");
  }
  if (read.notes && (overwrite || blank("notes"))) {
    const s = String(read.notes).trim().slice(0, 400);
    if (s && r.notes !== s) { r.notes = s; changed.push("notes"); }
  }
  return changed;
}
