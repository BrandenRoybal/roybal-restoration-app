/* isBlankProject — the guard that lets deletes reclaim repeat-tap scaffolds
   while ANY real content keeps the never-lose-work protection.
   Run: node test/blank.test.mjs */
import { newProject, newPhoto, isBlankProject, setAuthor } from "../js/model.js";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

ok(isBlankProject(newProject()), "a fresh + New Job scaffold is blank");

// Phase 1: a signed-in device stamps createdBy/by on fresh captures. Blank
// detection must still treat a stamped-but-empty scaffold as blank (so repeat-
// tap reclaim keeps working per person), while one real capture still counts.
setAuthor("tech@roybalconstruction.com");
ok(isBlankProject(newProject()), "a fresh scaffold stamped with an author is still blank");
const stamped = newProject();
stamped.photos.push(newPhoto());
ok(!isBlankProject(stamped), "one authored photo makes a scaffold non-blank");
setAuthor("");

const cons = newProject();
cons.jobType = "construction";
ok(isBlankProject(cons), "a fresh construction-mode scaffold is blank too");

const arch = newProject();
arch.archivedAt = new Date().toISOString();
ok(isBlankProject(arch), "archivedAt alone doesn't count as content");

ok(isBlankProject({ id: "x" }), "a bare {id} blob is blank");
ok(!isBlankProject(null) && !isBlankProject("nope"), "non-objects are never blank");

const named = newProject();
named.customer = "J";
ok(!isBlankProject(named), "one letter of a customer name is content");

const photo = newProject();
photo.photos.push(newPhoto());
ok(!isBlankProject(photo), "a photo entry is content (even before its image loads)");

const receipt = newProject();
receipt.receipts.push({ id: "r1", vendor: "", amount: 0 });
ok(!isBlankProject(receipt), "a receipt row is content (amount 0 still counts)");

const form = newProject();
form.workAuth = { id: "wa", signedAt: "", customerSig: "" };
ok(isBlankProject(form), "an opened-but-untouched form (all-empty object) stays blank");
form.workAuth.signedAt = "2026-08-01";
ok(!isBlankProject(form), "…but one filled field in it is content");

const log = newProject();
log.dryingLogs.push({ id: "d1" });
ok(!isBlankProject(log), "a drying log entry is content");

console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL BLANK CHECKS PASSED"));
process.exit(failures ? 1 : 0);
