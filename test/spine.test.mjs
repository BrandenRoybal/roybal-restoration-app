/* Spine pure-logic test — mapping + claim matching. No network.
   (The live unified_jobs upsert is verified against Supabase, not here.)
   Run: node apps/field/test/spine.test.mjs   (from repo root) */
import assert from "node:assert";
import { toUnifiedRow, normClaim, matchCoordinationId } from "../js/spine.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Spine crosswalk");

/* toUnifiedRow maps blob -> typed columns, blanks -> null */
const row = toUnifiedRow({
  id: "fp-1", claimNo: "ABC-123", carrier: "State Farm", adjuster: "",
  address: "123 Main", customer: "Jane", phone: "", email: "j@x.com",
  waterCategory: "3", waterClass: "2", dateOfLoss: "2026-06-20",
}, "co-9");
ok("maps field_project_id", row.field_project_id === "fp-1");
ok("maps coordination_job_id", row.coordination_job_id === "co-9");
ok("maps claim/carrier", row.claim_number === "ABC-123" && row.insurance_carrier === "State Farm");
ok("blank string -> null (adjuster)", row.adjuster_name === null);
ok("water category carried as string", row.water_category === "3");
ok("loss_type defaults to water", row.loss_type === "water");
ok("legacy job (no jobType) is water", toUnifiedRow({ id: "fp-2" }).loss_type === "water");
ok("construction job carries loss_type construction",
  toUnifiedRow({ id: "fp-3", jobType: "construction" }).loss_type === "construction");

/* normClaim is tolerant of formatting */
ok("normClaim strips spaces/dashes/case", normClaim(" abc-1 2_3 ") === "ABC123");
ok("normClaim empty -> ''", normClaim(null) === "");

/* matchCoordinationId finds the right Board job by claim # */
const coordRows = [
  { id: "co-1", data: { claimNo: "ZZZ-000" } },
  { id: "co-2", data: { claimNumber: "abc 1 2 3" } },   // different field name + formatting
  { id: "co-3", data: { title: "no claim" } },
];
ok("matches across formatting + alt field name", matchCoordinationId(coordRows, "ABC-123") === "co-2");
ok("no match -> null", matchCoordinationId(coordRows, "QQQ-999") === null);
ok("empty claim -> null", matchCoordinationId(coordRows, "") === null);
ok("handles empty rows", matchCoordinationId([], "ABC-123") === null);

console.log(`\n${pass} checks passed.`);
