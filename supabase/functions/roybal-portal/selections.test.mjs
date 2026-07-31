/* Customer view of a selection sheet. portal_selections is an OFFICE table —
   it carries our loaded prices and the Xactimate codes — so the projection is
   a privacy boundary and most of this file is about what must NOT cross it.
   Run: node --experimental-strip-types selections.test.mjs */
import assert from "node:assert/strict";
import {
  customerSelection, customerSheet, validateResponse, submissionMessage, NOTE_MAX,
} from "./selections.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

console.log("Portal selections — customer projection");

/* A row exactly as portal_selections stores it, internal columns and all. */
const ROW = {
  selection_id: "flooring--living-room",
  sort_order: 0,
  type: "flooring",
  label: "Flooring",
  scope: "room",
  room: "Living Room",
  rooms: ["Living Room"],
  title: "Living Room — Flooring",
  descr: "Carpet",
  qty: 296.85,
  unit: "SF",
  items: [
    { cat: "FCC", sel: "AV", desc: "Carpet", qty: 296.85, unitCost: 4.47, amount: 1326.92 },
    { cat: "FCC", sel: "PAD", desc: "Carpet pad", qty: 258.13, unitCost: 0.83, amount: 214.25 },
  ],
  // --- everything below is internal and must never reach the customer ---
  cat: "FCC",
  sel: "AV",
  lkq_unit_cost: 4.47,
  lkq_total: 1541.17,
  waste_pct: 15,
  delta_cents: 72200,
  chosen_option_id: "lifeproof-sterling-oak",
  customer_choice: null,
  customer_note: "",
  responded_at: null,
};

/* ============================================================
   1. The privacy boundary
   ============================================================ */
console.log("\n what must not cross");

const projected = customerSelection(ROW);
const blob = JSON.stringify(projected);

for (const secret of ["4.47", "1541.17", "1326.92", "214.25", "72200", "lifeproof"]) {
  test(`no cost basis leaks: ${secret}`, () => assert.ok(!blob.includes(secret), blob));
}
test("no Xactimate category code leaks", () => assert.ok(!/"FCC"/.test(blob)));
test("no Xactimate selector code leaks", () => assert.ok(!/"(AV|PAD)"/.test(blob)));
test("waste factor stays internal", () => {
  assert.ok(!("waste" in projected) && !("waste_pct" in projected), Object.keys(projected).join(","));
});
test("the projected shape is exactly the agreed field set", () => {
  assert.deepEqual(Object.keys(projected).sort(),
    ["alsoIncludes", "choice", "id", "label", "note", "qty", "respondedAt", "room", "rooms", "scope", "title", "unit", "what"]);
});

test("the projection is an allow-list, so a new column cannot leak by default", () => {
  const withFuture = customerSelection({ ...ROW, our_margin_pct: 38, secret_vendor_cost: 900 });
  const s = JSON.stringify(withFuture);
  assert.ok(!s.includes("38") && !s.includes("900") && !("our_margin_pct" in withFuture));
});

/* ============================================================
   2. What the customer SHOULD see
   ============================================================ */
console.log("\n what does cross");

test("the decision is identifiable and named", () => {
  assert.equal(projected.id, "flooring--living-room");
  assert.equal(projected.title, "Living Room — Flooring");
});
test("they see what is going back and how much of it", () => {
  assert.equal(projected.what, "Carpet");
  assert.equal(projected.qty, 296.85);
  assert.equal(projected.unit, "SF");
});
test("companion pieces are described but never priced", () => {
  assert.deepEqual(projected.alsoIncludes, ["Carpet pad"]);
});
test("the primary item is not repeated in alsoIncludes", () => {
  assert.ok(!projected.alsoIncludes.includes("Carpet"));
});
test("an unanswered decision reads as unanswered", () => {
  assert.equal(projected.choice, null);
});
test("their own answer comes back to them", () => {
  const answered = customerSelection({ ...ROW, customer_choice: "change", customer_note: "something darker" });
  assert.equal(answered.choice, "change");
  assert.equal(answered.note, "something darker");
});
test("a junk choice in the DB does not become a choice", () => {
  assert.equal(customerSelection({ ...ROW, customer_choice: "whatever" }).choice, null);
});
test("a row with no items does not throw", () => {
  assert.deepEqual(customerSelection({ selection_id: "x", items: null }).alsoIncludes, []);
});

/* ============================================================
   3. Sheet progress
   ============================================================ */
console.log("\n customerSheet");

const sheet = customerSheet([
  ROW,
  { ...ROW, selection_id: "fixtures--plm-tlt", title: "Toilet", customer_choice: "match" },
  { ...ROW, selection_id: "cabinets--kitchen", title: "Kitchen — Cabinets", customer_choice: "change" },
]);

test("counts every decision", () => assert.equal(sheet.total, 3));
test("counts the answered ones", () => assert.equal(sheet.answered, 2));
test("and what is left", () => assert.equal(sheet.remaining, 1));
test("tracks who wants a conversation", () => assert.equal(sheet.wantsChange, 1));
test("is not complete while one is open", () => assert.equal(sheet.complete, false));
test("is complete when all are answered", () => {
  const all = customerSheet([{ ...ROW, customer_choice: "match" }]);
  assert.equal(all.complete, true);
});
test("an empty sheet is not 'complete'", () => {
  const none = customerSheet([]);
  assert.equal(none.total, 0);
  assert.equal(none.complete, false);   // nothing to submit is not the same as done
});
test("undefined rows do not throw", () => assert.equal(customerSheet(undefined).total, 0));

/* ============================================================
   4. Input validation — this endpoint is public
   ============================================================ */
console.log("\n validateResponse");

test("accepts a real answer", () => {
  assert.deepEqual(validateResponse("flooring--living-room", "match", ""),
    { id: "flooring--living-room", choice: "match", note: "" });
});
test("keeps the note when they want something different", () => {
  assert.equal(validateResponse("x-1", "change", "  darker  ").note, "darker");
});
test("drops a note that came with 'keep it' — it would never be read", () => {
  assert.equal(validateResponse("x-1", "match", "ignore me").note, "");
});
test("rejects an unknown choice", () => {
  assert.throws(() => validateResponse("x-1", "delete", ""), /bad_choice/);
});
test("rejects a missing choice", () => {
  assert.throws(() => validateResponse("x-1", undefined, ""), /bad_choice/);
});
test("rejects an empty selection id", () => {
  assert.throws(() => validateResponse("", "match", ""), /bad_selection/);
});
test("rejects an over-long note", () => {
  assert.throws(() => validateResponse("x-1", "change", "z".repeat(NOTE_MAX + 1)), /too_long/);
});
test("accepts a note exactly at the limit", () => {
  assert.equal(validateResponse("x-1", "change", "z".repeat(NOTE_MAX)).note.length, NOTE_MAX);
});

/* The selection id is interpolated into a PostgREST filter, so it is
   constrained to the shape our own generator produces. */
for (const bad of ["a,b", "a)b", "*", "a b", "a'b", "../x", "a;b", "eq.1"]) {
  test(`rejects a selection id that could break out of the filter: ${JSON.stringify(bad)}`,
    () => assert.throws(() => validateResponse(bad, "match", ""), /bad_selection/));
}
test("accepts the ids our parser actually generates", () => {
  for (const id of ["flooring--living-room", "trim--house", "fixtures--plm-tlt", "paint--kitchen-dining-room"]) {
    assert.equal(validateResponse(id, "match", "").id, id);
  }
});

/* ============================================================
   5. What the office is told
   ============================================================ */
console.log("\n submissionMessage");

test("everything kept reads as a clean confirmation", () => {
  const m = submissionMessage({ total: 9, wantsChange: 0 });
  assert.match(m, /9 selections/);
  assert.match(m, /back the way it was/);
});
test("one change is singular", () => {
  assert.match(submissionMessage({ total: 9, wantsChange: 1 }), /is 1 item/);
});
test("several changes are plural and agree", () => {
  const m = submissionMessage({ total: 9, wantsChange: 3 });
  assert.match(m, /are 3 items/);
  assert.match(m, /they were/);
});

console.log(`\n${pass} assertions passed`);
