/* The carrier packet's renderer: the document model (packet/model.mjs,
   docs/Carrier_Packet_Design.md §5) in, one PDF out (§15).

   renderPacket(model, { label, mode, images, now }) → { bytes, pages, sha256, unavailable }

   - label: { number, version, replaces: { version, sentAt } | null,
     changed: [section titles], built: Date, mode } — what the lane decided
     at build time (none of it is in the model, so none of it moves the hash);
   - mode: "full" (one photo across, two a page) or "compact" (two by two);
   - images: Map(media key → Uint8Array of the decoded JPEG or PNG | null).
     A key with no bytes, or bytes this writer cannot embed (a HEIC, a
     TIFF), prints a gray "Image not available" box; `unavailable` is how
     many keys did, and the card counts those.

   The model decides what prints; this file decides only where. The cover
   is page 1: the field app's letterhead, the packet number and version, a
   version note when this one replaces a sent one, the job and claim facts,
   the contents with each section's page (drawn last, once the sections are
   laid out), the IICRC S500 line and the licenses. Every later page carries
   the running header (number, version, claim, insured) and the footer
   (company, licenses, Page N of M). Sections and their parts are bookmarks.

   Everything is deterministic: the same model, images and label give the
   same bytes. The clock is never read; the build time is the label's, and
   it is printed on the Alaska clock because the worker runs on UTC. */

import { createHash } from "node:crypto";
import { createPdf, C, PAGE, textWidth, wrapText } from "./pdfdoc.mjs";
import { Flow, M, CONTENT_W, BODY_BOTTOM, BODY_H, FRESH } from "./flow.mjs";
import { modelHash } from "./model.mjs";
import { COMPANY } from "../../../apps/field/js/model.js";
import { wallTime } from "../../../apps/field/js/scans.js";

export const PACKET_TITLE = "Water Mitigation Documentation Packet";
export const S500_LINE = "Water mitigation performed and documented in accordance with the IICRC S500 Standard for Professional Water Damage Restoration.";
const ZONE = "America/Anchorage";
const RIGHT = M.l + CONTENT_W;

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : typeof v === "object" ? "" : String(v));
const clean = (v) => str(v).replace(/\s+/g, " ").trim();
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt; };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const validDate = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d : null);

/* palette names in the model → pdfdoc colours */
const COLOR = { black: C.black, sub: C.sub, navy: C.navy, orange: C.orange, red: C.red, green: C.green, gray: C.gray, tag: C.tag };
const FILL = { dry: C.dryFill, wet: C.wetFill, band: C.band, box: C.box };
const FONTS = new Set(["reg", "bold", "ital"]);
const ALIGNS = new Set(["left", "right", "center"]);

/* a stamp or date → MM/DD/YYYY on the Alaska clock ("2026-10-05" prints as typed) */
function akMdy(v) {
  const d = validDate(v);
  const s = d ? d.toISOString() : clean(v);
  const w = (/T\d{2}:\d{2}/.test(s) && wallTime(s)) || s;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(w);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}

/* the water category and class as one line, "Category 2 / Class 3" */
function catClass(cover) {
  const cat = clean(cover.waterCategory), cls = clean(cover.waterClass);
  return [cat && (/^cat/i.test(cat) ? cat : `Category ${cat}`), cls && (/^class/i.test(cls) ? cls : `Class ${cls}`)].filter(Boolean).join(" / ");
}

/* ============================================================
   Blocks → drawing plans
   ============================================================ */

/* A model cell → a flow cell (palette names to colours). */
function cellOf(c) {
  if (!isObj(c)) return str(c);
  const out = { text: str(c.text) };
  if (FONTS.has(c.font)) out.font = c.font;
  if (COLOR[c.color]) out.color = COLOR[c.color];
  if (FILL[c.fill]) out.fill = FILL[c.fill];
  if (ALIGNS.has(c.align)) out.align = c.align;
  if (clean(c.mark)) out.mark = clean(c.mark).slice(0, 3);
  return out;
}

/* One block as { min, heading, lead, draw(keep) }: `min` is the height of
   its first piece (what a heading above it must keep on its page),
   `heading` marks a sub-head and `lead` a short paragraph (two lines at
   most): both travel with the block after them. */
function planBlock(flow, b, ctx) {
  const none = { min: 0, heading: false, draw() {} };
  if (!isObj(b)) return none;
  switch (b.t) {
    case "fields": {
      const pairs = arr(b.pairs).filter(Array.isArray).map(([l, v]) => [str(l), str(v)]);
      const cols = [1, 2, 3].includes(b.cols) ? b.cols : 2;
      return { min: flow.fieldsHeight(pairs, { cols }), heading: false, draw: () => flow.fields(pairs, { cols }) };
    }
    case "subhead": {
      const text = clean(b.text), right = clean(b.right);
      if (!text) return none;
      return { min: flow.subheadHeight(text, right), heading: true, draw: (keep) => flow.subhead(text, { right, keep }) };
    }
    case "para": {
      const o = { size: num(b.size, 5, 16, 9), font: FONTS.has(b.font) ? b.font : "reg", color: COLOR[b.color] || C.black };
      const text = str(b.text);
      const lead = flow.paragraphLineCount(text, o) <= 2;
      return { min: flow.paragraphHeight(text, o), heading: false, lead, draw: () => flow.paragraph(text, o) };
    }
    case "bullets": {
      const items = arr(b.items).map(str);
      return { min: flow.bulletsHeight(items), heading: false, draw: () => flow.bullets(items) };
    }
    case "table": {
      const columns = arr(b.columns).filter(isObj).map((c) => ({ head: str(c.head), w: Number(c.w) || 0, align: ALIGNS.has(c.align) ? c.align : "left" }));
      if (!columns.length) return none;
      // _rows print as of the build (payments, balance) but sit outside the hash
      const rows = [...arr(b.rows), ...arr(b._rows)].map((r) => arr(r).map(cellOf));
      const o = { size: num(b.size, 5, 12, 8), zebra: b.zebra !== false };
      return { min: flow.tableHeight(columns, rows, o), heading: false, draw: () => flow.table(columns, rows, o) };
    }
    case "image": {
      const img = ctx.image(b.media);
      const o = { maxH: num(b.maxH, 40, 700, 300), caption: str(b.caption) };
      return { min: flow.imageHeight(img, o), heading: false, draw: () => flow.image(img, o) };
    }
    case "grid": {
      const items = arr(b.items).filter(isObj).map((it) => ({ img: ctx.image(it.media), caption: Array.isArray(it.caption) ? it.caption.map(str) : str(it.caption) }));
      const o = { perRow: Math.round(num(b.perRow, 1, 6, 3)), boxH: num(b.boxH, 40, 600, 150) };
      return { min: flow.gridHeight(items, o), heading: false, draw: () => flow.imageGrid(items, o) };
    }
    case "photos": {
      const items = arr(b.items).filter(isObj).map((it) => ({ img: ctx.image(it.media), caption: Array.isArray(it.caption) ? it.caption.map(str) : str(it.caption) }));
      if (!items.length) return none;
      const o = ctx.mode === "compact"
        ? { perRow: 2, rowsPerPage: 2, capSize: 8, maxCapLines: 5 }
        : { perRow: 1, rowsPerPage: 2, capSize: 9, maxCapLines: 4 };
      return { min: FRESH * BODY_H, heading: false, draw: () => flow.photos(items, o) };
    }
    case "pages": {
      const items = arr(b.items).filter(isObj);
      if (!items.length) return none;
      return {
        min: FRESH * BODY_H, heading: false,
        draw: () => { for (const it of items) flow.fullPage(ctx.image(it.media), { caption: str(it.caption) }); },
      };
    }
    case "signatures": {
      const items = arr(b.items).filter(isObj).map((it) => {
        const electronic = it.electronic === true;
        const wanted = !electronic && it.media != null && it.media !== "";
        return { label: str(it.label), name: str(it.name), date: str(it.date), electronic, wanted, img: wanted ? ctx.image(it.media) : null };
      });
      if (!items.length) return none;
      return { min: flow.signaturesHeight(items), heading: false, draw: () => flow.signatures(items) };
    }
    case "note": {
      const text = str(b.text);
      if (!clean(text)) return none;
      return { min: flow.noteHeight(text), heading: false, draw: () => flow.note(text) };
    }
    default: {
      // a block this renderer does not know yet still prints its words
      const text = str(b.text);
      if (!clean(text)) return none;
      return { min: flow.paragraphHeight(text), heading: false, draw: () => flow.paragraph(text) };
    }
  }
}

/* what a heading at plans[j-1] must keep with it: the next block's first
   piece, through any run of sub-heads and short lead-in paragraphs */
function keepFrom(plans, j) {
  let h = 0;
  for (let k = j; k < plans.length; k++) {
    h += plans[k].min;
    if (!plans[k].heading && !(plans[k].lead && k + 1 < plans.length)) break;
  }
  return Math.min(h, BODY_H * 0.9);
}

function renderSection(flow, s, ctx) {
  const title = clean(s.title) || clean(s.key) || "Section";
  flow.section(title);
  ctx.sectionStarts.push({ page: flow.pageIndex, title });
  const entry = { key: str(s.key), title, page: flow.pageIndex, parts: [] };
  arr(s.parts).filter(isObj).forEach((part, pi) => {
    const plans = arr(part.blocks).map((b) => planBlock(flow, b, ctx));
    const ptitle = clean(part.title);
    const fresh = pi > 0 && part.newPage === true;
    if (ptitle) {
      flow.part(ptitle, { newPage: fresh, keep: keepFrom(plans, 0) });
      entry.parts.push({ title: ptitle, page: flow.pageIndex });
    } else if (fresh && !flow.blank) flow.newPage();
    plans.forEach((pl, j) => pl.draw(pl.heading ? keepFrom(plans, j + 1) : 0));
  });
  ctx.contents.push(entry);
}

/* ============================================================
   Running header and footer
   ============================================================ */
const FOOT_TEXT = [COMPANY.name, ...arr(COMPANY.licenses)].map(clean).filter(Boolean).join(" · ");

function runningHeader(p, text, section) {
  const hy = PAGE.h - M.t - 8;
  const rw = section ? p.text(RIGHT, hy, section, { size: 7.5, font: "bold", color: C.navy, align: "right", maxWidth: 220 }) : 0;
  p.text(M.l, hy, text, { size: 7.5, color: C.tag, maxWidth: CONTENT_W - rw - 14 });
  p.line(M.l, hy - 5, RIGHT, hy - 5, { width: 0.5, color: C.rule });
}

function runningFooter(p, i, total, text = FOOT_TEXT) {
  const pageText = `Page ${i + 1} of ${total}`;
  const pw = textWidth(pageText, 7.5, "bold");
  const ruleY = BODY_BOTTOM - 6;
  p.line(M.l, ruleY, RIGHT, ruleY, { width: 0.5, color: C.rule });
  wrapText(text, 6.5, "reg", CONTENT_W - pw - 16, { maxLines: 2 })
    .forEach((ln, j) => p.text(M.l, ruleY - 8 - j * 8, ln, { size: 6.5, color: C.sub }));
  p.text(RIGHT, ruleY - 8.5, pageText, { size: 7.5, font: "bold", color: C.navy, align: "right" });
}

/* ============================================================
   The cover
   ============================================================ */

/* A flow drawing on the cover only: it never starts a page. */
function coverFlow(doc, page, y) {
  const f = new Flow(doc);
  f.page = page;
  f.y = y;
  f.top = PAGE.h;
  f.ensure = () => page;
  return f;
}

/* everything on the cover that is known before the sections are laid out;
   returns where the contents go and where the page count goes */
function drawCover(doc, p, { cover, number, version, built, mode, replaces, changed, sections }) {
  let y = PAGE.h - M.t;

  // the letterhead (formkit.js letterhead, print.css .sheet-head)
  const words = clean(COMPANY.name).toUpperCase().split(" ");
  const first = words.shift() || "";
  const nw = p.text(M.l, y - 13, first, { size: 13, font: "bold", color: C.orange, spacing: 0.3 });
  p.text(M.l + nw, y - 13, " " + words.join(" "), { size: 13, font: "bold", color: C.black, spacing: 0.3 });
  p.text(M.l, y - 25, COMPANY.tagline, { size: 7.5, color: C.tag, maxWidth: CONTENT_W * 0.6 });
  p.text(RIGHT, y - 10.5, COMPANY.address, { size: 7.5, color: C.tag, align: "right" });
  p.text(RIGHT, y - 20, `${COMPANY.phone} | ${COMPANY.email}`, { size: 7.5, color: C.tag, align: "right" });
  p.text(RIGHT, y - 29.5, COMPANY.web, { size: 7.5, color: C.tag, align: "right" });
  p.line(M.l, y - 37, RIGHT, y - 37, { width: 2.5, color: C.navy });
  y -= 37 + 14;

  // the title
  wrapText(PACKET_TITLE.toUpperCase(), 16, "bold", CONTENT_W, { maxLines: 2 }).forEach((ln) => {
    p.text(PAGE.w / 2, y - 16, ln, { size: 16, font: "bold", color: C.navy, align: "center", spacing: 0.5 });
    y -= 20;
  });
  const sub = [clean(cover.carrier) && `Prepared for ${clean(cover.carrier)}`, clean(cover.claimNo) && `Claim ${clean(cover.claimNo)}`].filter(Boolean).join(" · ");
  if (sub) { p.text(PAGE.w / 2, y - 9, sub, { size: 9, color: C.sub, align: "center", maxWidth: CONTENT_W }); y -= 14; }
  y -= 10;

  // the packet number and version, prominently
  const boxH = 52;
  p.rect(M.l, y - boxH, CONTENT_W, boxH, { stroke: C.navy, width: 1.5 });
  p.rect(M.l, y - boxH, 5, boxH, { fill: C.orange });
  const cells = [
    { label: "Packet number", w: 0.38, value: number || "—", size: 19, font: "bold", color: C.navy },
    { label: "Version", w: 0.18, value: `v${version}`, size: 19, font: "bold", color: C.orange },
    { label: "Prepared", w: 0.24, value: built ? akMdy(built) : "", size: 12, font: "reg", color: C.black },
    { label: "Pages", w: 0.2, value: null, size: 12, font: "reg", color: C.black },
  ];
  let x = M.l + 5, pagesAt = null;
  cells.forEach((c, i) => {
    const w = (CONTENT_W - 5) * c.w;
    if (i) p.line(x, y - 8, x, y - boxH + 8, { width: 0.5, color: C.rule });
    p.text(x + 12, y - 14, c.label.toUpperCase(), { size: 6.8, font: "bold", color: C.sub, spacing: 0.3 });
    if (c.value == null) pagesAt = { x: x + 12, y: y - 37, size: c.size };
    else p.text(x + 12, y - 37, c.value, { size: c.size, font: c.font, color: c.color, maxWidth: w - 18 });
    x += w;
  });
  y -= boxH + 8;

  if (mode === "compact") {
    for (const ln of wrapText("Photos in this packet are reduced in size to keep it within carrier email limits; full-size photos are available on request.", 8, "ital", CONTENT_W)) {
      p.text(M.l, y - 8, ln, { size: 8, font: "ital", color: C.sub });
      y -= 10;
    }
    y -= 4;
  }

  // what this version replaces
  if (version > 1 || replaces) {
    const was = replaces ? Number(replaces.version) || version - 1 : version - 1;
    const sent = replaces ? akMdy(replaces.sentAt) : "";
    const list = arr(changed).map(clean).filter(Boolean);
    const text = `This version replaces version ${was}${sent ? ` sent ${sent}` : ""}.` + (list.length ? ` Changed: ${list.join(", ")}.` : "");
    const lines = wrapText(text, 9, "bold", CONTENT_W - 20, { maxLines: 5 });
    const h = lines.length * 12 + 10;
    p.rect(M.l, y - h, CONTENT_W, h, { fill: C.wetFill });
    p.rect(M.l, y - h, 3, h, { fill: C.orange });
    lines.forEach((ln, j) => p.text(M.l + 11, y - 5 - 9 * 0.9 - j * 12, ln, { size: 9, font: "bold", color: C.navy }));
    y -= h + 10;
  }

  // the foot of the cover: the S500 line, licenses, who prepared it
  const foot = [
    ...wrapText(S500_LINE, 8, "bold", CONTENT_W).map((t) => ({ t, size: 8, font: "bold", color: C.navy })),
    ...wrapText(`Licenses & certifications: ${arr(COMPANY.licenses).join(" · ")}`, 7.5, "reg", CONTENT_W).map((t) => ({ t, size: 7.5, font: "reg", color: C.tag })),
    ...wrapText(`Prepared by ${[COMPANY.signatory, COMPANY.signatoryTitle].filter(Boolean).join(", ")} · ${COMPANY.name}`, 7.5, "reg", CONTENT_W).map((t) => ({ t, size: 7.5, font: "reg", color: C.tag })),
  ];
  const footH = foot.length * 10.5 + 8;
  const footTop = BODY_BOTTOM + footH;
  p.line(M.l, footTop, RIGHT, footTop, { width: 0.8, color: C.navy });
  foot.forEach((ln, j) => p.text(M.l, footTop - 6 - ln.size * 0.9 - j * 10.5, ln.t, { size: ln.size, font: ln.font, color: ln.color }));

  // the job and claim facts, two lines each unless that would leave the
  // contents less than a 12 pt row a section: then one line each
  const facts = [
    ["Insured", cover.customer], ["Property", cover.address],
    ["Claim #", cover.claimNo], ["Carrier", cover.carrier],
    ["Adjuster", cover.adjuster], ["Date of loss", cover.dateOfLoss],
    ["Cause of loss", cover.lossCause], ["Work order #", cover.workOrderNo],
    ["Water category / class", catClass(cover)],
    ...arr(cover.facts).filter(Array.isArray).map(([l, v]) => [str(l), str(v)]),
  ].map(([l, v]) => [l, str(v)]);
  const f = coverFlow(doc, p, y);
  f.part("Job and claim details", { bookmark: null });
  const need = f.partHeight("Contents") + Math.max(1, sections) * 12;
  const left = f.y - f.fieldsTotalHeight(facts, { cols: 2, maxLines: 2, after: 2 }) - 4 - (footTop + 8);
  f.fields(facts, { cols: 2, maxLines: left >= need ? 2 : 1, after: 2 });
  y = f.y;

  return { contentsTop: y - 4, contentsBottom: footTop + 8, pagesAt };
}

/* the contents: each section and its parts with their page numbers, each
   line a link to its page. Parts fold into a count when they will not fit. */
const PART_NOUN = { maps: ["map", "maps"], logs: ["log", "logs"], docs: ["document", "documents"], invoices: ["invoice", "invoices"] };

function drawContents(doc, p, at, contents, counts) {
  const f = coverFlow(doc, p, at.contentsTop);
  f.part("Contents", { bookmark: null });
  let y = f.y;
  const room = y - at.contentsBottom;
  const partsOf = (s) => (s.parts.length === 1 && s.parts[0].title === s.title ? [] : s.parts);
  const height = (sec, part, gap) => contents.reduce((n, s) => n + sec + (partsOf(s).length ? partsOf(s).length * part + gap : 0), 0);
  // the parts are listed at the usual leading, else at a tighter one, and only
  // folded into a count ("2 maps") when even that will not fit on the cover
  const tight = height(14, 11.5, 3) > room;
  const SEC = tight ? 12 : 14, PART = tight ? 10 : 11.5, GAP = tight ? 2 : 3;
  const withParts = height(SEC, PART, GAP) <= room;
  const lead = withParts ? SEC : contents.length * 14 > room ? Math.max(9, room / Math.max(1, contents.length)) : 14;
  const detail = (s) => {
    const c = isObj(counts) ? counts : {};
    if (s.key === "maps" && c.maps) return [plural(c.maps, "map"), c.readings ? plural(c.readings, "reading") : "", c.meterPhotos ? plural(c.meterPhotos, "meter photo") : ""].filter(Boolean).join(" · ");
    if (s.key === "logs" && c.logs) return [plural(c.logs, "log"), c.equipment ? plural(c.equipment, "unit") : ""].filter(Boolean).join(" · ");
    if (s.key === "photos" && c.photos) return plural(c.photos, "photo");
    if (!withParts && s.parts.length > 1) { const n = PART_NOUN[s.key] || ["part", "parts"]; return `${s.parts.length} ${n[1]}`; }
    return "";
  };
  const row = (title, page, { size, font, indent, sub = "", pitch }) => {
    const pn = String(page + 1);
    const pw = textWidth(pn, size, "bold");
    const x = M.l + indent;
    const tw = p.text(x, y - size, title, { size, font, color: C.navy, maxWidth: RIGHT - pw - 24 - x });
    let end = x + tw;
    if (sub) end += 6 + p.text(end + 6, y - size, sub, { size: size - 1.5, color: C.sub, maxWidth: Math.max(0, RIGHT - pw - 24 - end - 6) });
    if (RIGHT - pw - 6 > end + 8) p.line(end + 4, y - size + 1, RIGHT - pw - 4, y - size + 1, { width: 0.7, color: C.gray, dash: [0.8, 2.2] });
    p.text(RIGHT, y - size, pn, { size, font: "bold", color: C.navy, align: "right" });
    // no taller than the row's pitch, so two rows' links never overlap
    p.link(M.l, y - size - 3, CONTENT_W, Math.min(size + 5, pitch), { page });
  };
  for (const s of contents) {
    row(s.title, s.page, { size: 9.5, font: "bold", indent: 0, sub: detail(s), pitch: lead });
    y -= lead;
    if (!withParts || !partsOf(s).length) continue;
    for (const pt of partsOf(s)) { row(pt.title, pt.page, { size: 8.5, font: "reg", indent: 14, pitch: PART }); y -= PART; }
    y -= GAP;
  }
  if (!contents.length) p.text(M.l, y - 9, "No sections are included in this packet.", { size: 9, font: "ital", color: C.sub });
}

/* ============================================================
   The packet
   ============================================================ */

/** renderPacket(model, { label, mode, images, now }) → { bytes, pages, sha256, unavailable } */
export function renderPacket(model, { label = {}, mode, images, now } = {}) {
  const m = isObj(model) ? model : {};
  const lb = isObj(label) ? label : {};
  const cover = isObj(m.cover) ? m.cover : {};
  const photoMode = (mode || lb.mode) === "compact" ? "compact" : "full";
  const built = validDate(lb.built) || validDate(now);
  const number = clean(lb.number);
  const version = Math.max(1, Math.floor(Number(lb.version) || 1));
  const replaces = isObj(lb.replaces) ? lb.replaces : null;
  const store = images instanceof Map ? images : new Map(Object.entries(isObj(images) ? images : {}));

  const doc = createPdf();
  const seen = new Map();
  const image = (key) => {
    if (key == null || key === "" || typeof key === "object") return null;
    const k = String(key);
    if (!seen.has(k)) {
      const bytes = store.get(k);
      seen.set(k, bytes && bytes.length ? doc.image(bytes, k) : null);
    }
    return seen.get(k);
  };

  const headText = [number, `v${version}`, clean(cover.claimNo) && `Claim ${clean(cover.claimNo)}`, clean(cover.customer)].filter(Boolean).join(" · ");
  const ctx = { mode: photoMode, image, sectionStarts: [], contents: [] };
  const sectionOf = (i) => { let t = ""; for (const s of ctx.sectionStarts) if (s.page <= i) t = s.title; return t; };

  const coverPage = doc.addPage();
  const at = drawCover(doc, coverPage, { cover, number, version, built, mode: photoMode, replaces, changed: lb.changed,
    sections: arr(m.sections).filter(isObj).length });

  const flow = new Flow(doc, {
    header: (p, i) => runningHeader(p, headText, sectionOf(i)),
    footer: (p, i, total) => runningFooter(p, i, total),
  });
  for (const s of arr(m.sections)) if (isObj(s)) renderSection(flow, s, ctx);
  const bookmarks = flow.finish();

  const total = doc.pages.length;
  drawContents(doc, coverPage, at, ctx.contents, m.counts);
  if (at.pagesAt) coverPage.text(at.pagesAt.x, at.pagesAt.y, String(total), { size: at.pagesAt.size });
  runningFooter(coverPage, 0, total, [COMPANY.name, COMPANY.web].filter(Boolean).join(" · "));
  doc.outline(bookmarks);

  let hash = clean(lb.hash) || clean(m._hash);
  if (!hash) { try { hash = modelHash(m); } catch { hash = ""; } }
  const customer = clean(cover.customer);
  const bytes = doc.finish({
    title: [PACKET_TITLE, customer, number && `${number} v${version}`].filter(Boolean).join(" - "),
    subject: number ? `${number} v${version}` : `v${version}`,
    author: COMPANY.name,
    keywords: ["water mitigation", "IICRC S500", "carrier packet", number, clean(cover.claimNo) && `claim ${clean(cover.claimNo)}`, clean(cover.carrier)].filter(Boolean).join(", "),
    creator: "Roybal Field Forms",
    producer: "Roybal Field Forms packet writer",
    created: built,
    timeZone: ZONE,
    custom: { PacketNumber: number, PacketVersion: String(version), ModelHash: hash },
  });
  // every image key that printed as the gray box, each once
  const unavailable = [...seen.values()].filter((img) => img == null).length;
  return { bytes, pages: total, sha256: createHash("sha256").update(bytes).digest("hex"), unavailable };
}
