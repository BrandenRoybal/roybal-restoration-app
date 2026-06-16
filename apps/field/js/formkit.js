/* ============================================================
   Roybal Field Forms — shared form building blocks
   Bound inputs autosave to the active project. One editable DOM
   serves both the on-screen UI and the print/PDF output.
   ============================================================ */
import { h, autosave, fileToDataURL, signaturePad, money, toast } from "./core.js";
import { fileToDocPages } from "./pdf.js";
import { COMPANY } from "./model.js";

/* save context (set once per form render) */
let CTX = { project: null, pill: null };
export function setCtx(project, pill) { CTX = { project, pill }; }
export function commit() { if (CTX.project) autosave(CTX.project, CTX.pill); }

/* ---------- field wrapper ---------- */
export function field(label, node, hint) {
  return h("div", { class: "field" },
    label ? h("label", {}, label, hint ? h("span", { class: "hint" }, "  " + hint) : null) : null,
    node);
}

/* ---------- bound inputs ---------- */
export function inp(obj, key, opts = {}) {
  const el = h("input", {
    type: opts.type || "text",
    value: obj[key] ?? "",
    placeholder: opts.placeholder || "",
    inputmode: opts.inputmode || null,
    ...(opts.attrs || {}),
  });
  el.addEventListener("input", () => { obj[key] = el.value; opts.oninput && opts.oninput(el.value); commit(); });
  return el;
}
export function ta(obj, key, opts = {}) {
  const el = h("textarea", { placeholder: opts.placeholder || "", rows: opts.rows || 3 });
  el.value = obj[key] ?? "";
  el.addEventListener("input", () => { obj[key] = el.value; commit(); });
  return el;
}
export function sel(obj, key, options, opts = {}) {
  const el = h("select", {},
    opts.placeholder ? h("option", { value: "" }, opts.placeholder) : null,
    ...options.map((o) => {
      const val = typeof o === "object" ? o.value : o;
      const lbl = typeof o === "object" ? o.label : o;
      return h("option", { value: val, selected: String(obj[key]) === String(val) }, lbl);
    }));
  el.addEventListener("change", () => { obj[key] = el.value; opts.onchange && opts.onchange(el.value); commit(); });
  return el;
}

/* ---------- segmented control (e.g. Cat 1/2/3) ---------- */
export function seg(obj, key, values, opts = {}) {
  const wrap = h("div", { class: "seg" });
  values.forEach((v) => {
    const val = typeof v === "object" ? v.value : v;
    const lbl = typeof v === "object" ? v.label : v;
    const b = h("button", { type: "button", class: String(obj[key]) === String(val) ? "active" : "" }, lbl);
    b.addEventListener("click", () => {
      obj[key] = String(obj[key]) === String(val) ? "" : val;
      [...wrap.children].forEach((c) => c.classList.remove("active"));
      if (obj[key] !== "") b.classList.add("active");
      opts.onchange && opts.onchange(obj[key]);
      commit();
    });
    wrap.append(b);
  });
  return wrap;
}

/* ---------- checkbox ---------- */
export function check(obj, key, label) {
  const box = h("input", { type: "checkbox", checked: !!obj[key] });
  box.addEventListener("change", () => { obj[key] = box.checked; commit(); });
  const id = "c" + Math.random().toString(36).slice(2);
  box.id = id;
  return h("div", { class: "check" }, box, h("label", { for: id }, label));
}

/* ---------- signature block: name + pad + date (reusable) ---------- */
export function sigBlock(obj, sigKey, nameKey, dateKey, title) {
  const pad = signaturePad(obj[sigKey], (data) => { obj[sigKey] = data; commit(); });
  const clearBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Clear");
  clearBtn.addEventListener("click", () => pad.clear());
  return h("div", { class: "sigblock" },
    h("label", { style: "font-size:13px;font-weight:600;color:var(--navy);display:block;margin-bottom:6px" }, title),
    pad.el,
    h("div", { class: "sig-actions app-only" }, clearBtn),
    h("div", { class: "grid2", style: "margin-top:8px" },
      field("Print name", inp(obj, nameKey, { placeholder: "Full name" })),
      field("Date", inp(obj, dateKey, { type: "date" }))));
}

/* ---------- signature OR upload (Work Authorization / Cert of Drying) ----------
   `signNodesFn` returns the fresh "sign on device" DOM for this form.
   In upload mode, an uploaded PDF/scan is stored as page images and
   REPLACES this form in the printed packet (see uploadedDocPages). */
export function signOrUpload(obj, signNodesFn) {
  const body = h("div");
  function render() {
    body.replaceChildren();
    if (obj.mode === "upload") body.append(uploadDoc(obj));
    else (signNodesFn() || []).forEach((n) => n && body.append(n));
  }
  const tabs = h("div", { class: "sig-tabs app-only" },
    tabBtn("✍️ Sign on device", () => switchTo("sign")),
    tabBtn("📎 Upload signed copy", () => switchTo("upload")));
  function tabBtn(label, fn) {
    const b = h("button", { type: "button" }, label); b.addEventListener("click", fn); return b;
  }
  function paint() {
    [...tabs.children].forEach((c, i) => c.classList.toggle("active", (i === 0) === (obj.mode !== "upload")));
  }
  function switchTo(mode) { obj.mode = mode; paint(); render(); commit(); }
  paint(); render();
  return h("div", {}, tabs, body);
}

/* legacy single uploadedDoc → uniform page array */
export function uploadedDocPages(obj) {
  if (obj && obj.uploadedPages && obj.uploadedPages.length) return obj.uploadedPages;
  if (obj && obj.uploadedDoc) return [obj.uploadedDoc];
  return [];
}

function uploadDoc(obj) {
  const wrap = h("div", { class: "uploadbox" });
  function render() {
    wrap.replaceChildren();
    const pages = uploadedDocPages(obj);
    if (pages.length) {
      wrap.append(
        h("div", { class: "app-only", style: "margin-bottom:8px;color:var(--green);font-weight:600" },
          `📎 ${pages.length} page(s) attached — this replaces the form in the PDF report.`),
        ...pages.map((src) => h("img", { src, alt: "Uploaded signed document page", class: "docpage" })),
        h("button", { type: "button", class: "btn btn--danger btn--sm app-only", style: "margin-top:10px",
          onclick: () => { obj.uploadedPages = []; obj.uploadedDoc = ""; commit(); render(); } }, "Remove"));
    } else {
      const input = h("input", { type: "file", accept: "image/*,application/pdf", style: "display:none" });
      const status = h("div", { class: "app-only subtle", style: "margin-top:8px" });
      const btn = h("button", { type: "button", class: "btn btn--primary" }, "📄 Choose PDF / photo");
      input.addEventListener("change", async () => {
        const f = input.files[0]; if (!f) return;
        btn.disabled = true; status.textContent = "Reading document…";
        try { obj.uploadedPages = await fileToDocPages(f); obj.uploadedDoc = ""; commit(); render(); }
        catch { btn.disabled = false; status.textContent = ""; toast("Sorry — couldn't read that file."); }
      });
      btn.addEventListener("click", () => input.click());
      wrap.append(
        h("div", { class: "app-only", style: "margin-bottom:10px" },
          "Upload a signed PDF or a photo/scan. The uploaded document will replace this form in the PDF report."),
        btn, input, status);
    }
  }
  render();
  return wrap;
}

/* ---------- photo uploader (array of dataURLs) ---------- */
export function photoUploader(arr, label = "Add photos") {
  const wrap = h("div");
  const thumbs = h("div", { class: "thumbs" });
  function paint() {
    thumbs.replaceChildren();
    arr.forEach((src, i) => {
      thumbs.append(h("div", { class: "thumb" },
        h("img", { src, alt: "" }),
        h("button", { type: "button", class: "app-only", onclick: () => { arr.splice(i, 1); commit(); paint(); } }, "✕")));
    });
  }
  const input = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: "display:none" });
  input.addEventListener("change", async () => {
    for (const f of input.files) arr.push(await fileToDataURL(f));
    input.value = ""; commit(); paint();
  });
  const btn = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only" }, "📷 " + label);
  btn.addEventListener("click", () => input.click());
  paint();
  return h("div", {}, h("div", { class: "app-only" }, btn), input, thumbs);
}

/* ---------- editable line-items table with live totals ---------- */
export function lineItems(items, blankFn, opts = {}) {
  const wrap = h("div");
  const totalsBox = h("div", { class: "totals" });
  const tbody = h("tbody");

  function recalc() {
    let subtotal = 0;
    items.forEach((it, i) => {
      const ext = (Number(it.qty) || 0) * (Number(it.price) || 0);
      subtotal += ext;
      const cell = tbody.children[i]?.querySelector(".ext");
      if (cell) cell.textContent = money(ext);
    });
    opts.onTotals && opts.onTotals(subtotal, totalsBox);
  }
  function rowEl(it, i) {
    const tr = h("tr");
    const mk = (key, w, type = "text") => {
      const c = h("td");
      const input = h("input", { type, value: it[key] ?? "", style: w ? `min-width:${w}` : "" });
      input.addEventListener("input", () => { it[key] = input.value; recalc(); commit(); });
      c.append(input); return c;
    };
    tr.append(
      mk("desc", "160px"),
      mk("qty", "60px", "number"),
      mk("unit", "60px"),
      mk("price", "80px", "number"),
      h("td", { class: "ext calc" }, money((Number(it.qty) || 0) * (Number(it.price) || 0))),
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { items.splice(i, 1); paint(); recalc(); commit(); } }, "✕"))
    );
    return tr;
  }
  function paint() {
    tbody.replaceChildren(...items.map(rowEl));
  }
  paint();
  const table = h("div", { class: "tablewrap" },
    h("table", { class: "grid" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Description"), h("th", {}, "Qty"), h("th", {}, "Unit"),
        h("th", {}, "Unit Price"), h("th", {}, "Extended"), h("th", { class: "app-only" }, ""))),
      tbody));
  const add = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add line item");
  add.addEventListener("click", () => { items.push(blankFn()); paint(); recalc(); commit(); });
  wrap.append(table, add, totalsBox);
  recalc();
  return wrap;
}

/* ---------- printable letterhead + footer ---------- */
export function letterhead(formTitle, subtitle) {
  return h("div", { class: "print-only sheet-head" },
    h("div", { class: "sheet-head__body" },
      h("div", { class: "sheet-head__co" },
        h("div", { class: "sheet-head__name" }, "ROYBAL CONSTRUCTION, LLC"),
        h("div", { class: "sheet-head__tag" }, COMPANY.tagline)),
      h("div", { class: "sheet-head__addr" },
        h("div", {}, COMPANY.address),
        h("div", {}, COMPANY.phone + " | " + COMPANY.email),
        h("div", {}, COMPANY.web))),
    h("div", { class: "sheet-head__title" },
      h("h2", {}, formTitle), subtitle ? h("div", { class: "sheet-head__sub" }, subtitle) : null));
}
export function sheetFooter(label) {
  return h("div", { class: "print-only sheet-foot" }, `Roybal Construction, LLC — ${label}`);
}

/* a print "sheet" wrapper */
export function sheet(formTitle, subtitle, footLabel, ...sections) {
  return h("section", { class: "sheet" },
    letterhead(formTitle, subtitle),
    ...sections,
    sheetFooter(footLabel));
}
