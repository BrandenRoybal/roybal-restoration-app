/* Site Visit estimator — the client's pure helpers (no DOM, no network).
   Run: node apps/field/test/sitevisit.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { siteFilePath, packetForDraft, packetReady, draftNotesText, applySiteDraft, siteVisitOf, newSiteVisit, frameTimes, frameCaption, FRAMES_PER_VIDEO, KINDS, MAX_IMAGES,
  pricingCounts, pricingSummary, pricedTag, customerText, hasReferenceLines, draftText, scanBasisNotes } from "../js/sitevisit.js";
import { FORMS, formsFor } from "../js/model.js";
import { subRatesText, SUB_RATES } from "../js/pricing.js";
import { estimateDocumentXml } from "../js/docx.js";
import { portalProjection } from "../js/portal.js";

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
  assert.deepEqual(sum, { lines: 3, fromCatalog: 1, fromReference: 0, flagged: 1, questions: 1, alternates: 0 });
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

/* ---------- the private Xactimate reference (owner/office drafts only) ----------
   Synthetic codes and prices only: this repo is public. */
const REF_NOTE = "Xactimate reference from your past estimates: 3 line(s) on 2 estimate(s), TESTLIST_JAN26, range $1.00–$2.00 — review";
const REF_DRAFT = {
  ...DRAFT,
  lossSummary: "Rebuild the kitchen after the dishwasher leak.",
  items: [
    { room: "Kitchen", desc: "Test wall finish", qty: 40, unit: "SF", price: 1.5, priced: "catalog", code: "TST1", basis: "walk 02:10" },
    { room: "Kitchen", desc: "Test trim piece", qty: 22, unit: "LF", price: 1.75, priced: "reference", code: "ZZZ", catalogDesc: "Test trim piece", refNote: REF_NOTE, basis: "Magicplan p.2" },
    { room: "Kitchen", desc: "Test fixture", qty: 1, unit: "EA", price: 90, priced: "estimate", basis: "photo 4" },
  ],
};

test("a reference-priced line keeps its price, provenance and refNote, and is counted on its own", () => {
  const inv = { items: [], notes: "" };
  const sum = applySiteDraft(inv, REF_DRAFT, "2026-09-28T04:00:00Z");
  assert.deepEqual(sum, { lines: 3, fromCatalog: 1, fromReference: 1, flagged: 0, questions: 1, alternates: 0 });
  const ref = inv.items[1];
  assert.equal(ref.priced, "reference");
  assert.equal(ref.price, "1.75");
  assert.equal(ref.code, "ZZZ");
  assert.equal(ref.refNote, REF_NOTE);
  assert.equal("refNote" in inv.items[0], false, "only reference lines carry a refNote");
  assert.deepEqual(inv.siteVisitDraft.basis[1], { desc: "Test trim piece", basis: "Magicplan p.2", priced: "reference", refNote: REF_NOTE });
  assert.deepEqual(inv.siteVisitDraft.basis[0], { desc: "Test wall finish", basis: "walk 02:10", priced: "catalog" });
});

test("the draft-basis summary counts reference lines separately; without any it reads as before", () => {
  const none = pricingCounts(DRAFT.items);
  assert.deepEqual(none, { lines: 3, fromCatalog: 1, fromReference: 0, flagged: 1, estimates: 1 });
  assert.equal(pricingSummary(none),
    "1 of 3 lines priced from the Fairbanks list; the rest are estimates — verify those. ⚠️ 1 needs attention (blank price).");
  const withRef = { lines: 30, fromCatalog: 12, fromReference: 6, flagged: 0, estimates: 12 };
  assert.equal(pricingSummary(withRef),
    "12 of 30 lines priced from the Fairbanks list, 6 from your past Xactimate estimates (review), 12 estimates — verify those.");
  assert.deepEqual(pricingCounts(REF_DRAFT.items), { lines: 3, fromCatalog: 1, fromReference: 1, flagged: 0, estimates: 1 });
  assert.deepEqual(pricingCounts(undefined), { lines: 0, fromCatalog: 0, fromReference: 0, flagged: 0, estimates: 0 });
});

test("each provenance gets its own label and colour; the reference tag carries the refNote as its title", () => {
  const [cat, ref, est] = REF_DRAFT.items.map(pricedTag);
  const flag = pricedTag(DRAFT.items[2]);
  assert.deepEqual(cat, { text: "Fairbanks TST1", color: "#1f9d55" });
  assert.deepEqual(ref, { text: "Xactimate ref $1.75 · review", color: "var(--navy-3)", title: REF_NOTE });
  assert.deepEqual(est, { text: "est.", color: "#c9760b" });
  assert.deepEqual(flag, { text: "⚠️ hourly rate on an SF line", color: "#c0392b" });
  assert.equal(new Set([cat.color, ref.color, est.color, flag.color]).size, 4, "four distinct colours");
  assert.equal(pricedTag({ priced: "reference", price: "" }).text, "Xactimate ref · review");   // no price, no "$NaN"
  assert.equal(pricedTag({ priced: "flag", flag: "stored flag" }).text, "⚠️ stored flag");  // an item's saved flag reads too
});

test("a reference line's refNote never reaches what the customer sees: notes, scope, Word file, portal", () => {
  const inv = { items: [], notes: "", invoiceNo: "RC-TEST-1", opMode: "pct" };
  applySiteDraft(inv, REF_DRAFT, "2026-09-28T04:00:00Z");
  const customerFacing = [
    inv.notes, inv.lossSummary, JSON.stringify(inv.customerScope), JSON.stringify(inv.alternates),
    estimateDocumentXml({ customer: "Test Customer", address: "1 Test St" }, inv, { isBuild: false }),
    JSON.stringify(portalProjection({ customer: "Test Customer", reconEstimates: [inv], portalShare: { status: "estimate" } })),
  ];
  for (const text of customerFacing) {
    assert.ok(!text.includes(REF_NOTE), "refNote leaked: " + text.slice(0, 120));
    assert.doesNotMatch(text, /xactimate|reference|refNote|TESTLIST/i);
  }
  // the QuickBooks push builds its lines from room/desc/qty/unit/price only
  const qbo = readFileSync(new URL("../js/qbo.js", import.meta.url), "utf8");
  assert.doesNotMatch(qbo, /refNote|\.priced\b|siteVisitDraft/);
});

test("draft prose that names the reference source is dropped sentence by sentence; everything else is kept verbatim", () => {
  assert.equal(customerText("Fairbanks list, $3.21/SF for 1/2\" drywall. Owner supplies tile."), "Fairbanks list, $3.21/SF for 1/2\" drywall. Owner supplies tile.");
  assert.equal(customerText("Priced at $3.21 per SF. Trim priced from past Xactimate estimates. Freight adds lead time."),
    "Priced at $3.21 per SF. Freight adds lead time.");
  assert.equal(customerText("Line one.\nThree lines use Xactimate reference prices.\nLine three."), "Line one.\nLine three.");
  assert.equal(customerText("Some reference-priced lines need review"), "");
  assert.equal(customerText(undefined), "");
  const notes = draftNotesText({
    items: REF_DRAFT.items,   // the scrub runs only on a draft with a reference-priced line
    assumptions: ["Home is unoccupied", "Trim uses the XACTIMATE REFERENCE codes."],
    exclusions: ["Reference prices from our past estimates are placeholders."],
    pricingNotes: "Fairbanks list, Sept 2026. Two lines priced from Roybal's past Xactimate estimates — review.",
  });
  assert.equal(notes, "ASSUMPTIONS\n• Home is unoccupied\n\nPRICING BASIS\nFairbanks list, Sept 2026.");
  // and applySiteDraft runs the loss summary, room summaries and alternates through it
  const inv = { items: [], notes: "" };
  applySiteDraft(inv, {
    ...REF_DRAFT,
    lossSummary: "Kitchen rebuild. Trim is from the Xactimate reference.",
    rooms: [{ name: "Kitchen", customerSummary: "New trim. Trim is off the reference list." }],
    alternates: [{ title: "Tile", description: "Deducts tile. Priced off past Xactimate jobs.", baseCost: -100 }],
  });
  assert.equal(inv.lossSummary, "Kitchen rebuild.");
  assert.deepEqual(inv.customerScope, [{ room: "Kitchen", summary: "New trim." }]);
  assert.deepEqual(inv.alternates, [{ title: "Tile", description: "Deducts tile.", baseCost: "-100" }]);
});

/* Review fixes: the scrub runs only on a draft that used the reference (#6),
   catches paraphrases of the source (#5/#8/#12), splits sentences past
   closing quotes and brackets, and never takes the Magicplan sentence (#7). */
const ORDINARY = "Partition walls hung to a laser reference line. Carry a reference price of $450 for the vanity.";
test("a draft with no reference line keeps its prose exactly as written", () => {
  const construction = {
    ...DRAFT,
    items: [
      { room: "04 — Framing & carpentry", desc: "Partitions, labor", qty: 35, unit: "HR", price: 125, by: "Roybal", priced: "estimate" },
      { room: "Kitchen", desc: "Test wall finish", qty: 40, unit: "SF", price: 1.5, priced: "catalog", code: "TST1" },
    ],
    lossSummary: ORDINARY,
    rooms: [{ name: "Kitchen", customerSummary: ORDINARY }],
    assumptions: [ORDINARY], exclusions: ["Checked against Xactimate history."],
    pricingNotes: ORDINARY,
    alternates: [{ title: "Laser reference line", description: ORDINARY, baseCost: 450 }],
  };
  assert.equal(hasReferenceLines(construction), false);
  assert.equal(hasReferenceLines(REF_DRAFT), true);
  assert.equal(hasReferenceLines(undefined), false);
  const inv = { items: [], notes: "" };
  applySiteDraft(inv, construction);
  assert.equal(inv.lossSummary, ORDINARY);
  assert.deepEqual(inv.customerScope, [{ room: "Kitchen", summary: ORDINARY }]);
  assert.deepEqual(inv.alternates, [{ title: "Laser reference line", description: ORDINARY, baseCost: "450" }]);
  // not even a sentence the scrub WOULD drop: without a reference line there is no private source to hide
  assert.equal(inv.notes, "ASSUMPTIONS\n• " + ORDINARY + "\n\nEXCLUSIONS\n• Checked against Xactimate history.\n\nPRICING BASIS\n" + ORDINARY);
  assert.equal(draftText(construction, "Checked against Xactimate history."), "Checked against Xactimate history.");
  assert.equal(draftText(construction, undefined), "");
  // on a draft that did use the reference, a laser "reference line" is still ordinary prose; a
  // "reference price" is not (on that draft it most likely names the private source), so it goes
  const LINE_ONLY = "Partition walls hung to a laser reference line.";
  assert.equal(customerText(ORDINARY), LINE_ONLY);
  const withRef = { items: [], notes: "" };
  applySiteDraft(withRef, { ...REF_DRAFT, lossSummary: ORDINARY, rooms: [{ name: "Kitchen", customerSummary: ORDINARY }] });
  assert.equal(withRef.lossSummary, LINE_ONLY);
  assert.deepEqual(withRef.customerScope, [{ room: "Kitchen", summary: LINE_ONLY }]);
});

test("paraphrases of the private source are dropped; the Fairbanks Xactimate price list is not one", () => {
  const LEGIT = "Priced from the Fairbanks Xactimate price list, Sept 2026.";
  for (const s of [
    "Trim priced from Roybal's past estimates.",
    "Casing uses our prior Xactimate estimates.",
    "Per Roybal's historical Xactimate pricing.",
    "Baseboard came off the reference list of Roybal's past jobs.",
    "Matched to previous Xactimate jobs.",
    "Checked against Xactimate history.",
    "Priced from our own Xactimate estimates.",
    "Crown matched to our past estimates.",
    "Two lines came from the reference block.",
    "Those codes sit in the reference tier.",
    "See xact_ref for the source.",
    "The refNote has the range.",
  ]) {
    assert.equal(customerText(LEGIT + " " + s + " Owner supplies tile."), LEGIT + " Owner supplies tile.", s);
  }
  assert.equal(customerText(LEGIT), LEGIT);
  assert.equal(customerText("Our pricing follows the Fairbanks Xactimate price list."), "Our pricing follows the Fairbanks Xactimate price list.");
  // end to end on a reference draft
  const inv = { items: [], notes: "" };
  applySiteDraft(inv, { ...REF_DRAFT, assumptions: [], exclusions: [], pricingNotes: LEGIT + " Two lines priced from Roybal's past estimates — review." });
  assert.equal(inv.notes, "PRICING BASIS\n" + LEGIT);
});

test("a sentence ends past its closing quote or bracket, so the next one survives", () => {
  assert.equal(customerText('Trim is "per our past Xactimate estimates." Freight adds lead time.'), "Freight adds lead time.");
  assert.equal(customerText("Casing is allowance-priced (from Roybal's past estimates.) Owner supplies tile."), "Owner supplies tile.");
  assert.equal(customerText("Door slab [see xact_ref.] Owner supplies tile."), "Owner supplies tile.");
  assert.equal(customerText("Owner supplies tile. Trim per \u201cour prior Xactimate estimates.\u201d Freight adds lead time."), "Owner supplies tile. Freight adds lead time.");
  // a quoted measurement or a price is still not a boundary
  assert.equal(customerText('Hang 1/2" drywall at $3.21/SF (see plan.) Checked against Xactimate history.'), 'Hang 1/2" drywall at $3.21/SF (see plan.)');
});

test("the Magicplan basis sentence goes on after the scrub, so a flagged sentence can't take it", () => {
  const draft = { ...REF_DRAFT, assumptions: [], exclusions: [], pricingNotes: "Fairbanks list, Sept 2026. Two lines priced from past Xactimate estimates (review)" };
  const MP = "Quantities from Magicplan LiDAR scan dated Sep 26, 2026; wall areas net of openings.";
  draft.pricingNotes = scanBasisNotes(draft, "2026-09-26");
  assert.equal(draft.pricingNotes, "Fairbanks list, Sept 2026. " + MP);
  const inv = { items: [], notes: "" };
  applySiteDraft(inv, draft);
  assert.equal(inv.notes, "PRICING BASIS\nFairbanks list, Sept 2026. " + MP);
  // only the flagged notes: the Magicplan sentence is all that's left
  assert.equal(scanBasisNotes({ ...REF_DRAFT, pricingNotes: "Priced from our past Xactimate estimates" }, "2026-09-26"), MP);
  // a draft with no reference line: the notes are kept as written, the sentence added once
  assert.equal(scanBasisNotes({ ...DRAFT, pricingNotes: "Laser reference line set" }, "2026-09-26"), "Laser reference line set " + MP);
  assert.equal(scanBasisNotes({ ...DRAFT, pricingNotes: "Fairbanks freight. " + MP }, "2026-09-26"), "Fairbanks freight. " + MP);
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

/* ---------- narrated walk clips (docs/Narrated_Walkthrough_Design.md) ---------- */
test("the slots lead with 🎥 Walk clips; the old kinds keep their shape", () => {
  assert.equal(Object.keys(KINDS)[0], "walk");
  assert.equal(KINDS.walk.label, "🎥 Walk clips");
  assert.equal(KINDS.walk.accept, "video/*,.mp4,.mov");
  assert.equal(KINDS.walk.multiple, true);
  assert.equal(KINDS.videos.label, "Silent clips (Magicplan)");
  assert.equal(KINDS.videos.accept, "video/*,.mp4,.mov");
  assert.equal(KINDS.audio.multiple, false);
  assert.equal(KINDS.audio.accept, "audio/*,video/*,.m4a,.mp3,.wav,.aac");
});

test("a walk clip's stills go to the draft as photos; the clip itself never does", () => {
  const sv = newSiteVisit();
  sv.files.push(
    { id: "w1", kind: "walk", name: "IMG_0042.mov", path: "sitevisit/j/w1-IMG_0042.mov", mime: "video/quicktime", status: "transcribed", room: "Kitchen", duration: 134 },
    { id: "f1", kind: "frames", videoId: "w1", path: "sitevisit/j/f1.jpg", mime: "image/jpeg", caption: 'still at 0:12 from walk clip Kitchen · "sink wall"' },
    { id: "f2", kind: "frames", videoId: "w1", path: "sitevisit/j/f2.jpg", mime: "image/jpeg", caption: "still at 0:31 from walk clip Kitchen" });
  const p = packetForDraft(sv);
  assert.deepEqual(p.photos.map((f) => f.path), ["sitevisit/j/f1.jpg", "sitevisit/j/f2.jpg"]);
  assert.equal(p.photos[0].caption, 'still at 0:12 from walk clip Kitchen · "sink wall"');
  assert.equal(JSON.stringify(p).includes("IMG_0042.mov"), false);
  assert.equal(packetReady({ files: [{ kind: "walk", path: "sitevisit/j/w.mov" }] }), false);   // a clip with no stills and no transcript is nothing to read
});

test("photos list before stills, so the server's budget drops the newest stills first", () => {
  const sv = newSiteVisit();
  sv.files.push(
    { id: "w1", kind: "walk", at: "2026-09-26T09:00:00Z" },
    { id: "a1", kind: "frames", videoId: "w1", path: "sitevisit/j/a1.jpg", mime: "image/jpeg", at: "2026-09-26T09:00:00Z" },
    { id: "p1", kind: "photos", path: "sitevisit/j/p1.jpg", mime: "image/jpeg", at: "2026-09-26T09:02:00Z" },
    { id: "w2", kind: "walk", at: "2026-09-26T09:05:00Z" },
    { id: "b1", kind: "frames", videoId: "w2", path: "sitevisit/j/b1.jpg", mime: "image/jpeg", at: "2026-09-26T09:05:00Z" },
    { id: "p2", kind: "photos", path: "sitevisit/j/p2.jpg", mime: "image/jpeg", at: "2026-09-26T09:07:00Z" });
  assert.deepEqual(packetForDraft(sv).photos.map((f) => f.path), ["sitevisit/j/p1.jpg", "sitevisit/j/p2.jpg", "sitevisit/j/a1.jpg", "sitevisit/j/b1.jpg"]);
});

test("the client's image cap mirrors the server's", () => {
  const server = readFileSync(new URL("../../../supabase/functions/roybal-ai-office/sitevisit.ts", import.meta.url), "utf8");
  const n = Number((server.match(/export const MAX_IMAGES = (\d+)/) || [])[1]);
  assert.equal(MAX_IMAGES, 150);
  assert.equal(MAX_IMAGES, n, "sitevisit.js MAX_IMAGES must equal sitevisit.ts MAX_IMAGES");
});

test("opening a visit transcribed before walk clips keeps its transcript, on the recording's row", () => {
  const project = { siteVisit: { files: [{ id: "a1", kind: "audio", name: "walk.m4a", path: "sitevisit/j/a1-walk.m4a", at: "2026-09-20T10:00:00Z" }], transcript: "[00:05] start in the kitchen", transcriptSeconds: 600 } };
  const sv = siteVisitOf(project);
  assert.equal(sv.files[0].transcript.text, "[00:05] start in the kitchen");
  assert.equal(sv.files[0].transcript.seconds, 600);
  assert.equal(sv.transcript, "[00:05] start in the kitchen");   // untouched until something rebuilds it
  const again = siteVisitOf(project);
  assert.equal(again.files[0].transcript.text, "[00:05] start in the kitchen");
});

console.log(`\n${pass} site-visit tests passed`);
