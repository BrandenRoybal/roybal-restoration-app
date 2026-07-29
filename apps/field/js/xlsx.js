/* ============================================================
   Minimal .xlsx reader — zero dependencies.

   An .xlsx is a ZIP of XML parts. We only need three of them:
     xl/workbook.xml       sheet names, in order
     xl/sharedStrings.xml  the string pool most cells point into
     xl/worksheets/sheetN.xml   the actual grid

   Written against Xactimate's "Export to Excel" output, which is
   machine-generated and predictable — this is not a general-purpose
   spreadsheet library and does not try to be. It reads values only:
   no formulas, no styles, no dates-as-serial-numbers conversion.

   Runs unchanged in the browser and in Node (18+).
   ============================================================ */

/* ---------- byte helpers ---------- */
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/* Raw-deflate via the platform. DecompressionStream covers every browser we
   target and Node 18+; the zlib fallback is only reached off-web. */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "function") {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateRawSync } = await import("node:zlib");
  return new Uint8Array(inflateRawSync(bytes));
}

/* ---------- ZIP ---------- */

/* Read the central directory and return { name -> {offset, method, size} }.
   We trust the central directory over local headers, then seek to the local
   header only to learn where the compressed bytes actually start (its extra
   field length routinely differs from the central copy). */
function zipIndex(buf) {
  // End of Central Directory: scan back from the tail, past any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) break;
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOff = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipRead(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (u32(buf, e.localOff) !== 0x04034b50) throw new Error("corrupt local header for " + name);
  const start = e.localOff + 30 + u16(buf, e.localOff + 26) + u16(buf, e.localOff + 28);
  const raw = buf.subarray(start, start + e.compSize);
  const out = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw)
    : (() => { throw new Error("unsupported zip compression method " + e.method + " for " + name); })();
  return new TextDecoder().decode(out);
}

/* ---------- XML ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

/* All <t> text inside one element, concatenated — shared strings are split
   across <r> runs when a cell mixes formatting. */
function innerText(xml) {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(innerText(m[1]));
  return out;
}

/* "BC12" -> 54. Column letters are base-26 with A=1. */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* Sheet grid -> array of row arrays. Cells with no r= attribute fall back to
   sequential position, which is what minimal writers emit. */
function sheetRows(xml, strings) {
  const rows = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let auto = 0, width = 0;
    for (const cM of rowM[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1] || "", body = cM[2] || "";
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      let idx = refM ? colIndex(refM[1]) : auto;
      if (idx < 0) idx = auto;
      auto = idx + 1;

      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || "n";
      let value = "";
      if (type === "inlineStr") {
        value = innerText(body);
      } else {
        const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = vM ? decodeXml(vM[1]) : "";
        value = type === "s" ? (strings[Number(raw)] ?? "") : raw;
      }
      cells[idx] = value;
      if (idx + 1 > width) width = idx + 1;
    }
    for (let i = 0; i < width; i++) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

/* ---------- public ---------- */

/* Read an .xlsx into { sheets: [{ name, rows }] }.
   `input` may be an ArrayBuffer, a Uint8Array, or a Node Buffer. */
export async function readXlsx(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = zipIndex(buf);

  const strings = sharedStrings(await zipRead(buf, entries, "xl/sharedStrings.xml"));

  // Sheet order and names come from workbook.xml; the r:id -> file mapping
  // lives in the rels part. Fall back to file order when rels is absent.
  const wb = await zipRead(buf, entries, "xl/workbook.xml");
  const rels = await zipRead(buf, entries, "xl/_rels/workbook.xml.rels");
  const relTarget = new Map();
  if (rels) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = (/\bId="([^"]+)"/.exec(m[1]) || [])[1];
      const target = (/\bTarget="([^"]+)"/.exec(m[1]) || [])[1];
      if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
    }
  }

  const declared = [];
  if (wb) {
    for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const name = (/\bname="([^"]*)"/.exec(m[1]) || [])[1];
      const rid = (/\br:id="([^"]+)"/.exec(m[1]) || [])[1];
      declared.push({ name: name ? decodeXml(name) : "", part: rid ? relTarget.get(rid) : null });
    }
  }

  const sheetParts = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const sheets = [];
  const wanted = declared.length ? declared : sheetParts.map((p) => ({ name: "", part: p.replace(/^xl\//, "") }));
  for (let i = 0; i < wanted.length; i++) {
    const part = wanted[i].part ? "xl/" + wanted[i].part : sheetParts[i];
    if (!part || !entries.has(part)) continue;
    const xml = await zipRead(buf, entries, part);
    sheets.push({ name: wanted[i].name || "Sheet" + (i + 1), rows: sheetRows(xml, strings) });
  }
  return { sheets };
}

/* Convenience: first sheet as objects keyed by its header row.
   Returns { headers, rows } where each row is a plain object. */
export function asRecords(sheet) {
  const rows = (sheet && sheet.rows) || [];
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h || "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.some((c) => String(c || "").trim())) continue;
    const rec = {};
    for (let c = 0; c < headers.length; c++) if (headers[c]) rec[headers[c]] = r[c] ?? "";
    out.push(rec);
  }
  return { headers, rows: out };
}
