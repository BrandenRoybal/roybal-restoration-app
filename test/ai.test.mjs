/* AI capture helpers — pure-logic test. No network, no AI, no secrets.
   Covers the candidate->model.js mapping (the contract the Edge Function
   returns and Step D writes back) and the spend-cap / cost arithmetic
   (which mirrors the roybal-ai-ingest Edge Function).
   Run: node apps/field/test/ai.test.mjs   (from repo root) */
import assert from "node:assert";
import {
  candidateChips, confidenceTone, LOW_CONFIDENCE,
  estimateCost, sumUsd, isOverCap, applyChips,
  rebuildChips, applyRebuildChips,
} from "../js/ai.js";

/* stub blank-row / photo factories (voice.js supplies the real model.js ones) */
const mk = {
  row: (g) =>
    g === "readings"  ? { date: "2026-06-25", values: ["", "", ""], affT: "", affRH: "", outT: "", outRH: "", refT: "", refRH: "" }
  : g === "equipment" ? { asset: "", type: "", location: "", placed: "", removed: "", hours: "" }
  :                     { employee: "", task: "", start: "", finish: "", hours: "" },
  photo: () => ({ id: "p1", src: "", caption: "", room: "", stage: "during" }),
};

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const find = (chips, group, field) => chips.find((c) => c.target.group === group && c.target.field === field);

console.log("AI capture helpers");

/* ---------- confidence -> chip tone ---------- */
ok("high confidence is green", confidenceTone(0.95) === "green");
ok("low confidence is amber", confidenceTone(LOW_CONFIDENCE - 0.01) === "amber");
ok("missing confidence is amber (tech should check)", confidenceTone(undefined) === "amber");

/* ---------- Drying Log: psychrometric + equipment -> model.js fields ---------- */
const dl = candidateChips("dryingLogs", {
  form_key: "dryingLogs",
  psychrometric: [
    { location: "affected", temp: 72, rh: 55, confidence: 0.93 },
    { location: "outside", temp: 38, rh: 70, confidence: 0.6 },
  ],
  equipment: [{ type: "air_mover", count: 2, location: "living room", placed: "2026-06-20", confidence: 0.95 }],
  unmapped: ["musty smell"],
});
ok("affected temp -> affT", find(dl, "readings", "affT")?.value === 72);
ok("affected RH -> affRH", find(dl, "readings", "affRH")?.value === 55);
ok("outside temp -> outT", find(dl, "readings", "outT")?.value === 38);
ok("outside RH -> outRH", find(dl, "readings", "outRH")?.value === 70);
ok("low-confidence outside reading renders amber", find(dl, "readings", "outT")?.tone === "amber");
ok("affected reading renders green", find(dl, "readings", "affT")?.tone === "green");
ok("equipment type -> equipment.type", find(dl, "equipment", "type")?.value === "air_mover");
ok("equipment location -> equipment.location", find(dl, "equipment", "location")?.value === "living room");
ok("equipment placed -> equipment.placed", find(dl, "equipment", "placed")?.value === "2026-06-20");
ok("equipment count rides along on the type chip", find(dl, "equipment", "type")?.target.meta?.count === 2);
ok("unmapped psychro location is ignored, not mismapped", !dl.some((c) => c.value === undefined));

/* ---------- Moisture Map ---------- */
const mm = candidateChips("moistureMaps", {
  form_key: "moistureMaps", label: "Kitchen", material: "drywall", dryGoal: 1,
  readings: [{ location: "south wall", mc_pct: 28.5, confidence: 0.9 }],
});
ok("moisture material -> material", find(mm, null, "material")?.value === "drywall");
ok("moisture dry goal -> dryGoal", find(mm, null, "dryGoal")?.value === 1);
ok("MC% reading -> values + carries location", find(mm, "readings", "values")?.target.meta?.location === "south wall");

/* ---------- Photos ---------- */
const ph = candidateChips("photos", {
  form_key: "photos",
  photos: [{ stage: "before", room: "kitchen", caption: "water line at baseboard", confidence: 0.9 }],
});
ok("photo stage -> stage (index 0)", find(ph, null, "stage")?.value === "before" && find(ph, null, "stage")?.target.meta?.index === 0);
ok("photo caption -> caption", find(ph, null, "caption")?.value === "water line at baseboard");

/* ---------- Daily Construction Log ---------- */
const cl = candidateChips("constructionLogs", {
  form_key: "constructionLogs",
  rows: [{ employee: "Jake", task: "flood cut", start: "08:00", finish: "12:00", hours: 4, confidence: 0.9 }],
  notes: "containment up",
});
ok("crew member -> rows.employee", find(cl, "rows", "employee")?.value === "Jake");
ok("hours -> rows.hours", find(cl, "rows", "hours")?.value === 4);
ok("log notes -> notes", find(cl, null, "notes")?.value === "containment up");

/* ---------- empties & unknown form_key ---------- */
ok("empty candidates -> no chips", candidateChips("dryingLogs", {}).length === 0);
ok("unknown form_key -> no chips", candidateChips("bogus", { x: 1 }).length === 0);

/* ---------- cost arithmetic (mirrors the Edge Function) ---------- */
const c = estimateCost({
  audioSeconds: 60, sttPricePerMin: 0.0043,
  inputTokens: 1000, outputTokens: 500,
  llmPriceInPerMTok: 1.0, llmPriceOutPerMTok: 5.0,
});
ok("STT cost = minutes * per-min rate", Math.abs(c.sttCost - 0.0043) < 1e-9);
ok("LLM cost = tokens/1e6 * price (in+out)", Math.abs(c.llmCost - (0.001 * 1.0 + 0.0005 * 5.0)) < 1e-9);
ok("total = stt + llm", Math.abs(c.total - (c.sttCost + c.llmCost)) < 1e-9);
ok("a daily voice log lands well under 5 cents", c.total < 0.05);
ok("transcript-only (no audio) costs no STT", estimateCost({ inputTokens: 800, outputTokens: 300, llmPriceInPerMTok: 1, llmPriceOutPerMTok: 5 }).sttCost === 0);

/* ---------- spend cap ---------- */
const rows = [{ cost_usd: 49.98 }, { cost_usd: 0.03 }, { cost_usd: "0.01" }];
ok("sumUsd totals the ledger (coerces strings)", Math.abs(sumUsd(rows) - 50.02) < 1e-9);
ok("at/over cap blocks new spend", isOverCap(50.02, 50) === true);
ok("under cap allows spend", isOverCap(49.0, 50) === false);
ok("exactly at cap blocks (hard ceiling)", isOverCap(50, 50) === true);
ok("cap of 0/unset never blocks", isOverCap(123, 0) === false);

/* ---------- write-back: candidate chips -> model.js project blob ---------- */
console.log("  -- write-back (applyChips) --");

/* Drying Log: reuse the form's initial blank rows; psychro -> one reading row,
   equipment -> one equipment row. */
const dlInstance = { readings: [mk.row("readings")], equipment: [mk.row("equipment")] };
const dlOut = applyChips("dryingLogs", dlInstance, {}, candidateChips("dryingLogs", {
  psychrometric: [{ location: "affected", temp: 72, rh: 55, confidence: 0.9 }, { location: "outside", temp: 38, rh: 70, confidence: 0.9 }],
  equipment: [{ type: "air_mover", location: "living room", placed: "2026-06-25", confidence: 0.9 }],
}), mk);
ok("drying psychro fills ONE reading row (no duplicate rows)", dlInstance.readings.length === 1);
ok("affT written", dlInstance.readings[0].affT === 72);
ok("outRH written", dlInstance.readings[0].outRH === 70);
ok("equipment reuses the blank equip row", dlInstance.equipment.length === 1 && dlInstance.equipment[0].type === "air_mover");
ok("equipment placed written", dlInstance.equipment[0].placed === "2026-06-25");

/* A second voice capture should APPEND, not clobber the now-filled row. */
applyChips("dryingLogs", dlInstance, {}, candidateChips("dryingLogs", {
  psychrometric: [{ location: "affected", temp: 70, rh: 50, confidence: 0.9 }],
}), mk);
ok("second capture appends a new reading row", dlInstance.readings.length === 2 && dlInstance.readings[1].affT === 70);

/* Moisture Map: instance-level material/dryGoal + MC% into the values grid. */
const mmInstance = { material: "", dryGoal: "", readings: [mk.row("readings")] };
applyChips("moistureMaps", mmInstance, {}, candidateChips("moistureMaps", {
  material: "drywall", dryGoal: 1, readings: [{ location: "south wall", mc_pct: 28.5, confidence: 0.9 }],
}), mk);
ok("moisture material set on instance", mmInstance.material === "drywall");
ok("moisture dry goal set on instance", mmInstance.dryGoal === 1);
ok("MC% lands in the values grid", mmInstance.readings[0].values.includes(28.5));

/* Construction Log: per-row crew/task/hours, grouped by row index. */
const clInstance = { rows: [mk.row("rows")] };
applyChips("constructionLogs", clInstance, {}, candidateChips("constructionLogs", {
  rows: [{ employee: "Jake", task: "flood cut", hours: 4, confidence: 0.9 }],
  notes: "containment up",
}), mk);
ok("construction crew written to row", clInstance.rows[0].employee === "Jake");
ok("construction hours written to row", clInstance.rows[0].hours === 4);
ok("construction notes set on instance", clInstance.notes === "containment up");

/* Photos: each candidate photo becomes a new project.photos entry. */
const proj = { photos: [] };
applyChips("photos", null, proj, candidateChips("photos", {
  photos: [
    { stage: "before", room: "kitchen", caption: "water line", confidence: 0.9 },
    { stage: "after", room: "kitchen", caption: "dried out", confidence: 0.9 },
  ],
}), mk);
ok("two candidate photos -> two project.photos entries", proj.photos.length === 2);
ok("photo stage/caption mapped", proj.photos[0].stage === "before" && proj.photos[0].caption === "water line");

/* Unchecked chips (confirmed=false) are skipped. */
const skipInstance = { rows: [mk.row("rows")] };
const someChips = candidateChips("constructionLogs", { rows: [{ employee: "Sam", hours: 8, confidence: 0.9 }] });
someChips.forEach((c) => { if (c.target.field === "hours") c.confirmed = false; });
const skipOut = applyChips("constructionLogs", skipInstance, {}, someChips, mk);
ok("unchecked chip is not applied", skipInstance.rows[0].employee === "Sam" && !has2(skipInstance.rows[0].hours));
ok("applied count reflects only confirmed chips", skipOut.applied === 1);

function has2(v) { return v !== undefined && v !== null && String(v).trim() !== ""; }

/* ============================================================
   Construction voice-capture chips (Phase 4)
   ============================================================ */
{
  const punch = candidateChips("punchList", { rows: [
    { area: "Master Bath", item: "Door casing scratched", trade: "Paint", priority: "normal", confidence: 0.9 },
    { area: "Kitchen", item: "Cabinet handle missing", trade: "Cabinets / Counters", confidence: 0.8 },
  ] });
  ok("punch rows -> chips per stated field", punch.length === 7);
  const inst = { rows: [{ area: "", item: "", trade: "", priority: "normal", status: "open", photos: [] }] };
  const mkC = { row: () => ({ area: "", item: "", trade: "", priority: "normal", status: "open", photos: [] }) };
  applyChips("punchList", inst, {}, punch, mkC);
  ok("two punch rows written (blank reused + one appended)",
    inst.rows.length === 2 && inst.rows[0].item === "Door casing scratched" && inst.rows[1].area === "Kitchen");
  ok("punch row keeps its defaults", inst.rows[0].status === "open" && Array.isArray(inst.rows[0].photos));

  const subs = candidateChips("subSchedule", { rows: [
    { trade: "Drywall", company: "AK Interiors", schedStart: "2026-07-20", status: "scheduled", confidence: 0.85 },
  ] });
  const subInst = { rows: [{ trade: "", company: "", status: "scheduled" }] };
  applyChips("subSchedule", subInst, {}, subs, { row: () => ({ trade: "", company: "", status: "scheduled" }) });
  ok("sub schedule row written", subInst.rows.length === 1 && subInst.rows[0].company === "AK Interiors" &&
    subInst.rows[0].schedStart === "2026-07-20");

  const insp = candidateChips("inspections", {
    type: "Framing", scheduled: "2026-07-22", result: "fail", corrections: "Add hurricane clips at ridge", confidence: 0.9,
  });
  ok("inspection chips are instance-level", insp.every((c) => c.target.group === null));
  const inspInst = { type: "", result: "", corrections: "" };
  applyChips("inspections", inspInst, {}, insp, {});
  ok("inspection fields written", inspInst.type === "Framing" && inspInst.result === "fail" &&
    /hurricane clips/.test(inspInst.corrections));

  const sels = candidateChips("selections", { rows: [
    { area: "Kitchen", item: "Faucet", spec: "Moen brushed nickel", allowance: 250, confidence: 0.6 },
  ] });
  ok("low-confidence selection chips are amber", sels.every((c) => c.tone === "amber"));
  const selInst = { rows: [{ area: "", item: "", spec: "", status: "pending" }] };
  applyChips("selections", selInst, {}, sels, { row: () => ({ area: "", item: "", spec: "", status: "pending" }) });
  ok("selection row written with allowance", selInst.rows[0].item === "Faucet" && String(selInst.rows[0].allowance) === "250");

  const co = candidateChips("changeOrders", {
    description: "Found rot in the subfloor behind the tub",
    daysAdded: 2,
    items: [{ desc: "Sister two floor joists + new underlayment", qty: 1, unit: "LS", price: 1800, confidence: 0.7 }],
    confidence: 0.85,
  });
  const coInst = { description: "", daysAdded: "", items: [{ room: "", desc: "", qty: "", unit: "", price: "" }] };
  applyChips("changeOrders", coInst, {}, co, { row: () => ({ room: "", desc: "", qty: "", unit: "", price: "" }) });
  ok("change order description + days written", /rot in the subfloor/.test(coInst.description) && String(coInst.daysAdded) === "2");
  ok("change order line item written into items[]",
    coInst.items.length === 1 && /Sister two floor joists/.test(coInst.items[0].desc) && String(coInst.items[0].price) === "1800");
}

/* ============================================================
   Rebuild draft chips (Phase 3: restoration → construction)
   ============================================================ */
const DRAFT = {
  scopeAreas: [
    { area: "Utility", items: [
      { trade: "Drywall", desc: "Hang, tape and finish lower 2 ft of walls", qty: 64, unit: "SF", confidence: 0.9 },
      { trade: "Paint", desc: "Prime and paint patched walls", qty: 0, unit: "SF", confidence: 0.5 },
    ] },
    { area: "Kitchen", items: [
      { trade: "Flooring", desc: "Replace vinyl flooring", qty: 120, unit: "SF", confidence: 0.85 },
    ] },
  ],
  tradeSequence: [
    { trade: "Drywall", note: "after rough-in check" },
    { trade: "Paint", note: "" },
    { trade: "Flooring", note: "last — dust done" },
  ],
  selections: [{ area: "Kitchen", item: "Vinyl flooring", spec: "match existing", confidence: 0.6 }],
  questions: ["Confirm subfloor condition under the vinyl"],
};

const rchips = rebuildChips(DRAFT);
ok("one chip per scope line + trade + selection", rchips.length === 3 + 3 + 1);
ok("scope chip labels area + trade", rchips[0].label === "Utility — Drywall");
ok("scope chip value shows qty/unit", /64 SF/.test(rchips[0].value));
ok("low-confidence scope chip is amber", rchips.find((c) => /Prime and paint/.test(String(c.target.meta.desc))).tone === "amber");
ok("selection chip carries spec in meta", rchips[6].target.meta.spec === "match existing");
ok("empty draft -> no chips", rebuildChips(null).length === 0 && rebuildChips({}).length === 0);

/* apply into a bare construction project via factories */
const rmk = {
  scope: () => ({ areas: [{ name: "", items: [{ trade: "", desc: "", qty: "", unit: "", notes: "" }] }], allowances: [], referencePlans: [] }),
  scopeArea: () => ({ name: "", items: [] }),
  scopeItem: () => ({ trade: "", desc: "", qty: "", unit: "", notes: "" }),
  subSchedule: () => ({ rows: [{ trade: "", company: "", status: "scheduled", notes: "" }] }),
  subRow: () => ({ trade: "", company: "", status: "scheduled", notes: "" }),
  selections: () => ({ rows: [{ area: "", item: "", spec: "", status: "pending" }] }),
  selectionRow: () => ({ area: "", item: "", spec: "", status: "pending" }),
};
const conProj = {};
const rout = applyRebuildChips(conProj, rchips, rmk);
ok("all confirmed chips applied", rout.applied === 7);
ok("scope created with two areas", conProj.scopeOfWork.areas.length === 2);
ok("factory blank area reused (no empty leftover)", conProj.scopeOfWork.areas[0].name === "Utility");
ok("scope items land under their area", conProj.scopeOfWork.areas[0].items.length === 2 &&
  conProj.scopeOfWork.areas[0].items[0].desc === "Hang, tape and finish lower 2 ft of walls");
ok("qty stored as string for the form inputs", conProj.scopeOfWork.areas[0].items[0].qty === "64");
ok("trade sequence fills the sub schedule in order", conProj.subSchedule.rows.map((r) => r.trade).join() === "Drywall,Paint,Flooring");
ok("trade note lands in row notes", conProj.subSchedule.rows[0].notes === "after rough-in check");
ok("selection lands pending with spec", conProj.selections.rows[0].item === "Vinyl flooring" &&
  conProj.selections.rows[0].status === "pending" && conProj.selections.rows[0].spec === "match existing");

/* unchecked chips are skipped; existing scope area is reused, not duplicated */
const conProj2 = { scopeOfWork: { areas: [{ name: "Utility", items: [] }], allowances: [] } };
const rchips2 = rebuildChips(DRAFT);
rchips2.forEach((c) => { if (c.target.group !== "scopeItems") c.confirmed = false; });
const rout2 = applyRebuildChips(conProj2, rchips2, rmk);
ok("only scope chips applied when others unchecked", rout2.applied === 3);
ok("existing area matched case-insensitively (no duplicate)",
  conProj2.scopeOfWork.areas.filter((a) => a.name.toLowerCase() === "utility").length === 1);
ok("subSchedule untouched when its chips are unchecked", conProj2.subSchedule === undefined);

/* the schema's qty-0-means-unknown sentinel never reaches the form */
const paintChip = rchips.find((c) => /Prime and paint/.test(String(c.target.meta.desc)));
ok("qty 0 chip shows no quantity", !/\(0/.test(String(paintChip.value)));
ok("qty 0 lands blank in the scope item",
  conProj.scopeOfWork.areas[0].items[1].qty === "" && conProj.scopeOfWork.areas[0].items[1].unit === "");

/* off-list trades coerce to "Other" and keep the model's wording in notes */
const oddDraft = {
  scopeAreas: [{ area: "Garage", items: [{ trade: "Concrete Polishing", desc: "Polish slab", qty: 200, unit: "SF", confidence: 0.9 }] }],
  tradeSequence: [{ trade: "Concrete Polishing", note: "last" }],
  selections: [], questions: [],
};
const oddProj = {};
applyRebuildChips(oddProj, rebuildChips(oddDraft), { ...rmk, trades: ["Demo", "Drywall", "Other"] });
ok("off-list scope trade coerced to Other", oddProj.scopeOfWork.areas[0].items[0].trade === "Other");
ok("original trade wording kept in scope notes", oddProj.scopeOfWork.areas[0].items[0].notes === "Concrete Polishing");
ok("off-list sub trade coerced with note", oddProj.subSchedule.rows[0].trade === "Other" &&
  /Concrete Polishing/.test(oddProj.subSchedule.rows[0].notes) && /last/.test(oddProj.subSchedule.rows[0].notes));
/* without a trades list, values pass through untouched */
const passProj = {};
applyRebuildChips(passProj, rebuildChips(oddDraft), rmk);
ok("no trades list -> trade passes through", passProj.scopeOfWork.areas[0].items[0].trade === "Concrete Polishing");

console.log(`\n${pass} checks passed.`);
