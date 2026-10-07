import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { billingReconcile, alaskaDate, SCOPE_KEYS, JOB_KEYS } from "../lanes/billing.mjs";
import { runJob, handlers } from "../lanes/queue.mjs";
import { loadConfig } from "../config.mjs";
import { findingsKey, DETECTOR, LIMITS } from "../../../apps/field/js/reconcile.js";
import { fakeSupa, testConfig, recordingLog, jobRow } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BILLING_AGENT = "193d7dd0-74f9-407d-9891-8cb7aab22f82";
const NOW = new Date("2026-10-07T20:00:00Z");   // noon in Anchorage
const TODAY = "2026-10-07";
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const K3_KEYS = ["base_rev", "detector", "findings_hash", "hints", "job_id", "limits", "lines", "rate_invoice_id",
  "rate_invoice_no", "sent", "total_usd", "unpriced_count"];
const SUMMARY_KEYS = ["run_date", "jobs_seen", "in_scope", "filed", "unchanged", "superseded", "skipped", "hints_only", "errors"];

/* A small PostgREST over in-memory tables: the select list (columns, and
   alias:data->key or alias:data->>key), eq / gt / not.is.null filters,
   order=id.asc and limit, and a max-rows cap like the server's, which trims
   a page without saying so. */
function postgrest(tables, { maxRows = 1000 } = {}) {
  const cell = (row, expr) => {
    const m = /^data->(>?)(\w+)$/.exec(expr);
    if (!m) return row[expr] ?? null;
    const v = row.data?.[m[2]];
    if (v == null) return null;
    return m[1] ? (typeof v === "object" ? JSON.stringify(v) : String(v)) : structuredClone(v);
  };
  return (table) => (query) => {
    let rows = tables[table] ?? [];
    let limit = Infinity, cols = ["id"];
    for (const [k, v] of new URLSearchParams(query)) {
      if (k === "select") { cols = v.split(","); continue; }
      if (k === "order") { assert.equal(v, "id.asc"); continue; }
      if (k === "limit") { limit = Number(v); continue; }
      const [op, ...rest] = v.split(".");
      const want = rest.join(".");
      if (v === "not.is.null") rows = rows.filter((r) => cell(r, k) != null);
      else if (op === "eq") rows = rows.filter((r) => String(cell(r, k)) === want);
      else if (op === "gt") rows = rows.filter((r) => String(cell(r, k)) > want);
      else throw new Error(`fake PostgREST: no filter ${k}=${v}`);
    }
    rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, Math.min(limit, maxRows));
    return rows.map((r) => Object.fromEntries(cols.map((c) => {
      const [alias, expr] = c.includes(":") ? c.split(":") : [c, c];
      return [alias, cell(r, expr)];
    })));
  };
}

const row = (id, data, over = {}) => ({ id, deleted: false, data: { id, rev: 1, ...data }, ...over });
const tile = (id, fieldJobId, stage) => ({ id, deleted: false, data: { id, fieldJobId, stage } });
const timeRow = (id, data, over = {}) => ({ id, deleted: false, updated_at: "2026-08-06T15:00:00+00:00", data: { id, ...data }, ...over });

/* A Cat 2 water job the real detector finds two gaps on: one LGR for 7
   unit-days (4 billed) and 6 QuickBooks Time hours (3 billed). */
const tmInvoice = (over = {}) => ({
  id: "inv1", invoiceNo: "1042", billingModel: "tm", terms: "Due on receipt",
  items: [
    { id: "l1", desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", code: "DHM>", qty: "4", unit: "EA", price: "85.05" },
    { id: "l2", desc: "Water Extraction & Remediation Technician - per hour", code: "LAB", qty: "3", unit: "HR", price: "81.27" },
  ],
  ...over,
});
const gapJob = (over = {}) => ({
  rev: 7, customer: "Doe", jobType: "restoration", waterCategory: "2", dateOfLoss: "2026-07-27", qbJobcodeId: "JC1",
  dryingLogs: [{
    id: "dl1", dryoutStart: "", dryoutFinish: "",
    equipment: [{ asset: "D-1", type: "LGR 7000XLi", location: "Kitchen", placed: "2026-07-28T15:00", removed: "2026-08-04T09:00", hours: 162 }],
    readings: [],
  }],
  invoices: [tmInvoice()], photos: [], changeOrders: [],
  ...over,
});
const qbTime = (id, date, hours, ts, extra = {}) => timeRow(id, {
  qbJobcodeId: "JC1", source: "qbtime", date, hours, qbTimesheetId: ts,
  employee: "Pat Example", note: "tore out the kitchen", qbUserId: "U77", start: "08:00", finish: "14:00", ...extra,
});

function world({ projects = [], tiles = [], time = [], door, maxRows, cfg = {}, detector, now = NOW } = {}) {
  const pg = postgrest({ field_projects: projects, coordination_jobs: tiles, time_entries: time }, { maxRows });
  const supa = fakeSupa({
    select: { field_projects: pg("field_projects"), coordination_jobs: pg("coordination_jobs"), time_entries: pg("time_entries") },
    rpc: {
      billing_review_gaps_file: door ?? ((a) => ({ filed: true, proposal_id: `p-${a.p_job_id}`, status: "proposed", superseded: 0 })),
      finish_job: (a) => ({ status: a.p_ok ? "done" : "failed" }),
    },
  });
  const ctx = {
    cfg: testConfig(cfg), supa, log: recordingLog(), handlers, now: () => now, stopping: () => false,
    active: { jobs: new Set(), outbox: new Set() }, settleRetryMs: [5, 5], ...(detector ? { detector } : {}),
  };
  return { supa, ctx };
}
const nightly = (run_date = TODAY) =>
  jobRow({ kind: "billing.reconcile", payload: { run_date }, principal_kind: "agent", principal_id: BILLING_AGENT });
const manual = (job_ids) =>
  jobRow({ kind: "billing.reconcile", payload: { job_ids }, principal_kind: "agent", principal_id: BILLING_AGENT });
const doorCalls = (supa) => supa.rpcs("billing_review_gaps_file");
const selects = (supa, table) => supa.calls.select.filter((c) => c.table === table).map((c) => c.query);
// wraps the real detector to see what the lane hands it
const spyDetector = async (seen) => {
  const real = await import("../../../apps/field/js/reconcile.js");
  return { reconcileJob: (p, o) => { const r = real.reconcileJob(p, o); seen.push({ p, o, r }); return r; } };
};

test("scope: the nightly scan reconciles only restoration water jobs with an open invoice on an active board stage, and counts the rest by reason", async () => {
  const J = Object.fromEntries("ABCDEFGHIJK".split("").map((c, i) => [c, uuid(i + 1)]));
  const projects = [
    row(J.A, gapJob()),                                                     // unlinked: the field evidence decides
    row(J.B, gapJob()),                                                     // tile in_progress
    row(J.C, gapJob()),                                                     // tile lead
    row(J.D, gapJob({ jobType: "construction" })),
    row(J.E, { jobType: "restoration", smokeType: "heavy", invoices: [tmInvoice()] }),   // fire only
    row(J.F, gapJob({ archivedAt: "2026-09-01T00:00:00Z" })),
    row(J.G, gapJob({ invoices: [tmInvoice({ status: "paid" }), tmInvoice({ id: "inv0", status: "void" })] })),
    row(J.H, gapJob({ invoices: [] })),
    row(J.I, gapJob({ invoices: [tmInvoice({ billingModel: "contract" })] })),
    row(J.J, gapJob(), { deleted: true }),                                  // never seen
    row(J.K, gapJob()),                                                     // two tiles: lead and final
  ];
  const tiles = [
    tile(uuid(101), J.B, "in_progress"), tile(uuid(102), J.C, "lead"),
    tile(uuid(103), J.K, "lead"), tile(uuid(104), J.K, "final"), tile(uuid(105), "", "done"),
  ];
  const { supa, ctx } = world({ projects, tiles, time: [qbTime("t1", "2026-07-28", 6, "ts1")] });
  const out = await billingReconcile(ctx, nightly());
  assert.equal(out.jobs_seen, 10);
  assert.equal(out.in_scope, 3);
  assert.equal(out.filed, 3);
  assert.deepEqual(out.skipped, { stage: 1, not_restoration: 1, not_water: 1, archived: 1, paid: 1, no_invoice: 1, contract: 1 });
  assert.deepEqual(doorCalls(supa).map((a) => a.p_job_id), [J.A, J.B, J.K]);
  assert.deepEqual(out.errors, []);
  // the scan reads the scope keys only; the detector's keys are read per candidate
  const [scan] = selects(supa, "field_projects");
  assert.match(scan, /deleted=eq\.false/);
  assert.match(scan, /lossTypes:data->lossTypes/);
  assert.match(scan, /smokeType:data->smokeType/);
  assert.doesNotMatch(scan, /photos|dryingLogs|laborLog/);
  const detail = selects(supa, "field_projects").filter((q) => q.includes(`id=eq.${J.A}`));
  assert.equal(detail.length, 1);
  assert.match(detail[0], /dryingLogs:data->dryingLogs/);
  assert.match(detail[0], /photos:data->photos/);
  assert.doesNotMatch(detail[0], /deleted=eq/, "a candidate deleted since the scan reads as deleted, not as missing");
});

test("paging: every page of field_projects, coordination_jobs and time_entries is read by id, even when the server caps a page below the limit asked for", async () => {
  const ids = [1, 2, 3, 4, 5].map(uuid);
  const time = ["t1", "t2", "t3", "t4", "t5"].map((t, i) => qbTime(uuid(200 + i), `2026-07-${28 + (i % 3)}`, 1.5, `ts${i}`));
  const seen = [];
  const { supa, ctx } = world({
    projects: ids.map((id) => row(id, gapJob())),
    tiles: [tile(uuid(101), ids[0], "in_progress"), tile(uuid(102), ids[1], "done"), tile(uuid(103), ids[4], "lead")],
    time, maxRows: 2, detector: await spyDetector(seen),
  });
  const out = await billingReconcile(ctx, nightly());
  assert.equal(out.jobs_seen, 5);
  assert.equal(out.filed, 4);
  assert.deepEqual(out.skipped, { stage: 1 }, "the stage on the third page of tiles still counts");
  const scans = selects(supa, "field_projects").filter((q) => !q.includes("id=eq."));
  assert.equal(scans.length, 4, "pages of 2, 2, 1, then an empty page ends it");
  assert.doesNotMatch(scans[0], /id=gt\./);
  assert.match(scans[1], new RegExp(`id=gt\\.${ids[1]}`));
  assert.match(scans[3], new RegExp(`id=gt\\.${ids[4]}`));
  assert.ok(scans.every((q) => /order=id\.asc/.test(q) && /limit=\d+/.test(q)));
  assert.equal(selects(supa, "coordination_jobs").length, 3);
  for (const s of seen) assert.equal(s.o.timeEntries.length, 5, "all five hours rows reach the detector");
});

test("the door gets the job, the rev it read and the input K3 names; findings_hash is md5 of findingsKey; the fingerprint is the door's to add", async () => {
  const id = uuid(1);
  const seen = [];
  const { supa, ctx } = world({
    projects: [row(id, gapJob())],
    time: [qbTime("t1", "2026-07-28", 6, "ts1")],
    detector: await spyDetector(seen),
  });
  const out = await billingReconcile(ctx, nightly());
  assert.equal(out.filed, 1);
  const [{ o, r }] = seen;
  assert.deepEqual({ today: o.today, boardStage: o.boardStage, manual: o.manual }, { today: TODAY, boardStage: null, manual: false });
  assert.ok(r.lines.length >= 2, "the fixture has gaps");
  const [a] = doorCalls(supa);
  assert.deepEqual(Object.keys(a).sort(), ["p_base_rev", "p_evidence_refs", "p_input", "p_job_id", "p_rationale"],
    "p_expires_in is left to its 14-day default");
  assert.equal(a.p_job_id, id);
  assert.equal(a.p_base_rev, 7);
  assert.deepEqual(Object.keys(a.p_input).sort(), K3_KEYS);
  assert.equal(a.p_input.job_id, id);
  assert.equal(a.p_input.base_rev, 7);
  assert.equal(a.p_input.findings_hash, md5(findingsKey(r.lines)));
  assert.match(a.p_input.findings_hash, /^[0-9a-f]{32}$/);
  assert.deepEqual(a.p_input.lines, r.lines);
  assert.deepEqual(a.p_input.hints, r.hints);
  assert.equal(a.p_input.total_usd, r.total_usd);
  assert.equal(a.p_input.unpriced_count, r.unpriced_count);
  assert.equal(a.p_input.detector, DETECTOR);
  assert.equal(a.p_input.limits, LIMITS);
  assert.equal(a.p_input.sent, false);
  assert.equal(a.p_input.rate_invoice_id, "inv1");
  assert.equal(a.p_input.rate_invoice_no, "1042");
  assert.ok(!("invoice_fingerprint" in a.p_input) && !("offer" in a.p_input), "the door stamps both");
  assert.equal(a.p_rationale, r.rationale);
  assert.match(a.p_rationale, /^Add \d+ lines .* to Doe: /);
  assert.deepEqual(a.p_evidence_refs, r.evidence_refs);
  assert.ok(a.p_evidence_refs.length >= 1 && a.p_evidence_refs.length <= 10);
  assert.ok(!JSON.stringify(a).includes("Pat Example"), "no employee name reaches the proposal");
  assert.ok(ctx.log.events().includes("billing.filed"));
});

test("a blob with no rev files with none: p_base_rev null and no base_rev in the input", async () => {
  const id = uuid(1);
  const { supa, ctx } = world({ projects: [row(id, gapJob({ rev: undefined }))] });
  await billingReconcile(ctx, nightly());
  const [a] = doorCalls(supa);
  assert.equal(a.p_base_rev, null);
  assert.ok(!("base_rev" in a.p_input));
});

test("time_entries: read by the job's jobcode, QuickBooks Time rows only, each cut to six fields: never an employee, a note or a QB user", async () => {
  const id = uuid(1), noCode = uuid(2);
  const seen = [];
  const { supa, ctx } = world({
    projects: [row(id, gapJob()), row(noCode, gapJob({ qbJobcodeId: "" }))],
    time: [
      qbTime(uuid(300), "2026-07-28", 6, "ts1"),
      qbTime(uuid(301), "2026-07-29", 2.5, 4471),
      qbTime(uuid(302), "2026-07-29", 9, "ts9", { qbJobcodeId: "JC2" }),       // another job
      qbTime(uuid(303), "2026-07-30", 9, "ts8", { source: "manual" }),         // not QuickBooks Time
      qbTime(uuid(304), "2026-07-30", 9, "ts7"),
    ].map((r) => (r.id === uuid(304) ? { ...r, deleted: true } : r)),
    detector: await spyDetector(seen),
  });
  await billingReconcile(ctx, nightly());
  const rows = seen.find((s) => s.p.id === id).o.timeEntries;
  assert.deepEqual(rows.map((r) => r.id), [uuid(300), uuid(301)]);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["date", "hours", "id", "qbTimesheetId", "source", "updated_at"]);
  assert.deepEqual(rows[1], { id: uuid(301), date: "2026-07-29", hours: 2.5, qbTimesheetId: "4471", updated_at: "2026-08-06T15:00:00+00:00", source: "qbtime" });
  const q = selects(supa, "time_entries");
  assert.equal(q.length, 2, "one page and the empty page after it, for the one job with a jobcode");
  assert.match(q[0], /deleted=eq\.false/);
  assert.match(q[0], /data->>qbJobcodeId=eq\.JC1/);
  assert.match(q[0], /data->>source=eq\.qbtime/);
  assert.doesNotMatch(q.join("\n"), /employee|note|qbUserId|start|finish|select=data|select=\*/);
  assert.ok(!JSON.stringify(seen.map((s) => s.o)).includes("Pat Example"));
  assert.deepEqual(seen.find((s) => s.p.id === noCode).o.timeEntries, [], "no jobcode: no read; the Labor Log is the fallback");
});

test("rev_moved: the job is read again once and filed at its new rev; a second rev_moved is counted, not chased", async () => {
  const id = uuid(1);
  const projects = [row(id, gapJob())];
  let n = 0;
  const { supa, ctx } = world({
    projects,
    door: (a) => {
      n += 1;
      if (n === 1) { projects[0].data.rev = 8; return { skipped: "rev_moved" }; }   // a phone saved the job meanwhile
      return { filed: true, proposal_id: "p1", status: "proposed", superseded: 1 };
    },
  });
  const out = await billingReconcile(ctx, nightly());
  assert.deepEqual(doorCalls(supa).map((a) => a.p_base_rev), [7, 8]);
  assert.equal(doorCalls(supa)[1].p_input.base_rev, 8);
  assert.equal(selects(supa, "field_projects").filter((q) => q.includes(`id=eq.${id}`)).length, 2);
  assert.equal(out.filed, 1);
  assert.equal(out.superseded, 1);
  assert.equal(out.in_scope, 1, "a re-read job counts once");
  assert.deepEqual(out.skipped, {});

  const again = world({ projects: [row(id, gapJob())], door: () => ({ skipped: "rev_moved" }) });
  const out2 = await billingReconcile(again.ctx, nightly());
  assert.equal(doorCalls(again.supa).length, 2, "read again once, never a third time");
  assert.deepEqual(out2.skipped, { rev_moved: 1 });
  assert.equal(out2.filed, 0);
  assert.equal(out2.in_scope, 1);
});

test("no lines: one door call with a null input supersedes an open card; a job with hints but no lines files nothing and is listed", async () => {
  const clean = uuid(1), hinted = uuid(2);
  const { supa, ctx } = world({
    projects: [
      // nothing logged, nothing billed: no lines, no hints
      row(clean, { jobType: "restoration", waterCategory: "2", invoices: [tmInvoice({ items: [] })] }),
      // the invoice covers the work; the drying log has days with no reading (a hint)
      row(hinted, gapJob({ qbJobcodeId: "", invoices: [tmInvoice({ items: [{ id: "l1", desc: "LGR dehumidifier (per 24 hr period)", code: "DHM>", qty: "7", unit: "EA", price: "85.05" }] })] })),
    ],
    door: (a) => ({ filed: false, superseded: a.p_job_id === clean ? 1 : 0 }),
  });
  const out = await billingReconcile(ctx, nightly());
  const calls = doorCalls(supa);
  assert.equal(calls.length, 2, "one call per job with no lines");
  for (const a of calls) {
    assert.equal(a.p_input, null);
    assert.equal(a.p_rationale, null);
    assert.equal(a.p_evidence_refs, null);
    assert.equal(a.p_base_rev, a.p_job_id === clean ? 1 : 7, "the rev it read, so a save meanwhile is caught");
  }
  assert.equal(out.filed, 0);
  assert.equal(out.superseded, 1);
  assert.deepEqual(out.skipped, { no_gaps: 1, hints_only: 1 });
  assert.deepEqual(out.hints_only, [hinted]);
});

test("unchanged findings return the existing card; the open cards a quiet answer supersedes are counted; a door skip is counted by its reason", async () => {
  const [a, b, c, d] = [uuid(1), uuid(2), uuid(3), uuid(4)];
  const answers = {
    [a]: { filed: false, proposal_id: "p-old", status: "declined", superseded: 0 },
    [b]: { skipped: "deleted" },
    [c]: { skipped: "missing" },
    // executed earlier; the job's other open card holds findings tonight's check no longer makes
    [d]: { filed: false, proposal_id: "p-done", status: "executed", superseded: 1 },
  };
  const { ctx } = world({ projects: [a, b, c, d].map((id) => row(id, gapJob())), door: (x) => answers[x.p_job_id] });
  const out = await billingReconcile(ctx, nightly());
  assert.equal(out.unchanged, 2);
  assert.equal(out.superseded, 1, "the door's findings_changed supersede is in the summary");
  assert.equal(out.filed, 0);
  assert.deepEqual(out.skipped, { deleted: 1, missing: 1 });
});

test("one job's error is recorded and the run goes on, and the job still finishes done with the summary", async () => {
  const [a, b, c] = [uuid(1), uuid(2), uuid(3)];
  const { supa, ctx } = world({
    projects: [a, b, c].map((id) => row(id, gapJob())),
    door: (x) => {
      if (x.p_job_id === a) {
        const e = new Error("/rest/v1/rpc/billing_review_gaps_file: 403 agent:billing may not propose invoice.review_gaps");
        e.code = "42501";
        throw e;
      }
      if (x.p_job_id === b) return null;     // an answer this lane does not know
      return { filed: true, proposal_id: "p3", status: "proposed", superseded: 0 };
    },
  });
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, true);
  const out = fin.p_result;
  assert.equal(out.filed, 1);
  assert.equal(out.errors.length, 2);
  assert.equal(out.errors[0].job_id, a);
  assert.match(out.errors[0].message, /may not propose/);
  assert.equal(out.errors[1].job_id, b);
  assert.match(out.errors[1].message, /answered null/);
  assert.equal(ctx.log.lines.filter((l) => l.event === "billing.job_failed").length, 2);
});

test("a stale run_date is skipped without a read; yesterday in Alaska still runs, though it is two days ago in UTC", async () => {
  const late = new Date("2026-10-08T05:00:00Z");     // 21:00 on 10-07 in Anchorage
  assert.equal(alaskaDate(late), "2026-10-07");
  assert.equal(alaskaDate(new Date("2026-01-15T08:59:00Z")), "2026-01-14", "AKST is UTC-9");
  const stale = world({ projects: [row(uuid(1), gapJob())], now: late });
  assert.deepEqual(await billingReconcile(stale.ctx, nightly("2026-10-05")), { skipped: "stale", run_date: "2026-10-05" });
  assert.equal(stale.supa.calls.select.length, 0);
  assert.equal(stale.supa.calls.rpc.length, 0);
  const ok = world({ projects: [row(uuid(1), gapJob())], now: late });
  const out = await billingReconcile(ok.ctx, nightly("2026-10-06"));
  assert.equal(out.run_date, "2026-10-06");
  assert.equal(out.filed, 1);
  const future = world({ projects: [row(uuid(1), gapJob())], now: late });
  assert.equal((await billingReconcile(future.ctx, nightly("2026-10-08"))).filed, 1, "a run_date ahead of the clock still runs");
});

test("the kill switch: BILLING_RECONCILE=off answers {skipped:\"off\"} and reads nothing, nightly or manual", async () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k" };
  assert.equal(loadConfig(base).billingReconcile, true);
  assert.equal(loadConfig({ ...base, BILLING_RECONCILE: "off" }).billingReconcile, false);
  assert.equal(loadConfig({ ...base, BILLING_RECONCILE: " OFF " }).billingReconcile, false);
  assert.equal(loadConfig({ ...base, BILLING_RECONCILE: "on" }).billingReconcile, true);
  for (const job of [nightly(), manual([uuid(1)]), nightly("2020-01-01")]) {
    const { supa, ctx } = world({ projects: [row(uuid(1), gapJob())], cfg: { billingReconcile: false } });
    assert.deepEqual(await billingReconcile(ctx, job), { skipped: "off" });
    assert.equal(supa.calls.select.length + supa.calls.rpc.length, 0);
  }
});

test("a payload with neither a usable run_date nor 1..100 job uuids is dead on arrival", async () => {
  for (const payload of [{}, { run_date: "2026-13-01" }, { run_date: 20261007 }, { job_ids: [] }, { job_ids: ["nope"] },
    { job_ids: uuid(1) }, { job_ids: Array.from({ length: 101 }, (_, i) => uuid(i)) }]) {
    const { supa, ctx } = world();
    await runJob(ctx, jobRow({ kind: "billing.reconcile", payload }));
    const fin = supa.rpcs("finish_job")[0];
    assert.equal(fin.p_ok, false, JSON.stringify(payload));
    assert.equal(fin.p_permanent, true, JSON.stringify(payload));
    assert.match(fin.p_error, /run_date|job_ids/);
    assert.equal(supa.calls.select.length, 0);
  }
});

test("a manual run reads only the jobs it names, ignores archived, paid and the board stage, and still needs a restoration job with an invoice", async () => {
  const J = { archived: uuid(1), paid: uuid(2), lead: uuid(3), build: uuid(4), none: uuid(5), gone: uuid(6), other: uuid(7) };
  const seen = [];
  const { supa, ctx } = world({
    projects: [
      row(J.archived, gapJob({ archivedAt: "2026-09-01T00:00:00Z" })),
      row(J.paid, gapJob({ invoices: [tmInvoice({ status: "paid" })] })),
      row(J.lead, gapJob()),
      row(J.build, gapJob({ jobType: "construction" })),
      row(J.none, gapJob({ invoices: [] })),
      row(J.gone, gapJob(), { deleted: true }),
      row(J.other, gapJob()),
    ],
    tiles: [tile(uuid(101), J.lead, "lead")],
    detector: await spyDetector(seen),
  });
  const missing = uuid(99);
  const out = await billingReconcile(ctx, manual([J.archived, J.paid, J.lead, J.build, J.none, J.gone, missing, J.paid.toUpperCase()]));
  assert.equal(out.run_date, TODAY);
  assert.equal(out.jobs_seen, 7, "the ids it names, once each");
  assert.equal(out.in_scope, 3);
  assert.equal(out.filed, 3);
  assert.deepEqual(out.skipped, { not_restoration: 1, no_invoice: 1, deleted: 1, missing: 1 });
  assert.deepEqual(doorCalls(supa).map((a) => a.p_job_id), [J.archived, J.paid, J.lead]);
  assert.ok(seen.every((s) => s.o.manual === true));
  assert.equal(selects(supa, "coordination_jobs").length, 0, "a manual run reads no tiles");
  assert.ok(!selects(supa, "field_projects").some((q) => q.includes(J.other)), "nor any job it does not name");
});

test("the summary has exactly the K9 keys; hints_only stops at 50 ids and errors at 20", async () => {
  const minimal = { jobType: "restoration", waterCategory: "2", invoices: [tmInvoice({ items: [] })] };
  const hintsOnly = { reconcileJob: (p) => ({ job_id: p.id, scope: { ok: true, reason: "in_scope" }, lines: [],
    hints: [{ kind: "undocumented_days", label: "2 days with equipment on and no reading", refs: [] }],
    evidence_refs: [], total_usd: 0, unpriced_count: 0, rationale: "" }) };
  const many = Array.from({ length: 60 }, (_, i) => row(uuid(i + 1), minimal));
  const one = world({ projects: many, detector: hintsOnly, door: () => ({ filed: false, superseded: 0 }) });
  const out = await billingReconcile(one.ctx, nightly());
  assert.deepEqual(Object.keys(out), SUMMARY_KEYS);
  assert.equal(out.run_date, TODAY);
  assert.equal(out.jobs_seen, 60);
  assert.equal(out.in_scope, 60);
  assert.deepEqual(out.skipped, { hints_only: 60 });
  assert.equal(out.hints_only.length, 50);
  assert.deepEqual(out.hints_only, many.slice(0, 50).map((r) => r.id));
  assert.deepEqual(out.errors, []);

  const two = world({ projects: many.slice(0, 25), detector: hintsOnly, door: () => { throw new Error("db down"); } });
  const out2 = await billingReconcile(two.ctx, nightly());
  assert.equal(out2.errors.length, 20);
  assert.deepEqual(out2.errors[0], { job_id: uuid(1), message: "db down" });
  assert.deepEqual(out2.hints_only, [], "a job whose filing failed is an error, not a hints-only job");
});

test("a read that fails before any job is reached throws, so the queue retries the whole run", async () => {
  const { supa, ctx } = world({ projects: [row(uuid(1), gapJob())] });
  supa.select = async () => { throw new Error("/rest/v1/coordination_jobs: 503 upstream"); };
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, false);
  assert.match(fin.p_error, /503/);
  assert.equal(doorCalls(supa).length, 0);
});

test("a worker told to stop mid-run gives the run back (a retry, never dead) instead of being cut off by the grace period", async () => {
  const { supa, ctx } = world({ projects: [1, 2, 3].map((n) => row(uuid(n), gapJob())) });
  let filed = 0;
  ctx.stopping = () => filed >= 1;
  const door = supa.rpc;
  supa.rpc = async (fn, args) => { const r = await door(fn, args); if (fn === "billing_review_gaps_file") filed += 1; return r; };
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, false);
  assert.match(fin.p_error, /stopping/);
  assert.equal(doorCalls(supa).length, 1);
});

/* The scan and the per-job read project field_projects.data to named keys, so
   a key the detector starts reading and these lists miss would silently read
   as absent (lossTypesOf, for one, calls a job with no loss fields water).
   Hold the lists to the detector's own source. */
test("SCOPE_KEYS and JOB_KEYS cover every blob key scopeOf and reconcileJob read", () => {
  const src = (f) => fs.readFileSync(path.join(REPO, "apps/field/js", f), "utf8");
  const keysIn = (code) => new Set([...code.matchAll(/\bp\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  // a one-line arrow, or a function up to its closing brace
  const fnBody = (code, name) => {
    const m = new RegExp(`export (?:const ${name} = .*|function ${name}\\([\\s\\S]*?\\n\\}\\n)`).exec(code);
    assert.ok(m, `${name} is in the source`);
    return m[0];
  };
  const reconcile = src("reconcile.js"), model = src("model.js");
  const TOP_LEVEL = new Set(["id", "deleted"]);   // columns, not data keys
  const DATE_PARTS = new Set(["year", "month", "day", "hour", "minute", "second"]);   // akWall's Intl parts, also named p
  const lossTypes = keysIn(fnBody(model, "lossTypesOf"));
  const jobTypeKeys = keysIn(fnBody(model, "jobType"));
  for (const k of [...keysIn(fnBody(reconcile, "scopeOf")), ...lossTypes, ...jobTypeKeys]) {
    if (!TOP_LEVEL.has(k)) assert.ok(SCOPE_KEYS.includes(k), `the scan projects ${k}`);
  }
  for (const k of [...keysIn(reconcile), ...lossTypes, ...jobTypeKeys]) {
    if (!TOP_LEVEL.has(k) && !DATE_PARTS.has(k)) assert.ok(JOB_KEYS.includes(k), `the per-job read projects ${k}`);
  }
  assert.ok(lossTypes.has("smokeType") && lossTypes.has("waterCategory"), "the source scan found lossTypesOf's keys");
});
