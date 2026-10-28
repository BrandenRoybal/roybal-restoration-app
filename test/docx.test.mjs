/* Editable Word estimate — js/docx.js. Round-trips the .docx through
   xlsx.js's zip reader and checks the WordprocessingML it carries.
   Run: node apps/field/test/docx.test.mjs   (from repo root)
   Optional: DOCX_OUT=/tmp/x.docx writes the sample file for a manual open. */
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { estimateDocx, estimateDocumentXml, estimateFigures, itemsByArea, estimateDocxName, esc, money } from "../js/docx.js";
import { zipIndex, zipRead } from "../js/xlsx.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

console.log("Word estimate (.docx)");

const project = { customer: "Pat Kennedy", address: "1465 Noble St", phone: "907-555-0100", email: "pat@example.com" };
const inv = {
  invoiceNo: "RC-KEN-0926", invoiceDate: "2026-09-24", dueDate: "2026-10-24",
  lossSummary: "Kitchen remodel & new flooring <main level>",
  items: [
    { room: "Kitchen", desc: "Demo cabinets & haul", qty: "1", unit: "LS", price: "1200" },
    { room: "Kitchen", desc: "New base cabinets", qty: "12", unit: "LF", price: "350", by: "Northland Cabinets" },
    { room: "Living Room", desc: "LVP flooring", qty: "400", unit: "SF", price: "6.5" },
    { room: "Living Room", desc: "", qty: "1", price: "999" },            // priced, no description — still prints
    { room: "Bath", desc: "", qty: "", price: "" },                        // empty row — skipped
  ],
  opMode: "pct", overheadPct: "10", profitPct: "10", contingencyPct: "5", taxRate: "",
  accuracyPct: "15", duration: "3 weeks",
  alternates: [{ title: "Quartz counters", description: "Upgrade from laminate", baseCost: "3000" }, { title: "", baseCost: "" }],
  notes: "ASSUMPTIONS\n• Existing plumbing reused",
};

/* ---------- the math matches the printed sheet ---------- */
const f = estimateFigures(inv, true);
// subtotal 1200 + 4200 + 2600 + the undescribed 999 (the sheet counts qty×price on every row)
ok("subtotal counts every priced row, like recalc()", f.subtotal === 1200 + 4200 + 2600 + 999);
ok("construction: contingency before O&P, O&P on that base", Math.abs(f.cont - f.subtotal * 0.05) < 1e-9
  && Math.abs(f.oh - (f.subtotal * 1.05) * 0.1) < 1e-9 && Math.abs(f.total - f.subtotal * 1.05 * 1.2) < 1e-9);
ok("alternates carry contingency + O&P, empty ones dropped", f.alternates.length === 1 && Math.abs(f.alternates[0].amount - 3000 * 1.05 * 1.2) < 1e-9);
ok("contract billing: the agreed figure is the total", estimateFigures({ billingModel: "contract", contractAmount: "50000", items: [{ qty: 1, price: 10 }] }).total === 50000);
ok("restoration estimate without a % carries no contingency", estimateFigures({ items: [{ qty: 1, price: 100 }], contingencyPct: "" }, false).cont === 0);

/* ---------- grouping ---------- */
const g = itemsByArea(inv.items);
ok("items group by area in order; empty rows skipped, priced rows kept so the table adds up",
  g.map((x) => x.area).join() === "Kitchen,Living Room" && g[1].items.length === 2
  && g.flatMap((x) => x.items).reduce((t, it) => t + Number(it.qty) * Number(it.price), 0) === f.subtotal);

/* ---------- XML ---------- */
ok("XML escapes &, <, > and quotes", esc(`a & b <c> "d"`) === "a &amp; b &lt;c&gt; &quot;d&quot;");
ok("XML drops control characters Word refuses", esc("a\u0007b\tc") === "ab\tc");
const xml = estimateDocumentXml(project, inv, { isBuild: true });
ok("document carries the letterhead, number, customer and total",
  xml.includes("Roybal Construction, LLC") && xml.includes("RC-KEN-0926") && xml.includes("Pat Kennedy")
  && xml.includes(money(f.total)) && xml.includes("ESTIMATE"));
ok("user text is escaped inside the document", xml.includes("Kitchen remodel &amp; new flooring &lt;main level&gt;") && !xml.includes("<main level>"));
ok("area subtotals, performer, alternates, range, duration and notes all print",
  xml.includes(">Kitchen<") && xml.includes("(Northland Cabinets)") && xml.includes("Quartz counters")
  && xml.includes("Expected range at ±15%") && xml.includes("Estimated duration: 3 weeks") && xml.includes("Existing plumbing reused"));
ok("tags balance (a cheap well-formedness check)",
  ["w:p", "w:r", "w:tbl", "w:tr", "w:tc", "w:t"].every((t) =>
    (xml.match(new RegExp(`<${t}[ >]`, "g")) || []).length === (xml.match(new RegExp(`</${t}>`, "g")) || []).length));
const rxml = estimateDocumentXml({ ...project, carrier: "State Farm", claimNo: "12-345" }, { ...inv, contingencyPct: "" }, { isBuild: false });
ok("a restoration estimate is titled for reconstruction and shows the claim", rxml.includes("RECONSTRUCTION ESTIMATE") && rxml.includes("Claim #: 12-345"));

/* ---------- the package ---------- */
const buf = concat(estimateDocx(project, inv, { isBuild: true }));
const entries = zipIndex(buf);
ok("package has the five required parts",
  ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml"].every((n) => entries.has(n)));
const doc = await zipRead(buf, entries, "word/document.xml");
ok("document.xml round-trips out of the zip", doc === xml);
const types = await zipRead(buf, entries, "[Content_Types].xml");
ok("content types declare the main document", types.includes("wordprocessingml.document.main+xml"));
ok("file name is safe and readable", estimateDocxName(project, inv) === "Estimate - RC-KEN-0926 - Pat Kennedy.docx"
  && estimateDocxName({ customer: 'A/B: "C"' }, {}) === "Estimate - A-B- -C-.docx");

if (process.env.DOCX_OUT) { writeFileSync(process.env.DOCX_OUT, buf); console.log("  wrote " + process.env.DOCX_OUT); }
console.log(`\n${pass} docx checks passed.`);
