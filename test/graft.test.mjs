/* Graft — in-place refresh of a live project after a sync merge.
   The point: object/array identity is PRESERVED so form pages bound to
   sub-objects keep working, while content updates to match the store.
   Run: node test/graft.test.mjs */
import assert from "node:assert/strict";
import { graftProject } from "../js/graft.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

test("scalars update; the root object keeps its identity", () => {
  const live = { id: "j", customer: "Old", updatedAt: "T1" };
  const out = graftProject(live, { id: "j", customer: "New", updatedAt: "T2" });
  assert.equal(out, live);
  assert.equal(live.customer, "New");
  assert.equal(live.updatedAt, "T2");
});

test("arrays keep identity and id-matched elements keep identity", () => {
  const photoA = { id: "A", caption: "one" };
  const live = { id: "j", photos: [photoA] };
  const boundArray = live.photos;                 // what a photos page holds
  graftProject(live, { id: "j", photos: [{ id: "A", caption: "edited" }, { id: "B", caption: "from other device" }] });
  assert.equal(live.photos, boundArray);          // same array the page renders
  assert.equal(live.photos[0], photoA);           // same element a caption editor is bound to
  assert.equal(photoA.caption, "edited");
  assert.equal(live.photos.length, 2);
  assert.equal(live.photos[1].caption, "from other device");
});

test("elements gone from fresh disappear; order follows fresh", () => {
  const live = { photos: [{ id: "A" }, { id: "B" }] };
  graftProject(live, { photos: [{ id: "B" }] });
  assert.deepEqual(live.photos.map((p) => p.id), ["B"]);
});

test("nested single-form objects update key-by-key, keeping the bound reference", () => {
  const auth = { ownerSig: "", ownerName: "" };
  const live = { id: "j", workAuth: auth };
  graftProject(live, { id: "j", workAuth: { ownerSig: "sig!", ownerName: "Pat" } });
  assert.equal(live.workAuth, auth);              // form editor still bound to it
  assert.equal(auth.ownerSig, "sig!");
  assert.equal(auth.ownerName, "Pat");
});

test("a slot filled by the merge appears; keys dropped from fresh are removed", () => {
  const live = { certDrying: null, stale: "x" };
  graftProject(live, { certDrying: { certNo: "7" } });
  assert.equal(live.certDrying.certNo, "7");
  assert.ok(!("stale" in live));
});

test("result deep-equals fresh (non-id arrays replaced wholesale)", () => {
  const live = { rooms: ["Kitchen"], laborLog: { entries: [{ date: "d1" }] } };
  const fresh = { rooms: ["Kitchen", "Bath"], laborLog: { entries: [{ date: "d1" }, { date: "d2" }] } };
  graftProject(live, fresh);
  assert.deepEqual(live, fresh);
});

console.log(`\n${pass} graft checks passed.`);
