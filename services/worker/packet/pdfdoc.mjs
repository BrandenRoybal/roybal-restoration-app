/* The carrier packet's PDF writer — pages, text, lines, boxes, images,
   links, bookmarks and the document info, with no dependency.

   It is the same kind of writer as apps/field/js/photopdf.js (which this
   file borrows its Helvetica metrics, WinAnsi mapping, word wrap and JPEG
   header reader from), grown to what a multi-section document needs:

   - images are objects of the DOCUMENT, keyed by the caller (a media hash)
     and by their bytes, so a meter photo printed on its moisture map and
     again on the Certificate of Drying is stored once;
   - JPEGs pass through untouched (/DCTDecode); PNGs (signatures, which are
     transparent canvas exports) are decoded, flattened onto white and
     re-deflated with the PNG row predictors (/FlateDecode) — node:zlib,
     nothing to install;
   - three fonts: Helvetica, Helvetica-Bold, Helvetica-Oblique (the oblique
     shares the regular widths);
   - page links to a URL or to another page, a nested outline (bookmarks),
     and custom /Info keys (the packet number, version and model hash) plus
     a trailer /ID derived from the bytes. Bookmark titles and /Info values
     are written as UTF-16 when they are not plain ASCII: those strings are
     PDFDocEncoding, not WinAnsi, and an em dash in WinAnsi reads there as
     a different letter.

   Output is deterministic: the same calls give the same bytes. Nothing reads
   the clock; the caller passes the creation date and the zone it is shown
   in (the worker runs on UTC, the packet is dated on the Alaska clock). */

import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { winAnsi, textWidth as tw, wrapText as wrap, jpegInfo } from "../../../apps/field/js/photopdf.js";

export const PAGE = { w: 612, h: 792 };                        // US letter, points

/* print.css colours as PDF rgb operands */
export const C = {
  navy: "0.059 0.106 0.176", orange: "0.949 0.416 0.129", black: "0 0 0", white: "1 1 1",
  tag: "0.267 0.333 0.420", sub: "0.357 0.420 0.502", border: "0.420 0.471 0.573",
  rule: "0.769 0.800 0.847", band: "0.933 0.949 0.969", link: "0.110 0.373 0.690",
  box: "0.957 0.961 0.969", green: "0.086 0.459 0.255", red: "0.706 0.137 0.098",
  dryFill: "0.886 0.957 0.914", wetFill: "0.996 0.925 0.906", gray: "0.600 0.620 0.660",
  placeholder: "0.898 0.906 0.922",
};

/* ---------- text ---------- */
const FONTS = { reg: "F1", bold: "F2", ital: "F3" };
/* Characters a form or a tech's keyboard produces that Helvetica's WinAnsi
   set lacks, spelled out. photopdf.js drops what it cannot map, and a dry
   goal of "≤ 16%" must not print as " 16%". (× and ° are Latin-1 and print
   as themselves.) */
const SPELL = [
  [/≤/g, "<="], [/≥/g, ">="], [/≠/g, "!="], [/≈/g, "~"],
  [/[✓✔✅☑]/g, "Yes"], [/[✗✘❌☒]/g, "No"], [/☐/g, "[ ]"],
  [/[✕✖]/g, "x"], [/↔/g, "<->"], [/℉/g, "°F"], [/℃/g, "°C"], [/№/g, "No."],
  [/＋/g, "+"], [/－/g, "-"], [/Δ/g, "Delta "], [/[①-⑳]/g, (c) => `(${c.codePointAt(0) - 0x245f})`],
];
export const norm = (str) => {
  let s = String(str == null ? "" : str).normalize("NFC");
  for (const [re, to] of SPELL) s = s.replace(re, to);
  return s;
};
export const textWidth = (str, size, font = "reg") => tw(norm(str), size, font === "bold");
export const wrapText = (str, size, font, width, opts) => wrap(norm(str), size, font === "bold", width, opts);
export { winAnsi, jpegInfo };

const latin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
const toBytes = (x) => (typeof x === "string" ? latin1(x) : x);
const pdfStr = (bytes) => {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
};
/* a string shown on the page (WinAnsi, the fonts' encoding) */
export const lit = (str) => pdfStr(winAnsi(norm(str)));
/* a "text string" (bookmark titles, /Info): ASCII as itself, anything
   else as UTF-16BE with its byte-order mark */
export const textString = (str) => {
  const s = String(str == null ? "" : str).normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (/^[\x20-\x7e]*$/.test(s)) return pdfStr(latin1(s));
  let hex = "<FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return hex + ">";
};
export const n2 = (v) => {
  const r = Math.round(v * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};
/* a PDF name from a free key: letters and digits only */
const pdfName = (k) => "/" + (String(k).replace(/[^A-Za-z0-9]/g, "") || "X");

/* A Date as a PDF date on the wall clock of `timeZone`, with that zone's
   offset at that instant: D:20261010120000-08'00' in Alaska summer time,
   -09'00' in winter. Intl does the zone arithmetic, so the result is the
   same on a UTC container as on an Alaska laptop. "" for a bad date. */
export function pdfDate(d, timeZone = "UTC") {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]));
  } catch { return pdfDate(d, "UTC"); }
  const p2 = (n) => String(n).padStart(2, "0");
  const Y = Number(parts.year), Mo = Number(parts.month), D = Number(parts.day);
  const h = Number(parts.hour) % 24, mi = Number(parts.minute), s = Number(parts.second);
  const wall = Date.UTC(Y, Mo - 1, D, h, mi, s);
  const off = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);   // minutes east of UTC
  const zone = off === 0 ? "Z" : `${off < 0 ? "-" : "+"}${p2(Math.floor(Math.abs(off) / 60))}'${p2(Math.abs(off) % 60)}'`;
  return `D:${String(Y).padStart(4, "0")}${p2(Mo)}${p2(D)}${p2(h)}${p2(mi)}${p2(s)}${zone}`;
}

/* ---------- PNG → flattened RGB ---------- */
/* Decode a non-interlaced PNG of any colour type (8 or 16 bits, taking the
   high byte of 16; 1, 2 or 4 bits for palette and grey), composite any
   alpha onto white, and return { width, height, rgb: Uint8Array } — or null
   when it is not a PNG this can read (interlaced, corrupt, unknown type). */
export function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null;
  const be32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  let o = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (o + 8 <= b.length) {
    const len = be32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (o + 12 + len > b.length) return null;
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = be32(o + 8); height = be32(o + 12); depth = b[o + 16]; ctype = b[o + 17]; interlace = b[o + 20];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (!width || !height || interlace !== 0 || !idat.length) return null;
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) return null;
  const depths = ctype === 3 ? [1, 2, 4, 8] : ctype === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!depths.includes(depth)) return null;
  if (width * height > 40_000_000) return null;                // a page-sized scan at most
  let raw;
  try { raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d)))); } catch { return null; }
  const bitsPerPixel = chans * depth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));       // filter unit in bytes
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) return null;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const u = y ? px[up + x] : 0;
      const c = y && x >= bpp ? px[up + x - bpp] : 0;
      let out;
      switch (f) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + u; break;
        case 3: out = v + ((a + u) >> 1); break;
        case 4: {
          const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c);
          break;
        }
        default: return null;
      }
      px[dst + x] = out & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  const sample = (row, i) => {                                 // i-th sample of a row, as stored
    if (depth === 16) return px[row * stride + i * 2];
    if (depth === 8) return px[row * stride + i];
    const per = 8 / depth, byte = px[row * stride + Math.floor(i / per)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const greyScale = depth < 8 ? 255 / ((1 << depth) - 1) : 1; // a 1-bit grey sample is 0 or 255
  const tr16 = (k) => (trns && trns.length >= k * 2 + 2 ? (depth === 16 ? trns[k * 2] : trns[k * 2 + 1]) : -1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r, g, bl, al = 255;
      if (ctype === 0) {
        const v = sample(y, x);
        if (trns && v === tr16(0)) al = 0;
        r = g = bl = Math.round(v * greyScale);
      } else if (ctype === 2) {
        r = sample(y, x * 3); g = sample(y, x * 3 + 1); bl = sample(y, x * 3 + 2);
        if (trns && r === tr16(0) && g === tr16(1) && bl === tr16(2)) al = 0;
      } else if (ctype === 3) {
        const k = sample(y, x);
        if (!palette || palette.length < k * 3 + 3) return null;
        r = palette[k * 3]; g = palette[k * 3 + 1]; bl = palette[k * 3 + 2];
        if (trns && k < trns.length) al = trns[k];
      } else if (ctype === 4) {
        r = g = bl = sample(y, x * 2); al = sample(y, x * 2 + 1);
      } else {
        r = sample(y, x * 4); g = sample(y, x * 4 + 1); bl = sample(y, x * 4 + 2); al = sample(y, x * 4 + 3);
      }
      const o3 = (y * width + x) * 3;
      // composite onto white: c·a + 255·(1−a)
      rgb[o3] = Math.round((r * al + 255 * (255 - al)) / 255);
      rgb[o3 + 1] = Math.round((g * al + 255 * (255 - al)) / 255);
      rgb[o3 + 2] = Math.round((bl * al + 255 * (255 - al)) / 255);
    }
  }
  return { width, height, rgb };
}

/* Rows of samples with a PNG predictor in front of each (the filter with the
   smallest sum of absolute values, the usual heuristic): deflate shrinks a
   flattened signature or a scanned page several times better this way than
   as bare samples. /DecodeParms /Predictor 15 tells the reader. */
function predictRows(px, width, height, chans) {
  const stride = width * chans;
  const out = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride;
    const sums = [0, 0, 0, 0, 0];
    for (let x = 0; x < stride; x++) {
      const v = px[row + x];
      const a = x >= chans ? px[row + x - chans] : 0;
      const u = y ? px[up + x] : 0;
      const c = y && x >= chans ? px[up + x - chans] : 0;
      const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
      const f = [v, (v - a) & 0xff, (v - u) & 0xff, (v - ((a + u) >> 1)) & 0xff, (v - pred) & 0xff];
      for (let k = 0; k < 5; k++) { cand[k][x] = f[k]; sums[k] += f[k] < 128 ? f[k] : 256 - f[k]; }
    }
    let best = 0;
    for (let k = 1; k < 5; k++) if (sums[k] < sums[best]) best = k;
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/* the image kind from its first bytes */
export function imageKind(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

/* ---------- pages ---------- */
class Page {
  constructor(doc, index) {
    this.doc = doc;
    this.index = index;                                        // 0-based
    this.ops = [];
    this.xobjs = new Map();                                    // image name → image
    this.annots = [];
  }
  raw(op) { this.ops.push(op); }

  /* Text at a baseline; returns its width. maxWidth trims (no ellipsis);
     spacing is extra space between letters (print.css letter-spacing). */
  text(x, y, str, { size = 9, font = "reg", color = C.black, align = "left", maxWidth = 0, spacing = 0 } = {}) {
    let s = norm(str);
    const width = (t) => textWidth(t, size, font) + (spacing && t.length > 1 ? spacing * (t.length - 1) : 0);
    if (maxWidth) while (s && width(s) > maxWidth) s = s.slice(0, -1);
    if (!s) return 0;
    const w = width(s);
    const tx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    const op = `BT /${FONTS[font] || "F1"} ${n2(size)} Tf ${spacing ? `${n2(spacing)} Tc ` : ""}${color} rg ${n2(tx)} ${n2(y)} Td ${lit(s)} Tj ET`;
    // character spacing is graphics state and outlives ET: keep it to this text
    this.ops.push(spacing ? `q ${op} Q` : op);
    return w;
  }

  line(x1, y1, x2, y2, { width = 0.5, color = C.rule, dash = null } = {}) {
    const d = dash ? `[${dash.map(n2).join(" ")}] 0 d ` : "";
    this.ops.push(`q ${d}${n2(width)} w ${color} RG ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S Q`);
  }

  /* x, y = bottom-left */
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    if (fill) this.ops.push(`${fill} rg ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`);
    if (stroke) this.ops.push(`q ${n2(width)} w ${stroke} RG ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re S Q`);
  }

  circle(cx, cy, r, { fill = null, stroke = null, width = 0.5 } = {}) {
    const k = 0.5523 * r;
    const path = `${n2(cx + r)} ${n2(cy)} m ` +
      `${n2(cx + r)} ${n2(cy + k)} ${n2(cx + k)} ${n2(cy + r)} ${n2(cx)} ${n2(cy + r)} c ` +
      `${n2(cx - k)} ${n2(cy + r)} ${n2(cx - r)} ${n2(cy + k)} ${n2(cx - r)} ${n2(cy)} c ` +
      `${n2(cx - r)} ${n2(cy - k)} ${n2(cx - k)} ${n2(cy - r)} ${n2(cx)} ${n2(cy - r)} c ` +
      `${n2(cx + k)} ${n2(cy - r)} ${n2(cx + r)} ${n2(cy - k)} ${n2(cx + r)} ${n2(cy)} c h`;
    const paint = fill && stroke ? "B" : fill ? "f" : "S";
    this.ops.push(`q ${fill ? fill + " rg " : ""}${stroke ? `${n2(width)} w ${stroke} RG ` : ""}${path} ${paint} Q`);
  }

  /* draw an image (from doc.image) into a box, stretched to w×h */
  image(img, x, y, w, h) {
    if (!img) return;
    this.xobjs.set(img.name, img);
    this.ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(y)} cm /${img.name} Do Q`);
  }

  /* object-fit: contain in the box; returns the drawn rect. align "center"
     (default) or "left" (a signature sits at the start of its line);
     valign "middle" (default) or "top" (a document page under its caption). */
  imageFit(img, x, y, w, h, { align = "center", valign = "middle", maxScale = Infinity } = {}) {
    if (!img || !img.width || !img.height) return null;
    const s = Math.min(w / img.width, h / img.height, maxScale);
    const dw = img.width * s, dh = img.height * s;
    const dx = align === "left" ? x : x + (w - dw) / 2;
    const dy = valign === "top" ? y + h - dh : y + (h - dh) / 2;
    this.image(img, dx, dy, dw, dh);
    return { x: dx, y: dy, w: dw, h: dh };
  }

  /* a clickable area: { url } or { page } (0-based index of another page) */
  link(x, y, w, h, target) {
    if (!target) return;
    if (target.url && /^https?:\/\//i.test(target.url)) this.annots.push({ rect: [x, y, x + w, y + h], url: target.url });
    else if (Number.isInteger(target.page)) this.annots.push({ rect: [x, y, x + w, y + h], page: target.page });
  }
}

/* ---------- the document ---------- */
export class PdfDoc {
  /* compress: deflate the page content streams (a table-heavy packet's
     text operators are several times its fonts and structure) */
  constructor({ compress = true } = {}) {
    this.compress = compress;
    this.pages = [];
    this.images = new Map();                                   // key → image
    this.byBytes = new Map();                                  // sha256 of the bytes → image
    this.outlineItems = [];
  }

  addPage() {
    const p = new Page(this, this.pages.length);
    this.pages.push(p);
    return p;
  }

  /* An image for these bytes, stored once per key and once per content.
     JPEG passes through; PNG is flattened. Returns { name, width, height,
     kind } or null when the bytes are not an image this writer can embed. */
  image(bytes, key) {
    const k = String(key || "");
    if (k && this.images.has(k)) return this.images.get(k);
    if (!bytes || !bytes.length) return null;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = createHash("sha256").update(u8).digest("hex");
    if (this.byBytes.has(digest)) {
      const same = this.byBytes.get(digest);
      if (k) this.images.set(k, same);
      return same;
    }
    const kind = imageKind(u8);
    let img = null;
    if (kind === "jpeg") {
      const info = jpegInfo(u8);
      if (info && [1, 3, 4].includes(info.components)) {
        img = { kind, width: info.width, height: info.height, components: info.components, data: u8 };
      }
    } else if (kind === "png") {
      const px = decodePng(u8);
      if (px) {
        // a grey image (a scanned page) keeps one channel
        let grey = true;
        for (let i = 0; i < px.rgb.length && grey; i += 3) grey = px.rgb[i] === px.rgb[i + 1] && px.rgb[i] === px.rgb[i + 2];
        const chans = grey ? 1 : 3;
        let samples = px.rgb;
        if (grey) { samples = new Uint8Array(px.width * px.height); for (let i = 0; i < samples.length; i++) samples[i] = px.rgb[i * 3]; }
        img = { kind, width: px.width, height: px.height, components: chans, data: deflateSync(predictRows(samples, px.width, px.height, chans), { level: 9 }) };
      }
    }
    if (!img) return null;
    img.name = "Im" + (this.byBytes.size + 1);
    this.byBytes.set(digest, img);
    this.images.set(k || img.name, img);
    return img;
  }

  /* bookmarks: [{ title, page, children?: [...] }], page 0-based; shown open */
  outline(items) { this.outlineItems = Array.isArray(items) ? items : []; }

  /* info: { title, subject, author, keywords, creator, producer,
             created: Date, timeZone, custom: { Key: "value" } } */
  finish(info = {}) {
    const objs = [];
    const reserve = () => { objs.push(null); return objs.length; };
    const set = (n, ...parts) => { objs[n - 1] = parts.map(toBytes); };
    const add = (...parts) => { const n = reserve(); set(n, ...parts); return n; };
    const stream = (dict, bytes) => [`<< ${dict}${dict ? " " : ""}/Length ${bytes.length} >>\nstream\n`, bytes, "\nendstream"];

    const catalog = reserve(), pagesObj = reserve();
    const fonts = {
      F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
      F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
    };
    // images in the order they were first added (deterministic)
    const imgObj = new Map();
    for (const img of this.byBytes.values()) {
      const cs = img.components === 1 ? "/DeviceGray" : img.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      if (img.kind === "jpeg") {
        const decode = img.components === 4 ? " /Decode [1 0 1 0 1 0 1 0]" : "";   // Adobe CMYK JPEGs are inverted
        imgObj.set(img.name, add(...stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode}`, img.data)));
      } else {
        imgObj.set(img.name, add(...stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /FlateDecode` +
          ` /DecodeParms << /Predictor 15 /Colors ${img.components} /BitsPerComponent 8 /Columns ${img.width} >>`, img.data)));
      }
    }
    const pageObjs = this.pages.map(() => reserve());
    const fontRes = `/Font << ${Object.entries(fonts).map(([k, n]) => `/${k} ${n} 0 R`).join(" ")} >>`;
    this.pages.forEach((p, i) => {
      const ops = latin1(p.ops.join("\n"));
      const content = this.compress
        ? add(...stream("/Filter /FlateDecode", deflateSync(ops, { level: 6 })))
        : add(...stream("", ops));
      const annots = p.annots.map((a) => {
        const rect = `/Rect [${a.rect.map(n2).join(" ")}] /Border [0 0 0]`;
        if (a.url) return add(`<< /Type /Annot /Subtype /Link ${rect} /A << /S /URI /URI ${pdfStr(latin1(a.url))} >> >>`);
        const dest = pageObjs[a.page];
        return dest ? add(`<< /Type /Annot /Subtype /Link ${rect} /Dest [${dest} 0 R /Fit] >>`) : null;
      }).filter(Boolean);
      const xo = [...p.xobjs.keys()].map((name) => `/${name} ${imgObj.get(name)} 0 R`);
      const res = `<< ${fontRes}${xo.length ? ` /XObject << ${xo.join(" ")} >>` : ""} >>`;
      set(pageObjs[i], `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources ${res} /Contents ${content} 0 R` +
        (annots.length ? ` /Annots [${annots.map((n) => n + " 0 R").join(" ")}]` : "") + " >>");
    });
    set(pagesObj, `<< /Type /Pages /Kids [${pageObjs.map((n) => n + " 0 R").join(" ")}] /Count ${pageObjs.length} >>`);

    // outline, every level open: /Count is the number of visible descendants
    let outlines = 0;
    const valid = (list) => (list || []).filter((it) => it && String(it.title || "").trim() && pageObjs[it.page]);
    const items = valid(this.outlineItems);
    if (items.length) {
      outlines = reserve();
      const build = (list, parent) => {
        const nums = list.map(() => reserve());
        let total = 0;
        list.forEach((it, i) => {
          const kids = valid(it.children);
          const sub = kids.length ? build(kids, nums[i]) : null;
          total += 1 + (sub ? sub.total : 0);
          set(nums[i], `<< /Title ${textString(String(it.title).trim())} /Parent ${parent} 0 R` +
            (i ? ` /Prev ${nums[i - 1]} 0 R` : "") + (i < list.length - 1 ? ` /Next ${nums[i + 1]} 0 R` : "") +
            (sub ? ` /First ${sub.first} 0 R /Last ${sub.last} 0 R /Count ${sub.total}` : "") +
            ` /Dest [${pageObjs[it.page]} 0 R /XYZ null null null] >>`);
        });
        return { first: nums[0], last: nums[nums.length - 1], total };
      };
      const top = build(items, outlines);
      set(outlines, `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${top.total} >>`);
    }
    set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R` + (outlines ? ` /Outlines ${outlines} 0 R /PageMode /UseOutlines` : "") + " >>");

    const kv = [];
    if (info.title) kv.push(`/Title ${textString(info.title)}`);
    if (info.subject) kv.push(`/Subject ${textString(info.subject)}`);
    if (info.author) kv.push(`/Author ${textString(info.author)}`);
    if (info.keywords) kv.push(`/Keywords ${textString(info.keywords)}`);
    kv.push(`/Creator ${textString(info.creator || "Roybal Field Forms")}`);
    kv.push(`/Producer ${textString(info.producer || "Roybal Field Forms")}`);
    const created = pdfDate(info.created, info.timeZone || "UTC");
    if (created) kv.push(`/CreationDate (${created})`, `/ModDate (${created})`);
    for (const [k, v] of Object.entries(info.custom || {})) if (v != null && v !== "") kv.push(`${pdfName(k)} ${textString(v)}`);
    const infoObj = add(`<< ${kv.join(" ")} >>`);

    // serialise
    const out = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
    let offset = out[0].length;
    const offsets = [];
    objs.forEach((parts, i) => {
      offsets.push(offset);
      const chunk = [latin1(`${i + 1} 0 obj\n`), ...(parts || [latin1("null")]), latin1("\nendobj\n")];
      for (const c of chunk) { out.push(c); offset += c.length; }
    });
    const hash = createHash("md5");
    for (const c of out) hash.update(c);
    const id = hash.digest("hex");
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n%%EOF\n`;
    out.push(latin1(xref));
    const total = out.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of out) { bytes.set(c, at); at += c.length; }
    return bytes;
  }
}

export const createPdf = (opts) => new PdfDoc(opts);
