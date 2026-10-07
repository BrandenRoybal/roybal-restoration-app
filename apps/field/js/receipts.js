/* ============================================================
   Roybal Field Forms — 🧾 Receipts (job material costs)
   ------------------------------------------------------------
   The Receipts tile on every job: snap a receipt at the counter,
   the AI reads vendor / date / total / tax / card / receipt # and
   every line item, the crew member checks it and taps Done. The
   list shows the job's running cost total by category (materials,
   equipment rental, dump fees, other) and feeds the budget flag.

   Offline first, like every form: the photo and the typed fields
   save to the device at once; the AI read is an online-only
   enhancement (officeai.js) — with no signal the receipt keeps
   its photo and a "✨ Read receipt" button for later. Receipts
   live in project.receipts[] (merge.js unions them by id, media.js
   offloads the photo on sync); migration 0015 projects them into
   public.job_receipts for the office. Nothing here touches
   QuickBooks — that is the plan's phase 3.

   Returns (plan phase 2): each is its own element with kind "return"
   and a negative amount (a credit, receiptlib.js). The office logs one
   from the receipt it returns; here a return slip snapped at the counter
   (the AI reads it as one, or its lines are credits) offers "↩ Log as a
   return" and becomes the same credit, the slip folding into it. A credit
   is read-only here — a retake or a re-read would flip its sign or drop
   its links — and the receipt it returns carries a "↩ Returned" badge.
   ============================================================ */
import { h, Store, toast, fmtDate, money, fileToDataURL, todayISO } from "./core.js";
import { setCtx, commit, field, inp, ta, sel, seg, lineItems } from "./formkit.js";
import { newReceipt, blankLineItem, author } from "./model.js";
import { tombstoneItems } from "./merge.js";
import { aiAvailable, aiReady, readReceipt } from "./officeai.js";
import { isMediaMarker } from "./media.js";
import { fileToDocPages } from "./pdf.js";
import { budgetStatus } from "./fincalc.js";
import {
  RECEIPT_CATEGORIES, PAID_WITH, receiptCategory, receiptTotals, receiptAmount,
  itemsTotal, amountNum, applyReceiptRead,
} from "./receiptcalc.js";

/* receiptlib.js (the return badges, the delete cascade) loads on demand, not
   in the app's startup graph: a phone whose cache missed it still opens
   offline, just without the badges. These two are its isReturn and norm. */
const isReturn = (r) => !!r && r.kind === "return";
const norm = (s) => String(s ?? "").toLowerCase().replace(/["“”″'’`]/g, "").replace(/\s+/g, " ").trim();
let libLoad = null;
function receiptLib() {
  if (!libLoad) libLoad = import("./receiptlib.js").catch(() => { libLoad = null; return null; });
  return libLoad;
}

/* Receipts snapped a moment ago whose first AI read should fire as soon as
   the editor opens (the snap navigates there through the router, which
   can't carry a flag). */
const PENDING_READ = new Set();

/* A phone photo keeps enough pixels to read 7-pt thermal print at a returns
   counter months later (2000 px on the long edge ≈ 180 dpi on an 11" receipt);
   sync offloads it to the field-media bucket so the job row stays slim. */
const RECEIPT_MAX_DIM = 2000;
const RECEIPT_QUALITY = 0.8;
const MAX_PAGES = 4;   // pages of a PDF receipt the AI reads (page 1 + 3)

const listHash = (project) => `#/p/${project.id}/f/receipts`;
const editHash = (project, r) => `#/p/${project.id}/f/receipts/${r.id}`;

/** Router entry (app.js formPage): the list, or one receipt's editor.
    ctx = { view, setChrome } — the page shell app.js owns. */
export async function receiptsPage(project, instId, ctx) {
  if (!instId) return receiptsList(project, ctx);
  const r = project.receipts.find((x) => x && x.id === instId);
  if (!r) { location.hash = listHash(project); return; }
  if (isReturn(r)) return returnView(project, r, ctx);
  return receiptEditor(project, r, ctx);
}

/* ---------- capture ---------- */
async function fileToReceiptPages(f) {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
  if (isPdf) return fileToDocPages(f);
  return [await fileToDataURL(f, RECEIPT_MAX_DIM, RECEIPT_QUALITY)];
}

/** One receipt per file: the photo saves first (offline-safe), then the
    editor opens and the AI read fires if there's signal. */
async function addReceiptFiles(project, files) {
  let last = null;
  for (const f of files) {
    let pages;
    try { pages = await fileToReceiptPages(f); }
    catch { toast("Couldn't read " + (f.name || "that file") + " — try a photo or a PDF."); continue; }
    if (!pages.length) continue;
    const r = newReceipt();
    r.photo = pages[0];
    r.extraPages = pages.slice(1, MAX_PAGES);
    project.receipts.push(r);
    PENDING_READ.add(r.id);
    last = r;
  }
  if (!last) return;
  await Store.put(project);
  location.hash = editHash(project, last);
}

function captureInputs(project) {
  // capture="environment" opens the rear camera straight away on a phone; on
  // a desktop both are an ordinary file picker
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none" });
  const upload = h("input", { type: "file", accept: "image/*,application/pdf", multiple: true, style: "display:none" });
  const onPick = (input) => async () => {
    const files = [...input.files]; input.value = "";
    if (files.length) await addReceiptFiles(project, files);
  };
  camera.addEventListener("change", onPick(camera));
  upload.addEventListener("change", onPick(upload));
  return { camera, upload };
}

/* ---------- list ---------- */
function receiptsList(project, { view, setChrome }) {
  setChrome("Receipts", `#/p/${project.id}`);
  const body = view; body.replaceChildren();
  setCtx(project, null);
  const { camera, upload } = captureInputs(project);

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "🧾 Receipts"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => camera.click() }, "📷 Snap receipt")),
    h("p", { class: "subtle" }, "Every material, rental and dump receipt for this job. Snap it at the counter — the AI reads it, you check it."),
    totalsCard(project),
    h("div", { class: "btn-row", style: "margin:6px 0 12px;flex-wrap:wrap" },
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => upload.click() }, "📎 Upload photo / PDF"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => { const r = newReceipt(); project.receipts.push(r); Store.put(project).then(() => { location.hash = editHash(project, r); }); } }, "✎ Type one in")),
    camera, upload);

  if (!project.receipts.length) {
    body.append(h("div", { class: "empty" }, h("div", { class: "big" }, "🧾"),
      h("p", {}, "No receipts yet."),
      h("button", { class: "btn btn--primary", style: "max-width:260px;margin:8px auto 0", onclick: () => camera.click() }, "📷 Snap the first receipt")));
    return;
  }

  // filters: text over vendor / notes / line items, and one category
  let q = "", fCat = "";
  const search = h("input", { type: "search", placeholder: "Search vendor, item, receipt #…" });
  search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); paint(); });
  const catF = h("select", {}, h("option", { value: "" }, "All categories"),
    ...RECEIPT_CATEGORIES.map((c) => h("option", { value: c.value }, c.icon + " " + c.label)));
  catF.addEventListener("change", () => { fCat = catF.value; paint(); });
  body.append(h("div", { class: "filterbar" }, search, catF));

  const list = h("div", { class: "joblist" });
  body.append(list);

  // every word somewhere on the receipt: "3/4 plywood" finds 3/4" CDX plywood 4x8
  const hay = (r) => norm([r.vendor, r.notes, r.receiptNo, r.cardLast4, ...(r.items || []).map((it) => it && (it.desc + " " + (it.sku || "")))]
    .filter(Boolean).join(" "));
  const matches = (r) => norm(q).split(" ").filter(Boolean).every((w) => hay(r).includes(w));
  let state = new Map(), returnStatus = () => "", slip = () => false;
  receiptLib().then((lib) => {
    if (!lib || !list.isConnected) return;
    state = new Map(lib.buildIndex([project]).map((e) => [e.id, e]));
    returnStatus = lib.returnStatus;
    if (typeof lib.isSlip === "function") slip = lib.isSlip;
    paint();
  });
  function paint() {
    const rows = project.receipts.filter((r) => r && (!fCat || receiptCategory(r.category) === fCat) && (!q || matches(r)))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) {
      list.replaceChildren(h("div", { class: "empty" }, h("p", {}, "No receipts match.")));
      return;
    }
    list.replaceChildren(...rows.map((r) => {
      const cat = RECEIPT_CATEGORIES.find((c) => c.value === receiptCategory(r.category)) || RECEIPT_CATEGORIES[3];
      const n = (r.items || []).length;
      const sub = [fmtDate(r.date), cat.label, n ? `${n} item${n === 1 ? "" : "s"}` : "", r.cardLast4 ? "••" + r.cardLast4 : "", r.receiptNo ? "#" + r.receiptNo : ""]
        .filter(Boolean).join(" · ");
      const ret = isReturn(r);
      const isSlip = !ret && slip(r);
      const needs = !ret && !isSlip && (!receiptAmount(r) || !String(r.vendor || "").trim());
      const e = state.get(r.id);
      const st = returnStatus(e);
      const badges = [
        ret ? h("span", { class: "badge disp-b" }, "↩ Return") : null,
        isSlip ? h("span", { class: "badge", style: "background:var(--brand-tint);color:var(--brand-dark)" }, "↩ Return slip: tap to log it") : null,
        st ? h("span", { class: "badge disp-b" }, (st === "all" ? "↩ All returned " : "↩ Partly returned ") + money(-e.returned)) : null,
        needs ? h("span", { class: "badge", style: "background:var(--brand-tint);color:var(--brand-dark)" }, "Needs vendor / total") : null,
        r.ai && !ret ? h("span", { class: "badge" }, "✨ AI read") : null].filter(Boolean);
      return h("a", { class: "card card--tap citem", href: editHash(project, r) },
        thumbEl(r.photo, ret ? "↩" : cat.icon),
        h("div", { class: "jobrow__main" },
          h("div", { class: "jobrow__title" }, (String(r.vendor || "").trim() || "Unknown vendor") + " — " + money(receiptAmount(r))),
          h("div", { class: "jobrow__sub" }, sub),
          badges.length ? h("div", { class: "badgeline", style: "margin:4px 0 0" }, ...badges) : null),
        h("div", { class: "jobrow__chev" }, "›"));
    }));
  }
  paint();
}

function thumbEl(src, icon) {
  if (src && !isMediaMarker(src)) return h("img", { class: "cthumb", src, alt: "" });
  return h("div", { class: "cthumb cthumb--ph" }, src ? "☁️" : icon);
}

/** The running total: job total, one row per category with something in
    it, the budget line when the job has a budget, the top vendors. */
function totalsCard(project) {
  const t = receiptTotals(project);
  // a category holding only a return (its receipt deleted) still gets its row,
  // so "included above" is always true
  const rows = RECEIPT_CATEGORIES.filter((c) => t.byCategory[c.value].count || t.byCategory[c.value].total)
    .map((c) => h("div", { class: "trow" },
      h("span", {}, `${c.icon} ${c.label} `, t.byCategory[c.value].count ? h("span", { class: "subtle", style: "font-size:12px" }, `(${t.byCategory[c.value].count})`) : null),
      h("span", {}, money(t.byCategory[c.value].total))));
  if (t.returns) rows.push(h("div", { class: "trow" },
    h("span", {}, "↩ Returns (included above) ", h("span", { class: "subtle", style: "font-size:12px" }, `(${t.returns})`)),
    h("span", {}, money(t.credits))));
  const b = budgetStatus(project);
  const vendors = t.vendors.slice(0, 3).map((v) => `${v.vendor} ${money(v.total)}`).join(" · ");
  return h("div", { class: "card" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:10px" },
      h("strong", {}, "Job costs to date"),
      h("span", { style: "font-size:22px;font-weight:800" }, money(t.total))),
    rows.length ? h("div", { class: "totals", style: "margin-top:6px" }, ...rows) : null,
    b ? h("p", { class: "subtle", style: "margin:8px 0 0" + (b.over ? ";color:var(--red);font-weight:600" : "") },
      `${b.over ? "⚠ " : ""}${b.pct}% of the ${money(b.base)} budget`) : null,
    vendors ? h("p", { class: "subtle", style: "margin:6px 0 0;font-size:12px" }, "By vendor: " + vendors) : null);
}

/* ---------- editor ---------- */
function receiptEditor(project, r, ctx) {
  const { view, setChrome } = ctx;
  setChrome("Receipt", listHash(project), "Receipt — " + (r.vendor || "untitled"));
  const body = view; body.replaceChildren();
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);
  if (!Array.isArray(r.items)) r.items = [];
  if (!Array.isArray(r.extraPages)) r.extraPages = [];

  /* photo — "Retake" replaces THIS receipt's photo (a new receipt starts from the list) */
  const photoBox = h("div", { class: "card", style: "padding:8px" });
  const retake = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none" });
  retake.addEventListener("change", async () => {
    const f = retake.files[0]; retake.value = "";
    if (!f) return;
    try {
      const pages = await fileToReceiptPages(f);
      if (!pages.length) return;
      r.photo = pages[0]; r.extraPages = pages.slice(1, MAX_PAGES);
      await Store.put(project);
      paintPhoto();
      if (aiReady()) runRead({ overwrite: !!r.ai });
    } catch { toast("Couldn't read that file — try a photo or a PDF."); }
  });
  const readBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "✨ Read receipt");
  const readStatus = h("div", { class: "subtle", style: "font-size:12px;margin:6px 0 0" });
  function paintPhoto() {
    const pages = r.extraPages.length ? ` · ${1 + r.extraPages.length} pages` : "";
    const img = r.photo && !isMediaMarker(r.photo)
      ? h("img", { src: r.photo, alt: "Receipt", style: "display:block;max-width:100%;max-height:280px;margin:0 auto;border-radius:8px;cursor:zoom-in",
          onclick: () => lightbox(r.photo) })
      : h("div", { class: "empty", style: "padding:18px" }, h("div", { class: "big" }, r.photo ? "☁️" : "🧾"),
          h("p", {}, r.photo ? "Photo is in the cloud — it loads the next time this device syncs online." : "No photo yet."));
    photoBox.replaceChildren(img,
      h("div", { class: "btn-row", style: "margin-top:8px;flex-wrap:wrap" },
        h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => retake.click() }, r.photo ? "📷 Retake" : "📷 Snap photo"),
        readBtn),
      readStatus, retake);
    paintReadStatus();
  }
  function paintReadStatus() {
    readStatus.textContent = r.ai
      ? `✨ Read by AI ${fmtDate(String(r.ai.at || "").slice(0, 10))}` + (r.ai.confidence != null ? ` · confidence ${Math.round(r.ai.confidence * 100)}%` : "") + " — check it against the paper."
      : (r.photo ? "Not read yet — tap ✨ Read receipt (needs signal)." : "");
  }

  /* AI read: fills what's blank; a second read asks before overwriting */
  let reading = false;
  async function runRead({ overwrite = false } = {}) {
    if (reading) return;
    if (!r.photo) return toast("Snap the receipt first.");
    if (isMediaMarker(r.photo)) return toast("The photo hasn't loaded on this device yet — sync online first.");
    if (!aiAvailable()) return;
    if (overwrite && !confirm("Read it again and replace the vendor, total, items and the rest with what the AI reads?")) return;
    reading = true; readBtn.disabled = true; readBtn.textContent = "✨ Reading…";
    try {
      const read = await readReceipt(project, [r.photo, ...r.extraPages]);
      // the slip was logged as a return meanwhile: it is gone, nothing to land
      if (!project.receipts.includes(r)) { reading = false; return; }
      const changed = applyReceiptRead(r, read, { overwrite });
      r.ai = { at: new Date().toISOString(), model: read.model || "", confidence: typeof read.confidence === "number" ? read.confidence : null };
      // a return slip (receiptlib.js isSlip): the refund never lands on the
      // total, it waits here for "Log as a return"
      if (read.isReturn === true) { r.ai.isReturn = true; r.ai.refund = amountNum(read.refund) > 0 ? amountNum(read.refund) : null; }
      await Store.put(project);
      const priced = (Array.isArray(read.items) ? read.items : []).filter((it) => it && amountNum(it.price) !== 0);
      const slipRead = read.isReturn === true || (!(amountNum(read.total) > 0) && priced.length > 0 && priced.every((it) => amountNum(it.price) < 0));
      toast(slipRead && !(amountNum(r.amount) > 0) ? `Read a return slip from ${read.vendor || "the store"}. Tap ↩ Log as a return to take it off the job total.`
        : changed.length ? `Read ${read.vendor || "the receipt"} — ${money(amountNum(read.total))}. Check it, then Done.` : "Read it — nothing new to fill in.", 4000);
      // repaint every field with what landed — unless the editor is no longer
      // on screen (the return form opened over it): that form stays
      if (readBtn.isConnected) receiptEditor(project, r, ctx);
      return;
    } catch (e) {
      toast("Couldn't read the receipt — " + (e && e.message ? e.message : "try again"));
    }
    reading = false; readBtn.disabled = false; readBtn.textContent = "✨ Read receipt";
  }
  readBtn.addEventListener("click", () => runRead({ overwrite: !!r.ai }));
  paintPhoto();

  /* fields */
  const totalEl = h("span", { style: "font-weight:700" });
  const drift = h("div", { class: "subtle", style: "font-size:12px;margin:4px 0 0" });
  function paintTotals() {
    const sum = itemsTotal(r.items);
    const total = receiptAmount(r);
    totalEl.textContent = money(sum);
    const sub = amountNum(r.subtotal);
    // the printed total is what was paid; the lines are a reading check
    if (r.items.length && total > 0 && Math.abs((sub > 0 ? sub : total) - sum) > 1) {
      drift.textContent = `⚠ Line items add to ${money(sum)}, the receipt ${sub > 0 ? "subtotal" : "total"} is ${money(sub > 0 ? sub : total)} — a line may be misread.`;
      drift.style.color = "var(--red)";
    } else { drift.textContent = ""; }
  }
  const items = lineItems(r.items, blankLineItem, { onTotals: () => paintTotals() });

  // a return slip, or a receipt with no total that might be one: log it as a
  // return of the purchase it came from (receiptlib.js loads on demand)
  const slipBox = h("div");
  if (!(amountNum(r.amount) > 0)) receiptLib().then((lib) => {
    if (!lib || typeof lib.isSlip !== "function" || !slipBox.isConnected || amountNum(r.amount) > 0) return;
    const go = () => {
      if (reading) return toast("The AI is still reading it. One moment.");
      commit(); returnForm(project, r, ctx);
    };
    slipBox.replaceChildren(lib.isSlip(r)
      ? h("div", { class: "card", style: "border-left:4px solid var(--brand);margin-bottom:10px" },
          h("strong", {}, "↩ This is a return slip"),
          h("p", { class: "subtle", style: "margin:4px 0 8px" }, "Log it as a return of the receipt it came from, and the refund comes off this job's total."),
          h("button", { type: "button", class: "btn btn--primary btn--sm", onclick: go }, "↩ Log as a return"))
      : h("div", { style: "display:flex;align-items:center;gap:8px;margin:0 0 8px" },
          h("span", { class: "subtle", style: "font-size:13px" }, "A return slip?"),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto", onclick: go }, "↩ Log it as a return")));
  });

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "🧾 Receipt"), pill),
    slipBox,
    photoBox,
    h("div", { class: "grid2", style: "margin-top:12px" },
      field("Vendor", inp(r, "vendor", { placeholder: "Home Depot, Spenard, FNSB landfill…" })),
      field("Date", inp(r, "date", { type: "date" }))),
    h("div", { class: "grid3" },
      field("Total paid $", inp(r, "amount", { type: "number", inputmode: "decimal", attrs: { step: "0.01", min: "0" }, oninput: () => paintTotals() }), "the running job total"),
      field("Subtotal $", inp(r, "subtotal", { type: "number", inputmode: "decimal", attrs: { step: "0.01", min: "0" }, oninput: () => paintTotals() })),
      field("Tax $", inp(r, "tax", { type: "number", inputmode: "decimal", attrs: { step: "0.01", min: "0" } }))),
    field("Category", seg(r, "category", RECEIPT_CATEGORIES.map((c) => ({ value: c.value, label: c.icon + " " + c.label })))),
    h("div", { class: "grid3" },
      field("Paid with", sel(r, "paidWith", PAID_WITH, { placeholder: "—" })),
      field("Card last 4", inp(r, "cardLast4", { inputmode: "numeric", attrs: { maxlength: "4" }, placeholder: "4558" })),
      field("Receipt #", inp(r, "receiptNo", { placeholder: "from the paper" }))),
    h("h3", { style: "margin:14px 0 6px" }, "Line items ", h("span", { class: "subtle", style: "font-weight:400;font-size:13px" }, "— what was bought, for returns and item lookup")),
    items,
    h("div", { style: "display:flex;justify-content:space-between;font-size:13px;margin-top:4px" }, h("span", { class: "subtle" }, "Items add to"), totalEl),
    drift,
    field("Notes", ta(r, "notes", { rows: 2, placeholder: "What it was for, who bought it, anything to return…" })),
    h("div", { class: "sticky-actions" },
      h("button", { type: "button", class: "btn btn--primary", onclick: async () => { commit(); location.hash = listHash(project); } }, "✓ Done"),
      h("button", { type: "button", class: "btn btn--danger", style: "flex:0 0 auto;width:auto", onclick: async () => {
        // returns logged against only this receipt go with it — a credit with
        // no receipt would sit on the job total with nothing to explain it
        // (receiptlib.js deletePlan); one that also covers another receipt
        // is the office's to change first
        const lib = await receiptLib();
        let kill = [r.id], n = 0;
        if (lib) {
          const plan = lib.deletePlan(project, r.id);
          if (plan.refuse) return toast(plan.refuse, 5000);
          kill = plan.kill; n = plan.returns;
        } else if (project.receipts.some((x) => isReturn(x) && (x.returnOf === r.id ||
            (Array.isArray(x.items) && x.items.some((it) => it && it.ofReceipt === r.id))))) {
          return toast("This receipt has a return logged against it. Open Field Forms with signal, then try again.", 5000);
        }
        if (!confirm(n
          ? `Delete this receipt and the ${n === 1 ? "return" : n + " returns"} logged against it from the job?`
          : "Delete this receipt from the job?")) return;
        const gone = new Set(kill);
        project.receipts = project.receipts.filter((x) => x && !gone.has(x.id));
        tombstoneItems(project, kill);   // so the delete sticks across devices (merge.js)
        await Store.put(project);
        toast("Receipt deleted.");
        location.hash = listHash(project);
      } }, "🗑")));
  paintTotals();

  // a receipt snapped a moment ago reads itself the first time its editor opens
  if (PENDING_READ.has(r.id)) {
    PENDING_READ.delete(r.id);
    if (aiReady()) runRead();
    else toast("Saved. No signal — tap ✨ Read receipt when you're back online, or type it in.", 3500);
  }
}

/* ---------- a return (credit) — read-only here ----------
   Changed or removed in the office app (Receipts). A retake or AI read on
   a credit would rewrite its amount as a cost and drop its item links, and
   the phone's decimal keypad has no minus key — so nothing here edits it. */
function returnView(project, r, ctx) {
  const { view, setChrome } = ctx;
  setChrome("Return", listHash(project), "Return — " + (r.vendor || ""));
  view.replaceChildren();
  setCtx(project, null);
  const orig = project.receipts.find((x) => x && x.id === r.returnOf && !isReturn(x));
  const pages = [r.photo, ...(Array.isArray(r.extraPages) ? r.extraPages : [])].filter(Boolean);
  const lines = (Array.isArray(r.items) ? r.items : []).filter(Boolean);
  view.append(
    h("h1", {}, "↩ Return"),
    h("div", { class: "card" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:10px" },
        h("strong", {}, String(r.vendor || "").trim() || "Unknown vendor"),
        h("span", { style: "font-size:22px;font-weight:800;color:var(--green)" }, money(receiptAmount(r)))),
      h("p", { class: "subtle", style: "margin:6px 0 0" }, [fmtDate(r.date), r.receiptNo ? "Slip #" + r.receiptNo : ""].filter(Boolean).join(" · ")),
      h("p", { style: "margin:8px 0 0" }, orig
        ? h("a", { href: editHash(project, orig) }, `Return of ${String(orig.vendor || "").trim() || "a receipt"} — ${fmtDate(orig.date)} · ${money(receiptAmount(orig))} ›`)
        : h("span", { class: "subtle" }, "The receipt it returns is no longer on this job.")),
      r.notes ? h("p", { class: "subtle", style: "margin:8px 0 0" }, r.notes) : null),
    pages.length
      ? h("div", { class: "card", style: "padding:8px" }, ...pages.map((src) => isMediaMarker(src)
          ? h("div", { class: "empty", style: "padding:18px" }, h("div", { class: "big" }, "☁️"), h("p", {}, "The slip photo loads the next time this device syncs online."))
          : h("img", { src, alt: "Return slip", style: "display:block;max-width:100%;max-height:280px;margin:0 auto 6px;border-radius:8px;cursor:zoom-in", onclick: () => lightbox(src) })))
      : null,
    lines.length ? h("div", { class: "card" }, h("strong", {}, "Taken back"),
      h("div", { class: "totals", style: "margin-top:6px" }, ...lines.map((it) => h("div", { class: "trow" },
        h("span", {}, `${it.desc || "Item"}${amountNum(it.qty) ? " × " + amountNum(it.qty) : ""}`),
        h("span", {}, money(amountNum(it.qty) * amountNum(it.price))))))) : null,
    h("p", { class: "subtle", style: "font-size:13px" }, `Logged${r.by ? " by " + r.by : ""}. Returns are changed or removed in the office app (Receipts), so the job total stays right.`));
}

/* ---------- a return slip → a return (the phone's half of the office form) ----------
   The slip was snapped as a receipt. This books it against the purchase it
   came from on this job: receiptlib.js slipMatches suggests the receipt and
   the items (same store, a SKU or unit price that matches, the original
   invoice # the slip prints), the crew checks the quantities and the refund,
   and Save writes the same credit the office form builds (buildReturnCredit)
   with the slip's photo on it. The slip comes off the list and is
   tombstoned, so a stale copy on another phone can't bring it back as a $0
   receipt. One receipt per return here; a return across two receipts, a
   change or a delete is the office's. */
async function returnForm(project, slip, ctx) {
  const { view, setChrome } = ctx;
  setChrome("Log a return", listHash(project), "Log a return");
  view.replaceChildren();
  setCtx(project, null);
  const back = () => {
    const cur = project.receipts.find((x) => x && x.id === slip.id);
    if (cur && !isReturn(cur)) receiptEditor(project, cur, ctx); else location.hash = listHash(project);
  };
  const stop = (msg) => view.replaceChildren(h("h1", {}, "↩ Log a return"),
    h("div", { class: "card" }, h("p", { style: "margin:0" }, msg)),
    h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn btn--ghost", onclick: back }, "‹ Back to the slip")));
  const lib = await receiptLib();
  if (!lib || typeof lib.slipMatches !== "function") return stop("Open Field Forms once with signal, then try again.");
  const entries = lib.buildIndex([project]);
  const byId = new Map(entries.filter((e) => e.kind === "purchase").map((e) => [e.id, e]));
  const matches = lib.slipMatches(entries, project.id, slip);
  if (!matches.length) {
    return stop("There's no receipt on this job to log it against. Snap the original receipt on this job first, or log the return in the office app (Receipts).");
  }

  // derived from the slip: a double tap, another phone or the office turning
  // this same slip into a return all write ONE element (receiptlib.js)
  const formId = lib.slipReturnId(slip.id);
  const onSlip = lib.slipRefund(slip);
  let chosen = matches[0].score > 0 ? matches[0].id : "";
  let picks = new Map();               // itemId -> qty, on the chosen receipt
  const seed = () => {
    picks = new Map();
    const m = matches.find((x) => x.id === chosen);
    for (const pk of (m ? m.picks : [])) picks.set(pk.itemId, pk.qty);
  };
  seed();
  const pickList = () => [...picks].filter(([, q]) => q > 0).map(([itemId, qty]) => ({ receiptId: chosen, itemId, qty }));

  // the refund: what the slip prints when the AI read it, else the items picked (plus tax)
  let refundTouched = onSlip > 0;
  const refund = h("input", { type: "text", inputmode: "decimal", placeholder: "0.00", value: onSlip > 0 ? onSlip.toFixed(2) : "", "aria-label": "Refund on the slip" });
  refund.addEventListener("input", () => { refundTouched = refund.value.trim() !== ""; });
  const prefill = () => {
    if (refundTouched) return;
    const v = lib.prefillRefund(pickList(), byId);
    refund.value = v > 0 ? v.toFixed(2) : "";
  };

  const label = (e) => `${e.vendor || "Unknown store"} · ${lib.fmtDay(e.date)} · ${money(e.amount)}${e.receiptNo ? " · #" + e.receiptNo : ""}`;
  const which = h("select", { "aria-label": "The receipt it returns" },
    h("option", { value: "" }, "Pick the receipt it returns…"),
    ...matches.map((m) => h("option", { value: m.id }, label(byId.get(m.id)))));
  which.value = chosen;
  const itemsBox = h("div", { class: "totals", style: "margin-top:6px" });
  function paintItems() {
    const e = byId.get(chosen);
    if (!e) { itemsBox.replaceChildren(); return; }
    const items = e.items.filter((it) => it.price > 0);
    if (!items.length) { itemsBox.replaceChildren(h("p", { class: "subtle", style: "margin:4px 0" }, "No item lines on that receipt. Enter the refund below.")); return; }
    itemsBox.replaceChildren(...items.map((it) => {
      const left = lib.remainingQty(e, it);
      const q = h("input", { type: "number", inputmode: "decimal", min: "0", step: "any", max: String(left), placeholder: "0",
        value: picks.get(it.id) ? String(picks.get(it.id)) : "", disabled: left <= 0, style: "width:76px;flex:0 0 auto",
        "aria-label": "Quantity returned: " + (it.desc || "item") });
      q.addEventListener("input", () => {
        const n = amountNum(q.value);
        if (n > 0) picks.set(it.id, n); else picks.delete(it.id);
        prefill();
      });
      return h("div", { class: "trow", style: "align-items:center;gap:10px" }, q,
        h("span", { style: "flex:1;text-align:left" }, it.desc || "Item",
          h("div", { class: "subtle", style: "font-size:12px" },
            `${money(it.price)} each${it.sku ? " · SKU " + it.sku : ""} · ${left <= 0 ? "all returned" : lib.fmtQty(left) + " of " + lib.fmtQty(it.qty) + " left"}`)));
    }));
  }
  which.addEventListener("change", () => { chosen = which.value; seed(); paintItems(); prefill(); });
  paintItems();

  const date = h("input", { type: "date", value: lib.validISO(slip.date) ? slip.date : todayISO(), "aria-label": "Return date" });
  const slipNo = h("input", { type: "text", maxlength: "40", value: String(slip.receiptNo || ""), placeholder: "From the return slip" });
  const over = h("input", { type: "checkbox", id: "ret-over" });
  const err = h("div", { class: "warn", role: "alert", hidden: true });
  const save = h("button", { type: "button", class: "btn btn--primary" }, "↩ Save return");
  const lines = lib.slipLines(slip);

  view.append(
    h("h1", {}, "↩ Log a return"),
    h("p", { class: "subtle" }, "The refund comes off this job's total, the receipt it returns shows what went back, and this slip's photo moves onto the return."),
    h("div", { class: "card" },
      field("Returns which receipt", which),
      lines.length ? h("p", { class: "subtle", style: "font-size:12px;margin:-4px 0 6px" },
        "On the slip: " + lines.map((ln) => `${ln.desc} × ${lib.fmtQty(ln.qty)}`).join(" · ")) : null,
      h("strong", { style: "font-size:14px" }, "What went back"),
      itemsBox),
    h("div", { class: "card" },
      h("div", { class: "grid2" },
        field("Refund $", refund, onSlip > 0 ? "from the slip" : "filled from the items"),
        field("Return date", date)),
      field("Slip #", slipNo),
      h("div", { class: "check" }, over, h("label", { for: "ret-over" }, "More than what's left on the receipt (store credit or an exchange)"))),
    err,
    h("div", { class: "sticky-actions" }, save,
      h("button", { type: "button", class: "btn btn--ghost", style: "flex:0 0 auto;width:auto", onclick: back }, "Cancel")));
  prefill();

  let saving = false;
  save.addEventListener("click", async () => {
    if (saving) return;
    err.hidden = true;
    if (project.receipts.some((x) => x && x.id === formId)) {
      if (!saving) toast("This slip is already logged as a return.", 3500);
      location.hash = listHash(project); return;
    }
    try {
      if (!chosen) throw new Error("Pick the receipt this slip returns.");
      if (!lib.validISO(date.value)) throw new Error("Pick the date on the return slip.");
      const amt = Math.abs(amountNum(refund.value));
      // checked and built against the job as it is NOW (sync grafts into this object)
      const cur = project.receipts.find((x) => x && x.id === slip.id);
      const dead = project.deletedIds && typeof project.deletedIds === "object" ? project.deletedIds : {};
      if (dead[formId]) throw new Error("This slip was logged as a return and then deleted in the office.");
      if (!cur || dead[slip.id]) throw new Error("This slip was deleted on another device.");
      if (amountNum(cur.amount) > 0 || isReturn(cur)) throw new Error("This slip has a total now, so it counts as a purchase. Clear its total first if it's really a return.");
      const fe = lib.buildIndex([project]);
      const picked = pickList();
      const problem = lib.checkReturn({ entries: fe, jobId: project.id, returnOf: chosen, picks: picked, refund: amt, over: over.checked });
      if (problem) throw new Error(problem);
      const sources = lib.returnSources(fe, project.id, chosen);
      const c = lib.buildReturnCredit({ id: formId, start: sources[0], sources, picks: picked, refund: amt,
        date: date.value, slipNo: slipNo.value, note: "",
        photo: cur.photo || "", extraPages: Array.isArray(cur.extraPages) ? cur.extraPages.slice(0, MAX_PAGES - 1) : [],
        by: author() || "", nowISO: new Date().toISOString() });
      saving = true; save.disabled = true;
      project.receipts = project.receipts.filter((x) => !(x && x.id === slip.id));
      project.receipts.push(c);
      tombstoneItems(project, [slip.id]);   // so the slip stays gone on every device (merge.js)
      await Store.put(project);
      toast(`Return logged: ${money(receiptAmount(c))} off this job.`, 3500);
      location.hash = listHash(project);
    } catch (e) {
      saving = false; save.disabled = false;
      err.textContent = String((e && e.message) || e);
      err.hidden = false;
    }
  });
}

/* ---------- full-screen photo (the returns-counter view) ----------
   The app's viewport blocks pinch zoom (maximum-scale=1), so the overlay
   zooms itself: tap the image to switch between fit-to-width and 2.2×
   (scroll to pan), ✕ or the dark edge to close. */
function lightbox(src) {
  let zoomed = false;
  const img = h("img", { src, alt: "Receipt", style: "display:block;width:100%;height:auto;cursor:zoom-in" });
  const scroller = h("div", { style: "position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:48px 0 0" }, img);
  const close = () => ov.remove();
  const ov = h("div", { style: "position:fixed;inset:0;background:#000;z-index:1000" },
    scroller,
    h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "position:absolute;top:10px;right:10px;width:auto;z-index:1", onclick: close }, "✕ Close"),
    h("div", { class: "subtle", style: "position:absolute;top:16px;left:14px;color:#ccc;font-size:12px" }, "Tap the receipt to zoom"));
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    img.style.width = zoomed ? "220%" : "100%";
    img.style.cursor = zoomed ? "zoom-out" : "zoom-in";
  });
  scroller.addEventListener("click", (e) => { if (e.target === scroller) close(); });
  document.body.append(ov);
}
