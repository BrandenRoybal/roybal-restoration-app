/* ============================================================
   Roybal Field Forms — editable Word estimate (.docx)
   ------------------------------------------------------------
   Private-pay customers get estimates they (and the office) can edit
   in Word. A .docx is a ZIP of WordprocessingML, so this builds the
   XML by hand and packs it with zip.js — no library, works offline,
   Node-testable (test/docx.test.mjs round-trips it through xlsx.js's
   zip reader). Same content and math as the printed estimate
   (forms.js invoice(), recalc()): letterhead, Prepared For, scope
   summary, line items grouped by area, the totals block, alternates,
   notes/assumptions/exclusions, and the estimate disclaimer. Navy +
   safety orange from the field app's design tokens.
   ============================================================ */
import { zipStore } from "./zip.js";

const NAVY = "0F1B2D";
const ORANGE = "F26A21";
const GREY = "5B6B80";
const LINE = "CDD5DF";
const COMPANY = {
  name: "Roybal Construction, LLC",
  address: "3850 Royal Rd, Fairbanks, AK 99701",
  contact: "907-371-9868 · branden@roybalconstruction.com",
};

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const money = (n) => (num(n) < 0 ? "-$" : "$") + Math.abs(num(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (v) => { const n = num(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); };
const fmtDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/* ---------- pure: the estimate's figures, exactly as recalc() prints them ---------- */
export function estimateFigures(inv, isBuild = false) {
  const i = inv || {};
  const subtotal = arr(i.items).reduce((t, it) => t + num(it && it.qty) * num(it && it.price), 0);
  const contract = i.billingModel === "contract";
  const amt = (i.opMode || "pct") === "amount";
  const contPct = num(i.contingencyPct);
  const showCont = isBuild || contPct > 0;
  const cont = contract || !showCont ? 0 : subtotal * (contPct / 100);
  const opBase = subtotal + cont;
  const base = contract ? num(i.contractAmount) : opBase;
  const oh = contract ? 0 : (amt ? num(i.overheadAmount) : opBase * (num(i.overheadPct) / 100));
  const pf = contract ? 0 : (amt ? num(i.profitAmount) : opBase * (num(i.profitPct) / 100));
  const rcv = base + oh + pf;
  const tax = base * (num(i.taxRate) / 100);
  const total = rcv - num(i.deductible) - num(i.previousPayments) + tax;
  const contFactor = subtotal ? cont / subtotal : 0;
  const opFactor = opBase ? (oh + pf) / opBase : 0;
  const alternates = arr(i.alternates).filter((a) => a && (String(a.title || "").trim() || num(a.baseCost)))
    .map((a, n) => ({ no: n + 1, title: String(a.title || "").trim(), description: String(a.description || "").trim(),
      amount: num(a.baseCost) * (1 + contFactor) * (1 + opFactor) }));
  return { subtotal, cont, contPct, showCont: showCont && !contract, oh, pf, amt, rcv, tax, total, contract,
    deductible: num(i.deductible), previousPayments: num(i.previousPayments), alternates };
}

/* line items grouped by area, in the order they appear (the "Recap by Room"
   rule). An empty row is skipped; a priced row with no description still
   prints, so the table always adds up to the line item total. */
export function itemsByArea(items) {
  const order = [], by = new Map();
  for (const it of arr(items)) {
    if (!it || (!String(it.desc || "").trim() && !(num(it.qty) * num(it.price)))) continue;
    const key = String(it.room || "").trim();
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    by.get(key).push(it);
  }
  return order.map((area) => ({ area, items: by.get(area) }));
}

/* ---------- XML helpers ---------- */
export const esc = (s) => String(s ?? "")
  // drop characters XML 1.0 forbids (control chars other than tab/newline)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(text, { b = false, color = "", size = 0, caps = false } = {}) {
  const pr = ['<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>', b ? "<w:b/>" : "", caps ? "<w:caps/>" : "", color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""].join("");
  // a newline in the text becomes a line break inside the paragraph
  const parts = String(text ?? "").split("\n");
  return parts.map((t, i) => `${i ? "<w:r>" + (pr ? `<w:rPr>${pr}</w:rPr>` : "") + "<w:br/></w:r>" : ""}` +
    `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join("");
}
function para(runs, { align = "", before = 0, after = 80, keep = false, border = "" } = {}) {
  const pr = [keep ? "<w:keepNext/>" : "",
    border ? `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="${border}"/></w:pBdr>` : "",
    `<w:spacing w:before="${before}" w:after="${after}"/>`,
    align ? `<w:jc w:val="${align}"/>` : ""].join("");
  return `<w:p><w:pPr>${pr}</w:pPr>${runs}</w:p>`;
}
const heading = (text) => para(run(text, { b: true, color: NAVY, size: 22, caps: true }), { before: 240, after: 80, keep: true, border: ORANGE });

function cell(content, width, { shade = "", align = "", bold = false, color = "", size = 18, span = 1 } = {}) {
  const pr = `<w:tcW w:w="${width}" w:type="dxa"/>` + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : "") +
    (shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : "");
  return `<w:tc><w:tcPr>${pr}</w:tcPr>${para(run(content, { b: bold, color, size }), { align, after: 0 })}</w:tc>`;
}
function table(widths, rows, { header = true, align = "" } = {}) {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
  const borders = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LINE}"/><w:bottom w:val="single" w:sz="4" w:color="${LINE}"/>` +
    `<w:insideH w:val="single" w:sz="4" w:color="${LINE}"/></w:tblBorders>`;
  const trs = rows.map((cells, i) => `<w:tr>${header && i === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    (align ? `<w:jc w:val="${align}"/>` : "") + `${borders}<w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`;
}

/* ---------- pure: word/document.xml ---------- */
export function estimateDocumentXml(project, inv, { isBuild = false } = {}) {
  const p = project || {};
  const i = inv || {};
  const f = estimateFigures(i, isBuild);
  const title = isBuild ? "Estimate" : "Reconstruction Estimate";
  const body = [];

  // letterhead
  body.push(para(run(COMPANY.name, { b: true, color: NAVY, size: 32 }), { after: 0 }));
  body.push(para(run(COMPANY.address + " · " + COMPANY.contact, { color: GREY, size: 17 }), { after: 120, border: ORANGE }));
  body.push(para(run(title.toUpperCase(), { b: true, color: ORANGE, size: 28 }), { before: 120, after: 60 }));
  const meta = [
    i.invoiceNo ? "Estimate # " + i.invoiceNo : "",
    i.invoiceDate ? "Date: " + fmtDay(i.invoiceDate) : "",
    i.dueDate ? "Valid until: " + fmtDay(i.dueDate) : "",
  ].filter(Boolean).join("    ");
  if (meta) body.push(para(run(meta, { size: 19 }), { after: 120 }));

  // prepared for
  body.push(heading("Prepared for"));
  const who = [p.customer, p.address, [p.phone, p.email].filter(Boolean).join(" · ")].filter((s) => String(s || "").trim());
  body.push(para(run(who.join("\n") || "—", { size: 20 }), { after: 60 }));
  if (!isBuild) {
    const claim = [p.carrier ? "Carrier: " + p.carrier : "", p.claimNo ? "Claim #: " + p.claimNo : "",
      p.dateOfLoss ? "Date of loss: " + fmtDay(p.dateOfLoss) : ""].filter(Boolean).join("    ");
    if (claim) body.push(para(run(claim, { size: 18, color: GREY }), { after: 60 }));
  }

  // scope summary
  if (String(i.lossSummary || "").trim()) {
    body.push(heading(isBuild ? "Scope summary" : "Damage description / rebuild scope"));
    body.push(para(run(String(i.lossSummary).trim(), { size: 20 })));
  }

  // line items by area
  body.push(heading(isBuild ? "Estimated scope of work" : "Estimated scope of repairs"));
  const W = [5100, 900, 800, 1400, 1500];   // 9700 twips ≈ 6.7" inside 0.9" margins
  const rows = [[
    cell("Description", W[0], { shade: NAVY, bold: true, color: "FFFFFF" }),
    cell("Qty", W[1], { shade: NAVY, bold: true, color: "FFFFFF", align: "right" }),
    cell("Unit", W[2], { shade: NAVY, bold: true, color: "FFFFFF" }),
    cell("Unit price", W[3], { shade: NAVY, bold: true, color: "FFFFFF", align: "right" }),
    cell("Total", W[4], { shade: NAVY, bold: true, color: "FFFFFF", align: "right" }),
  ]];
  const groups = itemsByArea(i.items);
  const labelled = groups.length > 1 || (groups[0] && groups[0].area);
  for (const g of groups) {
    if (labelled) {
      const sub = g.items.reduce((t, it) => t + num(it.qty) * num(it.price), 0);
      rows.push([cell(g.area || "General", W[0] + W[1] + W[2] + W[3], { shade: "FFF3EC", bold: true, color: NAVY, span: 4 }),
        cell(money(sub), W[4], { shade: "FFF3EC", bold: true, color: NAVY, align: "right" })]);
    }
    for (const it of g.items) {
      rows.push([
        cell(String(it.desc || "").trim() + (String(it.by || "").trim() ? "\n(" + String(it.by).trim() + ")" : ""), W[0]),
        cell(qtyText(it.qty), W[1], { align: "right" }),
        cell(String(it.unit || ""), W[2]),
        cell(money(it.price), W[3], { align: "right" }),
        cell(money(num(it.qty) * num(it.price)), W[4], { align: "right" }),
      ]);
    }
  }
  if (rows.length === 1) rows.push([cell("No line items yet.", W.reduce((a, b) => a + b, 0), { span: 5, color: GREY })]);
  body.push(table(W, rows));

  // totals
  const T = [3600, 2000];
  const tRows = [];
  const tline = (label, value, strong = false) => tRows.push([
    cell(label, T[0], { align: "right", bold: strong, size: strong ? 22 : 19 }),
    cell(value, T[1], { align: "right", bold: strong, size: strong ? 22 : 19, color: strong ? NAVY : "" })]);
  if (f.contract) {
    tline("Contract amount", money(num(i.contractAmount)));
  } else {
    tline("Line item total", money(f.subtotal));
    if (f.showCont && f.cont) tline(`Design contingency (${qtyText(f.contPct)}%)`, money(f.cont));
    if (f.oh) tline(f.amt ? "Overhead" : `Overhead (${qtyText(i.overheadPct)}%)`, money(f.oh));
    if (f.pf) tline(f.amt ? "Profit" : `Profit (${qtyText(i.profitPct)}%)`, money(f.pf));
  }
  if (f.tax) tline(`Tax (${qtyText(i.taxRate)}%)`, money(f.tax));
  if (f.deductible) tline("Less deductible", money(-f.deductible));
  if (f.previousPayments) tline("Less previous payments", money(-f.previousPayments));
  tline("Estimate total", money(f.total), true);
  body.push(para("", { after: 60 }));
  body.push(table(T, tRows, { header: false, align: "right" }));
  const acc = num(i.accuracyPct);
  if (acc > 0 && f.total > 0) body.push(para(run(`Expected range at ±${qtyText(acc)}%: ${money(f.total * (1 - acc / 100))} – ${money(f.total * (1 + acc / 100))}`, { size: 18, color: GREY }), { before: 80 }));
  if (String(i.duration || "").trim()) body.push(para(run("Estimated duration: " + String(i.duration).trim(), { size: 18, color: GREY })));

  // alternates
  if (f.alternates.length) {
    body.push(heading("Alternates — add to the estimate total"));
    for (const a of f.alternates) {
      body.push(para(run(`ALT ${a.no}  `, { b: true, color: ORANGE, size: 20 }) + run(a.title || "Alternate", { b: true, size: 20 }) +
        run("   " + money(a.amount), { b: true, color: NAVY, size: 20 }), { after: 20, keep: true }));
      if (a.description) body.push(para(run(a.description, { size: 19 })));
    }
  }

  // notes
  if (String(i.notes || "").trim()) {
    body.push(heading("Notes, assumptions & exclusions"));
    body.push(para(run(String(i.notes).trim(), { size: 19 })));
  }

  // disclaimer
  body.push(para(run(isBuild
    ? "This is an estimate of proposed work, not an invoice. Pricing is subject to hidden conditions and signed change orders."
    : "This is an estimate of proposed reconstruction, not an invoice. Pricing subject to hidden-condition supplements and carrier-approved change orders.",
  { size: 17, color: GREY }), { before: 240, border: "" }));
  body.push(para(run(COMPANY.name + " · " + COMPANY.address + " · " + COMPANY.contact, { size: 16, color: GREY }), { after: 0 }));

  const sect = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1080" w:right="1296" w:bottom="1080" w:left="1296" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}${sect}</w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>` +
  `<w:color w:val="1C2733"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `</w:styles>`;
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The whole .docx as ZIP parts (feed to `new Blob(parts, { type: DOCX_MIME })`). */
export function estimateDocx(project, inv, opts = {}) {
  const enc = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", bytes: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: enc.encode(ROOT_RELS) },
    { name: "word/document.xml", bytes: enc.encode(estimateDocumentXml(project, inv, opts)) },
    { name: "word/_rels/document.xml.rels", bytes: enc.encode(DOC_RELS) },
    { name: "word/styles.xml", bytes: enc.encode(STYLES) },
  ]);
}

/** "Estimate RC-KEN-0926 - Kennedy.docx" — safe on every OS */
export function estimateDocxName(project, inv) {
  const bits = ["Estimate", (inv && inv.invoiceNo) || "", (project && (project.customer || project.address)) || ""]
    .map((s) => String(s).trim()).filter(Boolean);
  return bits.join(" - ").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) + ".docx";
}
