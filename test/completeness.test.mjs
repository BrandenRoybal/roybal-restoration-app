/* Completeness engine test — pure logic, no DOM, no network, no AI.
   Run: node apps/field/test/completeness.test.mjs   (from repo root) */
import assert from "node:assert";
import { evaluateProject, summaryLine } from "../js/completeness.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

/* A fully documented Cat 2 water-mit job (no contents add-on). */
function completeJob() {
  return {
    waterCategory: "2", waterClass: "2",
    workAuth: { ownerSig: "data:sig", ownerName: "Jane Owner", ownerDate: "2026-06-20" },
    moistureMaps: [{ material: "Drywall", dryGoal: "1", floorPlan: "data:img",
      readings: [{ date: "2026-06-21", values: ["12", "", ""] }] }],
    dryingLogs: [{
      readings: [{ date: "2026-06-21", outT: "38", outRH: "70", affT: "72", affRH: "55", gd: "30" }],
      equipment: [{ type: "air_mover", location: "Living Room", placed: "2026-06-20", removed: "2026-06-25" }],
    }],
    photos: [
      { stage: "before", caption: "LR water line at baseboard" },
      { stage: "during", caption: "Air movers placed" },
      { stage: "after", caption: "LR dried to standard" },
    ],
    certDrying: { sigTech: "data:sig", verification: [{ material: "Drywall", goal: "1", final: "0.8" }] },
    constructionLogs: [{ rows: [{ employee: "Mike", task: "Demo", hours: "6" }] }],
    laborLog: { syncedAt: "2026-06-22T00:00:00Z",
      entries: [{ date: "2026-06-21", employee: "Mike", start: "8:00", finish: "14:00", hours: "6", task: "Demo" }] },
    contents: [], changeOrders: [],
  };
}

/* A Cat 3 job mid-drying with real gaps: missing affected RH, no 'after' photo,
   an uncaptioned photo, no cert sign-off, and no Cat 3 justification. */
function incompleteCat3() {
  const j = completeJob();
  j.waterCategory = "3";
  j.dryingLogs[0].readings[0].affRH = "";          // missing affected RH
  j.photos = [{ stage: "before", caption: "" }];    // no after photo + missing caption
  j.certDrying = { sigTech: "", verification: [{ material: "Drywall", goal: "1", final: "" }] };
  return j;                                          // cat3 justification not present
}

console.log("Completeness engine");

const a = evaluateProject(completeJob());
ok("complete Cat 2 job is billable", a.isBillable === true);
ok("complete job has zero hard gaps", a.hardGaps.length === 0);
ok("complete job did NOT trigger the contents add-on", a.conditions.contents === false);
ok("summary reads ready", /ready to bill/i.test(summaryLine(a)));

const b = evaluateProject(incompleteCat3());
ok("incomplete Cat 3 job is NOT billable", b.isBillable === false);
ok("Cat 3 add-on auto-detected", b.conditions.cat3 === true);
const gapIds = b.hardGaps.map((g) => g.id);
ok("flags missing affected RH", gapIds.includes("dl_affRH"));
ok("flags missing 'after' photo", gapIds.includes("ph_after"));
ok("flags missing photo caption", gapIds.includes("ph_caption"));
ok("flags missing cert final reading", gapIds.includes("cd_final"));
ok("flags missing tech sign-off", gapIds.includes("cd_sig"));
ok("flags missing Cat 3 justification", gapIds.includes("c3_just"));
ok("does NOT raise contents gaps (add-on inactive)", !gapIds.some((id) => id.startsWith("ct_")));

/* Turning on the contents add-on should now demand room + disposition. */
const c = evaluateProject({ ...completeJob(), contents: [{ name: "Sofa" /* no room/disposition */ }] });
ok("contents add-on activates room/disposition gaps", c.hardGaps.some((g) => g.id === "ct_room"));

/* Billing labor comes from the QuickBooks Time Labor Log, NOT the Daily
   Construction Log — a job with construction logs but no synced hours blocks. */
const d = evaluateProject({ ...completeJob(), laborLog: null });
ok("no labor log blocks billing even with construction logs", d.isBillable === false);
ok("flags missing QuickBooks Time hours", d.hardGaps.some((g) => g.id === "ll_hours"));
const e = evaluateProject({ ...completeJob(), constructionLogs: [] });
ok("construction logs no longer gate billing", e.isBillable === true);

/* ---------- construction jobs check their own matrix ---------- */
function completeConstructionJob() {
  return {
    jobType: "construction",
    preConChecklist: { items: { 0: true, 2: true }, permits: [{ type: "Building", number: "B26-1042" }] },
    scopeOfWork: { areas: [{ name: "Kitchen", items: [{ trade: "Drywall", desc: "Hang + finish 320 sqft" }] }], allowances: [] },
    photos: [{ stage: "before", caption: "Kitchen before demo" }, { stage: "after", caption: "Finished kitchen" }],
    inspections: [{ type: "Final / CO", result: "pass" }],
    selections: { rows: [{ item: "Cabinets", status: "installed" }] },
    punchList: { rows: [{ item: "Touch-up paint", status: "verified" }] },
    drawSchedule: { rows: [{ desc: "Final", invoicedDate: "2026-07-01", paidDate: "2026-07-05" }] },
    certCompletion: { sigContractor: "data:sig", sigOwner: "data:sig" },
  };
}
const f = evaluateProject(completeConstructionJob());
ok("complete construction job is ready to close", f.isBillable === true);
ok("complete construction job has zero hard gaps", f.hardGaps.length === 0);

const g = evaluateProject({ jobType: "construction" });
ok("bare construction job is blocked", g.isBillable === false);
const gIds = g.hardGaps.map((x) => x.id);
ok("blocked on contract", gIds.includes("pc_contract"));
ok("blocked on permits", gIds.includes("pc_permits"));
ok("blocked on scope", gIds.includes("sc_items"));
ok("blocked on punch list", gIds.includes("pu_clear"));
ok("blocked on cert of completion", gIds.includes("cc_sig"));
ok("no water rules leak into construction", !gIds.some((id) => id.startsWith("mm_") || id.startsWith("dl_") || id.startsWith("cd_")));

const i = evaluateProject({ ...completeConstructionJob(),
  inspections: [{ type: "Framing", result: "fail", reinspection: "" }] });
ok("failed inspection without reinspection blocks", i.hardGaps.some((x) => x.id === "in_fail"));

const j = evaluateProject({ ...completeConstructionJob(),
  punchList: { rows: [{ item: "Door adjust", status: "open" }] } });
ok("open punch item blocks closeout", j.hardGaps.some((x) => x.id === "pu_clear"));

/* permits satisfied by a permit number even if the checkbox wasn't ticked */
const k = evaluateProject({ ...completeConstructionJob(),
  preConChecklist: { items: { 0: true }, permits: [{ type: "Building", number: "B26-1042" }] } });
ok("permit row with a number satisfies the permit gate", !k.hardGaps.some((x) => x.id === "pc_permits"));

/* restoration jobs are untouched by the construction matrix */
const l = evaluateProject({ ...completeJob(), certDrying: null });   // break a water rule
ok("restoration job still checks the water matrix", l.hardGaps.some((x) => x.id === "cd_sig"));
ok("no construction rules leak into restoration", !l.hardGaps.some((x) => x.id.startsWith("pc_") || x.id.startsWith("cc_") || x.id.startsWith("pu_")));

console.log(`\n${pass} checks passed.`);
