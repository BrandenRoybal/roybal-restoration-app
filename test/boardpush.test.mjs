/* Job Board bridge test — pure mapping/matching logic only (the network
   functions are browser-only and fail-safe).
   Run: node apps/field/test/boardpush.test.mjs   (from repo root) */
import assert from "node:assert";
import {
  planPhases, boardJobFromProject, mergePlanIntoBoardJob,
  rollupActuals, historyDigest, phasesToSubRows, isoDateOnly, matchCustomerRow,
  boardRowFor, tileCandidates, tilesNeedingFieldFile, fieldSeedFromBoardJob,
  nameLike, normAddr, sameWorkGroup, looseCandidates, mergeBoardTiles, duplicateTilePairs,
} from "../js/boardpush.js";
import { blankSubRow } from "../js/model.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Job Board bridge");

const NOW_ISO = "2026-07-15T12:00:00.000Z";

/* ---------- planPhases: AI draft -> board-shaped phases ---------- */
const draft = {
  phases: [
    { name: "Demo & prep", estimatedHours: 24, lagDays: 0, confidence: 0.9 },
    { name: "Drywall", estimatedHours: 40, lagDays: 1, confidence: 0.85 },
    { name: "", estimatedHours: 10, lagDays: 0, confidence: 0.5 },        // nameless — dropped
    { name: "Paint", estimatedHours: 0, lagDays: -2, confidence: 0.4 },   // 0h sentinel + bad lag
  ],
  notBefore: "2026-08-01", notBeforeLabel: "permit",
  assumptions: ["2-man crew"],
};
const phases = planPhases(draft);
ok("nameless phases dropped", phases.length === 3);
ok("hours carried; zero-hour sentinel becomes blank", phases[0].estimatedHours === 24 && phases[2].estimatedHours === "");
ok("negative lag clamped to 0", phases[2].lagDays === 0);
ok("confidence kept for the review UI", phases[0].confidence === 0.9);
ok("empty draft -> no phases", planPhases(null).length === 0 && planPhases({}).length === 0);

const project = {
  id: "fp-9", customer: "Hansen", address: "415 Birch Ln", phone: "907-555-0101",
  claimNo: "CL-88", workOrderNo: "WO-201", constructionType: "remodel",
  contractAmount: "48000", startDate: "2026-08-04", jobType: "construction",
};
const plan = { phases, notBefore: "2026-08-01", notBeforeLabel: "permit", assumptions: ["2-man crew"] };

/* ---------- boardJobFromProject: brand-new board job ---------- */
const job = boardJobFromProject(project, plan, NOW_ISO);
ok("new board job gets its own id + rev 0", !!job.id && job.id !== project.id && job.rev === 0);
ok("stage scheduled when the field job has a start date", job.stage === "scheduled");
ok("construction type maps to the board vocabulary", job.type === "remodel");
ok("header carries over", job.title === "Hansen" && job.address === "415 Birch Ln" && job.claimNo === "CL-88");
ok("contract value carried as a number", job.contractValue === 48000);
ok("phases become board subtasks with computed-duration left to the board",
  job.subtasks.length === 3 && job.subtasks.every((st) => st.durationDays === null && st.crewIds.length === 0 && st.id));
ok("subtasks never carry the confidence hint", job.subtasks.every((st) => !("confidence" in st)));
ok("job-level estimated hours = sum of phase hours", job.estimatedHours === 64);
ok("the board owns dates — none are set", job.startDate === "" && job.targetDate === "" && job.scheduleMode === "auto");
ok("notBefore constraint carried", job.notBefore === "2026-08-01" && job.notBeforeLabel === "permit");
ok("explicit field link set", job.fieldJobId === "fp-9");
const noStart = boardJobFromProject({ ...project, startDate: "" }, plan, NOW_ISO);
ok("no start date -> lands in Leads", noStart.stage === "lead");

/* the model's notBefore is prose-prone — only a clean ISO date may reach the board */
ok("isoDateOnly accepts YYYY-MM-DD", isoDateOnly("2026-08-01") === "2026-08-01");
for (const bad of ["next Tuesday", "08/01/2026", "2026-8-1", "", null])
  ok(`isoDateOnly rejects ${JSON.stringify(bad)}`, isoDateOnly(bad) === "");
const badPlan = { ...plan, notBefore: "next Tuesday", notBeforeLabel: "permit" };
ok("garbage notBefore never reaches a new board job",
  boardJobFromProject(project, badPlan, NOW_ISO).notBefore === "" &&
  boardJobFromProject(project, badPlan, NOW_ISO).notBeforeLabel === "");
ok("garbage notBefore never merges into an existing board job",
  mergePlanIntoBoardJob({ id: "co-x", rev: 1, subtasks: [], notBefore: "" }, project, badPlan, NOW_ISO).data.notBefore === "");
const mapped = { new_construction: "new_build", reconstruction: "restoration" };
for (const [k, v] of Object.entries(mapped))
  ok(`${k} maps to board type ${v}`, boardJobFromProject({ ...project, constructionType: k }, plan, NOW_ISO).type === v);

/* ---------- mergePlanIntoBoardJob: existing board job ---------- */
const bareExisting = {
  id: "co-1", rev: 4, stage: "in_progress", scheduleMode: "manual", pinnedStart: "2026-07-20",
  startDate: "2026-07-20", targetDate: "2026-08-20", crewIds: ["c1"], deps: [{ predId: "x", type: "FS", lagDays: 0 }],
  subtasks: [], contractValue: "", notBefore: "",
};
const direct = mergePlanIntoBoardJob(bareExisting, project, plan, NOW_ISO);
ok("no existing phases -> phases land directly", direct.mode === "direct" && direct.data.subtasks.length === 3);
ok("coordinator territory untouched (dates/crew/deps/stage/mode)",
  direct.data.stage === "in_progress" && direct.data.scheduleMode === "manual" &&
  direct.data.pinnedStart === "2026-07-20" && direct.data.startDate === "2026-07-20" &&
  direct.data.crewIds.join() === "c1" && direct.data.deps.length === 1);
ok("empty contract value backfilled", direct.data.contractValue === 48000);
ok("direct merge leaves no proposal behind", !("fieldPlanProposal" in direct.data));

const withPhases = { ...bareExisting, subtasks: [{ id: "st1", name: "Demo", estimatedHours: 20, lagDays: 0, crewIds: ["c1"] }], contractValue: 50000, notBefore: "2026-07-18" };
const staged = mergePlanIntoBoardJob(withPhases, project, plan, NOW_ISO);
ok("existing phases -> plan becomes a proposal", staged.mode === "proposal" && staged.data.fieldPlanProposal.phases.length === 3);
ok("existing phases never overwritten", staged.data.subtasks.length === 1 && staged.data.subtasks[0].name === "Demo");
ok("existing contract value + notBefore kept", staged.data.contractValue === 50000 && staged.data.notBefore === "2026-07-18");
ok("proposal records origin + assumptions", staged.data.fieldPlanProposal.from === "fp-9" && staged.data.fieldPlanProposal.assumptions.join() === "2-man crew");
ok("source objects not mutated", withPhases.fieldPlanProposal === undefined && bareExisting.subtasks.length === 0);

/* ---------- rollupActuals: daily-log hours per phase name ---------- */
const logs = {
  constructionLogs: [
    { date: "2026-07-14", rows: [
      { task: "Hang drywall lower walls", hours: "6" },
      { task: "drywall taping", hours: "2" },
      { task: "Site cleanup", hours: "1" },
    ] },
    { date: "2026-07-15", rows: [{ task: "Demo & prep utility room", hours: "4" }] },
  ],
};
const acts = rollupActuals(logs, ["Demo & prep", "Drywall", "Paint"]);
ok("only matched phases appear in the rollup", Object.keys(acts).sort().join() === "Demo & prep,Drywall");
ok("drywall tasks matched both ways", acts["Drywall"] === 8);
ok("phase-in-task match works ('Demo & prep utility room')", acts["Demo & prep"] === 4);
ok("unmatched tasks stay out", !("Paint" in acts) && Object.values(acts).reduce((a, b) => a + b, 0) === 12);

/* Labor Log (QuickBooks Time) is the living hours source now that the Field
   Report no longer collects per-day work rows — both sources combine. */
const withLabor = rollupActuals({
  ...logs,
  laborLog: { entries: [
    { date: "2026-07-16", note: "drywall sanding and second coat", hours: 5 },
    { date: "2026-07-16", note: "", task: "Paint prime walls", hours: 3 },
    { date: "2026-07-17", note: "lunch run", hours: 1 },
  ] },
}, ["Demo & prep", "Drywall", "Paint"]);
ok("labor-log notes roll into the phase hours", withLabor["Drywall"] === 13);
ok("labor-log task fallback matches too", withLabor["Paint"] === 3);
ok("legacy work-log rows still count", withLabor["Demo & prep"] === 4);
ok("empty inputs safe", Object.keys(rollupActuals({}, ["X"])).length === 0 && Object.keys(rollupActuals(logs, [])).length === 0);

/* ---------- historyDigest: estimate calibration from done jobs ---------- */
const rows = [
  { id: "a", data: { stage: "done", fieldActuals: { Drywall: 52 }, subtasks: [{ name: "Drywall", estimatedHours: 40 }] } },
  { id: "b", data: { stage: "done", fieldActuals: { Drywall: 30, Paint: 12 }, subtasks: [{ name: "Drywall", estimatedHours: 30 }, { name: "Paint", estimatedHours: 16 }] } },
  { id: "c", data: { stage: "in_progress", fieldActuals: { Drywall: 99 }, subtasks: [{ name: "Drywall", estimatedHours: 10 }] } },  // not done — excluded
  { id: "d", data: { stage: "done", subtasks: [{ name: "Demo", estimatedHours: 20 }] } },                                          // no actuals — excluded
];
const digest = historyDigest(rows);
ok("only finished jobs with actuals count", digest.length === 2);
const dw = digest.find((g) => g.phase === "Drywall");
ok("per-phase totals aggregate across jobs", dw.jobs === 2 && dw.estHours === 70 && dw.actualHours === 82);
ok("ratio computed (drywall runs 1.17x)", dw.ratio === 1.17);
ok("empty history -> empty digest", historyDigest([]).length === 0 && historyDigest(null).length === 0);

/* ---------- phasesToSubRows: board phases -> sub-schedule prefill ---------- */
const subRows = phasesToSubRows([
  { name: "Drywall", estimatedHours: 40 },
  { name: "Insulation + inspection", estimatedHours: 8 },
  { name: "Shower glass", estimatedHours: 6 },
], blankSubRow);
ok("phase names map to trades", subRows[0].trade === "Drywall" && subRows[1].trade === "Insulation");
ok("unmatched phase lands as Other with the name kept", subRows[2].trade === "Other" && /Shower glass/.test(subRows[2].notes));
ok("planned hours ride in the notes", /40h planned/.test(subRows[0].notes));
ok("prefill rows keep the model defaults", subRows.every((r) => r.status === "scheduled" && r.coi === false));

/* ---------- matchCustomerRow: the anti-duplicate fallback ----------
   A push must land on the coordinator's existing tile even when it has no
   claim # or field link yet — but only on an UNAMBIGUOUS customer match. */
const mkRow = (id, data) => ({ id, data });
const boardRows = [
  mkRow("b1", { customer: "Jeff Hebard", title: "Hebard Rebuild", stage: "scheduled", fieldJobId: "" }),
  mkRow("b2", { customer: "Ana Diaz", title: "Diaz Kitchen", stage: "lead", fieldJobId: "" }),
  mkRow("b3", { customer: "Old Hebard", title: "Jeff Hebard", stage: "done", fieldJobId: "" }),
];
const proj = (customer, id = "fp-1") => ({ id, customer });
ok("matches the one active job by customer name", matchCustomerRow(boardRows, proj("Jeff Hebard"))?.id === "b1");
ok("match is case/space-insensitive", matchCustomerRow(boardRows, proj("  jeff hebard "))?.id === "b1");
ok("title matches too", matchCustomerRow(boardRows, proj("Diaz Kitchen"))?.id === "b2");
ok("done jobs never match", matchCustomerRow([boardRows[2]], proj("Jeff Hebard")) === null);
ok("no customer on the project -> no match", matchCustomerRow(boardRows, proj("")) === null);
ok("ambiguous (two active hits) -> no match", matchCustomerRow([
  boardRows[0], mkRow("b4", { customer: "Jeff Hebard", title: "Hebard Garage", stage: "lead" }),
], proj("Jeff Hebard")) === null);
ok("a row linked to a DIFFERENT field job never matches", matchCustomerRow([
  mkRow("b5", { customer: "Jeff Hebard", stage: "lead", fieldJobId: "other-project" }),
], proj("Jeff Hebard")) === null);
ok("a row linked to THIS field job still matches", matchCustomerRow([
  mkRow("b6", { customer: "Jeff Hebard", stage: "lead", fieldJobId: "fp-1" }),
], proj("Jeff Hebard"))?.id === "b6");
ok("milestones never match", matchCustomerRow([
  mkRow("b7", { customer: "Jeff Hebard", stage: "lead", isMilestone: true }),
], proj("Jeff Hebard")) === null);

/* ---------- boardRowFor: the batched list matcher ----------
   Same order as findBoardRow (fieldJobId -> claim # -> customer), against
   pre-fetched rows — used to stamp board stages onto the whole jobs list. */
const stageRows = [
  mkRow("s1", { customer: "Jeff Hebard", claimNo: "CL-77", stage: "in_progress", fieldJobId: "fp-A" }),
  mkRow("s2", { customer: "Ana Diaz", claimNo: "CL-88", stage: "scheduled", fieldJobId: "" }),
  mkRow("s3", { customer: "Sam Rowe", title: "Rowe Addition", stage: "lead", fieldJobId: "" }),
];
ok("explicit fieldJobId link wins", boardRowFor(stageRows, { id: "fp-A", customer: "Somebody Else" })?.id === "s1");
ok("claim # matches when unlinked", boardRowFor(stageRows, { id: "fp-B", claimNo: "cl 88" })?.id === "s2");
ok("customer-name fallback still applies", boardRowFor(stageRows, { id: "fp-C", customer: "Sam Rowe" })?.id === "s3");
ok("no match -> null", boardRowFor(stageRows, { id: "fp-D", customer: "Nobody", claimNo: "CL-99" }) === null);
ok("empty rows -> null", boardRowFor([], { id: "fp-A" }) === null && boardRowFor(null, { id: "fp-A" }) === null);
/* A restoration job converted to a recon job shares claim # + customer with
   it — the board tile belongs to the RECON job, so fallbacks must not bite. */
ok("converted restoration job never claim/customer-matches",
  boardRowFor(stageRows, { id: "fp-E", claimNo: "CL-88", customer: "Ana Diaz", linkedConstructionId: "fp-F" }) === null);
ok("converted restoration job still honors an explicit link",
  boardRowFor(stageRows, { id: "fp-A", linkedConstructionId: "fp-F" })?.id === "s1");

/* ---------- Phase 6: board tile -> field job adoption ----------
   Leads stay board-only; Scheduled / In Progress tiles with no matching
   job file (by link, claim, or customer — archived files count) get one. */
const tile = (id, data) => ({ id, data });
const T_ROWS = [
  tile("t1", { stage: "scheduled",   type: "remodel", customer: "Echo New", claimNo: "CL-300", phone: "907-555-2001",
               address: "5 Elm", contractValue: 22000, startDate: "2026-08-03", targetDate: "2026-09-12", rev: 2 }),
  tile("t2", { stage: "in_progress", type: "water", customer: "Foxtrot Water", rev: 0 }),
  tile("t3", { stage: "lead",        type: "remodel", customer: "Golf Lead" }),
  tile("t4", { stage: "scheduled",   type: "remodel", customer: "Hotel Marker", isMilestone: true }),
  tile("t5", { stage: "scheduled",   type: "remodel", customer: "India Linked", fieldJobId: "fp-x" }),
  tile("t6", { stage: "scheduled",   type: "remodel", customer: "Juliet Existing", claimNo: "CL-500" }),
  tile("t7", { stage: "scheduled",   type: "remodel", title: "Kilo Title Only" }),
];
const T_PROJECTS = [
  { id: "fp-j", customer: "Juliet Existing", claimNo: "CL-500" },
  { id: "fp-k", customer: "Kilo Title Only", archivedAt: "2026-06-01T00:00:00.000Z" },
];
const needs = tilesNeedingFieldFile(T_ROWS, T_PROJECTS);
ok("only real unlinked work needs a file", needs.map((r) => r.id).join(",") === "t1,t2");
ok("leads stay board-only", !needs.find((r) => r.id === "t3"));
ok("milestones never spawn a file", !needs.find((r) => r.id === "t4"));
ok("a tile that ever linked a job is respected (job may be deleted)", !needs.find((r) => r.id === "t5"));
ok("claim-match blocks creation", !needs.find((r) => r.id === "t6"));
ok("archived job files still block creation (title match)", !needs.find((r) => r.id === "t7"));
ok("tileCandidates matches claim tolerant of formatting", tileCandidates({ claimNo: "cl 500" }, T_PROJECTS)[0].id === "fp-j");
ok("tileCandidates empty for a blank tile", tileCandidates({}, T_PROJECTS).length === 0);

const blankSeed = () => ({ id: "x", jobType: "restoration", constructionType: "", customer: "", address: "",
  phone: "", claimNo: "", contractAmount: "", startDate: "", targetCompletion: "" });
const seedA = fieldSeedFromBoardJob(T_ROWS[0], blankSeed());
ok("seed id derives from the tile (idempotent across devices)", seedA.id === "bj-t1");
ok("remodel tile -> construction/remodel job", seedA.jobType === "construction" && seedA.constructionType === "remodel");
ok("header, money and dates carried into the seed",
  seedA.customer === "Echo New" && seedA.claimNo === "CL-300" && seedA.contractAmount === "22000" &&
  seedA.startDate === "2026-08-03" && seedA.targetCompletion === "2026-09-12");
const seedB = fieldSeedFromBoardJob(T_ROWS[1], blankSeed());
ok("water tile -> restoration job, no construction fields", seedB.jobType === "restoration" && !seedB.startDate && seedB.constructionType === "");
ok("title stands in for a missing customer", fieldSeedFromBoardJob(T_ROWS[6], blankSeed()).customer === "Kilo Title Only");

/* ---------- Phase 6: field restoration job -> a "water" tile in Leads ---------- */
const waterJob = boardJobFromProject({ id: "fp-w", customer: "Lima Wet", jobType: "restoration" }, null, NOW_ISO);
ok("water job lands as the board's Water Mitigation type", waterJob.type === "water");
ok("water job starts in Leads (no start date)", waterJob.stage === "lead");
ok("plan-less tile carries no phases or hours", waterJob.subtasks.length === 0 && waterJob.estimatedHours === "");

/* ============================================================
   Duplicate prevention + healing
   ============================================================ */

/* ---------- fuzzy identity: the matching that stops duplicates ---------- */
ok("nameLike: containment links 'Smith' to 'John Smith'", nameLike("Smith", "John Smith"));
ok("nameLike: tile title 'Hebard Rebuild' links to customer 'Jeff Hebard' via last name", nameLike("Hebard Rebuild", "Hebard"));
ok("nameLike: punctuation never blocks ('Smith — Kitchen')", nameLike("Smith — Kitchen", "smith kitchen"));
ok("nameLike: short fragments never link ('Jo')", !nameLike("Jo", "John Smith"));
ok("normAddr: '415 Birch Ln.' == '415 birch lane'", normAddr("415 Birch Ln.") === normAddr("415 birch lane"));
ok("normAddr: different numbers stay different", normAddr("415 Birch Ln") !== normAddr("417 Birch Ln"));
ok("work groups: water never matches remodel", !sameWorkGroup("water", "remodel"));
ok("work groups: fire matches water (both mitigation)", sameWorkGroup("fire", "water"));
ok("work groups: unknown/blank tile type is compatible with anything", sameWorkGroup("", "water") && sameWorkGroup("other", "remodel"));

const fuzzyRows = [
  mkRow("f1", { customer: "Jeff Hebard", title: "Hebard Rebuild", stage: "scheduled", type: "remodel" }),
  mkRow("f2", { customer: "", title: "Diaz — 12 Spruce Ct", address: "12 Spruce Court", stage: "lead", type: "remodel" }),
];
ok("partial-name match finds the hand-built tile", matchCustomerRow(fuzzyRows, { id: "fp-1", customer: "Hebard", jobType: "construction", constructionType: "remodel" })?.id === "f1");
ok("street-address match finds the tile when names differ", matchCustomerRow(fuzzyRows, { id: "fp-2", customer: "Ana Diaz Family Trust LLC totally different", address: "12 Spruce Ct.", jobType: "construction", constructionType: "remodel" })?.id === "f2");
ok("a water job never matches a remodel tile (groups fenced)",
  matchCustomerRow([mkRow("f3", { customer: "Jeff Hebard", stage: "scheduled", type: "remodel" })], { id: "fp-3", customer: "Jeff Hebard", jobType: "restoration" }) === null);
ok("two lookalikes -> refuse to guess", matchCustomerRow([
  fuzzyRows[0], mkRow("f4", { customer: "Jeff Hebard", title: "Hebard Garage", stage: "lead", type: "remodel" }),
], { id: "fp-4", customer: "Hebard", jobType: "construction", constructionType: "remodel" }) === null);
ok("looseCandidates surfaces every lookalike for the create-guard", looseCandidates([
  fuzzyRows[0], mkRow("f4", { customer: "Jeff Hebard", title: "Hebard Garage", stage: "lead", type: "remodel" }),
], { id: "fp-4", customer: "Hebard", jobType: "construction", constructionType: "remodel" }).length === 2);

/* ---------- duplicateTilePairs: find (machine dupe, hand-built keeper) ---------- */
const hand = mkRow("h1", {
  id: "h1", customer: "Jeff Hebard", title: "Hebard Rebuild", stage: "in_progress", type: "remodel",
  crewIds: ["c1", "c2"], startDate: "2026-07-01", targetDate: "2026-08-15", materials: "ordered", priority: "high",
  subtasks: [{ id: "st1", name: "Framing", durationDays: 3, crewIds: ["c1"] }],
  deps: [{ predId: "other-job", type: "FS", lagDays: 0 }],
  notes: "Owner wants cedar trim", contractValue: "", claimNo: "", phone: "", rev: 6,
});
const machine = mkRow("m1", {
  id: "m1", customer: "Hebard", title: "Hebard", stage: "lead", type: "remodel",
  crewIds: [], subtasks: [{ id: "st9", name: "Demo", estimatedHours: 16, lagDays: 0, crewIds: [] }],
  notes: "Pushed from the field app — WO 44", fieldJobId: "fp-9", claimNo: "CL-88", phone: "907-555-0101",
  contractValue: 48000, fieldActuals: { Demo: 12 }, rev: 1,
});
const pairs = duplicateTilePairs([hand, machine]);
ok("pairs a machine tile with its hand-built twin", pairs.length === 1 && pairs[0].keep.id === "h1" && pairs[0].dupe.id === "m1");
ok("no pairing when the keeper is done", duplicateTilePairs([mkRow("h2", { ...hand.data, stage: "done" }), machine]).length === 0);
ok("no pairing across work groups", duplicateTilePairs([mkRow("h3", { ...hand.data, type: "water" }), machine]).length === 0);
ok("two possible keepers -> refuse to guess", duplicateTilePairs([
  hand, mkRow("h4", { ...hand.data, id: "h4", title: "Hebard Garage" }), machine,
]).length === 0);
ok("two hand-built tiles alone never pair", duplicateTilePairs([hand, mkRow("h5", { ...hand.data, id: "h5" })]).length === 0);
ok("claim # mismatch on both sides blocks a name match", duplicateTilePairs([
  mkRow("h6", { ...hand.data, claimNo: "CL-1" }), mkRow("m2", { ...machine.data, claimNo: "CL-2" }),
]).length === 0);

/* ---------- mergeBoardTiles: nothing the coordinator built is lost ---------- */
const mergedTile = mergeBoardTiles(hand.data, machine.data, NOW_ISO);
ok("keeper's stage/dates/crew/materials/priority survive untouched",
  mergedTile.stage === "in_progress" && mergedTile.startDate === "2026-07-01" && mergedTile.targetDate === "2026-08-15" &&
  mergedTile.crewIds.join(",") === "c1,c2" && mergedTile.materials === "ordered" && mergedTile.priority === "high");
ok("keeper's phases and deps survive untouched",
  mergedTile.subtasks.length === 1 && mergedTile.subtasks[0].name === "Framing" && mergedTile.deps[0].predId === "other-job");
ok("keeper's notes survive; machine boilerplate is not appended",
  /cedar trim/.test(mergedTile.notes) && !/Pushed from the field app/.test(mergedTile.notes));
ok("field link, claim #, phone and contract value fill the keeper's blanks",
  mergedTile.fieldJobId === "fp-9" && mergedTile.claimNo === "CL-88" && mergedTile.phone === "907-555-0101" && mergedTile.contractValue === 48000);
ok("field actuals carry over", mergedTile.fieldActuals && mergedTile.fieldActuals.Demo === 12);
ok("the dupe's phase plan arrives as the standard proposal (never overwrites)",
  mergedTile.fieldPlanProposal && mergedTile.fieldPlanProposal.phases[0].name === "Demo" && mergedTile.fieldPlanProposal.from === "fp-9");
ok("stage only moves forward — a further-along dupe advances the keeper",
  mergeBoardTiles({ ...hand.data, stage: "lead" }, { ...machine.data, stage: "scheduled" }, NOW_ISO).stage === "scheduled");
const emptyKeeper = mergeBoardTiles({ id: "h9", stage: "scheduled", type: "remodel", crewIds: [], subtasks: [], notes: "", materials: "none", priority: "normal" }, machine.data, NOW_ISO);
ok("a phase-less keeper takes the dupe's phases directly", emptyKeeper.subtasks.length === 1 && emptyKeeper.subtasks[0].name === "Demo");
ok("human notes typed on the dupe ride along", /WO 55 gate code 1234/.test(
  mergeBoardTiles(hand.data, { ...machine.data, notes: "WO 55 gate code 1234" }, NOW_ISO).notes));

console.log(`\n${pass} board-bridge checks passed.`);
