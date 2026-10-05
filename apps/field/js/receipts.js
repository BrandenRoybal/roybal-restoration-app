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
   ============================================================ */
import { h, Store, toast, fmtDate, money, fileToDataURL } from "./core.js";
import { setCtx, commit, field, inp, ta, sel, seg, lineItems } from "./formkit.js";
import { newReceipt, blankLineItem } from "./model.js";
import { tombstoneItems } from "./merge.js";
import { aiAvailable, aiReady, readReceipt } from "./officeai.js";
import { isMediaMarker } from "./media.js";
import { fileToDocPages } from "./pdf.js";
import { budgetStatus } from "./fincalc.js";
import {
  RECEIPT_CATEGORIES, PAID_WITH, receiptCategory, receiptTotals, receiptAmount,
  itemsTotal, amountNum, applyReceiptRead,
} from "./receiptcalc.js";

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

  const hay = (r) => [r.vendor, r.notes, r.receiptNo, r.cardLast4, ...(r.items || []).map((it) => it && (it.desc + " " + (it.sku || "")))]
    .filter(Boolean).join(" ").toLowerCase();
  function paint() {
    const rows = project.receipts.filter((r) => r && (!fCat || receiptCategory(r.category) === fCat) && (!q || hay(r).includes(q)))
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
      const needs = !receiptAmount(r) || !String(r.vendor || "").trim();
      return h("a", { class: "card card--tap citem", href: editHash(project, r) },
        thumbEl(r.photo, cat.icon),
        h("div", { class: "jobrow__main" },
          h("div", { class: "jobrow__title" }, (String(r.vendor || "").trim() || "Unknown vendor") + " — " + money(receiptAmount(r))),
          h("div", { class: "jobrow__sub" }, sub),
          needs || r.ai ? h("div", { class: "badgeline", style: "margin:4px 0 0" },
            needs ? h("span", { class: "badge", style: "background:var(--brand-tint);color:var(--brand-dark)" }, "Needs vendor / total") : null,
            r.ai ? h("span", { class: "badge" }, "✨ AI read") : null) : null),
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
  const rows = RECEIPT_CATEGORIES.filter((c) => t.byCategory[c.value].count)
    .map((c) => h("div", { class: "trow" },
      h("span", {}, `${c.icon} ${c.label} `, h("span", { class: "subtle", style: "font-size:12px" }, `(${t.byCategory[c.value].count})`)),
      h("span", {}, money(t.byCategory[c.value].total))));
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
      const changed = applyReceiptRead(r, read, { overwrite });
      r.ai = { at: new Date().toISOString(), model: read.model || "", confidence: typeof read.confidence === "number" ? read.confidence : null };
      await Store.put(project);
      toast(changed.length ? `Read ${read.vendor || "the receipt"} — ${money(amountNum(read.total))}. Check it, then Done.` : "Read it — nothing new to fill in.");
      receiptEditor(project, r, ctx);   // repaint every field with what landed
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

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "🧾 Receipt"), pill),
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
        if (!confirm("Delete this receipt from the job?")) return;
        project.receipts = project.receipts.filter((x) => x && x.id !== r.id);
        tombstoneItems(project, [r.id]);   // so the delete sticks across devices (merge.js)
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
