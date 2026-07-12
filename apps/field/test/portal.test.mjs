/* Customer portal projection — the privacy boundary is the whole point:
   portalProjection(project) must expose ONLY curated, customer-safe fields
   and never any internal data. Run: node apps/field/test/portal.test.mjs */
import assert from "node:assert";
import { portalProjection, portalMilestones, portalShareLink, newShareToken } from "../js/portal.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Customer portal projection");

/* a job stuffed with sensitive internal data + two photos, one shared */
const project = {
  id: "job-1",
  customer: "Erica Swift", address: "1428 Badger Rd",
  phone: "907-555-0101", email: "e@x.com",
  carrier: "State Farm", adjuster: "Dan Page", claimNo: "02-0D9H-665",
  contractAmount: "48000", lossCause: "Water heater rupture",
  narrative: "Internal construction narrative with margins.",
  photos: [
    { id: "p1", src: "data:image/jpeg;base64,SHAREDPHOTO", caption: "Kitchen after", stage: "after" },
    { id: "p2", src: "data:image/jpeg;base64,PRIVATEPHOTO", caption: "internal", stage: "during" },
  ],
  invoices: [{ invoiceNo: "1001", items: [{ desc: "labor", price: "125" }], contractAmount: "48000" }],
  reconEstimates: [{ invoiceNo: "E1", items: [{ desc: "drywall", price: "999" }] }],
  constructionLogs: [{ date: "2026-07-10", notes: "CREW ISSUE: subfloor rot", materials: "extra lumber" }],
  moistureMaps: [{ readings: [{ notes: "flood cut 2ft" }] }],
  changeOrders: [{ description: "supplement $5000" }],
  portalShare: { id: "ps-1", enabled: true, shareToken: "tok", status: "drying", sharedPhotoIds: ["p1"] },
};

const proj = portalProjection(project);
const json = JSON.stringify(proj);

/* ---------- it exposes the safe fields ---------- */
ok("customer name + address exposed", proj.customer_name === "Erica Swift" && proj.property_address === "1428 Badger Rd");
ok("status + label exposed", proj.status === "drying" && proj.statusLabel === "Structural drying");
ok("milestone timeline built", Array.isArray(proj.milestones) && proj.milestones.length >= 5);
ok("only the shared photo is included", proj.photos.length === 1 && proj.photos[0].id === "p1");
ok("shared photo carries caption + stage", proj.photos[0].caption === "Kitchen after" && proj.photos[0].stage === "after");

/* ---------- THE PRIVACY BOUNDARY: nothing internal leaks ---------- */
const FORBIDDEN = [
  "State Farm", "Dan Page", "02-0D9H-665",   // carrier / adjuster / claim
  "48000", "999", "125",                       // dollar amounts / costs
  "margins", "narrative",                       // internal narrative
  "CREW ISSUE", "subfloor rot", "lumber",       // Field Report internals
  "flood cut", "supplement",                    // moisture notes / change orders
  "PRIVATEPHOTO",                               // the un-shared photo
  "e@x.com", "907-555-0101",                    // contact details not in the projection
];
for (const needle of FORBIDDEN)
  ok(`internal data never leaks: "${needle}"`, !json.includes(needle));

ok("projection keys are the curated set only",
  Object.keys(proj).sort().join(",") === "customer_name,milestones,photos,property_address,status,statusLabel");

/* ---------- milestone states ---------- */
const ms = portalMilestones("drying");
const cur = ms.find((m) => m.state === "current");
ok("current milestone marked", cur && cur.key === "drying");
ok("earlier milestones are done", ms.find((m) => m.key === "mitigation").state === "done");
ok("later milestones are upcoming", ms.find((m) => m.key === "complete").state === "upcoming");
ok("unknown status -> all upcoming", portalMilestones("").every((m) => m.state === "upcoming"));

/* ---------- link + token ---------- */
ok("share link points at the portal subdomain", portalShareLink("abc123") === "https://portal.roybalconstruction.com/j/abc123");
ok("empty token -> no link", portalShareLink("") === "");
const t1 = newShareToken(), t2 = newShareToken();
ok("share token is long, hex, unguessable, unique", /^[0-9a-f]{48}$/.test(t1) && t1 !== t2);

/* ---------- empty / disabled safety ---------- */
ok("no shared photos when none selected", portalProjection({ ...project, portalShare: { sharedPhotoIds: [] } }).photos.length === 0);
ok("null job -> safe empty projection", portalProjection(null).customer_name === "" && portalProjection(null).photos.length === 0);

console.log(`\n${pass} portal checks passed.`);
