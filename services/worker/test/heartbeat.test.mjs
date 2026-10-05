import { test } from "node:test";
import assert from "node:assert/strict";
import { beat, deadLetterCheck, deadLetterText, tick } from "../heartbeat.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch } from "./helpers.mjs";

const freshState = () => ({ bootIso: "2026-10-05T18:00:00.000Z", lastBeatAt: 0, lastBeatError: null, depth: null });

test("beat reports depth, leases and the edge base url, and extends the longer lease", async () => {
  const cfg = testConfig();
  const supa = fakeSupa({
    count: { jobs_queue: (q) => (q.startsWith("status=eq.leased") ? 2 : 7), outbox: 3 },
    rpc: { worker_heartbeat: { worker_id: "w-test" } },
  });
  const state = freshState();
  const active = { jobs: new Set(["44444444-4444-4444-4444-444444444444"]), outbox: new Set(["11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111112"]) };
  await beat({ cfg, supa, log: recordingLog(), active }, state);
  const hb = supa.rpcs("worker_heartbeat")[0];
  assert.deepEqual(hb.p_active_jobs, ["44444444-4444-4444-4444-444444444444"], "only the job being run is extended");
  assert.deepEqual(hb.p_active_outbox, ["11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111112"]);
  assert.deepEqual(hb.p_meta.active, { jobs: 1, outbox: 2 });
  assert.equal(hb.p_worker_id, "w-test");
  assert.equal(hb.p_version, "test");
  assert.equal(hb.p_queue_depth, 7);
  assert.equal(hb.p_leased, 2);
  assert.equal(hb.p_outbox_pending, 3);
  assert.equal(hb.p_edge_base_url, "https://stub.supabase.co");
  assert.equal(hb.p_lease_seconds, 300);
  assert.equal(hb.p_meta.region, "sjc");
  assert.deepEqual(hb.p_meta.channels, ["sms", "email"]);
  assert.ok(state.lastBeatAt > 0);
  assert.deepEqual(state.depth, { queue: 7, leased: 2, outbox: 3 });
  const leasedQuery = supa.calls.count.find((c) => c.query.startsWith("status=eq.leased")).query;
  assert.match(leasedQuery, /locked_by=eq\.w-test/);
});

test("with nothing in flight the heartbeat names no lease; the final beat (extend: false) names none even mid-work", async () => {
  const supa = fakeSupa({ rpc: { worker_heartbeat: { worker_id: "w-test" } } });
  await beat({ cfg: testConfig(), supa, log: recordingLog(), active: { jobs: new Set(), outbox: new Set() } }, freshState());
  let hb = supa.rpcs("worker_heartbeat")[0];
  assert.equal(hb.p_active_jobs, null);
  assert.equal(hb.p_active_outbox, null);
  const busy = { jobs: new Set(["44444444-4444-4444-4444-444444444444"]), outbox: new Set(["11111111-1111-1111-1111-111111111111"]) };
  await beat({ cfg: testConfig(), supa, log: recordingLog(), active: busy }, freshState(), { extend: false });
  hb = supa.rpcs("worker_heartbeat")[1];
  assert.equal(hb.p_active_jobs, null, "a stopping worker renews nothing: abandoned rows must expire into retries");
  assert.equal(hb.p_active_outbox, null);
  // a context without active sets (older callers) still beats
  await beat({ cfg: testConfig(), supa, log: recordingLog() }, freshState());
  assert.equal(supa.rpcs("worker_heartbeat")[2].p_active_outbox, null);
});

test("the dead-letter check is off without OWNER_CELL and quiet when nothing is dead", async () => {
  const supa = fakeSupa();
  const r1 = await deadLetterCheck({ cfg: testConfig({ ownerCell: "" }), supa, log: recordingLog() }, freshState());
  assert.equal(r1.texted, false);
  assert.equal(supa.calls.count.length, 0);
  const r2 = await deadLetterCheck({ cfg: testConfig(), supa, log: recordingLog(), fetch: fakeFetch([]) }, freshState());
  assert.equal(r2.texted, false);
  assert.equal(r2.reason, "nothing dead");
  const since = supa.calls.count[0].query;
  assert.match(since, /status=eq\.dead&updated_at=gt\.2026-10-04T18%3A00%3A00\.000Z/, "counts from a day before boot when there is no watermark, so rows that died during a restart are not missed");
});

test("dead rows text the owner once through roybal-notify (kind brief) and move the watermark", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([{ match: (u) => u === cfg.notifyUrl, reply: () => ({ body: { ok: true, sid: "SM1", status: "queued" } }) }]);
  const supa = fakeSupa({ count: { outbox: 2, jobs_queue: 1 } });
  const log = recordingLog();
  const r = await deadLetterCheck({ cfg, supa, log, fetch }, freshState());
  assert.equal(r.texted, true);
  assert.equal(r.count, 3);
  const body = fetch.calls[0].body;
  assert.equal(body.action, "sendSms");
  assert.equal(body.to, cfg.ownerCell);
  assert.equal(body.kind, "brief");
  assert.equal(body.captured_by, "worker-deadletter");
  assert.match(body.body, /3 messages or tasks gave up/);
  const up = supa.calls.upsert[0];
  assert.equal(up.table, "app_settings");
  assert.equal(up.onConflict, "key");
  assert.equal(up.rows[0].key, "worker.deadletter_alert");
  assert.ok(up.rows[0].value.alerted_at && up.rows[0].value.watermark);
  assert.equal(up.rows[0].value.last_count, 3);
  assert.ok(log.events().includes("deadletter.texted"));
});

test("inside the 24 h guard nothing is texted and the watermark does not move", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([]);
  const recent = new Date(Date.now() - 3600_000).toISOString();
  const supa = fakeSupa({
    select: { app_settings: [{ key: "worker.deadletter_alert", value: { alerted_at: recent, watermark: recent } }] },
    count: { outbox: 1, jobs_queue: 0 },
  });
  const r = await deadLetterCheck({ cfg, supa, log: recordingLog(), fetch }, freshState());
  assert.equal(r.texted, false);
  assert.equal(r.reason, "texted within 24 h");
  assert.equal(fetch.calls.length, 0);
  assert.equal(supa.calls.upsert.length, 0);
  assert.match(supa.calls.count[0].query, new RegExp(encodeURIComponent(recent).replace(/[.]/g, "\\.")), "counts from the stored watermark");
});

test("after the guard lapses the owner is texted again; a refused text leaves the watermark alone", async () => {
  const cfg = testConfig();
  const old = new Date(Date.now() - 25 * 3600_000).toISOString();
  const st = { select: { app_settings: [{ key: "worker.deadletter_alert", value: { alerted_at: old, watermark: old } }] }, count: { outbox: 1, jobs_queue: 0 } };
  const ok = fakeFetch([{ match: () => true, reply: () => ({ body: { ok: true, sid: "SM2" } }) }]);
  const supa = fakeSupa(st);
  assert.equal((await deadLetterCheck({ cfg, supa, log: recordingLog(), fetch: ok }, freshState())).texted, true);
  assert.equal(supa.calls.upsert.length, 1);

  const refused = fakeFetch([{ match: () => true, reply: () => ({ status: 400, body: { ok: false, error: "sms_cap_reached: 500 of 500" } }) }]);
  const supa2 = fakeSupa(st);
  const log = recordingLog();
  const r = await deadLetterCheck({ cfg, supa: supa2, log, fetch: refused }, freshState());
  assert.equal(r.texted, false);
  assert.equal(supa2.calls.upsert.length, 0);
  assert.ok(log.events().includes("deadletter.text_failed"));
});

test("deadLetterText reads as a sentence in Alaska time", () => {
  const t = deadLetterText({ count: 1, since: "2026-10-05T18:00:00Z" });
  assert.match(t, /^Roybal worker: 1 message or task gave up after retries since Oct 5, 10:00 AM Alaska time\./);
  assert.match(deadLetterText({ count: 3, since: "2026-10-05T18:00:00Z" }), /3 messages or tasks/);
  assert.ok(t.length < 320);
});

test("tick swallows a failing heartbeat and records the error for /healthz", async () => {
  const supa = fakeSupa({ count: { "*": () => { throw new Error("db down"); } } });
  const state = freshState();
  const log = recordingLog();
  await tick({ cfg: testConfig({ ownerCell: "" }), supa, log }, state);
  assert.equal(state.lastBeatError, "db down");
  assert.ok(log.events().includes("heartbeat.failed"));
});
