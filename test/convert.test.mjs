/* Restoration → construction conversion test — pure logic, no DOM.
   Run: node apps/field/test/convert.test.mjs   (from repo root) */
import assert from "node:assert";
import { convertToConstruction, rebuildFacts } from "../js/convert.js";
import { jobType } from "../js/model.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Restoration → construction conversion");

function restorationJob() {
  return {
    id: "rest-1",
    customer: "Erica Swift", address: "1428 Badger Rd", phone: "907-555-0101", email: "e@x.com",
    carrier: "State Farm", adjuster: "Dan Page", claimNo: "02-0D9H-665",
    lossCause: "Water heater rupture", dateOfLoss: "2026-06-01",
    workOrderNo: "WO-118", waterCategory: "2", waterClass: "2", dryingSystem: "Closed",
    rooms: ["Utility", "Kitchen"],
    photos: [
      { id: "p1", src: "data:p1", room: "Utility", stage: "before", caption: "Water line at base", ts: "2026-06-01T10:00:00Z" },
      { id: "p2", src: "data:p2", room: "Kitchen", stage: "after", caption: "Dried to standard" },
      { id: "p3", src: "", stage: "during", caption: "broken photo — no src" },
    ],
    moistureMaps: [
      { label: "Utility", material: "Drywall", dryGoal: "1", sketch: "data:sketch1", floorPlan: "data:plan1",
        readings: [{ date: "2026-06-02", values: ["30"], notes: "Flood cut 2ft, utility wall" }] },
      { label: "Kitchen", material: "Subfloor", floorPlan: "data:plan2",
        readings: [{ date: "2026-06-02", values: ["24"], notes: "" }] },
    ],
    constructionLogs: [{ rows: [{ employee: "Mike", task: "Tear out wet carpet + pad", hours: "4" }] }],
    contents: [
      { name: "Area rug", qty: "1", category: "Décor", room: "Utility", disposition: "non-salvageable" },
      { name: "Toolbox", qty: "1", category: "Tools", room: "Utility", disposition: "salvageable" },
    ],
    changeOrders: [{ coNo: "CO-1", coDate: "2026-06-04", description: "Additional flood cut in kitchen" }],
    narrative: "Mitigation narrative text.",
    certDrying: { sigTech: "data:sig", issueDate: "2026-06-10" },
  };
}

/* ---------- conversion is a copy, not a mutation ---------- */
const rest = restorationJob();
const snapshot = JSON.stringify(rest);
const con = convertToConstruction(rest);

ok("original job untouched", JSON.stringify(rest) === snapshot);
ok("new job gets a fresh id", con.id && con.id !== rest.id);
ok("new job is construction", jobType(con) === "construction");
ok("construction type is reconstruction", con.constructionType === "reconstruction");
ok("back-link to the restoration job", con.linkedRestorationId === "rest-1");

/* header carries over; job-specific fields don't */
for (const k of ["customer", "address", "phone", "email", "carrier", "adjuster", "claimNo", "lossCause", "dateOfLoss"])
  ok(`header ${k} carried`, con[k] === rest[k]);
ok("work order NOT carried (new job, new WO)", con.workOrderNo === "");
ok("water classification NOT carried", con.waterCategory === "" && con.waterClass === "");
ok("rooms list carried as a copy", con.rooms.join() === "Utility,Kitchen" && con.rooms !== rest.rooms);

/* photos: mitigation record becomes the rebuild's "before" context */
ok("only photos with a src carry over", con.photos.length === 2);
ok("copied photos get fresh ids", con.photos.every((p) => p.id !== "p1" && p.id !== "p2"));
ok("copied photos are staged 'before'", con.photos.every((p) => p.stage === "before"));
ok("original stage preserved in caption", con.photos[1].caption === "Mitigation (after): Dried to standard");
ok("room carried on photos", con.photos[0].room === "Utility");

/* no Floor Plan form on this job → moisture-map sketches are the fallback source */
ok("scope of work pre-created with reference plans", !!con.scopeOfWork && con.scopeOfWork.referencePlans.length === 2);
ok("fallback: sketch preferred over raw map image", con.scopeOfWork.referencePlans[0] === "data:sketch1");
ok("fallback: map without sketch uses its floor-plan image", con.scopeOfWork.referencePlans[1] === "data:plan2");
ok("no floor-plan takeoff to carry", con.floorPlan === null || con.floorPlan === undefined);

/* ---------- the Floor Plan form is the preferred reference-plan source ---------- */
{
  const withPlan = restorationJob();
  withPlan.floorPlan = {
    createdAt: "x", mode: "upload", uploadedPages: ["data:fp-page1", "data:fp-page2"],
    dimensions: { rooms: [{ name: "Utility", dims: "10' x 8'", floorSF: "80", perimLF: "36", ceiling: "", notes: "", conf: 1 }], notes: [], at: "x" },
  };
  const c2 = convertToConstruction(withPlan);
  ok("floor-plan pages become the reference plans", c2.scopeOfWork.referencePlans.join() === "data:fp-page1,data:fp-page2");
  ok("moisture-map sketches stay out when a floor plan exists", !c2.scopeOfWork.referencePlans.includes("data:sketch1"));
  ok("plan takeoff dimensions carried to the rebuild", !!c2.floorPlan && c2.floorPlan.dimensions.rooms.length === 1 && c2.floorPlan.dimensions.rooms[0].floorSF === "80");
  ok("carried dimensions are a copy, not a shared reference", c2.floorPlan.dimensions !== withPlan.floorPlan.dimensions && c2.floorPlan.dimensions.rooms[0] !== withPlan.floorPlan.dimensions.rooms[0]);
  ok("no plan images duplicated onto the carried floor plan", c2.floorPlan.uploadedPages.length === 0);

  const legacy = restorationJob();
  legacy.floorPlan = { uploadedDoc: "data:fp-legacy" };
  ok("legacy single-page uploadedDoc shape works", convertToConstruction(legacy).scopeOfWork.referencePlans.join() === "data:fp-legacy");

  const emptyPlan = restorationJob();
  emptyPlan.floorPlan = { createdAt: "x", mode: "upload", uploadedPages: [] };
  ok("empty floor plan falls back to moisture maps", convertToConstruction(emptyPlan).scopeOfWork.referencePlans[0] === "data:sketch1");

  const bigPage = "data:image/jpeg;base64," + "x".repeat(1_000_000);
  const heavyFp = restorationJob();
  heavyFp.floorPlan = { uploadedPages: [bigPage, bigPage] };
  const hf = convertToConstruction(heavyFp);
  ok("floor-plan pages respect the byte budget", hf.scopeOfWork.referencePlans.length === 1 && hf.mitigationRef.plansLeftBehind === 1);
}

/* read-only mitigation reference */
ok("narrative carried into mitigationRef", con.mitigationRef.narrative === "Mitigation narrative text.");
ok("change orders summarized", con.mitigationRef.changeOrders.length === 1 && /kitchen/i.test(con.mitigationRef.changeOrders[0].description));
ok("mitigationRef records the source job", con.mitigationRef.fromProjectId === "rest-1");
ok("mitigationRef carries no images", !JSON.stringify(con.mitigationRef).includes("data:"));
ok("nothing left behind on a small job", con.mitigationRef.photosLeftBehind === 0 && con.mitigationRef.plansLeftBehind === 0);

/* rebuild forms start empty — the AI draft is review-before-apply */
ok("sub schedule not pre-created", con.subSchedule === null);
ok("selections not pre-created", con.selections === null);
ok("no water forms on the new job", con.moistureMaps.length === 0 && con.dryingLogs.length === 0 && con.certDrying === null);

/* ---------- media byte budgets (the blob must stay under sync's 5MB row cap) ---------- */
{
  const big = (mb) => "data:image/jpeg;base64," + "x".repeat(Math.round(mb * 1_000_000));
  const heavy = {
    id: "rest-3",
    photos: [
      { id: "a", src: big(1.2), stage: "before", ts: "2026-06-01T00:00:00Z" },
      { id: "b", src: big(1.2), stage: "after", ts: "2026-06-08T00:00:00Z" },
      { id: "c", src: big(1.2), stage: "after", ts: "2026-06-09T00:00:00Z" },
      { id: "d", src: big(1.2), stage: "during", ts: "2026-06-04T00:00:00Z" },
    ],
    moistureMaps: [{ sketch: big(1.0) }, { sketch: big(1.0) }],
  };
  const hc = convertToConstruction(heavy);
  ok("photo copy respects the byte budget", hc.photos.length === 2 && hc.mitigationRef.photosLeftBehind === 2);
  ok("end-state photos win the budget", hc.photos.every((p) => /after/.test(p.caption)));
  ok("plan copy respects the byte budget", hc.scopeOfWork.referencePlans.length === 1 && hc.mitigationRef.plansLeftBehind === 1);
  ok("converted blob stays well under the 5MB sync cap", JSON.stringify(hc).length < 5_000_000);
}

/* ---------- missing-data defaults ---------- */
const empty = convertToConstruction({ id: "rest-2" });
ok("empty job converts without throwing", empty.jobType === "construction" && empty.linkedRestorationId === "rest-2");
ok("no photos -> empty array", Array.isArray(empty.photos) && empty.photos.length === 0);
ok("no plans -> no pre-created scope", empty.scopeOfWork === null);
ok("null input converts safely", convertToConstruction(null).jobType === "construction");

/* ---------- rebuild fact pack ---------- */
const facts = rebuildFacts(rest);
ok("facts carry the job header", facts.job.insured === "Erica Swift" && facts.job.claim === "02-0D9H-665");
ok("facts carry affected areas", facts.affectedAreas.length === 2 && facts.affectedAreas[0].material === "Drywall");
ok("demo notes gathered from map notes + log tasks",
  facts.demoNotes.includes("Flood cut 2ft, utility wall") && facts.demoNotes.includes("Tear out wet carpet + pad"));
ok("contents loss grouped by room (non-salvageable only)",
  facts.contentsLoss.length === 1 && facts.contentsLoss[0].room === "Utility" && facts.contentsLoss[0].items.length === 1);
ok("change orders in the pack", facts.changeOrders.length === 1);
ok("narrative in the pack", facts.narrative === "Mitigation narrative text.");
ok("empty job yields safe facts", rebuildFacts({}).demoNotes.length === 0 && rebuildFacts(null).contentsLoss.length === 0);

console.log(`\n${pass} conversion checks passed.`);
