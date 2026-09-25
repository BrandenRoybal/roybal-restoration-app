/* 📅 Site visit on a lead — the office half of the lead → bid workflow
   (docs/Lead_Bid_Workflow_Design.md §5.1–5.2). Run:
   node apps/board/test/leadvisit.test.mjs

   The field app decides "this lead is being bid" from siteVisit.at
   (apps/field/js/boardpush.js isBidLead), so the patches here are the
   contract between the office and the crew's phones. */
import assert from "node:assert/strict";
import {
  fmtVisitAt, visitDate, visitTime, whoLabel, visitPeople,
  scheduleVisitPatch, cancelVisitPatch, visitChip, bidSteps, estimateSentOn, bidStats,
} from "../js/leadvisit.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const crew = [
  { id: "c1", name: "CJ Martinez", email: "cj@example.com" },
  { id: "c2", name: "Old Hand", email: "old@example.com", active: false },
  { id: "c3", name: "No Login" },
  { id: "c4", name: "Alex Lee", email: "Alex@Example.com" },
];

/* ---- formatting ---- */
test("fmtVisitAt prints the appointment as typed (no zone shift)", () => {
  assert.equal(fmtVisitAt("2026-09-26T14:00"), "Sat 9/26 2:00 PM");
  assert.equal(fmtVisitAt("2026-09-28T09:30"), "Mon 9/28 9:30 AM");
  assert.equal(fmtVisitAt("2026-09-28T12:05"), "Mon 9/28 12:05 PM");
  assert.equal(fmtVisitAt("2026-09-28"), "Mon 9/28");
  assert.equal(fmtVisitAt(""), "");
});
test("visitDate / visitTime split siteVisit.at for the editor inputs", () => {
  assert.equal(visitDate("2026-09-26T14:00"), "2026-09-26");
  assert.equal(visitTime("2026-09-26T14:00"), "14:00");
  assert.equal(visitTime("2026-09-26"), "");
  assert.equal(visitDate(undefined), "");
});
test("whoLabel uses the roster name for a login email, else the email's first part", () => {
  assert.equal(whoLabel("cj@example.com", crew), "CJ Martinez");
  assert.equal(whoLabel("alex@example.com", crew), "Alex Lee");      // case-insensitive
  assert.equal(whoLabel("branden@roybalconstruction.com", crew), "Branden");
  assert.equal(whoLabel("", crew), "");
});
test("visitPeople: me first, then active roster members with a login, no dupes", () => {
  const ppl = visitPeople(crew, "branden@roybalconstruction.com");
  assert.deepEqual(ppl.map((p) => p.email), ["branden@roybalconstruction.com", "Alex@Example.com", "cj@example.com"]);
  const asCj = visitPeople(crew, "cj@example.com");
  assert.equal(asCj[0].name, "CJ Martinez");
  assert.equal(asCj.filter((p) => p.email.toLowerCase() === "cj@example.com").length, 1);
});

/* ---- the writes ---- */
test("booking a visit writes siteVisit + makes the visit the follow-up", () => {
  const p = scheduleVisitPatch({}, { date: "2026-09-26", time: "14:00", by: "cj@example.com" });
  assert.deepEqual(p, {
    siteVisit: { at: "2026-09-26T14:00", by: "cj@example.com", status: "scheduled" },
    nextAction: "Site visit", nextActionAt: "2026-09-26",
  });
});
test("a date with no time is still a visit (the field's isBidLead only needs .at)", () => {
  assert.equal(scheduleVisitPatch({}, { date: "2026-09-26", time: "", by: "x@y.z" }).siteVisit.at, "2026-09-26");
});
test("an earlier, different follow-up the office typed is kept", () => {
  const d = { nextAction: "Call back about insurance", nextActionAt: "2026-09-24" };
  const p = scheduleVisitPatch(d, { date: "2026-09-26", time: "", by: "x@y.z" });
  assert.equal(p.nextAction, undefined);
  assert.equal(p.nextActionAt, undefined);
});
test("…but a later one is replaced — the visit comes first", () => {
  const d = { nextAction: "Send estimate", nextActionAt: "2026-10-05" };
  assert.equal(scheduleVisitPatch(d, { date: "2026-09-26", time: "", by: "x@y.z" }).nextActionAt, "2026-09-26");
});
test("re-booking a new time starts a fresh visit (the old done stamp doesn't carry)", () => {
  const d = { siteVisit: { at: "2026-09-20T10:00", by: "a@b.c", status: "done", doneAt: "2026-09-20" } };
  const p = scheduleVisitPatch(d, { date: "2026-09-26", time: "14:00", by: "a@b.c" });
  assert.deepEqual(p.siteVisit, { at: "2026-09-26T14:00", by: "a@b.c", status: "scheduled" });
});
test("saving the same time only changes who — a done stamp survives", () => {
  const d = { siteVisit: { at: "2026-09-26T14:00", by: "a@b.c", status: "done", doneAt: "2026-09-26" } };
  const p = scheduleVisitPatch(d, { date: "2026-09-26", time: "14:00", by: "cj@example.com" });
  assert.equal(p.siteVisit.doneAt, "2026-09-26");
  assert.equal(p.siteVisit.by, "cj@example.com");
});
test("cancelling clears .at (no new bid file) and drops a visit follow-up", () => {
  const d = { siteVisit: { at: "2026-09-26T14:00", by: "a@b.c", status: "scheduled" }, nextAction: "Site visit", nextActionAt: "2026-09-26" };
  assert.deepEqual(cancelVisitPatch(d), {
    siteVisit: { status: "cancelled", at: "", by: "a@b.c", was: "2026-09-26T14:00" },
    nextAction: "", nextActionAt: "",
  });
  const other = cancelVisitPatch({ ...d, nextAction: "Call back" });
  assert.equal(other.nextAction, undefined);
});

/* ---- what the office sees ---- */
test("visitChip: plain ahead, amber the day of, red once passed and not done", () => {
  const d = { siteVisit: { at: "2026-09-26T14:00", status: "scheduled" } };
  assert.deepEqual([visitChip(d, "2026-09-25").text, visitChip(d, "2026-09-25").tone], ["📅 9/26", ""]);
  assert.equal(visitChip(d, "2026-09-26").tone, "due");
  assert.equal(visitChip(d, "2026-09-27").tone, "late");
  const done = { siteVisit: { at: "2026-09-26T14:00", status: "done", doneAt: "2026-09-26" } };
  assert.deepEqual([visitChip(done, "2026-09-30").text, visitChip(done, "2026-09-30").tone], ["🔍 9/26", ""]);
  assert.equal(visitChip({ siteVisit: { status: "cancelled", at: "" } }, "2026-09-26"), null);
  assert.equal(visitChip({}, "2026-09-26"), null);
});
test("bidSteps reads the funnel in order", () => {
  const d = {
    siteVisit: { at: "2026-09-26T14:00", by: "cj@example.com", status: "scheduled" },
  };
  assert.deepEqual(bidSteps(d, crew).map((s) => s.text), ["📅 Sat 9/26 2:00 PM · CJ Martinez"]);
  const later = {
    siteVisit: { at: "2026-09-26T14:00", by: "cj@example.com", status: "done", doneAt: "2026-09-26" },
    fieldJobId: "bj-1", estimateNo: "RC-KEN-0925", estimateTotal: 18450, estimateSentAt: "2026-09-27T10:00:00Z",
  };
  assert.deepEqual(bidSteps(later, crew).map((s) => s.text),
    ["📐 Bid started", "🔍 Inspected 9/26", "📄 RC-KEN-0925 · $18,450 sent 9/27"]);
});
test("a hand-logged 'Estimate sent' counts until the field stamps one", () => {
  const d = { leadLog: [{ kind: "note", at: "2026-09-01" }, { kind: "estimate-sent", at: "2026-09-10" }] };
  assert.equal(estimateSentOn(d), "2026-09-10");
  assert.deepEqual(bidSteps(d).map((s) => s.text), ["📄 Estimate sent 9/10"]);
  assert.equal(estimateSentOn({ ...d, estimateSentAt: "2026-09-12T08:00:00Z" }), "2026-09-12");
});
test("bidStats: visits in the next 7 days, estimates out > 5d with no answer", () => {
  const today = "2026-09-24";
  const leads = [
    { siteVisit: { at: "2026-09-24T09:00", status: "scheduled" } },              // today — counts
    { siteVisit: { at: "2026-09-30", status: "scheduled" } },                    // +6 — counts
    { siteVisit: { at: "2026-10-01", status: "scheduled" } },                    // +7 — no
    { siteVisit: { at: "2026-09-23", status: "scheduled" } },                    // past — no
    { siteVisit: { at: "", status: "cancelled", was: "2026-09-25" } },           // cancelled — no
    { siteVisit: { at: "2026-09-25", status: "done", doneAt: "2026-09-25" } },   // done — no
    { estimateSentAt: "2026-09-18T10:00:00Z" },                                   // 6d — waiting
    { estimateSentAt: "2026-09-20T10:00:00Z" },                                   // 4d — not yet
    { leadLog: [{ kind: "estimate-sent", at: "2026-09-10" }, { kind: "waiting", at: "2026-09-15" }] }, // heard back
  ];
  assert.deepEqual(bidStats(leads, today), { visitsThisWeek: 2, estimatesWaiting: 1 });
});

console.log(`\n${pass} leadvisit checks passed`);
