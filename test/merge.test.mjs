/* Project merge — the rule set that makes two-device edits additive.
   Run: node test/merge.test.mjs */
import assert from "node:assert/strict";
import { mergeProjects, ID_COLLECTIONS, FORM_SLOTS } from "../js/merge.js";
import { FORMS, newWorkAuth, newLaborLog, newFloorPlan } from "../js/model.js";

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

test("a factory blank (form opened, never touched) cannot erase a signed original", () => {
  // crew phone taps the Work Auth tile just to look → a non-null blank is
  // materialized; later edits make the crew copy "newer". The signed office
  // copy must still win field-by-field.
  const signed = newWorkAuth();
  signed.ownerSig = "data:image/png;base64,SIGNATURE";
  signed.ownerName = "Pat Customer";
  signed.uploadedPages = ["data:image/jpeg;base64,PAGE1"];
  const office = { updatedAt: T1, workAuth: signed };
  const crew = { updatedAt: T2, workAuth: newWorkAuth(), photos: [{ id: "X" }] };
  const { merged, filledForms } = mergeProjects(office, crew);
  assert.equal(merged.workAuth.ownerSig, "data:image/png;base64,SIGNATURE");
  assert.equal(merged.workAuth.ownerName, "Pat Customer");
  assert.deepEqual(merged.workAuth.uploadedPages, ["data:image/jpeg;base64,PAGE1"]);
  assert.ok(filledForms >= 1);
});

test("both sides filled: field-level union — neither device's entries vanish", () => {
  const a = { updatedAt: T2, workAuth: { ownerSig: "sig-A", repSig: "", ownerName: "" } };
  const b = { updatedAt: T1, workAuth: { ownerSig: "", repSig: "sig-B", ownerName: "Pat" } };
  const { merged } = mergeProjects(a, b);
  assert.equal(merged.workAuth.ownerSig, "sig-A");     // newer side's filled field kept
  assert.equal(merged.workAuth.repSig, "sig-B");       // older side's filled field recovered
  assert.equal(merged.workAuth.ownerName, "Pat");
});

test("blank labor log (entries:[]) never beats one holding QuickBooks hours", () => {
  const filled = newLaborLog();
  filled.entries = [{ date: "2026-07-20", employee: "Mike", hours: 8, qbId: "q1" }];
  const older = { updatedAt: T1, laborLog: filled };
  const newer = { updatedAt: T2, laborLog: newLaborLog() };
  const { merged } = mergeProjects(older, newer);
  assert.equal(merged.laborLog.entries.length, 1);
  assert.equal(merged.laborLog.entries[0].employee, "Mike");
});

test("supportDocs (engineer reports) union like every id-keyed collection", () => {
  const office = { updatedAt: T1, supportDocs: [{ id: "D1", title: "Engineer's report" }] };
  const crew = { updatedAt: T2, photos: [{ id: "B" }] };
  const { merged } = mergeProjects(office, crew);
  assert.equal(merged.supportDocs.length, 1);
  assert.equal(merged.supportDocs[0].title, "Engineer's report");
});

test("floorPlan: uploaded plan survives a merge with a copy that lacks (or blanked) it", () => {
  const plan = newFloorPlan();
  plan.uploadedPages = ["data:image/jpeg;base64,PLAN"];
  // crew copy lacks the slot entirely
  let r = mergeProjects({ updatedAt: T1, floorPlan: plan }, { updatedAt: T2, photos: [] });
  assert.deepEqual(r.merged.floorPlan.uploadedPages, ["data:image/jpeg;base64,PLAN"]);
  // crew copy holds a factory blank (opened, never uploaded)
  r = mergeProjects({ updatedAt: T1, floorPlan: plan }, { updatedAt: T2, floorPlan: newFloorPlan() });
  assert.deepEqual(r.merged.floorPlan.uploadedPages, ["data:image/jpeg;base64,PLAN"]);
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

test("registry completeness: EVERY form in the app is covered by a merge rule", () => {
  // this is the test that would have caught supportDocs/floorPlan going
  // missing — any new form added to model.js must pick a merge strategy
  for (const f of FORMS) {
    assert.ok(ID_COLLECTIONS.includes(f.key) || FORM_SLOTS.includes(f.key),
      `FORMS key "${f.key}" is in neither ID_COLLECTIONS nor FORM_SLOTS (merge.js)`);
  }
  assert.ok(ID_COLLECTIONS.includes("receipts") && ID_COLLECTIONS.includes("boxes"),
    "non-form collections stay registered too");
});

console.log(`\n${pass} merge checks passed.`);
