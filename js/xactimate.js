/* ============================================================
   Xactimate estimate -> customer selection sheet.

   Input is Xactimate's own "Export to Excel" of an estimate — the
   sanctioned export, of Branden's own work product on a claim he was
   engaged for. We never touch the Verisk price list; the like-kind-and-
   quality baseline for a job is whatever that job's approved estimate
   already says, and upgrade pricing is ours.

   The job here is to decide which put-back lines a homeowner can
   actually make a choice about, and group them into decisions:

     Living Room / FCC AV carpet + FCC PAD pad   -> one flooring decision
     FNC B+ baseboard across eight rooms          -> one trim decision
     PLM TLT toilet in two bathrooms              -> one fixture decision

   Everything else — extraction, demo, drywall board, insulation — is
   scope, not a choice, and is kept aside rather than shown to the customer.
   ============================================================ */

import { readXlsx, asRecords } from "./xlsx.js";

/* ---------- selection taxonomy ----------
   scope decides how lines collapse into one decision:
     room  — per room (different rooms can differ)
     house — one decision for the whole job
     item  — one decision per distinct catalog item, across rooms   */
export const SELECTION_TYPES = {
  flooring:     { label: "Flooring",            scope: "room",  order: 10 },
  wallcovering: { label: "Wall covering",       scope: "room",  order: 20 },
  cabinets:     { label: "Cabinets",            scope: "room",  order: 30 },
  countertops:  { label: "Countertops",         scope: "room",  order: 40 },
  vanity:       { label: "Vanity",              scope: "room",  order: 50 },
  paint:        { label: "Wall color",          scope: "room",  order: 60 },
  texture:      { label: "Wall texture",        scope: "house", order: 70 },
  trim:         { label: "Baseboard & casing",  scope: "house", order: 80 },
  trimfinish:   { label: "Trim finish",         scope: "house", order: 90 },
  doors:        { label: "Interior doors",      scope: "house", order: 100 },
  fixtures:     { label: "Plumbing fixtures",   scope: "item",  order: 110 },
  lighting:     { label: "Lighting",            scope: "item",  order: 120 },
  appliances:   { label: "Appliances",          scope: "item",  order: 130 },
};

/* Selectors inside a category that are prep or substrate, not a choice.
   PNT is the messy one: masking, floor protection and sealer all live in
   the same category as the actual color. */
const PAINT_COLOR = /^P\d/i;                 // P2 = walls, two coats
const PAINT_TRIM = /^TRIM/i;                 // TRIMS = stain & finish trim
const TEXTURE_SEL = /^(TEX|KD|ORPL|SWRL|SKIP)/i;
const CAB_COUNTER = /^CT/i;                  // CTFL = countertop, flat laid
const CAB_VANITY = /^VAN/i;
const MBL_TOP = /^(VT|CT)/i;                 // VTSNK = vanity top, one sink

/* cat -> type, for categories that map wholesale. */
const SIMPLE = {
  FCC: "flooring", FCV: "flooring", FCW: "flooring", FCT: "flooring", FCS: "flooring",
  DOR: "doors",
  APP: "appliances",
  PLM: "fixtures",
  LIT: "lighting",
  SDG: "wallcovering",
};

/* Decide which decision a line belongs to, or null when it is scope.
   Kept as one function so the whole taxonomy is inspectable and testable. */
export function classifyLine(cat, sel) {
  const c = String(cat || "").toUpperCase().trim();
  const s = String(sel || "").toUpperCase().trim();
  if (!c) return null;

  if (SIMPLE[c]) return SIMPLE[c];

  if (c === "CAB") {
    if (CAB_COUNTER.test(s)) return "countertops";
    if (CAB_VANITY.test(s)) return "vanity";
    return "cabinets";                       // LOW / UPP / FULL
  }
  if (c === "MBL") return MBL_TOP.test(s) ? "countertops" : null;
  if (c === "PNT") {
    if (PAINT_COLOR.test(s)) return "paint";
    if (PAINT_TRIM.test(s)) return "trimfinish";
    return null;                             // MASKLF, S-, floor protection
  }
  if (c === "DRY") return TEXTURE_SEL.test(s) ? "texture" : null;
  if (c === "FNC") return /^[BC]/i.test(s) ? "trim" : null;   // B+ base, C+ casing
  return null;
}

/* ---------- parsing ---------- */

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => String(v ?? "").trim();

/* Waste is printed as a note, not a field, and FCC/FCV exclude it from the
   unit price — so an upgrade off one of those lines has to re-apply it. */
export function wastePct(note) {
  const m = /(\d+(?:\.\d+)?)\s*%\s*waste/i.exec(String(note || ""));
  return m ? Number(m[1]) : null;
}

/* Xactimate export records -> normalized lines. Header-keyed, not positional,
   so a differently-ordered export still reads correctly. */
export function normalizeLines(records) {
  const out = [];
  for (const r of records || []) {
    const excluded = /^true$/i.test(str(r["Excluded"]));
    const desc = str(r["Desc"]);
    if (excluded || !desc) continue;
    const cat = str(r["Cat"]).toUpperCase();
    const sel = str(r["Sel"]).toUpperCase();
    out.push({
      no: num(r["#"]) || out.length + 1,
      roomKey: str(r["Group Code"]),
      room: str(r["Group Description"]) || str(r["Group Code"]),
      desc,
      qty: num(r["Qty"]),
      unit: str(r["Unit"]).toUpperCase(),
      unitCost: num(r["Unit Cost"]),
      amount: num(r["Item Amount"]),
      rcv: num(r["RCV"]),
      acv: num(r["ACV"]),
      life: str(r["Life"]),
      recoverable: /^yes$/i.test(str(r["Recoverable"])),
      cat,
      sel,
      note: str(r["Note 1"]),
      waste: wastePct(r["Note 1"]),
      type: classifyLine(cat, sel),
    });
  }
  return out;
}

/* ---------- grouping ---------- */

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* Group key decides what collapses together. Deterministic, so re-importing
   the same estimate yields the same selection ids and prior customer picks
   survive a re-import. */
function groupKey(line, scope) {
  if (scope === "room") return `${line.type}--${slug(line.roomKey || line.room)}`;
  if (scope === "item") return `${line.type}--${slug(line.cat + "-" + line.sel)}`;
  return `${line.type}--house`;
}

/* Build the customer-facing selection sheet.
   Returns { selections, scopeOnly, rooms, totals }. */
export function buildSelectionSheet(lines) {
  const groups = new Map();
  const scopeOnly = [];

  for (const line of lines) {
    if (!line.type) { scopeOnly.push(line); continue; }
    const meta = SELECTION_TYPES[line.type];
    if (!meta) { scopeOnly.push(line); continue; }
    const key = groupKey(line, meta.scope);
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        type: line.type,
        label: meta.label,
        scope: meta.scope,
        order: meta.order,
        room: meta.scope === "room" ? line.room : null,
        roomKey: meta.scope === "room" ? line.roomKey : null,
        rooms: new Set(),
        lines: [],
      });
    }
    const g = groups.get(key);
    g.rooms.add(line.room);
    g.lines.push(line);
  }

  const round = (n) => Math.round(n * 100) / 100;

  const selections = [...groups.values()].map((g) => {
    /* Roll the group's lines up by catalog item. A decision can span several
       distinct items in two different ways, and they must not be conflated:
         complementary  — carpet + carpet pad in one room
         repeated       — the same baseboard in ten rooms
       Summing quantities across a group would add carpet SF to pad SF and
       produce a number that means nothing, so quantities only ever sum
       within one cat+sel. */
    const byItem = new Map();
    for (const l of g.lines) {
      const k = l.cat + "|" + l.sel + "|" + l.unit;
      if (!byItem.has(k)) {
        byItem.set(k, { cat: l.cat, sel: l.sel, desc: l.desc, unit: l.unit, qty: 0, unitCost: l.unitCost, amount: 0, waste: null, count: 0 });
      }
      const it = byItem.get(k);
      it.qty += l.qty;
      it.amount += l.amount;
      it.count++;
      // Only a non-zero waste factor is worth carrying up. Xactimate sometimes
      // staples a "0 % waste added for Carpet" note onto an unrelated line
      // (it lands on a bifold door in the Graham estimate) — that is noise.
      if (l.waste > 0) it.waste = l.waste;
    }
    const items = [...byItem.values()]
      .map((it) => ({ ...it, qty: round(it.qty), amount: round(it.amount) }))
      .sort((a, b) => b.amount - a.amount);

    // The largest item is the one the customer is actually choosing; the rest
    // follow it (pick the carpet, the pad comes along).
    const primary = items[0];
    const rooms = [...g.rooms];
    const where = g.scope === "room" ? g.room
      : rooms.length === 1 ? rooms[0]
        : rooms.length <= 3 ? rooms.join(", ") : `${rooms.length} rooms`;

    /* An item-scoped decision IS a product ("Toilet"), so name it that way —
       four selections all titled "Plumbing fixtures" would be unusable. */
    const title = g.scope === "room" ? `${g.room} — ${g.label}`
      : g.scope === "item" ? primary.desc
        : g.label;

    return {
      id: g.id,
      type: g.type,
      label: g.label,
      scope: g.scope,
      order: g.order,
      room: g.room,
      roomKey: g.roomKey,
      rooms,
      where,
      title,
      items,
      desc: primary.desc,
      cat: primary.cat,
      sel: primary.sel,
      qty: primary.qty,
      unit: primary.unit,
      lkqUnitCost: primary.unitCost,
      lkqTotal: round(items.reduce((s, it) => s + it.amount, 0)),
      waste: primary.waste,
      lineNos: g.lines.map((l) => l.no),
      lines: g.lines,
    };
  });

  selections.sort((a, b) =>
    (a.order - b.order) || String(a.room || "").localeCompare(String(b.room || "")) || a.id.localeCompare(b.id));

  const rooms = [];
  for (const l of lines) if (l.room && !rooms.includes(l.room)) rooms.push(l.room);

  return {
    selections,
    scopeOnly,
    rooms,
    totals: {
      lineCount: lines.length,
      selectionCount: selections.length,
      selectionValue: round(selections.reduce((s, x) => s + x.lkqTotal, 0)),
      scopeValue: round(scopeOnly.reduce((s, l) => s + l.amount, 0)),
      estimateValue: round(lines.reduce((s, l) => s + l.amount, 0)),
    },
  };
}

/* ---------- end to end ---------- */

/* Read an Xactimate "Export to Excel" file and return the selection sheet.
   `input` is an ArrayBuffer / Uint8Array / Node Buffer. */
export async function selectionSheetFromXlsx(input) {
  const wb = await readXlsx(input);
  if (!wb.sheets.length) throw new Error("workbook has no sheets");
  const { headers, rows } = asRecords(wb.sheets[0]);
  if (!headers.includes("Cat") || !headers.includes("Sel") || !headers.includes("Unit Cost")) {
    throw new Error(
      "this does not look like an Xactimate estimate export — expected Cat, Sel and Unit Cost columns, got: " +
      headers.filter(Boolean).join(", "));
  }
  const lines = normalizeLines(rows);
  if (!lines.length) throw new Error("no line items found in the export");
  return { ...buildSelectionSheet(lines), headers, lines };
}
