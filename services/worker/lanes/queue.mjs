/* The queue lane — claim_job → handler → finish_job.

   One kind today: `proposal.execute`, which op_proposal_approve enqueues for
   an operation whose runtime is `worker` (none of the first five is; the lane
   exists so the day one lands, nothing else has to). The handler runs
   op_execute as the job's own principal (the approver), exactly as the SQL
   runtime path does. A proposal whose executor fails is NOT a failed job: the
   proposal records its failure and a re-run would return the same row, so the
   job is done with that outcome in its result. */

import { errText } from "../log.mjs";

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
};

export async function finishJob(ctx, job, { ok, result = null, error = null, permanent = false }) {
  try {
    const row = await ctx.supa.rpc("finish_job", {
      p_job_id: job.id,
      p_worker_id: ctx.cfg.workerId,
      p_ok: ok,
      p_error: error ? String(error).slice(0, 2000) : null,
      p_result: result,
      p_permanent: permanent,
    });
    ctx.log(ok ? "job.done" : "job.failed", {
      job_id: job.id, kind: job.kind, attempts: job.attempts, status: row?.status ?? null,
      ...(error ? { error: String(error).slice(0, 300) } : {}),
    });
    return row;
  } catch (e) {
    // 55000: the sweeper took the lease while we worked — another worker (or
    // a retry) owns the outcome now. Anything else is an outage; the lease
    // will expire into a retry on its own.
    ctx.log(e?.code === "55000" ? "job.lease_lost" : "job.finish_failed", {
      job_id: job.id, kind: job.kind, error: errText(e),
    });
    return null;
  }
}

export async function runJob(ctx, job) {
  const handler = (ctx.handlers ?? handlers)[job.kind];
  if (!handler) {
    return finishJob(ctx, job, { ok: false, error: `no handler for kind ${job.kind}`, permanent: true });
  }
  try {
    const result = await handler(ctx, job);
    return await finishJob(ctx, job, { ok: true, result: result ?? {} });
  } catch (e) {
    return finishJob(ctx, job, { ok: false, error: errText(e, 2000), permanent: e?.permanent === true });
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
