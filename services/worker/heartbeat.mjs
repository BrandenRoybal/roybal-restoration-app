/* The 30 s check-in, and the dead-letter text.

   beat(): worker_heartbeat() upserts this worker's row, extends every lease
   it holds, and records SUPABASE_URL as app_settings edge.base_url — which is
   how the database's liveness check (pg_cron → worker_liveness_check) knows
   where roybal-webhooks/alert lives for THIS project. The dead-WORKER text is
   therefore the database's to send, never this process's: a process that is
   down cannot report itself.

   deadLetterCheck(): rows that gave up (outbox dead, jobs_queue dead) since
   the last watermark → one text to OWNER_CELL through roybal-notify (kind
   brief: owner-directed, quiet-hours exempt), at most once per 24 h; the
   watermark moves only when a text goes out, so nothing is swallowed by the
   guard. State lives in app_settings worker.deadletter_alert so a restart
   does not re-text. */

import { errText } from "./log.mjs";

const DAY_MS = 24 * 3600 * 1000;

export async function beat(ctx, state) {
  const { cfg, supa } = ctx;
  const [queueDepth, leased, outboxPending] = await Promise.all([
    supa.count("jobs_queue", "status=in.(queued,failed)"),
    supa.count("jobs_queue", `status=eq.leased&locked_by=eq.${encodeURIComponent(cfg.workerId)}`),
    supa.count("outbox", "status=in.(pending,failed)"),
  ]);
  const row = await supa.rpc("worker_heartbeat", {
    p_worker_id: cfg.workerId,
    p_version: cfg.version,
    p_queue_depth: queueDepth,
    p_leased: leased,
    p_outbox_pending: outboxPending,
    p_meta: {
      region: cfg.region || null,
      pid: process.pid,
      node: process.version,
      uptime_s: Math.round(process.uptime()),
      channels: cfg.channels,
      kinds: cfg.queueKinds,
      email: cfg.emailEnabled,
    },
    p_edge_base_url: cfg.supabaseUrl,
    p_lease_seconds: Math.max(cfg.queueLeaseS, cfg.outboxLeaseS),
  });
  state.lastBeatAt = Date.now();
  state.lastBeatError = null;
  state.depth = { queue: queueDepth, leased, outbox: outboxPending };
  return row;
}

export function deadLetterText({ count, since }) {
  const fmt = (d) => new Date(d).toLocaleString("en-US", {
    timeZone: "America/Anchorage", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const what = count === 1 ? "1 message or task" : `${count} messages or tasks`;
  return `Roybal worker: ${what} gave up after retries since ${fmt(since)} Alaska time. ` +
    `Open the admin app's outbox and look for status dead.`;
}

export async function deadLetterCheck(ctx, state) {
  const { cfg, supa } = ctx;
  if (!cfg.ownerCell) return { texted: false, reason: "OWNER_CELL unset" };

  const rows = await supa.select("app_settings", "select=key,value&key=eq.worker.deadletter_alert");
  const st = rows[0]?.value ?? {};
  const since = st.watermark || state.bootIso;
  const [deadOutbox, deadJobs] = await Promise.all([
    supa.count("outbox", `status=eq.dead&updated_at=gt.${encodeURIComponent(since)}`),
    supa.count("jobs_queue", `status=eq.dead&finished_at=gt.${encodeURIComponent(since)}`),
  ]);
  const count = deadOutbox + deadJobs;
  if (!count) return { texted: false, reason: "nothing dead", count };

  const guarded = st.alerted_at && Date.now() - Date.parse(st.alerted_at) < DAY_MS;
  if (guarded) return { texted: false, reason: "texted within 24 h", count };

  const nowIso = new Date().toISOString();
  const res = await (ctx.fetch ?? globalThis.fetch)(cfg.notifyUrl, {
    method: "POST",
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "sendSms", to: cfg.ownerCell, kind: "brief", captured_by: "worker-deadletter",
      body: deadLetterText({ count, since }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    ctx.log("deadletter.text_failed", { count, error: String(data?.error ?? res.status).slice(0, 300) });
    return { texted: false, reason: "notify refused", count };
  }
  await supa.upsert("app_settings", [{
    key: "worker.deadletter_alert",
    value: { alerted_at: nowIso, watermark: nowIso, last_count: count, sid: data.sid ?? null },
    updated_at: nowIso,
  }], "key");
  ctx.log("deadletter.texted", { count, since });
  return { texted: true, count };
}

/** One tick: heartbeat, then the dead-letter check; each failure logged, never thrown. */
export async function tick(ctx, state) {
  try {
    await beat(ctx, state);
  } catch (e) {
    state.lastBeatError = errText(e);
    ctx.log("heartbeat.failed", { error: errText(e) });
  }
  try {
    await deadLetterCheck(ctx, state);
  } catch (e) {
    ctx.log("deadletter.check_failed", { error: errText(e) });
  }
}
