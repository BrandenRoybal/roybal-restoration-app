import { test } from "node:test";
import assert from "node:assert/strict";
import { runQueueOnce, runJob, handlers, JobError } from "../lanes/queue.mjs";
import { fakeSupa, testConfig, recordingLog, jobRow } from "./helpers.mjs";

const ctxWith = (supa = fakeSupa(), extra = {}) =>
  ({ cfg: testConfig(), supa, log: recordingLog(), handlers, active: { jobs: new Set(), outbox: new Set() }, settleRetryMs: [5, 5], ...extra });

test("runQueueOnce claims with the configured kinds and lease; an empty queue is 0", async () => {
  const supa = fakeSupa({ rpc: { claim_job: [] } });
  const ctx = ctxWith(supa);
  assert.equal(await runQueueOnce(ctx), 0);
  assert.deepEqual(supa.rpcs("claim_job")[0], { p_worker_id: "w-test", p_kinds: ["proposal.execute"], p_lease_seconds: 300 });
  assert.equal(supa.rpcs("finish_job").length, 0);
});

test("proposal.execute runs op_execute as the job's principal and finishes done with the outcome", async () => {
  const job = jobRow();
  const supa = fakeSupa({ rpc: {
    claim_job: [job],
    op_execute: { id: job.payload.proposal_id, status: "executed", error: null },
    finish_job: (a) => ({ status: a.p_ok ? "done" : "failed" }),
  } });
  const ctx = ctxWith(supa);
  assert.equal(await runQueueOnce(ctx), 1);
  const exec = supa.rpcs("op_execute")[0];
  assert.deepEqual(exec, { p_proposal_id: job.payload.proposal_id, p_principal_kind: "human", p_principal_id: job.principal_id });
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_job_id, job.id);
  assert.equal(fin.p_worker_id, "w-test");
  assert.equal(fin.p_ok, true);
  assert.equal(fin.p_permanent, false);
  assert.deepEqual(fin.p_result, { proposal_id: job.payload.proposal_id, status: "executed", error: null });
  assert.ok(ctx.log.events().includes("job.claimed"));
  assert.ok(ctx.log.events().includes("job.done"));
});

test("a proposal whose executor failed is still a done job: the proposal holds the failure", async () => {
  const job = jobRow();
  const supa = fakeSupa({ rpc: { op_execute: { status: "failed", error: "op spine: no executor" } } });
  await runJob(ctxWith(supa), job);
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, true);
  assert.equal(fin.p_result.status, "failed");
  assert.match(fin.p_result.error, /no executor/);
});

test("a proposal.execute job without a proposal_id is dead on arrival", async () => {
  const supa = fakeSupa();
  await runJob(ctxWith(supa), jobRow({ payload: {} }));
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, true);
  assert.equal(supa.rpcs("op_execute").length, 0);
});

test("an unknown kind is finished permanently failed, never retried", async () => {
  const supa = fakeSupa();
  await runJob(ctxWith(supa), jobRow({ kind: "document.render" }));
  const fin = supa.rpcs("finish_job")[0];
  assert.equal(fin.p_ok, false);
  assert.equal(fin.p_permanent, true);
  assert.match(fin.p_error, /no handler for kind document\.render/);
});

test("a handler's JobError(permanent) is dead; a plain error is a retry", async () => {
  const supa = fakeSupa();
  const ctx = ctxWith(supa, { handlers: {
    "x.perm": async () => { throw new JobError("never", { permanent: true }); },
    "x.tran": async () => { throw new Error("later"); },
  } });
  await runJob(ctx, jobRow({ kind: "x.perm" }));
  await runJob(ctx, jobRow({ kind: "x.tran" }));
  const [a, b] = supa.rpcs("finish_job");
  assert.equal(a.p_permanent, true);
  assert.equal(a.p_error, "never");
  assert.equal(b.p_permanent, false);
  assert.equal(b.p_error, "later");
});

test("a lost lease on finish_job (55000) is logged, not thrown", async () => {
  const supa = fakeSupa({ rpc: {
    op_execute: { status: "executed" },
    finish_job: () => { const e = new Error("not leased by w-test"); e.code = "55000"; throw e; },
  } });
  const ctx = ctxWith(supa);
  const out = await runJob(ctx, jobRow());
  assert.equal(out, null);
  assert.ok(ctx.log.events().includes("job.lease_lost"));
});

test("the job is in ctx.active.jobs while its handler runs and gone afterwards, success or failure", async () => {
  const job = jobRow({ kind: "x.look" });
  let seen = null;
  const ctx = ctxWith(fakeSupa(), { handlers: { "x.look": async (c) => { seen = c.active.jobs.has(job.id); return {}; } } });
  await runJob(ctx, job);
  assert.equal(seen, true);
  assert.equal(ctx.active.jobs.size, 0);
  const ctx2 = ctxWith(fakeSupa(), { handlers: { "x.boom": async () => { throw new Error("later"); } } });
  await runJob(ctx2, jobRow({ kind: "x.boom" }));
  assert.equal(ctx2.active.jobs.size, 0);
  const ctx3 = ctxWith(fakeSupa());
  await runJob(ctx3, jobRow({ kind: "nobody.knows" }));
  assert.equal(ctx3.active.jobs.size, 0);
});

test("an outage on finish_job is retried per configured delay, then logged as finish_failed (the lease expires into a retry)", async () => {
  let n = 0;
  const supa = fakeSupa({ rpc: { op_execute: { status: "executed" }, finish_job: () => { n += 1; throw new Error("db down"); } } });
  const ctx = ctxWith(supa);
  const out = await runJob(ctx, jobRow());
  assert.equal(out, null);
  assert.equal(n, 3, "one call plus one retry per configured delay");
  assert.ok(ctx.log.events().includes("job.finish_retry"));
  assert.ok(ctx.log.events().includes("job.finish_failed"));
  assert.equal(ctx.active.jobs.size, 0);
  let m = 0;
  const supa2 = fakeSupa({ rpc: { op_execute: { status: "executed" }, finish_job: () => { m += 1; if (m === 1) throw new Error("blip"); return { status: "done" }; } } });
  const ctx2 = ctxWith(supa2);
  const row = await runJob(ctx2, jobRow());
  assert.equal(row.status, "done");
  assert.ok(ctx2.log.events().includes("job.done"));
});
