/* Build Watch test — pure logic, no DOM, no network, no AI.
   Run: node apps/field/test/buildwatch.test.mjs   (from repo root) */
import assert from "node:assert";
import { buildFlags, isComplete } from "../js/buildwatch.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const kinds = (flags) => flags.map((f) => f.kind);

// A fixed "now": Wed 2026-07-15 noon local
const NOW = new Date("2026-07-15T12:00:00").getTime();

console.log("Build Watch");

/* quiet job — nothing documented, nothing flagged */
ok("empty job -> no flags", buildFlags({}, NOW).length === 0);
ok("null job -> no flags", buildFlags(null, NOW).length === 0);

/* inspFail — failed inspection with no reinspection */
const failed = { inspections: [{ type: "Framing", result: "fail", reinspection: "" }] };
ok("failed inspection flags", kinds(buildFlags(failed, NOW)).includes("inspFail"));
ok("failed inspection is 'bad'", buildFlags(failed, NOW)[0].tone === "bad");
const rescheduled = { inspections: [{ type: "Framing", result: "fail", reinspection: "2026-07-20" }] };
ok("reinspection scheduled -> no flag", buildFlags(rescheduled, NOW).length === 0);
const passed = { inspections: [{ type: "Framing", result: "pass" }] };
ok("passed inspection -> no flag", buildFlags(passed, NOW).length === 0);

/* subNoShow / subLate */
const noShow = { subSchedule: { rows: [{ trade: "Drywall", status: "no-show" }] } };
ok("sub no-show flags 'bad'", buildFlags(noShow, NOW).some((f) => f.kind === "subNoShow" && f.tone === "bad"));
const late = { subSchedule: { rows: [{ trade: "Paint", status: "on-site", schedEnd: "2026-07-10" }] } };
ok("trade past scheduled end flags 'warn'", buildFlags(late, NOW).some((f) => f.kind === "subLate" && f.tone === "warn"));
const onTime = { subSchedule: { rows: [{ trade: "Paint", status: "on-site", schedEnd: "2026-07-16" }] } };
ok("trade within schedule -> no flag", buildFlags(onTime, NOW).length === 0);
const doneLate = { subSchedule: { rows: [{ trade: "Paint", status: "done", schedEnd: "2026-07-01" }] } };
ok("done trade never flags late", buildFlags(doneLate, NOW).length === 0);

/* selOrder — pending selection at/past its ordering deadline */
const mustOrder = { selections: { rows: [{ item: "Cabinets", status: "pending", leadWeeks: "3", neededBy: "2026-08-01" }] } };
ok("pending selection inside lead window flags", kinds(buildFlags(mustOrder, NOW)).includes("selOrder"));
ok("inside lead window is 'warn'", buildFlags(mustOrder, NOW)[0].tone === "warn");
const pastNeeded = { selections: { rows: [{ item: "Faucet", status: "pending", leadWeeks: "1", neededBy: "2026-07-10" }] } };
ok("past needed-by is 'bad'", buildFlags(pastNeeded, NOW)[0].tone === "bad");
const plentyOfTime = { selections: { rows: [{ item: "Paint color", status: "pending", leadWeeks: "1", neededBy: "2026-09-01" }] } };
ok("selection with time to spare -> no flag", buildFlags(plentyOfTime, NOW).length === 0);
const ordered = { selections: { rows: [{ item: "Cabinets", status: "ordered", leadWeeks: "3", neededBy: "2026-07-16" }] } };
ok("ordered selection never flags", buildFlags(ordered, NOW).length === 0);
const noDates = { selections: { rows: [{ item: "Trim", status: "pending" }] } };
ok("pending selection with no dates -> no flag", buildFlags(noDates, NOW).length === 0);
/* falls back to the job's target completion when no needed-by */
const viaTarget = { targetCompletion: "2026-07-20", selections: { rows: [{ item: "Flooring", status: "pending", leadWeeks: "2" }] } };
ok("falls back to target completion for the deadline", kinds(buildFlags(viaTarget, NOW)).includes("selOrder"));

/* daily-log ↔ schedule cross-check (Phase 4) */
{
  // NOW is Wed 2026-07-15; logs dated 07-14 are "recent"
  const base = {
    subSchedule: { rows: [
      { trade: "Drywall", status: "on-site", schedStart: "2026-07-13", schedEnd: "2026-07-17" },
    ] },
    constructionLogs: [
      { date: "2026-07-14", rows: [{ employee: "Mike", task: "Hang drywall lower walls" }] },
    ],
  };
  ok("scheduled trade with recent log entries -> no cross-check flag",
    buildFlags(base, NOW).length === 0);

  const quiet = JSON.parse(JSON.stringify(base));
  quiet.constructionLogs = [{ date: "2026-07-11", rows: [{ employee: "Mike", task: "Hang drywall" }] }];
  ok("scheduled trade silent 2+ days flags tradeQuiet",
    buildFlags(quiet, NOW).some((f) => f.kind === "tradeQuiet" && /Drywall/.test(f.label)));

  const offPlan = JSON.parse(JSON.stringify(base));
  offPlan.constructionLogs[0].rows.push({ employee: "Sam", task: "Rough in plumbing at kitchen sink" });
  ok("unscheduled trade in recent logs flags tradeUnscheduled",
    buildFlags(offPlan, NOW).some((f) => f.kind === "tradeUnscheduled" && /Plumbing/.test(f.label)));

  const notDueYet = JSON.parse(JSON.stringify(base));
  notDueYet.subSchedule.rows[0].schedStart = "2026-07-20";   // future — shouldn't be on site yet
  notDueYet.constructionLogs = [{ date: "2026-07-14", rows: [{ employee: "Mike", task: "site prep" }] }];
  ok("trade not due yet never flags quiet", !buildFlags(notDueYet, NOW).some((f) => f.kind === "tradeQuiet"));

  ok("no logs at all -> no cross-check flags (nothing to compare)",
    buildFlags({ subSchedule: base.subSchedule }, NOW).length === 0);
  /* "Other" has no keyword signature — it can never be observed in log text,
     so it must never flag quiet (it would be a permanent false alarm) */
  const other = JSON.parse(JSON.stringify(base));
  other.subSchedule.rows = [{ trade: "Other", status: "on-site", schedStart: "2026-07-13", schedEnd: "2026-07-17" }];
  other.constructionLogs = [{ date: "2026-07-11", rows: [{ employee: "Glass guy", task: "shower glass install" }] }];
  ok("'Other' trade never flags quiet", !buildFlags(other, NOW).some((f) => f.kind === "tradeQuiet"));
  const doneTrade = JSON.parse(JSON.stringify(base));
  doneTrade.subSchedule.rows[0].status = "done";
  doneTrade.constructionLogs = [{ date: "2026-07-11", rows: [{ employee: "Mike", task: "Hang drywall" }] }];
  ok("done trade never flags quiet", !buildFlags(doneTrade, NOW).some((f) => f.kind === "tradeQuiet"));
}

/* phaseOver / phaseHot / coStale — daily-log hours vs the board-plan estimate */
{
  const planJob = (hours) => ({
    boardPlan: { generatedAt: "2026-07-10T00:00:00Z", status: "pushed",
      phases: [{ name: "Drywall", estimatedHours: 40, lagDays: 0 }] },
    constructionLogs: [{ date: "2026-07-14", rows: [{ task: "hang drywall", hours: String(hours) }] }],
  });
  ok("under 80% of estimate -> no phase flag", !buildFlags(planJob(20), NOW).some((f) => f.kind.startsWith("phase")));
  ok("80% of estimate flags amber", buildFlags(planJob(33), NOW).some((f) => f.kind === "phaseHot" && f.tone === "warn"));
  ok("110% of estimate flags red", buildFlags(planJob(45), NOW).some((f) => f.kind === "phaseOver" && f.tone === "bad"));
  const co = planJob(10);
  co.changeOrders = [{ createdAt: "2026-07-12T00:00:00Z", coNo: "CO-1" }];
  ok("change order after the timeline flags coStale", buildFlags(co, NOW).some((f) => f.kind === "coStale"));
  const coOld = planJob(10);
  coOld.changeOrders = [{ createdAt: "2026-07-01T00:00:00Z", coNo: "CO-1" }];
  ok("older change order doesn't flag", !buildFlags(coOld, NOW).some((f) => f.kind === "coStale"));
  ok("no board plan -> no phase flags", !buildFlags({ constructionLogs: planJob(45).constructionLogs }, NOW).some((f) => f.kind.startsWith("phase")));
}

/* isComplete silences everything */
const certified = {
  certCompletion: { sigContractor: "data:sig" },
  inspections: [{ type: "Framing", result: "fail" }],
  subSchedule: { rows: [{ trade: "Drywall", status: "no-show" }] },
};
ok("certificate of completion signed -> complete", isComplete(certified));
ok("complete job never flags", buildFlags(certified, NOW).length === 0);
ok("uploaded cert also completes", isComplete({ certCompletion: { uploadedPages: ["data:p1"] } }));
/* merely opening the cert tile auto-creates the form with issueDate prefilled —
   that must NOT count as complete or every flag would silence on one tap */
const blankCert = { certCompletion: { certNo: "", issueDate: "2026-07-15", sigContractor: "", uploadedPages: [] },
  inspections: [{ type: "Framing", result: "fail" }] };
ok("factory-blank cert (prefilled issueDate) is not complete", !isComplete(blankCert));
ok("factory-blank cert keeps the flags alive", buildFlags(blankCert, NOW).length > 0);

console.log(`\n${pass} build-watch checks passed.`);
