/* Job Board bridge test — pure mapping/matching logic only (the network
   functions are browser-only and fail-safe).
   Run: node apps/field/test/boardpush.test.mjs   (from repo root) */
import assert from "node:assert";
import {
  planPhases, boardJobFromProject, mergePlanIntoBoardJob,
  rollupActuals, historyDigest, phasesToSubRows, isoDateOnly, matchCustomerRow,
  boardRowFor,
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

console.log(`\n${pass} board-bridge checks passed.`);
