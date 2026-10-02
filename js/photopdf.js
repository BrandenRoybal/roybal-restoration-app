/* ============================================================
   Roybal — emailable photo-log PDF (a minimal PDF writer)
   VERBATIM COPY in apps/field/js/photopdf.js and apps/portal/js/photopdf.js
   (the portal deploys as its own static directory and can't import across
   apps — keep the two files identical; photopdf.test.mjs checks that).

   Why this exists: carriers and TPAs flatten whatever the insured uploads
   into a PDF, so a portal link on the packet arrives as dead text and the
   reviewer never sees the photos. The packet's own PHOTO REPORT embeds the
   ≤50 KB thumbnails and the full-res ZIP is ~50 MB — neither is "the photo
   file" an email can carry. This module writes a PDF of full-size photos,
   two to a page, split into parts that each stay under the email cap, with
   the claim header and the live portal link on every part's cover.

   It is deliberately a hand-rolled writer, not a library: each JPEG goes
   into the PDF as-is (/DCTDecode), so a part weighs its photos' bytes plus
   a few KB of structure; text is the built-in Helvetica (nothing to embed);
   and it is pure byte-pushing with no DOM — Node-testable like zip.js. The
   caller does the browser work (fetching full-res, canvas re-encoding) and
   hands in { num, stage, room, caption, jpeg } per photo.

   The layout mirrors print.css: letter, 0.5in margins, the letterhead
   band, uppercase navy section heads, bordered photo cards with the
   caption under the image. Photos draw object-fit: contain — never
   cropped. Cards carry "#NNN · STAGE · room · caption" and NO dates: the
   date a BEFORE photo was captioned reads to a reviewer as the date of the
   damage. NNN is the photo's position in the job photo log, the same
   number the portal ZIP puts at the front of each file name.
   ============================================================ */

export const PAGE = { w: 612, h: 792 };                        // letter, points
const M = { l: 36, r: 36, t: 36, b: 39.6 };                    // @page 0.5in 0.5in 0.55in
const CONTENT_W = PAGE.w - M.l - M.r;                          // 540

/* Measured 2026-09-11 on a 216-photo job (900×1200 originals): 1100 px at
   q0.62 ≈ 80 KB a photo, so ~108 photos fit one 10 MB part. */
export const PHOTO_ENCODE = { maxDim: 1100, quality: 0.62 };
export const PART_MAX_BYTES = 10_000_000;
export const PER_PAGE = 2;

const STAGE_RANK = { before: 0, during: 1, after: 2 };
const STAGE_LABEL = { before: "BEFORE", during: "DURING", after: "AFTER" };
const stageRank = (s) => STAGE_RANK[s] ?? 1;
const stageLabel = (s) => STAGE_LABEL[s] || "PHOTOS";

/* print.css colors, as PDF rgb operands */
const C = {
  navy: "0.059 0.106 0.176", orange: "0.949 0.416 0.129", black: "0 0 0",
  tag: "0.267 0.333 0.420", sub: "0.357 0.420 0.502", border: "0.420 0.471 0.573",
  rule: "0.769 0.800 0.847", band: "0.933 0.949 0.969", link: "0.110 0.373 0.690",
  box: "0.957 0.961 0.969",
};

const COMPANY = {
  name: "CONSTRUCTION, LLC",   // after the orange "ROYBAL"
  tagline: "General Contracting | Restoration & Mitigation | IICRC WRT Certified",
  address: "3850 Royal Rd, Fairbanks, AK 99701",
  phone: "907-371-9868", email: "branden@roybalconstruction.com", web: "roybalconstruction.com",
};

/* ---------- text: WinAnsi encoding + Helvetica metrics ---------- */
/* Helvetica / Helvetica-Bold advance widths (1/1000 em) for WinAnsi codes 32..255,
   from the Adobe core-14 AFM metrics — text wrapping needs real widths. */
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350, 556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350, 556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556];

/* Unicode → WinAnsi for the 0x80–0x9F block (everything 0xA0–0xFF is Latin-1) */
const WIN = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);
/* near-misses a tech's keyboard produces that Helvetica can't show verbatim */
const SUBST = new Map([
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2212, "-"], [0x2032, "'"], [0x2033, '"'],
  [0x2192, "->"], [0x2190, "<-"], [0x2713, "v"], [0x2714, "v"], [0x26a0, "!"],
  [0x00a0, " "], [0x2002, " "], [0x2003, " "], [0x2007, " "], [0x2009, " "], [0x202f, " "],
]);

/* a JS string as WinAnsi bytes; characters Helvetica has no glyph for
   (emoji, arrows) are substituted or dropped — never turned into "?" on a
   document a reviewer reads */
export function winAnsi(str) {
  const out = [];
  for (const ch of String(str == null ? "" : str)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN.has(c)) out.push(WIN.get(c));
    else if (SUBST.has(c)) for (const s of SUBST.get(c)) out.push(s.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

/* advance width of `str` in points at `size` */
export function textWidth(str, size, bold = false) {
  const W = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of winAnsi(str)) w += W[b - 32] || 0;
  return (w * size) / 1000;
}

/* PDF literal string from WinAnsi bytes, ASCII-safe */
const pdfStr = (bytes) => {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
};
const lit = (str) => pdfStr(winAnsi(str));

/* Greedy word wrap. The first line may be narrower (a bold prefix sits on
   it); a word wider than a whole line (a URL) breaks by character, like
   word-break: break-all. Past maxLines the last line ends in an ellipsis. */
export function wrapText(str, size, bold, width, { firstWidth = width, maxLines = Infinity } = {}) {
  const words = String(str || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "", avail = firstWidth;
  const push = () => { lines.push(line); line = ""; avail = width; };
  const fits = (s) => textWidth(s, size, bold) <= avail;
  for (const word of words) {
    const joined = line ? line + " " + word : word;
    if (fits(joined)) { line = joined; continue; }
    if (line) push();
    if (fits(word)) { line = word; continue; }
    let chunk = "";                                   // break an over-wide word
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else { line = chunk; push(); chunk = ch; }
    }
    line = chunk;
  }
  if (line || !lines.length) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    const w = maxLines === 1 ? firstWidth : width;
    while (last && textWidth(last + "…", size, bold) > w) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

/* ---------- JPEG header: dimensions + color model ---------- */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }            // fill bytes between segments
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;   // EOI / scan before any frame header
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (SOF.has(marker)) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      if (!width || !height) return null;
      return { width, height, components, progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce };
    }
    i += 2 + len;
  }
  return null;
}

/* ---------- part planning: balanced, each under the cap ---------- */
const PER_PHOTO_OVERHEAD = 1400;   // page dict + content stream + XObject dict + xref lines
const PER_PART_OVERHEAD = 60_000;  // cover (up to a QR's worth of rectangles), fonts, catalog, slack

/* Split sizes (in display order) into the fewest parts that each stay under
   maxBytes once structure is added, balanced so two parts come out alike
   rather than one full and one nearly empty. A single photo larger than the
   cap gets a part of its own (it can't be made smaller here; the caller's
   encode settings decide that). Returns [[start, end), …]. */
export function planParts(sizes, maxBytes = PART_MAX_BYTES) {
  const costs = sizes.map((s) => s + PER_PHOTO_OVERHEAD);
  const budget = Math.max(1, maxBytes - PER_PART_OVERHEAD);
  const total = costs.reduce((a, b) => a + b, 0);
  if (!costs.length) return [];
  for (let n = Math.min(costs.length, Math.max(1, Math.ceil(total / budget))); ; n++) {
    const parts = [];
    let i = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const target = (total * (k + 1)) / n;
      const start = i;
      while (i < costs.length && costs.length - i > n - k - 1 &&
             (i === start || acc + costs[i] <= target + costs[i] / 2)) { acc += costs[i]; i++; }
      parts.push([start, i]);
    }
    if (i < costs.length) parts[parts.length - 1][1] = costs.length;
    const over = parts.some(([a, b]) => b - a > 1 && costs.slice(a, b).reduce((x, y) => x + y, 0) > budget);
    if (!over || n >= costs.length) return parts.filter(([a, b]) => b > a);
  }
}

/* ---------- the writer ---------- */
const latin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
const toBytes = (x) => (typeof x === "string" ? latin1(x) : x);

function pdfDoc() {
  const objs = [];                       // objs[n-1] = [Uint8Array…] | null (reserved)
  const doc = {
    reserve() { objs.push(null); return objs.length; },
    set(n, ...parts) { objs[n - 1] = parts.map(toBytes); },
    add(...parts) { const n = doc.reserve(); doc.set(n, ...parts); return n; },
    stream(dict, bytes) { return [`<< ${dict} /Length ${bytes.length} >>\nstream\n`, bytes, "\nendstream"]; },
    finish(root, info) {
      const out = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
      let offset = out[0].length;
      const offsets = [];
      objs.forEach((parts, i) => {
        offsets.push(offset);
        const chunk = [latin1(`${i + 1} 0 obj\n`), ...(parts || [latin1("null")]), latin1("\nendobj\n")];
        for (const c of chunk) { out.push(c); offset += c.length; }
      });
      let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
      xref += `trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
      out.push(latin1(xref));
      const total = out.reduce((n, p) => n + p.length, 0);
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const p of out) { bytes.set(p, o); o += p.length; }
      return bytes;
    },
  };
  return doc;
}

/* content-stream helpers (ops are strings; numbers keep 2 decimals) */
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const text = (ops, x, y, str, { size = 9, bold = false, color = C.black, align = "left", maxWidth = 0 } = {}) => {
  let s = String(str == null ? "" : str);
  if (maxWidth) while (s && textWidth(s, size, bold) > maxWidth) s = s.slice(0, -1);
  if (!s) return 0;
  const w = textWidth(s, size, bold);
  const tx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  ops.push(`BT /${bold ? "F2" : "F1"} ${n2(size)} Tf ${color} rg ${n2(tx)} ${n2(y)} Td ${lit(s)} Tj ET`);
  return w;
};
const hline = (ops, x1, x2, y, w, color) => ops.push(`${n2(w)} w ${color} RG ${n2(x1)} ${n2(y)} m ${n2(x2)} ${n2(y)} l S`);
const rectFill = (ops, x, y, w, h, color) => ops.push(`${color} rg ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`);
const rectStroke = (ops, x, y, w, h, lw, color) => ops.push(`${n2(lw)} w ${color} RG ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re S`);

/* section heading in the print.css h2 style: uppercase navy on a light band
   with the orange left bar. Returns the y below it. */
function sectionHead(ops, top, label) {
  rectFill(ops, M.l, top - 16, CONTENT_W, 16, C.band);
  rectFill(ops, M.l, top - 16, 2.5, 16, C.orange);
  text(ops, M.l + 8, top - 11.5, label.toUpperCase(), { size: 10.5, bold: true, color: C.navy });
  return top - 16 - 8;
}

/* "2026-07-31" → "Jul 31, 2026"; a Date formats in local time; anything
   else (free-typed) passes through */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso) {
  if (iso instanceof Date) return `${MONTHS[iso.getMonth()]} ${iso.getDate()}, ${iso.getFullYear()}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]}`;
}
const pad3 = (n) => String(n).padStart(3, "0");

/* one photo's caption as [bold prefix, rest] */
export function cardCaption(p) {
  const prefix = `#${pad3(p.num)} · ${stageLabel(p.stage)}`;
  const rest = [p.item, p.room, p.caption].map((s) => String(s || "").trim()).filter(Boolean).join(" · ")
    + (p.preview ? " · preview only" : "");
  return [prefix, rest];
}

/* ---------- pages ---------- */
const HEAD_H = 18, FOOT_H = 16, SLOT_GAP = 8, BAND_H = 26, CAP_LEAD = 11;
const BODY_TOP = PAGE.h - M.t - HEAD_H;                      // 738
const BODY_BOTTOM = M.b + FOOT_H;                            // 55.6
const SLOT_H = (BODY_TOP - BODY_BOTTOM - SLOT_GAP * (PER_PAGE - 1)) / PER_PAGE;

function runningHeaderFooter(ops, ctx, partLabel, pageNo, pageCount) {
  const hy = PAGE.h - M.t - 8;
  const left = ["Roybal Construction, LLC", "Photo Log", ctx.header.customer, ctx.header.claimNo ? "Claim # " + ctx.header.claimNo : ""]
    .filter(Boolean).join(" · ");
  const right = [partLabel, `Page ${pageNo} of ${pageCount}`].filter(Boolean).join(" · ");
  const rw = text(ops, PAGE.w - M.r, hy, right, { size: 7.5, color: C.sub, align: "right" });
  text(ops, M.l, hy, left, { size: 7.5, color: C.sub, maxWidth: CONTENT_W - rw - 12 });
  hline(ops, M.l, PAGE.w - M.r, hy - 6, 0.5, C.rule);
  hline(ops, M.l, PAGE.w - M.r, M.b + 12, 0.5, C.rule);
  text(ops, M.l, M.b + 3, "Roybal Construction, LLC — Photo Log", { size: 7.5, color: C.sub });
  text(ops, PAGE.w - M.r, M.b + 3, ctx.header.address || "", { size: 7.5, color: C.sub, align: "right", maxWidth: CONTENT_W / 2 });
}

/* two cards per page; a stage band above the first card of each group */
function photoPage(ctx, items, groupStarts, partLabel, pageNo, pageCount) {
  const ops = [], images = [];
  runningHeaderFooter(ops, ctx, partLabel, pageNo, pageCount);
  items.forEach((p, k) => {
    const slotTop = BODY_TOP - k * (SLOT_H + SLOT_GAP);
    let cardTop = slotTop;
    const band = groupStarts.get(p);
    if (band) {
      text(ops, M.l, slotTop - 13, band, { size: 10.5, bold: true, color: C.navy });
      hline(ops, M.l, PAGE.w - M.r, slotTop - 18, 1, C.navy);
      cardTop = slotTop - BAND_H;
    }
    const cardH = cardTop - (slotTop - SLOT_H);
    const cardBottom = cardTop - cardH;
    const [prefix, rest] = cardCaption(p);
    const capX = M.l + 5, capW = CONTENT_W - 10;
    const preW = textWidth(prefix + " ", 9, true);
    const lines = rest ? wrapText(rest, 9, false, capW, { firstWidth: capW - preW, maxLines: 3 }) : [""];
    const capH = 6 + lines.length * CAP_LEAD + 4;
    const boxH = cardH - capH;
    rectStroke(ops, M.l, cardBottom, CONTENT_W, cardH, 0.6, C.border);
    rectFill(ops, M.l + 0.3, cardTop - boxH, CONTENT_W - 0.6, boxH - 0.3, C.box);
    // object-fit: contain, centered — the whole photo, never cropped
    const s = Math.min((CONTENT_W - 4) / p.info.width, (boxH - 4) / p.info.height);
    const dw = p.info.width * s, dh = p.info.height * s;
    const dx = M.l + (CONTENT_W - dw) / 2, dy = cardTop - boxH + (boxH - dh) / 2;
    images.push(p);
    ops.push(`q ${n2(dw)} 0 0 ${n2(dh)} ${n2(dx)} ${n2(dy)} cm /Im${images.length} Do Q`);
    hline(ops, M.l, PAGE.w - M.r, cardBottom + capH, 0.4, C.rule);
    let y = cardBottom + capH - 6 - 8.5;
    text(ops, capX, y, prefix, { size: 9, bold: true, color: C.navy });
    lines.forEach((ln, i) => {
      if (i === 0) { if (ln) text(ops, capX + preW, y, "· " + ln, { size: 9 }); }
      else text(ops, capX, y, ln, { size: 9 });
      y -= CAP_LEAD;
    });
  });
  return { ops, images, annots: [] };
}

/* the cover: letterhead, title, claim header, the live link(s), what this
   part holds */
function coverPage(ctx, part, parts, pageCount) {
  const ops = [], annots = [];
  const hd = ctx.header;
  // letterhead
  let y = PAGE.h - M.t;
  const nw = text(ops, M.l, y - 13, "ROYBAL", { size: 13, bold: true, color: C.orange });
  text(ops, M.l + nw, y - 13, " " + COMPANY.name, { size: 13, bold: true });
  text(ops, M.l, y - 25, COMPANY.tagline, { size: 7.5, color: C.tag });
  text(ops, PAGE.w - M.r, y - 10.5, COMPANY.address, { size: 7.5, color: C.tag, align: "right" });
  text(ops, PAGE.w - M.r, y - 20, COMPANY.phone + " | " + COMPANY.email, { size: 7.5, color: C.tag, align: "right" });
  text(ops, PAGE.w - M.r, y - 29.5, COMPANY.web, { size: 7.5, color: C.tag, align: "right" });
  hline(ops, M.l, PAGE.w - M.r, y - 37, 2.5, C.navy);
  y -= 49;
  rectFill(ops, M.l, y - 22, CONTENT_W, 22, C.band);
  text(ops, PAGE.w / 2, y - 16, "PHOTO LOG", { size: 15, bold: true, color: C.navy, align: "center" });
  y -= 22;
  const subtitle = parts.length === 1
    ? `Job Site Documentation · ${part.items.length} photo${part.items.length === 1 ? "" : "s"}`
    : `Job Site Documentation · Part ${part.index + 1} of ${parts.length} · ${part.items.length} of ${ctx.total} photos`;
  text(ops, PAGE.w / 2, y - 12, subtitle, { size: 8.5, color: C.sub, align: "center" });
  y -= 28;

  // job information (the same four fields the PHOTO REPORT sheet prints)
  y = sectionHead(ops, y, "Job Information");
  const colW = (CONTENT_W - 12) / 2;
  const field = (col, top, label, value) => {
    const x = M.l + col * (colW + 12);
    text(ops, x, top - 8, label.toUpperCase(), { size: 7.5, color: C.sub });
    const lines = wrapText(value || "—", 11, false, colW, { maxLines: 2 });
    lines.forEach((ln, i) => text(ops, x, top - 21 - i * 13, ln, { size: 11 }));
    const bottom = top - 21 - (lines.length - 1) * 13 - 4;
    hline(ops, x, x + colW, bottom, 0.5, C.rule);
    return bottom;
  };
  let rowBottom = Math.min(field(0, y, "Customer", hd.customer), field(1, y, "Job Address", hd.address));
  y = rowBottom - 8;
  rowBottom = Math.min(field(0, y, "Claim #", hd.claimNo), field(1, y, "Date of Loss", fmtDate(hd.dateOfLoss)));
  y = rowBottom - 16;

  // the live link(s) — full resolution lives behind them; the QR survives a
  // flattened upload where the typed URL is dead text
  const links = (ctx.links || []).filter((l) => l && l.url);
  if (links.length) {
    y = sectionHead(ops, y, "Full-Resolution Photos");
    for (const l of links) {
      const qrN = l.qr && l.qr.length ? l.qr.length : 0;
      const qrSize = qrN ? 58 : 0;
      const bodyW = CONTENT_W - 24 - (qrN ? qrSize + 12 : 0);
      const urlLines = wrapText(l.url, 9, false, bodyW, { maxLines: 3 });
      const subLines = l.sub ? wrapText(l.sub, 7.5, false, bodyW, { maxLines: 3 }) : [];
      const boxH = Math.max(qrN ? qrSize + 16 : 0, 8 + 11 + urlLines.length * 11 + subLines.length * 9.5 + 8);
      rectStroke(ops, M.l, y - boxH, CONTENT_W, boxH, 1.5, C.navy);
      let ty = y - 8 - 9.5;
      text(ops, M.l + 12, ty, l.head || "Full-size photos, view & download:", { size: 9.5, bold: true });
      ty -= 11;
      const urlTop = ty + 9;
      for (const ln of urlLines) { text(ops, M.l + 12, ty, ln, { size: 9, color: C.link }); ty -= 11; }
      annots.push({ rect: [M.l + 12, ty + 11 - 3, M.l + 12 + bodyW, urlTop + 2], url: l.url });
      for (const ln of subLines) { text(ops, M.l + 12, ty + 1, ln, { size: 7.5, color: C.sub }); ty -= 9.5; }
      if (qrN) {
        const cell = qrSize / qrN, qx = PAGE.w - M.r - 12 - qrSize, qy = y - 8 - qrSize;
        rectFill(ops, qx - 2, qy - 2, qrSize + 4, qrSize + 4, "1 1 1");
        for (let r = 0; r < qrN; r++) {
          const row = l.qr[r];
          for (let c = 0; c < qrN; c++) {
            if (!row[c]) continue;
            let e = c; while (e + 1 < qrN && row[e + 1]) e++;      // merge a run into one rect
            rectFill(ops, qx + c * cell, qy + qrSize - (r + 1) * cell, (e - c + 1) * cell, cell, C.black);
            c = e;
          }
        }
      }
      y -= boxH + 8;
    }
    y -= 8;
  }

  // what this part holds
  y = sectionHead(ops, y, parts.length === 1 ? "In This File" : `In This File · Part ${part.index + 1} of ${parts.length}`);
  const line = (s, opt = {}) => { text(ops, M.l + 2, y - 9, s, { size: 9.5, ...opt }); y -= 13.5; };
  const counts = (items) => {
    const out = [];
    for (const p of items) {
      const last = out[out.length - 1];
      if (last && last.label === stageLabel(p.stage)) last.n++; else out.push({ label: stageLabel(p.stage), n: 1 });
    }
    return out.map((g) => `${g.label} (${g.n})`).join(", ");
  };
  line(`${part.items.length} photo${part.items.length === 1 ? "" : "s"}${parts.length > 1 ? ` of ${ctx.total}` : ""}, ${pageCount - 1} page${pageCount - 1 === 1 ? "" : "s"}: ${counts(part.items)}`);
  for (const other of parts) {
    if (other === part) continue;
    line(`Part ${other.index + 1} of ${parts.length} is a separate file: ${other.items.length} photos, ${counts(other.items)}`, { color: C.sub });
  }
  y -= 4;
  for (const ln of wrapText(
    "Photos are grouped before / during / after the work. Each is numbered by its position in the job photo log" +
    (links.length ? " — the same number that starts its file name in the download at the link above." : ".") +
    " The label under each photo gives its number, stage, location and caption.", 9, false, CONTENT_W - 4)) line(ln, { size: 9, color: C.tag });
  y -= 2;
  line(`Generated ${fmtDate(ctx.generated)} by Roybal Field Forms.`, { size: 8, color: C.sub });

  hline(ops, M.l, PAGE.w - M.r, M.b + 12, 0.5, C.rule);
  text(ops, M.l, M.b + 3, "Roybal Construction, LLC — Photo Log", { size: 7.5, color: C.sub });
  text(ops, PAGE.w - M.r, M.b + 3, `Page 1 of ${pageCount}`, { size: 7.5, color: C.sub, align: "right" });
  return { ops, images: [], annots };
}

function emitPage(doc, pagesObj, fonts, page) {
  const xobj = page.images.map((p) => {
    const cs = p.info.components === 1 ? "/DeviceGray" : p.info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    const decode = p.info.components === 4 ? " /Decode [1 0 1 0 1 0 1 0]" : "";   // Adobe CMYK JPEGs are inverted
    return doc.add(...doc.stream(`/Type /XObject /Subtype /Image /Width ${p.info.width} /Height ${p.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode}`, p.jpeg));
  });
  const content = doc.add(...doc.stream("", latin1(page.ops.join("\n"))));
  const annots = page.annots.map((a) =>
    doc.add(`<< /Type /Annot /Subtype /Link /Rect [${a.rect.map(n2).join(" ")}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(latin1(a.url))} >> >>`));
  const res = `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R >>` +
    (xobj.length ? ` /XObject << ${xobj.map((n, i) => `/Im${i + 1} ${n} 0 R`).join(" ")} >>` : "") + " >>";
  return doc.add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources ${res} /Contents ${content} 0 R` +
    (annots.length ? ` /Annots [${annots.map((n) => n + " 0 R").join(" ")}]` : "") + " >>");
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function buildPart(ctx, part, parts) {
  const doc = pdfDoc();
  const catalog = doc.reserve(), pagesObj = doc.reserve();
  const fonts = [
    doc.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    doc.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
  ];
  const items = part.items;
  const pageCount = 1 + Math.ceil(items.length / PER_PAGE);
  // a band above the first photo of each stage in this part; "continued"
  // when the stage began in an earlier part
  const groupStarts = new Map();
  items.forEach((p, i) => {
    if (i && stageRank(items[i - 1].stage) === stageRank(p.stage)) return;
    const inPart = items.filter((q) => stageRank(q.stage) === stageRank(p.stage)).length;
    const continued = i === 0 && part.index > 0 &&
      stageRank(parts[part.index - 1].items[parts[part.index - 1].items.length - 1].stage) === stageRank(p.stage);
    groupStarts.set(p, `${stageLabel(p.stage)} (${inPart})${continued ? " · continued" : ""}`);
  });
  const partLabel = parts.length > 1 ? `Part ${part.index + 1} of ${parts.length}` : "";
  const pages = [emitPage(doc, pagesObj, fonts, coverPage(ctx, part, parts, pageCount))];
  for (let i = 0; i < items.length; i += PER_PAGE)
    pages.push(emitPage(doc, pagesObj, fonts, photoPage(ctx, items.slice(i, i + PER_PAGE), groupStarts, partLabel, pages.length + 1, pageCount)));
  doc.set(pagesObj, `<< /Type /Pages /Kids [${pages.map((n) => n + " 0 R").join(" ")}] /Count ${pages.length} >>`);
  doc.set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const title = ["Photo Log", ctx.header.customer, ctx.header.claimNo ? "Claim " + ctx.header.claimNo : "", partLabel].filter(Boolean).join(" - ");
  const info = doc.add(`<< /Title ${lit(title)} /Producer (Roybal Field Forms) /Creator (Roybal Field Forms) /CreationDate (${stamp(ctx.generated)}) >>`);
  return { bytes: doc.finish(catalog, info), pages: pageCount };
}

/* ---------- entry point ----------
   spec: {
     header: { customer, address, claimNo, dateOfLoss },
     links:  [{ head, url, sub, qr: boolean[][] }]   (only live links — none prints as nothing)
     photos: [{ num, stage, room, caption, item, jpeg: Uint8Array, preview }]
     maxBytes, generated (Date)
   }
   → { parts: [{ bytes, pages, count, first, last, stages }], skipped: [num…], total } */
export function buildPhotoLogPdf(spec) {
  const generated = spec.generated instanceof Date ? spec.generated : new Date();
  const header = {
    customer: String(spec.header?.customer || "").trim(),
    address: String(spec.header?.address || "").trim(),
    claimNo: String(spec.header?.claimNo || "").trim(),
    dateOfLoss: String(spec.header?.dateOfLoss || "").trim(),
  };
  const skipped = [];
  const photos = [];
  for (const p of spec.photos || []) {
    const info = jpegInfo(p.jpeg);
    if (!info) { skipped.push(p.num); continue; }
    photos.push({ ...p, info });
  }
  // grouped before → during → after; ties keep log order (stable sort)
  photos.sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.num - b.num);
  const ranges = planParts(photos.map((p) => p.jpeg.length), spec.maxBytes || PART_MAX_BYTES);
  const parts = ranges.map(([a, b], index) => ({ index, items: photos.slice(a, b) }));
  const ctx = { header, links: spec.links || [], generated, total: photos.length };
  return {
    total: photos.length,
    skipped,
    parts: parts.map((part) => {
      const { bytes, pages } = buildPart(ctx, part, parts);
      const stages = {};
      for (const p of part.items) stages[stageLabel(p.stage)] = (stages[stageLabel(p.stage)] || 0) + 1;
      return { bytes, pages, count: part.items.length, nums: part.items.map((p) => p.num), stages };
    }),
  };
}
