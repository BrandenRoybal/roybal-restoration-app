/* ============================================================
   Office Admin — financial confirm-chip executors (Section 1)
   ------------------------------------------------------------
   estimateWrite / invoiceCreate / invoiceStatusUpdate /
   changeOrderWrite / receiptLog. These are the office's ONLY
   write path into job records, and every one runs strictly
   behind a human tap on a chip that names exactly what it will
   do. Records reuse the field app's own factories (model.js) so
   everything a chip writes opens normally in the field editors,
   totals math rides fincalc.js (editor-parity), and saves go
   through the shared Store — the same sync engine the field app
   uses pushes them to field_projects.
   ============================================================ */
import { Store, uid, todayISO } from "../../js/core.js";
import { newInvoice, newReconEstimate, newChangeOrder, blankLineItem, CHANGE_REASONS } from "../../js/model.js";
import {
  invoiceTotals, money, budgetStatus, hasSubcontractorDocs,
  ESTIMATE_STATUSES, INVOICE_STATUSES, LINE_TYPES,
} from "../../js/fincalc.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoOr = (v) => (ISO.test(String(v || "")) ? String(v) : "");
const jobLabel = (p) => p.customer || p.address || "job";

/* match exactly one shared-store project by id, claim number, or
   customer/address fragment (exact customer hit beats ambiguity) */
export async function findProjectWide(q) {
  const needle = String(q || "").trim();
  if (!needle) return { err: "which job? none named" };
  const all = await Store.all().catch(() => []);
  const byId = all.find((p) => p.id === needle);
  if (byId) return { hit: byId };
  const lower = needle.toLowerCase();
  const hits = all.filter((p) =>
    `${p.customer || ""} ${p.address || ""} ${p.claimNo || ""}`.toLowerCase().includes(lower));
  if (!hits.length) return { err: `no job matches “${q}”` };
  if (hits.length > 1) {
    const exact = hits.filter((p) =>
      String(p.customer || "").toLowerCase() === lower || String(p.claimNo || "").toLowerCase() === lower);
    if (exact.length === 1) return { hit: exact[0] };
    return { err: `${hits.length} jobs match “${q}” — be more specific` };
  }
  return { hit: hits[0] };
}

/* spec line items → the editor's item shape; category/basis ride along
   as extra keys the editors preserve but don't render */
function mapLineItems(lineItems) {
  if (!Array.isArray(lineItems) || !lineItems.length) return { err: "lineItems must be a non-empty array" };
  const items = [];
  for (const li of lineItems) {
    const desc = String((li && li.description) || "").trim();
    const qty = Number(li && li.quantity);
    const price = Number(li && li.unitPrice);
    if (!desc) return { err: "every line item needs a description" };
    if (!(qty > 0)) return { err: `“${desc.slice(0, 40)}”: quantity must be > 0` };
    if (!Number.isFinite(price)) return { err: `“${desc.slice(0, 40)}”: unitPrice must be a number (negative = credit)` };
    const type = li && li.type ? String(li.type) : "";
    if (type && !LINE_TYPES.includes(type)) return { err: `line type must be one of ${LINE_TYPES.join(" / ")}` };
    items.push({
      ...blankLineItem(), desc, qty: String(qty), unit: String((li && li.unit) || "EA"), price: String(price),
      ...(li && li.category ? { category: String(li.category).toUpperCase().slice(0, 6) } : {}),
      ...(type ? { basis: type } : {}),
    });
  }
  return { items };
}

const totalsLine = (t) =>
  `lines ${money(t.subtotal)}${t.overhead || t.profit ? ` + O&P ${money(t.overhead + t.profit)}` : ""}` +
  `${t.tax ? ` + tax ${money(t.tax)}` : ""} = ${money(t.total)}`;

/* ---- estimateWrite: create or update a reconstruction estimate ---- */
async function estimateWrite(params) {
  const m = await findProjectWide(params.job ?? params.jobId);
  if (m.err) return { ok: false, detail: m.err };
  const p = m.hit;
  p.reconEstimates = p.reconEstimates || [];
  const status = params.status ? String(params.status) : "";
  if (status && !ESTIMATE_STATUSES.includes(status))
    return { ok: false, detail: `status must be one of ${ESTIMATE_STATUSES.join(" / ")}` };

  let est, created = false;
  if (params.estimateId) {
    est = p.reconEstimates.find((e) => e && (e.id === params.estimateId || e.invoiceNo === params.estimateId));
    if (!est) return { ok: false, detail: `no estimate “${params.estimateId}” on ${jobLabel(p)}` };
  } else {
    est = newReconEstimate();
    est.invoiceNo = `EST-${p.reconEstimates.length + 1}`;
    // apply the GC O&P rule EXPLICITLY (the editor's opAuto would silently
    // rewrite factory 10&10 to 0/0 on open for self-performed jobs — the
    // chip's confirmed total must be the total the editor shows)
    est.opAuto = false;
    const gcOP = hasSubcontractorDocs(p) ? "10" : "0";
    est.overheadPct = gcOP;
    est.profitPct = gcOP;
    p.reconEstimates.push(est);
    created = true;
  }
  if (params.lineItems != null || created) {
    const r = mapLineItems(params.lineItems);
    if (r.err) return { ok: false, detail: r.err };
    est.items = r.items;
  }
  if (params.notes) est.notes = est.notes ? `${est.notes}\n${String(params.notes).slice(0, 400)}` : String(params.notes).slice(0, 400);
  if (status) est.status = status;
  else if (created && !est.status) est.status = "draft";

  await Store.put(p);
  const t = invoiceTotals(est);
  return {
    ok: true,
    detail: `${est.invoiceNo} ${created ? "created" : "updated"} (${est.status}) — total ${money(t.total)}`,
    message: `🧮 ${jobLabel(p)} — estimate ${est.invoiceNo} (${est.status})\n` +
      `${est.items.length} line item${est.items.length === 1 ? "" : "s"} · ${totalsLine(t)}\n` +
      `Open it in the field app's Reconstruction Estimate form to review or send.`,
  };
}

/* ---- invoiceCreate: from an APPROVED estimate ---- */
async function invoiceCreate(params) {
  const m = await findProjectWide(params.job ?? params.jobId);
  if (m.err) return { ok: false, detail: m.err };
  const p = m.hit;
  const est = (p.reconEstimates || []).find((e) => e && (e.id === params.estimateId || e.invoiceNo === params.estimateId));
  if (!est) return { ok: false, detail: `no estimate “${params.estimateId || "?"}” on ${jobLabel(p)}` };
  if (est.status !== "approved")
    return { ok: false, detail: `${est.invoiceNo || "that estimate"} is ${est.status || "draft"} — only an approved estimate can be invoiced` };
  const invoiceDate = isoOr(params.invoiceDate);
  const dueDate = isoOr(params.dueDate);
  if (!invoiceDate || !dueDate) return { ok: false, detail: "invoiceDate and dueDate must be YYYY-MM-DD dates" };
  const billedTo = String(params.billedTo || "").trim();
  if (!billedTo) return { ok: false, detail: "billedTo is required (customer, carrier, or entity)" };

  p.invoices = p.invoices || [];
  const inv = newInvoice();
  inv.invoiceNo = `INV-${p.invoices.length + 1}`;
  inv.invoiceDate = invoiceDate;
  inv.dueDate = dueDate;
  inv.items = est.items.map((it) => ({ ...it }));
  inv.opMode = est.opMode; inv.opAuto = false;               // carry the estimate's O&P verbatim
  inv.overheadPct = est.overheadPct; inv.profitPct = est.profitPct;
  inv.overheadAmount = est.overheadAmount; inv.profitAmount = est.profitAmount;
  inv.taxRate = est.taxRate;
  inv.deductible = est.deductible;           // the approved figure was net of it
  inv.lossSummary = est.lossSummary;
  inv.billedTo = billedTo;                                   // additive — shown here + in notes
  inv.estimateId = est.id;
  inv.notes = [`Billed to: ${billedTo}`, `From approved estimate ${est.invoiceNo || est.id}`,
    String(params.notes || "").slice(0, 300)].filter(Boolean).join("\n");
  p.invoices.push(inv);
  await Store.put(p);
  const t = invoiceTotals(inv);
  return {
    ok: true,
    detail: `${inv.invoiceNo} created — ${money(t.total)} due ${dueDate}`,
    message: `🧾 ${jobLabel(p)} — invoice ${inv.invoiceNo} from ${est.invoiceNo}\n` +
      `Billed to ${billedTo} · ${totalsLine(t)} · due ${dueDate}\n` +
      `Push to QuickBooks from the invoice editor when ready.`,
  };
}

/* ---- invoiceStatusUpdate: lifecycle + payments + running balance ----
   Addressed by invoice number; per-job numbering (INV-n) collides across
   jobs, so an optional `job` param scopes the search and the ambiguity
   error says exactly how to retry. */
async function invoiceStatusUpdate(params) {
  const status = String(params.status || "");
  if (!INVOICE_STATUSES.includes(status))
    return { ok: false, detail: `status must be one of ${INVOICE_STATUSES.join(" / ")}` };
  const key = String(params.invoiceId || "").trim();
  if (!key) return { ok: false, detail: "which invoice? give invoiceId or the invoice number" };
  if (params.paymentDate && !isoOr(params.paymentDate))
    return { ok: false, detail: "paymentDate must be a YYYY-MM-DD date" };

  let pool;
  if (params.job) {
    const m = await findProjectWide(params.job);
    if (m.err) return { ok: false, detail: m.err };
    pool = [m.hit];
  } else {
    pool = await Store.all().catch(() => []);
  }
  const hits = [];
  for (const p of pool)
    for (const inv of p.invoices || [])
      if (inv && (inv.id === key || inv.invoiceNo === key || inv.qboDocNumber === key)) hits.push({ p, inv });
  if (!hits.length) return { ok: false, detail: `no invoice matches “${key}”${params.job ? ` on ${jobLabel(pool[0])}` : ""}` };
  if (hits.length > 1)
    return { ok: false, detail: `“${key}” exists on ${hits.map((h) => jobLabel(h.p)).join(" and ")} — retry with job: "<customer>"` };
  const { p, inv } = hits[0];

  const amount = params.amountReceived != null && params.amountReceived !== "" ? Number(params.amountReceived) : null;
  if (status === "partially_paid" && !(amount > 0))
    return { ok: false, detail: "partially_paid needs amountReceived > 0" };
  if (amount != null && !(amount > 0)) return { ok: false, detail: "amountReceived must be > 0" };
  if (amount != null) {
    const owing = invoiceTotals(inv).total;
    if (amount > owing + 0.005)
      return { ok: false, detail: `payment ${money(amount)} exceeds the ${money(owing)} balance on ${inv.invoiceNo || "that invoice"}` };
  }

  inv.status = status;
  if (amount != null) {
    inv.payments = inv.payments || [];
    inv.payments.push({
      amount, date: isoOr(params.paymentDate) || todayISO(),
      method: String(params.paymentMethod || "").slice(0, 30),
      ...(params.notes ? { notes: String(params.notes).slice(0, 200) } : {}),
    });
    // previousPayments feeds the editor's total math — the balance stays
    // honest there too (rounded to cents so floats never leave artifacts)
    inv.previousPayments = String(Math.round(((Number(inv.previousPayments) || 0) + amount) * 100) / 100);
  } else if (params.notes) {
    const line = `[${todayISO()}] ${String(params.notes).slice(0, 200)}`;
    inv.notes = inv.notes ? `${inv.notes}\n${line}` : line;
  }
  await Store.put(p);
  const balance = invoiceTotals(inv).total;
  return {
    ok: true,
    detail: `${inv.invoiceNo || "invoice"} → ${status}${amount ? ` (+${money(amount)})` : ""} · balance ${money(balance)}`,
    message: `💵 ${jobLabel(p)} — ${inv.invoiceNo || "invoice"} marked ${status.replace("_", " ")}` +
      `${amount ? `\nPayment ${money(amount)}${params.paymentMethod ? ` by ${params.paymentMethod}` : ""} recorded` : ""}` +
      `\nRunning balance: ${money(balance)}${status === "paid" && balance > 0.005 ? " — note: balance isn't zero; log the payment amount if one arrived" : ""}`,
  };
}

/* ---- changeOrderWrite: scope change with reason + cost delta ---- */
async function changeOrderWrite(params) {
  const m = await findProjectWide(params.job ?? params.jobId);
  if (m.err) return { ok: false, detail: m.err };
  const p = m.hit;
  const description = String(params.description || "").trim();
  const reason = String(params.reason || "").trim();
  if (!description || !reason) return { ok: false, detail: "a change order needs both description and reason" };
  const approval = params.approvalStatus ? String(params.approvalStatus) : "";
  if (approval && !["pending", "approved", "rejected"].includes(approval))
    return { ok: false, detail: "approvalStatus must be pending / approved / rejected" };
  const delta = Number(params.costDelta);
  if (!Number.isFinite(delta)) return { ok: false, detail: "costDelta must be a number (negative for credits)" };

  p.changeOrders = p.changeOrders || [];
  let co, created = false;
  if (params.changeOrderId) {
    co = p.changeOrders.find((c) => c && (c.id === params.changeOrderId || c.coNo === params.changeOrderId));
    if (!co) return { ok: false, detail: `no change order “${params.changeOrderId}” on ${jobLabel(p)}` };
  } else {
    co = newChangeOrder();
    co.coNo = `CO-${p.changeOrders.length + 1}`;
    p.changeOrders.push(co);
    created = true;
  }
  // tick the matching standard reason checkbox — the editor keys the boxes
  // by CHANGE_REASONS INDEX (formkit check()), not by label. An unmatched
  // reason rides the description so the signed/printed CO always shows it.
  const idx = CHANGE_REASONS.findIndex((r) => r.toLowerCase().includes(reason.toLowerCase()) || reason.toLowerCase().includes(r.toLowerCase().split(" ")[0]));
  if (idx >= 0) co.reasons = { ...(co.reasons || {}), [idx]: true };
  co.description = idx >= 0 ? description : `Reason: ${reason.slice(0, 120)}\n${description}`;
  const match = idx >= 0 ? CHANGE_REASONS[idx] : null;
  if (params.lineItems != null) {
    const r = mapLineItems(params.lineItems);
    if (r.err) return { ok: false, detail: r.err };
    co.items = r.items;
  } else if (created) {
    co.items = [{ ...blankLineItem(), desc: description.slice(0, 120), qty: "1", unit: "EA", price: String(delta) }];
  }
  co.costDelta = delta;
  if (approval) co.approvalStatus = approval;
  else if (created && !co.approvalStatus) co.approvalStatus = "pending";
  await Store.put(p);

  const itemsSum = (co.items || []).reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
  const drift = Math.abs(itemsSum - delta) > Math.max(1, Math.abs(delta) * 0.01);
  return {
    ok: true,
    detail: `${co.coNo} ${created ? "created" : "updated"} (${co.approvalStatus}) — ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}`,
    message: `🔁 ${jobLabel(p)} — change order ${co.coNo} (${co.approvalStatus})\n${description.slice(0, 200)}\n` +
      `Reason: ${match || reason} · cost delta ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}` +
      `${drift ? `\n⚠ line items total ${money(itemsSum)} ≠ costDelta — double-check before sending` : ""}\n` +
      `Signatures still happen in the field app's Change Order form.`,
  };
}

/* ---- receiptLog: job-level cost entry (feeds the budget flag) ---- */
async function receiptLog(params) {
  const m = await findProjectWide(params.job ?? params.jobId);
  if (m.err) return { ok: false, detail: m.err };
  const p = m.hit;
  const vendor = String(params.vendor || "").trim();
  const amount = Number(params.amount);
  if (!vendor) return { ok: false, detail: "vendor is required" };
  if (!(amount > 0)) return { ok: false, detail: "amount must be > 0" };
  if (params.date && !isoOr(params.date)) return { ok: false, detail: "date must be a YYYY-MM-DD date" };
  p.receipts = p.receipts || [];
  p.receipts.push({
    id: uid(), vendor: vendor.slice(0, 80), amount,
    category: String(params.category || "").slice(0, 40),
    date: isoOr(params.date) || todayISO(),
    notes: String(params.notes || "").slice(0, 200),
    loggedBy: "office-assistant", at: new Date().toISOString(),
  });
  await Store.put(p);
  const b = budgetStatus(p);
  return {
    ok: true,
    detail: `${money(amount)} — ${vendor} on ${jobLabel(p)}${b ? ` · costs ${b.pct}% of budget` : ""}`,
    message: `🛒 ${jobLabel(p)} — receipt logged: ${vendor} ${money(amount)}` +
      `${params.category ? ` (${params.category})` : ""}` +
      `${b ? `\nLogged costs ${money(b.costs)} = ${b.pct}% of the ${money(b.base)} budget${b.over ? " — ⚠ OVER the alert threshold" : ""}` : "\nNo approved estimate or contract amount yet — no budget to compare against."}`,
  };
}

/** Dispatch for assistctx.js — returns undefined for kinds it doesn't own. */
export function runFinanceAction(a) {
  const p = (a && a.params) || {};
  switch (a && a.type) {
    case "estimateWrite": return estimateWrite(p);
    case "invoiceCreate": return invoiceCreate(p);
    case "invoiceStatusUpdate": return invoiceStatusUpdate(p);
    case "changeOrderWrite": return changeOrderWrite(p);
    case "receiptLog": return receiptLog(p);
    default: return undefined;
  }
}
