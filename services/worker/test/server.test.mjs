/* The real server with Supabase stubbed at the fetch layer: boot, /healthz,
   one empty pass of each lane, the heartbeat RPC, and a clean stop. */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { createWorker } = await import("../server.mjs");
const { testConfig, recordingLog, fakeFetch } = await import("./helpers.mjs");

function stubRest(cfg) {
  const base = cfg.supabaseUrl;
  return fakeFetch([
    { match: (u) => u.startsWith(`${base}/rest/v1/rpc/claim_job`), reply: () => ({ body: [] }) },
    { match: (u) => u.startsWith(`${base}/rest/v1/rpc/outbox_claim`), reply: () => ({ body: [] }) },
    { match: (u) => u.startsWith(`${base}/rest/v1/rpc/worker_heartbeat`), reply: () => ({ body: { worker_id: cfg.workerId } }) },
    { match: (u) => u.startsWith(`${base}/rest/v1/jobs_queue`) || u.startsWith(`${base}/rest/v1/outbox`),
      reply: () => ({ body: [], headers: { "Content-Range": "*/0" } }) },
    { match: (u) => u.startsWith(`${base}/rest/v1/app_settings`), reply: () => ({ body: [] }) },
  ]);
}

test("boots, answers /healthz, heartbeats, polls both lanes, and stops cleanly", async () => {
  const cfg = testConfig({ port: 0, pollMs: 250, ownerCell: "" });
  const fetch = stubRest(cfg);
  const log = recordingLog();
  const w = createWorker({ cfg, log, fetchImpl: fetch });
  await w.start();
  const port = w.server.address().port;
  const res = await globalThis.fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.worker_id, "w-test");
  assert.equal(body.stopping, false);
  assert.equal(typeof body.last_heartbeat_ago_s, "number");
  assert.equal(body.last_heartbeat_error, null);
  assert.deepEqual(body.channels, ["sms", "email"]);

  const nf = await globalThis.fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(nf.status, 404);

  await new Promise((r) => setTimeout(r, 400));
  const urls = fetch.calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes("/rpc/worker_heartbeat")), "heartbeat sent");
  assert.ok(urls.some((u) => u.includes("/rpc/claim_job")), "queue lane polled");
  assert.ok(urls.some((u) => u.includes("/rpc/outbox_claim")), "outbox lane polled");
  const hb = fetch.calls.find((c) => c.url.includes("/rpc/worker_heartbeat"));
  assert.equal(hb.init.headers.apikey, cfg.serviceKey);
  assert.equal(hb.body.p_edge_base_url, cfg.supabaseUrl);
  assert.ok(log.events().includes("worker.start"));

  await w.stop("test");
  assert.ok(log.events().includes("worker.stopped"));
  assert.equal(log.lines.find((l) => l.event === "worker.stopped").outcome, "drained");
  await assert.rejects(globalThis.fetch(`http://127.0.0.1:${port}/healthz`));
});

test("the email lane is off, and says so, without the Gmail client secret", async () => {
  const cfg = testConfig({ port: 0, emailEnabled: false, channels: ["sms"], ownerCell: "" });
  const log = recordingLog();
  const w = createWorker({ cfg, log, fetchImpl: stubRest(cfg) });
  await w.start();
  assert.equal(w.ctx.adapters.email, undefined);
  assert.ok(log.events().includes("email.disabled"));
  assert.ok(log.events().includes("deadletter.disabled"));
  await w.stop("test");
});

test("a database outage does not take /healthz down", async () => {
  const cfg = testConfig({ port: 0, pollMs: 250, ownerCell: "" });
  const fetch = fakeFetch([{ match: () => true, reply: () => ({ status: 503, body: { message: "db down" } }) }]);
  const log = recordingLog();
  const w = createWorker({ cfg, log, fetchImpl: fetch });
  await w.start();
  const port = w.server.address().port;
  const body = await (await globalThis.fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.match(body.last_heartbeat_error, /503/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(log.events().includes("queue.loop_error"));
  assert.ok(log.events().includes("outbox.loop_error"));
  await w.stop("test");
});
