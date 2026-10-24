/* The server's merge must know every collection the field app's merge does.
   merge.js ID_COLLECTIONS has two SQL twins: merge_project_blobs (the merge
   push_project runs when two devices' copies differ) and _mf_sweep_tombstones
   (the tombstone sweep on every push). A collection missing from either one
   is treated as a plain value by the server — the newer copy wins whole, and
   another device's elements are dropped. merge.test.mjs only checks the JS
   side, so nothing caught a new collection the SQL never heard of.

   This reads the NEWEST migration that defines each function (the one the
   database actually runs) and holds its id_cols to ID_COLLECTIONS, and
   merge_project_blobs' form_slots to FORM_SLOTS. It also holds migration
   0022's equipment rules to scans.js: the fleet table's type list to
   TYPE_LABELS, the doors' prefix defaults to TAG_PREFIXES, and the SQL
   equipment_tag_key cases in supabase/test/equipment_scan.test.sql to
   tagKey() (the replay runs the same cases through the SQL function).
   Run: node --test test/merge-sql-parity.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ID_COLLECTIONS, FORM_SLOTS } from "../js/merge.js";
import { TAG_PREFIXES, TYPE_LABELS, tagKey } from "../js/scans.js";

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);
const SQL_TEST = new URL("../../../supabase/test/equipment_scan.test.sql", import.meta.url);

const migrations = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, MIGRATIONS), "utf8") }));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The body ($$…$$, or $tag$…$tag$) of the last CREATE FUNCTION public.<name>
   in the newest migration that has one. */
function newestDefinition(name) {
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+"?public"?\\."?${escapeRe(name)}"?\\s*\\(`, "gi");
  for (let i = migrations.length - 1; i >= 0; i--) {
    const { name: file, sql } = migrations[i];
    const starts = [...sql.matchAll(head)].map((m) => m.index);
    if (!starts.length) continue;
    const from = starts[starts.length - 1];
    const open = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(sql.slice(from));
    assert.ok(open, `${file}: no $$ body after CREATE FUNCTION ${name}`);
    const bodyStart = from + open.index + open[0].length;
    const bodyEnd = sql.indexOf(open[1], bodyStart);
    assert.ok(bodyEnd > bodyStart, `${file}: the body of ${name} never closes`);
    return { file, body: sql.slice(bodyStart, bodyEnd) };
  }
  assert.fail(`no migration defines public.${name}`);
}

/* The quoted names in `<variable> text[] := array[ … ]`. */
function textArray(body, variable, where) {
  const m = new RegExp(`\\b${variable}\\s+text\\[\\]\\s*:=\\s*array\\s*\\[([^\\]]*)\\]`, "i").exec(body);
  assert.ok(m, `${where}: no ${variable} text[] := array[…]`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const sorted = (a) => [...a].sort();
const dupes = (a) => a.filter((x, i) => a.indexOf(x) !== i);

for (const fn of ["merge_project_blobs", "_mf_sweep_tombstones"]) {
  test(`${fn}: id_cols is merge.js ID_COLLECTIONS`, () => {
    const { file, body } = newestDefinition(fn);
    const cols = textArray(body, "id_cols", `${file} ${fn}`);
    assert.deepEqual(dupes(cols), [], `${file} ${fn}: id_cols lists a name twice`);
    assert.deepEqual(sorted(cols), sorted(ID_COLLECTIONS),
      `${file} ${fn}: id_cols differs from ID_COLLECTIONS — add the missing name to both, in a new migration`);
  });
}

test("merge_project_blobs: form_slots is merge.js FORM_SLOTS", () => {
  const { file, body } = newestDefinition("merge_project_blobs");
  assert.deepEqual(sorted(textArray(body, "form_slots", `${file} merge_project_blobs`)), sorted(FORM_SLOTS));
});

test("the scan log is a collection on both sides (a failing parse can't pass this file)", () => {
  assert.ok(ID_COLLECTIONS.includes("equipmentScans"));
  for (const fn of ["merge_project_blobs", "_mf_sweep_tombstones"]) {
    const { body } = newestDefinition(fn);
    assert.ok(textArray(body, "id_cols", fn).includes("equipmentScans"), `${fn} does not list equipmentScans`);
  }
});

/* ---------- migration 0022's equipment rules ---------- */
function eqMigration() {
  const m = [...migrations].reverse().find((x) => /create\s+table\s+if\s+not\s+exists\s+public\.equipment_units\b/i.test(x.sql));
  assert.ok(m, "no migration creates public.equipment_units");
  return m;
}

test("equipment_units: the type check list is scans.js TYPE_LABELS", () => {
  const { name, sql } = eqMigration();
  const table = /create\s+table\s+if\s+not\s+exists\s+public\.equipment_units\s*\(([\s\S]*?)\n\);/i.exec(sql);
  assert.ok(table, `${name}: equipment_units has no column list`);
  const check = /check\s*\(\s*type\s+in\s*\(([^)]*)\)/i.exec(table[1]);
  assert.ok(check, `${name}: equipment_units.type has no check list`);
  const types = [...check[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.deepEqual(sorted(types), sorted(Object.keys(TYPE_LABELS)));
});

test("the two doors default a type from the prefix exactly as TAG_PREFIXES", () => {
  for (const fn of ["equipment_unit_save", "equipment_units_add_range"]) {
    const { file, body } = newestDefinition(fn);
    const pairs = Object.fromEntries([...body.matchAll(/when\s+'([A-Z]{2})'\s+then\s+'([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(pairs, TAG_PREFIXES, `${file} ${fn}: prefix defaults differ from TAG_PREFIXES`);
  }
});

/* One SQL literal: null, '…' ('' is a quote) or E'…' (backslash escapes). */
function sqlLiterals(line) {
  const out = [];
  const re = /\bnull\b|([Ee]?)'((?:[^'\\]|''|\\.)*)'/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[0].toLowerCase() === "null") { out.push(null); continue; }
    let s = m[2].replace(/''/g, "'");
    if (m[1]) {
      s = s.replace(/\\(u[0-9a-fA-F]{4}|t|n|r|\\|')/g, (_, e) =>
        e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16))
          : { t: "\t", n: "\n", r: "\r", "\\": "\\", "'": "'" }[e]);
    }
    out.push(s);
  }
  return out;
}

test("equipment_tag_key and tagKey() agree on every case the SQL test checks", () => {
  const src = readFileSync(SQL_TEST, "utf8");
  const begin = src.indexOf("-- tag-key cases: begin");
  const end = src.indexOf("-- tag-key cases: end");
  assert.ok(begin > 0 && end > begin, "equipment_scan.test.sql has lost its tag-key case markers");
  const cases = src.slice(begin, end).split("\n")
    .filter((l) => /^\s*\(/.test(l))
    .map((l) => sqlLiterals(l));
  assert.ok(cases.length >= 20, `only ${cases.length} tag-key cases parsed`);
  for (const c of cases) {
    assert.equal(c.length, 2, `a case line is not (input, key): ${JSON.stringify(c)}`);
    const [input, want] = c;
    assert.equal(tagKey(input), want, `tagKey(${JSON.stringify(input)})`);
  }
  // the parse itself: an E'' escape and a null both came through
  assert.ok(cases.some(([i]) => i === "AM−014"), "the \\u2212 case did not decode");
  assert.ok(cases.some(([i]) => i === null), "the null case did not parse");
});
