/* QB Time → phase matcher — pure-logic tests (no Deno, no network).
   Run: node --experimental-strip-types supabase/functions/qb-time-proxy/phasematch.test.mjs */
import assert from "node:assert/strict";
import {
  tokensOf, serviceLeaf, isRoleService, matchPhase,
  entryFingerprint, reconcileRows, phasedJobForDate, MIN_SCORE,
  dominantConcept, coveredConcepts, clusterUnmatched, jobLabel, isOpenForMatching,
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

/* ---------- regressions from the first live backfill (65 real entries) ---------- */

test("'Hang doors' does not own the drywall vocabulary", () => {
  // shipped bug: "hang" lived in the drywall concept, so a Drywall/Mud/Tape
  // service item scored 3 against "Hang doors" and stamped painting hours to it
  const m = matchPhase({ note: "", service: "Drywall / Mud / Tape" },
    [P("d", "Hang doors"), P("t", "Trim and Window sills")]);
  assert.equal(m, null);
});

test("'Trim and Window sills' does not own the siding vocabulary", () => {
  const m = matchPhase({ note: "", service: "Labor (In-House):Labor - Siding / Exterior" },
    [P("t", "Trim and Window sills"), P("d", "Hang doors")]);
  assert.equal(m, null);
});

test("a billing service item never overrides a note that said something", () => {
  const phases = [P("d", "Hang doors"), P("w", "Drywall - Mud, Tape, Paint.")];
  // real entries: the note names paint/framing, the QuickBooks service says drywall
  assert.equal(matchPhase({ note: "Prep for paint trim and doors 101", service: "Drywall / Mud / Tape" }, phases), null);
  assert.equal(matchPhase({ note: "Fixing kitchen framing", service: "Labor (In-House):Labor - Drywall / Taping" }, phases), null);
  assert.equal(matchPhase({ note: "Final coat unit 202&203", service: "Drywall / Mud / Tape" }, phases), null);
});

test("the service item still speaks when the note is silent or generic", () => {
  const phases = [P("d", "Demo"), P("m", "Materials & ordering")];
  assert.equal(matchPhase({ note: "", service: "Labor - Expediting Materials" }, phases)?.phaseId, "m");
  assert.equal(matchPhase({ note: "misc", service: "Labor - Expediting Materials" }, phases)?.phaseId, "m");
});

test("real notes that DID land right still land right", () => {
  const remodel = [P("c", "Install Cabinets"), P("w", "Drywall - Mud, Tape, Paint."), P("t", "Trim and Window sills")];
  assert.equal(matchPhase({ note: "Cabinet install unit 102" }, remodel)?.phaseId, "c");
  assert.equal(matchPhase({ note: "Hanging sheetrock and fire tape at sourdough" }, remodel)?.phaseId, "w");
  assert.equal(matchPhase({ note: "Sanding and puddy the new trim" }, remodel)?.phaseId, "t");
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

// The expensive regression: the free matcher fails on exactly the rows the AI
// stamped, so a fresh pull always arrives with no phaseId. If that wiped the
// stamp we'd re-pay Haiku for the same answer every night.
test("an AI stamp survives a re-pull whose matcher found nothing", () => {
  const prev = {
    id: "e1", hours: 2, note: "put the last pieces up",
    phaseId: "p-trim", phaseMatch: { by: "ai", score: 0.82 },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", { hours: 2, note: "put the last pieces up", createdAt: "x", updatedAt: "y" });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(skipped, 1, "stamp inherited → content identical → nothing to write");
  assert.equal(toWrite.length, 0);
});

test("an AI 'looked and passed' marker also survives (stops repeat spend)", () => {
  const prev = {
    id: "e1", hours: 2, note: "worked on site", phaseMatch: { by: "ai", score: 0 },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", { hours: 2, note: "worked on site", createdAt: "x", updatedAt: "y" });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(skipped, 1);
  assert.equal(toWrite.length, 0);
});

test("a NEW deterministic match still overrides a stale AI stamp", () => {
  // the owner renamed a phase, so this pull's matcher now hits — trust it
  const prev = {
    id: "e1", hours: 2, note: "hung drywall",
    phaseId: "p-old", phaseMatch: { by: "ai", score: 0.75 },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", {
    hours: 2, note: "hung drywall",
    phaseId: "p-drywall", phaseMatch: { by: "note", score: 4 },
    createdAt: "x", updatedAt: "y",
  });
  const { toWrite } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(toWrite.length, 1);
  assert.equal(toWrite[0].data.phaseId, "p-drywall");
  assert.deepEqual(toWrite[0].data.phaseMatch, { by: "note", score: 4 });
});

test("a manual stamp still beats a fresh deterministic match", () => {
  const prev = {
    id: "e1", hours: 2, note: "hung drywall",
    phaseId: "p-hand", phaseMatch: { by: "manual" },
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", {
    hours: 2, note: "hung drywall",
    phaseId: "p-drywall", phaseMatch: { by: "note", score: 4 },
    createdAt: "x", updatedAt: "y",
  });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(skipped, 1, "manual re-asserted → identical → skipped");
  assert.equal(toWrite.length, 0);
});

// The owner clearing a bad guess ("Auto phase" in the board drawer) is an
// instruction, not a wish: it must survive the very next pull, or tonight's
// matcher silently re-pins what they just cleared.
test("a manual UNPIN survives a re-pull whose matcher wants to stamp it", () => {
  const prev = {
    id: "e1", hours: 2, note: "hung drywall", phaseMatch: { by: "manual" },   // no phaseId = unpinned
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
  };
  const fresh = row("e1", {
    hours: 2, note: "hung drywall",
    phaseId: "p-drywall", phaseMatch: { by: "note", score: 4 },   // matcher wants this row
    createdAt: "x", updatedAt: "y",
  });
  const { toWrite, skipped } = reconcileRows([fresh], new Map([["e1", prev]]));
  assert.equal(skipped, 1, "unpin re-asserted → identical to stored → nothing to write");
  assert.equal(toWrite.length, 0);
});

test("isOpenForMatching: only unstamped, un-touched rows are fair game", () => {
  assert.equal(isOpenForMatching({ note: "x" }), true);
  assert.equal(isOpenForMatching({ phaseId: "p1" }), false);                          // already stamped
  assert.equal(isOpenForMatching({ phaseMatch: { by: "manual" } }), false);           // deliberately unpinned
  assert.equal(isOpenForMatching({ phaseId: "p1", phaseMatch: { by: "manual" } }), false);
  assert.equal(isOpenForMatching({ phaseMatch: { by: "ai", score: 0 } }), true);      // AI passed; matcher may still try
  assert.equal(isOpenForMatching(undefined), true);
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

/* ---------- clustering → phase proposals ---------- */

test("dominantConcept picks what a note is mostly about", () => {
  assert.equal(dominantConcept("hung and taped drywall"), "drywall");
  assert.equal(dominantConcept("punch list touch ups and adjustments"), "punch");
  assert.equal(dominantConcept("worked on site"), null);
});

test("coveredConcepts reads the concepts a job's phases already own", () => {
  const c = coveredConcepts([P("a", "Drywall hang & tape"), P("b", "Interior prime & paint")]);
  assert.ok(c.has("drywall") && c.has("paint"));
  assert.equal(c.has("punch"), false);
});

const ent = (id, hours, note) => ({ id, hours, note });

test("a cluster clears the bar on 2+ entries", () => {
  const out = clusterUnmatched(
    [ent("e1", 1, "punch list touch up"), ent("e2", 0.5, "adjusted the door, walk thru")],
    [P("a", "Demo")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Punch list");
  assert.equal(out[0].hours, 1.5);
  assert.deepEqual(out[0].entryIds, ["e1", "e2"]);
});

test("a single big entry clears the bar on hours alone", () => {
  const out = clusterUnmatched([ent("e1", 5.2, "hauled debris and cleaned the site")], [P("a", "Demo")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Final clean");
});

test("one small entry is not enough to bother the owner", () => {
  assert.deepEqual(clusterUnmatched([ent("e1", 1, "swept up")], [P("a", "Demo")]), []);
});

test("a concept an existing phase already covers is never proposed", () => {
  const out = clusterUnmatched(
    [ent("e1", 4, "punch list items"), ent("e2", 3, "touch ups")],
    [P("a", "Punch & owner walk-through")]);
  assert.deepEqual(out, [], "the job already has a punch phase — nothing to add");
});

test("notes with no recognizable concept never become a proposal", () => {
  assert.deepEqual(clusterUnmatched(
    [ent("e1", 4, "worked on site"), ent("e2", 4, "misc stuff")], [P("a", "Demo")]), []);
});

test("multiple clusters come back biggest-first", () => {
  const out = clusterUnmatched([
    ent("e1", 1, "punch list touch up"), ent("e2", 1, "walk thru adjustments"),
    ent("e3", 9, "hung drywall"), ent("e4", 2, "taped and mudded"),
  ], [P("a", "Demo")]);
  assert.equal(out[0].name, "Drywall");
  assert.equal(out[1].name, "Punch list");
});

test("jobLabel prefers title, falls back to customer, then 'job'", () => {
  assert.equal(jobLabel({ title: "3018 Nate Circle", customer: "Smith" }), "3018 Nate Circle");
  assert.equal(jobLabel({ customer: "Smith" }), "Smith");
  assert.equal(jobLabel({}), "job");
});

console.log(`\nALL ${pass} PHASEMATCH CHECKS PASSED`);
