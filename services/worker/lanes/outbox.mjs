/* The outbox lane — outbox_claim → (adopt | send) → outbox_sent | outbox_failed.

   The order inside deliverOne is the exactly-once argument:
   1. EVERY attempt asks the adapter for an earlier provider record first
      (the tag outbox:<id> on sms_messages / email_messages); found → the
      adapter vouches the provider accepted it → outbox_sent(adopted), no
      second send. Attempt 1 included: a dead row the owner revived, or a row
      whose earlier process died after the provider accepted, is adopted, not
      resent. One indexed select; it finds nothing on a true first attempt.
   2. otherwise the adapter sends, and writes its provider record;
   3. outbox_sent settles the row, retried a few times on an outage because
      it is idempotent for the holder. If it still fails nothing is reported:
      the row leaves ctx.active, so the heartbeat stops renewing its lease,
      the sweeper makes a retry, and step 1 adopts.
   A failed send → outbox_failed with the adapter's verdict on permanence.

   ctx.active.outbox holds every id this process has claimed and not yet
   settled: the whole batch from the moment outbox_claim returns (every row's
   lease starts there), each row leaving as its deliverOne exits. The
   heartbeat extends only those leases, so a slow first row cannot let the
   sweeper take the tail this loop still intends to send.

   Every attempt writes an integration_runs row (connection twilio/gmail,
   kind push) so the office's integrations page shows the lane breathing. */

import { errText, redact } from "../log.mjs";

const SETTLE_RETRY_MS = [500, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logRun(ctx, { connection, ok, error, externalRef, startedAt }) {
  try {
    await ctx.supa.insert("integration_runs", [{
      connection, kind: "push", started_at: startedAt, finished_at: new Date().toISOString(),
      ok, error: error ? String(error).slice(0, 500) : null, rows_affected: ok ? 1 : 0, external_ref: externalRef,
    }]);
  } catch (e) {
    ctx.log("integration_run.write_failed", { error: errText(e) });
  }
}

/** outbox_sent with a short retry: an outage on the settle call must not turn
    a delivered message into a retry when a second try would have recorded it.
    Code 55000 (the lease is no longer ours) is final and not retried. */
async function reportSent(ctx, row, result, adopted) {
  const args = {
    p_outbox_id: row.id,
    p_worker_id: ctx.cfg.workerId,
    p_provider_id: result.providerId || null,
    p_provider_status: result.providerStatus || null,
    p_cost_usd: result.costUsd ?? null,
    p_adopted: adopted,
    p_principal_id: ctx.cfg.outboxAgentId,
  };
  const delays = ctx.settleRetryMs ?? SETTLE_RETRY_MS;
  for (let i = 0; ; i++) {
    try {
      await ctx.supa.rpc("outbox_sent", args);
      return true;
    } catch (e) {
      if (e?.code === "55000" || i >= delays.length) throw e;
      ctx.log("outbox.sent_report_retry", { outbox_id: row.id, try: i + 1, error: errText(e) });
      await sleep(delays[i]);
    }
  }
}

export async function deliverOne(ctx, row) {
  const adapter = ctx.adapters?.[row.channel];
  const startedAt = new Date().toISOString();
  const base = { outbox_id: row.id, channel: row.channel, attempts: row.attempts };
  ctx.active?.outbox?.add(row.id);
  try {
    if (!adapter) {
      await reportFailed(ctx, row, `no adapter for channel ${row.channel}`, false);
      return;
    }

    let result = null;
    let adopted = false;
    try {
      const prior = await adapter.findPrior(row);
      if (prior) { result = prior; adopted = true; }
      if (!result) result = await adapter.send(row);
    } catch (e) {
      const permanent = e?.permanent === true;
      await reportFailed(ctx, row, errText(e, 2000), permanent);
      await logRun(ctx, { connection: adapter.connection, ok: false, error: errText(e), externalRef: row.id, startedAt });
      ctx.log("outbox.failed", { ...base, permanent, error: redact(errText(e, 300)) });
      return;
    }

    try {
      await reportSent(ctx, row, result, adopted);
      ctx.log("outbox.sent", { ...base, adopted, provider_id: result.providerId || null });
    } catch (e) {
      // Sent (or adopted) but not recorded. Deliberately NOT reported as a
      // failure: the row leaves ctx.active below, its lease expires into a
      // retry, and that retry's findPrior adopts the provider record.
      ctx.log(e?.code === "55000" ? "outbox.lease_lost_after_send" : "outbox.sent_report_failed", { ...base, error: errText(e) });
    }
    await logRun(ctx, { connection: adapter.connection, ok: true, externalRef: row.id, startedAt });
  } finally {
    ctx.active?.outbox?.delete(row.id);
  }
}

async function reportFailed(ctx, row, error, permanent) {
  try {
    await ctx.supa.rpc("outbox_failed", {
      p_outbox_id: row.id,
      p_worker_id: ctx.cfg.workerId,
      p_error: String(error).slice(0, 2000),
      p_permanent: permanent,
      p_principal_id: ctx.cfg.outboxAgentId,
    });
  } catch (e) {
    ctx.log("outbox.failed_report_failed", { outbox_id: row.id, error: errText(e) });
  }
}

/** Claims a batch and delivers it. Returns how many rows were claimed. */
export async function runOutboxOnce(ctx) {
  if (!ctx.cfg.channels.length) return 0;
  const rows = await ctx.supa.rpc("outbox_claim", {
    p_worker_id: ctx.cfg.workerId,
    p_channels: ctx.cfg.channels,
    p_lease_seconds: ctx.cfg.outboxLeaseS,
    p_limit: ctx.cfg.outboxBatch,
  });
  if (!Array.isArray(rows) || !rows.length) return 0;
  // Every claimed row is ours to renew until it settles (see the header).
  for (const row of rows) ctx.active?.outbox?.add(row.id);
  let done = 0;
  try {
    for (const row of rows) {
      if (ctx.stopping?.()) break;   // a stop mid-batch: unsent rows leave the set below, keep their lease and expire into a retry
      await deliverOne(ctx, row);
      done += 1;
    }
  } finally {
    for (const row of rows) ctx.active?.outbox?.delete(row.id);
    if (done < rows.length) ctx.log("outbox.batch_cut_short", { claimed: rows.length, delivered: done });
  }
  return rows.length;
}
