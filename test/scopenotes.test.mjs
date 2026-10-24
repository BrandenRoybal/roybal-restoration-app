/* Walk scope notes — the pure helpers (js/scopenotes.js). Design §3 steps 7–8, §4.2.
   Fixtures are hand-written; never a real customer's transcript.
   Run: node apps/field/test/scopenotes.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import {
  BUCKETS, clipText, spread, extractInput, canExtract, untranscribed, adoptScopeNotes, allItems, findItem,
  setItemState, editItem, acceptAll, checkVerify, scopeCounts, citeOf, scopeNotesText, typedScopeFromNotes, uncoveredInstructions, MAX_STILLS,
} from "../js/scopenotes.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Walk scope notes");

const u = (start, end, text) => ({ start, end, speaker: 0, text });
const visit = () => ({
  files: [
    { id: "w1", kind: "walk", name: "IMG_1.MOV", path: "sitevisit/p1/w1-IMG_1.MOV", duration: 95, room: "Kitchen", status: "transcribed", at: "2026-10-01T10:00:00Z",
      transcript: { text: "[00:00] Kitchen.", seconds: 95, utterances: [u(0, 1, "Kitchen."), u(12, 15, "Take it to four feet on the sink wall."), u(70, 72, "About twelve feet of base.")] } },
    { id: "f1", kind: "frames", videoId: "w1", name: "IMG_1.MOV @ 12s", path: "sitevisit/p1/f1.jpg", caption: "still at 0:12 · \"Take it…\"" },
    { id: "f2", kind: "frames", videoId: "w1", name: "IMG_1.MOV @ 70s", path: "sitevisit/p1/f2.jpg", caption: "c", queued: true },   // not uploaded yet
    { id: "w2", kind: "walk", name: "IMG_2.MOV", path: "sitevisit/p1/w2-IMG_2.MOV", duration: 40, room: "", status: "uploaded", at: "2026-10-01T10:05:00Z" },
    { id: "w3", kind: "walk", name: "IMG_3.MOV", path: "sitevisit/p1/w3-IMG_3.MOV", duration: 30, room: "", status: "transcribed", at: "2026-10-01T10:09:00Z",
      transcript: { text: "Hall bath. Homeowner says it started Tuesday.", seconds: 30, utterances: [] } },
    { id: "r1", kind: "report", name: "Magicplan.pdf", path: "sitevisit/p1/r1.pdf" },
  ],
});
const result = { model: "m", fromClips: [1, 3], rooms: [
  { room: "Kitchen", items: [
    { bucket: "instructions", text: "take it to four feet on the sink wall", clip: 1, at: 12 },
    { bucket: "quantities", text: "about twelve feet of base", clip: 1, at: 70, value: 12, unit: "LF" },
    { bucket: "verify", text: "check the subfloor under the fridge", clip: 1, at: 80 },
    { bucket: "bogus", text: "x", clip: 1, at: 1 },
    { bucket: "observations", text: "a clip that doesn't exist", clip: 7, at: 1 },
  ] },
  { room: "Main Level", items: [
    { bucket: "homeownerSaid", text: "Homeowner: it started Tuesday", clip: 3, at: 2 },
    { bucket: "trades", text: "electrician for the disposal", clip: 3, at: 9, trade: "Electrician" },
  ] },
] };

test("clipText stamps each utterance; a clip with only text keeps its text", () => {
  const sv = visit();
  assert.equal(clipText(sv.files[0]), "[0:00] Kitchen.\n[0:12] Take it to four feet on the sink wall.\n[1:10] About twelve feet of base.");
  assert.equal(clipText(sv.files[4]), "Hall bath. Homeowner says it started Tuesday.");
});

test("spread thins evenly and leaves a short list alone", () => {
  assert.deepEqual(spread([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(spread(Array.from({ length: 10 }, (_, i) => i), 5), [0, 2, 4, 6, 8]);
});

test("extractInput numbers clips like the panel, skips untranscribed clips and unuploaded stills", () => {
  const sv = visit();
  const i = extractInput(sv, { rooms: ["Kitchen", ""], jobType: "restoration" });
  assert.deepEqual(i.clips.map((c) => [c.n, c.room, c.seconds]), [[1, "Kitchen", 95], [3, "", 30]]);
  assert.deepEqual(i.stills, [{ path: "sitevisit/p1/f1.jpg", clip: 1, at: 12, caption: "still at 0:12 · \"Take it…\"" }]);
  assert.equal(i.jobKind, "claim");
  assert.deepEqual(i.rooms, ["Kitchen"]);
  assert.equal(extractInput(sv, { jobType: "construction" }).jobKind, "construction");
  assert.equal(canExtract(sv), true);
  assert.equal(untranscribed(sv), 1);
  assert.equal(canExtract({ files: [sv.files[3]] }), false);
});

test("extractInput caps the stills", () => {
  const sv = visit();
  for (let k = 0; k < MAX_STILLS + 30; k++) sv.files.push({ id: "x" + k, kind: "frames", videoId: "w1", name: `IMG_1.MOV @ ${k}s`, path: `sitevisit/p1/x${k}.jpg` });
  assert.equal(extractInput(sv, {}).stills.length, MAX_STILLS);
});

test("adoptScopeNotes maps clip numbers to rows, numbers items, drops what it can't place", () => {
  const sv = visit();
  const c = adoptScopeNotes(sv, result, "2026-10-01T11:00:00Z");
  assert.deepEqual(c, { items: 5, kept: 0, fresh: 5, rooms: 2 });
  const items = allItems(sv);
  assert.deepEqual(items.map((it) => it.id), ["N1", "N2", "N3", "N4", "N5"]);
  assert.equal(items[0].clipId, "w1");
  assert.equal(items[3].clipId, "w3");
  assert.deepEqual(sv.scopeNotes.fromClips, ["w1", "w3"]);
  assert.equal(sv.scopeNotes.status, "draft");
  assert.equal(items[1].value, 12);
  assert.equal(items[4].trade, "Electrician");
});

test("review: accept, reject, edit, accept the rest; reviewed once nothing is open", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  assert.equal(setItemState(sv, "N1", "accepted"), true);
  assert.equal(setItemState(sv, "N5", "rejected"), true);
  assert.equal(editItem(sv, "N2", "fourteen feet of base"), true);
  assert.equal(findItem(sv, "N2").origText, "about twelve feet of base");
  assert.equal(findItem(sv, "N2").state, "accepted");
  assert.equal(editItem(sv, "N2", "  "), false, "an empty edit is refused");
  assert.deepEqual(scopeCounts(sv), { items: 5, open: 2, accepted: 2, verify: 1, verifyItems: [{ id: "N3", text: "check the subfloor under the fridge" }] });
  assert.equal(acceptAll(sv), 2);
  assert.equal(sv.scopeNotes.status, "reviewed");
  setItemState(sv, "N4", null);
  assert.equal(sv.scopeNotes.status, "draft");
  assert.equal(setItemState(sv, "N99", "accepted"), false);
});

test("the Verify checkbox clears a verify item from the Bid card list", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  assert.equal(checkVerify(sv, "N1", true), false, "only verify items");
  assert.equal(checkVerify(sv, "N3", true), true);
  assert.equal(scopeCounts(sv).verify, 0);
  checkVerify(sv, "N3", false);
  assert.equal(scopeCounts(sv).verify, 1);
  setItemState(sv, "N3", "rejected");
  assert.equal(scopeCounts(sv).verify, 0, "a rejected verify item isn't owed");
});

test("a re-run keeps what was reviewed: same id, same decision, the owner's wording", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  editItem(sv, "N1", "tear out to 4 ft on the sink wall");
  setItemState(sv, "N5", "rejected");
  checkVerify(sv, "N3", true);
  setItemState(sv, "N3", "accepted");
  const again = { ...result, rooms: [...result.rooms, { room: "Hall bath", items: [{ bucket: "damage", text: "vinyl lifting at the tub", clip: 3, at: 20 }] }] };
  const c = adoptScopeNotes(sv, again);
  assert.deepEqual(c, { items: 6, kept: 3, fresh: 3, rooms: 3 });
  assert.equal(findItem(sv, "N1").text, "tear out to 4 ft on the sink wall");
  assert.equal(findItem(sv, "N1").state, "accepted");
  assert.equal(findItem(sv, "N5").state, "rejected");
  assert.equal(findItem(sv, "N3").checked, true);
  assert.deepEqual(allItems(sv).filter((it) => !it.state).map((it) => it.id), ["N6", "N7", "N8"], "unreviewed items get new ids, never reused ones");
});

test("citeOf names the clip's room, or Clip n when it has none", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  assert.equal(citeOf(sv, findItem(sv, "N1")), "walk Kitchen 0:12");
  assert.equal(citeOf(sv, findItem(sv, "N4")), "walk Clip 3 0:02");
  assert.equal(citeOf(sv, { clipId: "gone", at: 75 }), "walk 1:15");
});

test("scopeNotesText: accepted only, by room, instructions first, each with its id and cite", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  assert.equal(scopeNotesText(sv), "", "nothing accepted, no block");
  setItemState(sv, "N2", "accepted");
  setItemState(sv, "N1", "accepted");
  setItemState(sv, "N5", "accepted");
  setItemState(sv, "N4", "rejected");
  assert.equal(scopeNotesText(sv), [
    "Kitchen",
    "[N1] INSTRUCTION: take it to four feet on the sink wall (walk Kitchen 0:12)",
    "[N2] QUANTITY (spoken): about twelve feet of base = 12 LF (walk Kitchen 1:10)",
    "",
    "Main Level",
    "[N5] TRADE: electrician for the disposal (Electrician) (walk Clip 3 0:09)",
  ].join("\n"));
});

test("typedScopeFromNotes: the accepted instructions, quantities and trades", () => {
  const sv = visit();
  adoptScopeNotes(sv, result);
  acceptAll(sv);
  assert.equal(typedScopeFromNotes(sv), "Kitchen:\n- take it to four feet on the sink wall\n- about twelve feet of base (12 LF)\nMain Level:\n- electrician for the disposal");
});

test("uncoveredInstructions: an accepted instruction the draft never cited", () => {
  const sv = visit();
  adoptScopeNotes(sv, { ...result, rooms: [{ room: "Kitchen", items: [...result.rooms[0].items, { bucket: "instructions", text: "keep the uppers", clip: 1, at: 40 }] }] });
  acceptAll(sv);
  const ids = allItems(sv).filter((it) => it.bucket === "instructions").map((it) => it.id);
  assert.deepEqual(ids, ["N1", "N4"]);
  assert.deepEqual(uncoveredInstructions(sv, ["[N1] walk Kitchen 0:12: four feet", "Magicplan: 214 ft²"]).map((x) => x.id), ["N4"]);
  assert.deepEqual(uncoveredInstructions(sv, ["N4 — which uppers stay?", "[N1]"]), []);
  assert.deepEqual(uncoveredInstructions(sv, ["[N14] something"]).map((x) => x.id), ["N1", "N4"], "N1 is not N14");
  setItemState(sv, "N4", "rejected");
  assert.deepEqual(uncoveredInstructions(sv, []).map((x) => x.id), ["N1"]);
});

test("every bucket has a label and a prompt tag", () => {
  for (const [k, b] of Object.entries(BUCKETS)) assert.ok(b.label && b.tag, k);
  assert.equal(Object.keys(BUCKETS).length, 10);
});

console.log(`\n${pass} passed`);
