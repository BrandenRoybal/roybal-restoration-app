/* Job-type mode test — pure logic, no DOM, no network, no AI.
   Run: node apps/field/test/mode.test.mjs   (from repo root) */
import assert from "node:assert";
import { FORMS, formsFor, jobType, newProject } from "../js/model.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Job-type mode");

/* jobType helper — legacy jobs have no jobType and must read as restoration */
ok("missing jobType reads as restoration (legacy jobs)", jobType({}) === "restoration");
ok("null project reads as restoration", jobType(null) === "restoration");
ok("explicit construction reads as construction", jobType({ jobType: "construction" }) === "construction");
ok("unknown value falls back to restoration", jobType({ jobType: "remodel" }) === "restoration");
ok("newProject defaults to restoration", jobType(newProject()) === "restoration");

/* formsFor — filters the registry by job kind */
const keys = (list) => list.map((f) => f.key);
const rest = keys(formsFor({}));
const con = keys(formsFor({ jobType: "construction" }));

ok("restoration sees the moisture map", rest.includes("moistureMaps"));
ok("restoration sees the drying log", rest.includes("dryingLogs"));
ok("restoration sees the cert of drying", rest.includes("certDrying"));
ok("construction hides the moisture map", !con.includes("moistureMaps"));
ok("construction hides the drying log", !con.includes("dryingLogs"));
ok("construction hides the cert of drying", !con.includes("certDrying"));
for (const k of ["photos", "contents", "workAuth", "constructionLogs", "laborLog", "changeOrders", "invoices"])
  ok(`${k} is shared by both kinds`, rest.includes(k) && con.includes(k));

/* the construction form set is construction-only */
for (const k of ["scopeOfWork", "preConChecklist", "selections", "subSchedule", "inspections", "punchList", "drawSchedule", "certCompletion"])
  ok(`${k} is construction-only`, con.includes(k) && !rest.includes(k));

ok("every registry entry declares its types", FORMS.every((f) => Array.isArray(f.types) && f.types.length));

/* a job switched between kinds never hides forms that hold data —
   tiles, packet, and old bookmarks all keep showing the documents */
const flipped = { jobType: "construction", moistureMaps: [{ id: "m1" }], certDrying: { sigTech: "data:sig" } };
const flippedKeys = keys(formsFor(flipped));
ok("switched job keeps its moisture maps visible", flippedKeys.includes("moistureMaps"));
ok("switched job keeps its cert of drying visible", flippedKeys.includes("certDrying"));
ok("switched job still hides data-free water forms", !flippedKeys.includes("dryingLogs"));

/* backward-safety contract: an entry without `types` shows for both kinds */
FORMS.push({ key: "__untyped__", name: "tmp" });
ok("entry without types shows for both kinds",
  keys(formsFor({})).includes("__untyped__") && keys(formsFor({ jobType: "construction" })).includes("__untyped__"));
FORMS.pop();

/* new construction header fields exist with safe blank defaults */
const p = newProject();
for (const k of ["constructionType", "contractAmount", "startDate", "targetCompletion", "permitNumbers", "lender", "linkedRestorationId"])
  ok(`newProject has blank ${k}`, p[k] === "");
ok("newProject has an inspections array", Array.isArray(p.inspections));
for (const k of ["scopeOfWork", "preConChecklist", "selections", "subSchedule", "punchList", "drawSchedule", "certCompletion"])
  ok(`newProject has null ${k}`, p[k] === null);

console.log(`\n${pass} checks passed.`);
