/* Roybal worker — the always-on process behind the operations spine.

   Two lanes poll the database and a heartbeat ticks beside them:
     queue   claim_job → handler → finish_job            (lanes/queue.mjs)
     outbox  outbox_claim → adapter → outbox_sent/failed (lanes/outbox.mjs)
     beat    worker_heartbeat every 30 s, dead-letter text (heartbeat.mjs)

   /healthz answers 200 while the process is alive, with the last heartbeat
   age in the body. It stays 200 through a database outage on purpose: a 503
   would make Fly restart the machine in a loop, which fixes nothing and
   erases the logs that say what is wrong. The alarm for a worker that is
   not checking in is the database's (worker_liveness_check).

   SIGTERM: stop claiming, let in-flight work finish (up to SHUTDOWN_GRACE_MS,
   under fly.toml's kill_timeout), one last heartbeat, exit 0. A send still
   running when the grace runs out keeps its lease; the sweeper turns it into
   a retry that adopts the provider record if the send actually completed. */

import http from "node:http";
import { loadConfig } from "./config.mjs";
import { makeSupa } from "./supa.mjs";
import { makeLog, errText } from "./log.mjs";
import { smsAdapter } from "./adapters/sms.mjs";
import { emailAdapter } from "./adapters/email.mjs";
import { runQueueOnce, handlers } from "./lanes/queue.mjs";
import { runOutboxOnce } from "./lanes/outbox.mjs";
import { tick as heartbeatTick, beat } from "./heartbeat.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWorker({ cfg = loadConfig(), log = makeLog(), fetchImpl } = {}) {
  const supa = makeSupa({ supabaseUrl: cfg.supabaseUrl, serviceKey: cfg.serviceKey, fetchImpl });
  const state = {
    bootIso: new Date().toISOString(),
    stopping: false,
    lastBeatAt: 0,
    lastBeatError: null,
    depth: null,
    lanes: { queue: { runs: 0, lastRunAt: null, lastError: null }, outbox: { runs: 0, lastRunAt: null, lastError: null } },
  };
  const ctx = {
    cfg, supa, log, fetch: fetchImpl,
    adapters: {},
    handlers,
    stopping: () => state.stopping,
  };
  ctx.adapters.sms = smsAdapter(ctx);
  if (cfg.emailEnabled) ctx.adapters.email = emailAdapter(ctx);

  const loops = [];
  let beatTimer = null;

  async function runLoop(name, once) {
    const lane = state.lanes[name];
    while (!state.stopping) {
      let did = 0;
      try {
        did = await once(ctx);
        lane.lastError = null;
      } catch (e) {
        lane.lastError = errText(e);
        log(`${name}.loop_error`, { error: errText(e) });
        did = 0;
      }
      lane.runs += 1;
      lane.lastRunAt = new Date().toISOString();
      if (state.stopping) break;
      // more work right away after a busy pass; an outage backs off to twice the poll
      await sleep(did > 0 ? 50 : lane.lastError ? cfg.pollMs * 2 : cfg.pollMs);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      const body = {
        ok: true,
        worker_id: cfg.workerId,
        version: cfg.version,
        uptime_s: Math.round(process.uptime()),
        stopping: state.stopping,
        last_heartbeat_ago_s: state.lastBeatAt ? Math.round((Date.now() - state.lastBeatAt) / 1000) : null,
        last_heartbeat_error: state.lastBeatError,
        depth: state.depth,
        lanes: state.lanes,
        channels: cfg.channels,
        kinds: cfg.queueKinds,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  async function start() {
    await new Promise((resolve) => server.listen(cfg.port, resolve));
    log("worker.start", {
      worker_id: cfg.workerId, version: cfg.version, port: cfg.port,
      channels: cfg.channels, kinds: cfg.queueKinds, email: cfg.emailEnabled, owner_cell: Boolean(cfg.ownerCell),
    });
    if (!cfg.emailEnabled) log("email.disabled", { reason: "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set; email rows wait as pending" });
    if (!cfg.ownerCell) log("deadletter.disabled", { reason: "OWNER_CELL not set" });
    await heartbeatTick(ctx, state);
    beatTimer = setInterval(() => { heartbeatTick(ctx, state); }, cfg.heartbeatMs);
    loops.push(runLoop("queue", runQueueOnce));
    loops.push(runLoop("outbox", runOutboxOnce));
  }

  async function stop(reason = "stop") {
    if (state.stopping) return;
    state.stopping = true;
    log("worker.stopping", { reason });
    if (beatTimer) clearInterval(beatTimer);
    const deadline = sleep(cfg.shutdownGraceMs).then(() => "timeout");
    const outcome = await Promise.race([Promise.allSettled(loops).then(() => "drained"), deadline]);
    try { await beat(ctx, state); } catch (e) { log("heartbeat.failed", { error: errText(e), at: "stop" }); }
    await new Promise((resolve) => server.close(() => resolve()));
    log("worker.stopped", { outcome });
  }

  return { ctx, state, server, start, stop };
}

if (process.env.NODE_ENV !== "test") {
  const worker = createWorker();
  worker.start().catch((e) => {
    worker.ctx.log("worker.start_failed", { error: errText(e) });
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      worker.stop(sig).then(() => process.exit(0), () => process.exit(0));
    });
  }
}
