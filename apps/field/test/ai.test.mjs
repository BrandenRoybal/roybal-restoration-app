/* AI capture helpers — pure-logic test. No network, no AI, no secrets.
   Covers the candidate->model.js mapping (the contract the Edge Function
   returns and Step D writes back) and the spend-cap / cost arithmetic
   (which mirrors the roybal-ai-ingest Edge Function).
   Run: node apps/field/test/ai.test.mjs   (from repo root) */
import assert from "node:assert";
import {
  candidateChips, confidenceTone, LOW_CONFIDENCE,
  estimateCost, sumUsd, isOverCap, applyChips,
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

console.log(`\n${pass} checks passed.`);
