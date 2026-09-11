/* Tech identity (Step E) — pure-logic test. No DOM, no network.
   Covers stored-identity parsing, captured_by precedence, and mapping the
   Board crew_members rows into the picker roster.
   Run: node apps/field/test/tech.test.mjs   (from repo root) */
import assert from "node:assert";
import { parseTech, resolveCapturedBy, rosterFromRows } from "../js/tech.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Tech identity");

/* ---------- parseTech: JSON shape + legacy plain string ---------- */
ok("parses {id,name} JSON", (() => { const t = parseTech(JSON.stringify({ id: "c1", name: "Branden" })); return t.id === "c1" && t.name === "Branden"; })());
ok("parses a legacy plain name string", (() => { const t = parseTech("Mike"); return t.id === null && t.name === "Mike"; })());
ok("trims the stored name", parseTech(JSON.stringify({ name: "  Jake  " })).name === "Jake");
ok("empty / blank -> null", parseTech("") === null && parseTech(JSON.stringify({ name: "" })) === null && parseTech(null) === null);

/* ---------- resolveCapturedBy: tech name, else email, else null ---------- */
ok("prefers the chosen tech name", resolveCapturedBy("Branden", "tech@x.com") === "Branden");
ok("falls back to email when no tech", resolveCapturedBy("", "tech@x.com") === "tech@x.com");
ok("null when neither is set", resolveCapturedBy("", "") === null);
ok("blank tech name falls through to email", resolveCapturedBy("   ", "tech@x.com") === "tech@x.com");

/* ---------- rosterFromRows: Board crew_members rows -> roster ---------- */
const rows = [
  { data: { id: "c2", name: "Sam", color: "#0a0", active: true } },
  { data: { id: "c1", name: "Alex", color: "#00a" } },                 // active omitted -> included
  { data: { id: "c3", name: "Zed", active: false } },                  // inactive -> excluded
  { data: { id: "c4", name: "", color: "#a00" } },                     // no name -> excluded
  { data: null },                                                       // junk -> excluded
];
const roster = rosterFromRows(rows);
ok("excludes inactive + nameless + junk", roster.length === 2);
ok("sorted by name (Alex before Sam)", roster[0].name === "Alex" && roster[1].name === "Sam");
ok("carries id and color", roster[0].id === "c1" && roster[0].color === "#00a");
ok("tolerates flat rows (no .data wrapper)", rosterFromRows([{ id: "x", name: "Pat" }])[0].name === "Pat");
ok("non-array input -> []", Array.isArray(rosterFromRows(null)) && rosterFromRows(null).length === 0);

console.log(`\n${pass} checks passed.`);
