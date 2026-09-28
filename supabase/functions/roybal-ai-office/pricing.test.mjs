/* Line-item pricing — the pure half (no Deno, no network).
   Run: node --experimental-strip-types pricing.test.mjs
   Every code, description and price here is INVENTED (ZZZ / TST*): the repo is
   public, and the real reference data never enters it. */
import assert from "node:assert/strict";
import {
  normUnit, resolveLines, referenceTextFromRows, referenceAllowed, refPrice, refNote, estimatingRules, auditCodeRule,
  catalogTextFromRows, fetchAllPages, REFERENCE_HEADER, REFERENCE_PRIVATE, kindOfFacts,
} from "./pricing.ts";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- fixtures (synthetic) ---------- */
const cat = (code, over = {}) => ({
  category: "ZZZ", code, description: `Test catalog row ${code}`, unit: "SF",
  replace_price: 2.5, remove_price: 1.25, detach_reset_price: null, ...over,
});
const ref = (code, activity, over = {}) => ({
  category: "ZZZ", code, activity, unit: "SF", description: `Test reference row ${code}`,
  n_lines: 4, n_estimates: 3, median: 7.1, min: 6, max: 8.4, latest_median: 7.5, latest_price_list: "TESTLIST_JAN26", ...over,
});
const line = (over = {}) => ({ room: "Test Room", desc: "test line", qty: 10, unit: "SF", price: 1, basis: "test", category: "ZZZ", code: "TST1", priceBasis: "replace", ...over });
const CLAIM = { mode: "piecework", kind: "claim" };
const one = (items, catalog, refs, opts = CLAIM) => resolveLines([items], catalog, refs, opts)[0];

/* ---------- normUnit ---------- */
test("normUnit folds case, whitespace and the common aliases", () => {
  assert.equal(normUnit(" sf "), "SF");
  assert.equal(normUnit("SQ FT"), "SF");
  assert.equal(normUnit("sqft"), "SF");
  assert.equal(normUnit("Sq. Ft."), "SF");
  assert.equal(normUnit("DAY"), "DA");
  assert.equal(normUnit("days"), "DA");
  assert.equal(normUnit("each"), "EA");
  assert.equal(normUnit("HRS"), "HR");
  assert.equal(normUnit("Hour"), "HR");
  assert.equal(normUnit("LF"), "LF");
  assert.equal(normUnit(""), "");
  assert.equal(normUnit(null), "");
  assert.equal(normUnit("constructor"), "CONSTRUCTOR");      // own-property lookup only
});

/* ---------- the tiers ---------- */
test("catalog beats reference: a catalog hit is stamped from the sheet even when a reference row exists", () => {
  const r = one(line(), [cat("TST1")], [ref("TST1", "Replace")]);
  assert.equal(r.priced, "catalog");
  assert.equal(r.price, 2.5);
  assert.equal(r.catalogDesc, "Test catalog row TST1");
  assert.equal(r.refNote, undefined);
  assert.equal(r.priceBasis, undefined);                    // priceBasis never leaks onto the line
});

test("the reference tier prices a catalog miss on a piecework claim", () => {
  const r = one(line({ code: "TST2" }), [cat("TST1")], [ref("TST2", "Replace")]);
  assert.equal(r.priced, "reference");
  assert.equal(r.price, 7.5);                               // latest_median wins over median
  assert.equal(r.code, "TST2");
  assert.equal(r.catalogDesc, "Test reference row TST2");
  assert.equal(r.unit, "SF");
  assert.equal(r.room, "Test Room");
});

test("a catalog row with an empty needed column falls through to the reference tier", () => {
  const r = one(line({ priceBasis: "detach_reset" }), [cat("TST1")], [ref("TST1", "D&R", { latest_median: 3.3 })]);
  assert.equal(r.priced, "reference");
  assert.equal(r.price, 3.3);
  const zero = one(line({ priceBasis: "remove" }), [cat("TST1", { remove_price: 0 })], [ref("TST1", "Remove", { latest_median: 0.9 })]);
  assert.equal(zero.priced, "reference");
  assert.equal(zero.price, 0.9);
});

test("reference is used only on piecework + claim: never T&M, never construction, never unknown", () => {
  assert.equal(referenceAllowed(CLAIM), true);
  for (const opts of [
    { mode: "tm", kind: "claim" },
    { mode: "piecework", kind: "construction" },
    { mode: "piecework", kind: "unknown" },
    { mode: "piecework" },
    { mode: "tm", kind: "construction" },
  ]) {
    assert.equal(referenceAllowed(opts), false, JSON.stringify(opts));
    const r = one(line({ code: "TST2" }), [], [ref("TST2", "Replace")], opts);
    assert.equal(r.priced, "estimate", JSON.stringify(opts));
    assert.equal(r.price, 1, "the model's own number stands");
    assert.equal(r.refNote, undefined);
  }
  assert.equal(referenceAllowed(undefined), false);
});

test("kindOfFacts: construction stays construction, any other job type is a claim, no job type is unknown", () => {
  assert.equal(kindOfFacts({ job: { jobType: "construction" } }), "construction");
  assert.equal(kindOfFacts({ job: { jobType: "restoration" } }), "claim");
  // a client older than v192 sends no jobType on the invoice / rebuild facts:
  // unknown, so neither the reference tier nor the claim house patterns apply
  for (const f of [{ job: {} }, { job: { jobType: "" } }, {}, null, undefined, { job: { jobType: 7 } }]) {
    assert.equal(kindOfFacts(f), "unknown", JSON.stringify(f));
    assert.equal(referenceAllowed({ mode: "piecework", kind: kindOfFacts(f) }), false);
  }
  assert.equal(referenceAllowed({ mode: "piecework", kind: kindOfFacts({ job: { jobType: "construction" } }) }), false);
  assert.equal(referenceAllowed({ mode: "piecework", kind: kindOfFacts({ job: { jobType: "restoration" } }) }), true);
});

test("no reference row, or no rows at all, leaves the line an estimate as before", () => {
  assert.equal(one(line({ code: "NOPE" }), [], [ref("TST2", "Replace")]).priced, "estimate");
  assert.equal(one(line({ code: "NOPE" }), [], []).priced, "estimate");
  assert.equal(one(line({ code: "NOPE" }), [], undefined).priced, "estimate");
  // a reference row with no usable price is a miss, not a $0 line
  const r = one(line({ code: "TST2" }), [], [ref("TST2", "Replace", { latest_median: null, median: 0 })]);
  assert.equal(r.priced, "estimate");
  // median stands in when the latest price list has none
  assert.equal(one(line({ code: "TST2" }), [], [ref("TST2", "Replace", { latest_median: null, median: 7.1 })]).price, 7.1);
});

test("priceBasis maps to the activity: replace→Replace, remove→Remove, detach_reset→D&R, labor→Replace (HR)", () => {
  const refs = [
    ref("TST3", "Replace", { latest_median: 10 }),
    ref("TST3", "Remove", { latest_median: 2 }),
    ref("TST3", "D&R", { latest_median: 5 }),
    ref("TST3", "R&R", { latest_median: 99 }),
    ref("TST4", "Replace", { unit: "HR", latest_median: 60 }),
  ];
  const at = (basis, over = {}) => one(line({ code: "TST3", priceBasis: basis, ...over }), [], refs);
  assert.equal(at("replace").price, 10);
  assert.equal(at("remove").price, 2);
  assert.equal(at("detach_reset").price, 5);
  const lab = one(line({ code: "TST4", priceBasis: "labor", unit: "HR" }), [], refs);
  assert.equal(lab.priced, "reference");
  assert.equal(lab.price, 60);
  // 'estimate', a missing basis and an empty code never look anything up
  assert.equal(at("estimate").priced, "estimate");
  assert.equal(at(undefined).priced, "estimate");
  assert.equal(one(line({ code: "", priceBasis: "replace" }), [], refs).priced, "estimate");
  assert.equal(one(line({ category: "", priceBasis: "replace" }), [], refs).priced, "estimate");
});

test("the labor guardrail runs BEFORE the reference tier: labor on an SF line is flagged with no price", () => {
  const refs = [ref("TST4", "Replace", { unit: "HR", latest_median: 60 })];
  const r = one(line({ code: "TST4", priceBasis: "labor", unit: "SF", qty: 500 }), [], refs);
  assert.equal(r.priced, "flag");
  assert.equal(r.price, undefined);
  assert.match(r.priceFlag, /^TST4 is an hourly labor rate \(\$60\.00\/HR\) — bill this as HR × crew-hours, not per SF$/);
  // the catalog path keeps its guardrail (same message pattern)
  const c = one(line({ code: "TST5", priceBasis: "labor", unit: "LF" }), [cat("TST5", { unit: "HR", replace_price: 50 })], refs);
  assert.equal(c.priced, "flag");
  assert.equal(c.price, undefined);
  assert.equal(c.priceFlag, "TST5 is an hourly labor rate ($50.00/HR) — bill this as HR × crew-hours, not per LF");
  // "hours" is an HR line, so it prices
  assert.equal(one(line({ code: "TST5", priceBasis: "labor", unit: "Hours" }), [cat("TST5", { unit: "HR", replace_price: 50 })], []).priced, "catalog");
});

test("a unit mismatch flags on the catalog path and misses on the reference path", () => {
  const c = one(line({ unit: "LF" }), [cat("TST1", { unit: "SF" })], []);
  assert.equal(c.priced, "flag");
  assert.equal(c.price, undefined);
  assert.equal(c.code, "TST1");
  assert.equal(c.priceFlag, "TST1 is priced per SF; this line is per LF — fix the unit or quantity");
  // spelling differences are not a mismatch
  assert.equal(one(line({ unit: "sq ft" }), [cat("TST1", { unit: "SF" })], []).priced, "catalog");
  assert.equal(one(line({ unit: "Days" }), [cat("TST1", { unit: "DA" })], []).priced, "catalog");
  // a line with no unit takes the row's unit (unchanged behavior)
  const bare = one(line({ unit: "" }), [cat("TST1", { unit: "SF" })], []);
  assert.equal(bare.priced, "catalog");
  assert.equal(bare.unit, "SF");
  // the reference tier matches the unit exactly (after normUnit) — a mismatch is a miss
  assert.equal(one(line({ code: "TST2", unit: "LF" }), [], [ref("TST2", "Replace", { unit: "SF" })]).priced, "estimate");
  assert.equal(one(line({ code: "TST2", unit: "sq ft" }), [], [ref("TST2", "Replace", { unit: "SF" })]).priced, "reference");
});

test("the reference note carries the counts, the price list and the range, and asks for review", () => {
  const r = one(line({ code: "TST2" }), [], [ref("TST2", "Replace")]);
  assert.equal(r.refNote, "Xactimate reference from your past estimates: 4 line(s) on 3 estimate(s), TESTLIST_JAN26, range $6.00–$8.40 — review");
  assert.equal(refNote(ref("TST2", "Replace", { latest_price_list: "", min: null })),
    "Xactimate reference from your past estimates: 4 line(s) on 3 estimate(s) — review");
  assert.equal(refPrice(ref("X", "Replace", { latest_median: "7.25" })), 7.25);   // numeric strings from the API coerce
});

test("resolveLines keeps every line in order and never mutates its input", () => {
  const items = [line(), line({ code: "TST2" }), line({ code: "NOPE" })];
  const snapshot = JSON.stringify(items);
  const out = resolveLines(items, [cat("TST1")], [ref("TST2", "Replace")], CLAIM);
  assert.deepEqual(out.map((i) => i.priced), ["catalog", "reference", "estimate"]);
  assert.equal(JSON.stringify(items), snapshot);
  assert.deepEqual(resolveLines(null, [], [], CLAIM), []);
});

/* ---------- the prompt block ---------- */
test("referenceTextFromRows lists reference codes the catalog does not carry, Replace/Remove/D&R only", () => {
  const t = referenceTextFromRows([
    ref("TST1", "Replace"),                               // in the catalog → out
    ref("TST2", "Remove", { latest_median: 1.5, n_estimates: 2 }),
    ref("TST2", "Replace", { latest_median: 4, n_estimates: 5 }),
    ref("TST6", "R&R"),                                   // can't map to one priceBasis → out
    ref("TST7", ""),                                      // unknown activity → out
    ref("TST8", "D&R", { unit: "EA", latest_median: 12, description: "Test  reset\nrow" }),
    ref("TST9", "Replace", { latest_median: null, median: null }),   // no price → out
  ], [cat("TST1")]);
  const lines = t.split("\n");
  assert.equal(lines[0], REFERENCE_HEADER);
  assert.ok(lines[0].startsWith("XACTIMATE REFERENCE CODES — from Roybal's own past Xactimate estimates. Use one ONLY when no PRICE CATALOG row fits"));
  const rows = lines.filter((l) => /^ZZZ /.test(l));
  assert.deepEqual(rows, [
    "ZZZ TST2 | Test reference row TST2 | SF | Replace | ref $4.00 (5 est)",
    "ZZZ TST2 | Test reference row TST2 | SF | Remove | ref $1.50 (2 est)",
    "ZZZ TST8 | Test reset row | EA | D&R | ref $12.00 (3 est)",
  ]);
  assert.ok(!t.includes("TST1") && !t.includes("TST6") && !t.includes("TST7") && !t.includes("TST9"));
  assert.ok(!t.includes("CONSTRUCTION ESTIMATE"));
  // the block tells the model to keep the private source out of customer prose
  assert.ok(lines.includes(REFERENCE_PRIVATE));
  assert.match(REFERENCE_PRIVATE, /never mention/);
  for (const f of ["lossSummary", "pricingNotes", "assumptions", "exclusions"]) assert.ok(REFERENCE_PRIVATE.includes(f), f);
});

test("referenceTextFromRows returns '' (no header) when there is nothing to offer", () => {
  assert.equal(referenceTextFromRows([], []), "");
  assert.equal(referenceTextFromRows(undefined, undefined), "");
  assert.equal(referenceTextFromRows([ref("TST1", "Replace")], [cat("TST1")]), "");
  assert.equal(referenceTextFromRows([ref("TST6", "R&R")], []), "");
});

/* ---------- the estimating rules ---------- */
test("the house-pattern blocks exist and carry no prices, codes or job names", () => {
  for (const pm of ["piecework", "tm"]) {
    const r = estimatingRules(pm);
    assert.match(r.houseMitigation, /^ROYBAL HOUSE PATTERNS — MITIGATION/);
    assert.match(r.houseRestoration, /^ROYBAL HOUSE PATTERNS — RESTORATION \/ PUT-BACK/);
    for (const k of ["houseMitigation", "houseRestoration"]) {
      const t = r[k];
      assert.ok(t.endsWith("\n"), k + " ends its block");
      assert.ok(!t.includes("$"), k + " has a $");
      assert.doesNotMatch(t, /\d+\.\d{2}\b/, k + " has a decimal price");
      assert.doesNotMatch(t, /\bE-?\d{3,}\b/, k + " has an estimate number");
      assert.doesNotMatch(t, /\bthe [A-Z][a-z]+ (job|house|home|loss|estimate)\b/, k + " names a job");
      assert.doesNotMatch(t, /\b(Mr|Mrs|Ms)\.? [A-Z]/, k + " names a person");
      assert.ok(!t.includes("|"), k + " carries a catalog-style code line");
    }
  }
  const r = estimatingRules("piecework");
  assert.match(r.houseMitigation, /REMOVE ONLY/);
  assert.match(r.houseRestoration, /Baseboard is the item most often missed/);
});

test("the code rule names the reference tier only when the block is in the prompt", () => {
  const plain = estimatingRules("piecework").pricingRules;
  const withRef = estimatingRules("piecework", { reference: true }).pricingRules;
  assert.ok(!plain.includes("XACTIMATE REFERENCE"));
  assert.ok(withRef.includes("XACTIMATE REFERENCE"));
  // three tiers, in order: catalog, reference, estimate
  const iCat = withRef.indexOf("PRICE CATALOG"), iRef = withRef.indexOf("XACTIMATE REFERENCE"), iEst = withRef.indexOf('priceBasis="estimate"');
  assert.ok(iCat >= 0 && iRef > iCat && iEst > iRef, "catalog → reference → estimate");
  // T&M never mentions it (no reference in T&M)
  assert.ok(!estimatingRules("tm", { reference: true }).pricingRules.includes("XACTIMATE REFERENCE"));
  assert.ok(!auditCodeRule(false).includes("XACTIMATE REFERENCE"));
  assert.ok(auditCodeRule(true).includes("XACTIMATE REFERENCE"));
});

test("catalogTextFromRows: T&M sends only LAB hourly rates; piecework drops $0 placeholders", () => {
  const rows = [
    cat("TST1"),
    cat("TST2", { replace_price: 0, remove_price: null }),
    { category: "LAB", code: "TSTL", description: "Test labor", unit: "HR", replace_price: 40, remove_price: null, detach_reset_price: null },
  ];
  const pw = catalogTextFromRows(rows, "piecework").split("\n");
  assert.deepEqual(pw, [
    "ZZZ TST1 | Test catalog row TST1 | SF | replace $2.50 | tear-out $1.25",
    "LAB TSTL | Test labor | HR | replace $40.00",
  ]);
  const tm = catalogTextFromRows(rows, "tm");
  assert.ok(tm.startsWith("LABOR RATES — category LAB"));
  assert.ok(tm.includes("LAB TSTL | Test labor | HR | $40.00"));
  assert.ok(!tm.includes("TST1"));
});

/* ---------- paging ---------- */
const pager = (total, { failAt = -1, status416At = -1 } = {}) => {
  const calls = [];
  const get = async (from, to) => {
    calls.push([from, to]);
    if (calls.length - 1 === failAt) return { ok: false, status: 500, rows: [] };
    if (from >= total && status416At >= 0) return { ok: false, status: 416, rows: [] };
    const rows = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i);
    return { ok: true, status: 206, rows };
  };
  return { calls, get };
};

test("fetchAllPages reads past the 1000-row cap and stops on the short page", async () => {
  const p = pager(2345);
  const rows = await fetchAllPages(p.get);
  assert.equal(rows.length, 2345);
  assert.deepEqual(p.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(rows[1000], 1000);
});

test("fetchAllPages stops on a 416 (ranged past the end) and on an exact multiple's empty page", async () => {
  const exact = pager(2000, { status416At: 0 });
  assert.equal((await fetchAllPages(exact.get)).length, 2000);
  assert.deepEqual(exact.calls.map((c) => c[0]), [0, 1000, 2000]);
  const empty = pager(1000);
  assert.equal((await fetchAllPages(empty.get)).length, 1000);
  assert.equal(empty.calls.length, 2);
  assert.deepEqual(await fetchAllPages(pager(0).get), []);
});

test("fetchAllPages throws on a failed page (the caller turns that into fail-soft [])", async () => {
  await assert.rejects(fetchAllPages(pager(5000, { failAt: 1 }).get), /read failed \(500\)/);
  // bounded: never more than maxPages requests
  const endless = { calls: 0, get: async () => { endless.calls++; return { ok: true, status: 206, rows: new Array(10).fill(0) }; } };
  assert.equal((await fetchAllPages(endless.get, 10, 3)).length, 30);
  assert.equal(endless.calls, 3);
});

for (const [name, fn] of tests) {
  await fn();
  console.log("  ✓ " + name);
  pass++;
}
console.log(`\n${pass} pricing tests passed`);
