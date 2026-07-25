/* QB Time → phase matcher — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/qb-time-proxy/phasematch.test.mjs */
import assert from "node:assert/strict";
import {
  tokensOf, serviceLeaf, isRoleService, matchPhase,
  entryFingerprint, reconcileRows, phasedJobForDate, MIN_SCORE,
} from "./phasematch.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

/* ---------- tokensOf ---------- */

test("tokensOf: lowercases, splits punctuation, drops stopwords + labor-noise", () => {
  assert.deepEqual(tokensOf("Labor (In-House):Labor — Hung the drywall!"), ["hung", "drywall"]);
});

test("tokensOf: trims simple plurals but not short or double-s words", () => {
  assert.deepEqual(tokensOf("doors walls pass"), ["door", "wall", "pass"]);
});

/* ---------- service items ---------- */

test("serviceLeaf: takes the segment after the last colon", () => {
  assert.equal(serviceLeaf("Labor (In-House):Labor - Expediting Materials - (Construction)"),
    "Labor - Expediting Materials - (Construction)");
});

// real service items from this shop's QB Time
test("isRoleService: 'Lead Carpenter / Foreman' is a role, not a task", () => {
  assert.equal(isRoleService("Labor (In-House):Labor — Lead Carpenter / Foreman"), true);
});

test("isRoleService: 'Expediting Materials' is task-like", () => {
  assert.equal(isRoleService("Labor (In-House):Labor - Expediting Materials - (Construction)"), false);
});

/* ---------- matchPhase ---------- */

const P = (id, name) => ({ id, name });
const REMODEL = [P("d", "Demo"), P("t", "Trim & doors"), P("p", "Punch list")];

test("clear note match: drywall words land on the Drywall phase", () => {
  const m = matchPhase({ note: "Hung and taped drywall upstairs" },
    [P("d", "Demo"), P("w", "Drywall"), P("pt", "Paint")]);
  assert.equal(m?.phaseId, "w");
  assert.equal(m?.by, "note");
  assert.ok(m.score >= MIN_SCORE);
});

// real entry: David Jarman 2026-07-23, 3018 Nate Circle
test("real note 'Fixing blind covers silicone windowsills adjusted cabinet door' → Trim & doors", () => {
  const m = matchPhase({
    note: "Fixing blind covers silicone windowsills adjusted cabinet door",
    service: "Labor (In-House):Labor — Lead Carpenter / Foreman",     // role → ignored
  }, REMODEL);
  assert.equal(m?.phaseId, "t");
  assert.equal(m?.by, "note");
});

// real entry: Clinton Smith 2026-07-23, 3018 Nate Circle
test("real note 'Walk thru' → Final walkthrough phase", () => {
  const m = matchPhase({
    note: "Walk thru",
    service: "Labor (In-House):Labor - Expediting Materials - (Construction)",
  }, [P("d", "Demo"), P("m", "Materials & ordering"), P("w", "Final walkthrough")]);
  assert.equal(m?.phaseId, "w");
  assert.equal(m?.by, "note", "the note is what the crew did — it outranks the service item");
});

test("service fallback: unmatchable note, task-like service → Materials phase", () => {
  const m = matchPhase({
    note: "misc",
    service: "Labor (In-House):Labor - Expediting Materials - (Construction)",
  }, [P("d", "Demo"), P("m", "Materials & ordering")]);
  assert.equal(m?.phaseId, "m");
  assert.equal(m?.by, "service");
});

test("role-only service with empty note matches nothing — even a Carpentry phase", () => {
  const m = matchPhase({ note: "", service: "Labor (In-House):Labor — Lead Carpenter / Foreman" },
    [P("c", "Carpentry"), P("d", "Demo")]);
  assert.equal(m, null);
});

test("ambiguity loses: a note naming two phases stamps neither", () => {
  const m = matchPhase({ note: "paint and drywall" }, [P("w", "Drywall"), P("pt", "Paint")]);
  assert.equal(m, null);
});

test("no phases / nameless phases → null", () => {
  assert.equal(matchPhase({ note: "demo day" }, []), null);
  assert.equal(matchPhase({ note: "demo day" }, [{ id: "x", name: "" }]), null);
});

test("weak single-vote evidence stays below the bar", () => {
  // one concept vote (score 1) must not stamp — date fallback is safer
  const m = matchPhase({ note: "fixed stuff" }, REMODEL);
  assert.equal(m, null);
});

/* ---------- entryFingerprint ---------- */

test("fingerprint ignores createdAt/updatedAt and key order", () => {
  const a = { id: "1", hours: 2, note: "x", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  const b = { updatedAt: "2026-07-25", note: "x", id: "1", createdAt: "2026-07-25", hours: 2 };
  assert.equal(entryFingerprint(a), entryFingerprint(b));
  assert.notEqual(entryFingerprint(a), entryFingerprint({ ...a, hours: 3 }));
});

/* ---------- reconcileRows ---------- */

const row = (id, data) => ({ id, deleted: false, data: { id, ...data } });

test("unchanged re-pulled row is skipped entirely", () => {
  const prev = { id: "e1", hours: 2, note: "demo", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" };
  const fresh = row("e1", { hours: 2, note: "demo", createdAt: "2026-07-25T14:00:00Z", updatedAt: "2026-07-25T14:00:00Z" });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(toWrite.length, 0);
  assert.equal(skipped, 1);
});

test("changed row is written with the ORIGINAL createdAt preserved", () => {
  const prev = { id: "e1", hours: 2, note: "demo", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" };
  const fresh = row("e1", { hours: 3.5, note: "demo", createdAt: "2026-07-25T14:00:00Z", updatedAt: "2026-07-25T14:00:00Z" });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(skipped, 0);
  assert.equal(toWrite.length, 1);
  assert.equal(toWrite[0].data.createdAt, "2026-07-01T00:00:00Z");
  assert.equal(toWrite[0].data.hours, 3.5);
});

test("a manual phase assignment survives re-pull AND re-matching", () => {
  const prev = {
    id: "e1", hours: 2, note: "demo day",
    phaseId: "hand-picked", phaseMatch: { by: "manual" },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  // the matcher re-stamped it differently on this pull — owner still wins
  const fresh = row("e1", {
    hours: 2, note: "demo day",
    phaseId: "matcher-said", phaseMatch: { by: "note", score: 4 },
    createdAt: "2026-07-25T14:00:00Z", updatedAt: "2026-07-25T14:00:00Z",
  });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  // after preserving the manual stamp the content is unchanged → skip
  assert.equal(skipped, 1);
  assert.equal(toWrite.length, 0);
});

test("manual stamp preserved even when other fields changed (row written)", () => {
  const prev = {
    id: "e1", hours: 2, note: "demo day",
    phaseId: "hand-picked", phaseMatch: { by: "manual" },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", {
    hours: 4, note: "demo day",
    phaseId: "matcher-said", phaseMatch: { by: "note", score: 4 },
    createdAt: "2026-07-25T14:00:00Z", updatedAt: "2026-07-25T14:00:00Z",
  });
  const { toWrite } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(toWrite.length, 1);
  assert.equal(toWrite[0].data.phaseId, "hand-picked");
  assert.deepEqual(toWrite[0].data.phaseMatch, { by: "manual" });
  assert.equal(toWrite[0].data.hours, 4);
});

test("brand-new rows always write", () => {
  const { toWrite, skipped } = reconcileRows([row("new1", { hours: 1 })], new Map());
  assert.equal(toWrite.length, 1);
  assert.equal(skipped, 0);
});

/* ---------- phasedJobForDate ---------- */

test("phasedJobForDate: hoursFrom scopes shared jobcodes (rebuild vs mitigation)", () => {
  const mit = { id: "mit", subtasks: [], hoursFrom: "" };                       // no phases → never a candidate
  const rebuild = { id: "rb", subtasks: [P("a", "Demo")], hoursFrom: "2026-07-01" };
  const phasedOld = { id: "old", subtasks: [P("b", "Dry-out")] };               // no hoursFrom → matches any date
  assert.equal(phasedJobForDate([mit, rebuild, phasedOld], "2026-07-10")?.id, "rb",
    "latest hoursFrom at/before the date wins");
  assert.equal(phasedJobForDate([mit, rebuild, phasedOld], "2026-06-15")?.id, "old",
    "before the rebuild's hoursFrom, the unscoped phased job wins");
  assert.equal(phasedJobForDate([mit], "2026-07-10"), null, "no phased candidates → null");
});

console.log(`\nALL ${pass} PHASEMATCH CHECKS PASSED`);
