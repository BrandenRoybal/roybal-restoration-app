/* Construction narrative — pure facts builder. No DOM, no network, no AI.
   Verifies narrativeFacts() digests the documented job into the structured
   facts the model writes from. Run: node apps/field/test/narrative.test.mjs */
import assert from "node:assert";
import { narrativeFacts, constructionFacts } from "../js/narrative.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

/* A documented Cat 1 / Class 1 job (modeled on the Swift narrative). */
function job() {
  return {
    customer: "Erica Swift", address: "2400 Maria St, Fairbanks, AK 99709",
    carrier: "State Farm", claimNo: "02-0D9H-665", adjuster: "Akeem Oso",
    dateOfLoss: "2026-05-29", lossCause: "Water heater rupture",
    waterCategory: "1", waterClass: "1", dryingSystem: "Closed", workOrderNo: "SWIFT5-29-26",
    moistureMaps: [{
      label: "Utility Room", material: "Drywall", dryGoal: "≤ 1%",
      readings: [
        { date: "2026-06-03", values: ["28", "30", "", ""] },
        { date: "2026-06-08", values: ["0.8", "0.9", "", ""] },
      ],
    }],
    dryingLogs: [{
      readings: [{ date: "2026-06-03", gd: "10" }, { date: "2026-06-08", gd: "40" }],
      equipment: [
        { type: "lgr_dehumidifier", location: "Utility", placed: "2026-06-03", removed: "2026-06-08" },
        { type: "air_mover", location: "Utility", placed: "2026-06-03", removed: "2026-06-08" },
        { type: "air_mover", location: "Kitchen", placed: "2026-06-03", removed: "2026-06-08" },
      ],
    }],
    certDrying: {
      issueDate: "2026-06-15", dryingDays: "6", dryStart: "2026-06-03", dryComplete: "2026-06-08",
      sigTech: "data:sig",
      verification: [{ material: "Drywall", goal: "1", final: "0.8", dry: true }],
    },
    constructionLogs: [{ rows: [{ employee: "Mike", task: "Flood cut", hours: "6" }, { employee: "Jake", task: "Flood cut", hours: "4" }] }],
    changeOrders: [],
    photos: [{ stage: "before" }, { stage: "before" }, { stage: "after" }],
  };
}

console.log("Construction narrative — facts");
const f = narrativeFacts(job());

/* ---------- job header ---------- */
ok("insured + claim carried", f.job.insured === "Erica Swift" && f.job.claim === "02-0D9H-665");
ok("water category/class carried", f.job.waterCategory === "1" && f.job.waterClass === "1");
ok("loss cause + carrier carried", f.job.lossCause === "Water heater rupture" && f.job.carrier === "State Farm");

/* ---------- affected areas (moisture maps, wet -> dry) ---------- */
ok("one affected area extracted", f.affectedAreas.length === 1 && f.affectedAreas[0].material === "Drywall");
ok("first reading max MC% = 30", f.affectedAreas[0].firstReading.maxMC === 30);
ok("last reading max MC% = 0.9 (dried)", f.affectedAreas[0].lastReading.maxMC === 0.9);

/* ---------- equipment summary (counts + unit-days) ---------- */
const am = f.equipment.find((e) => e.type === "air_mover");
const lgr = f.equipment.find((e) => e.type === "lgr_dehumidifier");
ok("2 air movers aggregated", am && am.units === 2);
ok("air-mover unit-days = 2 units x 5 days = 10", am.unitDays === 10);
ok("1 LGR dehumidifier, 5 unit-days", lgr && lgr.units === 1 && lgr.unitDays === 5);
ok("equipment locations collected", am.locations.includes("Utility") && am.locations.includes("Kitchen"));

/* ---------- drying window + grain depression trend ---------- */
ok("drying window from cert", f.drying.start === "2026-06-03" && f.drying.finish === "2026-06-08");
ok("drying days from cert (6)", f.drying.days === 6);
ok("grain depression trend 10 -> 40", f.drying.firstGrainDepression === 10 && f.drying.lastGrainDepression === 40);

/* ---------- certificate ---------- */
ok("certified true + date", f.certificate.certified === true && f.certificate.certDate === "2026-06-15");
ok("verification row dry", f.certificate.verification[0].material === "Drywall" && f.certificate.verification[0].dry === true);

/* ---------- scope (construction logs) ---------- */
ok("tasks + crew aggregated", f.scope.tasks.includes("Flood cut") && f.scope.crew.length === 2);
ok("total crew hours summed", f.scope.totalHours === 10);

/* ---------- photos ---------- */
ok("photo stage counts", f.photos.before === 2 && f.photos.after === 1);

/* ---------- robustness: empty project doesn't throw ---------- */
const e = narrativeFacts({});
ok("empty project -> safe empty facts", e.affectedAreas.length === 0 && e.equipment.length === 0 && e.certificate === null);

/* ============================================================
   constructionFacts — the construction-job digest (Phase 4)
   ============================================================ */
console.log("\nConstruction facts");
const cjob = {
  customer: "Hansen", address: "415 Birch Ln", workOrderNo: "WO-201",
  constructionType: "remodel", contractAmount: "48000",
  startDate: "2026-07-01", targetCompletion: "2026-09-15", permitNumbers: "B26-1042", lender: "MACS FCU",
  scopeOfWork: { areas: [
    { name: "Kitchen", items: [{ trade: "Drywall", desc: "Hang + finish", qty: "320", unit: "SF" }, { trade: "", desc: "" }] },
  ] },
  subSchedule: { rows: [{ trade: "Drywall", company: "AK Interiors", status: "on-site", schedStart: "2026-07-13", schedEnd: "2026-07-17" }] },
  inspections: [{ type: "Rough Electrical", result: "pass" }, { type: "Insulation", result: "fail", reinspection: "2026-07-20" }],
  selections: { rows: [
    { item: "Faucet", area: "Kitchen", status: "pending", allowance: "250", actual: "" },
    { item: "Flooring", status: "installed", allowance: "2000", actual: "2600" },
  ] },
  punchList: { rows: [{ item: "Touch-up", status: "open" }, { item: "Adjust door", status: "done" }] },
  drawSchedule: { rows: [{ desc: "Rough-in", pct: "25", amount: "12000", invoicedDate: "2026-07-10", paidDate: "" }] },
  constructionLogs: [{ date: "2026-07-14", rows: [{ employee: "Mike", task: "Hang drywall", hours: "8" }] }],
  changeOrders: [{ coNo: "CO-1", description: "Added outlet run" }],
  photos: [{ stage: "before" }],
  mitigationRef: { fromProjectId: "rest-1" },
};
const CNOW = new Date("2026-07-15T12:00:00").getTime();
const cf = constructionFacts(cjob, CNOW);
ok("job header carried", cf.job.owner === "Hansen" && cf.job.contractAmount === "48000" && cf.job.permits === "B26-1042");
ok("scope digested as compact strings", cf.scope.length === 1 && /Drywall — Hang \+ finish — 320 SF/.test(cf.scope[0].items[0]));
ok("blank scope items dropped", cf.scope[0].items.length === 1);
ok("schedule rows carried", cf.schedule.length === 1 && cf.schedule[0].status === "on-site");
ok("inspections carried with reinspection", cf.inspections.length === 2 && cf.inspections[1].reinspection === "2026-07-20");
ok("pending selections listed by name", cf.selections.pending.length === 1 && cf.selections.pending[0] === "Kitchen: Faucet");
/* only DECIDED rows count — the pending Faucet (blank actual) is an open
   decision, not $250 of savings */
ok("net over-allowance counts decided rows only", cf.selections.netOverAllowance === 600);
ok("punch open/total", cf.punch.open === 1 && cf.punch.total === 2);
ok("invoiced-unpaid draw counted", cf.draws.invoicedUnpaid === 1 && cf.draws.rows.length === 1);
ok("daily work summary rides along", cf.dailyWork.totalHours === 8 && cf.dailyWork.crew.includes("Mike"));
ok("recent work is DATED so 'this week' means something",
  cf.recentWork.length === 1 && cf.recentWork[0].date === "2026-07-14" &&
  cf.recentWork[0].tasks.includes("Hang drywall") && cf.recentWork[0].hours === 8);
/* an old log falls out of the recent window */
const oldJob = { ...cjob, constructionLogs: [{ date: "2026-06-01", rows: [{ task: "Demo", hours: "6" }] }] };
ok("logs older than 14 days drop out of recentWork", constructionFacts(oldJob, CNOW).recentWork.length === 0);
ok("converted job notes its mitigation origin", cf.convertedFrom !== null);
ok("empty construction job -> safe facts",
  constructionFacts({}).scope.length === 0 && constructionFacts(null).punch.total === 0);

console.log(`\n${pass} checks passed.`);
