/* The outbox lane — outbox_claim → (adopt | send) → outbox_sent | outbox_failed.

   The order inside deliverOne is the exactly-once argument:
   1. a retry (attempts > 1) asks the adapter for the earlier attempt's
      provider record first; found → outbox_sent(adopted), no second send;
   2. otherwise the adapter sends, and writes its provider record;
   3. outbox_sent settles the row. If THAT call fails (outage), nothing is
      reported: the lease expires, the sweeper makes a retry, and step 1
      adopts. A failed send → outbox_failed with the adapter's verdict on
      permanence.
   Every attempt writes an integration_runs row (connection twilio/gmail,
   kind push) so the office's integrations page shows the lane breathing. */

import { errText } from "../log.mjs";

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

export async function deliverOne(ctx, row) {
  const adapter = ctx.adapters?.[row.channel];
  const startedAt = new Date().toISOString();
  const base = { outbox_id: row.id, channel: row.channel, attempts: row.attempts };

  if (!adapter) {
    await reportFailed(ctx, row, `no adapter for channel ${row.channel}`, false);
    return;
  }

  let result = null;
  let adopted = false;
  try {
    if (row.attempts > 1) {
      const prior = await adapter.findPrior(row);
      if (prior) { result = prior; adopted = true; }
    }
    if (!result) result = await adapter.send(row);
  } catch (e) {
    const permanent = e?.permanent === true;
    await reportFailed(ctx, row, errText(e, 2000), permanent);
    await logRun(ctx, { connection: adapter.connection, ok: false, error: errText(e), externalRef: row.id, startedAt });
    ctx.log("outbox.failed", { ...base, permanent, error: errText(e, 300) });
    return;
  }

  try {
    await ctx.supa.rpc("outbox_sent", {
      p_outbox_id: row.id,
      p_worker_id: ctx.cfg.workerId,
      p_provider_id: result.providerId || null,
      p_provider_status: result.providerStatus || null,
      p_cost_usd: result.costUsd ?? null,
      p_adopted: adopted,
      p_principal_id: ctx.cfg.outboxAgentId,
    });
    ctx.log("outbox.sent", { ...base, adopted, provider_id: result.providerId || null });
  } catch (e) {
    // Sent (or adopted) but not recorded. Deliberately NOT reported as a
    // failure: the lease will expire into a retry whose findPrior adopts.
    ctx.log(e?.code === "55000" ? "outbox.lease_lost_after_send" : "outbox.sent_report_failed", { ...base, error: errText(e) });
  }
  await logRun(ctx, { connection: adapter.connection, ok: true, externalRef: row.id, startedAt });
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
  for (const row of rows) {
    if (ctx.stopping?.()) break;   // a stop mid-batch: unsent rows keep their lease and expire into a retry
    await deliverOne(ctx, row);
  }
  return rows.length;
}
