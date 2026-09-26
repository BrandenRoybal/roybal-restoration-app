/* Xactimate export -> selection sheet. The taxonomy is the whole product:
   getting "which lines is the customer allowed to choose about" wrong either
   hides a decision or asks them to pick a vapor barrier.
   Run: node apps/field/test/xactimate.test.mjs */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { readXlsx, asRecords } from "../js/xlsx.js";
import {
  classifyLine, wastePct, normalizeLines, buildSelectionSheet,
  selectionSheetFromXlsx, SELECTION_TYPES,
} from "../js/xactimate.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, `${name}\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`); console.log("  ✓ " + name); pass++; };

console.log("Xactimate estimate -> selection sheet");

/* ============================================================
   1. Taxonomy
   ============================================================ */
console.log("\n classifyLine");

eq("carpet is flooring", classifyLine("FCC", "AV"), "flooring");
eq("sheet vinyl is flooring", classifyLine("FCV", "AV"), "flooring");
eq("carpet pad rides with flooring", classifyLine("FCC", "PAD"), "flooring");
eq("lower cabinets are cabinets", classifyLine("CAB", "LOW"), "cabinets");
eq("CAB countertop selector splits to countertops", classifyLine("CAB", "CTFL"), "countertops");
eq("CAB vanity selector splits to vanity", classifyLine("CAB", "VAN"), "vanity");
eq("cultured-marble vanity top is a countertop", classifyLine("MBL", "VTSNK"), "countertops");
eq("baseboard is trim", classifyLine("FNC", "B+"), "trim");
eq("casing is trim", classifyLine("FNC", "C+"), "trim");
eq("interior door", classifyLine("DOR", "BIRCH-"), "doors");
eq("toilet is a fixture", classifyLine("PLM", "TLT"), "fixtures");
eq("range is an appliance", classifyLine("APP", "RGG"), "appliances");
eq("interior T&G reads as wall covering", classifyLine("SDG", "TGC"), "wallcovering");

/* PNT is the category that will bite — masking, sealer and floor protection
   live beside the actual wall color. */
eq("paint two-coat is a color choice", classifyLine("PNT", "P2"), "paint");
eq("stain & finish trim is a finish choice", classifyLine("PNT", "TRIMS"), "trimfinish");
eq("masking is NOT a selection", classifyLine("PNT", "MASKLF"), null);
eq("floor protection is NOT a selection", classifyLine("PNT", "MASKFL"), null);
eq("sealer is NOT a selection", classifyLine("PNT", "S-"), null);

eq("drywall board is NOT a selection", classifyLine("DRY", "LF"), null);
eq("knockdown texture IS a selection", classifyLine("DRY", "KD"), "texture");
eq("water extraction is NOT a selection", classifyLine("WTR", "BARR"), null);
eq("demo is NOT a selection", classifyLine("DMO", "PU"), null);
eq("cleaning is NOT a selection", classifyLine("CLN", "FINALR"), null);
eq("empty category is not a selection", classifyLine("", ""), null);
eq("lowercase input still classifies", classifyLine("fcc", "av"), "flooring");

ok("every type in the taxonomy has a label, scope and order",
  Object.values(SELECTION_TYPES).every((t) => t.label && t.scope && typeof t.order === "number"));

/* ============================================================
   2. Waste
   ============================================================ */
console.log("\n wastePct");
eq("reads a waste note", wastePct("15 % waste added for Carpet."), 15);
eq("tolerates no space", wastePct("10% waste added"), 10);
eq("no note means null", wastePct(""), null);
eq("unrelated note means null", wastePct("see F9 note"), null);

/* ============================================================
   3. Normalization + grouping
   ============================================================ */
console.log("\n normalizeLines / buildSelectionSheet");

const REC = (o) => ({
  Excluded: "False", "#": "", "Group Code": "", "Group Description": "", Desc: "",
  Qty: "", "Item Amount": "", Unit: "", "Unit Cost": "", RCV: "", ACV: "",
  Life: "", Recoverable: "Yes", Cat: "", Sel: "", "Note 1": "", ...o,
});

const records = [
  REC({ "#": 1, "Group Code": "LIVING_ROOM", "Group Description": "Living Room", Desc: "Carpet",
        Qty: "296.85", Unit: "SF", "Unit Cost": "4.47", "Item Amount": "1326.92", Cat: "FCC", Sel: "AV",
        "Note 1": "15 % waste added for Carpet." }),
  REC({ "#": 2, "Group Code": "LIVING_ROOM", "Group Description": "Living Room", Desc: "Carpet pad",
        Qty: "258.13", Unit: "SF", "Unit Cost": "0.83", "Item Amount": "214.25", Cat: "FCC", Sel: "PAD" }),
  REC({ "#": 3, "Group Code": "LIVING_ROOM", "Group Description": "Living Room", Desc: "Baseboard",
        Qty: "30", Unit: "LF", "Unit Cost": "4.9", "Item Amount": "147", Cat: "FNC", Sel: "B+" }),
  REC({ "#": 4, "Group Code": "BEDROOM_1", "Group Description": "Bedroom 1", Desc: "Baseboard",
        Qty: "35", Unit: "LF", "Unit Cost": "4.9", "Item Amount": "171.5", Cat: "FNC", Sel: "B+" }),
  REC({ "#": 5, "Group Code": "BEDROOM_1", "Group Description": "Bedroom 1", Desc: "Mask and prep for paint",
        Qty: "44.67", Unit: "LF", "Unit Cost": "2.17", "Item Amount": "96.93", Cat: "PNT", Sel: "MASKLF" }),
  REC({ "#": 6, "Group Code": "MAIN_LEVEL", "Group Description": "Main Level", Desc: "Containment Barrier",
        Qty: "48", Unit: "SF", "Unit Cost": "1.26", "Item Amount": "60.48", Cat: "WTR", Sel: "BARR" }),
  REC({ "#": 7, Excluded: "True", "Group Code": "BEDROOM_1", "Group Description": "Bedroom 1",
        Desc: "Dropped line", Qty: "1", Unit: "EA", "Unit Cost": "999", "Item Amount": "999", Cat: "FCC", Sel: "AV" }),
  REC({ "#": 8, "Group Code": "BATHROOM", "Group Description": "Bathroom", Desc: "Toilet",
        Qty: "1", Unit: "EA", "Unit Cost": "313.77", "Item Amount": "313.77", Cat: "PLM", Sel: "TLT" }),
  REC({ "#": 9, "Group Code": "BATHROOM_2", "Group Description": "Bathroom 2", Desc: "Toilet",
        Qty: "1", Unit: "EA", "Unit Cost": "313.77", "Item Amount": "313.77", Cat: "PLM", Sel: "TLT" }),
];

const lines = normalizeLines(records);
eq("excluded rows are dropped", lines.length, 8);
ok("numbers are parsed, not left as strings", typeof lines[0].qty === "number" && lines[0].qty === 296.85);
eq("waste is lifted off the note", lines[0].waste, 15);

const sheet = buildSelectionSheet(lines);
const byId = Object.fromEntries(sheet.selections.map((s) => [s.id, s]));

eq("scope lines are set aside, not shown to the customer",
  sheet.scopeOnly.map((l) => l.cat + " " + l.sel).sort(), ["PNT MASKLF", "WTR BARR"]);

const floor = byId["flooring--living-room"];
ok("flooring decision exists for the living room", !!floor);
eq("carpet and pad collapse into one decision", floor.items.length, 2);
eq("the customer is choosing the carpet, not the pad", floor.cat + " " + floor.sel, "FCC AV");

/* The regression this whole rollup exists for: summing across a group would
   add 296.85 SF of carpet to 258.13 SF of pad and show 554.98. */
eq("quantity is the carpet's, NOT carpet + pad", floor.qty, 296.85);
eq("but the credit is the whole group", floor.lkqTotal, 1541.17);
eq("waste survives onto the decision", floor.waste, 15);

const trim = byId["trim--house"];
ok("baseboard collapses to one whole-house decision", !!trim);
eq("repeated items DO sum across rooms", trim.qty, 65);
eq("and it names both rooms", trim.rooms.sort(), ["Bedroom 1", "Living Room"]);
eq("house-scope decisions are not titled with a room", trim.title, "Baseboard & casing");

const toilet = sheet.selections.find((s) => s.type === "fixtures");
eq("the same fixture in two bathrooms is one decision", toilet.qty, 2);
eq("an item decision is titled with the product, not the category", toilet.title, "Toilet");
eq("and it records where it goes", toilet.rooms.sort(), ["Bathroom", "Bathroom 2"]);

/* Re-importing a revised estimate must not orphan the customer's picks. */
const again = buildSelectionSheet(normalizeLines(records));
eq("ids are deterministic across runs",
  again.selections.map((s) => s.id), sheet.selections.map((s) => s.id));

const t = sheet.totals;
ok("selection value + scope value reconciles to the estimate total",
  Math.round((t.selectionValue + t.scopeValue) * 100) === Math.round(t.estimateValue * 100));

/* ============================================================
   4. The .xlsx reader, against a synthesized workbook
   (a real Xactimate export is a customer's job file and does not
    belong in the repo, so build a valid one here instead)
   ============================================================ */
console.log("\n readXlsx");

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/* Minimal stored-compression (method 0) zip writer. */
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const w16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const w32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, text] of Object.entries(files)) {
    const nm = enc.encode(name), data = enc.encode(text), c = crc32(data);
    const local = Uint8Array.from([...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(c), ...w32(data.length), ...w32(data.length), ...w16(nm.length), ...w16(0), ...nm]);
    parts.push(local, data);
    central.push(Uint8Array.from([...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(c), ...w32(data.length), ...w32(data.length), ...w16(nm.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(0), ...w32(offset), ...nm]));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = Uint8Array.from([...w32(0x06054b50), ...w16(0), ...w16(0),
    ...w16(central.length), ...w16(central.length), ...w32(cdSize), ...w32(offset), ...w16(0)]);
  const all = [...parts, ...central, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of all) { out.set(chunk, p); p += chunk.length; }
  return out;
}

/* Build a workbook the way Excel does: text via the shared-string pool,
   numbers inline — which is exactly what Xactimate emits. */
function makeXlsx(rows) {
  const pool = [];
  const idx = (s) => { let i = pool.indexOf(s); if (i < 0) { i = pool.length; pool.push(s); } return i; };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const col = (n) => { let s = ""; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const body = rows.map((row, r) =>
    `<row r="${r + 1}">` + row.map((v, c) => {
      const ref = `${col(c)}${r + 1}`;
      if (v === "" || v == null) return "";
      return typeof v === "number"
        ? `<c r="${ref}"><v>${v}</v></c>`
        : `<c r="${ref}" t="s"><v>${idx(String(v))}</v></c>`;
    }).join("") + "</row>").join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${pool.length}" uniqueCount="${pool.length}">${pool.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`;
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Book1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": shared,
    "xl/worksheets/sheet1.xml": sheet,
  });
}

const HEADERS = ["Excluded", "#", "Group Code", "Group Description", "Desc", "Age", "Condition", "Qty",
  "Item Amount", "Unit", "Reported Cost", "Unit Cost", "Coverage", "Sales Tax", "RCV", "Life",
  "Depreciation Type", "Depreciation Amount", "Recoverable", "ACV", "Tax", "Replace", "Cat", "Sel",
  "Owner", "Original Vendor", "Date", "Source Name", "Note 1"];

const row = (o) => HEADERS.map((h) => (h in o ? o[h] : ""));
const bytes = makeXlsx([
  HEADERS,
  row({ Excluded: "False", "#": 1, "Group Code": "LIVING_ROOM", "Group Description": "Living Room",
        Desc: "Carpet", Qty: 296.85, Unit: "SF", "Unit Cost": 4.47, "Item Amount": 1326.92,
        Cat: "FCC", Sel: "AV", "Note 1": "15 % waste added for Carpet." }),
  row({ Excluded: "False", "#": 2, "Group Code": "LIVING_ROOM", "Group Description": "Living Room",
        Desc: "Toilet & \"comfort\" seat <upgrade>", Qty: 1, Unit: "EA", "Unit Cost": 313.77,
        "Item Amount": 313.77, Cat: "PLM", Sel: "TLT" }),
]);

const wb = await readXlsx(bytes);
eq("reads the sheet name from workbook.xml", wb.sheets[0].name, "Book1");
eq("reads every row", wb.sheets[0].rows.length, 3);

const rec = asRecords(wb.sheets[0]);
eq("header row becomes keys", rec.headers.length, 29);
eq("resolves shared strings", rec.rows[0]["Desc"], "Carpet");
eq("keeps numeric cells", rec.rows[0]["Unit Cost"], "4.47");
eq("decodes XML entities", rec.rows[1]["Desc"], 'Toilet & "comfort" seat <upgrade>');

const built = buildSelectionSheet(normalizeLines(rec.rows));
eq("end-to-end produces both decisions", built.selections.length, 2);
eq("and reconciles", Math.round(built.totals.estimateValue * 100), Math.round(1640.69 * 100));

/* ============================================================
   5. Guardrails on bad input
   ============================================================ */
console.log("\n bad input");

await assert.rejects(
  () => selectionSheetFromXlsx(makeXlsx([["Name", "Qty"], ["Widget", 1]])),
  /does not look like an Xactimate estimate export/,
  "a non-Xactimate workbook is rejected with a useful message");
console.log("  ✓ a non-Xactimate workbook is rejected with a useful message"); pass++;

await assert.rejects(
  () => selectionSheetFromXlsx(makeXlsx([HEADERS])),
  /no line items/, "a header-only export is rejected");
console.log("  ✓ a header-only export is rejected"); pass++;

eq("an empty record set yields no lines", normalizeLines([]).length, 0);
eq("undefined records do not throw", normalizeLines(undefined).length, 0);

/* ============================================================
   6. Optional: the real thing, when it happens to be on this machine
   ============================================================ */
const REAL = "/Users/brandenroybal/Documents/Roybal Construction, LLC/Jobs/Graham - 264 Cindy dr./Documents/GRAHAM-RESTORATION.xlsx";
if (existsSync(REAL)) {
  console.log("\n real Xactimate export (GRAHAM-RESTORATION.xlsx)");
  const real = await selectionSheetFromXlsx(readFileSync(REAL));
  eq("reads all 120 line items", real.totals.lineCount, 120);
  ok("finds a workable number of decisions", real.totals.selectionCount > 20 && real.totals.selectionCount < 60);
  ok("reconciles to the estimate total",
    Math.round((real.totals.selectionValue + real.totals.scopeValue) * 100) === Math.round(real.totals.estimateValue * 100));
  ok("no decision carries a zero-percent waste note",
    real.selections.every((s) => s.waste === null || s.waste > 0));
  ok("every decision has at least one item and a positive credit",
    real.selections.every((s) => s.items.length >= 1 && s.lkqTotal > 0));
  ok("carpet decisions keep carpet and pad as separate items",
    real.selections.filter((s) => s.items.some((i) => i.sel === "PAD"))
      .every((s) => s.cat === "FCC" && s.sel === "AV" && s.items.length === 2));
} else {
  console.log("\n (skipped real-export check — GRAHAM-RESTORATION.xlsx not on this machine)");
}

console.log(`\n${pass} assertions passed`);
