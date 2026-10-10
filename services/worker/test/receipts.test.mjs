import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptsQboMatch, STORE_ACCOUNTS_KEY } from "../lanes/receipts.mjs";
import { matchReceipts } from "../lanes/qbomatch.mjs";
import { runJob, handlers } from "../lanes/queue.mjs";
import { loadConfig } from "../config.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, jobRow } from "./helpers.mjs";
import * as oct7 from "./qbo-oct7.fixture.mjs";

const NOW = new Date("2026-10-08T20:00:00Z");   // noon in Anchorage, Oct 8
const PROXY = testConfig().qboProxyUrl;
const INTEGRATIONS_AGENT = "5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10";
const SUMMARY_KEYS = ["run_date", "receipts", "matched", "in_qbo", "unmatched", "conflicts", "cards_filed", "skipped", "errors"];
const JOB_IDS = Object.values(oct7.JOBS).sort();
const uuid = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

/* A small PostgREST over in-memory tables, enough for what the lane sends:
   the select list (columns, and alias:data->>key), eq / gt / in / is.null
   filters, the (job_id, id) keyset or=(…) of job_receipts, order on one or
   two columns, limit, and a max-rows cap like the server's, which trims a
   page without saying so. Anything else throws, so a query the lane starts
   sending is seen here first. */
function postgrest(tables, { maxRows = 1000 } = {}) {
  const cell = (row, expr) => {
    const m = /^data->>(\w+)$/.exec(expr);
    if (!m) return row[expr] ?? null;
    const v = row.data?.[m[1]];
    return v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  const KEYSET = /^\(job_id\.gt\.([^,()]+),and\(job_id\.eq\.([^,()]+),id\.gt\.("(?:[^"\\]|\\.)*")\)\)$/;
  return (table) => (query) => {
    let rows = tables[table] ?? [];
    let limit = Infinity, cols = null, order = [];
    for (const [k, v] of new URLSearchParams(query)) {
      if (k === "select") { cols = v.split(","); continue; }
      if (k === "order") { order = v.split(",").map((o) => { assert.match(o, /^\w+\.asc$/); return o.split(".")[0]; }); continue; }
      if (k === "limit") { limit = Number(v); continue; }
      if (k === "or") {
        const m = KEYSET.exec(v);
        if (!m || m[1] !== m[2]) throw new Error(`fake PostgREST: no or=${v}`);
        const [job, id] = [m[1], JSON.parse(m[3])];
        rows = rows.filter((r) => r.job_id > job || (r.job_id === job && r.id > id));
        continue;
      }
      const dot = v.indexOf(".");
      const [op, want] = [v.slice(0, dot), v.slice(dot + 1)];
      if (v === "is.null") rows = rows.filter((r) => cell(r, k) == null);
      else if (op === "eq") rows = rows.filter((r) => String(cell(r, k)) === want);
      else if (op === "gt") rows = rows.filter((r) => String(cell(r, k)) > want);
      else if (op === "in" && /^\(.*\)$/.test(want)) {
        const set = new Set(want.slice(1, -1).split(","));
        rows = rows.filter((r) => set.has(String(cell(r, k))));
      } else throw new Error(`fake PostgREST: no filter ${k}=${v}`);
    }
    const cmp = (a, b) => { for (const k of order) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
    rows = [...rows].sort(cmp).slice(0, Math.min(limit, maxRows));
    if (!cols) throw new Error(`fake PostgREST: ${table} read with no select list`);
    return rows.map((r) => Object.fromEntries(cols.map((c) => {
      const [alias, expr] = c.includes(":") ? c.split(":") : [c, c];
      return [alias, cell(r, expr)];
    })));
  };
}

const projectRow = (j) => ({ id: j.id, deleted: j.deleted, data: { address: j.address, ...(j.title ? { title: j.title } : {}),
  ...(j.qbJobcodeName ? { qbJobcodeName: j.qbJobcodeName } : {}), lossType: "water", invoices: [] } });
const receiptRow = (r) => ({ ...r, deleted_at: null, subtotal: null, tax: null, notes: "", items: [], logged_by: "", has_photo: true });
const ok = (key, list) => ({ status: 200, body: { [key]: list, ok: true, data: { [key]: list } } });

/** The Oct 7 world: the lane's tables, qbo-proxy, and the two doors. */
function world({ receipts = oct7.RECEIPTS.map(receiptRow), links = [], jobLinks = [], projects = oct7.JOB_ROWS.map(projectRow),
  settings = [], maxRows, proxy, note, door, cfg = {}, now = NOW } = {}) {
  const pg = postgrest({ job_receipts: receipts, receipt_qbo_links: links, job_qbo_links: jobLinks, field_projects: projects,
    app_settings: settings }, { maxRows });
  const supa = fakeSupa({
    select: Object.fromEntries(["job_receipts", "receipt_qbo_links", "job_qbo_links", "field_projects", "app_settings"].map((t) => [t, pg(t)])),
    rpc: {
      receipt_qbo_links_note: note ?? ((a) => ({ written: a.p_rows.length, kept: 0, removed: 0 })),
      receipts_qbo_link_file: door ?? ((a) => (a.p_input
        ? { filed: true, proposal_id: `p-${a.p_job_id.slice(0, 8)}`, status: "proposed", superseded: 0 }
        : { skipped: "empty", superseded: 0 })),
      finish_job: (a) => ({ status: a.p_ok ? "done" : "failed" }),
    },
  });
  const fetch = fakeFetch([{
    match: (u) => u === PROXY,
    reply: (u, init) => {
      const body = JSON.parse(init.body);
      if (proxy) { const r = proxy(body); if (r) return r; }
      if (body.action === "listProjects") return ok("projects", oct7.PROJECTS);
      if (body.action === "listPurchases") return ok("purchases", oct7.PURCHASES.filter((p) => p.txnDate >= body.from && p.txnDate <= body.to));
      return { status: 404, body: { ok: false, error: `Unknown action: ${body.action}` } };
    },
  }]);
  const ctx = { cfg: testConfig(cfg), supa, fetch, log: recordingLog(), handlers, now: () => now, stopping: () => false,
    active: { jobs: new Set(), outbox: new Set() } };
  return { supa, ctx, fetch };
}
const nightly = (run_date = "2026-10-08") =>
  jobRow({ kind: "receipts.qbo_match", payload: { run_date }, principal_kind: "agent", principal_id: INTEGRATIONS_AGENT });
const manual = (job_ids) =>
  jobRow({ kind: "receipts.qbo_match", payload: { job_ids }, principal_kind: "agent", principal_id: INTEGRATIONS_AGENT });
const doorCalls = (supa) => supa.rpcs("receipts_qbo_link_file");
const noteCalls = (supa) => supa.rpcs("receipt_qbo_links_note");
const selects = (supa, table) => supa.calls.select.filter((c) => c.table === table).map((c) => c.query);
const expected = (over = {}) => matchReceipts({ receipts: oct7.RECEIPTS, purchases: oct7.PURCHASES, links: [], jobs: oct7.JOB_ROWS,
  projects: oct7.PROJECTS, storeAccounts: null, today: "2026-10-08", ...over });

test("the nightly run on the Oct 7 rows: one read of each table, two qbo-proxy reads, one note for all five jobs, Alston's card filed", async () => {
  const { supa, ctx, fetch } = world();
  const out = await receiptsQboMatch(ctx, nightly());

  assert.deepEqual(Object.keys(out), SUMMARY_KEYS);
  assert.deepEqual(out, { run_date: "2026-10-08", receipts: 27, matched: 9, in_qbo: 4, unmatched: 18, conflicts: 0, cards_filed: 1,
    skipped: { empty: 4 }, errors: [] });

  // reads: live receipts with the matcher's columns only (no notes, line items or who logged it)
  assert.deepEqual(selects(supa, "job_receipts"), [
    "select=job_id,id,vendor,receipt_date,amount,category,paid_with,card_last4,receipt_no,photo_ref&deleted_at=is.null&order=job_id.asc,id.asc&limit=1000",
    `select=job_id,id,vendor,receipt_date,amount,category,paid_with,card_last4,receipt_no,photo_ref&deleted_at=is.null&order=job_id.asc,id.asc&limit=1000&or=${
      encodeURIComponent(`(job_id.gt.${oct7.JOBS.brighton},and(job_id.eq.${oct7.JOBS.brighton},id.gt."r24"))`)}`,
  ]);
  const jobsRead = `select=id,deleted,title:data->>title,address:data->>address,customer:data->>customer,qbJobcodeName:data->>qbJobcodeName&id=in.(${JOB_IDS.join(",")})&order=id.asc&limit=100`;
  assert.deepEqual(selects(supa, "field_projects"), [jobsRead, `${jobsRead}&id=gt.${JOB_IDS[4]}`]);
  assert.deepEqual(selects(supa, "app_settings"), [`select=key,value&key=eq.${STORE_ACCOUNTS_KEY}`]);
  assert.equal(selects(supa, "receipt_qbo_links").length, 1);   // empty: one read says so
  assert.equal(selects(supa, "job_qbo_links").length, 1);

  // qbo-proxy, under the service key: the projects, then the expenses from 14 days before the oldest receipt
  assert.deepEqual(fetch.calls.map((c) => [c.url, c.init.method, c.body]), [
    [PROXY, "POST", { action: "listProjects" }],
    [PROXY, "POST", { from: "2026-09-04", to: "2026-10-08", action: "listPurchases" }],
  ]);
  for (const c of fetch.calls) {
    assert.equal(c.init.headers.apikey, ctx.cfg.serviceKey);
    assert.equal(c.init.headers.Authorization, `Bearer ${ctx.cfg.serviceKey}`);
    assert.ok(c.init.signal, "a hung read cannot hold the queue lane");
  }

  // one note, every job with receipts, exactly the matcher's rows (grouped by job)
  const want = expected();
  const byReceipt = (rows) => [...rows].sort((a, b) => (a.receipt_id < b.receipt_id ? -1 : 1));
  assert.equal(noteCalls(supa).length, 1);
  assert.deepEqual(noteCalls(supa)[0].p_job_ids, JOB_IDS);
  assert.deepEqual(byReceipt(noteCalls(supa)[0].p_rows), want.notes);
  assert.equal(want.notes.length, 22);

  // the door for each job the run looked at: Alston's card, and no input for the four with nothing to approve
  assert.deepEqual(doorCalls(supa).map((a) => [a.p_job_id, a.p_input === null]), JOB_IDS.map((id) => [id, id !== oct7.JOBS.alston]));
  const alston = doorCalls(supa).find((a) => a.p_job_id === oct7.JOBS.alston);
  assert.deepEqual(alston, { p_job_id: oct7.JOBS.alston, p_input: want.cards[0].input, p_rationale: want.cards[0].rationale, p_evidence_refs: [] });
  assert.deepEqual(Object.keys(alston).sort(), ["p_evidence_refs", "p_input", "p_job_id", "p_rationale"]);   // the door's 14-day default stands
  for (const a of doorCalls(supa).filter((x) => x.p_input === null)) {
    assert.deepEqual(a, { p_job_id: a.p_job_id, p_input: null, p_rationale: null, p_evidence_refs: null });
  }

  // the logs carry counts and ids, never a vendor, an amount or a customer name
  const run = ctx.log.lines.find((l) => l.event === "receipts.run");
  assert.deepEqual(run, { event: "receipts.run", run_date: "2026-10-08", manual: false, receipts: 27, matched: 9, in_qbo: 4,
    unmatched: 18, conflicts: 0, cards: 1, cards_filed: 1, purchases: 83, notes_written: 22, notes_removed: 0, errors: 0 });
  assert.deepEqual(ctx.log.lines.filter((l) => l.event === "receipts.filed"),
    [{ event: "receipts.filed", job_id: oct7.JOBS.alston, proposal_id: "p-a628eea5", items: 5, superseded: 0 }]);
  assert.doesNotMatch(JSON.stringify(ctx.log.lines), /Pollen|Home Depot|Spenard|1369/);
});

test("the job's QuickBooks link, the receipts' rows and the store-entry switch are read and handed to the matcher", async () => {
  const link = { job_id: oct7.JOBS.chena, qbo_customer_id: "502", qbo_project_ref: null, qbo_name: "1885 Chena Landings Lp.", source: "picked",
    set_by_kind: "human", set_by_id: null, set_at: "2026-10-01T00:00:00Z" };
  const queued = { receipt_id: "r03", job_id: oct7.JOBS.alston, state: "queued", qbo_txn_type: "Purchase", qbo_txn_id: "10519",
    qbo_sync_token: "0", qbo_customer_id: "112", amount: 67.88, receipt_date: "2026-09-28", detail: {}, changes: ["tag", "attach"],
    proposal_id: uuid(9), outbox_id: uuid(10) };
  const stores = { spenard: { account_id: "53", vendor_id: "65", expense_account_id: "42", class_id: "1000000001" } };
  const { supa, ctx } = world({ links: [queued], jobLinks: [link], settings: [{ key: STORE_ACCOUNTS_KEY, value: stores }] });
  const out = await receiptsQboMatch(ctx, nightly());

  const linksRead = "select=receipt_id,job_id,state,qbo_txn_type,qbo_txn_id,qbo_sync_token,qbo_customer_id,amount,receipt_date,detail&order=receipt_id.asc&limit=1000";
  assert.deepEqual(selects(supa, "receipt_qbo_links"), [linksRead, `${linksRead}&receipt_id=gt.r03`]);
  const jobLinksRead = "select=job_id,qbo_customer_id,qbo_project_ref,qbo_name,source&order=job_id.asc&limit=1000";
  assert.deepEqual(selects(supa, "job_qbo_links"), [jobLinksRead, `${jobLinksRead}&job_id=gt.${oct7.JOBS.chena}`]);
  assert.equal(out.skipped.queued, 1, "the approved receipt is counted, not re-matched");

  const files = Object.fromEntries(doorCalls(supa).map((a) => [a.p_job_id, a.p_input]));
  // Alston: four tag + attach items (10519 is approved already) and its own Spenard invoices to enter
  assert.deepEqual(files[oct7.JOBS.alston].items.filter((i) => !i.create).map((i) => i.qbo_txn_id), ["10520", "10577", "10584", "10614"]);
  assert.deepEqual(files[oct7.JOBS.alston].items.filter((i) => i.create).map((i) => i.receipt_id), ["r07", "r11", "r17", "r18"]);
  // Chena is linked to 502, so its Spenard invoices are entered to it
  assert.equal(files[oct7.JOBS.chena].qbo_customer_id, "502");
  assert.equal("link" in files[oct7.JOBS.chena], false, "a linked job's card suggests nothing");
  assert.deepEqual(files[oct7.JOBS.chena].items.map((i) => [i.receipt_id, i.changes.join("+")]),
    [["r21", "create+attach"], ["r23", "create+attach"], ["r26", "create+attach"], ["r28", "create+attach"]]);
});

test("the kill switch: RECEIPTS_QBO=off answers {skipped:\"off\"} and reads nothing, nightly or manual", async () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k" };
  assert.equal(loadConfig(base).receiptsQbo, true);
  assert.equal(loadConfig({ ...base, RECEIPTS_QBO: " OFF " }).receiptsQbo, false);
  for (const job of [nightly(), manual([oct7.JOBS.alston]), nightly("2020-01-01"), manual("garbage")]) {
    const { supa, ctx, fetch } = world({ cfg: { receiptsQbo: false } });
    assert.deepEqual(await receiptsQboMatch(ctx, job), { skipped: "off" });
    assert.equal(supa.calls.select.length + supa.calls.rpc.length + fetch.calls.length, 0);
  }
});

test("a stale run_date is skipped without a read; yesterday in Alaska still runs", async () => {
  const stale = world();
  assert.deepEqual(await receiptsQboMatch(stale.ctx, nightly("2026-10-06")), { skipped: "stale", run_date: "2026-10-06" });
  assert.equal(stale.supa.calls.select.length + stale.fetch.calls.length, 0);
  const late = new Date("2026-10-09T05:00:00Z");     // 21:00 on 10-08 in Anchorage, already the 9th in UTC
  const yesterday = world({ now: late });
  assert.equal((await receiptsQboMatch(yesterday.ctx, nightly("2026-10-07"))).run_date, "2026-10-07");
});

test("a payload with neither a usable run_date nor 1..100 job uuids is dead on arrival", async () => {
  for (const payload of [{}, null, { run_date: "2026-13-01" }, { run_date: 20261008 }, { job_ids: [] }, { job_ids: ["nope"] },
    { job_ids: uuid(1) }, { job_ids: Array.from({ length: 101 }, (_, i) => uuid(i)) }, { job_ids: [uuid(1), 7] }]) {
    const { supa, ctx } = world();
    await runJob(ctx, jobRow({ kind: "receipts.qbo_match", payload }));
    const fin = supa.rpcs("finish_job")[0];
    assert.equal(fin.p_ok, false, JSON.stringify(payload));
    assert.equal(fin.p_permanent, true, JSON.stringify(payload));
    assert.match(fin.p_error, /run_date|job_ids/);
    assert.equal(supa.calls.select.length, 0);
  }
});

test("an older qbo-proxy (404 Unknown action) ends the run as qbo_proxy_not_updated before anything is written", async () => {
  for (const action of ["listProjects", "listPurchases"]) {
    const { supa, ctx } = world({
      proxy: (b) => (b.action === action ? { status: 404, body: { ok: false, error: `Unknown action: ${action}` } } : null),
    });
    await runJob(ctx, nightly());
    const fin = supa.rpcs("finish_job")[0];
    assert.equal(fin.p_ok, true, action);
    assert.deepEqual(fin.p_result, { skipped: "qbo_proxy_not_updated", run_date: "2026-10-08" });
    assert.equal(noteCalls(supa).length + doorCalls(supa).length, 0, action);
    const line = ctx.log.lines.find((l) => l.event === "receipts.proxy_not_updated");
    assert.match(line.error, new RegExp(`Unknown action: ${action}`));
  }
});

test("qbo-proxy failing (500, ok:false, unreachable, no list) throws, so the queue retries the whole run, and nothing is written", async () => {
  const replies = [
    () => ({ status: 500, body: { ok: false, error: "QuickBooks token refresh failed" } }),
    () => ({ status: 200, body: { ok: false, error: "QuickBooks not connected" } }),
    () => ({ status: 200, body: { ok: true, data: {} } }),
    () => { throw new TypeError("fetch failed"); },
  ];
  for (const reply of replies) {
    const { supa, ctx } = world({ proxy: (b) => (b.action === "listPurchases" ? reply() : null) });
    await runJob(ctx, nightly());
    const fin = supa.rpcs("finish_job")[0];
    assert.equal(fin.p_ok, false);
    assert.equal(fin.p_permanent, false);
    assert.match(fin.p_error, /qbo-proxy/);
    assert.equal(noteCalls(supa).length + doorCalls(supa).length, 0);
  }
});

test("qbo-proxy's lists are read from the top level or from data", async () => {
  const { supa, ctx } = world({
    proxy: (b) => (b.action === "listProjects" ? { status: 200, body: { ok: true, data: { projects: oct7.PROJECTS } } }
      : b.action === "listPurchases" ? { status: 200, body: { ok: true, purchases: oct7.PURCHASES } } : null),
  });
  const out = await receiptsQboMatch(ctx, nightly());
  assert.equal(out.cards_filed, 1);
  assert.equal(doorCalls(supa).find((a) => a.p_input).p_input.link.qbo_name, "Pollen Apartments");
});

test("one job's filing error is recorded and the run goes on; each door answer is counted by what it said", async () => {
  const { supa, ctx } = world({
    door: (a) => {
      if (a.p_job_id === oct7.JOBS.alston) return { filed: false, proposal_id: uuid(5), status: "proposed", superseded: 0 };
      if (a.p_job_id === oct7.JOBS.chena) {
        const e = new Error("/rest/v1/rpc/receipts_qbo_link_file: 403 agent:integrations may not propose receipts.qbo_link");
        e.code = "42501";
        throw e;
      }
      if (a.p_job_id === oct7.JOBS.beechwood) return null;     // an answer this lane does not know
      if (a.p_job_id === oct7.JOBS.polarfox) return { skipped: "qbo_lane_off" };
      return { skipped: "empty", superseded: 1 };
    },
  });
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, true);
  const out = fin.p_result;
  assert.equal(out.cards_filed, 0);
  assert.deepEqual(out.skipped, { unchanged: 1, qbo_lane_off: 1, empty: 1 });
  assert.deepEqual(out.errors.map((e) => e.job_id), [oct7.JOBS.chena, oct7.JOBS.beechwood]);
  assert.match(out.errors[0].message, /may not propose/);
  assert.match(out.errors[1].message, /answered null/);
  assert.equal(doorCalls(supa).length, 5);
  assert.equal(ctx.log.lines.filter((l) => l.event === "receipts.job_failed").length, 2);
});

test("the note write failing throws before any card is filed, so the run is retried whole", async () => {
  const { supa, ctx } = world({ note: () => { throw new Error("/rest/v1/rpc/receipt_qbo_links_note: 400 row 3 has a bad job_id"); } });
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, false);
  assert.equal(doorCalls(supa).length, 0);
});

test("a manual run matches every receipt but notes and files only the jobs it names, a named job with no receipts included", async () => {
  const empty = uuid(7);
  const { supa, ctx } = world({ projects: [...oct7.JOB_ROWS.map(projectRow), projectRow({ id: empty, address: "1 Empty St", deleted: false })] });
  const out = await receiptsQboMatch(ctx, manual([oct7.JOBS.alston.toUpperCase(), oct7.JOBS.alston, empty]));
  const scoped = expected({ scope: [oct7.JOBS.alston] });
  assert.deepEqual(noteCalls(supa), [{ p_job_ids: [oct7.JOBS.alston, empty], p_rows: scoped.notes }]);   // one job: already in order
  assert.ok(scoped.notes.every((n) => n.job_id === oct7.JOBS.alston));
  assert.deepEqual(doorCalls(supa).map((a) => [a.p_job_id, a.p_input?.items.length ?? null]), [[oct7.JOBS.alston, 5], [empty, null]]);
  assert.equal(out.receipts, 17);       // Alston's receipts, not the night's
  assert.equal(out.cards_filed, 1);
  assert.equal(ctx.log.lines.find((l) => l.event === "receipts.run").manual, true);
});

test("paging: every receipt, link and job link is read even when the server caps a page below the limit asked for", async () => {
  const links = Array.from({ length: 7 }, (_, i) => ({ receipt_id: `old${i}`, job_id: oct7.JOBS.alston, state: "unmatched",
    qbo_txn_type: null, qbo_txn_id: null, qbo_sync_token: null, qbo_customer_id: null, amount: 5, receipt_date: "2026-06-01",
    detail: { reason: "not_found" } }));
  // a receipt id with a comma and a quote cannot end the keyset early
  const odd = receiptRow({ ...oct7.RECEIPTS[0], id: 'r01,"x"', amount: 3.33 });
  const { supa, ctx } = world({ maxRows: 4, links, receipts: [...oct7.RECEIPTS.map(receiptRow), odd] });
  const out = await receiptsQboMatch(ctx, nightly());
  assert.equal(selects(supa, "job_receipts").length, 9);     // 29 rows in pages of 4, then an empty page
  assert.equal(selects(supa, "receipt_qbo_links").length, 3);
  assert.match(selects(supa, "receipt_qbo_links")[1], /&receipt_id=gt\.old3$/);
  assert.equal(out.receipts, 27, "the odd id is left out by the matcher, not lost by the paging");
  assert.equal(noteCalls(supa)[0].p_rows.length, 22, "old links on receipts no longer live are not carried");
});

test("with no receipt to match, qbo-proxy is not asked; the jobs rows still name are noted, so rows of deleted receipts go", async () => {
  const gone = { receipt_id: "r99", job_id: oct7.JOBS.chena, state: "in_qbo", qbo_txn_type: "Purchase", qbo_txn_id: "10001",
    qbo_sync_token: "0", qbo_customer_id: "502", amount: 9, receipt_date: "2026-09-01", detail: {} };
  const { supa, ctx, fetch } = world({ receipts: [], links: [gone], note: () => ({ written: 0, kept: 0, removed: 1 }) });
  const out = await receiptsQboMatch(ctx, nightly());
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(noteCalls(supa), [{ p_job_ids: [oct7.JOBS.chena], p_rows: [] }]);
  assert.equal(doorCalls(supa).length, 0);
  assert.equal(out.receipts, 0);
  assert.equal(ctx.log.lines.find((l) => l.event === "receipts.run").notes_removed, 1);
});

test("the note splits past 500 jobs, by whole jobs, and the run still files each job's door", async () => {
  const jobs = Array.from({ length: 501 }, (_, i) => uuid(1000 + i));
  const receipts = jobs.map((j, i) => receiptRow({ job_id: j, id: `w${i}`, vendor: "The Home Depot #1303", receipt_date: "2026-10-07",
    amount: 1 + i / 100, category: "materials", paid_with: "card", card_last4: "3176", receipt_no: "", photo_ref: null }));
  const { supa, ctx } = world({ receipts, projects: jobs.map((id) => projectRow({ id, address: id, deleted: false })) });
  const out = await receiptsQboMatch(ctx, nightly());
  assert.deepEqual(noteCalls(supa).map((c) => [c.p_job_ids.length, c.p_rows.length]), [[500, 500], [1, 1]]);
  assert.equal(selects(supa, "field_projects").length, 12);   // 100 ids per request, each read to its empty page
  assert.equal(doorCalls(supa).length, 501);
  assert.deepEqual(out.skipped, { empty: 501 });
  assert.equal(out.unmatched, 501);
});

test("a worker told to stop mid-run gives the run back (a retry, never dead)", async () => {
  const { supa, ctx } = world();
  let filed = 0;
  ctx.stopping = () => filed >= 1;
  const door = supa.rpc;
  supa.rpc = async (fn, args) => { const r = await door(fn, args); if (fn === "receipts_qbo_link_file") filed += 1; return r; };
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, false);
  assert.match(fin.p_error, /stopping/);
  assert.equal(doorCalls(supa).length, 1);
});

test("the queue dispatches receipts.qbo_match to this lane and finishes the job with the summary", async () => {
  assert.equal(handlers["receipts.qbo_match"], receiptsQboMatch);
  const { supa, ctx } = world();
  await runJob(ctx, nightly());
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, true);
  assert.deepEqual(Object.keys(fin.p_result), SUMMARY_KEYS);
  assert.equal(fin.p_result.cards_filed, 1);
});
