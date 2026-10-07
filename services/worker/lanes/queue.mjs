/* The queue lane — claim_job → handler → finish_job.

   Two kinds. `proposal.execute`, which op_proposal_approve enqueues for an
   operation whose runtime is `worker` (none is yet; the lane exists so the
   day one lands, nothing else has to): the handler runs op_execute as the
   job's own principal (the approver), exactly as the SQL runtime path does.
   A proposal whose executor fails is NOT a failed job: the proposal records
   its failure and a re-run would return the same row, so the job is done
   with that outcome in its result. `billing.reconcile`, the nightly billing
   check pg_cron enqueues (lanes/billing.mjs): its summary is the result.

   Only the kinds in QUEUE_KINDS are ever claimed; any other kind waits as
   `queued` until a worker that knows it is deployed. A kind that IS listed
   but has no handler here is dead on arrival, never retried.

   ctx.active.jobs holds the job id while it runs; the heartbeat extends only
   that lease. Add on entry, delete on every exit. */

import { errText } from "../log.mjs";
import { billingReconcile } from "./billing.mjs";

const SETTLE_RETRY_MS = [500, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JobError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "JobError";
    this.permanent = permanent;
  }
}

export const handlers = {
  async "proposal.execute"(ctx, job) {
    const proposalId = job.payload?.proposal_id;
    if (!proposalId) throw new JobError("proposal.execute job has no proposal_id", { permanent: true });
    const row = await ctx.supa.rpc("op_execute", {
      p_proposal_id: proposalId,
      p_principal_kind: job.principal_kind || "system",
      p_principal_id: job.principal_id ?? null,
    });
    return { proposal_id: proposalId, status: row?.status ?? null, error: row?.error ?? null };
  },
  "billing.reconcile": billingReconcile,
};

export async function finishJob(ctx, job, { ok, result = null, error = null, permanent = false }) {
  const args = {
    p_job_id: job.id,
    p_worker_id: ctx.cfg.workerId,
    p_ok: ok,
    p_error: error ? String(error).slice(0, 2000) : null,
    p_result: result,
    p_permanent: permanent,
  };
  const delays = ctx.settleRetryMs ?? SETTLE_RETRY_MS;
  for (let i = 0; ; i++) {
    try {
      const row = await ctx.supa.rpc("finish_job", args);
      ctx.log(ok ? "job.done" : "job.failed", {
        job_id: job.id, kind: job.kind, attempts: job.attempts, status: row?.status ?? null,
        ...(error ? { error: String(error).slice(0, 300) } : {}),
      });
      return row;
    } catch (e) {
      // 55000: the sweeper took the lease while we worked — another worker (or
      // a retry) owns the outcome now. Anything else is an outage: retry the
      // settle a few times, then let the lease expire into a retry on its own.
      if (e?.code !== "55000" && i < delays.length) {
        ctx.log("job.finish_retry", { job_id: job.id, try: i + 1, error: errText(e) });
        await sleep(delays[i]);
        continue;
      }
      ctx.log(e?.code === "55000" ? "job.lease_lost" : "job.finish_failed", {
        job_id: job.id, kind: job.kind, error: errText(e),
      });
      return null;
    }
  }
}

export async function runJob(ctx, job) {
  ctx.active?.jobs?.add(job.id);
  try {
    const handler = (ctx.handlers ?? handlers)[job.kind];
    if (!handler) {
      return await finishJob(ctx, job, { ok: false, error: `no handler for kind ${job.kind}`, permanent: true });
    }
    try {
      const result = await handler(ctx, job);
      return await finishJob(ctx, job, { ok: true, result: result ?? {} });
    } catch (e) {
      return await finishJob(ctx, job, { ok: false, error: errText(e, 2000), permanent: e?.permanent === true });
    }
  } finally {
    ctx.active?.jobs?.delete(job.id);
  }
}

/** Claims and runs one job. Returns 1 when a job was run, 0 when the queue was empty. */
export async function runQueueOnce(ctx) {
  const rows = await ctx.supa.rpc("claim_job", {
    p_worker_id: ctx.cfg.workerId,
    p_kinds: ctx.cfg.queueKinds,
    p_lease_seconds: ctx.cfg.queueLeaseS,
  });
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) return 0;
  ctx.log("job.claimed", { job_id: job.id, kind: job.kind, attempts: job.attempts });
  await runJob(ctx, job);
  return 1;
}
