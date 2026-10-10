/* The carrier packet's PDF writer and flow layout (packet/pdfdoc.mjs,
   packet/flow.mjs): the file structure a reader needs (xref offsets,
   trailer, outline, /Info), images (JPEG byte for byte and stored once,
   PNG decoded, flattened onto white and re-deflated), text that survives
   WinAnsi, dates on the Alaska clock whatever the container's zone, and
   the layout rules: tables that split and repeat their header, wrapping
   that never leaves the box, headings that never sit alone at a page
   bottom, no blank pages. Everything is made up here; nothing touches the
   network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { createPdf, decodePng, imageKind, norm, winAnsi, textString, pdfDate, textWidth, PAGE, C } from "../packet/pdfdoc.mjs";
import { Flow, M, CONTENT_W, BODY_TOP, BODY_BOTTOM, BODY_H } from "../packet/flow.mjs";

const IMAGES = new URL("../../../apps/site/public/images/", import.meta.url);
const jpg = (f) => new Uint8Array(readFileSync(new URL(f, IMAGES)));
const JPG_A = jpg("90369908-the-strength-beneath.jpg");
const JPG_B = jpg("2ae21081-pressure-treated-wood.jpg");
const RIGHT = M.l + CONTENT_W;

/* ---------- a tiny PNG encoder (filter 0 rows) ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png({ width, height, ctype, depth = 8, rows, plte = null, trns = null, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = ctype; ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", plte)] : []), ...(trns ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const px = (rgb, x) => [...rgb.subarray(x * 3, x * 3 + 3)];

/* ---------- a small reader for what the writer wrote ---------- */
function readPdf(bytes) {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4\n"), "PDF header");
  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(s);
  assert.ok(tail, "startxref and %%EOF at the end");
  const xrefAt = Number(tail[1]);
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
  assert.ok(head, "startxref points at the xref table");
  const size = Number(head[1]);
  const rows = s.slice(xrefAt + head[0].length).split("\n").slice(0, size);
  assert.equal(rows[0], "0000000000 65535 f ");
  const objs = new Map();
  for (let n = 1; n < size; n++) {
    assert.match(rows[n], /^\d{10} 00000 n $/);
    const off = Number(rows[n].slice(0, 10));
    const open = `${n} 0 obj\n`;
    assert.equal(s.slice(off, off + open.length), open, `object ${n} starts at its xref offset`);
    const at = off + open.length;
    const st = /^<< (.*?)\/Length (\d+) >>\nstream\n/.exec(s.slice(at, at + 4000));
    if (st) {
      const start = at + st[0].length, len = Number(st[2]);
      assert.equal(s.slice(start + len, start + len + 18), "\nendstream\nendobj\n", `object ${n}'s /Length is its stream's length`);
      objs.set(n, { dict: st[1], data: buf.subarray(start, start + len) });
    } else objs.set(n, { body: s.slice(at, s.indexOf("\nendobj\n", at)) });
  }
  const trailer = /trailer\n<< (.*) >>\nstartxref/.exec(s)[1];
  assert.match(trailer, new RegExp(`/Size ${size} `));
  const ref = (body, key) => { const m = new RegExp(`/${key} (\\d+) 0 R`).exec(body); return m ? Number(m[1]) : 0; };
  const catalog = objs.get(ref(trailer, "Root")).body;
  const kids = /\/Kids \[([^\]]*)\]/.exec(objs.get(ref(catalog, "Pages")).body)[1].match(/\d+(?= 0 R)/g).map(Number);
  const stream = (o) => (/\/FlateDecode/.test(o.dict) && !/\/Subtype \/Image/.test(o.dict) ? inflateSync(o.data) : Buffer.from(o.data));
  const pages = kids.map((n) => {
    const body = objs.get(n).body;
    return { n, body, ops: stream(objs.get(ref(body, "Contents"))).toString("latin1") };
  });
  return { s, objs, trailer, size, catalog, pages, ref };
}

/* WinAnsi bytes back to Unicode (the 0x80-0x9F block), for widths */
const FROM_WIN = (() => {
  const m = new Map();
  for (let cp = 0x100; cp < 0x2200; cp++) {
    const b = winAnsi(String.fromCodePoint(cp));
    if (b.length === 1 && b[0] >= 0x80 && b[0] <= 0x9f && !m.has(b[0])) m.set(b[0], String.fromCodePoint(cp));
  }
  return m;
})();
const unwin = (s) => [...s].map((ch) => FROM_WIN.get(ch.charCodeAt(0)) || ch).join("");
const unlit = (s) => s.replace(/\\([0-7]{3}|[\\()])/g, (_, e) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e));
const FONT = { 1: "reg", 2: "bold", 3: "ital" };
/* every text-showing operator of a content stream */
function textOps(ops) {
  const out = [];
  const re = /BT \/F([123]) ([\d.]+) Tf (?:([\d.]+) Tc )?(?:[\d.]+ ){3}rg (-?[\d.]+) (-?[\d.]+) Td \(((?:\\[0-7]{3}|\\[\\()]|[^\\)])*)\) Tj ET/g;
  for (let m; (m = re.exec(ops));) {
    const text = unwin(unlit(m[6]));
    const size = Number(m[2]), spacing = Number(m[3] || 0), font = FONT[m[1]];
    out.push({ font, size, x: Number(m[4]), y: Number(m[5]), text, w: textWidth(text, size, font) + spacing * Math.max(0, text.length - 1) });
  }
  return out;
}
const textOf = (ops) => textOps(ops).map((t) => t.text).join(" ");
/* the text ops a flow page holds right now (before finish) */
const pageOps = (page) => textOps(page.ops.join("\n"));
/* a literal or UTF-16 PDF text string → JS string */
function decodeTextString(tok) {
  if (tok.startsWith("<FEFF")) {
    const hex = tok.slice(5, -1);
    let out = "";
    for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  }
  return unlit(tok.slice(1, -1));
}

/* ============================== pdfdoc ============================== */

test("pdfdoc: a two-page document has a valid header, xref, trailer and /ID", () => {
  const doc = createPdf();
  doc.addPage().text(M.l, 700, "First page");
  doc.addPage().text(M.l, 700, "Second page", { font: "bold" });
  const pdf = readPdf(doc.finish({ title: "Two pages", created: new Date("2026-10-10T20:00:00Z") }));
  assert.equal(pdf.pages.length, 2);
  assert.match(pdf.trailer, /\/Root \d+ 0 R \/Info \d+ 0 R \/ID \[<([0-9a-f]{32})> <\1>\]/);
  assert.match(textOf(pdf.pages[0].ops), /First page/);
  assert.match(textOf(pdf.pages[1].ops), /Second page/);
  assert.match(pdf.pages[0].body, /\/MediaBox \[0 0 612 792\]/);
});

test("pdfdoc: the same calls give the same bytes", () => {
  const make = () => {
    const doc = createPdf();
    const p = doc.addPage();
    p.text(M.l, 700, "Same every time ≤ 16%");
    p.image(doc.image(JPG_A, "a"), M.l, 400, 200, 150);
    p.image(doc.image(png({ width: 2, height: 1, ctype: 6, rows: [[255, 0, 0, 255, 0, 0, 255, 0]] }), "p"), M.l, 300, 20, 10);
    doc.outline([{ title: "Only — section", page: 0 }]);
    return doc.finish({ title: "Same", created: new Date("2026-10-10T20:00:00Z"), timeZone: "America/Anchorage", custom: { PacketNumber: "PKT-2026-0001" } });
  };
  assert.deepEqual(make(), make());
});

test("pdfdoc: a JPEG passes through byte for byte, stored once per key and once per content", () => {
  const doc = createPdf();
  const a1 = doc.image(JPG_A, "meter-1");
  const a2 = doc.image(JPG_A, "meter-1");
  const a3 = doc.image(new Uint8Array(JPG_A), "meter-dup");          // the same bytes under another key
  const b = doc.image(JPG_B, "meter-2");
  assert.equal(a1, a2);
  assert.equal(a1, a3);
  assert.notEqual(a1, b);
  const p1 = doc.addPage(), p2 = doc.addPage();
  p1.image(a1, M.l, 400, 100, 80);
  p2.image(a3, M.l, 400, 100, 80);
  p2.image(b, M.l, 200, 100, 80);
  const pdf = readPdf(doc.finish());
  const jpegs = [...pdf.objs.entries()].filter(([, o]) => o.dict && /\/DCTDecode/.test(o.dict));
  assert.equal(jpegs.length, 2, "two distinct JPEGs, two image objects");
  const [nA, oA] = jpegs.find(([, o]) => Buffer.compare(Buffer.from(o.data), Buffer.from(JPG_A)) === 0);
  assert.ok(nA, "the JPEG's bytes are in the file unchanged");
  assert.match(oA.dict, new RegExp(`/Width ${a1.width} /Height ${a1.height} /ColorSpace /DeviceRGB /BitsPerComponent 8`));
  for (const pg of pdf.pages) assert.match(pg.body, new RegExp(`/${a1.name} ${nA} 0 R`), "both pages draw the one object");
});

test("pdfdoc: PNG decode flattens RGBA onto white", () => {
  const img = decodePng(png({ width: 3, height: 1, ctype: 6, rows: [[255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 128]] }));
  assert.equal(img.width, 3);
  assert.equal(img.height, 1);
  assert.deepEqual(px(img.rgb, 0), [255, 0, 0], "opaque keeps its colour");
  assert.deepEqual(px(img.rgb, 1), [255, 255, 255], "transparent is white paper");
  assert.deepEqual(px(img.rgb, 2), [127, 127, 127], "half-transparent black is half grey");
});

test("pdfdoc: PNG decode reads palette + tRNS, 16-bit, grey and grey + alpha", () => {
  // 2-bit palette, the third entry transparent
  const pal = decodePng(png({ width: 4, height: 1, ctype: 3, depth: 2, rows: [[0b00011011]],
    plte: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]), trns: Buffer.from([255, 255, 0]) }));
  assert.deepEqual([0, 1, 2, 3].map((x) => px(pal.rgb, x)), [[255, 0, 0], [0, 255, 0], [255, 255, 255], [10, 20, 30]]);
  // 16-bit RGB takes the high byte
  const deep = decodePng(png({ width: 1, height: 1, ctype: 2, depth: 16, rows: [[0x12, 0x34, 0xab, 0xcd, 0xff, 0x00]] }));
  assert.deepEqual(px(deep.rgb, 0), [0x12, 0xab, 0xff]);
  // 16-bit RGBA, fully transparent
  const deepA = decodePng(png({ width: 1, height: 1, ctype: 6, depth: 16, rows: [[0, 0, 0, 0, 0, 0, 0, 0]] }));
  assert.deepEqual(px(deepA.rgb, 0), [255, 255, 255]);
  // 1-bit grey: black, white
  const bits = decodePng(png({ width: 2, height: 1, ctype: 0, depth: 1, rows: [[0b01000000]] }));
  assert.deepEqual([px(bits.rgb, 0), px(bits.rgb, 1)], [[0, 0, 0], [255, 255, 255]]);
  // grey + alpha
  const ga = decodePng(png({ width: 1, height: 1, ctype: 4, rows: [[0, 0]] }));
  assert.deepEqual(px(ga.rgb, 0), [255, 255, 255]);
  // 8-bit RGB with a tRNS colour key
  const key = decodePng(png({ width: 2, height: 1, ctype: 2, rows: [[1, 2, 3, 9, 9, 9]], trns: Buffer.from([0, 9, 0, 9, 0, 9]) }));
  assert.deepEqual([px(key.rgb, 0), px(key.rgb, 1)], [[1, 2, 3], [255, 255, 255]]);
});

test("pdfdoc: images this writer cannot read are refused, never half-drawn", () => {
  const good = png({ width: 1, height: 1, ctype: 2, rows: [[1, 2, 3]] });
  assert.equal(imageKind(good), "png");
  assert.equal(imageKind(JPG_A), "jpeg");
  assert.equal(imageKind(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  assert.equal(decodePng(good.subarray(0, 40)), null, "truncated");
  assert.equal(decodePng(png({ width: 1, height: 1, ctype: 2, rows: [[1, 2, 3]], interlace: 1 })), null, "interlaced");
  assert.equal(decodePng(png({ width: 1, height: 1, ctype: 5, rows: [[1]] })), null, "no such colour type");
  const doc = createPdf();
  assert.equal(doc.image(new Uint8Array([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0]), "bad-jpeg"), null);
  assert.equal(doc.image(new Uint8Array(0), "empty"), null);
  assert.equal(doc.image(null, "none"), null);
});

test("pdfdoc: a PNG is re-deflated with the row predictors and decodes back to the flattened pixels", () => {
  const W = 37, H = 9;
  const rgba = Array.from({ length: H }, (_, y) => Uint8Array.from({ length: W * 4 }, (_, i) => (i % 4 === 3 ? (i * 7 + y * 31) & 0xff : (i * 13 + y * 3) & 0xff)));
  const grey = Array.from({ length: H }, (_, y) => Uint8Array.from({ length: W }, (_, x) => (x * 5 + y * 9) & 0xff));
  const doc = createPdf();
  const p = doc.addPage();
  p.image(doc.image(png({ width: W, height: H, ctype: 6, rows: rgba }), "colour"), 0, 0, 10, 10);
  p.image(doc.image(png({ width: W, height: H, ctype: 0, rows: grey }), "grey"), 0, 0, 10, 10);
  const pdf = readPdf(doc.finish());
  const flats = [...pdf.objs.values()].filter((o) => o.dict && /\/Subtype \/Image/.test(o.dict) && /\/FlateDecode/.test(o.dict));
  assert.equal(flats.length, 2);
  const unpredict = (data, chans) => {
    const raw = inflateSync(data), stride = W * chans, out = new Uint8Array(stride * H);
    for (let y = 0; y < H; y++) {
      const f = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) {
        const v = raw[y * (stride + 1) + 1 + x];
        const a = x >= chans ? out[y * stride + x - chans] : 0, u = y ? out[(y - 1) * stride + x] : 0, c = y && x >= chans ? out[(y - 1) * stride + x - chans] : 0;
        const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c);
        out[y * stride + x] = (v + [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][f]) & 0xff;
      }
    }
    return out;
  };
  const colour = flats.find((o) => /\/DeviceRGB/.test(o.dict)), mono = flats.find((o) => /\/DeviceGray/.test(o.dict));
  assert.match(colour.dict, new RegExp(`/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${W} >>`));
  assert.match(mono.dict, /\/Colors 1 /, "a grey PNG keeps one channel");
  assert.deepEqual(unpredict(colour.data, 3), decodePng(png({ width: W, height: H, ctype: 6, rows: rgba })).rgb);
  assert.deepEqual([...unpredict(mono.data, 1)], grey.flatMap((r) => [...r]));
});

test("pdfdoc: text survives WinAnsi — symbols are spelled out, × ° · — print as themselves", () => {
  assert.equal(norm("≤ 16%"), "<= 16%");
  assert.equal(norm("≥ 70"), ">= 70");
  assert.equal(norm("✓ done ✗ not"), "Yes done No not");
  assert.equal(norm("≈ 1,920"), "~ 1,920");
  assert.equal(norm("≠ goal"), "!= goal");
  assert.equal(norm("➀"), "➀", "an unknown symbol is left for winAnsi to drop");
  const bytes = [...winAnsi(norm("2 × 5 · 70°F — ok ± 1"))];
  for (const b of [0xd7, 0xb7, 0xb0, 0x97, 0xb1]) assert.ok(bytes.includes(b), `byte 0x${b.toString(16)} kept`);
  assert.equal(String.fromCharCode(...winAnsi(norm("café"))), "caf\xe9", "a decomposed accent composes first");
  assert.equal(String.fromCharCode(...winAnsi(norm("wet \u{1F4A7} floor"))), "wet  floor", "an emoji is dropped, not printed as ?");
  assert.ok(textWidth("≤ 16%", 9) > textWidth("16%", 9), "the spelled-out form is what is measured");
});

test("pdfdoc: bookmark titles and /Info values are UTF-16 when they are not ASCII", () => {
  assert.equal(textString("Floor Plan"), "(Floor Plan)");
  assert.equal(textString("a (b) \\ c"), "(a \\(b\\) \\\\ c)");
  const t = textString("Moisture Map — Kitchen");
  assert.match(t, /^<FEFF[0-9A-F]+>$/);
  assert.equal(decodeTextString(t), "Moisture Map — Kitchen");
});

test("pdfdoc: pdfDate is the Alaska wall clock with its offset, whatever the container's zone", () => {
  const ak = (iso) => pdfDate(new Date(iso), "America/Anchorage");
  assert.equal(ak("2026-10-10T20:00:00Z"), "D:20261010120000-08'00'");
  assert.equal(ak("2026-11-01T09:59:59Z"), "D:20261101015959-08'00'", "the last second of daylight time");
  assert.equal(ak("2026-11-01T10:00:00Z"), "D:20261101010000-09'00'", "standard time from 2 a.m. Nov 1");
  assert.equal(ak("2026-11-02T03:30:00Z"), "D:20261101183000-09'00'");
  assert.equal(pdfDate(new Date("2026-10-10T20:00:00Z")), "D:20261010200000Z");
  assert.equal(pdfDate(new Date("nope")), "");
  assert.equal(pdfDate(null), "");
  const was = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    assert.equal(ak("2026-10-10T20:00:00Z"), "D:20261010120000-08'00'");
    process.env.TZ = "UTC";
    assert.equal(ak("2026-12-24T08:15:30Z"), "D:20261223231530-09'00'");
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
  const doc = createPdf();
  doc.addPage();
  const pdf = readPdf(doc.finish({ created: new Date("2026-10-10T20:00:00Z"), timeZone: "America/Anchorage" }));
  const info = pdf.objs.get(pdf.ref(pdf.trailer, "Info")).body;
  assert.match(info, /\/CreationDate \(D:20261010120000-08'00'\) \/ModDate \(D:20261010120000-08'00'\)/);
});

test("pdfdoc: the outline nests children under their parent and counts what is visible", () => {
  const doc = createPdf();
  doc.addPage(); doc.addPage(); doc.addPage();
  doc.outline([
    { title: "Moisture Maps", page: 1, children: [{ title: "Moisture Map — Kitchen", page: 1 }, { title: "Moisture Map — Basement", page: 2 }] },
    { title: "Invoices", page: 2 },
    { title: "", page: 0 },                                                // no title: left out
    { title: "Nowhere", page: 9 },                                         // no such page: left out
  ]);
  const pdf = readPdf(doc.finish());
  assert.match(pdf.catalog, /\/PageMode \/UseOutlines/);
  const root = pdf.objs.get(pdf.ref(pdf.catalog, "Outlines")).body;
  assert.match(root, /\/Count 4\b/);
  const titles = [];
  const walk = (n, depth) => {
    while (n) {
      const body = pdf.objs.get(n).body;
      titles.push("  ".repeat(depth) + decodeTextString(/\/Title (\(.*?\)|<FEFF[0-9A-F]*>) \/Parent/.exec(body)[1]));
      if (/\/First/.test(body)) walk(pdf.ref(body, "First"), depth + 1);
      n = pdf.ref(body, "Next");
    }
  };
  walk(pdf.ref(root, "First"), 0);
  assert.deepEqual(titles, ["Moisture Maps", "  Moisture Map — Kitchen", "  Moisture Map — Basement", "Invoices"]);
});

test("pdfdoc: links go to a page or an http(s) URL, and nothing else", () => {
  const doc = createPdf();
  const p = doc.addPage();
  doc.addPage();
  p.link(36, 700, 100, 12, { page: 1 });
  p.link(36, 680, 100, 12, { url: "https://example.com/a(b)" });
  p.link(36, 660, 100, 12, { url: "javascript:alert(1)" });
  const pdf = readPdf(doc.finish());
  const annots = [...pdf.objs.values()].filter((o) => o.body && /\/Subtype \/Link/.test(o.body)).map((o) => o.body);
  assert.equal(annots.length, 2);
  assert.ok(annots.some((a) => a.includes(`/Dest [${pdf.pages[1].n} 0 R /Fit]`)));
  assert.ok(annots.some((a) => a.includes("/URI (https://example.com/a\\(b\\))")));
});

/* ============================== flow ============================== */

const bands = () => {
  const calls = [];
  const header = (p, i, total) => { calls.push(["h", i, total]); p.text(M.l, PAGE.h - M.t - 8, "HEADER"); };
  const footer = (p, i, total) => { calls.push(["f", i, total]); p.text(RIGHT, M.b + 3, `Page ${i + 1} of ${total}`, { align: "right" }); };
  return { calls, header, footer };
};

test("flow: a long table splits across pages, repeats its header and keeps every row once, in order", () => {
  const doc = createPdf();
  const f = new Flow(doc, bands());
  f.section("Drying Logs");
  const rows = Array.from({ length: 150 }, (_, i) => [`R${String(i + 1).padStart(3, "0")}`, "Air mover", { text: "10/01 10:00", mark: "S" }, { text: "96", align: "right" }]);
  f.table([{ head: "Reading", w: 0.25 }, { head: "Type", w: 0.35 }, { head: "Set", w: 0.25 }, { head: "Hours", w: 0.15, align: "right" }], rows, { size: 7.5 });
  f.finish();
  assert.ok(doc.pages.length >= 4, `150 rows take several pages (${doc.pages.length})`);
  const seen = [];
  doc.pages.forEach((pg, i) => {
    const ops = pageOps(pg);
    assert.ok(ops.some((t) => t.text === "Reading" && t.font === "bold"), `page ${i + 1} repeats the header row`);
    seen.push(...ops.filter((t) => /^R\d{3}$/.test(t.text)).map((t) => t.text));
    for (const t of ops) if (/^R\d{3}$/.test(t.text)) assert.ok(t.y > BODY_BOTTOM, "no row runs into the footer");
  });
  assert.deepEqual(seen, rows.map((r) => r[0]));
  const last = pageOps(doc.pages[doc.pages.length - 1]).filter((t) => /^R\d{3}$/.test(t.text));
  assert.ok(last.length >= 2, "a split never leaves one row alone on a page");
  assert.ok(pageOps(doc.pages[0]).some((t) => t.text === "S" && t.size < 7.5), "the scan mark is a small superscript");
});

test("flow: an empty table prints its header and None recorded.", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  f.section("Moisture Maps");
  f.table([{ head: "Date", w: 0.2 }, { head: "1", w: 0.8 }], []);
  const texts = pageOps(doc.pages[0]).map((t) => t.text);
  assert.ok(texts.includes("Date"));
  assert.ok(texts.includes("None recorded."));
});

test("flow: columns wider than the page shrink to fit; fractions that nearly fill it fill it", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  f.section("Wide");
  const wide = Array.from({ length: 17 }, (_, i) => ({ head: `Column ${i + 1}`, w: 60, align: "center" }));
  f.table(wide, [wide.map((_, i) => `v${i + 1}`)], { size: 6.5 });
  const near = [{ head: "A", w: 0.5 }, { head: "B", w: 0.46 }];
  f.table(near, [["a", "b"]]);
  const navy = [...doc.pages[0].ops.join("\n").matchAll(new RegExp(`${C.navy} rg ([\\d.]+) ([\\d.]+) ([\\d.]+) ([\\d.]+) re f`, "g"))];
  const widths = navy.map((m) => Number(m[3])).filter((w) => w > 300);
  assert.ok(widths.length >= 2);
  for (const w of widths) assert.ok(Math.abs(w - CONTENT_W) < 0.02, `table header ${w} pt wide`);
  for (const t of pageOps(doc.pages[0])) assert.ok(t.x >= M.l - 0.01 && t.x + t.w <= RIGHT + 0.01, `"${t.text}" inside the margins`);
});

test("flow: a long unbroken URL and a very long caption wrap inside their boxes", () => {
  const url = "https://portal.example.com/jobs/0d3e5a7c-0000-4000-8000-00000000d001/documents/moisture-maps/kitchen/readings/2026-10-04/meter-photo-3.jpg";
  const caption = "Standing water at the base of the sink cabinet, extending under the dishwasher and along the toe kick to the refrigerator alcove; " +
    "the vinyl plank floor is lifting at three seams and the subfloor reads 32% at the worst point, well above the 16% dry goal.";
  const doc = createPdf();
  const f = new Flow(doc);
  f.section("Wrap");
  f.paragraph(url, { size: 10 });
  f.fields([["Portal link", url], ["Caption", caption]], { cols: 2 });
  f.imageGrid([{ img: null, caption }, { img: null, caption: ["#001", " · BEFORE · " + url] }], { perRow: 4, boxH: 80, maxCapLines: 6 });
  f.photos([{ img: null, caption: ["#002", " · DURING · " + caption + " " + caption] }], { perRow: 2, rowsPerPage: 2, capSize: 8, maxCapLines: 5 });
  for (const pg of doc.pages) for (const t of pageOps(pg)) assert.ok(t.x >= M.l - 0.01 && t.x + t.w <= RIGHT + 0.01, `"${t.text}" inside the margins`);
  const urlLines = pageOps(doc.pages[0]).filter((t) => t.size === 10);
  assert.ok(urlLines.length >= 2, "the URL breaks over lines");
  assert.equal(urlLines.map((t) => t.text).join(""), url, "broken by character, nothing lost");
  // the grid's 4-across cell is 129 pt: every caption line of the first cell stays inside it
  const cellW = (CONTENT_W - 8 * 3) / 4;
  for (const t of pageOps(doc.pages[0]).filter((t) => t.size === 7.5 && t.x < M.l + cellW)) assert.ok(t.x + t.w <= M.l + cellW, `"${t.text}" inside its cell`);
  const capLines = pageOps(doc.pages[0]).filter((t) => t.size === 7.5 && t.x < M.l + cellW && t.y < 700);
  assert.ok(capLines.length >= 3 && capLines.length <= 6, `caption wrapped to ${capLines.length} lines`);
});

test("flow: a heading moves to the next page with the start of what follows it", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  f.section("Moisture Maps");
  f.y = BODY_BOTTOM + 60;
  f.subhead("Moisture readings (MC%)", { keep: 80, right: "Dry goal <= 16%" });
  assert.equal(doc.pages.length, 2);
  assert.ok(!pageOps(doc.pages[0]).some((t) => t.text === "Moisture readings (MC%)"));
  assert.ok(pageOps(doc.pages[1]).some((t) => t.text === "Moisture readings (MC%)"));
  f.y = BODY_BOTTOM + 60;
  f.part("Moisture Map — Basement", { keep: 100 });
  assert.equal(doc.pages.length, 3);
  assert.equal(f.bookmarks[0].children.map((c) => c.page).join(), "2", "the part's bookmark points where it landed");
});

test("flow: nothing starts a page from an empty one", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  f.newPage();
  f.ensure(BODY_H * 3);
  assert.equal(doc.pages.length, 1);
  f.paragraph("one line");
  f.ensure(BODY_H * 3);
  assert.equal(doc.pages.length, 2);
});

test("flow: every flow page gets the running header and footer with its number and the total", () => {
  const doc = createPdf();
  doc.addPage();                                                     // a cover the flow did not make
  const b = bands();
  const f = new Flow(doc, b);
  f.section("One");
  f.section("Two");
  f.paragraph("x ".repeat(12000));
  f.finish();
  const total = doc.pages.length;
  assert.ok(total >= 4);
  assert.deepEqual(b.calls.filter((c) => c[0] === "f").map((c) => c[1]), Array.from({ length: total - 1 }, (_, i) => i + 1));
  assert.ok(b.calls.every((c) => c[2] === total));
  assert.equal(pageOps(doc.pages[0]).length, 0, "the cover is left alone");
  assert.ok(pageOps(doc.pages[total - 1]).some((t) => t.text === `Page ${total} of ${total}`));
});

test("flow: an uploaded page uses a fresh page under its heading, and starts one otherwise", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  const img = doc.image(JPG_A, "page");
  f.section("Floor Plan");
  f.fullPage(img, { caption: "Floor plan — page 1 of 2" });
  assert.equal(doc.pages.length, 1, "page 1 under the band");
  f.fullPage(img, { caption: "Floor plan — page 2 of 2" });
  assert.equal(doc.pages.length, 2);
  f.section("Invoices");
  f.fields([["Invoice #", "INV-1"]]);
  f.table([{ head: "Line", w: 1 }], Array.from({ length: 12 }, (_, i) => [`line ${i}`]));
  f.fullPage(null, { caption: "Attachment" });
  assert.equal(doc.pages.length, 4, "after an invoice the attachment takes its own page");
  assert.ok(pageOps(doc.pages[3]).some((t) => t.text === "Image not available"));
  const draw = doc.pages[0].ops.find((o) => o.includes(`/${img.name} Do`));
  const [w, h, x, y] = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(draw).slice(1).map(Number);
  assert.ok(x >= M.l - 0.01 && x + w <= RIGHT + 0.01 && y >= BODY_BOTTOM && y + h <= BODY_TOP, "the page fits inside the margins");
  assert.ok(Math.abs(w - CONTENT_W) < 0.01 || y + h > BODY_TOP - 60, "and fills the width or the height");
});

test("flow: photos go two to a page in full mode and four in compact", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ img: null, caption: [`#00${i + 1}`, " · BEFORE · Kitchen"] }));
  const run = (o) => { const doc = createPdf(); const f = new Flow(doc); f.section("Job Photos"); f.photos(items, o); return doc.pages.length; };
  assert.equal(run({ perRow: 1, rowsPerPage: 2 }), 3);
  assert.equal(run({ perRow: 2, rowsPerPage: 2 }), 2);
});

test("flow: signatures print the image, the electronic line, a blank line, and a gray box for a missing image", () => {
  const doc = createPdf();
  const f = new Flow(doc);
  const sig = doc.image(png({ width: 4, height: 2, ctype: 6, rows: [new Uint8Array(16).fill(255), new Uint8Array(16)] }), "sig");
  f.section("Certificate of Drying");
  f.signatures([
    { label: "Technician", name: "Pat Sample", date: "10/06/2026", img: sig, wanted: true },
    { label: "Owner", name: "Jane Sample", date: "10/06/2026", electronic: true },
    { label: "Adjuster", name: "", date: "" },
    { label: "Second technician", name: "Chris Sample", date: "10/06/2026", img: null, wanted: true },
  ]);
  const texts = pageOps(doc.pages[0]).map((t) => t.text);
  assert.ok(texts.includes("Signed electronically by Jane Sample,"));
  assert.ok(texts.includes("10/06/2026"));
  assert.equal(texts.filter((t) => t === "Image not available").length, 1);
  assert.ok(doc.pages[0].ops.some((o) => o.includes(`/${sig.name} Do`)));
  assert.ok(texts.includes("SECOND TECHNICIAN"), "a fourth signature starts a second row");
});
