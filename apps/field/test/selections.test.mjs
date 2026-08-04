/* Publishing a selection sheet to portal_selections. The thing worth
   protecting here is the customer's answer: a revised estimate must update
   decisions in place, never silently drop what they already chose.
   Run: node apps/field/test/selections.test.mjs */
import assert from "node:assert";
import { selectionRows, mergeSelectionRows, selectionSummary, stepWarning, publishSelections } from "../js/selections.js";
import { buildSelectionSheet, normalizeLines } from "../js/xactimate.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, `${name}\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`); console.log("  ✓ " + name); pass++; };

console.log("Customer selections — office publish");

const REC = (o) => ({
  Excluded: "False", "#": "", "Group Code": "", "Group Description": "", Desc: "",
  Qty: "", "Item Amount": "", Unit: "", "Unit Cost": "", RCV: "", ACV: "",
  Life: "", Recoverable: "Yes", Cat: "", Sel: "", "Note 1": "", ...o,
});

const carpet = (amount, unitCost) => REC({
  "#": 1, "Group Code": "LIVING_ROOM", "Group Description": "Living Room", Desc: "Carpet",
  Qty: "296.85", Unit: "SF", "Unit Cost": String(unitCost), "Item Amount": String(amount),
  Cat: "FCC", Sel: "AV", "Note 1": "15 % waste added for Carpet." });
const toilet = REC({
  "#": 2, "Group Code": "BATHROOM", "Group Description": "Bathroom", Desc: "Toilet",
  Qty: "1", Unit: "EA", "Unit Cost": "313.77", "Item Amount": "313.77", Cat: "PLM", Sel: "TLT" });
const demo = REC({
  "#": 3, "Group Code": "MAIN_LEVEL", "Group Description": "Main Level", Desc: "Haul debris",
  Qty: "1", Unit: "EA", "Unit Cost": "253.82", "Item Amount": "253.82", Cat: "DMO", Sel: "PU" });

const sheetOf = (recs) => buildSelectionSheet(normalizeLines(recs));

/* ============================================================
   1. Rows map to the table
   ============================================================ */
console.log("\n selectionRows");

const sheet = sheetOf([carpet(1326.92, 4.47), toilet, demo]);
const rows = selectionRows("job-1", sheet);

eq("one row per decision, scope lines excluded", rows.length, 2);
ok("every row is bound to the portal job", rows.every((r) => r.portal_job_id === "job-1"));
ok("column names are snake_case for PostgREST",
  Object.keys(rows[0]).every((k) => !/[A-Z]/.test(k)));

const floor = rows.find((r) => r.type === "flooring");
eq("carries the deterministic id", floor.selection_id, "flooring--living-room");
eq("carries the LKQ baseline off the estimate", floor.lkq_total, 1326.92);
eq("and the unit cost", floor.lkq_unit_cost, 4.47);
eq("and the waste factor", floor.waste_pct, 15);
eq("descr avoids the reserved word 'desc'", floor.descr, "Carpet");
ok("keeps the per-item rollup", Array.isArray(floor.items) && floor.items.length === 1);
eq("sort order follows the sheet", rows.map((r) => r.sort_order), [0, 1]);

ok("a sheet with no decisions yields no rows", selectionRows("job-1", sheetOf([demo])).length === 0);
assert.throws(() => selectionRows("", sheet), /no portal job id/,
  "refuses to build rows without a portal job");
console.log("  ✓ refuses to build rows without a portal job"); pass++;

/* ============================================================
   2. Re-import must not lose the customer's answer
   ============================================================ */
console.log("\n mergeSelectionRows — re-importing a revised estimate");

const answered = [
  { selection_id: "flooring--living-room", title: "Living Room — Flooring", lkq_total: 1326.92,
    chosen_option_id: "lifeproof-sterling-oak", chosen_label: "LifeProof Sterling Oak",
    delta_cents: 72200, chosen_at: "2026-07-30T18:00:00Z" },
  { selection_id: "fixtures--plm-tlt", title: "Toilet", lkq_total: 313.77,
    chosen_option_id: null, chosen_label: null, delta_cents: 0, chosen_at: null },
];

const same = mergeSelectionRows(selectionRows("job-1", sheet), answered);
const keptFloor = same.rows.find((r) => r.selection_id === "flooring--living-room");
eq("the customer's pick survives a re-import", keptFloor.chosen_option_id, "lifeproof-sterling-oak");
eq("so does the label they saw", keptFloor.chosen_label, "LifeProof Sterling Oak");
eq("so does what they owe", keptFloor.delta_cents, 72200);
eq("and when they chose it", keptFloor.chosen_at, "2026-07-30T18:00:00Z");
eq("an unanswered decision stays unanswered",
  same.rows.find((r) => r.selection_id === "fixtures--plm-tlt").chosen_option_id, undefined);
eq("nothing removed when the estimate is unchanged", same.removed.length, 0);
eq("nothing repriced when the estimate is unchanged", same.repriced.length, 0);

/* The dangerous case: the estimate was revised and the baseline moved under
   an answer the customer already gave. Their delta is now stale. */
const revised = mergeSelectionRows(
  selectionRows("job-1", sheetOf([carpet(1500.00, 5.05), toilet, demo])), answered);
eq("a moved baseline on an ANSWERED decision is reported", revised.repriced.length, 1);
eq("with both numbers, so the office can see the gap",
  { was: revised.repriced[0].was, now: revised.repriced[0].now }, { was: 1326.92, now: 1500 });
eq("the pick is still kept, not thrown away",
  revised.rows.find((r) => r.selection_id === "flooring--living-room").chosen_option_id,
  "lifeproof-sterling-oak");

/* A baseline that moves on an UNanswered decision is just an update. */
const unanswered = mergeSelectionRows(
  selectionRows("job-1", sheetOf([carpet(1500.00, 5.05), toilet, demo])),
  [{ selection_id: "flooring--living-room", lkq_total: 1326.92, chosen_option_id: null }]);
eq("a moved baseline on an unanswered decision is not flagged", unanswered.repriced.length, 0);

/* A decision that disappeared from the revised estimate. */
const shrunk = mergeSelectionRows(selectionRows("job-1", sheetOf([toilet, demo])), answered);
eq("a decision dropped from the estimate is reported for deletion", shrunk.removed.length, 1);
eq("named, so the office knows which", shrunk.removed[0].selection_id, "flooring--living-room");
ok("and flagged when the customer had already answered it", shrunk.removed[0].wasChosen === true);
ok("the surviving decision is still published",
  shrunk.rows.some((r) => r.selection_id === "fixtures--plm-tlt"));

eq("no prior rows is a clean first publish",
  mergeSelectionRows(selectionRows("job-1", sheet), []).removed.length, 0);
eq("undefined prior rows does not throw",
  mergeSelectionRows(selectionRows("job-1", sheet), undefined).rows.length, 2);

/* ============================================================
   3. Summary shown to the office before publishing
   ============================================================ */
console.log("\n selectionSummary");

const sum = selectionSummary(sheet);
eq("counts decisions", sum.decisions, 2);
eq("separates customer-visible value from scope", sum.selectionValue, 1640.69);
eq("scope value is the rest", sum.scopeValue, 253.82);
ok("and the two reconcile to the estimate",
  Math.round((sum.selectionValue + sum.scopeValue) * 100) === Math.round(sum.estimateValue * 100));
eq("reports how many lines were read", sum.lineCount, 3);
eq("an empty sheet summarises to zeroes", selectionSummary({}).decisions, 0);

/* ============================================================
   4. publishSelections must not swallow a half-failure
   The original bug: `rest()` resolves for 4xx as well as 2xx, so a bare
   .catch() on it could never fire and the stamp failed silently — the office
   saw "Published 39 decisions" while the job row recorded nothing.
   ============================================================ */
console.log("\n stepWarning — a half-failed publish must not look like a clean one");

/* The bug this encodes: supa.js's rest() RESOLVES for 4xx/5xx, so a bare
   `.catch()` on it never fires. A 404 stamp was swallowed and the office was
   told "Published 39 decisions" while the job row recorded nothing. */
eq("a 2xx is silent", stepWarning("Stamp failed", { ok: true, status: 204 }, null), null);

ok("a NON-OK response is reported even though it never threw",
  stepWarning("Stamp failed", { ok: false, status: 404 }, null) !== null);
ok("a 404 suggests the likely cause",
  /published to the portal first/.test(stepWarning("Stamp failed", { ok: false, status: 404 }, null)));
ok("a 401 suggests re-auth instead",
  /sign in again/.test(stepWarning("Stamp failed", { ok: false, status: 401 }, null)));
ok("a 500 carries the status without a misleading hint", (() => {
  const w = stepWarning("Stamp failed", { ok: false, status: 500 }, null);
  return /HTTP 500/.test(w) && !/portal first|sign in/.test(w);
})());
ok("a thrown error is reported too",
  /boom/.test(stepWarning("Stamp failed", null, new Error("boom"))));
ok("no response at all is reported rather than assumed fine",
  stepWarning("Stamp failed", null, null) !== null);
ok("the label always leads, so the office reads what broke first",
  stepWarning("Couldn't record the import", { ok: false, status: 404 }, null)
    .startsWith("Couldn't record the import"));

console.log("\n publishSelections — guards");

const guard = async (project, sh) => {
  try { await publishSelections(project, sh, {}); return "did not throw"; }
  catch (e) { return e.message; }
};
eq("refuses when the portal is switched off",
  await guard({ portalShare: { id: "job-1", enabled: false } }, sheet),
  "Turn the customer portal on for this job first.");
eq("refuses an estimate that produced no decisions",
  await guard({ portalShare: { id: "job-1", enabled: true, shareToken: "a".repeat(32) } },
    { selections: [], totals: {} }),
  "That estimate produced no customer decisions.");

console.log(`\n${pass} assertions passed`);
