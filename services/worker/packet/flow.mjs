/* Flow layout for the carrier packet: a cursor that runs down the page and
   starts a new one when the next block will not fit, on top of pdfdoc.mjs.

   Blocks: section bands (navy, one per packet section, a bookmark),
   part heads (the print.css h2: light band, orange bar, a child bookmark),
   sub-heads, paragraphs, bullets, key/value grids, tables that split across
   pages and repeat their header row, single images, image grids with
   captions, photo pages (one or two across, two rows a page), full-page
   uploaded documents, signature lines and boxed notes. Every page this
   flow starts gets the running header and footer drawn at the end, when
   the page count is known ("Page N of M").

   Headings never sit alone at the bottom of a page: each heading takes a
   `keep`, the height of the first piece of what follows it (the renderer
   measures it with the *Height helpers here, which share their arithmetic
   with the drawing), and moves to the next page with it. A block never
   starts a new page from an empty one, so nothing makes a blank page.

   Coordinates: PDF points, origin bottom-left. `this.y` is the top of the
   free space on the current page. */

import { PAGE, C, textWidth, wrapText } from "./pdfdoc.mjs";

export const M = { l: 36, r: 36, t: 36, b: 39.6 };              // @page .5in .5in .55in
export const CONTENT_W = PAGE.w - M.l - M.r;                    // 540
export const HEAD_H = 20;                                       // running header band
export const FOOT_H = 24;                                       // running footer: a rule and two small lines
export const BODY_TOP = PAGE.h - M.t - HEAD_H;
export const BODY_BOTTOM = M.b + FOOT_H;
export const BODY_H = BODY_TOP - BODY_BOTTOM;
/* A page with this much of its body still free counts as fresh: an uploaded
   page or a photo page uses it (under its section band) instead of leaving
   the band alone on a page of its own. */
export const FRESH = 0.85;

const RIGHT = M.l + CONTENT_W;
const clean = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
const arr = (v) => (Array.isArray(v) ? v : []);
const upper = (s) => clean(s).toUpperCase();

/* heights of the fixed pieces */
const SECTION_H = 22, SECTION_AFTER = 10;
const PART_LEAD = 12, PART_PAD = 6, PART_AFTER = 8;
const SUB_LEAD = 11.5, SUB_AFTER = 6;
const SIG_H = 44;
const MISSING = "Image not available";

/* a gray box where an image should be */
function placeholder(p, x, y, w, h, text = MISSING) {
  p.rect(x, y, w, h, { fill: C.placeholder, stroke: C.border, width: 0.5 });
  p.text(x + w / 2, y + h / 2 - 3, text, { size: Math.min(9, Math.max(6.5, h / 6)), font: "ital", color: C.sub, align: "center", maxWidth: w - 8 });
}

/* "[prefix, rest]" or "text" → { prefix, rest } */
const capParts = (cap) => (Array.isArray(cap) ? { prefix: clean(cap[0]), rest: clean(cap[1]) } : { prefix: "", rest: clean(cap) });

/* caption lines for a box `w` wide; the bold prefix sits on the first line */
function captionLines(cap, size, w, maxLines) {
  const { prefix, rest } = capParts(cap);
  if (!prefix && !rest) return { prefix, preW: 0, lines: [] };
  const preW = prefix ? textWidth(prefix + " ", size, "bold") : 0;
  const lines = rest ? wrapText(rest, size, "reg", w, { firstWidth: Math.max(10, w - preW), maxLines }) : [""];
  return { prefix, preW, lines };
}
function drawCaption(p, x, y, cap, size, lead) {
  if (cap.prefix) p.text(x, y, cap.prefix, { size, font: "bold", color: C.navy });
  cap.lines.forEach((ln, j) => {
    if (ln) p.text(x + (j === 0 ? cap.preW : 0), y, ln, { size });
    y -= lead;
  });
}

export class Flow {
  /* header(page, i, total) and footer(page, i, total) draw the running
     bands; they are called for every page this flow made, at finish(). */
  constructor(doc, { header = null, footer = null } = {}) {
    this.doc = doc;
    this.header = header;
    this.footer = footer;
    this.page = null;
    this.y = BODY_TOP;
    this.top = BODY_TOP;
    this.bookmarks = [];                                        // [{ title, page, children }]
    this.flowPages = new Set();                                 // page indexes that get bands
  }

  get pageIndex() { return this.page ? this.page.index : -1; }

  newPage({ bands = true } = {}) {
    this.page = this.doc.addPage();
    if (bands) this.flowPages.add(this.page.index);
    this.y = this.top = bands ? BODY_TOP : PAGE.h - M.t;
    return this.page;
  }

  /* free height left on this page */
  get room() { return this.page ? this.y - BODY_BOTTOM : 0; }
  /* nothing drawn on this page yet */
  get blank() { return !this.page || this.y >= this.top - 0.5; }
  /* most of the page still free (only a heading on it) */
  get fresh() { return !!this.page && this.room >= FRESH * BODY_H; }

  /* make sure h points fit below the cursor; start a page if not (never
     from a blank page: a block taller than a page draws there and clips) */
  ensure(h) {
    if (!this.page || (this.y - h < BODY_BOTTOM && !this.blank)) this.newPage();
    return this.page;
  }

  space(h) { this.y -= h; }

  #mark(title, child) {
    if (!title) return;
    const mark = { title: clean(title), page: this.page.index, children: [] };
    if (child && this.bookmarks.length) this.bookmarks[this.bookmarks.length - 1].children.push(mark);
    else this.bookmarks.push(mark);
  }

  /* ---------- headings ---------- */

  /* a packet section: a navy band with an orange bar, on a new page */
  section(title, { newPage = true, bookmark = title, keep = 0 } = {}) {
    if (newPage || !this.page) this.newPage();
    else this.ensure(SECTION_H + SECTION_AFTER + keep);
    const p = this.page;
    p.rect(M.l, this.y - SECTION_H, CONTENT_W, SECTION_H, { fill: C.navy });
    p.rect(M.l, this.y - SECTION_H, 4, SECTION_H, { fill: C.orange });
    p.text(M.l + 12, this.y - 15.2, upper(title), { size: 11.5, font: "bold", color: C.white, spacing: 0.6, maxWidth: CONTENT_W - 20 });
    this.y -= SECTION_H + SECTION_AFTER;
    this.#mark(bookmark, false);
    return p;
  }

  partHeight(title) {
    return wrapText(upper(title), 10, "bold", CONTENT_W - 16, { maxLines: 2 }).length * PART_LEAD + PART_PAD + PART_AFTER;
  }

  /* a part of a section (one moisture map, one log, one invoice): the
     print.css h2 — uppercase navy on a light band, orange left bar */
  part(title, { newPage = false, bookmark = title, keep = 0 } = {}) {
    const lines = wrapText(upper(title), 10, "bold", CONTENT_W - 16, { maxLines: 2 });
    const h = lines.length * PART_LEAD + PART_PAD;
    if (newPage || !this.page) this.newPage();
    else this.ensure(h + PART_AFTER + keep);
    const p = this.page;
    p.rect(M.l, this.y - h, CONTENT_W, h, { fill: C.band });
    p.rect(M.l, this.y - h, 3, h, { fill: C.orange });
    lines.forEach((ln, i) => p.text(M.l + 9, this.y - 12.4 - i * PART_LEAD, ln, { size: 10, font: "bold", color: C.navy, spacing: 0.5 }));
    this.y -= h + PART_AFTER;
    this.#mark(bookmark, true);
    return p;
  }

  subheadHeight(title, right = "") {
    const rw = right ? textWidth(right, 7.5) + 10 : 0;
    return wrapText(clean(title), 9.5, "bold", CONTENT_W - rw, { maxLines: 2 }).length * SUB_LEAD + 4 + SUB_AFTER;
  }

  /* a smaller navy heading with a rule under it, an optional note at the right */
  subhead(title, { keep = 0, right = "" } = {}) {
    const rw = right ? textWidth(right, 7.5) + 10 : 0;
    const lines = wrapText(clean(title), 9.5, "bold", CONTENT_W - rw, { maxLines: 2 });
    const h = lines.length * SUB_LEAD + 4;
    this.ensure(h + SUB_AFTER + keep);
    const p = this.page;
    lines.forEach((ln, i) => p.text(M.l, this.y - 10 - i * SUB_LEAD, ln, { size: 9.5, font: "bold", color: C.navy }));
    if (right) p.text(RIGHT, this.y - 10 - (lines.length - 1) * SUB_LEAD, right, { size: 7.5, color: C.sub, align: "right", maxWidth: CONTENT_W / 2 });
    p.line(M.l, this.y - h + 0.5, RIGHT, this.y - h + 0.5, { width: 0.8, color: C.navy });
    this.y -= h + SUB_AFTER;
  }

  /* ---------- text ---------- */

  #paraLines(text, size, font, width) {
    const lines = [];
    for (const para of String(text == null ? "" : text).split(/\n/)) {
      const t = para.replace(/\s+/g, " ").trim();
      if (!t) { lines.push(""); continue; }
      lines.push(...wrapText(t, size, font, width));
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    while (lines.length && !lines[0]) lines.shift();
    return lines;
  }

  paragraphLineCount(text, { size = 9, font = "reg", indent = 0 } = {}) {
    return this.#paraLines(text, size, font, CONTENT_W - indent).length;
  }

  /* the first two lines (a paragraph never leaves one line behind) */
  paragraphHeight(text, { size = 9, font = "reg", lead = null, indent = 0 } = {}) {
    return Math.min(2, this.paragraphLineCount(text, { size, font, indent })) * (lead || size * 1.3);
  }

  paragraph(text, { size = 9, font = "reg", color = C.black, lead = null, indent = 0, width = CONTENT_W, after = 5 } = {}) {
    const lh = lead || size * 1.3;
    const lines = this.#paraLines(text, size, font, width - indent);
    if (!lines.length) return;
    // no widow: the first two lines go together, and so do the last two
    this.ensure(Math.min(2, lines.length) * lh);
    lines.forEach((ln, i) => {
      const left = lines.length - i;
      if (this.y - lh < BODY_BOTTOM || (left === 2 && this.y - 2 * lh < BODY_BOTTOM && i > 0 && lines.length > 3)) this.newPage();
      if (ln) this.page.text(M.l + indent, this.y - size, ln, { size, font, color });
      this.y -= lh;
    });
    this.y -= after;
  }

  bulletsHeight(items, { size = 9 } = {}) {
    const first = arr(items).find((t) => clean(t));
    return first ? Math.min(2, wrapText(clean(first), size, "reg", CONTENT_W - 14).length) * size * 1.3 : 0;
  }

  /* bullet list */
  bullets(items, { size = 9, color = C.black, after = 5 } = {}) {
    const lh = size * 1.3;
    for (const it of arr(items)) {
      const t = clean(it);
      if (!t) continue;
      const lines = wrapText(t, size, "reg", CONTENT_W - 14);
      this.ensure(Math.min(2, lines.length) * lh);
      lines.forEach((ln, i) => {
        this.ensure(lh);
        if (i === 0) this.page.text(M.l + 3, this.y - size, "•", { size, color: C.orange, font: "bold" });
        this.page.text(M.l + 14, this.y - size, ln, { size, color });
        this.y -= lh;
      });
      this.y -= 1.5;
    }
    this.y -= after;
  }

  /* ---------- key/value grid ----------
     label/value cells in `cols` columns, the job-information look: small
     uppercase label, value under it, a hairline below. pairs: [[label,
     value]]. A blank value leaves the hairline empty, as on the paper form. */
  #fieldRows(pairs, cols, size, maxLines) {
    const list = arr(pairs).filter((p) => Array.isArray(p) && clean(p[0]));
    const gap = 14;
    const colW = (CONTENT_W - gap * (cols - 1)) / cols;
    const lead = size * 1.22;
    const rows = [];
    for (let i = 0; i < list.length; i += cols) {
      const cells = list.slice(i, i + cols).map(([label, value]) => ({
        label: wrapText(upper(label), 6.8, "bold", colW, { maxLines: 2 }),
        lines: clean(value) ? wrapText(clean(value), size, "reg", colW, { maxLines }) : [],
      }));
      const labH = Math.max(...cells.map((c) => c.label.length)) * 8;
      const h = labH + 2 + Math.max(1, ...cells.map((c) => c.lines.length)) * lead + 4;
      rows.push({ cells, labH, h });
    }
    return { rows, colW, gap, lead };
  }

  fieldsHeight(pairs, { cols = 2, size = 9, maxLines = 8 } = {}) {
    const { rows } = this.#fieldRows(pairs, Math.max(1, cols), size, maxLines);
    return rows.length ? rows[0].h + 5 : 0;
  }

  fields(pairs, { cols = 2, size = 9, maxLines = 8, after = 6 } = {}) {
    const { rows, colW, gap, lead } = this.#fieldRows(pairs, Math.max(1, cols), size, maxLines);
    if (!rows.length) return;
    for (const row of rows) {
      this.ensure(row.h);
      const p = this.page;
      row.cells.forEach((c, k) => {
        const x = M.l + k * (colW + gap);
        c.label.forEach((ln, j) => p.text(x, this.y - 6.8 - j * 8, ln, { size: 6.8, font: "bold", color: C.sub, spacing: 0.3 }));
        c.lines.forEach((ln, j) => p.text(x, this.y - row.labH - 2 - size * 0.95 - j * lead, ln, { size }));
        p.line(x, this.y - row.h + 1, x + colW, this.y - row.h + 1, { width: 0.5, color: C.border });
      });
      this.y -= row.h + 5;
    }
    this.y -= after;
  }

  /* ---------- tables ----------
     columns: [{ head, w (points, or a fraction of the width when ≤ 1),
                 align: left|right|center, font, size }]
     rows: arrays of cells; a cell is a string, or { text, font, color,
           fill, align, mark, markColor } (colours as pdfdoc C operands;
           mark: a small superscript after the text).
     Columns wider than the page in sum are scaled to fit. Rows never
     split; a row taller than a page is cut to its first lines with an
     ellipsis. The header row repeats on every page the table reaches. */
  #tableLayout(columns, { size = 8, headSize = null, pad = 2.5 } = {}) {
    const cols = arr(columns);
    const hs = headSize || size;
    const raw = cols.map((c) => { const w = Number(c && c.w) || 0; return w > 0 && w <= 1 ? w * CONTENT_W : Math.max(0, w); });
    const total = raw.reduce((n, w) => n + w, 0) || 1;
    // wider than the page: shrink to fit; fractions that nearly fill it
    // (rounded by hand, 0.96 of the width) fill it
    const fractional = cols.every((c) => { const w = Number(c && c.w) || 0; return w > 0 && w <= 1; });
    const scale = total > CONTENT_W + 0.5 || (fractional && total >= 0.9 * CONTENT_W) ? CONTENT_W / total : 1;
    const widths = raw.map((w) => w * scale);
    const tableW = widths.reduce((a, b) => a + b, 0);
    const xs = [];
    widths.reduce((x, w) => { xs.push(x); return x + w; }, M.l);
    const headLines = cols.map((c, i) => wrapText(clean(c && c.head), hs, "bold", Math.max(4, widths[i] - pad * 2), { maxLines: 3 }));
    const headH = Math.max(1, ...headLines.map((l) => l.length)) * hs * 1.15 + pad * 2;
    const maxRowH = BODY_H - headH - 4;
    const lh = size * 1.22;
    const cellOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { text: v });
    const layoutRow = (row) => {
      const cells = cols.map((c, i) => {
        const cell = cellOf(arr(row)[i]);
        const font = cell.font || (c && c.font) || "reg";
        const sz = cell.size || (c && c.size) || size;
        const mark = clean(cell.mark);
        const markW = mark ? textWidth(mark, sz * 0.7, "bold") + 1 : 0;
        const lines = wrapText(clean(cell.text), sz, font, Math.max(4, widths[i] - pad * 2 - markW));
        return { ...cell, font, sz, lines, mark, markW, align: cell.align || (c && c.align) || "left" };
      });
      let h = Math.max(lh, ...cells.map((c) => c.lines.length * c.sz * 1.22)) + pad * 2;
      if (h > maxRowH) {
        const keep = Math.max(1, Math.floor((maxRowH - pad * 2) / lh));
        for (const c of cells) {
          if (c.lines.length <= keep) continue;
          c.lines.length = keep;
          let last = c.lines[keep - 1];
          const room = Math.max(4, widths[cells.indexOf(c)] - pad * 2 - c.markW);
          while (last && textWidth(last + " …", c.sz, c.font) > room) last = last.slice(0, -1);
          c.lines[keep - 1] = last + " …";
        }
        h = maxRowH;
      }
      return { cells, h };
    };
    return { cols, hs, pad, widths, xs, tableW, headLines, headH, lh, layoutRow };
  }

  tableHeight(columns, rows, opts = {}) {
    const L = this.#tableLayout(columns, opts);
    const first = arr(rows).slice(0, Math.max(1, opts.minRows ?? 2)).map(L.layoutRow);
    return L.headH + (first.length ? first.reduce((n, r) => n + r.h, 0) : L.lh + L.pad * 2) + 2;
  }

  table(columns, rows, { size = 8, headSize = null, pad = 2.5, zebra = true, after = 8, minRows = 2, empty = "None recorded." } = {}) {
    const L = this.#tableLayout(columns, { size, headSize, pad });
    const list = arr(rows);
    if (!L.cols.length) return;
    let segTop = 0;
    const closeSeg = () => {
      // the outer frame of this page's piece of the table
      this.page.rect(M.l, this.y, L.tableW, segTop - this.y, { stroke: C.border, width: 0.6 });
    };
    const drawHead = () => {
      const p = this.page;
      segTop = this.y;
      p.rect(M.l, this.y - L.headH, L.tableW, L.headH, { fill: C.navy });
      L.cols.forEach((c, i) => {
        const al = (c && c.align) || "left";
        const x = L.xs[i], w = L.widths[i];
        L.headLines[i].forEach((ln, j) => {
          const ty = this.y - L.pad - L.hs * 0.85 - j * L.hs * 1.15;
          const tx = al === "right" ? x + w - L.pad : al === "center" ? x + w / 2 : x + L.pad;
          p.text(tx, ty, ln, { size: L.hs, font: "bold", color: C.white, align: al });
        });
        if (i) p.line(x, this.y, x, this.y - L.headH, { width: 0.4, color: C.border });
      });
      this.y -= L.headH;
    };

    const laid = list.map(L.layoutRow);
    const first = laid.slice(0, minRows);
    this.ensure(L.headH + (first.length ? first.reduce((n, r) => n + r.h, 0) : L.lh + pad * 2) + 2);
    drawHead();
    let zi = 0, onPage = 0;
    // the last rows go to a page together, so a split never leaves one alone
    const tail = laid.length > minRows * 2 ? laid.length - minRows : -1;
    const tailH = tail >= 0 ? laid.slice(tail).reduce((n, r) => n + r.h, 0) : 0;
    laid.forEach(({ cells, h }, ri) => {
      const split = this.y - h < BODY_BOTTOM || (ri === tail && onPage >= minRows && this.y - tailH < BODY_BOTTOM && tailH <= BODY_H - L.headH);
      if (split) { closeSeg(); this.newPage(); drawHead(); zi = 0; onPage = 0; }
      const p = this.page;
      const top = this.y, bottom = this.y - h;
      if (zebra && zi % 2 === 1) p.rect(M.l, bottom, L.tableW, h, { fill: C.box });
      cells.forEach((c, i) => {
        const x = L.xs[i], w = L.widths[i];
        if (c.fill) p.rect(x, bottom, w, h, { fill: c.fill });
        c.lines.forEach((ln, j) => {
          const ty = top - pad - c.sz * 0.85 - j * c.sz * 1.22;
          const lw = textWidth(ln, c.sz, c.font);
          const mw = j === c.lines.length - 1 ? c.markW : 0;
          const tx = c.align === "right" ? x + w - pad - lw - mw : c.align === "center" ? x + (w - lw - mw) / 2 : x + pad;
          p.text(tx, ty, ln, { size: c.sz, font: c.font, color: c.color || C.black });
          if (c.mark && j === c.lines.length - 1) {
            p.text(tx + lw + 1, ty + c.sz * 0.38, c.mark, { size: c.sz * 0.7, font: "bold", color: c.markColor || C.orange });
          }
        });
        if (i) p.line(x, top, x, bottom, { width: 0.4, color: C.rule });
      });
      p.line(M.l, bottom, M.l + L.tableW, bottom, { width: 0.4, color: C.rule });
      this.y = bottom;
      zi++;
      onPage++;
    });
    if (!list.length) {
      const h = L.lh + pad * 2;
      this.page.text(M.l + pad, this.y - pad - size * 0.85, empty, { size, font: "ital", color: C.sub });
      this.y -= h;
    }
    closeSeg();
    this.y -= after;
  }

  /* ---------- images ---------- */

  #imageBox(img, maxH, caption) {
    const capLines = clean(caption) ? wrapText(clean(caption), 7.5, "ital", CONTENT_W, { maxLines: 3 }) : [];
    const capH = capLines.length ? 3 + capLines.length * 9.5 : 0;
    const limit = Math.max(40, Math.min(Number(maxH) || 300, BODY_H - capH - 12));
    let w, h;
    if (img && img.width && img.height) {
      const s = Math.min(CONTENT_W / img.width, limit / img.height);
      w = img.width * s; h = img.height * s;
    } else { w = CONTENT_W; h = Math.min(limit, 110); }
    return { w, h, capLines, capH, total: h + capH + 8 };
  }

  imageHeight(img, { maxH = 300, caption = "" } = {}) { return this.#imageBox(img, maxH, caption).total; }

  /* one image fit to the content width and maxH, centred, caption under it;
     no image prints the gray "Image not available" box */
  image(img, { maxH = 300, caption = "", missing = MISSING } = {}) {
    const b = this.#imageBox(img, maxH, caption);
    this.ensure(b.total);
    const p = this.page;
    const x = M.l + (CONTENT_W - b.w) / 2, y = this.y - b.h;
    if (img) {
      p.image(img, x, y, b.w, b.h);
      p.rect(x, y, b.w, b.h, { stroke: C.rule, width: 0.5 });
    } else placeholder(p, x, y, b.w, b.h, missing);
    b.capLines.forEach((ln, j) => p.text(PAGE.w / 2, y - 3 - 7.5 - j * 9.5, ln, { size: 7.5, font: "ital", color: C.sub, align: "center" }));
    this.y -= b.total;
  }

  #gridRow(items, cellW, capSize, maxCapLines) {
    const caps = items.map((it) => captionLines(it.caption, capSize, cellW - 8, maxCapLines));
    const n = Math.max(0, ...caps.map((c) => c.lines.length));
    return { caps, capH: n ? 5 + n * capSize * 1.25 + 2 : 0 };
  }

  gridHeight(items, { perRow = 3, boxH = 150, gap = 8, capSize = 7.5, maxCapLines = 3 } = {}) {
    const list = arr(items);
    if (!list.length) return 0;
    const per = Math.max(1, perRow);
    const cellW = (CONTENT_W - gap * (per - 1)) / per;
    const { capH } = this.#gridRow(list.slice(0, per), cellW, capSize, maxCapLines);
    return Math.min(boxH, BODY_H - capH - 12) + capH;
  }

  /* a grid of captioned images. items: [{ img (from doc.image) | null,
     caption: [boldPrefix, rest] | string, missing: "why" }]. Each row is as
     tall as its longest caption needs. */
  imageGrid(items, { perRow = 3, boxH = 150, gap = 8, capSize = 7.5, maxCapLines = 3, after = 8 } = {}) {
    const list = arr(items);
    if (!list.length) return;
    const per = Math.max(1, perRow);
    const cellW = (CONTENT_W - gap * (per - 1)) / per;
    const lead = capSize * 1.25;
    for (let i = 0; i < list.length; i += per) {
      const row = list.slice(i, i + per);
      const { caps, capH } = this.#gridRow(row, cellW, capSize, maxCapLines);
      const bh = Math.min(boxH, BODY_H - capH - 12);
      const cellH = bh + capH;
      this.ensure(cellH);
      const p = this.page;
      const top = this.y;
      row.forEach((it, k) => {
        const x = M.l + k * (cellW + gap);
        p.rect(x + 0.3, top - bh, cellW - 0.6, bh - 0.3, { fill: C.box });
        if (it.img) p.imageFit(it.img, x + 2, top - bh + 2, cellW - 4, bh - 4);
        else placeholder(p, x + 2, top - bh + 2, cellW - 4, bh - 4, it.missing || MISSING);
        p.rect(x, top - cellH, cellW, cellH, { stroke: C.border, width: 0.6 });
        if (capH) {
          p.line(x, top - bh, x + cellW, top - bh, { width: 0.4, color: C.rule });
          drawCaption(p, x + 4, top - bh - 4 - capSize * 0.85, caps[k], capSize, lead);
        }
      });
      this.y -= cellH + gap;
    }
    this.y -= Math.max(0, after - gap);
  }

  /* Photo pages: `perRow` across (1 full, 2 compact), `rowsPerPage` rows,
     each card a bordered box with the photo contained in it and the caption
     under it ("#007 · BEFORE · Kitchen · …"). Each page of cards fills the
     body; the first may share its page with the section band. */
  photos(items, { perRow = 1, rowsPerPage = 2, gap = 10, capSize = 9, maxCapLines = 4 } = {}) {
    const list = arr(items);
    if (!list.length) return;
    const per = Math.max(1, perRow), rowsN = Math.max(1, rowsPerPage);
    const cellW = (CONTENT_W - gap * (per - 1)) / per;
    const lead = capSize * 1.22;
    for (let i = 0; i < list.length; i += per * rowsN) {
      if (!this.fresh) this.newPage();
      const slotH = (this.room - 4 - gap * (rowsN - 1)) / rowsN;
      const chunk = list.slice(i, i + per * rowsN);
      for (let r = 0; r < chunk.length; r += per) {
        const row = chunk.slice(r, r + per);
        const caps = row.map((it) => captionLines(it.caption, capSize, cellW - 10, maxCapLines));
        const n = Math.max(1, ...caps.map((c) => c.lines.length));
        const capH = 6 + n * lead + 3;
        const bh = slotH - capH;
        const p = this.page, top = this.y;
        row.forEach((it, k) => {
          const x = M.l + k * (cellW + gap);
          p.rect(x + 0.3, top - bh, cellW - 0.6, bh - 0.3, { fill: C.box });
          if (it.img) p.imageFit(it.img, x + 3, top - bh + 3, cellW - 6, bh - 6);
          else placeholder(p, x + 3, top - bh + 3, cellW - 6, bh - 6, it.missing || MISSING);
          p.rect(x, top - slotH, cellW, slotH, { stroke: C.border, width: 0.6 });
          p.line(x, top - bh, x + cellW, top - bh, { width: 0.4, color: C.rule });
          drawCaption(p, x + 5, top - bh - 6 - capSize * 0.8, caps[k], capSize, lead);
        });
        this.y -= slotH + gap;
      }
      this.y = Math.max(this.y, BODY_BOTTOM);
    }
  }

  /* One image filling the body of its page (an uploaded signed copy, a
     floor plan, an invoice attachment page), contained inside the margins
     with its caption small above it. Uses the current page when it is
     fresh (only a heading on it), else starts one. */
  fullPage(img, { caption = "", missing = MISSING } = {}) {
    if (!this.fresh) this.newPage();
    const p = this.page;
    const capLines = clean(caption) ? wrapText(clean(caption), 7.5, "bold", CONTENT_W, { maxLines: 2 }) : [];
    capLines.forEach((ln, j) => p.text(M.l, this.y - 7 - j * 9.5, ln, { size: 7.5, font: "bold", color: C.sub }));
    const top = this.y - (capLines.length ? capLines.length * 9.5 + 4 : 0);
    const h = top - BODY_BOTTOM - 2;
    if (img) {
      const r = p.imageFit(img, M.l, BODY_BOTTOM + 2, CONTENT_W, h, { valign: "top" });
      if (r) p.rect(r.x, r.y, r.w, r.h, { stroke: C.rule, width: 0.5 });
    } else {
      // a letter-shaped gray page where the document should be
      const w = Math.min(CONTENT_W, h * (8.5 / 11));
      placeholder(p, M.l + (CONTENT_W - w) / 2, top - h, w, h, missing);
    }
    this.y = BODY_BOTTOM;
  }

  /* ---------- signatures ----------
     items: [{ label, name, date, img, wanted, electronic }] — `img` the
     drawn signature (from doc.image), `wanted` true when the model named an
     image (so a missing one prints the gray box, not a blank line),
     `electronic` prints "Signed electronically by NAME, DATE" in place of
     an image. Up to three across. */
  #sigRows(items, perRow, gap) {
    const list = arr(items);
    const per = Math.max(1, Math.min(3, perRow || list.length || 1));
    const colW = (CONTENT_W - gap * (per - 1)) / per;
    const rows = [];
    for (let i = 0; i < list.length; i += per) {
      const cells = list.slice(i, i + per).map((it) => {
        const date = clean(it.date);
        const dateW = date ? textWidth(date, 8) + 8 : 0;
        return {
          ...it, date,
          label: wrapText(upper(it.label), 6.8, "bold", colW, { maxLines: 2 }),
          name: clean(it.name) ? wrapText(clean(it.name), 9, "reg", colW - dateW, { maxLines: 2 }) : [],
        };
      });
      const labH = Math.max(1, ...cells.map((c) => c.label.length)) * 8;
      const nameH = Math.max(1, ...cells.map((c) => c.name.length)) * 11;
      rows.push({ cells, labH, h: labH + 2 + SIG_H + 3 + nameH + 2 });
    }
    return { rows, colW, per };
  }

  signaturesHeight(items, { perRow = 0, gap = 18 } = {}) {
    const { rows } = this.#sigRows(items, perRow, gap);
    return rows.length ? rows[0].h + 8 : 0;
  }

  signatures(items, { perRow = 0, gap = 18, after = 6 } = {}) {
    const { rows, colW } = this.#sigRows(items, perRow, gap);
    for (const row of rows) {
      this.ensure(row.h + 8);
      const p = this.page;
      const top = this.y, sigTop = top - row.labH - 2, line = sigTop - SIG_H;
      row.cells.forEach((c, k) => {
        const x = M.l + k * (colW + gap);
        c.label.forEach((ln, j) => p.text(x, top - 6.8 - j * 8, ln, { size: 6.8, font: "bold", color: C.sub, spacing: 0.3 }));
        if (c.electronic) {
          const who = clean(c.electronicName || (c.name.length ? c.name.join(" ") : ""));
          const text = `Signed electronically${who ? ` by ${who}` : ""}${c.date ? `, ${c.date}` : ""}`;
          const lines = wrapText(text, 8.5, "ital", colW - 4, { maxLines: 3 });
          const y0 = line + SIG_H / 2 + ((lines.length - 1) * 10.5) / 2 - 3;
          lines.forEach((ln, j) => p.text(x + 2, y0 - j * 10.5, ln, { size: 8.5, font: "ital", color: C.navy }));
        } else if (c.img) p.imageFit(c.img, x, line + 2, colW, SIG_H - 4, { align: "left" });
        else if (c.wanted) placeholder(p, x, line + 2, Math.min(colW, 150), SIG_H - 4);
        p.line(x, line, x + colW, line, { width: 0.7, color: C.black });
        c.name.forEach((ln, j) => p.text(x, line - 10 - j * 11, ln, { size: 9 }));
        if (c.date) p.text(x + colW, line - 10, c.date, { size: 8, color: C.sub, align: "right" });
      });
      this.y -= row.h + 8;
    }
    this.y -= after;
  }

  /* ---------- note: a gray box of text ---------- */
  noteHeight(text, { size = 8.5 } = {}) {
    const n = wrapText(clean(text), size, "reg", CONTENT_W - 16).length;
    return Math.min(n, 3) * size * 1.3 + 10;
  }

  note(text, { size = 8.5, color = C.black, after = 8 } = {}) {
    const lead = size * 1.3;
    const lines = this.#paraLines(text, size, "reg", CONTENT_W - 16);
    if (!lines.length) return;
    let i = 0;
    while (i < lines.length) {
      this.ensure(Math.min(lines.length - i, 2) * lead + 10);
      const fit = Math.max(1, Math.floor((this.room - 10) / lead));
      const part = lines.slice(i, i + fit);
      const h = part.length * lead + 10;
      const p = this.page;
      p.rect(M.l, this.y - h, CONTENT_W, h, { fill: C.box, stroke: C.rule, width: 0.6 });
      part.forEach((ln, j) => { if (ln) p.text(M.l + 8, this.y - 5 - size * 0.9 - j * lead, ln, { size, color }); });
      this.y -= h;
      i += part.length;
      if (i < lines.length) this.newPage();
    }
    this.y -= after;
  }

  /* draw the running bands on every flow page */
  finish() {
    const total = this.doc.pages.length;
    for (const i of [...this.flowPages].sort((a, b) => a - b)) {
      const p = this.doc.pages[i];
      if (this.header) this.header(p, i, total);
      if (this.footer) this.footer(p, i, total);
    }
    return this.bookmarks;
  }
}
