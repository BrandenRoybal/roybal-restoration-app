/* reconcile.js — the nightly billing check's detector: documented unit-days,
   labor hours and the Cat 3 package against what the job's invoices bill.
   Pure logic, no DOM, no network, no clock.
   Run: node apps/field/test/reconcile.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DETECTOR, LIMITS, invoiceLineClass, equipmentUnitDays, scopeOf, reconcileJob, findingsKey,
} from "../js/reconcile.js";

let pass = 0;
function test(name, fn) { fn(); console.log("  ✓ " + name); pass++; }

console.log("Billing reconcile (detector)");

/* ---------- fixtures ---------- */
const clone = (o) => JSON.parse(JSON.stringify(o));
const log = (id, equipment, readings = [], extra = {}) => ({ id, dryoutStart: "", dryoutFinish: "", equipment, readings, ...extra });
const psych = (date, counts = {}) => ({ date, time: "09:00", outT: "48", outRH: "60", refT: "70", refRH: "40", affT: "72", affRH: "55", dehu: "", am: "", scrub: "", ...counts });
const qbRow = (id, date, hours, ts, updated = "2026-08-06T15:00:00Z") => ({ id, date, hours, qbTimesheetId: ts, updated_at: updated, source: "qbtime" });

/* A Cat 2 job: one LGR (7 unit-days: 07-28 15:00 → 08-04 09:00), two air
   movers (5 each: → 08-02 09:00), readings on four dates, one T&M invoice that
   bills 4 dehu-days, 10 air-mover-days and 12 HR. */
function baseJob() {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    customer: "Doe", jobType: "restoration", waterCategory: "2", waterClass: "2",
    dateOfLoss: "2026-07-27", qbJobcodeId: "JC1",
    laborLog: { id: "ll1", startDate: "", syncedAt: "", entries: [] },
    dryingLogs: [log("dl1", [
      { asset: "D-1", type: "LGR 7000XLi", location: "Kitchen", placed: "2026-07-28T15:00", removed: "2026-08-04T09:00", hours: 162 },
      { asset: "A-1", type: "Velo Pro air mover", location: "Kitchen", placed: "2026-07-28T15:00", removed: "2026-08-02T09:00", hours: 114 },
      { asset: "A-2", type: "axial fan", location: "Hall", placed: "2026-07-28T15:00", removed: "2026-08-02T09:00", hours: 114 },
    ], [
      psych("2026-07-29", { dehu: "1", am: "2" }), psych("2026-07-31", { dehu: "1", am: "2" }),
      psych("2026-08-02", { dehu: "1", am: "2" }), psych("2026-08-04", { dehu: "1", am: "0" }),
    ])],
    moistureMaps: [{ id: "mm1", label: "Kitchen", readings: [{ date: "2026-07-29", values: ["22", ""] }, { date: "2026-08-04", values: ["12"] }] }],
    invoices: [{
      id: "inv1", invoiceNo: "1042", invoiceDate: "2026-08-05", billingModel: "tm", terms: "Due on receipt",
      items: [
        { id: "l1", desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", code: "DHM>", qty: "4", unit: "EA", price: "85.05", room: "Kitchen" },
        { id: "l2", desc: "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", qty: "10", unit: "EA", price: "32.25", room: "" },
        { id: "l3", desc: "Water Extraction & Remediation Technician - per hour", code: "LAB", qty: "10", unit: "HR", price: "81.27", room: "" },
        { id: "l4", desc: "Equipment setup, take down, and monitoring (hourly charge)", code: "EQ", qty: "2", unit: "HR", price: "81.27", room: "" },
      ],
    }],
    photos: [], changeOrders: [],
  };
}
const baseEntries = () => [
  qbRow("t1", "2026-07-28", 6, "ts1"),
  qbRow("t2", "2026-07-29", 2.5, "ts2", "2026-08-01T10:00:00Z"),
  qbRow("t2b", "2026-07-29", 2.5, "ts2", "2026-08-02T10:00:00Z"),   // the same timesheet written twice
  qbRow("t3", "2026-07-31", 4, "ts3"),
  qbRow("t4", "2026-08-02", 3.6, "ts4"),
];
const run = (p, opts = {}) => reconcileJob(p, { timeEntries: baseEntries(), today: "2026-08-07", ...opts });
const line = (r, id) => r.lines.find((l) => l.finding_id === id);
const hint = (r, kind) => r.hints.find((h) => h.kind === kind);
const hintsOf = (r, kind) => r.hints.filter((h) => h.kind === kind);

/* ---------- shape checks (K3 B3/B4, B5) used on every result ---------- */
const HINT_KINDS = ["undocumented_days", "photographed_not_logged", "documented_not_billed", "billed_exceeds_documented",
  "log_disagreement", "count_strings_only", "open_equipment_row", "unclassified_equipment", "multiple_rates",
  "labor_source_stale", "manual_hours_present", "monitoring_not_billed", "labor_outside_window", "labor_no_window",
  "labor_not_comparable", "cat3_items_undocumented", "equipment_not_comparable"];
function walk(v, path, visit) {
  visit(v, path);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, visit);
}
const isMoney = (n) => Number.isFinite(n) && Math.round(n * 100) / 100 === n;
/* The exact decimal reference for D17, by the digits (BigInt, no float
   products): Postgres round(qty::numeric * price::numeric, 2), half away from
   zero. hundredths("12.34") = 1234n; cents rounds ten-thousandths to dollars. */
const hundredths = (n) => {
  const [i, f = ""] = String(Math.abs(n)).split(".");
  return (n < 0 ? -1n : 1n) * BigInt(i + (f + "00").slice(0, 2));
};
const cents = (t) => { const a = t < 0n ? -t : t; const c = (a + 50n) / 100n; return Number(t < 0n ? -c : c) / 100; };
const pgAmount = (qty, price) => cents(hundredths(qty) * hundredths(price));
const pgTotal = (lines) => cents(lines.filter((l) => l.price !== null).reduce((a, l) => a + hundredths(l.qty) * hundredths(l.price), 0n));
function checkRef(r, where) {
  assert.ok(r && typeof r === "object", where);
  for (const k of ["kind", "id", "label"]) assert.equal(typeof r[k], "string", `${where}.${k}`);
  assert.ok(r.kind && r.id, `${where} has kind and id`);
  if ("date" in r) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${where}.date`);
}
function checkShape(r) {
  assert.deepEqual(Object.keys(r).sort(), ["evidence_refs", "hints", "job_id", "lines", "rate_invoice_id", "rate_invoice_no",
    "rationale", "scope", "sent", "total_usd", "unpriced_count"]);
  walk(r, "r", (v, path) => {
    assert.notEqual(v, undefined, `${path} is undefined`);
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} is not finite`);
    if (typeof v === "string") assert.ok(!/\b(undefined|NaN|null)\b|\[object Object\]/.test(v), `${path} reads "${v}"`);
  });
  assert.equal(typeof r.sent, "boolean");
  assert.ok(r.rate_invoice_id.length <= 64 && r.rate_invoice_no.length <= 60);
  assert.ok(r.lines.length <= 40 && r.hints.length <= 20 && r.evidence_refs.length <= 10);
  for (const l of r.lines) {
    assert.match(l.finding_id, /^[a-z0-9_:.-]{1,80}$/);
    assert.equal(typeof l.class, "string");
    assert.ok(l.desc.length >= 1 && l.desc.length <= 300, "desc 1..300");
    assert.ok(l.qty === null || Number.isFinite(l.qty), "qty number|null");
    assert.ok(["EA", "DA", "HR", "SF", "LF", "LS"].includes(l.unit), `unit ${l.unit}`);
    assert.ok(l.price === null || (isMoney(l.price) && l.price > 0), "price 2 dp or null");
    assert.ok(l.amount === null || isMoney(l.amount), "amount 2 dp or null");
    assert.equal(l.amount === null, l.price === null, "amount only on a priced line");
    if (l.price !== null) assert.equal(l.amount, pgAmount(l.qty, l.price), "amount = round(qty × price, 2) on the decimals");
    assert.ok(typeof l.room === "string" && l.room.length <= 60);
    assert.ok(typeof l.code === "string" && l.code.length <= 20);
    assert.ok(typeof l.basis === "string" && l.basis.length <= 300 && l.basis.length > 0);
    assert.ok(Array.isArray(l.refs) && l.refs.length <= 10);
    l.refs.forEach((x, i) => checkRef(x, `${l.finding_id}.refs[${i}]`));
  }
  assert.equal(new Set(r.lines.map((l) => l.finding_id)).size, r.lines.length, "finding ids unique");
  for (const h of r.hints) {
    assert.ok(HINT_KINDS.includes(h.kind), `hint kind ${h.kind}`);
    assert.deepEqual(Object.keys(h).sort(), ["kind", "label", "refs"]);
    assert.ok(h.label.length > 0 && h.label.length <= 200);
    assert.ok(h.refs.length <= 10);
    h.refs.forEach((x, i) => checkRef(x, `${h.kind}.refs[${i}]`));
  }
  r.evidence_refs.forEach((x, i) => checkRef(x, `evidence_refs[${i}]`));
  assert.ok(isMoney(r.total_usd));
  // the executor's figure: round(Σ qty × price, 2) over the priced lines (a half cent per line can make it differ from Σ amount)
  assert.equal(r.total_usd, pgTotal(r.lines), "total sums priced lines");
  assert.equal(r.unpriced_count, r.lines.filter((l) => l.price === null).length);
  if (r.lines.length) {
    const [first, ...rest] = r.rationale.split("\n");
    assert.ok(first.length <= 160, `rationale line 1 is ${first.length} chars`);
    assert.equal(rest.join("\n"), LIMITS);
  } else assert.equal(r.rationale, "");
}
const results = [];
const checked = (r) => { checkShape(r); results.push(r); return r; };

/* ---------- constants ---------- */
test("DETECTOR and LIMITS", () => {
  assert.equal(DETECTOR, "billing.reconcile@0.1");
  assert.ok(LIMITS.length > 0 && LIMITS.length <= 600, `LIMITS is ${LIMITS.length} chars`);
  assert.match(LIMITS, /not carrier-grade/);
  assert.match(LIMITS, /hints, never quantities/);
  // Addendum A D19
  assert.match(LIMITS, /compared only on hourly invoices/);
  assert.match(LIMITS, /Cat 3 items become lines only with a record of the work/);
  assert.ok(!/\n/.test(LIMITS));
});

/* ---------- invoice line classing ---------- */
test("invoiceLineClass: price-list and estimating-rules wording", () => {
  const C = (desc, unit = "EA", code = "") => invoiceLineClass({ desc, unit, code, qty: "1", price: "1" });
  // the false friends deployedCounts' regexes would mis-class
  assert.equal(C("HEPA Vacuuming - hourly charge", "HR"), null);
  assert.equal(C("HEPA Vacuuming - Light - (PER SF)", "SF"), null);
  assert.equal(C("HEPA Vacuuming", ""), null);
  assert.equal(C("Add for HEPA filter (for negative air exhaust fan)"), null);
  assert.equal(C("Respirator cartridge - HEPA only (per pair)"), null);
  assert.equal(C("Adhesive remover"), null);
  assert.equal(C("HEPA Vacuuming exposed framing w/ sheathing - Walls", ""), null);
  assert.equal(C("sheathing"), null);
  assert.equal(C("Exhaust fan"), null);
  assert.equal(C("Equipment decontamination charge - per piece of equipment"), null);
  assert.equal(C("Multi-port air mover adapter (per 24 hr period)- No monit."), null);
  assert.equal(C("Air mover snout adapter 48\" (per 24 hr period) - No monit."), null);
  assert.equal(C("Dehumidifier booster (per 24 hour period) - No monitoring"), null);
  assert.equal(C("Booster for thermal air mover/exchange system", "DA"), null);
  assert.equal(C("Equipment setup, take down, and monitoring (hourly charge)", "HR"), null);
  // the real equipment lines ("No monitor." is wording, not a monitoring line)
  assert.equal(C("Air mover axial fan-up to 1/2 (per 24 hr period)"), "airMover");
  assert.equal(C("Air mover axial fan-up to 1/2 (per 24 hr period)-No monit."), "airMover");
  assert.equal(C("Mini air mover (per 24 hour period) - No monitoring"), "airMover");
  assert.equal(C("Axial fan air mover - 1 HP (per 24 hr period)-No monit."), "airMover");
  assert.equal(C("Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor."), "dehu");
  assert.equal(C("LGR dehumidifier"), "dehu");
  assert.equal(C("Dehumidifier (per 24 hour period) - Desiccant - No monit."), "dehu");
  assert.equal(C("Negative air fan/Air scrubber (24 hr period) - No monit.", "DA"), "scrubber");
  assert.equal(C("Neg. air fan/Air scrub. - Large (per 24 hr period) - No monit.", "DA"), "scrubber");
  assert.equal(C("Heat drying - thermal air mover - Electric", "DA"), "heater");
  assert.equal(C("Heat drying - thermal exchanger with air mover - 50 kBtu", "DA"), "heater");
  assert.equal(C("Drying furnace - ind. fired heater w/ducting - 85 kBtuh", "DA"), "heater");
  assert.equal(C("Drying blanket/mat (per 24 hr period) - No monitoring"), null);
  assert.equal(C(""), null);
  assert.equal(invoiceLineClass(null), null);
  assert.equal(invoiceLineClass("DHM"), null);
});

test("invoiceLineClass: the Xactimate selector decides first", () => {
  const K = (code, desc = "", unit = "EA") => invoiceLineClass({ code, desc, unit });
  for (const c of ["DHM", "DHM>", "DHM>>>", "DHMD", "DHMDT9K", "dhm>"]) assert.equal(K(c), "dehu", c);
  assert.equal(K("DHMB", "Dehumidifier booster (per 24 hour period) - No monitoring"), null);
  for (const c of ["DRY", "DRY+", "DRY++", "DRY-"]) assert.equal(K(c), "airMover", c);
  assert.equal(K("DRYMA", "Multi-port air mover adapter (per 24 hr period)- No monit."), null);
  assert.equal(K("DRYSA", "Air mover snout adapter 48\" (per 24 hr period) - No monit."), null);
  assert.equal(K("DRYN", "Tear out wet drywall, no bagging", "SF"), null);
  for (const c of ["NAFAN", "NAFAN>", "NAFAN>>"]) assert.equal(K(c, "", "DA"), "scrubber", c);
  for (const c of ["HEAT", "HEATX>", "HTAM", "HTAM>", "FURN", "FURN40"]) assert.equal(K(c, "", "DA"), "heater", c);
  assert.equal(K("HTAMB", "Booster for thermal air mover/exchange system", "DA"), null);
  // an HR / SF / LF line is never equipment, whatever it says
  assert.equal(K("DHM>", "Dehumidifier", "HR"), null);
  assert.equal(invoiceLineClass({ desc: "Air movers", unit: "hrs" }), null);
  assert.equal(invoiceLineClass({ desc: "Air movers", unit: "LF" }), null);
  for (const c of ["HTIP", "HTX"]) assert.equal(K(c, "", "EA"), "heater", c);
  for (const c of ["HTBL", "HTSC"]) assert.equal(K(c, "", "EA"), null, c);
});

/* Addendum A D13: the descriptions on real invoices, exactly as typed (no
   code), with the units they carry there. The first dry run missed the
   infrared panels and so "found" heater-days the invoice already billed. */
test("D13: real invoice descriptions class as the office meant them", () => {
  const C = (desc, unit) => invoiceLineClass({ desc, unit, code: "", qty: "1", price: "1" });
  const CASES = [
    ["Infrared heat panel (per 24 hr period) - No monitoring", "EA", "heater"],
    ["Drying furnace - ind. fired heater w/ducting - 170 kBtuh", "DA", "heater"],
    ["Heat drying - thermal air mover - Electric", "DA", "heater"],
    ["Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", "EA", "airMover"],
    ["Neg. air fan/Air scrub.-Large (per 24 hr period)-No monit.", "DA", "scrubber"],
    ["Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", "EA", "dehu"],
    ["Add for HEPA filter (for negative air exhaust fan)", "EA", null],
    ["Equipment decontamination charge - per piece of equipment", "EA", null],
    ["Equipment setup, take down, and monitoring (hourly charge)", "HR", null],
  ];
  for (const [desc, unit, want] of CASES) {
    assert.equal(C(desc, unit), want, desc);
    if (want === null) assert.equal(C(desc, "EA"), null, `${desc} (EA)`);   // excluded by its words, not only its unit
  }
  // an infrared-panel job billed in full has no heater gap
  const p = { id: "j", jobType: "restoration", waterCategory: "2", dryingLogs: [log("L", [
    { asset: "H-1", type: "Heater", placed: "2026-08-07T18:00", removed: "2026-08-10T09:00" },
    { asset: "H-2", type: "Heater", placed: "2026-08-07T18:00", removed: "2026-08-10T09:00" },
  ])], invoices: [{ id: "i", billingModel: "tm", items: [{ desc: CASES[0][0], qty: "6", unit: "EA", price: "35" }] }] };
  const r = checked(reconcileJob(p, { today: "2026-08-20" }));
  assert.ok(!line(r, "equip:heater"), "6 heater-days documented, 6 billed");
  assert.ok(!hint(r, "billed_exceeds_documented"));
});

/* The price list's water-heater lines and the heat-drying control system say
   "heater" / "heat drying" but are not drying heaters; as heaters they would
   be billed against heater-days and could set the heater rate. */
test("invoiceLineClass: water heaters, their platform and the heat-drying control system are not heaters", () => {
  const C = (desc, code = "", unit = "EA") => invoiceLineClass({ desc, unit, code, qty: "1", price: "1" });
  for (const d of ["Water heater - Detach", "Water heater - Detach - after hours", "Sensored control system for electric heat drying (24 hr)",
    "Water heater platform - wood frame"]) assert.equal(C(d), null, d);
  assert.equal(C("Sensored control system for electric heat drying (24 hr)", "HTSC"), null, "with its selector too");
  assert.equal(C("Dehumidifier w/environmental control - per 24 hrs"), "dehu", "a bare \"control\" vetoes nothing");
  assert.equal(C("Heat drying - thermal air mover - Electric", "", "DA"), "heater");
  // 5 heater-days (07-28 15:00 → 08-02 09:00)
  const job = (items) => ({ id: "j", jobType: "restoration", waterCategory: "2",
    dryingLogs: [log("L", [{ asset: "H-1", type: "Heater", placed: "2026-07-28T15:00", removed: "2026-08-02T09:00" }])],
    invoices: [{ id: "i", invoiceNo: "1042", billingModel: "tm", items }] });
  let r = checked(reconcileJob(job([{ desc: "Water heater - Detach", qty: "1", unit: "EA", price: "124.44" }]), { today: "2026-08-20" }));
  let h = line(r, "equip:heater");
  assert.deepEqual([h.qty, h.unit, h.price, h.desc], [5, "DA", null, "Heat drying - thermal air mover - Electric"], "no heater billed, no heater rate");
  r = checked(reconcileJob(job([{ desc: "Heat drying - thermal air mover - Electric", qty: "2", unit: "DA", price: "181" },
    { desc: "Sensored control system for electric heat drying (24 hr)", qty: "3", unit: "EA", price: "26.15" }]), { today: "2026-08-20" }));
  h = line(r, "equip:heater");
  assert.deepEqual([h.qty, h.unit, h.price, h.desc], [3, "DA", 181, "Heat drying - thermal air mover - Electric"], "the control days are not heater-days");
});

/* ---------- unit-days ---------- */
const eqDays = (equipment, extra = {}, more = {}) => equipmentUnitDays({ dryingLogs: [log("L", equipment, [], extra)], ...more });

test("unit-day rounding: afternoon set to morning pull is one 24-hour period", () => {
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T15:00", removed: "2026-08-02T09:00" }]).dehu.days, 1);
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T15:00", removed: "2026-08-04T09:00" }]).dehu.days, 3);   // 66 h
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T09:00", removed: "2026-08-03T09:00" }]).dehu.days, 2);   // exactly 48 h
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T09:00", removed: "2026-08-03T09:01" }]).dehu.days, 3);   // a partial period rounds up
});

test("same-day place and pull = 1 (minimum one)", () => {
  assert.equal(eqDays([{ type: "air mover", placed: "2026-08-01T08:00", removed: "2026-08-01T17:00" }]).airMover.days, 1);
  assert.equal(eqDays([{ type: "air mover", placed: "2026-08-01T08:00", removed: "2026-08-01T08:00" }]).airMover.days, 1);
});

test("date-only stamps read as midnight, never shifted by the server's zone", () => {
  assert.equal(eqDays([{ type: "air_mover", placed: "2026-06-20", removed: "2026-06-25" }]).airMover.days, 5);
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T15:00", removed: "2026-08-03" }]).dehu.days, 2);   // 33 h
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01 15:00", removed: "2026-08-03 14:00" }]).dehu.days, 2);
});

test("open rows: end at the log's dry-out finish, else left out with a hint", () => {
  const fin = eqDays([{ asset: "S-1", type: "air scrubber", placed: "2026-08-01T12:00", removed: "" }], { dryoutFinish: "2026-08-04" });
  assert.equal(fin.scrubber.days, 3);                                  // 60 h
  assert.equal(fin.hints.length, 0);
  const open = eqDays([
    { asset: "S-1", type: "air scrubber", placed: "2026-08-01T12:00", removed: "" },
    { asset: "S-2", type: "air scrubber", placed: "2026-08-03T12:00", removed: "2026-08-01T12:00" },   // removed before placed
    { type: "air scrubber", placed: "2026-08-01T12:00", removed: "2026-08-02T12:00" },
  ]);
  assert.equal(open.scrubber.days, 1);
  assert.deepEqual(open.scrubber.rows.map((r) => r.id), ["L#eq2"]);
  const h = open.hints.find((x) => x.kind === "open_equipment_row");
  assert.ok(h && /2 equipment rows/.test(h.label));
  assert.deepEqual(h.refs.map((r) => r.id), ["L#eq0", "L#eq1"]);
});

test("manual hours: ceil(hours / 24)", () => {
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T08:00", removed: "2026-08-09T08:00", hours: "30", _manualHrs: true }]).dehu.days, 2);
  assert.equal(eqDays([{ type: "dehu", hours: "50" }]).dehu.days, 3);   // typed hours, no stamps
  assert.equal(eqDays([{ type: "dehu", placed: "2026-08-01T08:00", removed: "2026-08-02T08:00", hours: 999 }]).dehu.days, 1, "auto hours never override the stamps");
});

/* A removed or dry-out finish stamp ahead of today (a planned pickup, a slip
   of the date picker) has not happened: the row is still running. */
test("an end after today: still running, left out with the hint", () => {
  const p = baseJob();
  p.dryingLogs[0].equipment[0].removed = "2026-08-30T09:00";
  let r = checked(run(p, { today: "2026-08-20" }));
  assert.ok(!line(r, "equip:dehu"), "10 of those days have not happened");
  assert.match(hint(r, "open_equipment_row").label, /^1 equipment row left out of the count \(.*an end after today/);
  assert.deepEqual(hint(r, "open_equipment_row").refs.map((x) => x.id), ["dl1#eq0"]);
  p.dryingLogs[0].equipment[0].removed = "";
  p.dryingLogs[0].dryoutFinish = "2026-08-30";                // the target finish, not the real one
  r = checked(run(p, { today: "2026-08-20" }));
  assert.ok(!line(r, "equip:dehu") && hint(r, "open_equipment_row"));
  // a stamp on today itself has happened
  p.dryingLogs[0].dryoutFinish = "";
  p.dryingLogs[0].equipment[0].removed = "2026-08-20T09:00";
  assert.equal(line(checked(run(p, { today: "2026-08-20" })), "equip:dehu").qty, 19, "07-28 15:00 → 08-20 09:00 is 23 days; 4 billed");
  const one = [{ type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-30T10:00" }];
  assert.equal(eqDays(one).dehu.days, 29, "no today: unchanged");
  assert.equal(equipmentUnitDays({ dryingLogs: [log("L", one)] }, { today: "2026-08-10" }).dehu.days, 0);
});

/* Alaska springs forward 2026-03-08 02:00. The stamps are wall-clock time, so
   a row across the change ran an hour less than its wall span. */
test("spring forward: a row across the change counts the hours it really ran, never one more", () => {
  assert.equal(eqDays([{ type: "dehu", placed: "2026-03-07T10:00", removed: "2026-03-08T10:30" }]).dehu.days, 1, "23.5 h, not 24.5");
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-03-07T10:00", removed: "2026-03-08T10:30" }]).dehu.days, 1, "tagged (the union) too");
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-03-07T10:00", removed: "2026-03-08T20:00" },
    { asset: "D-1", type: "dehu", placed: "2026-03-08T20:00", removed: "2026-03-09T10:30" }]).dehu.days, 2, "47.5 h across touching rows");
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-03-07T10:00", removed: "2026-03-08T12:00" }]).dehu.days, 2, "25 h is two periods");
  // the fall's repeated hour is never added, and date-only stamps stay whole days
  assert.equal(eqDays([{ type: "dehu", placed: "2026-11-01", removed: "2026-11-02" }]).dehu.days, 1);
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-10-31T10:00", removed: "2026-11-01T10:00" }]).dehu.days, 1);
  // typed hours are real hours: 25 typed across the change are two periods in the union as well
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-03-07T10:00", removed: "", hours: 25, _manualHrs: true }]).dehu.days, 2);
  // on a job, a one-day line bills it
  const p = { id: "j", jobType: "restoration", waterCategory: "2",
    dryingLogs: [log("L", [{ type: "LGR", placed: "2026-03-07T10:00", removed: "2026-03-08T10:30" }])],
    invoices: [{ id: "i", billingModel: "tm", items: [{ desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", qty: "1", unit: "EA", price: "85.05" }] }] };
  assert.deepEqual(checked(reconcileJob(p, { today: "2026-03-20" })).lines, []);
});

test("asset dedupe: the same machine in two rows unions its times; different machines add", () => {
  const twoLogs = equipmentUnitDays({ dryingLogs: [
    log("A", [{ asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-04T10:00" }]),
    log("B", [{ asset: "d-1 ", type: "LGR 7000XLi", placed: "2026-08-03T10:00", removed: "2026-08-06T10:00" }]),
  ] });
  assert.equal(twoLogs.dehu.days, 5, "08-01 10:00 → 08-06 10:00 once, not 3 + 3");
  assert.equal(twoLogs.dehu.rows.length, 2);
  // a typed "dh 1" and a scanned DH-001 are one machine: the tag key, not the spelling
  for (const typedTag of ["DH-1", "dh 1", "DH-001"]) {
    const spelled = eqDays([
      { asset: typedTag, type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-08T10:00" },
      { asset: "DH-001", type: "dehu", placed: "2026-08-03T10:00", removed: "2026-08-08T10:00" },
    ]);
    assert.equal(spelled.dehu.days, 7, typedTag);
  }
  const moved = eqDays([
    { asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-02T10:00" },
    { asset: "D-1", type: "dehu", placed: "2026-08-05T10:00", removed: "2026-08-06T10:00" },
  ]);
  assert.equal(moved.dehu.days, 2, "a gap between the rows keeps two periods");
  const two = eqDays([
    { asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
    { asset: "D-2", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
    { type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
    { type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
  ]);
  assert.equal(two.dehu.days, 8, "two tags + two untagged rows = four machines");
  const cross = eqDays([
    { asset: "X-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
    { asset: "X-1", type: "air mover", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" },
  ]);
  assert.ok(cross.dehu.days === 2 && cross.airMover.days === 2, "dedupe is per class");
  // typed hours with no placed time (a duplicate log's copy) never add to the same tag's other rows
  const typed = equipmentUnitDays({ dryingLogs: [
    log("A", [{ asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-04T10:00" }]),
    log("B", [{ asset: "D-1", type: "LGR", hours: 72, _manualHrs: true }]),
  ] });
  assert.equal(typed.dehu.days, 3, "one machine: 3, not 3 + 3");
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", hours: 48 }, { asset: "D-1", type: "dehu", hours: 48 }]).dehu.days, 2);
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", hours: 48 }, { asset: "D-2", type: "dehu", hours: 48 }]).dehu.days, 4, "different tags still add");
  assert.equal(eqDays([{ asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-04T10:00" },
    { asset: "D-1", type: "dehu", hours: 120 }]).dehu.days, 5, "the larger figure stands");
});

test("pooled duplicate logs: rows split across two logs add up", () => {
  const r = equipmentUnitDays({ dryingLogs: [
    log("A", [{ asset: "A-1", type: "air mover", placed: "2026-08-01T10:00", removed: "2026-08-03T10:00" }]),
    log("B", [{ asset: "A-2", type: "air mover", placed: "2026-08-01T10:00", removed: "2026-08-04T10:00" }]),
  ] });
  assert.equal(r.airMover.days, 5);
  assert.deepEqual(r.airMover.rows.map((x) => x.id), ["A#eq0", "B#eq0"]);
  assert.ok(r.airMover.rows.every((x) => x.kind === "equipment_row" && x.label && x.date));
  assert.ok(r.dehu.days === 0 && r.scrubber.days === 0 && r.heater.days === 0);
});

/* Scanned units (scans.js): the scan events are the record. The detector
   derives the rows again from them, on a copy, before counting, so a row a
   newer copy of the log dropped still counts and an undone scan does not;
   a scanned row's evidence id is its scan, not its place in the list. */
test("scanned equipment: rows rebuilt from the scan events on a copy, evidence ids from the scan", () => {
  const ev = (act, tag, id, at, extra = {}) => ({ id, tag, act, at, room: "Kitchen", type: "", model: "", logId: "dl1",
    voids: "", how: "camera", by: "", tech: "", build: "v208", ...extra });
  const p = baseJob();
  p.equipmentScans = [
    ev("place", "AM-007", "s1", "2026-07-28T23:00:00.000Z", { type: "Air mover" }),     // 07-28 15:00 Alaska
    ev("remove", "AM-007", "s2", "2026-08-02T17:00:00.000Z"),                            // 08-02 09:00: 5 days
    ev("place", "AM-008", "s3", "2026-07-28T23:00:00.000Z", { type: "Air mover" }),
    ev("void", "AM-008", "s4", "2026-07-28T23:05:00.000Z", { voids: "s3", room: "", logId: "" }),
    ev("place", "DH-002", "s5", "2026-08-05T17:00:00.000Z", { type: "Dehumidifier", room: "Hall" }),   // still running
  ];
  // the blob's log lost the AM-007 row to a newer copy, and still holds the undone AM-008 one
  p.dryingLogs[0].equipment.push({ asset: "AM-008", type: "Air mover", location: "Kitchen", placed: "2026-07-28T15:00",
    removed: "2026-08-04T09:00", hours: 162, notes: "", scanId: "s3", scan: {} });
  const before = clone(p);
  const r = checked(run(p));
  assert.deepEqual(p, before, "the job itself is never changed");
  const am = line(r, "equip:air_mover");
  assert.equal(am.qty, 5, "15 documented (two typed rows and AM-007), 10 billed; the undone AM-008 is not counted");
  assert.match(am.basis, /15 air-mover-days from 3 unit rows/);
  assert.deepEqual(am.refs.filter((x) => x.kind === "equipment_row").map((x) => x.id), ["dl1#eq1", "dl1#eq2", "dl1#scan:s1"]);
  assert.deepEqual(hint(r, "open_equipment_row").refs.map((x) => x.id), ["dl1#scan:s5"]);
  // the same through equipmentUnitDays, and the id holds when the rows are reordered
  const u = equipmentUnitDays(p, { today: "2026-08-07" });
  assert.equal(u.airMover.days, 15);
  const q = clone(p);
  q.dryingLogs[0].equipment.reverse();
  assert.ok(equipmentUnitDays(q, { today: "2026-08-07" }).airMover.rows.some((x) => x.id === "dl1#scan:s1"));
  // undo every scan: only the typed rows are left, and the stale scanned row is not counted
  p.equipmentScans.push(ev("void", "AM-007", "v1", "2026-08-06T17:00:00.000Z", { voids: "s1" }),
    ev("void", "DH-002", "v2", "2026-08-06T17:00:00.000Z", { voids: "s5" }));
  assert.equal(equipmentUnitDays(p, { today: "2026-08-07" }).airMover.days, 10);
  // every scan event deleted (tombstoned): a leftover scanned row is not counted either
  const gone = clone(p);
  gone.deletedIds = Object.fromEntries(gone.equipmentScans.map((e) => [e.id, "2026-08-06T18:00:00.000Z"]));
  gone.equipmentScans = [];
  assert.equal(equipmentUnitDays(gone, { today: "2026-08-07" }).airMover.days, 10);
  // a copy that simply lacks the scan log (one an older build wrote) keeps its scanned row
  // as the drying record, and it counts like a typed row: 10 + AM-008's 7
  p.equipmentScans = [];
  assert.equal(equipmentUnitDays(p, { today: "2026-08-07" }).airMover.days, 17);
  // and a job with no scans reads exactly as before
  assert.deepEqual(checked(run(baseJob())).lines.map((l) => l.finding_id), ["equip:dehu", "labor:hours"]);
});

test("blank seed rows are ignored; unmatched types raise a hint", () => {
  const r = eqDays([
    { asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" },
    { asset: "G-1", type: "Generator", placed: "2026-08-01T10:00", removed: "2026-08-02T10:00" },
  ]);
  assert.equal(r.hints.length, 1);
  assert.equal(r.hints[0].kind, "unclassified_equipment");
  assert.match(r.hints[0].label, /Generator/);
  assert.deepEqual(Object.keys(r).sort(), ["airMover", "dehu", "heater", "hints", "scrubber"]);
  assert.deepEqual(equipmentUnitDays({}).dehu, { days: 0, rows: [] });
  assert.deepEqual(equipmentUnitDays(null).hints, []);
});

test("D13: placeholder equipment rows (blank, N/A, na, none, -) are skipped silently and bound no window", () => {
  const rows = ["", "N/A", "na", "NONE", "-", " n / a ", "  ", "None "].map((type, i) =>
    ({ asset: "N/A", type, location: "N/A", placed: "2026-06-02T10:00", removed: `2026-06-0${i % 2 ? 4 : 3}T10:01`, hours: 0 }));
  const u = eqDays(rows);
  assert.deepEqual(u.hints, [], "no unclassified_equipment hint");
  for (const cls of ["dehu", "airMover", "scrubber", "heater"]) assert.deepEqual(u[cls], { days: 0, rows: [] });
  // on a job, the placeholder row's stamps do not make a mitigation window: the labor is unchecked, not compared
  const p = baseJob();
  p.dryingLogs[0].equipment = [{ asset: "N/A", type: "N/A", location: "N/A", placed: "2026-07-28T10:00", removed: "2026-07-28T10:01", hours: 0 }];
  p.dryingLogs[0].readings = [];
  const r = checked(run(p));
  assert.ok(!hint(r, "unclassified_equipment"));
  assert.ok(!line(r, "labor:hours"));
  assert.match(hint(r, "labor_no_window").label, /^16\.1 h of labor not checked/);
  assert.ok(!hintsOf(r, "billed_exceeds_documented").some((h) => /HR lines/.test(h.label)), "labor is not compared");
  // a real type is still read, and an unknown one still raises the hint
  assert.equal(eqDays([{ type: "N/A dehu", placed: "2026-08-01T10:00", removed: "2026-08-02T10:00" }]).dehu.days, 1);
  assert.equal(eqDays([{ type: "Generator", placed: "2026-08-01T10:00", removed: "2026-08-02T10:00" }]).hints[0].kind, "unclassified_equipment");
});

/* ---------- count strings: a cross-check, never a quantity ---------- */
test("count strings disagreeing with the unit rows -> log_disagreement hint", () => {
  const r = equipmentUnitDays({ dryingLogs: [log("L",
    [{ asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-05T10:00" }],
    [psych("2026-08-02", { dehu: "4" }), psych("2026-08-03", { dehu: "4" }), psych("2026-08-04", { dehu: "4" }),
      { date: "2026-08-04", dehu: "9", am: "", scrub: "" }])] });   // no T/RH: ignored
  const h = r.hints.find((x) => x.kind === "log_disagreement");
  assert.ok(h, "12 typed vs 3 from rows");
  assert.match(h.label, /12 unit-days on 3 dates.*3 on those dates/);
  assert.ok(h.refs.every((x) => x.kind === "psych_row" && x.id.startsWith("L@")));
  assert.equal(r.dehu.days, 4, "the unit rows still decide the figure");
  const agree = equipmentUnitDays({ dryingLogs: [log("L",
    [{ asset: "D-1", type: "dehu", placed: "2026-08-01T10:00", removed: "2026-08-05T10:00" }],
    [psych("2026-08-02", { dehu: "1" }), psych("2026-08-03", { dehu: "2" })])] });
  assert.ok(!agree.hints.some((x) => x.kind === "log_disagreement"), "within max(2, 20%)");
});

test("count strings with no unit rows -> count_strings_only, and no line", () => {
  const p = baseJob();
  p.dryingLogs[0].equipment = [];
  p.dryingLogs[0].readings = [psych("2026-07-29", { dehu: "2", am: "6", scrub: "1" }), psych("2026-07-30", { dehu: "2", am: "6" })];
  p.dateOfLoss = "";
  const u = equipmentUnitDays(p);
  assert.deepEqual(u.hints.filter((h) => h.kind === "count_strings_only").map((h) => h.label.split(" ")[3]), ["4", "12", "1"]);
  const r = checked(run(p));
  assert.ok(!r.lines.some((l) => l.finding_id.startsWith("equip:")), "typed counts never become a line");
  assert.ok(hint(r, "count_strings_only"));
});

/* ---------- the base job, end to end ---------- */
test("base job: a dehu line at the invoice's own rate and a labor line", () => {
  const r = checked(run(baseJob()));
  assert.deepEqual(r.scope, { ok: true, reason: "in_scope" });
  assert.equal(r.job_id, "11111111-2222-3333-4444-555555555555");
  assert.equal(r.sent, false);
  assert.equal(r.rate_invoice_id, "inv1");
  assert.equal(r.rate_invoice_no, "1042");
  assert.deepEqual(r.lines.map((l) => l.finding_id), ["equip:dehu", "labor:hours"]);
  const d = line(r, "equip:dehu");
  assert.deepEqual([d.class, d.qty, d.unit, d.price, d.amount, d.code, d.room], ["dehu", 3, "EA", 85.05, 255.15, "DHM>", "Kitchen"]);
  assert.equal(d.desc, "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.");
  assert.match(d.basis, /7 dehu-days from 1 unit row, 07-28→08-04/);
  assert.match(d.basis, /invoiced 4; 3 not billed/);
  assert.deepEqual(d.refs.map((x) => x.kind), ["equipment_row", "invoice_line"]);
  assert.equal(d.refs[1].id, "inv1#0");
  // 6 + 2.5 (one timesheet, written twice) + 4 + 3.6 = 16.1 h documented; 12 h billed; 4.1 → 4.00 in quarter hours
  const l = line(r, "labor:hours");
  assert.deepEqual([l.class, l.qty, l.unit, l.price, l.amount, l.code], ["labor", 4, "HR", 81.27, 325.08, "LAB"]);
  assert.match(l.basis, /16\.1 h from 4 entries in QuickBooks Time, 07-27→08-06/);
  assert.equal(l.refs[0].kind, "time_entries");
  assert.equal(l.refs[0].id, "JC1");
  assert.ok(l.refs.some((x) => x.id === "t2b") && !l.refs.some((x) => x.id === "t2"), "the later write of a timesheet wins");
  assert.equal(r.total_usd, 580.23);
  assert.equal(r.unpriced_count, 0);
  assert.equal(r.rationale.split("\n")[0], "Add 2 lines ($580.23) to Doe: dehu-days, labor hours");
  // air movers: 5 + 5 documented, 10 billed → nothing; monitoring is billed (EQ)
  assert.ok(!line(r, "equip:air_mover") && !hint(r, "monitoring_not_billed"));
  assert.ok(r.evidence_refs.length >= 3 && r.evidence_refs[0].kind === "drying_log");
});

test("undocumented days: equipment on, no reading that day -> a hint, never a line", () => {
  const r = checked(run(baseJob()));
  const h = hint(r, "undocumented_days");
  assert.ok(h);
  assert.match(h.label, /^4 days with equipment running and no reading \(unsupported days, not a billing gap\): 07-28, 07-30, 08-01, 08-03$/);
  assert.deepEqual(h.refs.map((x) => [x.kind, x.id, x.label]), [["drying_log", "dl1", "Drying log, equipment 07-28→08-04"]]);
  // filling those days with readings changes no line
  const p = baseJob();
  p.dryingLogs[0].readings.push(psych("2026-07-28"), psych("2026-07-30"), psych("2026-08-01"), psych("2026-08-03"));
  const r2 = checked(run(p));
  assert.ok(!hint(r2, "undocumented_days"));
  assert.equal(findingsKey(r2.lines), findingsKey(r.lines));
  // the dry-out window, when set, is the window
  const q = baseJob();
  q.dryingLogs[0].dryoutStart = "2026-07-30";
  q.dryingLogs[0].dryoutFinish = "2026-08-01";
  assert.match(hint(checked(run(q)), "undocumented_days").label, /^2 days with .*: 07-30, 08-01$/);
});

test("a void invoice bills nothing; a contract's equipment lines count as billed", () => {
  const p = baseJob();
  p.invoices.push(
    { id: "void1", invoiceNo: "1040", invoiceDate: "2026-08-06", status: "void", billingModel: "tm",
      items: [{ desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", qty: "50", unit: "EA", price: "99" }] },
    { id: "con1", invoiceNo: "C-1", invoiceDate: "2026-08-06", billingModel: "contract", contractAmount: "5000",
      items: [{ desc: "LGR dehumidifier", qty: "50", unit: "EA", price: "1" }] },
  );
  let r = checked(run(p));
  assert.ok(!line(r, "equip:dehu"), "the contract's scope lists 50 dehu-days: billed");
  const over = hintsOf(r, "billed_exceeds_documented").find((h) => /dehu-days/.test(h.label));
  assert.match(over.label, /^Invoiced 54 dehu-days; the drying log documents 7/, "4 T&M + 50 contract; the void 50 never count");
  assert.ok(over.refs.some((x) => x.id === "con1#0") && !over.refs.some((x) => x.id.startsWith("void1")));
  assert.equal(r.rate_invoice_id, "inv1", "the newest NON-void T&M invoice is the rate invoice");
  p.invoices.pop();
  r = checked(run(p));
  assert.equal(line(r, "equip:dehu").qty, 3, "billed is still 4 from the T&M invoice");
  assert.equal(line(r, "equip:dehu").price, 85.05);
});

/* A drying bid ("Structural drying per SF - Class 2 (Bid Item)", the WTR lump
   sum) or a contract with no itemised scope prices the equipment as one item:
   the unit-days can't be compared, so one hint and no equipment line. */
test("equipment priced inside a drying bid or an unitemised contract -> equipment_not_comparable, no line", () => {
  const bid = (over = {}) => { const p = baseJob(); p.invoices[0].items = [
    { desc: "Structural drying per SF - Class 2 (Bid Item)", code: "DRY2", qty: "800", unit: "SF", price: "2.1" },
    { desc: "Water Extraction & Remediation Technician - per hour", code: "LAB", qty: "16", unit: "HR", price: "81.27" }]; Object.assign(p.invoices[0].items[0], over); return p; };
  let r = checked(run(bid()));
  assert.ok(!r.lines.some((l) => l.finding_id.startsWith("equip:")), "7 dehu-days and 10 air-mover-days are inside the bid");
  const h = hintsOf(r, "equipment_not_comparable");
  assert.equal(h.length, 1);
  assert.equal(h[0].label, "The drying log documents 7 dehu-days, 10 air-mover-days; invoice 1042 prices drying as one item, so unit-days can't be compared.");
  assert.deepEqual(h[0].refs.map((x) => [x.kind, x.id]), [["invoice_line", "inv1#0"]]);
  assert.ok(!hint(r, "billed_exceeds_documented"));
  // by its selector alone (per CF), and the WTR lump sum
  assert.ok(hint(checked(run(bid({ desc: "Drying - bid", code: "DRY2CF", unit: "CF" }))), "equipment_not_comparable"));
  assert.ok(hint(checked(run(bid({ desc: "Water Extraction & Remediation (Bid Item)", code: "BIDITM", qty: "1", unit: "EA" }))), "equipment_not_comparable"));
  // other bid items, and APP's DRYC (a clothes dryer, EA), cover no equipment
  for (const it of [{ desc: "Dryer - Light commercial", code: "DRYC", unit: "EA" }, { desc: "Thermal imaging - (Bid Item)", code: "BIDITM", unit: "EA" },
    { desc: "Drywall (Bid Item)", code: "BIDITM", unit: "EA" }, { desc: "Drywall (Agreed Price)", code: "AGP", unit: "EA" }]) {
    r = checked(run(bid({ qty: "1", ...it })));
    assert.ok(!hint(r, "equipment_not_comparable"), it.desc);
    assert.deepEqual([line(r, "equip:dehu").qty, line(r, "equip:air_mover").qty], [7, 10], it.desc);
  }
  // a contract's itemised scope counts as billed; one with only the blank seed line covers the equipment
  const q = baseJob();
  q.invoices[0].items = q.invoices[0].items.filter((it) => it.unit === "HR");
  q.invoices.push({ id: "con1", invoiceNo: "C-1", invoiceDate: "2026-08-01", billingModel: "contract", contractAmount: "4000",
    items: [{ desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", code: "DHM>", qty: "7", unit: "EA", price: "" },
      { desc: "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", code: "DRY+", qty: "10", unit: "EA", price: "" }] });
  r = checked(run(q));
  assert.ok(!r.lines.some((l) => l.finding_id.startsWith("equip:")) && !hint(r, "equipment_not_comparable"));
  q.invoices[1].items = [{ id: "x", desc: "", qty: "", unit: "", price: "" }];
  r = checked(run(q));
  assert.ok(!r.lines.some((l) => l.finding_id.startsWith("equip:")));
  assert.match(hint(r, "equipment_not_comparable").label, /; invoice C-1 is a set amount with no itemised scope, so unit-days can't be compared\.$/);
  assert.deepEqual(hint(r, "equipment_not_comparable").refs.map((x) => [x.kind, x.id]), [["invoice", "con1"]]);
  // on a Cat 3 job the bid prices the scrubbers too: no negative-air line from the rows
  const c = bid();
  c.waterCategory = "3";
  c.dryingLogs[0].equipment.push({ asset: "S-1", type: "air scrubber", placed: "2026-07-28T15:00", removed: "2026-07-30T15:00" });
  r = checked(run(c));
  assert.ok(!line(r, "equip:scrubber") && !line(r, "cat3:negative_air"));
  assert.match(hint(r, "equipment_not_comparable").label, /2 scrubber-days/);
});

test("rate pick: the newest invoice with the class, its largest-qty line; multiple_rates hint", () => {
  const p = baseJob();
  p.invoices[0].items.push({ desc: "Dehumidifier (per 24 hr period)- up to 69 ppd- No monitor.", code: "DHM", qty: "1", unit: "EA", price: "62.62" });
  p.invoices.unshift({ id: "inv0", invoiceNo: "1001", invoiceDate: "2026-07-30", billingModel: "tm",
    items: [{ desc: "Dehumidifier (per 24 hr period)- 110-159 ppd - No monitor.", code: "DHM>>", qty: "1", unit: "EA", price: "119.44" }] });
  p.invoices.push({ id: "inv2", invoiceNo: "1050", invoiceDate: "2026-08-06", billingModel: "tm",
    items: [{ desc: "Haul debris - per pickup truck load", qty: "1", unit: "EA", price: "150" }] });
  const r = checked(run(p));
  // billed 4 + 1 + 1 = 6 → delta 1; the rate comes from inv1 (newest WITH a dehu line), its 4-qty line
  const d = line(r, "equip:dehu");
  assert.deepEqual([d.qty, d.price, d.code, d.refs[d.refs.length - 1].id], [1, 85.05, "DHM>", "inv1#0"]);
  assert.equal(r.rate_invoice_id, "inv1", "D16: the rate invoice (terms, O&P) is the newest T&M invoice with an equipment line, not inv2");
  const h = hint(r, "multiple_rates");
  assert.ok(h);
  assert.match(h.label, /^Dehu lines carry 3 rates \(\$62\.62, \$85\.05, \$119\.44\)/);
  // no dehu line anywhere: unpriced, the price list's words, never its price
  const q = baseJob();
  q.invoices[0].items.splice(0, 1);
  const u = line(checked(run(q)), "equip:dehu");
  assert.deepEqual([u.qty, u.unit, u.price, u.amount, u.code], [7, "EA", null, null, "DHM>"]);
  assert.equal(u.desc, "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.");
  assert.match(u.basis, /No dehu line on this job's invoices/);
  const rq = run(q);
  assert.equal(rq.unpriced_count, 1);
  assert.equal(rq.total_usd, 325.08);
  assert.match(rq.rationale, /^Add 2 lines \(\$325\.08, 1 unpriced\) to Doe: dehu-days, labor hours\n/);
});

/* Addendum A D16: a job billed as a mitigation invoice and a later rebuild
   invoice named the rebuild one as the rate invoice. */
test("D16: the rate invoice is the newest T&M invoice holding an equipment line, else the newest", () => {
  const rebuild = (over = {}) => ({ id: "rb1", invoiceNo: "R-2", invoiceDate: "2026-08-05", billingModel: "tm", terms: "Net 30",
    items: [{ desc: "1/2\" - drywall per LF - up to 2' tall", qty: "20", unit: "LF", price: "15" }], ...over });
  const p = baseJob();
  p.invoices.push(rebuild());                                  // same date, created later: the newest
  p.invoices[0].createdAt = "2026-08-05T09:10:00Z";
  p.invoices[1].createdAt = "2026-08-05T15:40:00Z";
  let r = checked(run(p));
  assert.deepEqual([r.rate_invoice_id, r.rate_invoice_no], ["inv1", "1042"]);
  assert.ok(r.evidence_refs.some((x) => x.kind === "invoice" && x.id === "inv1" && /rates and terms from invoice 1042/.test(x.label)));
  // a later invoice with an equipment line takes over
  p.invoices.push({ id: "inv3", invoiceNo: "1043", invoiceDate: "2026-08-09", billingModel: "tm",
    items: [{ desc: "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", qty: "1", unit: "EA", price: "32.25" }] });
  assert.equal(checked(run(p)).rate_invoice_id, "inv3");
  // void and contract invoices never set it, even holding equipment lines
  p.invoices[2].status = "void";
  p.invoices.push({ id: "con1", invoiceNo: "C-1", invoiceDate: "2026-08-10", billingModel: "contract", contractAmount: "900",
    items: [{ desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", qty: "1", unit: "EA", price: "1" }] });
  assert.equal(checked(run(p)).rate_invoice_id, "inv1");
  // no equipment line on any T&M invoice: the newest one
  const q = baseJob();
  q.invoices[0].items = q.invoices[0].items.filter((it) => it.unit === "HR");
  q.invoices.push(rebuild({ invoiceDate: "2026-08-06" }));
  assert.deepEqual([checked(run(q)).rate_invoice_id, run(q).rate_invoice_no], ["rb1", "R-2"]);
});

/* A credit ("Credit - … not run", qty 1 at a negative price as the office
   writes it, or a negative qty) takes units off what is billed and is never
   the rate line, nor makes its invoice the rate invoice. */
test("credits take units off and never set the rate", () => {
  const p = baseJob();
  p.dryingLogs[0].equipment.push({ asset: "A-3", type: "air mover", location: "Den", placed: "2026-07-28T15:00", removed: "2026-08-02T09:00" });
  p.invoices[0].items[1].qty = "12";                         // 15 air-mover-days documented, 12 billed
  p.invoices.push({ id: "inv2", invoiceNo: "1043", invoiceDate: "2026-08-09", billingModel: "tm",
    items: [{ desc: "Credit - Air mover axial fan (per 24 hr period) - 2 days not run", qty: "1", unit: "", price: "-64.50" }] });
  let r = checked(run(p));
  let a = line(r, "equip:air_mover");
  assert.deepEqual([a.qty, a.price, a.unit, a.desc], [4, 32.25, "EA", "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit."]);
  assert.match(a.basis, /invoiced 11; 4 not billed\. Rate from invoice 1042 line 2\.$/);
  assert.ok(!r.lines.some((l) => /^credit/i.test(l.desc)));
  assert.equal(r.rate_invoice_id, "inv1", "an invoice holding only a credit is not where the rates are");
  p.invoices[1].items[0] = { desc: "Credit - Air mover axial fan (per 24 hr period) - 2 days not run", qty: "-2", unit: "EA", price: "32.25" };
  a = line(checked(run(p)), "equip:air_mover");
  assert.deepEqual([a.qty, a.price, a.refs[a.refs.length - 1].id], [5, 32.25, "inv1#1"]);
  assert.match(a.basis, /invoiced 10; 5 not billed/);
  // the same on the hours: a credit HR line is billed hours taken off
  const q = baseJob();
  q.invoices[0].items.push({ desc: "Credit - Water Extraction & Remediation Technician - per hour", code: "LAB", qty: "2", unit: "HR", price: "-81.27" });
  const l = line(checked(run(q)), "labor:hours");
  assert.deepEqual([l.qty, l.price, l.desc], [6, 81.27, "Water Extraction & Remediation Technician - per hour"]);
});

test("a line with no price on the job's invoice stays unpriced but keeps its wording", () => {
  const p = baseJob();
  p.invoices[0].items[0].price = "";
  p.invoices[0].items[0].unit = "day";
  const d = line(checked(run(p)), "equip:dehu");
  assert.deepEqual([d.price, d.amount, d.unit, d.code], [null, null, "DA", "DHM>"]);
  assert.match(d.basis, /has no price/);
});

/* ---------- cents (Addendum A D17) ---------- */
/* Money rounds as Postgres round(numeric, 2) does, half away from zero on the
   decimal, so the card, the detector and the executor agree to the cent:
   Math.round(n * 100) / 100 makes 1.005 → 1.00 and 1.5 × 85.05 → 127.57,
   because the doubles sit just under the half. */
test("D17: half away from zero on the decimals; the total is round(Σ qty × price) like the executor's", () => {
  const p = baseJob();
  p.invoices[0].items[0].qty = "5.5";                        // 7 documented → 1.5 dehu-days at 85.05 = 127.575
  p.invoices[0].items[2].qty = "13.6";                       // 16.1 h vs 15.6 → 0.5 h at 6.17 = 3.085 (the 0.25 × 12.34 case)
  p.invoices[0].items[2].price = "6.17";
  const r = checked(run(p));
  const d = line(r, "equip:dehu"), l = line(r, "labor:hours");
  assert.deepEqual([d.qty, d.price, d.amount], [1.5, 85.05, 127.58]);
  assert.deepEqual([l.qty, l.price, l.amount], [0.5, 6.17, 3.09]);
  assert.equal(pgAmount(0.25, 12.34), 3.09, "the reference itself");
  // the executor sums the exact products and rounds once: 130.66, not 127.58 + 3.09
  assert.equal(r.total_usd, 130.66);
  assert.equal(r.rationale.split("\n")[0], "Add 2 lines ($130.66) to Doe: dehu-days, labor hours");
  // a 3-dp rate rounds half up to the cent
  const q = baseJob();
  q.invoices[0].items[0].price = "1.005";
  const e = line(checked(run(q)), "equip:dehu");
  assert.deepEqual([e.qty, e.price, e.amount], [3, 1.01, 3.03]);
  // a rate under half a cent is no rate
  q.invoices[0].items[0].price = "0.004";
  const z = line(checked(run(q)), "equip:dehu");
  assert.deepEqual([z.price, z.amount], [null, null]);
  assert.match(z.basis, /has no price/);
});

/* ---------- negative deltas ---------- */
test("billed more than documented -> a hint, never a negative line", () => {
  const p = baseJob();
  p.invoices[0].items[0].qty = "12";      // 12 dehu-days billed vs 7
  p.invoices[0].items[2].qty = "30";      // 32 h billed vs 16.1
  const r = checked(run(p));
  assert.equal(r.lines.length, 0);
  const hs = hintsOf(r, "billed_exceeds_documented");
  assert.equal(hs.length, 2);
  assert.match(hs[0].label, /Invoiced 12 dehu-days; the drying log documents 7/);
  assert.match(hs[1].label, /Invoiced 32 h on HR lines; QuickBooks Time has 16\.1 h/);
  assert.ok(r.lines.every((l) => l.qty === null || l.qty > 0));
  assert.equal(r.rationale, "");
  // billed hours with no labor source at all (no jobcode rows, no snapshot): no labor finding either way
  const none = checked(run(p, { timeEntries: [] }));
  assert.deepEqual(hintsOf(none, "billed_exceeds_documented").map((h) => h.label.split(";")[0]), ["Invoiced 12 dehu-days"]);
  // under one unit-day / half an hour either way: nothing at all
  const q = baseJob();
  q.invoices[0].items[0].qty = "7.5";
  q.invoices[0].items[2].qty = "14.2";    // 16.2 billed vs 16.1
  const rq = checked(run(q));
  assert.equal(rq.lines.length, 0);
  assert.equal(hintsOf(rq, "billed_exceeds_documented").length, 0);
});

/* ---------- labor ---------- */
/* laborLog.startDate is where reconstruction starts (the field app's "Count
   labor from (start date)": hours before it are the mitigation). Both phases
   share one QuickBooks jobcode, so this check keeps the hours BEFORE it. */
test("labor: startDate ends the mitigation; timesheet dedupe and the half-hour threshold", () => {
  const p = baseJob();
  const rebuild = baseEntries().concat([qbRow("t9", "2026-08-05", 8, "ts9"), qbRow("t10", "2026-08-06", 8, "ts10")]);
  let r = checked(run(p, { timeEntries: rebuild }));
  assert.equal(line(r, "labor:hours").qty, 20, "no start date: the +2-day tail takes the rebuild's first days in");
  p.laborLog.startDate = "2026-08-05";                      // the rebuild crew starts 08-05
  r = checked(run(p, { timeEntries: rebuild }));
  const l = line(r, "labor:hours");
  assert.equal(l.qty, 4, "16.1 h of mitigation vs 12 billed, as without the rebuild rows");
  assert.ok(!l.refs.some((x) => x.id === "t9" || x.id === "t10"), "the rebuild timesheets are not its evidence");
  assert.match(l.basis, /07-27→08-04/, "the window closes the day before the start date");
  assert.ok(!hint(r, "labor_outside_window"), "reconstruction hours are not outside the mitigation, they are another phase");
  // a start date before the window: no mitigation hours at all, so nothing either way
  p.laborLog.startDate = "2026-07-20";
  r = checked(run(p, { timeEntries: rebuild }));
  assert.ok(!line(r, "labor:hours") && !hint(r, "billed_exceeds_documented"));
  p.laborLog.startDate = "2026-08-02";                      // 08-02's 3.6 h are reconstruction-side
  r = checked(run(p));
  assert.equal(line(r, "labor:hours").qty, 0.5, "6 + 2.5 (ts2 once) + 4 = 12.5 h vs 12 billed: a delta of exactly 0.5 h makes a line");
  assert.equal(hintsOf(r, "billed_exceeds_documented").length, 0);
});

test("labor delta rounding to quarter hours, and the 0.5 h edge", () => {
  const p = baseJob();
  p.invoices[0].items[2].qty = "13.6";                      // billed 15.6 vs 16.1 → 0.5
  let l = line(checked(run(p)), "labor:hours");
  assert.equal(l.qty, 0.5);
  p.invoices[0].items[2].qty = "13.7";                      // 0.4 → nothing
  assert.ok(!line(checked(run(p)), "labor:hours"));
  p.invoices[0].items[2].qty = "7.2";                       // 6.9 → 7.0
  l = line(checked(run(p)), "labor:hours");
  assert.equal(l.qty, 7);
  p.invoices[0].items[2].qty = "7.9";                       // 6.2 → 6.25
  assert.equal(line(checked(run(p)), "labor:hours").qty, 6.25);
});

test("D6 window: hours outside it are a hint only", () => {
  const entries = baseEntries().concat([
    qbRow("t6", "2026-07-10", 5, "ts6"),                     // before the date of loss
    qbRow("t7", "2026-08-07", 4, "ts7"),                     // after removed 08-04 + 2
    qbRow("t8", "", 1, "ts8"),                               // undated
  ]);
  const r = checked(run(baseJob(), { timeEntries: entries }));
  assert.equal(line(r, "labor:hours").qty, 4, "same as without them");
  const h = hint(r, "labor_outside_window");
  assert.ok(h);
  assert.match(h.label, /^10 h dated outside the mitigation window 07-27→08-06/);
  assert.deepEqual(h.refs.map((x) => x.id), ["t8", "t6", "t7"]);
  // the window reaches back to the first placed / dry-out start when the date of loss is later or blank
  const p = baseJob();
  p.dateOfLoss = "";
  p.dryingLogs[0].dryoutStart = "2026-07-26";
  const r2 = checked(run(p, { timeEntries: baseEntries().concat([qbRow("t9", "2026-07-26", 1, "ts9")]) }));
  assert.equal(line(r2, "labor:hours").qty, 5);
  assert.ok(!hint(r2, "labor_outside_window"));
});

test("D6 window: none can be formed -> labor_no_window, no labor line", () => {
  const p = baseJob();
  for (const e of p.dryingLogs[0].equipment) e.removed = "";      // still running, no dry-out finish
  p.dryingLogs[0].equipment.forEach((e) => { e.hours = ""; });
  const r = checked(run(p));
  assert.ok(!line(r, "labor:hours"));
  const h = hint(r, "labor_no_window");
  assert.ok(h);
  assert.match(h.label, /^16\.1 h of labor not checked/);
  assert.ok(hint(r, "open_equipment_row"));
  // no labor at all: no hint either
  const r2 = checked(run(p, { timeEntries: [] }));
  assert.ok(!hint(r2, "labor_no_window"));
});

test("labor falls back to the Labor Log snapshot when QuickBooks Time has no rows", () => {
  const p = baseJob();
  p.qbJobcodeId = "";
  p.laborLog = { id: "ll9", syncedAt: "2026-08-06T18:00:00Z", startDate: "2026-08-05", entries: [
    { date: "2026-08-05", employee: "Tech A", hours: "8", qbId: "q0" },          // reconstruction (from startDate)
    { date: "2026-07-28", employee: "Tech A", hours: "9.5", qbId: "q1" },
    { date: "2026-07-30", employee: "Tech B", hours: "6", qbId: "" },
  ] };
  const r = checked(run(p, { timeEntries: [] }));
  const l = line(r, "labor:hours");
  assert.equal(l.qty, 3.5);                                   // 15.5 - 12
  assert.match(l.basis, /Labor Log snapshot synced 2026-08-06/);
  assert.deepEqual(l.refs.slice(0, 3).map((x) => [x.kind, x.id]), [["labor_log", "ll9"], ["labor_entry", "q1"], ["labor_entry", "ll9#2"]]);
});

test("labor: board hours are not counted (hint); technician line sets the rate; stale pull hint", () => {
  const entries = baseEntries().concat([{ id: "b1", date: "2026-07-30", hours: 5, updated_at: "2026-08-01T00:00:00Z" }]);
  const r = checked(run(baseJob(), { timeEntries: entries }));
  assert.equal(line(r, "labor:hours").qty, 4);
  assert.match(hint(r, "manual_hours_present").label, /^1 hour row \(5 h\) not from QuickBooks Time/);
  // rate: the technician line beats a bigger non-technician HR line
  const p = baseJob();
  p.invoices[0].items.push({ desc: "HEPA Vacuuming - hourly charge", code: "HEPAVAC", qty: "1", unit: "HR", price: "84.56" });
  p.invoices[0].items[3].qty = "11";                          // EQ 11 h > LAB 10 h
  p.invoices[0].items[2].qty = "1";
  const l = line(checked(run(p)), "labor:hours");
  assert.deepEqual([l.qty, l.price, l.code], [3, 81.27, "LAB"]);
  assert.equal(l.refs[l.refs.length - 1].id, "inv1#2");
  // no HR line at all: unpriced technician hours
  const q = baseJob();
  q.invoices[0].items.splice(2, 2);
  const u = line(checked(run(q)), "labor:hours");
  assert.deepEqual([u.qty, u.unit, u.price, u.desc], [16, "HR", null, "Water Extraction & Remediation Technician - per hour"]);
  // the newest row was written 07-30, before the window closed (08-06), and today is 08-20
  const old = baseEntries().map((e) => ({ ...e, updated_at: "2026-07-30T20:00:00Z" }));
  const s = checked(run(baseJob(), { timeEntries: old, today: "2026-08-20" }));
  assert.match(hint(s, "labor_source_stale").label, /last written 2026-07-30/);
  assert.ok(!hint(checked(run(baseJob())), "labor_source_stale"));
});

/* ---------- labor comparability (Addendum A D14) ---------- */
/* A T&M invoice that prices its work per SF/LF or per piece (tear out,
   remove, apply…) carries the labor inside those unit prices, so QuickBooks
   Time hours against HR lines alone would read as a gap that is not there. */
test("D14: unit-priced work on any T&M invoice -> labor_not_comparable, no labor line and no labor billed_exceeds hint", () => {
  const p = baseJob();
  p.invoices[0].items.push(
    { desc: "Tear out wet drywall, cleanup, bag, per LF - up to 2' tall", qty: "30", unit: "LF", price: "5" },
    { desc: "Apply anti-microbial agent to the surface area", qty: "120", unit: "SF", price: "0.4" },
    { desc: "Remove Toilet", qty: "1", unit: "EA", price: "40" },                    // EA, but a piece of work
  );
  const r = checked(run(p, { timeEntries: baseEntries().concat([qbRow("t9", "2026-08-20", 3, "ts9")]) }));
  assert.ok(!line(r, "labor:hours"), "16.1 h vs 12 h would have been a 4 h line");
  assert.ok(line(r, "equip:dehu"), "equipment still reconciles");
  const hs = hintsOf(r, "labor_not_comparable");
  assert.equal(hs.length, 1);
  assert.equal(hs[0].label, "QuickBooks Time has 16.1 h in the mitigation window 07-27→08-06; HR lines bill 12 h; " +
    "the rest of the labor is priced inside 3 unit-priced lines, so hours can't be compared.");
  assert.deepEqual(hs[0].refs.map((x) => [x.kind, x.id]), [["time_entries", "JC1"], ["invoice_line", "inv1#4"], ["invoice_line", "inv1#5"], ["invoice_line", "inv1#6"]]);
  assert.match(hint(r, "labor_outside_window").label, /^3 h dated outside the mitigation window/, "labor_outside_window still fires");
  // billed hours above the documented ones say nothing about labor either
  p.invoices[0].items[2].qty = "40";
  const r2 = checked(run(p));
  assert.ok(!hintsOf(r2, "billed_exceeds_documented").some((h) => /HR lines/.test(h.label)));
  assert.match(hint(r2, "labor_not_comparable").label, /HR lines bill 42 h/);
  // one rebuild invoice with SF lines is enough, whatever the mitigation invoice does
  const q = baseJob();
  q.invoices.push({ id: "rb1", invoiceNo: "R-1", invoiceDate: "2026-08-06", billingModel: "tm",
    items: [{ desc: "Paint the surface area - two coats", qty: "60", unit: "SF", price: "1.6" }] });
  assert.ok(!line(checked(run(q)), "labor:hours"));
  // …but not a void one
  q.invoices[1].status = "void";
  assert.equal(line(checked(run(q)), "labor:hours").qty, 4);
  // a contract (here the rebuild) prices its labor inside a set amount: not comparable either
  q.invoices[1].status = "";
  q.invoices[1].billingModel = "contract";
  let rc = checked(run(q));
  assert.ok(!line(rc, "labor:hours"));
  assert.equal(hint(rc, "labor_not_comparable").label, "QuickBooks Time has 16.1 h in the mitigation window 07-27→08-06; HR lines bill 12 h; " +
    "invoice R-1 is a contract (a set amount), so hours can't be compared.");
  assert.deepEqual(hint(rc, "labor_not_comparable").refs.map((x) => [x.kind, x.id]), [["time_entries", "JC1"], ["invoice", "rb1"]]);
  // the rebuild crew's first days inside the +2-day tail never become a labor line beside a contract rebuild
  const full = baseJob();
  full.invoices[0].items[0].qty = "7";
  full.invoices[0].items[2].qty = "14.1";
  full.invoices.push({ id: "rb1", invoiceNo: "R-1", invoiceDate: "2026-08-06", billingModel: "contract", contractAmount: "9000", items: [] });
  rc = checked(run(full, { timeEntries: baseEntries().concat([qbRow("t9", "2026-08-05", 8, "ts9"), qbRow("t10", "2026-08-06", 8, "ts10")]) }));
  assert.ok(!line(rc, "labor:hours"), "16 rebuild hours in the tail are not unbilled mitigation labor");
  assert.ok(hint(rc, "labor_not_comparable"));
  // no labor rows at all: nothing to say
  assert.ok(!hint(checked(run(p, { timeEntries: [] })), "labor_not_comparable"));
  // the Labor Log snapshot names itself
  const s = baseJob();
  s.invoices[0].items.push({ desc: "Remove Carpet pad", qty: "150", unit: "SF", price: "0.2" });
  s.qbJobcodeId = "";
  s.laborLog = { id: "ll9", syncedAt: "2026-08-06T18:00:00Z", startDate: "", entries: [{ date: "2026-07-28", hours: "9.55", qbId: "q1" }] };
  assert.match(hint(checked(run(s, { timeEntries: [] })), "labor_not_comparable").label,
    /^The Labor Log snapshot synced 2026-08-06 has 9\.6 h in the mitigation window 07-27→08-06; HR lines bill 12 h;.*inside 1 unit-priced line, so/);
});

test("D14: a T&M job that bills its work by the hour still gets its labor line", () => {
  const p = baseJob();
  // lines with no work in their unit price: equipment, hourly labor, and per-each charges that are not a piece of work
  p.invoices[0].items.push(
    { desc: "Emergency service call - during business hours", qty: "1", unit: "EA", price: "224.83" },
    { desc: "Equipment decontamination charge - per piece of equipment", qty: "3", unit: "EA", price: "46.76" },
    { desc: "Add for personal protective equipment (hazardous cleanup)", qty: "4", unit: "EA", price: "23.57" },
    { desc: "Add for HEPA filter (for negative air exhaust fan)", qty: "1", unit: "EA", price: "214.17" },
    { desc: "Muck-out/Flood loss cleanup - per hour (Labor only)", qty: "2", unit: "HR", price: "80" },
    { desc: "Laundry - wash/dry/fold - per pound - Drop off", qty: "20", unit: "LB", price: "4" },
    { desc: "Infrared heat panel (per 24 hr period) - No monitoring", qty: "0", unit: "EA", price: "35" },
  );
  const r = checked(run(p));
  assert.ok(!hint(r, "labor_not_comparable"));
  // 16.1 h documented; 10 + 2 + 2 h billed on HR lines
  const l = line(r, "labor:hours");
  assert.deepEqual([l.qty, l.price, l.code], [2, 81.27, "LAB"]);
  assert.match(l.basis, /invoiced 14 h on HR lines; 2 h not billed/);
});

/* ---------- Cat 3 (Addendum A D15) ---------- */
const ph = (id, ts, ai, stage = "during") => ({ id, src: "media:x", caption: "", room: "", stage, ts, ai: { equipment: [], workDone: [], materials: [], ...ai } });

test("Cat 3 package: an unbilled item is a line only with a record of the work; the rest is one hint", () => {
  const p = baseJob();
  p.waterCategory = "3";
  p.dryingLogs[0].equipment.push(
    { asset: "S-1", type: "HEPA air scrubber", placed: "2026-07-28T15:00", removed: "2026-08-04T09:00" },
    { asset: "S-2", type: "Negative air machine", placed: "2026-07-28T15:00", removed: "2026-08-04T09:00" },
  );
  p.invoices[0].items.push(
    { desc: "Negative air fan/Air scrubber (24 hr period) - No monit.", code: "NAFAN", qty: "14", unit: "DA", price: "70.75" },
    { desc: "Containment Barrier/Airlock/Decon. Chamber", code: "BARR", qty: "120", unit: "SF", price: "1.26" },
    { desc: "Personal protective gloves - Disposable (per pair)", qty: "10", unit: "EA", price: "0.39" },
  );
  p.changeOrders = [{ id: "co1", coNo: "1", description: "Flood cut and containment in the basement" }];
  p.cat3Justification = "Sewage backflow; crew wore Tyvek suits and P100 respirators";
  p.photos = [
    ph("p1", "2026-07-29T20:00:00.000Z", { workDone: ["HEPA vacuuming of exposed framing"] }),
    ph("p2", "2026-07-30T20:00:00.000Z", { materials: ["Antimicrobial applied to framing"] }, "after"),
    ph("p3", "2026-07-30T20:00:00.000Z", { workDone: ["Crew in Tyvek suits and boot covers"] }),   // PPE is never read off a photo
  ];
  const r = checked(run(p));
  const cat = r.lines.filter((l) => l.class === "cat3");
  assert.deepEqual(cat.map((l) => l.finding_id), ["cat3:hepa_vacuum", "cat3:suits", "cat3:cartridges", "cat3:hepa_filter", "cat3:antimicrobial"]);
  for (const l of cat) {
    assert.deepEqual([l.price, l.amount], [null, null]);
    assert.equal(l.qty, l.finding_id === "cat3:hepa_filter" ? 2 : null);
    assert.equal(l.refs[0].kind, "water_category");
    assert.ok(!l.refs.some((x) => x.id === "co1"), `${l.finding_id}: a change order about other work is not its record`);
  }
  const v = line(r, "cat3:hepa_vacuum");
  assert.deepEqual(v.refs.map((x) => [x.kind, x.id, x.date]), [["water_category", "3", undefined], ["photo", "p1", "2026-07-29"]]);
  assert.match(v.basis, /includes HEPA vacuuming and no invoice line has it\. The job records the work: photo 07-29: HEPA vacuuming of exposed framing\. Quantity and price are the office's call\.$/);
  assert.deepEqual(line(r, "cat3:antimicrobial").refs.map((x) => x.id), ["3", "p2"], "an after photo records the work too");
  for (const id of ["cat3:suits", "cat3:cartridges"]) {
    const l = line(r, id);
    assert.deepEqual(l.refs.map((x) => x.kind), ["water_category", "cat3_justification"], id);
    assert.match(l.basis, /The job records the work: Cat 3 justification: Sewage backflow; crew wore Tyvek suits and P100 respirators\./);
  }
  const f = line(r, "cat3:hepa_filter");
  assert.deepEqual([f.unit, f.code, f.desc], ["EA", "FHEPA", "Add for HEPA filter (for negative air exhaust fan)"]);
  assert.deepEqual(f.refs.map((x) => x.id), ["3", "dl1#eq3", "dl1#eq4"]);
  assert.match(f.basis, /One filter per scrubber: 2 scrubbers in the drying log\.$/);
  const h = hintsOf(r, "cat3_items_undocumented");
  assert.equal(h.length, 1);
  assert.equal(h[0].label, "Cat 3 package items with no invoice line and no record of the work: floor protection, boot covers");
  assert.deepEqual(h[0].refs.map((x) => x.kind), ["water_category"]);
  assert.ok(!r.lines.some((l) => ["cat3:floor_protection", "cat3:boot_covers"].includes(l.finding_id)));
  assert.equal(r.unpriced_count, 5);
  assert.equal(r.total_usd, 255.15, "unpriced lines stay out of the total");
  assert.match(r.rationale, /^Add 6 lines \(\$255\.15, 5 unpriced\) to Doe: dehu-days, Cat 3 package\n/);
  assert.ok(r.evidence_refs.some((x) => x.kind === "water_category" && /5 package items with a record of the work/.test(x.label)));
  assert.ok(!hint(r, "documented_not_billed"), "the photos ride their lines");
  // nothing recorded at all: no Cat 3 line, one hint naming every unbilled item
  p.photos = [];
  p.cat3Justification = "";
  p.changeOrders = [];
  p.dryingLogs[0].equipment.splice(3, 2);
  p.invoices[0].items.splice(4, 1);                          // the NAFAN line
  const bare = checked(run(p));
  assert.ok(!bare.lines.some((l) => l.class === "cat3"));
  assert.equal(hint(bare, "cat3_items_undocumented").label, "Cat 3 package items with no invoice line and no record of the work: " +
    "negative air, floor protection, HEPA vacuuming, suits, cartridges, boot covers, HEPA filter, antimicrobial");
  // a Cat 2 job gets no package and no hint
  const two = checked(run(baseJob()));
  assert.ok(!two.lines.some((l) => l.class === "cat3") && !hint(two, "cat3_items_undocumented"));
});

test("Cat 3 billed: an item's own line on any non-void invoice, or Xactimate's PPE kit for the four PPE items", () => {
  const p = baseJob();
  p.waterCategory = "3";
  p.cat3Justification = "Category 3: floor protection, Tyvek suits, boot covers, gloves and P100 cartridges used; HEPA vacuuming and antimicrobial throughout; containment with zip wall";
  const ids = (r) => r.lines.filter((l) => l.class === "cat3").map((l) => l.finding_id.slice(5));
  assert.deepEqual(ids(checked(run(p))), ["containment", "floor_protection", "hepa_vacuum", "suits", "cartridges", "gloves", "boot_covers", "antimicrobial"]);
  // the kit covers suits, cartridges, gloves and boot covers — and nothing else
  p.invoices[0].items.push({ desc: "Add for personal protective equipment (hazardous cleanup)", qty: "6", unit: "EA", price: "23.57" });
  assert.deepEqual(ids(checked(run(p))), ["containment", "floor_protection", "hepa_vacuum", "antimicrobial"]);
  p.invoices[0].items.pop();
  p.invoices[0].items.push({ desc: "", code: "PPE+", qty: "6", unit: "EA", price: "51.15" });
  assert.deepEqual(ids(checked(run(p))), ["containment", "floor_protection", "hepa_vacuum", "antimicrobial"], "by its selector");
  p.invoices[0].items.pop();
  // a single PPE item is not the kit: gloves and an N-95 mask leave the suits, cartridges and boot covers open
  p.invoices[0].items.push({ desc: "Personal protective gloves - Disposable (per pair)", code: "PPEG6", qty: "10", unit: "EA", price: "0.39" },
    { desc: "Personal protective mask (N-95)", code: "PPEM", qty: "4", unit: "EA", price: "1.5" });
  assert.deepEqual(ids(checked(run(p))), ["containment", "floor_protection", "hepa_vacuum", "suits", "cartridges", "boot_covers", "antimicrobial"]);
  // a contract invoice's scope lines count as billed; a void one's do not
  p.invoices.push({ id: "con1", invoiceNo: "C-1", invoiceDate: "2026-08-06", billingModel: "contract", contractAmount: "4000",
    items: [{ desc: "Floor protection - self-adhesive plastic film", qty: "400", unit: "SF", price: "" }] },
  { id: "v1", invoiceNo: "V-1", invoiceDate: "2026-08-06", billingModel: "tm", status: "void",
    items: [{ desc: "HEPA Vacuuming - Detailed - (PER SF)", code: "HEPAVAS", qty: "400", unit: "SF", price: "1" }] });
  assert.deepEqual(ids(checked(run(p))), ["containment", "hepa_vacuum", "suits", "cartridges", "boot_covers", "antimicrobial"]);
  // containment is recorded by poly sheeting or a zip wall in a photo's tags, too
  const q = baseJob();
  q.waterCategory = "3";
  for (const tag of ["Poly sheeting containment over the stairwell", "Polyethylene sheeting wall at doorway", "ZipWall poles", "Zip wall set at hallway"]) {
    q.photos = [ph("p9", "2026-07-30T20:00:00.000Z", { materials: [tag] })];
    assert.ok(line(checked(run(q)), "cat3:containment"), tag);
  }
  for (const tag of ["Plastic sheeting on the floor by the door", "Open food containers on a shelf"]) {
    q.photos = [ph("p9", "2026-07-30T20:00:00.000Z", { materials: [tag] })];
    assert.ok(!line(checked(run(q)), "cat3:containment"), tag);
  }
});

/* A wall opened to the studs shows its poly vapor barrier, and the tagger
   writes what it does NOT see ("no containment erected yet"): neither is a
   record of containment, nor is a rebuild change order replacing the barrier
   or the house wrap. */
test("Cat 3 records: building-envelope wording and negated mentions record nothing", () => {
  const q = baseJob();
  q.waterCategory = "3";
  const cat = (r) => r.lines.filter((l) => l.class === "cat3").map((l) => l.finding_id);
  for (const tag of ["Poly sheeting vapor barrier (partially installed)", "Vapor barrier installed over insulation", "6 mil polyethylene vapor barrier",
    "Blue poly sheeting/vapor barrier installed against insulation", "Tear-out to studs underway — no containment erected yet"]) {
    q.photos = [ph("p9", "2026-08-20T20:00:00.000Z", { materials: [tag] }, "after")];
    assert.ok(!line(checked(run(q)), "cat3:containment"), tag);
  }
  q.photos = [ph("p9", "2026-08-20T20:00:00.000Z", { workDone: ["Floor protection not required"] }, "after")];
  assert.ok(!line(checked(run(q)), "cat3:floor_protection"));
  q.photos = [];
  q.cat3Justification = "no containment needed; floor protection not required";
  assert.deepEqual(cat(checked(run(q))), []);
  q.cat3Justification = "";
  q.changeOrders = [{ id: "co1", coNo: "2", description: "Replace vapor barrier and insulation in the basement wall" },
    { id: "co2", coNo: "3", description: "Install Tyvek house wrap on exterior wall" }];
  assert.deepEqual(cat(checked(run(q))), [], "no containment, no suits");
  // a real record still counts, beside the envelope wording on the same photo
  q.changeOrders = [];
  q.photos = [ph("p9", "2026-07-30T20:00:00.000Z", { workDone: ["Containment erected at the stairwell"], materials: ["Poly sheeting vapor barrier"] })];
  assert.ok(line(checked(run(q)), "cat3:containment").refs.some((x) => x.id === "p9"));
  q.cat3Justification = "Containment set at the stairwell, no floor protection";
  q.photos = [];
  assert.deepEqual(cat(checked(run(q))), ["cat3:containment"], "the negation stays in its own clause");
  // and a Cat 2 job's vapor-barrier photo is not unbilled containment either
  const two = baseJob();
  two.photos = [ph("p9", "2026-07-30T20:00:00.000Z", { materials: ["Poly sheeting vapor barrier (partially installed)"] })];
  assert.ok(!hint(checked(run(two)), "documented_not_billed"));
});

test("Cat 3: negative air and the HEPA filter are recorded only by scrubber rows", () => {
  const p = baseJob();
  p.waterCategory = 3;                                         // a number reads the same
  p.cat3Justification = "Negative air and a new HEPA filter on the scrubber";   // words alone do not make the machine
  let r = checked(run(p));
  assert.ok(!line(r, "cat3:negative_air") && !line(r, "cat3:hepa_filter"));
  // nothing of the package billed or recorded: all ten fit the 200-character label
  assert.equal(hint(r, "cat3_items_undocumented").label, "Cat 3 package items with no invoice line and no record of the work: " +
    "containment, negative air, floor protection, HEPA vacuuming, suits, cartridges, gloves, boot covers, HEPA filter, antimicrobial");
  // scrubber rows documented, none billed: the unit-day line carries negative air; the filter counts the scrubbers
  p.dryingLogs[0].equipment.push({ asset: "S-1", type: "air scrubber", placed: "2026-07-28T15:00", removed: "2026-07-30T15:00" });
  r = checked(run(p));
  assert.ok(!line(r, "cat3:negative_air"));
  const s = line(r, "equip:scrubber");
  assert.deepEqual([s.qty, s.unit, s.price, s.desc], [2, "DA", null, "Negative air fan/Air scrubber (24 hr period) - No monit."]);
  assert.equal(line(r, "cat3:hepa_filter").qty, 1);
  assert.ok(!/negative air|HEPA filter/.test(hint(r, "cat3_items_undocumented").label));
  // a scrubber still running (no removed, no dry-out finish) has no unit-days, but it is in the log
  p.dryingLogs[0].equipment[3].removed = "";
  r = checked(run(p));
  assert.ok(!line(r, "equip:scrubber"));
  const na = line(r, "cat3:negative_air");
  assert.deepEqual([na.unit, na.code, na.qty], ["DA", "NAFAN", null]);
  assert.deepEqual(na.refs.map((x) => [x.kind, x.id]), [["water_category", "3"], ["equipment_row", "dl1#eq3"]]);
  assert.match(na.basis, /The drying log lists 1 scrubber\. Quantity and price are the office's call\.$/);
  assert.equal(line(r, "cat3:hepa_filter").qty, 1);
});

/* Addendum A acceptance, on a synthetic job shaped like the one the first dry
   run got wrong: a Cat 3 mitigation invoice that bills the equipment in full
   (heat as infrared panels), PPE as the kit and most work per SF/LF. The one
   real miss is containment, which only the photos record. */
test("Addendum A: a fully billed Cat 3 job surfaces only the containment its photos record", () => {
  const eqRow = (asset, type) => ({ asset, type, location: "Basement", placed: "2026-07-20T13:00", removed: "2026-07-30T09:00", hours: 236 });
  const late = (asset, type) => ({ asset, type, location: "Basement", placed: "2026-07-27T18:00", removed: "2026-07-30T09:00", hours: 63 });
  const p = {
    id: "99999999-8888-7777-6666-555555555555", customer: "Example Owner", jobType: "restoration", waterCategory: "3",
    dateOfLoss: "2026-07-20", qbJobcodeId: "JC9", laborLog: { id: "ll", startDate: "", entries: [] },
    dryingLogs: [log("dlA", [
      eqRow("AM-1", "Air mover  "), eqRow("AM-2", "Air mover"), eqRow("DH-1", "Dehumidifier "), eqRow("AS-1", "Air scrubber "),
      late("AM-3", "Air mover"), late("HT-1", "Heater"), late("HT-2", "Heater"),
      { asset: "N/A", type: "N/A", location: "N/A", placed: "2026-07-20T10:00", removed: "2026-07-20T10:01", hours: 0 },
    ], [psych("2026-07-20"), psych("2026-07-22"), psych("2026-07-24"), psych("2026-07-26"), psych("2026-07-28")],
    { dryoutStart: "2026-07-20", dryoutFinish: "2026-07-30" })],
    invoices: [{ id: "invA", invoiceNo: "Mit-1", invoiceDate: "2026-08-12", billingModel: "tm", status: "partially_paid", items: [
      { desc: "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", qty: "23", unit: "EA", price: "32.25" },
      { desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", qty: "10", unit: "EA", price: "85.05" },
      { desc: "Neg. air fan/Air scrub.-Large (per 24 hr period)-No monit.", qty: "10", unit: "DA", price: "100" },
      { desc: "Add for HEPA filter (for negative air exhaust fan)", qty: "1", unit: "EA", price: "214.17" },
      { desc: "Add for personal protective equipment (hazardous cleanup)", qty: "12", unit: "EA", price: "23.57" },
      { desc: "Infrared heat panel (per 24 hr period) - No monitoring", qty: "6", unit: "EA", price: "35" },
      { desc: "Muck-out/Flood loss cleanup - per hour (Labor only)", qty: "4", unit: "HR", price: "80" },
      { desc: "Tear out wet drywall, cleanup, bag - Cat 3", qty: "300", unit: "SF", price: "1.96" },
      { desc: "Equipment setup, take down, and monitoring (hourly charge)", qty: "3", unit: "HR", price: "81.27" },
      { desc: "Equipment decontamination charge - per piece of equipment", qty: "8", unit: "EA", price: "46.76" },
      { desc: "Remove Interior door unit", qty: "2", unit: "EA", price: "30" },
      { desc: "Apply anti-microbial agent to more than the floor", qty: "600", unit: "SF", price: "0.4" },
    ] }],
    photos: [
      ph("pA", "2026-08-11T21:00:00.000Z", { workDone: ["Containment walls framed around the furnace room"] }, "after"),
      ph("pB", "2026-08-11T21:05:00.000Z", { workDone: ["Ceiling grid wrapped in poly sheeting"], materials: ["Poly sheeting containment over the stairwell"] }, "after"),
      ph("pC", "2026-08-02T16:00:00.000Z", { materials: ["Plastic sheeting on the floor by the door", "Open food containers on a shelf"] }, "before"),
    ],
    changeOrders: [],
  };
  const hours = [["a", "2026-07-20", 9.5], ["b", "2026-07-21", 8], ["c", "2026-07-23", 6.25], ["d", "2026-07-27", 7.75], ["e", "2026-07-31", 4]];
  const r = checked(reconcileJob(p, { timeEntries: hours.map(([id, d, h]) => qbRow(id, d, h, "ts-" + id, "2026-08-01T15:00:00Z")), today: "2026-09-20", manual: true }));
  assert.deepEqual(r.lines.map((l) => l.finding_id), ["cat3:containment"]);
  const c = r.lines[0];
  assert.deepEqual([c.qty, c.price, c.amount, c.unit, c.code], [null, null, null, "SF", "BARR"]);
  assert.deepEqual(c.refs.map((x) => [x.kind, x.id]), [["water_category", "3"], ["photo", "pA"], ["photo", "pB"]]);
  assert.match(c.basis, /The job records the work: photo 08-11: Containment walls framed around the furnace room \(\+1 more\)\./);
  assert.deepEqual([r.total_usd, r.unpriced_count, r.rate_invoice_id], [0, 1, "invA"]);
  assert.equal(r.rationale.split("\n")[0], "Add 1 line ($0.00, 1 unpriced) to Example Owner: Cat 3 package");
  assert.deepEqual(r.hints.map((h) => h.kind).filter((k) => ["labor_not_comparable", "cat3_items_undocumented"].includes(k)),
    ["labor_not_comparable", "cat3_items_undocumented"]);
  assert.equal(hint(r, "labor_not_comparable").label, "QuickBooks Time has 35.5 h in the mitigation window 07-20→08-01; HR lines bill 7 h; " +
    "the rest of the labor is priced inside 3 unit-priced lines, so hours can't be compared.");
  assert.equal(hint(r, "cat3_items_undocumented").label, "Cat 3 package items with no invoice line and no record of the work: floor protection, HEPA vacuuming");
  for (const k of ["unclassified_equipment", "billed_exceeds_documented", "documented_not_billed"]) assert.ok(!hint(r, k), k);
});

/* ---------- photos: hints only ---------- */
test("photo hints: photographed_not_logged by Alaska date, documented_not_billed; never a line", () => {
  const p = baseJob();
  const ph = (id, ts, ai, stage = "during") => ({ id, src: "media:x", caption: "", room: "", stage, ts, ai: { equipment: [], workDone: [], materials: [], ...ai } });
  p.photos = [
    // 2026-08-06 05:30 UTC is 08-05 21:30 in Anchorage: no dehu row runs 08-05, no count → hint
    ph("p1", "2026-08-06T05:30:00.000Z", { equipment: ["LGR dehumidifier", "air movers"] }),
    // 2026-08-05 05:30 UTC is 08-04 21:30 AKDT: the dehu row ends 08-04 → covered (a UTC date would say 08-05)
    ph("p2", "2026-08-05T05:30:00.000Z", { equipment: ["dehumidifier"] }),
    // a before photo is not a during photo
    ph("p3", "2026-08-10T20:00:00.000Z", { equipment: ["air scrubber"] }, "before"),
    // stage unset reads as during
    ph("p4", "2026-08-10T20:00:00.000Z", { equipment: ["heater"] }, ""),
    // billed-kind work no line carries
    ph("p5", "2026-07-29T20:00:00.000Z", { workDone: ["containment erected"], materials: ["drywall"] }),
    ph("p6", "2026-07-30T20:00:00.000Z", { materials: ["antimicrobial applied"] }),
    { id: "p7", ts: "2026-07-30T20:00:00.000Z", stage: "during" },                  // never analysed
  ];
  const r = checked(run(p));
  const nl = hintsOf(r, "photographed_not_logged");
  assert.deepEqual(nl.map((h) => h.label), [
    "During photos show dehu equipment on 08-05 with no dehu row or count that day",
    "During photos show air-mover equipment on 08-05 with no air-mover row or count that day",
    "During photos show heater equipment on 08-10 with no heater row or count that day",
  ]);
  assert.deepEqual(nl[0].refs.map((x) => [x.kind, x.id, x.date]), [["photo", "p1", "2026-08-05"]]);
  const dn = hintsOf(r, "documented_not_billed");
  assert.deepEqual(dn.map((h) => h.refs[0].id), ["p5", "p6"]);
  assert.match(dn[0].label, /1 photo tagged containment; no invoice line bills containment/);
  assert.equal(findingsKey(r.lines), findingsKey(run(baseJob()).lines), "photos change no line");
  // a containment line by selector code silences the hint
  p.invoices[0].items.push({ desc: "Zip wall", code: "BARR", qty: "1", unit: "SF", price: "1" });
  assert.deepEqual(hintsOf(checked(run(p)), "documented_not_billed").map((h) => h.refs[0].id), ["p6"]);
  // on a Cat 3 job the photo rides the containment line instead of a hint
  const q = baseJob();
  q.waterCategory = "3";
  q.photos = [ph("p5", "2026-07-29T20:00:00.000Z", { workDone: ["containment erected"] })];
  const rq = checked(run(q));
  assert.ok(line(rq, "cat3:containment").refs.some((x) => x.id === "p5"));
  assert.ok(!hint(rq, "documented_not_billed"));
});

/* ---------- never a line from hint sources ---------- */
test("no line ever comes from count strings, photos, visits or undocumented days", () => {
  const p = baseJob();
  p.dryingLogs[0].equipment = [];
  p.dryingLogs[0].readings = [psych("2026-07-29", { dehu: "3", am: "8", scrub: "2" }), psych("2026-08-02", { dehu: "3", am: "8", scrub: "2" })];
  p.dryingLogs[0].dryoutStart = "2026-07-28";
  p.dryingLogs[0].dryoutFinish = "2026-08-04";
  p.photos = [{ id: "p1", stage: "during", ts: "2026-07-30T20:00:00Z", ai: { equipment: ["dehumidifier", "air scrubber", "heater"], workDone: ["containment", "HEPA vacuuming"], materials: ["antimicrobial"] } }];
  p.invoices[0].items = [{ desc: "Haul debris", qty: "1", unit: "EA", price: "150" }];
  const r = checked(run(p, { timeEntries: [] }));
  assert.deepEqual(r.lines, []);
  assert.equal(r.total_usd, 0);
  assert.equal(r.rationale, "");
  for (const k of ["count_strings_only", "photographed_not_logged", "documented_not_billed", "monitoring_not_billed"]) assert.ok(hint(r, k), k);
  assert.deepEqual(hint(r, "monitoring_not_billed").refs.map((x) => [x.kind, x.id, x.label]),
    [["moisture_map", "mm1", "Kitchen: 2 reading dates"], ["drying_log", "dl1", "Drying log: 2 reading dates"]]);
  assert.ok(r.hints.length > 0 && r.evidence_refs.length > 0, "a hints-only job still carries its evidence");
});

/* ---------- findingsKey (K4) ---------- */
test("findingsKey: [finding_id, class, qty, unit, price] sorted by finding_id", () => {
  const r = run(baseJob());
  const key = findingsKey(r.lines);
  assert.equal(key, JSON.stringify([["equip:dehu", "dehu", 3, "EA", 85.05], ["labor:hours", "labor", 4, "HR", 81.27]]));
  assert.equal(findingsKey(r.lines.slice().reverse()), key, "stable under line reordering");
  const edited = clone(r.lines).map((l) => ({ ...l, desc: "x", basis: "y", refs: [], room: "Den", amount: 1 }));
  assert.equal(findingsKey(edited), key, "evidence and wording are not identity");
  const more = clone(r.lines);
  more[0].qty = 4;
  assert.notEqual(findingsKey(more), key);
  assert.equal(findingsKey([{ finding_id: "cat3:suits", class: "cat3", qty: null, unit: "EA", price: null }]), '[["cat3:suits","cat3",null,"EA",null]]');
  assert.equal(findingsKey([]), "[]");
  assert.equal(findingsKey(null), "[]");
  // same job, same result, every time
  assert.deepEqual(run(baseJob()), r);
});

/* ---------- scope (D9) ---------- */
test("scope: nightly rules", () => {
  const S = (mut, opts) => { const p = baseJob(); mut(p); return scopeOf(p, opts); };
  assert.deepEqual(scopeOf(baseJob()), { ok: true, reason: "in_scope" });
  assert.deepEqual(S((p) => { p.deleted = true; }), { ok: false, reason: "deleted" });
  assert.deepEqual(S((p) => { p.jobType = "construction"; }), { ok: false, reason: "not_restoration" });
  assert.deepEqual(S((p) => { p.waterCategory = ""; p.waterClass = ""; p.lossTypes = ["fire"]; }), { ok: false, reason: "not_water" });
  assert.deepEqual(S((p) => { p.waterCategory = ""; p.waterClass = ""; p.lossTypes = []; }), { ok: true, reason: "in_scope" }, "no loss type reads as water");
  assert.deepEqual(S((p) => { p.archivedAt = "2026-08-20T00:00:00Z"; }), { ok: false, reason: "archived" });
  assert.deepEqual(S((p) => { p.invoices = []; }), { ok: false, reason: "no_invoice" });
  assert.deepEqual(S((p) => { p.invoices[0].status = "void"; }), { ok: false, reason: "no_invoice" });
  assert.deepEqual(S((p) => { p.invoices[0].billingModel = "contract"; }), { ok: false, reason: "contract" });
  assert.deepEqual(S((p) => { p.invoices[0].status = "paid"; }), { ok: false, reason: "paid" });
  assert.deepEqual(S((p) => { p.invoices[0].status = "paid"; p.invoices.push({ id: "i2", status: "void", items: [] }); }), { ok: false, reason: "paid" });
  assert.deepEqual(S((p) => { p.invoices[0].status = "paid"; p.invoices.push({ id: "i2", status: "sent", items: [] }); }), { ok: true, reason: "in_scope" });
  for (const stage of ["in_progress", "on_hold", "final", "done"]) assert.ok(scopeOf(baseJob(), { boardStage: stage }).ok, stage);
  for (const stage of ["lead", "scheduled"]) assert.deepEqual(scopeOf(baseJob(), { boardStage: stage }), { ok: false, reason: "stage" });
  assert.ok(scopeOf(baseJob(), { boardStage: null }).ok, "an unlinked job uses the field evidence alone");
});

test("scope: a manual run ignores archived, paid and stage, not kind or invoice", () => {
  const S = (mut, opts) => { const p = baseJob(); mut(p); return scopeOf(p, { manual: true, ...opts }); };
  assert.ok(S((p) => { p.archivedAt = "2026-08-20T00:00:00Z"; }).ok);
  assert.ok(S((p) => { p.invoices[0].status = "paid"; }).ok);
  assert.ok(S(() => {}, { boardStage: "lead" }).ok);
  assert.equal(S((p) => { p.jobType = "construction"; }).reason, "not_restoration");
  assert.equal(S((p) => { p.invoices = []; }).reason, "no_invoice");
  assert.equal(S((p) => { p.invoices[0].billingModel = "contract"; }).reason, "contract");
  // reconcileJob honours it: out of scope returns no findings
  const p = baseJob();
  p.archivedAt = "2026-08-20T00:00:00Z";
  const off = checked(run(p));
  assert.deepEqual([off.scope.ok, off.scope.reason, off.lines.length, off.hints.length, off.rationale], [false, "archived", 0, 0, ""]);
  assert.equal(checked(run(p, { manual: true })).lines.length, 2);
  assert.equal(checked(run(baseJob(), { boardStage: "scheduled" })).scope.reason, "stage");
});

/* ---------- sent ---------- */
test("sent: a sent/viewed/partially paid/paid status or a QuickBooks id on any non-void invoice", () => {
  const S = (mut) => { const p = baseJob(); mut(p); return run(p).sent; };
  assert.equal(S(() => {}), false);
  for (const st of ["sent", "viewed", "partially_paid"]) assert.equal(S((p) => { p.invoices[0].status = st; }), true, st);
  assert.equal(S((p) => { p.invoices[0].qboInvoiceId = "812"; }), true);
  assert.equal(S((p) => { p.invoices.push({ id: "c", billingModel: "contract", status: "paid", items: [] }); }), true);
  assert.equal(S((p) => { p.invoices.push({ id: "v", status: "void", qboInvoiceId: "9", items: [] }); }), false, "a voided invoice does not count");
});

/* ---------- rationale ---------- */
test("rationale: line 1 at most 160 chars with the dollar figure, line 2 the limits", () => {
  const p = baseJob();
  p.customer = "The Estate of Somebody With A Very Long Name, care of Their Property Manager, Unit 4B, Fairbanks North Star Borough";
  p.waterCategory = "3";
  p.cat3Justification = "Sewage: containment and floor protection set, HEPA vacuuming, Tyvek suits, P100 cartridges, gloves and boot covers, antimicrobial applied";
  p.dryingLogs[0].equipment.push({ asset: "S-1", type: "air scrubber", placed: "2026-07-28T15:00", removed: "2026-07-30T15:00" },
    { asset: "H-1", type: "heater", placed: "2026-07-28T15:00", removed: "2026-07-30T15:00" });
  p.invoices[0].items[1].qty = "1";
  const r = checked(run(p));
  const [first, second] = r.rationale.split("\n");
  assert.ok(first.length <= 160);
  assert.match(first, /^Add 14 lines \(\$\d{1,3}(,\d{3})*\.\d{2}, 11 unpriced\) to The Estate of .*…: dehu-days, air-mover-days, scrubber-days, heater-days, labor hours, Cat 3 package$/);
  assert.equal(second, LIMITS);
  const q = baseJob();
  q.customer = "";
  q.invoices[0].items[2].qty = "15";
  q.invoices[0].items[3].qty = "1";
  assert.equal(run(q).rationale.split("\n")[0], "Add 1 line ($255.15) to this job: dehu-days");
});

/* ---------- every result above, one more time ---------- */
test("every result: finite numbers, 2 dp money, B3/B4 shapes, no junk text", () => {
  assert.ok(results.length >= 20, `${results.length} results checked`);
  for (const r of results) checkShape(r);
  const junk = reconcileJob({ id: 7, jobType: "restoration", invoices: [{ id: 1, items: [null, { qty: "abc", price: "x", unit: 5, desc: null }] }],
    dryingLogs: [null, { equipment: [null, { type: "dehu", placed: "garbage", removed: "2026-13-45" }], readings: [null, { date: "nope" }] }],
    photos: [null, { ai: null }, { ai: { equipment: "dehu" } }], moistureMaps: [null, { readings: [{ date: "2026-08-01", values: "x" }] }],
    laborLog: { entries: [null, { hours: "NaN" }] } }, { timeEntries: [null, { source: "qbtime", hours: "x" }], today: "bad" });
  checkShape(junk);
  assert.equal(junk.job_id, "7");
  checkShape(reconcileJob(null, {}));
  checkShape(reconcileJob({}));
});

/* ---------- purity ---------- */
test("the module is pure: imports only dryingcalc.js, model.js and scans.js, reads no clock, touches no DOM or network", () => {
  const src = readFileSync(new URL("../js/reconcile.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./dryingcalc.js", "./model.js", "./scans.js"]);
  // scans.js is used for applyScans and tagKey alone, which read no clock (scans.test.mjs: no imports, no DOM, no network)
  assert.deepEqual([...src.matchAll(/import\s*\{([^}]*)\}\s*from\s+"\.\/scans\.js"/g)].map((m) => m[1].trim()), ["applyScans, tagKey"]);
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!/Date\.now\s*\(/.test(src), "no Date.now()");
  assert.ok(!/new Date\(\s*\)/.test(src), "no argument-less new Date()");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/\b(document|window|navigator|globalThis|process)\s*\.|\bfetch\s*\(|\b(localStorage|XMLHttpRequest|WebSocket)\b/.test(code), "no DOM or network");
});

console.log(`\n${pass} reconcile checks passed.`);
