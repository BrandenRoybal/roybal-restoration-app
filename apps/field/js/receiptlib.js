/* ============================================================
   Receipts library — pure logic for the office Receipts page
   (Job Receipts plan, phase 2). No DOM, no Store, no network.
   ------------------------------------------------------------
   The office page (apps/admin/js/receiptlibrary.js) builds a
   text-only index of every receipt on every job the office
   device holds, then filters, searches and flags it here, so all
   of it is testable with node:test (receiptlib.test.mjs).

   RETURNS. A return is never an edit to the receipt it returns.
   It is a NEW element in the same job's receipts[] — a credit:
     { kind: "return", returnOf: <first receipt's id>, amount: "-45.97",
       items: [{ of: <item id>, ofReceipt: <receipt id>, qty, price: "-12.98", … }], … }
   Sync unions receipts by id, so a crew phone holding an older copy
   of the job can never undo it, and a negative amount already nets
   in every total (receiptTotals, fincalc loggedCosts, the morning
   brief, job_receipts). What a receipt "has returned" is derived
   from the credits that point at it, here, every time.

   Only names that existed in receiptcalc.js before this file are
   imported: the office browser can hold a stale cached copy of a
   field module for one load after a deploy (sw.js serves them
   stale-while-revalidate), and a missing export would blank the page.
   ============================================================ */
import { amountNum, receiptAmount, receiptCategory, vendorKey, fmtMoney } from "./receiptcalc.js";

export const isReturn = (r) => !!r && r.kind === "return";

const r2 = (n) => Math.round(n * 100) / 100;
const EPS = 0.005;

/** The positive money string a form shows ("45.97"), never fmtMoney's "−$". */
export const money2 = (n) => r2(Math.abs(amountNum(n))).toFixed(2);
/** The negative money string a credit stores ("-45.97"): parses the same in
    amountNum, Number(), fincalc and the 0015 SQL regex. */
export const negMoney = (n) => {
  const v = r2(Math.abs(amountNum(n)));
  return v ? "-" + v.toFixed(2) : "0.00";
};

/* ---------- dates: calendar days on the local calendar ---------- */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function validISO(s) {
  const m = ISO_RE.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const utcOf = (iso) => { const m = ISO_RE.exec(iso); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
/** YYYY-MM-DD of a Date on the device's own calendar (todayISO's calendar). */
export function localISO(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDaysISO(iso, n) { return new Date(utcOf(iso) + n * 86400000).toISOString().slice(0, 10); }
/** Whole calendar days from a to b (DST-proof: both read as UTC midnights). */
export function daysBetween(a, b) { return Math.round((utcOf(b) - utcOf(a)) / 86400000); }
/** The receipt's day: its printed date, else the local day it was logged. */
export function receiptDay(r) {
  if (r && validISO(r.date)) return r.date;
  const at = r && (r.createdAt || r.at);
  const t = at ? new Date(at) : null;
  return t && !isNaN(t) ? localISO(t) : "";
}
export function fmtDay(iso) {
  if (!validISO(iso)) return "";
  return new Date(utcOf(iso)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/* ---------- text: one normaliser for the haystack and the query ---------- */
export const norm = (s) => String(s ?? "").toLowerCase()
  .replace(/["“”″'’`]/g, "")           // 3/4" plywood → 3/4 plywood; lowe's → lowes
  .replace(/\s+/g, " ").trim();
const descKey = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
const MONEY_Q = /^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/;

/* ---------- the index ---------- */
function jobOf(p) {
  return {
    id: p.id,
    customer: String(p.customer || "").trim() || "Untitled job",
    address: String(p.address || "").trim(),
    claim: String(p.claimNo || "").trim(),
  };
}
/** "1192 Bemis Ct" when the job has an address, else the customer. */
export const jobLabel = (job) => (job && (job.address || job.customer)) || "Untitled job";

function itemOf(it) {
  const q = amountNum(it.qty);
  return {
    id: String(it.id || ""),
    of: it.of ? String(it.of) : "",
    ofReceipt: it.ofReceipt ? String(it.ofReceipt) : "",
    desc: String(it.desc || "").trim(),
    qty: q > 0 ? q : 1,                 // a priced line with no qty is one of it
    unit: String(it.unit || "").trim(),
    price: amountNum(it.price),         // unit price; negative on a credit
    sku: String(it.sku || "").trim(),
  };
}

function entryOf(r, job) {
  const items = (Array.isArray(r.items) ? r.items : []).filter((it) => it && typeof it === "object").map(itemOf);
  const vendor = String(r.vendor || "").trim();
  const ret = isReturn(r);
  const pages = (r.photo ? 1 : 0) + (Array.isArray(r.extraPages) ? r.extraPages.filter(Boolean).length : 0);
  const e = {
    jobId: job.id, job, id: String(r.id),
    kind: ret ? "return" : "purchase",
    returnOf: ret && r.returnOf ? String(r.returnOf) : "",
    vendor, vkey: vendorKey(vendor),
    date: receiptDay(r), createdAt: String(r.createdAt || r.at || ""),
    amount: receiptAmount(r),
    subtotal: amountNum(r.subtotal), tax: amountNum(r.tax),
    category: receiptCategory(r.category),
    paidWith: String(r.paidWith || ""), cardLast4: String(r.cardLast4 || ""),
    receiptNo: String(r.receiptNo || "").trim(), notes: String(r.notes || "").trim(),
    by: String(r.by || r.loggedBy || ""), ai: !!r.ai,
    pages, hasPhoto: !!r.photo, items,
    // derived below (linkReturns)
    returned: 0, returnIds: [], returnedQty: {}, orphan: false, targets: [],
  };
  e.hay = norm([vendor, e.receiptNo, e.cardLast4, e.notes, job.customer, job.address, job.claim,
    ...items.map((it) => it.desc + " " + it.sku)].join(" "));
  return e;
}

/** Every receipt on every job, text only (no photo strings: an index that
    held the receipt objects would pin every image in memory). Elements a
    job has tombstoned are skipped. */
export function buildIndex(projects) {
  const out = [];
  for (const p of projects || []) {
    if (!p || !p.id || !Array.isArray(p.receipts)) continue;
    const dead = (p.deletedIds && typeof p.deletedIds === "object") ? p.deletedIds : {};
    const job = jobOf(p);
    for (const r of p.receipts) {
      if (!r || !r.id || dead[r.id]) continue;
      out.push(entryOf(r, job));
    }
  }
  linkReturns(out);
  return out;
}

/* What a receipt charged per dollar of its listed lines: its total over the
   lines (a contractor discount pulls it under 1, tax pushes it over). Lines
   adding to far less than the total were misread or left out, so the lines
   count at face value then. */
function paidRatio(p) {
  const list = p.items.reduce((a, it) => a + (it.price > 0 ? it.qty * it.price : 0), 0);
  const k = p.amount > 0 && list > 0 ? p.amount / list : 1;
  return k <= 1.25 ? k : 1;
}

/* Which purchase receipts a credit touches, and how much of it each one
   takes: each line's ofReceipt (else the credit's returnOf) gets its lines'
   value at what that receipt actually charged (paidRatio), and the credit's
   amount is split in those proportions; a credit with no lines goes wholly
   to returnOf. narrative.js repeats this for the billing AI. */
function creditShares(c, byId) {
  const val = new Map();
  for (const it of c.items) {
    const rid = it.ofReceipt || c.returnOf;
    if (!rid || !byId.has(rid)) continue;
    val.set(rid, (val.get(rid) || 0) + Math.abs(it.qty * it.price) * paidRatio(byId.get(rid)));
  }
  const total = Math.abs(c.amount);
  if (!val.size) return byId.has(c.returnOf) ? new Map([[c.returnOf, total]]) : new Map();
  const sum = [...val.values()].reduce((a, b) => a + b, 0);
  const out = new Map();
  for (const [rid, v] of val) out.set(rid, sum > 0 ? total * (v / sum) : total / val.size);
  return out;
}

/* A credit line → the purchase's item it returns: by item id, then by sku,
   then by description — an AI re-read of the purchase mints new item ids,
   and the sku/description fallbacks keep the link. One line, one item. */
function matchLines(purchase, lines) {
  const qty = {};
  const items = purchase.items.filter((it) => it.price > 0);
  for (const ln of lines) {
    let hit = ln.of && items.find((it) => it.id === ln.of);
    if (!hit && ln.sku) hit = items.find((it) => it.sku && it.sku === ln.sku);
    if (!hit && ln.desc) { const k = descKey(ln.desc); hit = k && items.find((it) => descKey(it.desc) === k); }
    if (hit) qty[hit.id] = (qty[hit.id] || 0) + ln.qty;
  }
  return qty;
}

function linkReturns(entries) {
  const byJob = new Map();
  for (const e of entries) {
    if (!byJob.has(e.jobId)) byJob.set(e.jobId, []);
    byJob.get(e.jobId).push(e);
  }
  for (const list of byJob.values()) {
    const byId = new Map(list.filter((e) => e.kind === "purchase").map((e) => [e.id, e]));
    const linesFor = new Map();
    for (const c of list) {
      if (c.kind !== "return") continue;
      const shares = creditShares(c, byId);
      c.targets = [...shares.keys()];
      c.orphan = !c.targets.length;
      for (const [rid, amt] of shares) {
        const p = byId.get(rid);
        p.returned = r2(p.returned + amt);
        if (!p.returnIds.includes(c.id)) p.returnIds.push(c.id);
        const lines = c.items.filter((it) => (it.ofReceipt || c.returnOf) === rid);
        if (!linesFor.has(rid)) linesFor.set(rid, []);
        linesFor.get(rid).push(...lines);
      }
    }
    for (const [rid, lines] of linesFor) byId.get(rid).returnedQty = matchLines(byId.get(rid), lines);
  }
}

/** "all" / "part" / "" for a purchase entry. */
export function returnStatus(e) {
  if (!e || e.kind !== "purchase" || !(e.returned > 0)) return "";
  return e.amount > 0 && e.returned >= e.amount - 0.01 ? "all" : "part";
}
export const overReturned = (e) => !!e && e.kind === "purchase" && e.amount > 0 && e.returned > e.amount + 0.05;
/** A purchase with no usable total: unread, or a return slip the crew snapped
    (the AI read drops a negative total, so a slip lands as a $0 receipt). */
export const needsTotal = (e) => !!e && e.kind === "purchase" && !(e.amount > 0);

/* ---------- search and filters ---------- */
function moneyQuery(q) {
  const s = String(q || "").trim();
  if (!MONEY_Q.test(s)) return null;
  const n = amountNum(s);
  return n > 0 ? n : null;
}
/** Every word of the query somewhere on the receipt (vendor, items, sku,
    receipt #, card, notes, job). A money query ("212.40", "$45.97") also
    matches the receipt total or any line's unit price or line total. */
export function matchQuery(e, q) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return true;
  if (words.every((w) => e.hay.includes(w))) return true;
  const m = moneyQuery(q);
  if (m == null) return false;
  if (Math.abs(Math.abs(e.amount) - m) < EPS) return true;
  return e.items.some((it) => Math.abs(Math.abs(it.price) - m) < EPS || Math.abs(Math.abs(it.qty * it.price) - m) < EPS);
}
/** The item lines worth showing under a search hit. */
export function matchedLines(e, q) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  const m = moneyQuery(q);
  const hay = (it) => norm(it.desc + " " + it.sku);
  let hits = e.items.filter((it) => words.every((w) => hay(it).includes(w)));
  if (!hits.length && m != null) hits = e.items.filter((it) => Math.abs(Math.abs(it.price) - m) < EPS || Math.abs(Math.abs(it.qty * it.price) - m) < EPS);
  if (!hits.length) hits = e.items.filter((it) => words.some((w) => w.length > 2 && hay(it).includes(w)));
  return hits.slice(0, 4);
}

export const DATE_PRESETS = [["", "All dates"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["year", "This year"]];
export function sinceFor(preset, today) {
  if (preset === "30" || preset === "90") return addDaysISO(today, -Number(preset));
  if (preset === "year") return today.slice(0, 4) + "-01-01";
  return "";
}
export const SHOW = [["all", "All"], ["purchases", "Purchases"], ["returns", "Returns"], ["needs", "Needs a total"]];

/** A vendor filter "home depot" also takes "home depot pro" and "home depot 1234". */
export const vendorMatches = (vkey, want) => !want || vkey === want || vkey.startsWith(want + " ");

const byNewest = (a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "");

/** { rows, hidden }: rows passing every filter, newest first; hidden = how many
    more match the search alone (so "No receipts match" can say why). */
export function filterEntries(entries, f = {}) {
  const since = sinceFor(f.preset || "", f.today || "");
  const show = f.show || "all";
  const pass = (e) =>
    vendorMatches(e.vkey, f.vendor || "") &&
    (!f.job || e.jobId === f.job) &&
    (!since || (e.date && e.date >= since)) &&
    (show === "all" || (show === "purchases" && e.kind === "purchase") ||
      (show === "returns" && e.kind === "return") || (show === "needs" && needsTotal(e)));
  const hits = entries.filter((e) => matchQuery(e, f.q || ""));
  const rows = hits.filter(pass).sort(byNewest);
  return { rows, hidden: f.q ? hits.length - rows.length : 0 };
}

/** One line for the filtered set. */
export function summarize(rows) {
  let spent = 0, returned = 0, purchases = 0, returns = 0;
  for (const e of rows) {
    spent += e.amount;
    if (e.kind === "return") { returns++; returned += Math.abs(e.amount); } else purchases++;
  }
  return { spent: r2(spent), returned: r2(returned), purchases, returns };
}

/* ---------- vendors and their return windows ----------
   windows: rows of public.receipt_vendors { vendor_key, display_name,
   return_days, notes }. A window applies to a receipt when its key is the
   receipt's vendorKey or a whole-word prefix of it — "home depot" covers
   "home depot pro" and "home depot 1234" — and the longest key wins. */
export function windowFor(windows, vkey) {
  let best = null;
  for (const w of windows || []) {
    const k = w && w.vendor_key;
    if (!k || !(vkey === k || String(vkey).startsWith(k + " "))) continue;
    if (!best || k.length > best.vendor_key.length) best = w;
  }
  return best;
}

/** Vendors seen on purchase receipts, biggest spend first:
    [{ key, label, count, total, own, covering }]. */
export function vendorGroups(entries, windows = []) {
  const map = new Map();
  for (const e of entries) {
    if (e.kind !== "purchase" || e.vkey === "unknown") continue;
    let g = map.get(e.vkey);
    if (!g) { g = { key: e.vkey, names: new Map(), count: 0, total: 0 }; map.set(e.vkey, g); }
    g.count++; g.total = r2(g.total + e.amount);
    if (e.vendor) g.names.set(e.vendor, (g.names.get(e.vendor) || 0) + 1);
  }
  return [...map.values()].map((g) => {
    const own = (windows || []).find((w) => w.vendor_key === g.key) || null;
    const covering = own ? null : windowFor(windows, g.key);
    const label = (own && own.display_name) || [...g.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || g.key;
    return { key: g.key, label, count: g.count, total: g.total, own, covering };
  }).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/* ---------- the return-window flag ----------
   "Bought here, the window is closing, nothing returned or cleared yet —
   anything left over?" Nothing tracks which items were used, so the flag
   asks rather than claims. Only receipts worth a trip: materials, $50 or
   more. A receipt stops flagging once any return points at it, or the office
   cleared it ("Nothing left over"), or the window closed. */
export const FLAG_MIN = 50;
export const leadDays = (days) => (days >= 28 ? 14 : Math.floor(days / 2));

export function returnFlags(entries, windows, reviews, today) {
  const cleared = new Set((reviews || []).filter((v) => v && v.status === "nothing_to_return")
    .map((v) => v.job_id + "|" + v.receipt_id));
  const groups = new Map();
  for (const e of entries || []) {
    if (e.kind !== "purchase" || e.category !== "materials" || !(e.amount >= FLAG_MIN)) continue;
    if (e.returnIds.length || cleared.has(e.jobId + "|" + e.id) || !validISO(e.date)) continue;
    const w = windowFor(windows, e.vkey);
    if (!w || !(Number(w.return_days) > 0)) continue;
    const days = Number(w.return_days);
    const closes = addDaysISO(e.date, days);
    const left = daysBetween(today, closes);
    if (left < 0 || left > leadDays(days)) continue;
    const key = e.jobId + "|" + w.vendor_key;
    let g = groups.get(key);
    if (!g) {
      g = { key, jobId: e.jobId, job: e.job, vendorKey: w.vendor_key, vendor: w.display_name || e.vendor || w.vendor_key,
        days, receipts: [], total: 0, left, closes };
      groups.set(key, g);
    }
    g.receipts.push({ id: e.id, vendor: e.vendor, date: e.date, amount: e.amount, items: e.items.length, closes, left });
    g.total = r2(g.total + e.amount);
    if (left < g.left) { g.left = left; g.closes = closes; }
  }
  for (const g of groups.values()) g.receipts.sort((a, b) => a.left - b.left || b.amount - a.amount);
  return [...groups.values()].sort((a, b) => a.left - b.left || b.total - a.total);
}
export const daysLeftText = (n) => (n === 0 ? "closes today" : n === 1 ? "closes tomorrow" : `closes in ${n} days`);

/* ---------- the return form ---------- */
/** Purchase receipts a return can draw from: the starting one, then the same
    job's other purchases from the same store (either key a prefix of the
    other), newest first. `include`: receipts a return being changed already
    draws from, kept even if their store name was retyped since. */
export function returnSources(entries, jobId, startId, include = []) {
  const start = entries.find((e) => e.jobId === jobId && e.id === startId && e.kind === "purchase");
  if (!start) return [];
  const keep = new Set(include);
  const related = (k) => k === start.vkey || k.startsWith(start.vkey + " ") || start.vkey.startsWith(k + " ");
  const others = entries.filter((e) => e.jobId === jobId && e.kind === "purchase" && e.id !== start.id &&
    e.amount > 0 && ((e.vkey !== "unknown" && related(e.vkey)) || keep.has(e.id))).sort(byNewest);
  return [start, ...others];
}
export const remainingQty = (e, it) => Math.max(0, it.qty - ((e.returnedQty && e.returnedQty[it.id]) || 0));
export const refundLeft = (e) => Math.max(0, r2(e.amount - e.returned));
const taxRate = (e) => (e.tax > 0 && e.subtotal > 0 ? e.tax / e.subtotal : 0);

/** Σ qty × unit price, plus the receipt's own tax share when it printed both. */
export function prefillRefund(picks, sourcesById) {
  let sum = 0;
  for (const pk of picks || []) {
    const e = sourcesById.get(pk.receiptId);
    const it = e && e.items.find((x) => x.id === pk.itemId);
    if (!it || !(pk.qty > 0)) continue;
    sum += pk.qty * Math.abs(it.price) * (1 + taxRate(e));
  }
  return r2(sum);
}

/** The receipts a return books against: those its picked items came from,
    or the starting receipt for a refund with no items picked
    (buildReturnCredit and creditShares book it the same way). */
export function returnTargets(returnOf, picks) {
  const ids = new Set((picks || []).filter((pk) => pk.qty > 0).map((pk) => pk.receiptId));
  return ids.size ? [...ids] : [returnOf];
}
/** The most a return booked against `targets` can refund without "store
    credit or exchange" ticked. */
export const refundCap = (entries, jobId, targets) => r2(targets.reduce((a, id) => {
  const e = entries.find((x) => x.jobId === jobId && x.id === id && x.kind === "purchase");
  return a + (e ? refundLeft(e) : 0);
}, 0));

/** null when the return may be saved, else the reason, checked against the
    FRESH copy of the job (entries rebuilt from it just before saving). */
export function checkReturn({ entries, jobId, returnOf, picks, refund, over }) {
  const byId = new Map(entries.filter((e) => e.jobId === jobId && e.kind === "purchase").map((e) => [e.id, e]));
  const start = byId.get(returnOf);
  if (!start) return "That receipt is no longer on the job (deleted on another device?).";
  if (!(start.amount > 0)) return "This receipt has no total yet. Add its total first.";
  if (!(refund > 0)) return "Enter the refund from the slip.";
  for (const pk of picks || []) {
    if (!(pk.qty > 0)) continue;
    const e = byId.get(pk.receiptId);
    const it = e && e.items.find((x) => x.id === pk.itemId);
    if (!it) return "An item you picked is no longer on its receipt. Reopen the form.";
    if (pk.qty > remainingQty(e, it) + 1e-9) return `Only ${fmtQty(remainingQty(e, it))} of “${it.desc}” is left to return.`;
  }
  // the room is on the receipts the refund is booked against, not the one the form started from
  const involved = returnTargets(returnOf, picks);
  const cap = refundCap(entries, jobId, involved);
  if (!over && refund > cap + 0.05) return `The refund is more than what's left on ${involved.length > 1 ? "those receipts" : "the receipt"} (${fmtMoney(cap)}). Tick "store credit or exchange" if that's right.`;
  return null;
}
export const fmtQty = (n) => String(r2(n));

/** The credit element. `id` is minted when the form opens (a new return) or
    derived from the return it replaces (successorId on the same receipts,
    movedId onto others), so a double tap or a retry saves the same return,
    never two. returnOf is the receipt the items came from
    (the starting one when it has picks, or nothing is picked). */
export function buildReturnCredit({ id, start, sources, picks, refund, date, slipNo, note, photo, extraPages, by, nowISO }) {
  const byId = new Map((sources || [start]).map((e) => [e.id, e]));
  const lines = [];
  for (const pk of picks || []) {
    const e = byId.get(pk.receiptId);
    const it = e && e.items.find((x) => x.id === pk.itemId);
    if (!it || !(pk.qty > 0)) continue;
    lines.push({ id: `${id}-${lines.length + 1}`, of: it.id, ofReceipt: e.id, desc: it.desc, qty: fmtQty(pk.qty),
      unit: it.unit, price: negMoney(it.price), sku: it.sku });
  }
  const from = lines.some((l) => l.ofReceipt === start.id) || !lines.length ? start : byId.get(lines[0].ofReceipt);
  const others = new Set(lines.map((l) => l.ofReceipt).filter((rid) => rid !== from.id)).size;
  const what = `↩ Return of ${from.vendor || "the"} ${from.date || ""} receipt${from.receiptNo ? " #" + from.receiptNo : ""}`
    .replace(/\s+/g, " ") + (others ? ` (+${others} more receipt${others === 1 ? "" : "s"})` : "");
  const n = String(note || "").trim();
  return {
    id, kind: "return", returnOf: from.id, by: by || "", createdAt: nowISO,
    vendor: from.vendor, date: validISO(date) ? date : "",
    amount: negMoney(refund), subtotal: "", tax: "",
    category: from.category, paidWith: from.paidWith || "", cardLast4: from.cardLast4 || "",
    receiptNo: String(slipNo || "").trim().slice(0, 40),
    notes: (what + (n ? " — " + n : "")).slice(0, 400),
    photo: photo || "", extraPages: Array.isArray(extraPages) ? extraPages.filter(Boolean).slice(0, 3) : [],
    items: lines, ai: null,
  };
}

/** Receipts on the same job that look like a return slip someone snapped as
    a receipt (no usable total) — the form can take one's photo and drop it. */
export const slipCandidates = (entries, jobId) =>
  entries.filter((e) => e.jobId === jobId && needsTotal(e) && e.hasPhoto).sort(byNewest);

/* ---------- a return slip snapped on a phone ----------
   At the counter the crew snaps the return slip like any receipt. A slip
   never lands as a cost: the reader keeps a credit's total off `amount`
   (applyReceiptRead takes money > 0 only), so it sits on the job as a $0
   receipt. The phone then offers to log it as a return of the purchase it
   came from: the same credit the office form builds (buildReturnCredit),
   and the slip folds into it, as when the office picks a crew slip.
   These read the RAW receipt element (the phone has it), not an index entry. */
const slipItems = (r) => (r && Array.isArray(r.items) ? r.items : []).filter((it) => it && typeof it === "object" && String(it.desc || "").trim());
const markedReturn = (r) => !!(r && r.ai && r.ai.isReturn === true);

/** A receipt that is really a return slip waiting to be logged: no total
    yet, and either the AI read it as a return or every priced line on it is
    a credit (a negative price). */
export function isSlip(r) {
  if (!r || isReturn(r) || amountNum(r.amount) > 0) return false;
  if (markedReturn(r)) return true;
  const priced = slipItems(r).filter((it) => amountNum(it.price) !== 0);
  return priced.length > 0 && priced.every((it) => amountNum(it.price) < 0);
}

/** What the slip takes back, as positive numbers: its credit lines, or every
    priced line when the AI marked the whole slip a return and the lines
    came out positive. [{ desc, sku, qty, price }] */
export function slipLines(r) {
  const all = slipItems(r).map((it) => ({ desc: String(it.desc).trim(), sku: String(it.sku || "").trim(),
    qty: Math.abs(amountNum(it.qty)) || 1, price: amountNum(it.price) }));
  const credits = all.filter((it) => it.price < 0);
  const use = credits.length ? credits : markedReturn(r) ? all.filter((it) => it.price > 0) : [];
  return use.map((it) => ({ ...it, price: r2(Math.abs(it.price)) }));
}

/** The refund the slip prints: the AI's read of its total when it gave one
    (ai.refund), else its lines; 0 when neither (the crew types it). */
export function slipRefund(r) {
  const printed = r && r.ai ? Math.abs(amountNum(r.ai.refund)) : 0;
  if (printed > 0) return r2(printed);
  return r2(slipLines(r).reduce((a, it) => a + it.qty * it.price, 0));
}

/* Levenshtein distance, for a misread digit or letter on a short code
   ("7066665392" for invoice 700665392, "JSD24SM" for SKU ISD24SM). Codes
   longer than 40 characters are never compared. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length > 40 || b.length > 40) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const codeKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const near = (a, b) => { const x = codeKey(a), y = codeKey(b); return x.length >= 5 && y.length >= 5 && editDistance(x, y) <= 1; };
const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w)));

/* How well a slip line names a purchase item: 0 is no match. A SKU equal
   or one character off, the same unit price, the same words. */
function lineScore(ln, it) {
  let s = 0;
  if (ln.sku && it.sku) s += codeKey(ln.sku) === codeKey(it.sku) ? 3 : near(ln.sku, it.sku) ? 2 : 0;
  if (ln.price > 0 && Math.abs(ln.price - it.price) <= 0.01) s += 2;
  const a = words(ln.desc), b = words(it.desc);
  if (a.size && b.size && [...a].filter((w) => b.has(w)).length * 2 >= Math.min(a.size, b.size)) s += 1;
  return s >= 2 ? s : 0;
}

/** The job's purchases this slip could return, best match first, each with
    the item quantities its lines point at:
      [{ id, score, picks: [{ receiptId, itemId, qty }] }]
    Only purchases on the same job with money left to return. A purchase
    scores for the same store, for each slip line that names one of its
    items (each item taken once, never past what is left of it), and for a
    number on the slip (its # or the AI's notes) that is the purchase's
    receipt # or one digit off it: a return slip often prints the original
    invoice #. Score 0 means nothing on the slip pointed at it. */
export function slipMatches(entries, jobId, r) {
  const lines = slipLines(r);
  const vkey = vendorKey(r && r.vendor);
  const nums = [...new Set((String((r && r.receiptNo) || "") + " " + String((r && r.notes) || "")).match(/[0-9][0-9-]{4,}[0-9]/g) || [])];
  const out = [];
  for (const e of entries) {
    if (e.jobId !== jobId || e.kind !== "purchase" || e.id === String(r && r.id) || !(e.amount > 0) || !(refundLeft(e) > 0)) continue;
    let score = 0;
    if (vkey !== "unknown" && e.vkey !== "unknown" && (vkey === e.vkey || vkey.startsWith(e.vkey + " ") || e.vkey.startsWith(vkey + " "))) score += 2;
    if (e.receiptNo && nums.some((n) => codeKey(n) === codeKey(e.receiptNo) || near(n, e.receiptNo))) score += 3;
    const used = new Set(), picks = [];
    for (const ln of lines) {
      let best = null, bestS = 0;
      for (const it of e.items) {
        if (!(it.price > 0) || used.has(it.id) || !(remainingQty(e, it) > 0)) continue;
        const s = lineScore(ln, it);
        if (s > bestS) { best = it; bestS = s; }
      }
      if (!best) continue;
      used.add(best.id);
      score += bestS;
      picks.push({ receiptId: e.id, itemId: best.id, qty: Math.min(ln.qty, remainingQty(e, best)) });
    }
    out.push({ id: e.id, score, picks });
  }
  const at = new Map(entries.filter((e) => e.jobId === jobId).map((e) => [e.id, e]));
  return out.sort((a, b) => b.score - a.score || byNewest(at.get(a.id), at.get(b.id)));
}

/* ---------- a return's identity across changes ----------
   Changing a return replaces it with a new element (the old id is
   tombstoned). A change that stays on the same receipts gets a DERIVED id —
   "c7k2" → "c7k2~1" → "c7k2~2" — so two devices changing the same return at
   once write the same id and sync keeps one, and a delete can tombstone the
   next few ids too, so a change made on another device before it heard of
   the delete can't bring the return back. A change that moves the return
   onto other receipts gets a MOVED id instead — "c7k2" → "c7k2~m1" →
   "c7k2~m2" — also derived, so two devices making a move write one id, but
   outside returnLineage: every "~n" id is booked on exactly the receipts of
   the return it came from, so deleting a receipt from an older copy
   (deletePlan) takes the "~n" ids of the returns it sees there and never a
   return that has moved off. The office's delete closes both (returnFamily). */
const GEN = /^(.*)~(\d+)$/;
export function successorId(id) {
  const m = GEN.exec(String(id));
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${id}~1`;
}
/** The ids a delete tombstones: the return's own, then its next `n`. */
export function returnLineage(id, n = 3) {
  const out = [String(id)];
  while (out.length <= n) out.push(successorId(out[out.length - 1]));
  return out;
}
const MOVED = /^(.*)~m(\d+)$/;
/** The id a change that moves the return onto other receipts takes. */
export function movedId(id) {
  const m = MOVED.exec(String(id));
  return m ? `${m[1]}~m${Number(m[2]) + 1}` : `${id}~m1`;
}
/** What the office's delete closes: the lineage and the moved id of each. */
export function returnFamily(id) {
  const line = returnLineage(id);
  return [...line, ...line.map(movedId)];
}

/** What deleting a purchase receipt takes with it (the phone's 🗑):
    { kill: ids to remove and tombstone, returns: how many returns go too }
    or { refuse: why }. A return booked only against this receipt goes with
    it (a credit with no receipt would sit on the job total unexplained); one
    that also covers another receipt is the office's to change first. */
export function deletePlan(project, receiptId) {
  const entries = buildIndex([project]);
  const credits = entries.filter((c) => c.kind === "return" && c.targets.includes(receiptId));
  if (credits.some((c) => c.targets.some((t) => t !== receiptId))) {
    return { refuse: "This receipt is part of a return the office logged that also covers another receipt. Ask the office to change that return first." };
  }
  return { kill: [String(receiptId), ...credits.flatMap((c) => returnLineage(c.id))], returns: credits.length };
}

/** updatedAt for an append-only office write (a new credit, a tombstone):
    one millisecond past the copy it was made from, so on any merge the
    office's possibly-stale copy of every OTHER element loses to the crew's,
    while new ids still union in and tombstones still bind (merge.js). */
export const nextStamp = (prev) => new Date((Date.parse(prev) || 0) + 1).toISOString();

export { fmtMoney };
