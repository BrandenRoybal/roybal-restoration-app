/* Haiku phase-fallback — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/qb-time-proxy/aiphase.test.mjs */
import assert from "node:assert/strict";
import {
  buildUserContent, buildRequestBody, applyAiMatches, SYSTEM, TOOL_NAME, MIN_CONFIDENCE,
} from "./aiphase.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const PHASES = [
  { id: "p1", name: "Demo" },
  { id: "p2", name: "Drywall" },
  { id: "p3", name: "Punch list", done: true },
];
const ENTRIES = [
  { id: "e1", hours: 2, date: "2026-07-20", note: "tore out the back wall" },
  { id: "e2", hours: 3.5, date: "2026-07-21", note: "misc", service: "Labor:Lead Carpenter" },
];

/* ---------- prompt ---------- */

test("user content lists phase ids, names, and numbered entries", () => {
  const s = buildUserContent(ENTRIES, PHASES);
  assert.match(s, /- p1 = Demo/);
  assert.match(s, /- p3 = Punch list \(already finished\)/);
  assert.match(s, /1\. 2026-07-20 \(2h\) "tore out the back wall"/);
  assert.match(s, /2\. .*"misc".*\[service: Labor:Lead Carpenter\]/);
});

test("nameless phases are never offered to the model", () => {
  const s = buildUserContent(ENTRIES, [...PHASES, { id: "px", name: "   " }]);
  assert.doesNotMatch(s, /px/);
});

test("an entry with no note still gets a line (never silently dropped)", () => {
  const s = buildUserContent([{ id: "e9", hours: 1 }], PHASES);
  assert.match(s, /1\. .*\(no note\)/);
});

test("request body is a forced tool call with no temperature", () => {
  const b = buildRequestBody("claude-haiku-4-5", ENTRIES, PHASES);
  assert.equal(b.model, "claude-haiku-4-5");
  assert.equal(b.system, SYSTEM);
  assert.deepEqual(b.tool_choice, { type: "tool", name: TOOL_NAME });
  assert.equal(b.tools[0].name, TOOL_NAME);
  assert.equal("temperature" in b, false, "house style: temperature is never set");
});

/* ---------- response validation ---------- */

const input = (assignments) => ({ assignments });

test("valid high-confidence assignment maps entry number → entry id", () => {
  const out = applyAiMatches(input([{ entry: 1, phaseId: "p1", confidence: 0.9 }]), ENTRIES, PHASES);
  assert.deepEqual(out, [{ entryId: "e1", phaseId: "p1", confidence: 0.9 }]);
});

test("abstention (empty phaseId) is dropped", () => {
  const out = applyAiMatches(input([{ entry: 2, phaseId: "", confidence: 0.95 }]), ENTRIES, PHASES);
  assert.deepEqual(out, []);
});

test("hallucinated phase id is dropped", () => {
  const out = applyAiMatches(input([{ entry: 1, phaseId: "nope", confidence: 0.99 }]), ENTRIES, PHASES);
  assert.deepEqual(out, []);
});

test("low confidence is dropped at the threshold boundary", () => {
  const under = applyAiMatches(input([{ entry: 1, phaseId: "p1", confidence: MIN_CONFIDENCE - 0.01 }]), ENTRIES, PHASES);
  assert.deepEqual(under, []);
  const at = applyAiMatches(input([{ entry: 1, phaseId: "p1", confidence: MIN_CONFIDENCE }]), ENTRIES, PHASES);
  assert.equal(at.length, 1, "exactly at the bar counts");
});

test("out-of-range and non-integer entry numbers are dropped", () => {
  const out = applyAiMatches(input([
    { entry: 0, phaseId: "p1", confidence: 0.9 },
    { entry: 99, phaseId: "p1", confidence: 0.9 },
    { entry: 1.5, phaseId: "p1", confidence: 0.9 },
  ]), ENTRIES, PHASES);
  assert.deepEqual(out, []);
});

test("one entry can't be assigned twice — first valid wins", () => {
  const out = applyAiMatches(input([
    { entry: 1, phaseId: "p1", confidence: 0.9 },
    { entry: 1, phaseId: "p2", confidence: 0.99 },
  ]), ENTRIES, PHASES);
  assert.deepEqual(out, [{ entryId: "e1", phaseId: "p1", confidence: 0.9 }]);
});

test("garbage input shapes return [] instead of throwing", () => {
  for (const bad of [null, undefined, {}, { assignments: "no" }, { assignments: [null, 7, "x"] }]) {
    assert.deepEqual(applyAiMatches(bad, ENTRIES, PHASES), []);
  }
});

test("missing/NaN confidence is dropped (never treated as certain)", () => {
  const out = applyAiMatches(input([
    { entry: 1, phaseId: "p1" },
    { entry: 2, phaseId: "p2", confidence: "sure" },
  ]), ENTRIES, PHASES);
  assert.deepEqual(out, []);
});

console.log(`\nALL ${pass} AIPHASE CHECKS PASSED`);
