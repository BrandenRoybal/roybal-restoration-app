/* Site Visit estimator — the client's pure helpers (no DOM, no network).
   Run: node apps/field/test/sitevisit.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { siteFilePath, packetForDraft, packetReady, draftNotesText, applySiteDraft, siteVisitOf, newSiteVisit, frameTimes, frameCaption, FRAMES_PER_VIDEO } from "../js/sitevisit.js";
import { FORMS, formsFor } from "../js/model.js";
import { subRatesText, SUB_RATES } from "../js/pricing.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Site Visit estimator");

test("storage paths stay inside sitevisit/<job>/ whatever the file is called", () => {
  assert.equal(siteFilePath("3f2a-11", "f-1", "Fuller Crawlspace Report.pdf"), "sitevisit/3f2a-11/f-1-Fuller_Crawlspace_Report.pdf");
  assert.equal(siteFilePath("j", "f", "../../etc/passwd"), "sitevisit/j/f-etc_passwd");
  assert.equal(siteFilePath("j", "f", "Walk 9·23 ☃.m4a"), "sitevisit/j/f-Walk_9_23_.m4a");
  assert.equal(siteFilePath("j", "f", ""), "sitevisit/j/f-file");
  const long = siteFilePath("j", "f", "x".repeat(500) + ".pdf");
  assert.ok(long.length < 160 && long.endsWith(".pdf"));
});

test("the draft packet carries paths and labels by kind, never file bytes", () => {
  const sv = newSiteVisit();
  sv.files.push(
    { id: "1", kind: "report", name: "Magicplan.pdf", path: "sitevisit/j/1-Magicplan.pdf", mime: "application/pdf", size: 9e6 },
    { id: "2", kind: "photos", name: "a.jpg", path: "sitevisit/j/2-a.jpg", mime: "image/jpeg" },
    { id: "3", kind: "notes", name: "p1.jpg", path: "sitevisit/j/3-p1.jpg", mime: "image/jpeg" },
    { id: "4", kind: "audio", name: "walk.m4a", path: "sitevisit/j/4-walk.m4a", mime: "audio/mp4" },
    { id: "5", kind: "photos", name: "lost", path: "" });
  sv.transcript = "[00:05] start in the kitchen"; sv.typedScope = "Rebuild kitchen";
  const p = packetForDraft(sv);
  assert.deepEqual(p.reports.map((f) => f.path), ["sitevisit/j/1-Magicplan.pdf"]);
  assert.deepEqual(p.photos.map((f) => f.path), ["sitevisit/j/2-a.jpg"]);
  assert.deepEqual(p.notes.map((f) => f.path), ["sitevisit/j/3-p1.jpg"]);
  assert.equal(p.transcript, "[00:05] start in the kitchen");
  assert.equal(JSON.stringify(p).includes("walk.m4a"), false);   // the audio itself is never sent to the draft
  assert.equal(packetReady(sv), true);
  assert.equal(packetReady(newSiteVisit()), false);
});

test("siteVisitOf repairs a missing or damaged packet", () => {
  const p = {};
  assert.deepEqual(siteVisitOf(p).files, []);
  const q = { siteVisit: { files: "nope", typedScope: "keep" } };
  assert.deepEqual(siteVisitOf(q).files, []);
  assert.equal(q.siteVisit.typedScope, "keep");
});

const DRAFT = {
  lossSummary: "Rebuild the kitchen after the dishwasher leak.",
  items: [
    { room: "Kitchen", desc: "Drywall - hung, taped, floated", qty: 112, unit: "SF", price: 3.1, priced: "catalog", code: "1/2", basis: "Magicplan p.3" },
    { room: "Kitchen", desc: "Vinyl plank", qty: 138.6, unit: "SF", price: 7.5, priced: "estimate", basis: "walk 14:20" },
    { room: "Main Level", desc: "Labor minimum", qty: 3, unit: "SF", priced: "flag", priceFlag: "hourly rate on an SF line" },
  ],
  rooms: [{ name: "Kitchen", customerSummary: "New drywall on the sink wall and a new vinyl plank floor." }],
  assumptions: ["Home is unoccupied during work"], exclusions: ["Mold testing"], questions: ["Dishwasher reset or replace?"],
  pricingNotes: "Fairbanks freight adds lead time.",
};

test("a finished draft fills the estimate and reports how it was priced", () => {
  const inv = { items: [{ desc: "old" }], notes: "", lossSummary: "" };
  const sum = applySiteDraft(inv, DRAFT, "2026-09-23T04:00:00Z");
  assert.deepEqual(sum, { lines: 3, fromCatalog: 1, flagged: 1, questions: 1, alternates: 0 });
  assert.equal(inv.items.length, 3);
  assert.ok(inv.items.every((it) => it.id));
  assert.equal(inv.items[0].qty, "112");
  assert.equal(inv.items[2].price, "");
  assert.equal(inv.items[2].flag, "hourly rate on an SF line");
  assert.equal(inv.lossSummary, DRAFT.lossSummary);
  assert.deepEqual(inv.customerScope, [{ room: "Kitchen", summary: "New drywall on the sink wall and a new vinyl plank floor." }]);
  assert.deepEqual(inv.siteVisitDraft.questions, ["Dishwasher reset or replace?"]);
  assert.match(inv.notes, /^ASSUMPTIONS\n• Home is unoccupied during work\n\nEXCLUSIONS\n• Mold testing\n\nPRICING BASIS\nFairbanks freight adds lead time\.$/);
});

test("a redraft replaces its own notes block and keeps what the user typed", () => {
  const inv = { items: [], notes: "Owner supplies the tile." };
  applySiteDraft(inv, DRAFT);
  assert.ok(inv.notes.startsWith("Owner supplies the tile.\n\nASSUMPTIONS"));
  applySiteDraft(inv, { ...DRAFT, exclusions: ["Permits"] });
  assert.equal((inv.notes.match(/ASSUMPTIONS/g) || []).length, 1);
  assert.ok(inv.notes.includes("• Permits") && !inv.notes.includes("Mold testing"));
  assert.ok(inv.notes.startsWith("Owner supplies the tile."));
});

test("a construction draft carries who does each line, the alternates, contingency and 10 & 10 with subs", () => {
  const inv = { items: [], notes: "", opAuto: true, opMode: "pct", overheadPct: "0", profitPct: "0" };
  const sum = applySiteDraft(inv, {
    ...DRAFT,
    items: [
      { room: "10 — Plumbing", desc: "Break-area sink rough-in & trim", qty: 12, unit: "HR", price: 200, by: "Plumbing & heating sub", priced: "estimate" },
      { room: "04 — Framing & carpentry", desc: "Partitions, labor", qty: 35, unit: "HR", price: 125, by: "Roybal", priced: "estimate" },
    ],
    alternates: [{ title: "Keep and patch the existing tile", description: "Deducts tile removal and LVP.", baseCost: -3708 }],
    contingencyPct: 15, accuracyPct: 25, duration: "7-9 weeks",
  });
  assert.equal(sum.alternates, 1);
  assert.deepEqual(inv.items.map((it) => it.by), ["Plumbing & heating sub", "Roybal"]);
  assert.deepEqual(inv.alternates, [{ title: "Keep and patch the existing tile", description: "Deducts tile removal and LVP.", baseCost: "-3708" }]);
  assert.equal(inv.contingencyPct, "15");
  assert.equal(inv.accuracyPct, "25");
  assert.equal(inv.duration, "7-9 weeks");
  assert.equal(inv.overheadPct, "10");
  assert.equal(inv.profitPct, "10");
  // an O&P the owner already set by hand is left alone; a Roybal-only draft doesn't force 10 & 10
  const manual = { items: [], opAuto: false, overheadPct: "5", profitPct: "5" };
  applySiteDraft(manual, { ...DRAFT, items: [{ desc: "x", by: "Electrical sub" }] });
  assert.equal(manual.overheadPct, "5");
  const own = { items: [], opAuto: true, overheadPct: "0", profitPct: "0" };
  applySiteDraft(own, { ...DRAFT, items: [{ desc: "x", by: "Roybal" }, { desc: "y", by: "Allowance" }] });
  assert.equal(own.overheadPct, "0");
});

test("the rates sent with every draft name the company and each sub with a price", () => {
  const lines = subRatesText().split("\n");
  assert.equal(lines.length, SUB_RATES.length);
  assert.ok(lines.every((l) => /^[^|]+ \| [^|]+ \| \$\d+(\.\d+)?\/(HR|SF)/.test(l)), lines.join("\n"));
  assert.ok(lines[0].startsWith("Roybal | "));
  // trades only: a named sub in a signed estimate makes every sub swap a change order
  assert.ok(SUB_RATES.slice(1).every((r) => / sub$/.test(r.by)), SUB_RATES.map((r) => r.by).join(", "));
  assert.doesNotMatch(subRatesText(), /AK 49|FBX|Graham/i);
});

test("an empty draft section leaves no empty heading", () => {
  assert.equal(draftNotesText({ assumptions: [], exclusions: ["Permits"], pricingNotes: "" }), "EXCLUSIONS\n• Permits");
});

test("estimates are available on construction jobs too", () => {
  const est = FORMS.find((f) => f.key === "reconEstimates");
  assert.deepEqual(est.types.slice().sort(), ["construction", "restoration"]);
  assert.ok(formsFor({ jobType: "construction" }).some((f) => f.key === "reconEstimates"));
});

test("a Magicplan clip gives evenly spaced stills, never the first or last instant", () => {
  const t = frameTimes(28.07);
  assert.equal(t.length, FRAMES_PER_VIDEO);
  assert.ok(t[0] > 0 && t[t.length - 1] < 28.07);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.05, "even spacing");
  assert.deepEqual(frameTimes(3), [0.75, 2.25]);         // short clip: about one every 2 s
  assert.deepEqual(frameTimes(0.5), [0.25]);
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.deepEqual(frameTimes(bad), []);
  assert.equal(frameCaption("Kitchen.mp4", 65.4), "still at 1:05 from Magicplan video Kitchen.mp4");
});

test("video stills go to the draft as photos; the clip itself never does", () => {
  const sv = newSiteVisit();
  sv.files.push(
    { kind: "photos", path: "sitevisit/j/p.jpg", mime: "image/jpeg" },
    { kind: "videos", id: "v1", name: "Break room.mp4", frames: 2 },
    { kind: "frames", videoId: "v1", path: "sitevisit/j/f1.jpg", mime: "image/jpeg", caption: frameCaption("Break room.mp4", 3.5) },
    { kind: "frames", videoId: "v1", path: "sitevisit/j/f2.jpg", mime: "image/jpeg", caption: frameCaption("Break room.mp4", 10.5) });
  const p = packetForDraft(sv);
  assert.deepEqual(p.photos.map((f) => f.path), ["sitevisit/j/p.jpg", "sitevisit/j/f1.jpg", "sitevisit/j/f2.jpg"]);
  assert.equal(p.photos[1].caption, "still at 0:03 from Magicplan video Break room.mp4");
  assert.equal(packetReady({ files: [{ kind: "videos", name: "x.mp4" }] }), false);   // a clip with no stills is nothing to read
});

console.log(`\n${pass} site-visit tests passed`);
