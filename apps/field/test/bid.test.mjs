/* Leads / Bids test — the pure state readers in js/bid.js (the network and
   DOM halves are browser-only and fail-safe). docs/Lead_Bid_Workflow_Design.md
   Run: node apps/field/test/bid.test.mjs   (from repo root) */
import assert from "node:assert";
import {
  tileMode, isOpenLeadTile, unlinkedLeadTiles, estimateTotal, bidState, bidChip,
  fmtVisitAt, whoLabel, shortMoney, lostBidFiles, siteVisitDonePatch,
  suggestEstimateNo, addBusinessDays, estimateSentPatch, estimateEmailDraft,
} from "../js/bid.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const tile = (id, data) => ({ id, data });

console.log("Leads / Bids");

/* ---------- which tab ---------- */
ok("water / fire / mold tiles are restoration", ["water", "fire", "mold"].every((t) => tileMode({ type: t }) === "restoration"));
ok("remodel / new_build / restoration / other / untyped are construction",
  ["remodel", "new_build", "restoration", "other", ""].every((t) => tileMode({ type: t }) === "construction") && tileMode(null) === "construction");

/* ---------- open lead ---------- */
ok("a lead-stage tile with no outcome is open", isOpenLeadTile({ stage: "lead" }) && isOpenLeadTile({}));
ok("won / lost / archived / milestone / scheduled are not", !isOpenLeadTile({ stage: "lead", outcome: "won" }) && !isOpenLeadTile({ stage: "lead", outcome: "lost" })
  && !isOpenLeadTile({ stage: "lead", archived: true }) && !isOpenLeadTile({ stage: "lead", isMilestone: true }) && !isOpenLeadTile({ stage: "scheduled" }));

/* ---------- ghost rows ---------- */
const ROWS = [
  tile("g1", { stage: "lead", type: "remodel", customer: "Alpha", createdAt: "2026-09-20T10:00:00Z" }),
  tile("g2", { stage: "lead", type: "water",   customer: "Bravo", createdAt: "2026-09-22T10:00:00Z" }),
  tile("g3", { stage: "lead", type: "remodel", customer: "Charlie", createdAt: "2026-09-24T10:00:00Z" }),
  tile("g4", { stage: "lead", type: "remodel", customer: "Delta Linked", fieldJobId: "bj-g4", createdAt: "2026-09-23T10:00:00Z" }),
  tile("g5", { stage: "lead", type: "remodel", customer: "Echo Lost", outcome: "lost", createdAt: "2026-09-23T10:00:00Z" }),
  tile("g6", { stage: "lead", type: "remodel", customer: "Foxtrot Repeat", createdAt: "2026-09-21T10:00:00Z" }),
  tile("g7", { stage: "scheduled", type: "remodel", customer: "Golf Scheduled" }),
];
const PROJECTS = [
  { id: "fp-c", customer: "Charlie" },                                                 // live file → blocked, still shown
  { id: "fp-f", customer: "Foxtrot Repeat", archivedAt: "2025-01-01T00:00:00.000Z" },  // archived → not blocked
];
const cons = unlinkedLeadTiles(ROWS, PROJECTS, "construction");
ok("construction tab lists its open unlinked leads, newest first", cons.map((x) => x.row.id).join(",") === "g3,g6,g1");
ok("a live lookalike file marks the row blocked (office links from that side)", cons.find((x) => x.row.id === "g3").blocked === true);
ok("an archived lookalike does not block a repeat customer", cons.find((x) => x.row.id === "g6").blocked === false);
ok("linked, lost and scheduled tiles are not ghost rows", !cons.find((x) => ["g4", "g5", "g7"].includes(x.row.id)));
ok("restoration tab gets the water lead only", unlinkedLeadTiles(ROWS, PROJECTS, "restoration").map((x) => x.row.id).join(",") === "g2");
ok("garbage rows never throw", unlinkedLeadTiles([null, {}, { data: null }], [], "construction").length === 0);

/* ---------- estimate total mirrors the estimate editor ---------- */
const est = { kind: "estimate", items: [{ qty: "10", price: "100" }, { qty: 2, price: 250 }], overheadPct: "10", profitPct: "10", opMode: "pct", contingencyPct: "5", taxRate: "0" };
ok("T&M: lines → contingency (build) → 10 & 10 on that base", estimateTotal(est, true) === 1890);   // 1500 + 75 = 1575; ×1.20 = 1890
ok("claim estimates skip contingency unless a % is typed", estimateTotal({ ...est, contingencyPct: "" }, false) === 1800);
ok("a typed contingency applies on a claim estimate too", estimateTotal(est, false) === 1890);
ok("fixed-dollar O&P (imported Xactimate) is added as-is", estimateTotal({ ...est, opMode: "amount", overheadAmount: "100", profitAmount: "50", contingencyPct: "" }, false) === 1650);
ok("contract billing: the agreed figure is the total", estimateTotal({ ...est, billingModel: "contract", contractAmount: "9999" }, true) === 9999);
ok("tax on the base, less deductible and previous payments", estimateTotal({ items: [{ qty: 1, price: 1000 }], taxRate: "5", deductible: "100", previousPayments: "50", overheadPct: "0", profitPct: "0" }) === 900);
ok("junk lines count as zero, never NaN", estimateTotal({ items: [null, { qty: "x", price: "y" }, { qty: 1, price: 5 }] }) === 5);
ok("no estimate → 0", estimateTotal(null) === 0 && estimateTotal({}) === 0);

/* ---------- bid state + chip ---------- */
const file = { id: "bj-b1", bidOf: "b1", jobType: "construction",
  siteVisit: { files: [{ kind: "report" }, { kind: "photos" }, { kind: "photos" }], transcript: "we walked the kitchen", typedScope: "", leadMessage: "Kitchen remodel", leadChannel: "web-form" },
  reconEstimates: [{ id: "e1", invoiceNo: "RC-MIK-0926", items: [{ qty: 1, price: 12000 }], overheadPct: "0", profitPct: "0" }] };
const tileD = { stage: "lead", channel: "web-form", createdAt: "2026-09-20T10:00:00Z", siteVisit: { at: "2026-09-26T14:00", by: "branden@roybalconstruction.com", status: "scheduled" } };
const s1 = bidState(file, tileD);
ok("visit reads off the tile (the office owns the appointment)", s1.visit.at === "2026-09-26T14:00" && s1.visit.status === "scheduled" && !s1.visit.doneAt);
ok("packet counts files and the transcript", s1.packet.files === 3 && s1.packet.transcript === true && s1.packet.scope === false);
ok("estimate: number, lines, total", s1.estimate.no === "RC-MIK-0926" && s1.estimate.lines === 1 && s1.estimate.total === 12000);
ok("the customer's ask comes from the file first", s1.lead.message === "Kitchen remodel" && s1.lead.channel === "web-form");
ok("chip: furthest step wins — an estimate with lines", bidChip(s1) === "📄 est. $12,000");
ok("chip: visit scheduled", bidChip(bidState({ bidOf: "b1" }, tileD)) === "📅 visit Sat 9/26 2:00 PM");
ok("chip: inspected beats the scheduled visit", bidChip(bidState({ bidOf: "b1", siteVisit: { doneAt: "2026-09-26" } }, tileD)) === "🔍 inspected 9/26");
ok("chip: sent beats everything", bidChip(bidState({ ...file, reconEstimates: [{ ...file.reconEstimates[0], sentAt: "2026-09-27T18:00:00Z" }] }, tileD)) === "📄 $12,000 sent 9/27");
ok("chip: a lost lead says so", bidChip(bidState(file, { ...tileD, outcome: "lost" })) === "✕ lost");
ok("chip: nothing yet → bid started", bidChip(bidState({ bidOf: "b1" }, { stage: "lead" })) === "📐 bid started");
ok("offline (no tile) still reads the file's own done stamp", bidState({ bidOf: "b1", siteVisit: { doneAt: "2026-09-26" } }, null).visit.status === "done");
ok("a tile past the lead stage reports its stage (the card hides on it)", bidState(file, { stage: "scheduled" }).lead.stage === "scheduled");
ok("garbage never throws", bidState(null, null).estimate === null && bidChip(null) === "📐 bid started");

/* ---------- dates, names, money ---------- */
ok("local-ISO datetime prints as typed, no zone shift", fmtVisitAt("2026-09-26T14:00") === "Sat 9/26 2:00 PM" && fmtVisitAt("2026-09-26T09:05") === "Sat 9/26 9:05 AM");
ok("midnight and noon", fmtVisitAt("2026-09-26T00:30") === "Sat 9/26 12:30 AM" && fmtVisitAt("2026-09-26T12:00") === "Sat 9/26 12:00 PM");
ok("date-only visit", fmtVisitAt("2026-09-26") === "Sat 9/26");
ok("space-separated datetime accepted", fmtVisitAt("2026-09-26 14:00") === "Sat 9/26 2:00 PM");
ok("garbage → empty", fmtVisitAt("") === "" && fmtVisitAt(null) === "" && fmtVisitAt("soon") === "");
ok("email → first name; name passes through", whoLabel("branden@roybalconstruction.com") === "Branden" && whoLabel("Dave") === "Dave" && whoLabel("") === "");
ok("money rounds to whole dollars with separators", shortMoney(18450.49) === "$18,450" && shortMoney("x") === "$0");

/* ---------- lost leads → archive their bid files ---------- */
const L_ROWS = [
  tile("l1", { stage: "lead", outcome: "lost" }),
  tile("l2", { stage: "lead" }),
  tile("l3", { stage: "lead", outcome: "lost", fieldJobId: "fp-old-link" }),
  tile("l4", { stage: "scheduled", outcome: "lost" }),   // nonsense state: never archive working files
];
const L_PROJECTS = [
  { id: "bj-l1", bidOf: "l1" },
  { id: "bj-l2", bidOf: "l2" },
  { id: "fp-old-link" },                                       // linked by the tile, no bidOf (pre-PR file)
  { id: "bj-l1-arch", bidOf: "l1", archivedAt: "2026-09-01T00:00:00Z" },
  { id: "bj-l4", bidOf: "l4" },
  { id: "fp-none", customer: "No tile" },
];
const lost = lostBidFiles(L_ROWS, L_PROJECTS).map((p) => p.id);
ok("files of lost leads are picked, by bidOf or by the tile's link", lost.join(",") === "bj-l1,fp-old-link");
ok("open leads, already-archived files, working tiles and unlinked files are left alone", !lost.includes("bj-l2") && !lost.includes("bj-l1-arch") && !lost.includes("bj-l4") && !lost.includes("fp-none"));

/* ---------- the site-visit-done patch ---------- */
const AT = "2026-09-26T22:41:00.000Z";
const d0 = { stage: "lead", siteVisit: { at: "2026-09-26T14:00", by: "branden@roybalconstruction.com", status: "scheduled" },
  leadLog: [{ id: "e0", at: "2026-09-20", kind: "note", note: "called" }], nextAction: "Site visit", nextActionAt: "2026-09-26" };
const p0 = siteVisitDonePatch(d0, AT, "branden@roybalconstruction.com", "e1");
ok("siteVisit keeps the appointment and gains status/doneAt", p0.siteVisit.at === "2026-09-26T14:00" && p0.siteVisit.status === "done" && p0.siteVisit.doneAt === "2026-09-26");
ok("leadLog is the WHOLE array plus an 🔍 inspected entry (shallow merge)", p0.leadLog.length === 2 && p0.leadLog[1].id === "e1" && p0.leadLog[1].kind === "inspected" && p0.leadLog[1].at === "2026-09-26");
ok("the entry names who and where it came from", /Site visit done — Branden \(Field Forms\)/.test(p0.leadLog[1].note) && p0.leadLog[1].action === "Site visit");
ok("the visit follow-up is cleared", p0.nextAction === "" && p0.nextActionAt === "");
ok("first touch stamps once", p0.firstTouchAt === AT && !("firstTouchAt" in siteVisitDonePatch({ ...d0, firstTouchAt: "earlier" }, AT, "", "e1")));
const p1 = siteVisitDonePatch({ stage: "lead", nextAction: "Send the drywall quote", nextActionAt: "2026-09-30" }, AT, "", "e2");
ok("an unrelated follow-up is left alone", !("nextAction" in p1) && !("nextActionAt" in p1));
ok("no prior siteVisit / leadLog → still a valid patch", p1.siteVisit.status === "done" && p1.leadLog.length === 1 && p1.leadLog[0].action === "Send the drywall quote");
ok("garbage tile never throws", siteVisitDonePatch(null, AT, "", "e3").leadLog.length === 1);

/* ---------- PR 3: estimate number, send stamp, email ---------- */
ok("estimate no: RC-<LAST3>-<MMYY> from the customer's last word",
  suggestEstimateNo("Pat Kennedy", "2025-09-14") === "RC-KEN-0925" && suggestEstimateNo("AmeriGas", "2026-09-24") === "RC-AME-0926");
ok("estimate no: short or missing names still make a number",
  suggestEstimateNo("Jo Ng", "2026-01-02") === "RC-NGX-0126" && suggestEstimateNo("", "2026-01-02") === "RC-JOB-0126");
ok("estimate no: a taken number gets -2, then -3 (case-insensitive)",
  suggestEstimateNo("Kennedy", "2025-09-01", ["rc-ken-0925"]) === "RC-KEN-0925-2"
  && suggestEstimateNo("Kennedy", "2025-09-01", ["RC-KEN-0925", "RC-KEN-0925-2"]) === "RC-KEN-0925-3");
ok("business days skip the weekend (Thu + 5 → next Thu; Fri + 1 → Mon)",
  addBusinessDays("2026-09-24", 5) === "2026-10-01" && addBusinessDays("2026-09-25", 1) === "2026-09-28" && addBusinessDays("", 5) === "");

const sentAt = "2026-09-24T20:00:00.000Z";
const sp1 = estimateSentPatch({ nextAction: "Send estimate", leadLog: [{ id: "x", kind: "note" }] },
  { no: "RC-KEN-0926", total: 18450.4, at: sentAt, to: "pat@example.com", entryId: "e1" });
ok("sent patch: log entry, number, total, 5-business-day follow-up",
  sp1.leadLog.length === 2 && sp1.leadLog[1].kind === "estimate-sent" && sp1.leadLog[1].at === "2026-09-24"
  && sp1.leadLog[1].note === "RC-KEN-0926 · $18,450 — to pat@example.com (Field Forms)" && sp1.leadLog[1].action === "Send estimate"
  && sp1.estimateNo === "RC-KEN-0926" && sp1.estimateTotal === 18450 && sp1.estimateSentAt === sentAt
  && sp1.nextAction === "Follow up on estimate" && sp1.nextActionAt === "2026-10-01" && sp1.firstTouchAt === sentAt);
ok("sent patch: fills a blank estValue and marks it the field's",
  sp1.estValue === 18450 && sp1.estValueSource === "field");
const sp2 = estimateSentPatch({ estValue: 15000, firstTouchAt: "2026-09-01" }, { no: "A", total: 18450, at: sentAt });
ok("sent patch: never replaces an estValue the office typed",
  !("estValue" in sp2) && !("estValueSource" in sp2) && !("firstTouchAt" in sp2));
const sp3 = estimateSentPatch({ estValue: 17000, estValueSource: "field" }, { no: "A", total: 19000, at: sentAt, revised: true });
ok("sent patch: updates its own earlier number; a resend says (revised)",
  sp3.estValue === 19000 && /\(revised\)/.test(sp3.leadLog[0].note));

const mail = estimateEmailDraft({ customer: "Pat Kennedy", address: "1465 Noble St", email: "pat@example.com" },
  { invoiceNo: "RC-KEN-0926", dueDate: "2026-10-24" }, 18450, "Branden");
ok("email: to the customer, subject names the estimate and address",
  mail.to === "pat@example.com" && mail.subject === "Estimate RC-KEN-0926 — 1465 Noble St · Roybal Construction");
ok("email: greets by first name, states the total and the valid-through date, signs off",
  /^Hi Pat,/.test(mail.body) && /totaling \$18,450\. Pricing is good through 10\/24\./.test(mail.body) && /\nBranden\n/.test(mail.body));
const bare = estimateEmailDraft({}, {}, 0);
ok("email: a bare file still makes a sendable draft, signed once by the company",
  bare.to === "" && /^Hi,/.test(bare.body) && bare.subject === "Estimate · Roybal Construction"
  && /Thank you,\nRoybal Construction, LLC$/.test(bare.body));

console.log(`\n${pass} bid checks passed.`);
