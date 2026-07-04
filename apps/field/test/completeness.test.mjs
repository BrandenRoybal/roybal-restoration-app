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

console.log(`\n${pass} checks passed.`);
