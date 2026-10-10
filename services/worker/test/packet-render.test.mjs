/* The carrier packet's renderer (packet/render.mjs, design §5 and §15): a
   document model in, one PDF out. The model here is built by hand so these
   tests stand on their own: every block type, a long moisture grid in two
   blocks of 13 locations, the 17-column psychrometric table, long captions
   and URLs, JPEGs from the public site's image folder, PNGs drawn here
   (alpha, palette, 16-bit), and images that are missing or unreadable.
   Nothing here is a real customer, claim or job, and nothing touches the
   network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { renderPacket, PACKET_TITLE, S500_LINE } from "../packet/render.mjs";
import { winAnsi, textWidth, PAGE } from "../packet/pdfdoc.mjs";
import { M } from "../packet/flow.mjs";
import { COMPANY } from "../../../apps/field/js/model.js";

const IMAGES = new URL("../../../apps/site/public/images/", import.meta.url);
const jpg = (f) => new Uint8Array(readFileSync(new URL(f, IMAGES)));
const BUILT = new Date("2026-10-10T20:00:00Z");                      // noon in Fairbanks, daylight time
const LABEL = { number: "PKT-2026-0007", version: 1, replaces: null, changed: [], built: BUILT, mode: "full" };
const HEADER = "PKT-2026-0007 · v1 · Claim DEMO-12345 · Jane Sample";

/* ---------- PNGs drawn here ---------- */
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
function png({ width, height, ctype, depth = 8, rows, plte = null, trns = null }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = ctype;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", plte)] : []), ...(trns ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
/* a signature stroke on a transparent canvas, soft at its edges */
function sigPng(seed = 1, W = 200, H = 60) {
  const px = new Uint8Array(W * H * 4);
  for (let x = 6; x < W - 6; x += 0.3) {
    const y = H / 2 + (12 + seed) * Math.sin(x / (8 + seed)) * Math.cos(x / 31);
    for (let d = -1; d <= 1; d++) for (let e = -1; e <= 1; e++) {
      const X = Math.round(x) + d, Y = Math.round(y) + e;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = (Y * W + X) * 4; px[i] = 15; px[i + 1] = 27; px[i + 2] = 45; px[i + 3] = d || e ? 140 : 255;
    }
  }
  return png({ width: W, height: H, ctype: 6, rows: Array.from({ length: H }, (_, y) => px.subarray(y * W * 4, (y + 1) * W * 4)) });
}
/* a sketch: walls, a wet area half transparent, a transparent margin */
function planPng(W = 300, H = 200) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    const r = new Uint8Array(W * 4);
    for (let x = 0; x < W; x++) {
      const i = x * 4;
      if (x < 10 || y < 10 || x >= W - 10 || y >= H - 10) continue;
      if (x % 75 < 3 || y % 65 < 3) { r[i] = 15; r[i + 1] = 27; r[i + 2] = 45; r[i + 3] = 255; continue; }
      const wet = (x - 100) ** 2 + (y - 110) ** 2 < 45 ** 2;
      r[i] = wet ? 120 : 235; r[i + 1] = wet ? 170 : 240; r[i + 2] = wet ? 230 : 245; r[i + 3] = wet ? 160 : 255;
    }
    rows.push(r);
  }
  return png({ width: W, height: H, ctype: 6, rows });
}
const palettePng = () => png({ width: 8, height: 4, ctype: 3, depth: 4,
  rows: Array.from({ length: 4 }, (_, y) => Uint8Array.from({ length: 4 }, (_, x) => (((x + y) % 4) << 4) | ((x + y + 1) % 4))),
  plte: Buffer.from([255, 0, 0, 0, 128, 0, 0, 0, 255, 242, 106, 33]), trns: Buffer.from([255, 255, 255, 0]) });
const deepPng = () => png({ width: 6, height: 4, ctype: 2, depth: 16,
  rows: Array.from({ length: 4 }, (_, y) => { const r = Buffer.alloc(36); for (let x = 0; x < 6; x++) { r.writeUInt16BE(x * 10000, x * 6); r.writeUInt16BE(y * 15000, x * 6 + 2); r.writeUInt16BE(30000, x * 6 + 4); } return r; }) });

const LONG_URL = "https://portal.example.com/jobs/0d3e5a7c-0000-4000-8000-00000000d001/documents/moisture-maps/kitchen/readings/2026-10-04/meter-photo-location-3-full-resolution.jpg";
const LONG_CAPTION = "Standing water at the base of the sink cabinet, extending under the dishwasher and along the toe kick to the refrigerator alcove; the vinyl plank floor is lifting at three seams and the subfloor reads 32% at the worst point, well above the 16% dry goal; photo taken before any extraction began, with the supply line still dripping into the cabinet.";

const JPEGS = {
  photo1: "9c9b97ef-the-water-damage-restoration-process-explained1.jpg", photo2: "1ae79fc4-the-water-damage-restoration-process-explained4.jpg",
  photo3: "70167817-water-damage-50_50-1.jpg", photo4: "0b81fd1e-the-water-damage-restoration-process-explained2.jpg",
  photo5: "14748673-the-water-damage-restoration-process-explained3.jpg", meter1: "90369908-the-strength-beneath.jpg",
  meter2: "2ae21081-pressure-treated-wood.jpg", portrait: "22d666d2-painting-services.jpg", landscape: "19e0c593-mold-removal-hero.jpg",
};
function richImages() {
  return new Map([
    ["photo-1", jpg(JPEGS.photo1)], ["photo-2", jpg(JPEGS.photo2)], ["photo-3", jpg(JPEGS.photo3)],
    ["photo-4", jpg(JPEGS.photo4)], ["photo-5", jpg(JPEGS.photo5)], ["photo-png", planPng()], ["photo-null", null],
    ["meter-1", jpg(JPEGS.meter1)], ["meter-2", jpg(JPEGS.meter2)], ["meter-dup", jpg(JPEGS.meter1)],
    ["sketch", planPng()], ["sig-tech", sigPng(1)], ["sig-rep", sigPng(3)], ["sig-broken", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ["page-portrait", jpg(JPEGS.portrait)], ["page-landscape", jpg(JPEGS.landscape)], ["page-palette", palettePng()], ["page-deep", deepPng()],
  ]);
}
/* keys the model names that the store does not hold, or holds as nothing usable */
const MISSING_KEYS = ["meter-missing", "page-gone", "missing-sketch", "photo-null", "sig-broken"];

const loc13 = (start) => [{ head: "Date", w: 0.13 }, ...Array.from({ length: 13 }, (_, i) => ({ head: String(start + i + 1), w: 0.87 / 13, align: "center" }))];
const readingRows = (n, shift) => Array.from({ length: n }, (_, r) => [`10/${String(1 + (r % 28)).padStart(2, "0")}/2026`,
  ...Array.from({ length: 13 }, (_, i) => {
    if ((r + i) % 7 === 6) return "";
    const v = 34 - ((r + i + shift) % 22);
    const cell = { text: String(v), align: "center", fill: v <= 16 ? "dry" : "wet" };
    if ((r * 13 + i) % 11 === 0) cell.mark = "P";
    return cell;
  })]);
const PSY_COLS = [
  { head: "Date", w: 0.075 }, { head: "Time", w: 0.05 },
  { head: "Out °F", w: 0.045, align: "center" }, { head: "Out RH", w: 0.045, align: "center" }, { head: "Out GPP", w: 0.05, align: "center" },
  { head: "Ref °F", w: 0.045, align: "center" }, { head: "Ref RH", w: 0.045, align: "center" }, { head: "Ref GPP", w: 0.05, align: "center" },
  { head: "Aff °F", w: 0.045, align: "center" }, { head: "Aff RH", w: 0.045, align: "center" }, { head: "Aff GPP", w: 0.05, align: "center" },
  { head: "GD", w: 0.04, align: "center" }, { head: "Dehu", w: 0.04, align: "center" }, { head: "AM", w: 0.035, align: "center" },
  { head: "Scrb", w: 0.04, align: "center" }, { head: "Tech", w: 0.08 }, { head: "Notes", w: 0.18 },
];
const PSY_ROWS = 64;
const psyTech = (r) => `T${String(r + 1).padStart(2, "0")}`;

/* A packet model with every block type in it, shaped as packet/model.mjs builds one. */
function richModel() {
  return {
    v: 1,
    jobId: "demo-job-1",
    cover: {
      customer: "Jane Sample", address: "123 Example St, Fairbanks, AK 99701", claimNo: "DEMO-12345", carrier: "Sample Mutual",
      adjuster: "Alex Adjuster (adjuster@example.com)", dateOfLoss: "09/30/2026", lossCause: "Supply line failure under the kitchen sink",
      workOrderNo: "WO-2026-118", waterCategory: "2", waterClass: "3",
      facts: [["Mitigation start", "10/01/2026"], ["Mitigation finish", "10/06/2026"], ["Drying days", "6"], ["Certificate dated", "10/06/2026"],
        ["Dehumidifier days", "2 × 5"], ["Air mover days", "8 × 5"]],
    },
    sections: [
      { key: "cert", title: "Certificate of Drying", parts: [{ title: null, newPage: false, blocks: [
        { t: "fields", cols: 3, pairs: [["Certificate #", "COD-2026-031"], ["Issue date", "10/06/2026"], ["Project / job ID", "WO-2026-118"],
          ["Drying duration (days)", "6"], ["Drying start", "10/01/2026"], ["Drying completion", ""]] },
        { t: "subhead", text: "Dry standard verification", right: "All readings MC%" },
        { t: "table", size: 8.5, zebra: true, columns: [{ head: "Material / location", w: 0.28 }, { head: "Meter / setting", w: 0.22 }, { head: "Goal %", w: 0.12, align: "center" },
          { head: "Final %", w: 0.12, align: "center" }, { head: "Ref %", w: 0.12, align: "center" }, { head: "Dry", w: 0.14, align: "center" }],
          rows: [["Subfloor — kitchen", "Pin meter / wood scale", "≤ 16", "13", "11", { text: "Yes", fill: "dry" }],
            ["Drywall — hallway", "Pinless / drywall", "≤ 1", "1.5", "0.8", { text: "No", fill: "wet", font: "bold", color: "red" }]] },
        { t: "para", text: "Symbols: ≤ 16% · ≥ 70°F · ✓ done · ✗ not done · ≈ 1,920 cu ft · 2 × 5 days · ≠ goal · ± 1", size: 8.5, font: "ital", color: "black" },
        { t: "subhead", text: "Signatures", right: "" },
        { t: "signatures", items: [
          { label: "IICRC Certified Technician — Roybal Construction, LLC", name: "Pat Sample", date: "10/06/2026", media: "sig-tech", electronic: false },
          { label: "Property Owner / Insured", name: "Jane Sample", date: "10/06/2026", media: null, electronic: true },
          { label: "Adjuster / Carrier (if witness required)", name: "", date: "", media: null, electronic: false },
          { label: "Second technician", name: "Chris Sample", date: "10/06/2026", media: "sig-broken", electronic: false },
        ] },
        { t: "subhead", text: "Final readings with meter photos", right: "" },
        { t: "para", text: "Each location's last reading on the Moisture Map, with the photo of the meter screen taken for it.", size: 8.5, font: "reg", color: "sub" },
        { t: "grid", perRow: 4, boxH: 120, items: [
          { media: "meter-1", caption: "Kitchen · Loc 1 · 10/06 · 14%" }, { media: "meter-2", caption: ["Loc 2", "· 10/06 · 13%"] },
          { media: "meter-dup", caption: "Kitchen · Loc 3 · 10/06 · 12%" }, { media: "meter-missing", caption: LONG_CAPTION },
        ] },
      ] }] },
      { key: "workAuth", title: "Work Authorization", parts: [{ title: null, newPage: false, blocks: [
        { t: "fields", cols: 2, pairs: [["Property address", "123 Example St, Fairbanks, AK 99701"], ["Owner name", "Jane Sample"], ["Portal link", LONG_URL], ["Email", "jane.sample@example.com"]] },
        { t: "subhead", text: "Scope of authorized work", right: "" },
        { t: "bullets", items: ["Emergency water extraction and surface drying.", "Moisture mapping, readings, and documentation per IICRC S500 standard.", LONG_CAPTION] },
        { t: "subhead", text: "Terms & conditions", right: "" },
        ...Array.from({ length: 6 }, (_, i) => ({ t: "para", text: `Term ${i + 1}: The owner authorizes the contractor to perform the mitigation described above. ` + "Payment is due upon completion or receipt of insurance proceeds. ".repeat(3), size: 8.5, font: "reg", color: "black" })),
        { t: "para", text: `See ${LONG_URL} for the signed copy.`, size: 8, font: "reg", color: "sub" },
        { t: "note", text: "No scope items were checked on this authorization." },
        { t: "signatures", items: [
          { label: "Property Owner — sign above", name: "Jane Sample", date: "10/01/2026", media: null, electronic: true },
          { label: "Contractor Representative (Roybal Construction, LLC)", name: "Pat Sample", date: "10/01/2026", media: "sig-rep", electronic: false },
        ] },
      ] }] },
      { key: "floorPlan", title: "Floor Plan", parts: [{ title: null, newPage: false, blocks: [
        { t: "pages", items: [{ media: "page-portrait", caption: "Floor plan — page 1 of 3" }, { media: "sketch", caption: "Floor plan — page 2 of 3" }, { media: "page-gone", caption: "Floor plan — page 3 of 3" }] },
      ] }] },
      { key: "maps", title: "Moisture Maps", parts: [
        { title: "Moisture Map — Kitchen", newPage: false, blocks: [
          { t: "fields", cols: 3, pairs: [["Room / area", "Kitchen"], ["Material", "Framing / Wood / Subfloor"], ["Dry goal (MC%)", "≤ 16%"], ["Meter / setting", "Pin meter"], ["Technician", "Pat Sample"], ["Ambient temp / RH", "70 / 45"]] },
          { t: "image", media: "sketch", maxH: 300, caption: "Kitchen — affected area and reading locations" },
          { t: "subhead", text: "Moisture readings (MC%)", right: "Dry goal ≤ 16%" },
          { t: "table", columns: loc13(0), size: 8, zebra: false, rows: readingRows(46, 0) },
          { t: "table", columns: loc13(13), size: 8, zebra: false, rows: readingRows(6, 5) },
          { t: "para", size: 7.5, font: "reg", color: "sub", text: "Green = at or below the dry goal (16%); red = above it. P = this reading has a photo of the meter screen, below." },
          { t: "subhead", text: "Meter photos", right: "3 photos" },
          { t: "grid", perRow: 4, boxH: 120, items: [{ media: "meter-1", caption: "Loc 1 · 10/06 · 14%" }, { media: "meter-2", caption: "Loc 2 · 10/06 · 13%" }, { media: "meter-dup", caption: "Loc 4 · 09/29 · reading date removed" }] },
        ] },
        { title: "Moisture Map — Basement", newPage: true, blocks: [
          { t: "fields", cols: 3, pairs: [["Room / area", "Basement"], ["Material", "Concrete / Slab"], ["Dry goal (MC%)", ""]] },
          { t: "image", media: "missing-sketch", maxH: 300, caption: "Basement — affected area" },
          { t: "table", columns: loc13(0), size: 8, zebra: false, rows: [] },
        ] },
      ] },
      { key: "logs", title: "Drying Logs", parts: [{ title: "Drying Log — 10/01/2026 to 10/06/2026", newPage: false, blocks: [
        { t: "fields", cols: 3, pairs: [["Dry-out start", "10/01/2026"], ["Dry-out finish", "10/06/2026"], ["Drying days", "6"]] },
        { t: "subhead", text: "Equipment deployment & runtime", right: "3 units" },
        { t: "table", size: 7.5, zebra: true, columns: [{ head: "Tag / asset", w: 0.1 }, { head: "Type", w: 0.17 }, { head: "Location", w: 0.13 }, { head: "Set", w: 0.12 },
          { head: "Pulled", w: 0.12 }, { head: "Hours", w: 0.07, align: "right" }, { head: "Notes", w: 0.29 }],
          rows: [["AM-014", "Air mover", "Kitchen", { text: "10/01 10:00", mark: "S" }, { text: "still out", font: "ital" }, "", ""],
            ["DH-002", "LGR dehumidifier", "Kitchen", { text: "10/01 10:05", mark: "S" }, { text: "10/06 11:05", mark: "S" }, { text: "121", align: "right" }, "Set under the sink base"],
            ["AMX-0000000000000000000000001", "Air mover", "Hallway", "10/01 10:30", "10/05 15:00", { text: "96", align: "right" }, LONG_CAPTION]] },
        { t: "subhead", text: "Daily psychrometric readings", right: "°F · %RH · grains per pound" },
        { t: "table", size: 6.5, zebra: true, columns: PSY_COLS, rows: Array.from({ length: PSY_ROWS }, (_, r) => [`10/${String(1 + (r % 28)).padStart(2, "0")}/2026`,
          `${String(8 + (r % 10)).padStart(2, "0")}:15`, "41", "72", "38", "70", "45", "49", "76", "30", "40", "9", "2", "6", "1", psyTech(r),
          r % 9 === 0 ? "Readings taken after the dehumidifier filter was cleaned; airflow restored" : ""]) },
        { t: "callout", text: "A block type this renderer has never seen still prints its words." },
        { t: "subhead", text: "Equipment scan record", right: "1 scan" },
        { t: "table", size: 7.5, zebra: true, columns: [{ head: "Time", w: 70 }, { head: "Tag", w: 54 }, { head: "Type", w: 92 }, { head: "Action", w: 54 }, { head: "Room", w: 97 }, { head: "Read by", w: 70 }, { head: "Tech", w: 103 }],
          rows: [["10/01 10:00", "AM-014", "Air mover", "Placed", "Kitchen", "Camera", "Pat Sample"]] },
      ] }] },
      { key: "photos", title: "Job Photos", parts: [{ title: null, newPage: false, blocks: [{ t: "photos", items: [
        { media: "photo-1", caption: ["#001", " · BEFORE · Kitchen · " + LONG_CAPTION] },
        { media: "photo-2", caption: ["#002", " · BEFORE · Kitchen · Wet subfloor"] },
        { media: "photo-png", caption: ["#003", " · DURING · Kitchen · A PNG with transparency"] },
        { media: "photo-null", caption: ["#004", " · DURING · Hallway · this photo never reached storage"] },
        { media: "photo-3", caption: ["#005", " · DURING · Basement · " + LONG_URL] },
        { media: "photo-4", caption: ["#006", " · AFTER · Kitchen · Cabinet base dry"] },
        { media: "photo-5", caption: ["#007", " · AFTER · Hallway"] },
      ] }] }] },
      { key: "docs", title: "Supporting Documents", parts: [
        { title: "Supporting Document — Plumber's leak report", newPage: false, blocks: [{ t: "pages", items: [{ media: "page-landscape", caption: "Plumber's leak report" }] }] },
        { title: "Supporting Document — Palette and 16-bit scans", newPage: true, blocks: [{ t: "pages", items: [{ media: "page-palette", caption: "Palette PNG — page 1 of 2" }, { media: "page-deep", caption: "16-bit PNG — page 2 of 2" }] }] },
      ] },
      { key: "invoices", title: "Invoices", parts: [{ title: "Invoice INV-1042", newPage: false, blocks: [
        { t: "fields", cols: 2, pairs: [["Invoice #", "INV-1042"], ["Invoice date", "10/08/2026"], ["Due date", "11/07/2026"], ["Payment terms", "Net 30"]] },
        { t: "subhead", text: "Charges", right: "Time & materials" },
        { t: "table", size: 8, zebra: true, columns: [{ head: "#", w: 0.05 }, { head: "Description", w: 0.51 }, { head: "Qty", w: 0.08, align: "right" }, { head: "Unit", w: 0.08 }, { head: "Unit price", w: 0.13, align: "right" }, { head: "Total", w: 0.15, align: "right" }],
          rows: [
            [{ text: "", fill: "band", font: "bold" }, { text: "Kitchen", fill: "band", font: "bold" }, { text: "", fill: "band" }, { text: "", fill: "band" }, { text: "", fill: "band" }, { text: "", fill: "band" }],
            ...Array.from({ length: 30 }, (_, i) => [`${i + 1}.`, i === 3 ? LONG_CAPTION : `Line item ${i + 1} — air mover per day`, { text: "2", align: "right" }, "EA", { text: "$35.00", align: "right" }, { text: "$70.00", align: "right" }]),
          ] },
        { t: "table", size: 8.5, zebra: false, columns: [{ head: "Totals as billed", w: 0.72 }, { head: "Amount", w: 0.28, align: "right" }],
          rows: [["Line item total", { text: "$2,100.00", align: "right" }], [{ text: "Invoice total", font: "bold" }, { text: "$2,100.00", font: "bold", align: "right" }]],
          _rows: [["Payments received (as of 10/10/2026)", { text: "-$500.00", align: "right" }], [{ text: "Balance due", font: "bold" }, { text: "$1,600.00", font: "bold", align: "right" }]] },
        { t: "note", text: "Remit to: Roybal Construction, LLC · 3850 Royal Rd, Fairbanks, AK 99701 · Methods: Check, ACH, or credit card on request" },
        { t: "pages", items: [{ media: "page-portrait", caption: "Invoice INV-1042 attachment — Drywall subcontractor invoice" }] },
      ] }] },
    ],
    media: {},
    photoNums: {},
    counts: { maps: 2, readings: 600, meterPhotos: 3, logs: 1, equipment: 3, scans: 1, photos: 7, docs: 2, invoices: 1, invoiceTotal: 2100 },
    unitsOut: ["AM-014 (Kitchen)"],
    hardGaps: [],
    missing: 0,
  };
}

/* ---------- a small reader for what the renderer wrote ---------- */
function readPdf(bytes) {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4\n"));
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
  assert.ok(head, "startxref points at the xref table");
  const size = Number(head[1]);
  const rows = s.slice(xrefAt + head[0].length).split("\n").slice(0, size);
  const objs = new Map();
  for (let n = 1; n < size; n++) {
    const off = Number(rows[n].slice(0, 10));
    const open = `${n} 0 obj\n`;
    assert.equal(s.slice(off, off + open.length), open, `object ${n} starts at its xref offset`);
    const at = off + open.length;
    const st = /^<< (.*?)\/Length (\d+) >>\nstream\n/.exec(s.slice(at, at + 4000));
    if (st) {
      const start = at + st[0].length, len = Number(st[2]);
      assert.equal(s.slice(start + len, start + len + 18), "\nendstream\nendobj\n", `object ${n}'s /Length`);
      objs.set(n, { dict: st[1], data: buf.subarray(start, start + len) });
    } else objs.set(n, { body: s.slice(at, s.indexOf("\nendobj\n", at)) });
  }
  const trailer = /trailer\n<< (.*) >>\nstartxref/.exec(s)[1];
  const ref = (body, key) => { const m = new RegExp(`/${key} (\\d+) 0 R`).exec(body); return m ? Number(m[1]) : 0; };
  const catalog = objs.get(ref(trailer, "Root")).body;
  const kids = /\/Kids \[([^\]]*)\]/.exec(objs.get(ref(catalog, "Pages")).body)[1].match(/\d+(?= 0 R)/g).map(Number);
  const pages = kids.map((n) => {
    const body = objs.get(n).body;
    const c = objs.get(ref(body, "Contents"));
    const ops = (/\/FlateDecode/.test(c.dict) ? inflateSync(c.data) : Buffer.from(c.data)).toString("latin1");
    const texts = textOps(ops);
    return { n, body, ops, texts, text: texts.map((t) => t.text).join(" ") };
  });
  const info = {};
  for (const m of objs.get(ref(trailer, "Info")).body.matchAll(/\/(\w+) (\((?:\\.|[^\\)])*\)|<FEFF[0-9A-F]*>)/g)) info[m[1]] = decodeTextString(m[2]);
  const outline = [];
  const walk = (n, into) => {
    while (n) {
      const body = objs.get(n).body;
      const item = { title: decodeTextString(/\/Title (\((?:\\.|[^\\)])*\)|<FEFF[0-9A-F]*>) \/Parent/.exec(body)[1]), page: kids.indexOf(Number(/\/Dest \[(\d+) 0 R/.exec(body)[1])), children: [] };
      into.push(item);
      if (/\/First/.test(body)) walk(ref(body, "First"), item.children);
      n = ref(body, "Next");
    }
  };
  if (ref(catalog, "Outlines")) walk(ref(objs.get(ref(catalog, "Outlines")).body, "First"), outline);
  return { objs, trailer, pages, info, outline };
}
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
function decodeTextString(tok) {
  if (tok.startsWith("<FEFF")) {
    let out = "";
    for (let i = 5; i < tok.length - 1; i += 4) out += String.fromCharCode(parseInt(tok.slice(i, i + 4), 16));
    return out;
  }
  return unlit(tok.slice(1, -1));
}
const FONT = { 1: "reg", 2: "bold", 3: "ital" };
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
const render = (model = richModel(), o = {}) => renderPacket(model, { label: LABEL, mode: "full", images: richImages(), ...o });
let RICH = null;
const rich = () => (RICH ||= (() => { const r = render(); return { r, pdf: readPdf(r.bytes) }; })());

/* ============================== tests ============================== */

test("render: the rich packet is a valid PDF that reports its own page count and sha256", () => {
  const { r, pdf } = rich();
  assert.ok(r.bytes instanceof Uint8Array);
  assert.equal(r.pages, pdf.pages.length);
  assert.ok(r.pages > 15, `${r.pages} pages`);
  assert.equal(r.sha256, createHash("sha256").update(r.bytes).digest("hex"));
  assert.match(pdf.trailer, /\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
});

test("render: the cover has the letterhead, the title, the number and version, the facts and the licenses, and no running header", () => {
  const { r, pdf } = rich();
  const cover = pdf.pages[0];
  for (const s of ["ROYBAL", " CONSTRUCTION, LLC", COMPANY.tagline, COMPANY.address, `${COMPANY.phone} | ${COMPANY.email}`, COMPANY.web,
    PACKET_TITLE.toUpperCase(), "PKT-2026-0007", "v1", "10/10/2026", String(r.pages), "Prepared for Sample Mutual · Claim DEMO-12345",
    "Jane Sample", "123 Example St, Fairbanks, AK 99701", "DEMO-12345", "Sample Mutual", "09/30/2026", "Category 2 / Class 3",
    "Mitigation start", "10/01/2026", "2 × 5", "CONTENTS"]) {
    assert.ok(cover.texts.some((t) => t.text === s || t.text.toUpperCase() === s.toUpperCase()), `cover shows "${s}"`);
  }
  assert.ok(cover.texts.find((t) => t.text === "ROYBAL").size >= 13);
  const number = cover.texts.find((t) => t.text === "PKT-2026-0007");
  assert.ok(number.size >= 18 && number.font === "bold", "the packet number is prominent");
  assert.ok(cover.text.includes(S500_LINE.slice(0, 40)), "the IICRC S500 line");
  for (const lic of COMPANY.licenses) assert.ok(cover.text.includes(lic), `the license ${lic}`);
  assert.ok(!cover.text.includes(HEADER), "the cover has no running header");
  assert.ok(cover.text.includes(`Page 1 of ${r.pages}`));
  assert.ok(!cover.text.includes("This version replaces"), "version 1 replaces nothing");
});

test("render: the contents list each section and part at the page it starts on, each a link", () => {
  const { pdf } = rich();
  const cover = pdf.pages[0];
  const pageOf = (title) => {
    const t = cover.texts.find((x) => x.text === title);
    assert.ok(t, `contents lists "${title}"`);
    const num = cover.texts.find((x) => x.font === "bold" && /^\d+$/.test(x.text) && Math.abs(x.y - t.y) < 0.5 && x.x > 500);
    assert.ok(num, `"${title}" has a page number`);
    return Number(num.text);
  };
  for (const s of richModel().sections) {
    const at = pageOf(s.title);
    assert.ok(pdf.pages[at - 1].texts.some((t) => t.text === s.title.toUpperCase() && t.font === "bold"), `${s.title} starts on page ${at}`);
    for (const p of s.parts.filter((x) => x.title)) {
      const pat = pageOf(p.title);
      assert.ok(pdf.pages[pat - 1].texts.some((t) => t.text === p.title.toUpperCase()), `${p.title} starts on page ${pat}`);
    }
  }
  const links = (pdf.pages[0].body.match(/\/Annots \[([^\]]*)\]/) || ["", ""])[1].match(/\d+(?= 0 R)/g) || [];
  assert.equal(links.length, 14, "each contents line links to its page");
});

test("render: when the parts will not fit on the cover they fold into a count beside their section", () => {
  const m = richModel();
  const maps = m.sections.find((s) => s.key === "maps");
  for (let i = 0; i < 12; i++) maps.parts.push({ title: `Moisture Map — Room ${i + 3}`, newPage: true, blocks: [{ t: "fields", cols: 3, pairs: [["Room / area", `Room ${i + 3}`]] }] });
  const pdf = readPdf(render(m).bytes);
  const cover = pdf.pages[0];
  assert.ok(!cover.texts.some((t) => t.text.startsWith("Moisture Map — ")), "no part lines");
  assert.ok(cover.texts.some((t) => t.text === "2 maps · 600 readings · 3 meter photos"), "the model's own counts still print");
  assert.ok(cover.texts.some((t) => t.text === "2 documents"), "a section without counts says how many parts it has");
  for (const s of m.sections) assert.ok(cover.texts.some((t) => t.text === s.title), `${s.title} is still listed`);
  assert.equal(pdf.outline.find((o) => o.title === "Moisture Maps").children.length, 14, "the bookmarks keep every part");
});

/* the cover's link rectangles [x1, y1, x2, y2], bottom first */
const linkRects = (pdf) => (pdf.pages[0].body.match(/\/Annots \[([^\]]*)\]/)[1].match(/\d+(?= 0 R)/g) || [])
  .map((n) => /\/Rect \[([^\]]*)\]/.exec(pdf.objs.get(Number(n)).body)[1].split(" ").map(Number))
  .sort((a, b) => a[1] - b[1]);
const noOverlap = (rects, what) => {
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i][1] >= rects[i - 1][3] - 0.01, `${what}: link ${i + 1} from the bottom overlaps the one under it`);
};

test("render: a crowded cover keeps every contents row above its foot, and no two rows' links overlap", () => {
  // version 2 in compact mode, with the free-text facts long enough to take two lines each
  const m = richModel();
  Object.assign(m.cover, {
    customer: "Jane Sample and John Sample, Trustees of the Sample Family Living Trust dated 2019",
    address: "12345 Example Ridge Road, Unit 4B, Building C (enter from the alley), Fairbanks, AK 99709",
    carrier: "Sample Mutual Fire and Casualty Company c/o Example Claims Services (TPA)",
    adjuster: "Alex Adjuster, Senior Field Adjuster, Example Claims Services (alex.adjuster@claims.example.com)",
    lossCause: "Supply line failure under the kitchen sink; water ran overnight through the subfloor into the basement",
  });
  m.cover.facts.push(["Drying system", "Closed"], ["Air scrubber days", "1 × 4"]);
  const label = { ...LABEL, version: 2, mode: "compact", replaces: { version: 1, sentAt: "2026-10-06T02:30:00Z" },
    changed: ["Job and claim details", "Certificate of Drying", "Moisture Maps", "Drying Logs", "Job Photos", "Supporting Documents", "Invoices"] };
  const pdf = readPdf(render(m, { label, mode: "compact" }).bytes);
  const cover = pdf.pages[0];
  const footRule = Number(/0\.8 w 0\.059 0\.106 0\.176 RG 36 ([\d.]+) m/.exec(cover.ops)[1]);
  const rows = m.sections.map((s) => cover.texts.find((t) => t.text === s.title && t.font === "bold" && t.size === 9.5));
  rows.forEach((t, i) => assert.ok(t && t.y > footRule + 3, `"${m.sections[i].title}" (at ${t && t.y}) prints above the foot rule (${footRule})`));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].y - rows[i].y >= 12 - 0.01, `a 12 pt row pitch above "${m.sections[i].title}"`);
  assert.equal(linkRects(pdf).length, m.sections.length);
  noOverlap(linkRects(pdf), "crowded cover");
  // the usual cover, with part rows under their sections
  noOverlap(linkRects(rich().pdf), "usual cover");
});

test("render: every page after the cover has the running header and the footer with Page N of M", () => {
  const { r, pdf } = rich();
  const sections = new Set(richModel().sections.map((s) => s.title));
  pdf.pages.slice(1).forEach((pg, i) => {
    const head = pg.texts.find((t) => t.text === HEADER);
    assert.ok(head && head.y > PAGE.h - M.t - 12, `page ${i + 2} header`);
    const right = pg.texts.find((t) => t.y === head.y && t !== head);
    assert.ok(right && sections.has(right.text), `page ${i + 2} names its section (${right && right.text})`);
    assert.ok(pg.text.includes(`Page ${i + 2} of ${r.pages}`), `page ${i + 2} footer`);
    assert.ok(pg.text.includes(COMPANY.name) && pg.text.includes(COMPANY.licenses[0]) && pg.text.includes(COMPANY.licenses.at(-1)), `page ${i + 2} licenses`);
    const foot = pg.texts.filter((t) => t.y < M.b + 24);
    assert.ok(foot.length >= 2 && foot.length <= 3, "the footer is at most two lines and the page number");
  });
});

test("render: the claim part of the header is left out when there is no claim number", () => {
  const m = richModel();
  m.cover.claimNo = "";
  const pdf = readPdf(render(m).bytes);
  assert.ok(pdf.pages[1].texts.some((t) => t.text === "PKT-2026-0007 · v1 · Jane Sample"));
  assert.ok(!pdf.pages[0].text.includes("Claim"), "nor on the cover's subtitle");
});

test("render: bookmarks are the sections, with a child for each part title", () => {
  const { pdf } = rich();
  assert.deepEqual(pdf.outline.map((o) => [o.title, o.children.map((c) => c.title)]), richModel().sections.map((s) => [s.title, s.parts.map((p) => p.title).filter(Boolean)]));
  for (const o of pdf.outline) {
    assert.ok(pdf.pages[o.page].texts.some((t) => t.text === o.title.toUpperCase()), `${o.title} bookmark goes to its band`);
    for (const c of o.children) assert.ok(pdf.pages[c.page].texts.some((t) => t.text === c.title.toUpperCase()), `${c.title} bookmark goes to its head`);
  }
});

test("render: /Info has the title, subject, author, dates on the Alaska clock, keywords and the packet keys", () => {
  const { pdf } = rich();
  assert.equal(pdf.info.Title, `${PACKET_TITLE} - Jane Sample - PKT-2026-0007 v1`);
  assert.equal(pdf.info.Subject, "PKT-2026-0007 v1");
  assert.equal(pdf.info.Author, COMPANY.name);
  assert.ok(pdf.info.Creator && pdf.info.Producer);
  assert.equal(pdf.info.CreationDate, "D:20261010120000-08'00'");
  assert.equal(pdf.info.ModDate, "D:20261010120000-08'00'");
  assert.match(pdf.info.Keywords, /PKT-2026-0007/);
  assert.match(pdf.info.Keywords, /DEMO-12345/);
  assert.equal(pdf.info.PacketNumber, "PKT-2026-0007");
  assert.equal(pdf.info.PacketVersion, "1");
  assert.match(pdf.info.ModelHash, /^[0-9a-f]{64}$/);
  // after the fall change the offset is -09'00', and the printed date is Alaska's (Nov 1, not the UTC Nov 2)
  const winter = readPdf(render(richModel(), { label: { ...LABEL, built: new Date("2026-11-02T03:30:00Z") } }).bytes);
  assert.equal(winter.info.CreationDate, "D:20261101183000-09'00'");
  assert.ok(winter.pages[0].texts.some((t) => t.text === "11/01/2026"));
});

test("render: ModelHash is the label's or the model's hash when one is passed, and follows the model otherwise", () => {
  const given = "ab".repeat(32);
  assert.equal(readPdf(render(richModel(), { label: { ...LABEL, hash: given } }).bytes).info.ModelHash, given);
  const m = richModel();
  m._hash = "cd".repeat(32);
  assert.equal(readPdf(render(m).bytes).info.ModelHash, "cd".repeat(32));
  const a = readPdf(render(richModel()).bytes).info.ModelHash;
  const changed = richModel();
  changed.cover.claimNo = "DEMO-99999";
  assert.notEqual(readPdf(render(changed).bytes).info.ModelHash, a);
});

test("render: the same model, images, label and build time give the same bytes", () => {
  const a = render();
  const reversed = new Map([...richImages()].reverse());
  const b = renderPacket(richModel(), { label: { ...LABEL }, mode: "full", images: reversed, now: new Date("2030-01-01T00:00:00Z") });
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(a.bytes, b.bytes);
  const later = render(richModel(), { label: { ...LABEL, built: new Date("2026-10-11T20:00:00Z") } });
  assert.notEqual(later.sha256, a.sha256, "the build time is printed, so it changes the bytes");
  // with no build time on the label, `now` dates it
  const viaNow = renderPacket(richModel(), { label: { ...LABEL, built: undefined }, mode: "full", images: richImages(), now: BUILT });
  assert.equal(viaNow.sha256, a.sha256);
});

test("render: a JPEG is embedded byte for byte, once, however many keys and sections use it", () => {
  const { pdf } = rich();
  const jpegs = [...pdf.objs.values()].filter((o) => o.dict && /\/DCTDecode/.test(o.dict));
  const files = new Set(Object.values(JPEGS));
  assert.equal(jpegs.length, files.size, "one image object per distinct JPEG");
  for (const f of files) {
    const want = jpg(f);
    assert.equal(jpegs.filter((o) => Buffer.compare(Buffer.from(o.data), Buffer.from(want)) === 0).length, 1, `${f} stored once, unchanged`);
  }
  const pngs = [...pdf.objs.values()].filter((o) => o.dict && /\/Subtype \/Image/.test(o.dict) && /\/FlateDecode/.test(o.dict));
  assert.equal(pngs.length, 5, "the sketch, two signatures, the palette and the 16-bit PNG (the sketch is also photo #003)");
  for (const o of pngs) assert.match(o.dict, /\/Predictor 15/);
});

test("render: a missing or unreadable image prints the gray Image not available box", () => {
  const { r, pdf } = rich();
  const n = pdf.pages.reduce((k, pg) => k + pg.texts.filter((t) => t.text === "Image not available").length, 0);
  assert.equal(n, MISSING_KEYS.length);
  assert.equal(r.unavailable, MISSING_KEYS.length, "the renderer counts each key it printed as the box");
  // bytes that downloaded but this writer cannot embed (a HEIC, a TIFF) are boxes too, and counted
  const images = richImages();
  images.set("photo-2", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]));
  images.set("page-landscape", new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0]));
  const odd = render(richModel(), { images });
  const boxes = readPdf(odd.bytes).pages.reduce((k, pg) => k + pg.texts.filter((t) => t.text === "Image not available").length, 0);
  assert.equal(boxes, MISSING_KEYS.length + 2);
  assert.equal(odd.unavailable, MISSING_KEYS.length + 2);
  const none = readPdf(renderPacket(richModel(), { label: LABEL, mode: "full", images: new Map() }).bytes);
  assert.ok(none.pages.reduce((k, pg) => k + pg.texts.filter((t) => t.text === "Image not available").length, 0) >= 20, "with no images at all, every image is a box");
  assert.equal([...none.objs.values()].filter((o) => o.dict && /\/Subtype \/Image/.test(o.dict)).length, 0);
});

test("render: tables split across pages with the header repeated and every row kept in order", () => {
  const { pdf } = rich();
  const psyPages = pdf.pages.filter((pg) => pg.texts.some((t) => t.text === "Scrb" && t.font === "bold"));
  assert.ok(psyPages.length >= 2, `the ${PSY_ROWS}-row psychrometric table spans ${psyPages.length} pages`);
  const techs = psyPages.flatMap((pg) => pg.texts.filter((t) => /^T\d\d$/.test(t.text)).map((t) => t.text));
  assert.deepEqual(techs, Array.from({ length: PSY_ROWS }, (_, r) => psyTech(r)));
  const gridPages = pdf.pages.filter((pg) => pg.texts.some((t) => t.text === "13" && t.font === "bold") && pg.texts.some((t) => t.text === "Date" && t.font === "bold"));
  assert.ok(gridPages.length >= 2, "the 46-row moisture grid repeats its header too");
  assert.ok(pdf.pages.some((pg) => pg.texts.some((t) => t.text === "26" && t.font === "bold")), "the second block of 13 locations");
  assert.ok(pdf.pages.some((pg) => pg.text.includes("None recorded.")), "an empty grid says so");
  assert.ok(pdf.pages.some((pg) => pg.text.includes("Balance due")), "rows under _rows print (payments as of the build)");
});

test("render: wet and dry cells are filled and readings with a photo carry a superscript P", () => {
  const { pdf } = rich();
  const page = pdf.pages.find((pg) => pg.texts.some((t) => t.text === "MOISTURE MAP — KITCHEN"));
  const all = pdf.pages.map((pg) => pg.ops).join("\n");
  assert.ok(all.includes("0.886 0.957 0.914 rg") && all.includes("0.996 0.925 0.906 rg"), "the dry and wet fills");
  const p = pdf.pages.flatMap((pg) => pg.texts).filter((t) => t.text === "P");
  assert.ok(p.length > 10 && p.every((t) => t.size < 8 && t.font === "bold"), "P is a small bold superscript");
  const s = pdf.pages.flatMap((pg) => pg.texts).filter((t) => t.text === "S");
  assert.ok(s.length >= 3, "scanned times carry S");
  assert.ok(page);
});

test("render: full mode puts two photos on a page, compact four", () => {
  const photoPages = (mode) => readPdf(render(richModel(), { mode, label: { ...LABEL, mode } }).bytes).pages
    .filter((pg) => pg.texts.some((t) => t.text === "Job Photos" && t.font === "bold" && t.y > 740));
  assert.equal(photoPages("full").length, 4);
  assert.equal(photoPages("compact").length, 2);
  const compactCover = readPdf(render(richModel(), { mode: "compact", label: { ...LABEL, mode: "compact" } }).bytes).pages[0];
  assert.ok(compactCover.text.includes("reduced in size"), "the cover says the photos are reduced");
});

test("render: version 2 says which version it replaces, when that one was sent, and what changed", () => {
  const label = { ...LABEL, version: 2, replaces: { version: 1, sentAt: "2026-10-06T02:30:00Z" }, changed: ["Moisture Maps", "Invoices"] };
  const pdf = readPdf(render(richModel(), { label }).bytes);
  const cover = pdf.pages[0].text.replace(/\s+/g, " ");
  assert.ok(cover.includes("This version replaces version 1 sent 10/05/2026. Changed: Moisture Maps, Invoices."), "sent on the evening of Oct 5 in Alaska");
  assert.ok(pdf.pages[0].texts.some((t) => t.text === "v2"));
  assert.ok(pdf.pages[1].texts.some((t) => t.text === "PKT-2026-0007 · v2 · Claim DEMO-12345 · Jane Sample"));
  assert.equal(pdf.info.Subject, "PKT-2026-0007 v2");
  assert.equal(pdf.info.PacketVersion, "2");
});

test("render: nothing runs outside the margins — long captions, long URLs and wide tables wrap", () => {
  const { pdf } = rich();
  pdf.pages.forEach((pg, i) => {
    for (const t of pg.texts) {
      assert.ok(t.x >= M.l - 0.5 && t.x + t.w <= PAGE.w - M.r + 0.5, `page ${i + 1}: "${t.text.slice(0, 50)}" (x ${t.x}, w ${t.w.toFixed(1)}) inside the margins`);
      assert.ok(t.y >= M.b - 2 && t.y <= PAGE.h - M.t, `page ${i + 1}: "${t.text.slice(0, 50)}" inside the page`);
    }
  });
  const all = pdf.pages.map((pg) => pg.text).join(" ");
  assert.ok(all.includes("refrigerator alcove"), "a long caption wraps rather than being cut at once");
  assert.ok(all.includes("meter-photo-location-3-full-resolution.jpg") || all.includes("full-resolution.jpg"), "the tail of a long URL prints");
});

test("render: a long part title wraps inside its band, letter spacing and all", () => {
  const m = richModel();
  m.sections.find((s) => s.key === "docs").parts[0].title = "Supporting Document — Plumber's leak report and invoice from Acme Plumbing & Heating dated 10/02/2026";
  m.sections.find((s) => s.key === "maps").parts[0].title = "Moisture Map — Kitchen, dining room and hallway subfloor along the north exterior wall";
  const pdf = readPdf(render(m).bytes);
  const heads = pdf.pages.slice(1).flatMap((pg) => pg.texts.filter((t) => t.font === "bold" && t.size === 10 && t.x === M.l + 9));
  for (const t of heads) assert.ok(t.x + t.w <= PAGE.w - M.r - 2, `"${t.text}" ends at ${(t.x + t.w).toFixed(1)}, inside the band`);
  const words = heads.map((t) => t.text).join(" ");
  assert.ok(words.includes("SUPPORTING DOCUMENT — PLUMBER'S LEAK REPORT") && words.includes("HEATING DATED 10/02/2026"), "the whole title prints across its two lines");
  assert.ok(words.includes("NORTH EXTERIOR WALL"));
});

test("render: a name or a place with a letter WinAnsi lacks prints that letter without its accent", () => {
  const m = richModel();
  m.cover.customer = "Michał Sample";
  m.cover.address = "123 Example St, Utqiaġvik, AK 99723";
  const pdf = readPdf(render(m).bytes);
  assert.ok(pdf.pages[0].texts.some((t) => t.text === "Michal Sample"), "the insured on the cover");
  assert.ok(pdf.pages[0].texts.some((t) => t.text === "123 Example St, Utqiagvik, AK 99723"), "the property on the cover");
  assert.ok(pdf.pages[1].texts.some((t) => t.text === "PKT-2026-0007 · v1 · Claim DEMO-12345 · Michal Sample"), "the running header");
  assert.equal(pdf.info.Title, `${PACKET_TITLE} - Michał Sample - PKT-2026-0007 v1`, "the /Title (UTF-16) keeps the spelling");
});

test("render: the symbols the model emits print in WinAnsi", () => {
  const { pdf } = rich();
  const all = pdf.pages.map((pg) => pg.text).join(" ");
  for (const s of ["<= 16%", ">= 70°F", "Yes done", "No not done", "~ 1,920 cu ft", "2 × 5 days", "!= goal", "± 1", "Out °F", "Subfloor — kitchen"]) {
    assert.ok(all.includes(s), `prints "${s}"`);
  }
});

test("render: signatures print the image, the electronic line and the blank line", () => {
  const { pdf } = rich();
  const cert = pdf.pages[1];
  assert.ok(cert.text.includes("Signed electronically by Jane Sample,"));
  assert.ok(cert.texts.some((t) => t.text === "Pat Sample"));
  assert.ok(cert.texts.some((t) => t.text === "ADJUSTER / CARRIER (IF WITNESS REQUIRED)"));
  assert.match(cert.body, /\/XObject << \/Im\d+ \d+ 0 R/, "the technician's signature image is drawn");
});

test("render: no page is blank and no heading is left at the foot of a page with nothing under it", () => {
  const { pdf } = rich();
  pdf.pages.forEach((pg, i) => {
    const body = pg.texts.filter((t) => t.y < PAGE.h - M.t - 12 && t.y > M.b + 24);
    assert.ok(body.length || / Do Q/.test(pg.ops), `page ${i + 1} has something on it`);
    // a heading (a section band, a part head or a subhead) always has something under it on its page
    const heads = body.filter((t) => t.font === "bold" && t.size >= 9.5 && t.x <= M.l + 12);
    const lowest = Math.min(...body.map((t) => t.y));
    const stranded = heads.filter((h) => h.y <= lowest + 0.5 && !/ Do Q/.test(pg.ops.slice(pg.ops.lastIndexOf(`(${h.text}`))));
    assert.equal(stranded.length, 0, `page ${i + 1}: a heading ends the page (${stranded.map((t) => t.text).join(", ")})`);
  });
});

test("render: every block type renders, and a broken model renders what it can without throwing", () => {
  const broken = {
    cover: { customer: "Jane Sample", facts: [["Only a label"], null, "nope"] },
    sections: [
      null,
      { key: "cert", title: "", parts: null },
      { key: "logs", title: "Drying Logs", parts: [null, { title: 7, newPage: "yes", blocks: [
        null, 3, { t: "table" }, { t: "table", columns: [null, { head: "A" }], rows: [null, "x", [{ text: { nested: true } }, 5]] },
        { t: "fields", pairs: [null, ["Label"], ["Label", null], "x"], cols: 9 }, { t: "subhead" }, { t: "subhead", text: "Last heading" },
        { t: "image", media: { not: "a key" } }, { t: "grid", items: [null, { media: "x" }], perRow: 0, boxH: -5 },
        { t: "photos", items: [] }, { t: "pages", items: [{}] }, { t: "signatures", items: [{}] }, { t: "note" }, { t: "bullets", items: [null, 5] },
        { t: "para", text: null, size: "huge", font: "comic", color: "plaid" },
      ] }] },
    ],
  };
  const r = renderPacket(broken, { label: { number: "PKT-2026-0001", version: "x", built: "not a date" }, images: { x: new Uint8Array([1, 2]) } });
  const pdf = readPdf(r.bytes);
  assert.ok(r.pages >= 2);
  assert.equal(pdf.info.PacketVersion, "1");
  assert.equal(pdf.info.CreationDate, undefined, "no date is printed when there is none");
  assert.deepEqual(pdf.outline.map((o) => o.title), ["cert", "Drying Logs"]);
  const empty = renderPacket(null, {});
  assert.equal(empty.pages, 1, "no model: a cover only");
  assert.ok(readPdf(empty.bytes).pages[0].text.includes("No sections are included in this packet."));
});
