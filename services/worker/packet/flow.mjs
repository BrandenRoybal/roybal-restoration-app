/* Flow layout for the carrier packet: a cursor that runs down the page and
   starts a new one when the next block will not fit, on top of pdfdoc.mjs.

   Blocks: section heads (the print.css h2 band with its orange bar, and a
   bookmark), sub-heads, paragraphs, key/value grids, tables that split
   across pages and repeat their header row, image grids with captions, and
   full-page images. Every page this flow starts gets the running header and
   footer drawn at the end, when the page count is known ("Page N of M").

   Coordinates: PDF points, origin bottom-left. `this.y` is the top of the
   free space on the current page. */

import { PAGE, C, textWidth, wrapText } from "./pdfdoc.mjs";

export const M = { l: 36, r: 36, t: 36, b: 39.6 };              // @page .5in .5in .55in
export const CONTENT_W = PAGE.w - M.l - M.r;                    // 540
export const HEAD_H = 20;                                       // running header band
export const FOOT_H = 18;                                       // running footer band
export const BODY_TOP = PAGE.h - M.t - HEAD_H;
export const BODY_BOTTOM = M.b + FOOT_H;

const clean = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();

export class Flow {
  /* header(page, i, total) and footer(page, i, total) draw the running
     bands; they are called for every page this flow made, at finish(). */
  constructor(doc, { header = null, footer = null } = {}) {
    this.doc = doc;
    this.header = header;
    this.footer = footer;
    this.page = null;
    this.y = BODY_TOP;
    this.bookmarks = [];                                        // [{ title, page, children }]
    this.flowPages = new Set();                                 // page indexes that get bands
  }

  get pageIndex() { return this.page ? this.page.index : -1; }

  newPage({ bands = true } = {}) {
    this.page = this.doc.addPage();
    if (bands) this.flowPages.add(this.page.index);
    this.y = bands ? BODY_TOP : PAGE.h - M.t;
    return this.page;
  }

  /* make sure h points fit below the cursor; start a page if not */
  ensure(h) {
    if (!this.page || this.y - h < BODY_BOTTOM) this.newPage();
    return this.page;
  }

  space(h) { this.y -= h; }

  /* free height left on this page */
  get room() { return this.y - BODY_BOTTOM; }

  /* ---------- headings ---------- */

  /* the print.css h2: uppercase navy on a light band, orange left bar.
     Starts a new page when asked (each section does) and records a
     bookmark. `keep` reserves room for the first block under it. */
  section(title, { newPage = true, bookmark = title, keep = 60, child = false } = {}) {
    if (newPage || !this.page) this.newPage();
    else this.ensure(24 + keep);
    const p = this.page;
    p.rect(M.l, this.y - 18, CONTENT_W, 18, { fill: C.band });
    p.rect(M.l, this.y - 18, 3, 18, { fill: C.orange });
    p.text(M.l + 9, this.y - 12.8, String(title).toUpperCase(), { size: 10.5, font: "bold", color: C.navy, maxWidth: CONTENT_W - 14 });
    this.y -= 18 + 8;
    if (bookmark) {
      const mark = { title: bookmark, page: p.index, children: [] };
      if (child && this.bookmarks.length) this.bookmarks[this.bookmarks.length - 1].children.push(mark);
      else this.bookmarks.push(mark);
    }
    return p;
  }

  /* a smaller navy heading with a rule under it */
  subhead(title, { keep = 40, right = "" } = {}) {
    this.ensure(20 + keep);
    const p = this.page;
    const rw = right ? p.text(PAGE.w - M.r, this.y - 10, right, { size: 8, color: C.sub, align: "right" }) : 0;
    p.text(M.l, this.y - 10, title, { size: 10, font: "bold", color: C.navy, maxWidth: CONTENT_W - rw - 8 });
    p.line(M.l, this.y - 14, PAGE.w - M.r, this.y - 14, { width: 0.8, color: C.navy });
    this.y -= 20;
  }

  /* ---------- text ---------- */

  paragraph(text, { size = 9, font = "reg", color = C.black, lead = null, indent = 0, width = CONTENT_W, after = 4 } = {}) {
    const lh = lead || size * 1.3;
    const lines = [];
    for (const para of String(text == null ? "" : text).split(/\n/)) {
      const t = para.trim();
      if (!t) { lines.push(""); continue; }
      lines.push(...wrapText(t, size, font, width - indent));
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    for (const ln of lines) {
      this.ensure(lh);
      if (ln) this.page.text(M.l + indent, this.y - size, ln, { size, font, color });
      this.y -= lh;
    }
    this.y -= after;
  }

  /* bullet list */
  bullets(items, { size = 9, color = C.black, after = 4 } = {}) {
    for (const it of items) {
      const lines = wrapText(clean(it), size, "reg", CONTENT_W - 14);
      lines.forEach((ln, i) => {
        this.ensure(size * 1.3);
        if (i === 0) this.page.text(M.l + 3, this.y - size, "•", { size, color: C.orange, font: "bold" });
        this.page.text(M.l + 14, this.y - size, ln, { size, color });
        this.y -= size * 1.3;
      });
    }
    this.y -= after;
  }

  /* label/value cells in `cols` columns, the job-information look: small
     uppercase label, value under it, a hairline below. pairs: [[label, value]] */
  fields(pairs, { cols = 2, size = 9.5, labelSize = 7, gap = 12, after = 6 } = {}) {
    const list = pairs.filter((p) => p && p[0]);
    const colW = (CONTENT_W - gap * (cols - 1)) / cols;
    for (let i = 0; i < list.length; i += cols) {
      const row = list.slice(i, i + cols);
      const cells = row.map(([label, value]) => ({ label, lines: wrapText(clean(value) || "—", size, "reg", colW, { maxLines: 3 }) }));
      const h = 10 + Math.max(...cells.map((c) => c.lines.length)) * (size * 1.25) + 5;
      this.ensure(h);
      const p = this.page;
      cells.forEach((c, k) => {
        const x = M.l + k * (colW + gap);
        p.text(x, this.y - 7, String(c.label).toUpperCase(), { size: labelSize, color: C.sub });
        c.lines.forEach((ln, j) => p.text(x, this.y - 10 - (j + 1) * size * 1.05, ln, { size }));
        p.line(x, this.y - h + 2, x + colW, this.y - h + 2, { width: 0.4, color: C.rule });
      });
      this.y -= h + 2;
    }
    this.y -= after;
  }

  /* ---------- tables ----------
     columns: [{ head, w (points, or a fraction of the width when ≤ 1),
                 align: left|right|center, font, size }]
     rows: arrays of cells; a cell is a string, or { text, font, color,
           fill, align, mark } (mark: a small superscript after the text).
     Rows never split; a row taller than a page is clipped to its first
     lines. The header row repeats on every page the table reaches. */
  table(columns, rows, { size = 8, headSize = null, pad = 3, zebra = true, groupRow = null, after = 8, minRows = 2 } = {}) {
    const hs = headSize || size;
    const total = columns.reduce((n, c) => n + (c.w <= 1 ? c.w * CONTENT_W : c.w), 0);
    const scale = total > CONTENT_W + 0.5 ? CONTENT_W / total : 1;
    const widths = columns.map((c) => (c.w <= 1 ? c.w * CONTENT_W : c.w) * scale);
    const lh = size * 1.22;
    const headLines = columns.map((c, i) => wrapText(clean(c.head), hs, "bold", widths[i] - pad * 2, { maxLines: 3 }));
    const headH = Math.max(...headLines.map((l) => l.length)) * hs * 1.15 + pad * 2;
    const cellOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { text: v });
    const maxRowH = BODY_TOP - BODY_BOTTOM - headH - 4;

    const drawHead = () => {
      const p = this.page;
      let x = M.l;
      p.rect(M.l, this.y - headH, widths.reduce((a, b) => a + b, 0), headH, { fill: C.navy });
      columns.forEach((c, i) => {
        headLines[i].forEach((ln, j) => {
          const ty = this.y - pad - hs - j * hs * 1.15 + 1;
          const al = c.align || "left";
          const tx = al === "right" ? x + widths[i] - pad : al === "center" ? x + widths[i] / 2 : x + pad;
          p.text(tx, ty, ln, { size: hs, font: "bold", color: C.white, align: al });
        });
        x += widths[i];
      });
      this.y -= headH;
    };

    const layoutRow = (row) => {
      const cells = columns.map((c, i) => {
        const cell = cellOf(row[i]);
        const font = cell.font || c.font || "reg";
        const sz = cell.size || c.size || size;
        const markW = cell.mark ? textWidth(cell.mark, sz * 0.7, "bold") + 1 : 0;
        const lines = wrapText(clean(cell.text), sz, font, Math.max(4, widths[i] - pad * 2 - markW));
        return { ...cell, font, sz, lines, markW };
      });
      let h = Math.max(...cells.map((c) => c.lines.length * c.sz * 1.22)) + pad * 2;
      if (h > maxRowH) {
        const keep = Math.max(1, Math.floor((maxRowH - pad * 2) / lh));
        for (const c of cells) if (c.lines.length > keep) { c.lines.length = keep; c.lines[keep - 1] += " …"; }
        h = maxRowH;
      }
      return { cells, h };
    };

    const tableW = widths.reduce((a, b) => a + b, 0);
    // keep the head with at least `minRows` rows
    const first = rows.slice(0, minRows).map(layoutRow);
    this.ensure(headH + first.reduce((n, r) => n + r.h, 0) + 2);
    drawHead();
    let zi = 0;
    rows.forEach((row, ri) => {
      const isGroup = groupRow && groupRow(row, ri);
      if (isGroup) {
        const gh = size * 1.22 + pad * 2;
        if (this.y - gh - lh - pad * 2 < BODY_BOTTOM) { this.newPage(); drawHead(); }
        const p = this.page;
        p.rect(M.l, this.y - gh, tableW, gh, { fill: C.band });
        p.text(M.l + pad, this.y - pad - size + 1, clean(isGroup), { size, font: "bold", color: C.navy, maxWidth: tableW - pad * 2 });
        p.line(M.l, this.y - gh, M.l + tableW, this.y - gh, { width: 0.4, color: C.border });
        this.y -= gh;
        zi = 0;
        return;
      }
      const { cells, h } = layoutRow(row);
      if (this.y - h < BODY_BOTTOM) { this.newPage(); drawHead(); }
      const p = this.page;
      if (zebra && zi % 2 === 1) p.rect(M.l, this.y - h, tableW, h, { fill: C.box });
      let x = M.l;
      cells.forEach((c, i) => {
        if (c.fill) p.rect(x, this.y - h, widths[i], h, { fill: c.fill });
        const al = c.align || columns[i].align || "left";
        c.lines.forEach((ln, j) => {
          const ty = this.y - pad - c.sz - j * c.sz * 1.22 + 1;
          const w = textWidth(ln, c.sz, c.font);
          const tx = al === "right" ? x + widths[i] - pad - c.markW : al === "center" ? x + widths[i] / 2 : x + pad;
          p.text(tx, ty, ln, { size: c.sz, font: c.font, color: c.color || C.black, align: al });
          if (c.mark && j === c.lines.length - 1) {
            const mx = al === "right" ? tx + 1 : al === "center" ? tx + w / 2 + 1 : tx + w + 1;
            p.text(mx, ty + c.sz * 0.4, c.mark, { size: c.sz * 0.7, font: "bold", color: c.markColor || C.orange });
          }
        });
        x += widths[i];
      });
      p.line(M.l, this.y - h, M.l + tableW, this.y - h, { width: 0.4, color: C.rule });
      this.y -= h;
      zi++;
    });
    if (!rows.length) {
      const p = this.ensure(lh + pad * 2);
      p.text(M.l + pad, this.y - pad - size, "None recorded.", { size, font: "ital", color: C.sub });
      this.y -= lh + pad * 2;
    }
    // outer frame on the last page's part is enough for a print look
    this.y -= after;
  }

  /* ---------- images ---------- */

  /* a grid of captioned images. items: [{ img (from doc.image) | null,
     caption: [boldPrefix, rest] | string, missing: "why" }]. A null img
     prints a gray box with `missing` (or "Image not available"). */
  imageGrid(items, { perRow = 2, boxH = 300, gap = 8, capSize = 8, capLines = 2, after = 8 } = {}) {
    const cellW = (CONTENT_W - gap * (perRow - 1)) / perRow;
    const capH = capLines * capSize * 1.25 + 6;
    const cellH = boxH + capH;
    for (let i = 0; i < items.length; i += perRow) {
      this.ensure(cellH);
      const p = this.page;
      items.slice(i, i + perRow).forEach((it, k) => {
        const x = M.l + k * (cellW + gap);
        const top = this.y;
        p.rect(x, top - cellH, cellW, cellH, { stroke: C.border, width: 0.6 });
        p.rect(x + 0.3, top - boxH, cellW - 0.6, boxH - 0.3, { fill: C.box });
        if (it.img) p.imageFit(it.img, x + 2, top - boxH + 2, cellW - 4, boxH - 4);
        else {
          p.text(x + cellW / 2, top - boxH / 2, it.missing || "Image not available", { size: 8, font: "ital", color: C.sub, align: "center", maxWidth: cellW - 8 });
        }
        p.line(x, top - boxH, x + cellW, top - boxH, { width: 0.4, color: C.rule });
        const [prefix, rest] = Array.isArray(it.caption) ? it.caption : ["", it.caption || ""];
        const preW = prefix ? textWidth(prefix + " ", capSize, "bold") : 0;
        const lines = wrapText(clean(rest), capSize, "reg", cellW - 8, { firstWidth: cellW - 8 - preW, maxLines: capLines });
        let ty = top - boxH - 4 - capSize;
        if (prefix) p.text(x + 4, ty, prefix, { size: capSize, font: "bold", color: C.navy });
        lines.forEach((ln, j) => {
          if (ln) p.text(x + 4 + (j === 0 ? preW : 0), ty, ln, { size: capSize });
          ty -= capSize * 1.25;
        });
      });
      this.y -= cellH + gap;
    }
    this.y -= after - gap;
  }

  /* one image filling the body of its own page (an uploaded signed copy, an
     invoice attachment page); caption on the head band */
  fullPage(img, { caption = "", missing = "Page image not available" } = {}) {
    this.newPage();
    const p = this.page;
    const capH = caption ? 14 : 0;
    if (caption) p.text(M.l, this.y - 9, caption, { size: 8.5, font: "bold", color: C.navy, maxWidth: CONTENT_W });
    const top = this.y - capH, h = top - BODY_BOTTOM - 2;
    if (img) p.imageFit(img, M.l, BODY_BOTTOM + 2, CONTENT_W, h);
    else {
      p.rect(M.l, BODY_BOTTOM + 2, CONTENT_W, h, { fill: C.box, stroke: C.border });
      p.text(PAGE.w / 2, BODY_BOTTOM + h / 2, missing, { size: 10, font: "ital", color: C.sub, align: "center" });
    }
    this.y = BODY_BOTTOM;
  }

  /* draw the running bands on every flow page */
  finish() {
    const total = this.doc.pages.length;
    for (const i of this.flowPages) {
      const p = this.doc.pages[i];
      if (this.header) this.header(p, i, total);
      if (this.footer) this.footer(p, i, total);
    }
    return this.bookmarks;
  }
}
