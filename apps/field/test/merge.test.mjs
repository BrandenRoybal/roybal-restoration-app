/* Project merge — the rule set that makes two-device edits additive.
   Run: node test/merge.test.mjs */
import assert from "node:assert/strict";
import { mergeProjects, ID_COLLECTIONS, FORM_SLOTS } from "../js/merge.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const T1 = "2026-07-23T10:00:00Z", T2 = "2026-07-23T11:00:00Z";

test("id-keyed collections union — both devices' additions survive", () => {
  const office = { id: "j", updatedAt: T1, photos: [{ id: "A", src: "a" }], dryingLogs: [{ id: "L1", date: "2026-07-22" }] };
  const crew = { id: "j", updatedAt: T2, photos: [{ id: "B", src: "b" }], receipts: [{ id: "R1", amount: 40 }] };
  const { merged, added } = mergeProjects(office, crew);
  assert.deepEqual(merged.photos.map((p) => p.id).sort(), ["A", "B"]);
  assert.equal(merged.dryingLogs.length, 1);          // office's log recovered
  assert.equal(merged.receipts.length, 1);            // crew's receipt kept
  assert.equal(added, 2);                             // A + L1 came from the older side
});

test("id clash: the newer blob's version of an element wins", () => {
  const older = { updatedAt: T1, photos: [{ id: "A", caption: "before" }] };
  const newer = { updatedAt: T2, photos: [{ id: "A", caption: "after" }] };
  const { merged, added } = mergeProjects(older, newer);
  assert.equal(merged.photos.length, 1);
  assert.equal(merged.photos[0].caption, "after");
  assert.equal(added, 0);
});

test("argument order doesn't matter — updatedAt decides who's newer", () => {
  const a = { updatedAt: T2, customer: "New name", photos: [] };
  const b = { updatedAt: T1, customer: "Old name", photos: [{ id: "P" }] };
  assert.equal(mergeProjects(a, b).merged.customer, "New name");
  assert.equal(mergeProjects(b, a).merged.customer, "New name");
  assert.equal(mergeProjects(b, a).merged.photos.length, 1);
});

test("a filled form beats an empty slot, in either direction", () => {
  const withAuth = { updatedAt: T1, workAuth: { signed: true }, certDrying: null };
  const without = { updatedAt: T2, workAuth: null, certDrying: { done: true } };
  const { merged, filledForms } = mergeProjects(withAuth, without);
  assert.equal(merged.workAuth.signed, true);          // older side's form recovered
  assert.equal(merged.certDrying.done, true);          // newer side's form kept
  assert.equal(filledForms, 1);
});

test("rooms (plain strings) union by value", () => {
  const a = { updatedAt: T1, rooms: ["Kitchen", "Hall"] };
  const b = { updatedAt: T2, rooms: ["Kitchen", "Basement"] };
  const { merged } = mergeProjects(a, b);
  assert.deepEqual([...merged.rooms].sort(), ["Basement", "Hall", "Kitchen"]);
});

test("scalars: newer wins wholesale; merge never throws on sparse blobs", () => {
  const { merged } = mergeProjects({ updatedAt: T2, contractAmount: "50000" }, { updatedAt: T1, contractAmount: "45000", photos: [{ id: "X" }] });
  assert.equal(merged.contractAmount, "50000");
  assert.equal(merged.photos.length, 1);
  mergeProjects({}, {});                               // no updatedAt, no arrays — fine
});

test("output is a deep copy — mutating merged never touches the inputs", () => {
  const a = { updatedAt: T2, photos: [{ id: "A", caption: "x" }] };
  const b = { updatedAt: T1, photos: [{ id: "B", caption: "y" }] };
  const { merged } = mergeProjects(a, b);
  merged.photos[0].caption = "MUTATED";
  merged.photos.find((p) => p.id === "B").caption = "MUTATED";
  assert.equal(a.photos[0].caption, "x");
  assert.equal(b.photos[0].caption, "y");
});

test("registry sanity: the collections and form slots match the model", () => {
  assert.ok(ID_COLLECTIONS.includes("photos") && ID_COLLECTIONS.includes("receipts"));
  assert.ok(FORM_SLOTS.includes("workAuth") && FORM_SLOTS.includes("drawSchedule"));
});

console.log(`\n${pass} merge checks passed.`);
