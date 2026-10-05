import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverOne, runOutboxOnce } from "../lanes/outbox.mjs";
import { DeliveryError } from "../adapters/sms.mjs";
import { fakeSupa, testConfig, recordingLog, outboxRow } from "./helpers.mjs";
import { beat } from "../heartbeat.mjs";

function fakeAdapter({ prior = null, send = async () => ({ providerId: "P1", providerStatus: "sent" }) } = {}) {
  const calls = { findPrior: 0, send: 0 };
  return {
    calls,
    channel: "sms",
    connection: "twilio",
    async findPrior() { calls.findPrior += 1; return prior; },
    async send(row) { calls.send += 1; return send(row); },
  };
}

const ctxWith = (adapter, supa = fakeSupa(), cfg = testConfig()) =>
  ({ cfg, supa, log: recordingLog(), adapters: { sms: adapter }, stopping: () => false,
     active: { jobs: new Set(), outbox: new Set() }, settleRetryMs: [5, 5] });

test("first attempt: adopt lookup (finds nothing), send, then outbox_sent as agent:outbox, plus an integration run", async () => {
  const adapter = fakeAdapter();
  const ctx = ctxWith(adapter);
  const row = outboxRow({ attempts: 1 });
  await deliverOne(ctx, row);
  assert.equal(adapter.calls.findPrior, 1, "every attempt checks for an earlier provider record first");
  assert.equal(adapter.calls.send, 1);
  const sent = ctx.supa.rpcs("outbox_sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].p_outbox_id, row.id);
  assert.equal(sent[0].p_worker_id, "w-test");
  assert.equal(sent[0].p_provider_id, "P1");
  assert.equal(sent[0].p_adopted, false);
  assert.equal(sent[0].p_principal_id, ctx.cfg.outboxAgentId);
  assert.equal(ctx.supa.rpcs("outbox_failed").length, 0);
  const run = ctx.supa.calls.insert.find((c) => c.table === "integration_runs");
  assert.equal(run.rows[0].connection, "twilio");
  assert.equal(run.rows[0].kind, "push");
  assert.equal(run.rows[0].ok, true);
  assert.equal(run.rows[0].external_ref, row.id);
  assert.ok(ctx.log.events().includes("outbox.sent"));
});

test("a retry adopts the earlier attempt's provider record instead of sending again", async () => {
  const adapter = fakeAdapter({ prior: { providerId: "SM-old", providerStatus: "delivered" } });
  const ctx = ctxWith(adapter);
  await deliverOne(ctx, outboxRow({ attempts: 2 }));
  assert.equal(adapter.calls.findPrior, 1);
  assert.equal(adapter.calls.send, 0, "never a second text");
  const sent = ctx.supa.rpcs("outbox_sent");
  assert.equal(sent[0].p_provider_id, "SM-old");
  assert.equal(sent[0].p_adopted, true);
});

test("a retry with nothing to adopt sends", async () => {
  const adapter = fakeAdapter({ prior: null });
  const ctx = ctxWith(adapter);
  await deliverOne(ctx, outboxRow({ attempts: 3 }));
  assert.equal(adapter.calls.findPrior, 1);
  assert.equal(adapter.calls.send, 1);
  assert.equal(ctx.supa.rpcs("outbox_sent")[0].p_adopted, false);
});

test("a permanent refusal → outbox_failed(permanent); a transient one → outbox_failed(retry)", async () => {
  for (const [permanent, msg] of [[true, "not a valid phone number"], [false, "twilio 503"]]) {
    const adapter = fakeAdapter({ send: async () => { throw new DeliveryError(msg, { permanent }); } });
    const ctx = ctxWith(adapter);
    const row = outboxRow();
    await deliverOne(ctx, row);
    assert.equal(ctx.supa.rpcs("outbox_sent").length, 0);
    const failed = ctx.supa.rpcs("outbox_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].p_outbox_id, row.id);
    assert.equal(failed[0].p_error, msg);
    assert.equal(failed[0].p_permanent, permanent);
    assert.equal(failed[0].p_principal_id, ctx.cfg.outboxAgentId);
    const run = ctx.supa.calls.insert.find((c) => c.table === "integration_runs");
    assert.equal(run.rows[0].ok, false);
    assert.equal(run.rows[0].error, msg);
  }
});

test("a plain Error from an adapter is a retry, never permanent", async () => {
  const adapter = fakeAdapter({ send: async () => { throw new Error("socket hang up"); } });
  const ctx = ctxWith(adapter);
  await deliverOne(ctx, outboxRow());
  assert.equal(ctx.supa.rpcs("outbox_failed")[0].p_permanent, false);
});

test("outbox_sent failing after a real send is retried, then NOT reported as a failure (the retry adopts)", async () => {
  const adapter = fakeAdapter();
  const supa = fakeSupa({ rpc: { outbox_sent: () => { const e = new Error("db down"); e.code = null; throw e; } } });
  const ctx = ctxWith(adapter, supa);
  await deliverOne(ctx, outboxRow());
  assert.equal(adapter.calls.send, 1);
  assert.equal(supa.rpcs("outbox_sent").length, 3, "one call plus one retry per configured delay");
  assert.equal(supa.rpcs("outbox_failed").length, 0, "no outbox_failed: the lease expires into a retry");
  assert.ok(ctx.log.events().includes("outbox.sent_report_retry"));
  assert.ok(ctx.log.events().includes("outbox.sent_report_failed"));
  assert.equal(ctx.active.outbox.size, 0, "the row left the active set, so the heartbeat stops renewing its lease");
});

test("a settle that succeeds on the second try is recorded once and not reported failed", async () => {
  let n = 0;
  const supa = fakeSupa({ rpc: { outbox_sent: () => { n += 1; if (n === 1) throw new Error("blip"); return { status: "sent" }; } } });
  const ctx = ctxWith(fakeAdapter(), supa);
  await deliverOne(ctx, outboxRow());
  assert.equal(n, 2);
  assert.ok(ctx.log.events().includes("outbox.sent"));
  assert.ok(!ctx.log.events().includes("outbox.sent_report_failed"));
});

test("a lost lease (55000) on outbox_sent is logged as such and never retried", async () => {
  const supa = fakeSupa({ rpc: { outbox_sent: () => { const e = new Error("not sending for w-test"); e.code = "55000"; throw e; } } });
  const ctx = ctxWith(fakeAdapter(), supa);
  await deliverOne(ctx, outboxRow());
  assert.equal(supa.rpcs("outbox_sent").length, 1);
  assert.ok(ctx.log.events().includes("outbox.lease_lost_after_send"));
});

test("the row is in ctx.active.outbox while the adapter works and gone afterwards, on every path", async () => {
  const row = outboxRow();
  let seenDuring = null;
  const adapter = fakeAdapter({ send: async () => { seenDuring = ctx.active.outbox.has(row.id); return { providerId: "P", providerStatus: "sent" }; } });
  const ctx = ctxWith(adapter);
  await deliverOne(ctx, row);
  assert.equal(seenDuring, true);
  assert.equal(ctx.active.outbox.size, 0);
  const failing = fakeAdapter({ send: async () => { throw new DeliveryError("nope", { permanent: true }); } });
  const ctx2 = ctxWith(failing);
  await deliverOne(ctx2, row);
  assert.equal(ctx2.active.outbox.size, 0);
  const ctx3 = ctxWith(fakeAdapter());
  await deliverOne(ctx3, outboxRow({ channel: "qbo" }));
  assert.equal(ctx3.active.outbox.size, 0);
});

test("a provider error carrying the customer's number is redacted in the log line but kept whole in the database", async () => {
  const msg = "send_failed: To number: +19075551234, is not a mobile number";
  const adapter = fakeAdapter({ send: async () => { throw new DeliveryError(msg, { permanent: true }); } });
  const ctx = ctxWith(adapter);
  await deliverOne(ctx, outboxRow());
  const line = ctx.log.lines.find((l) => l.event === "outbox.failed");
  assert.doesNotMatch(line.error, /9075551234/);
  assert.match(line.error, /\[number\]/);
  assert.equal(ctx.supa.rpcs("outbox_failed")[0].p_error, msg);
});

test("a channel with no adapter is failed as a retry, not dropped", async () => {
  const ctx = ctxWith(fakeAdapter());
  await deliverOne(ctx, outboxRow({ channel: "qbo" }));
  const failed = ctx.supa.rpcs("outbox_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].p_permanent, false);
  assert.match(failed[0].p_error, /no adapter for channel qbo/);
});

test("runOutboxOnce claims with the configured channels, lease and batch, and delivers each row", async () => {
  const rows = [outboxRow({ id: "aaaaaaaa-0000-0000-0000-000000000001" }), outboxRow({ id: "aaaaaaaa-0000-0000-0000-000000000002" })];
  const supa = fakeSupa({ rpc: { outbox_claim: rows } });
  const adapter = fakeAdapter();
  const ctx = ctxWith(adapter, supa);
  assert.equal(await runOutboxOnce(ctx), 2);
  const claim = supa.rpcs("outbox_claim")[0];
  assert.deepEqual(claim, { p_worker_id: "w-test", p_channels: ["sms", "email"], p_lease_seconds: 120, p_limit: 10 });
  assert.equal(adapter.calls.send, 2);
  assert.equal(supa.rpcs("outbox_sent").length, 2);
});

test("runOutboxOnce returns 0 on an empty claim and claims nothing when no channel is enabled", async () => {
  const supa = fakeSupa({ rpc: { outbox_claim: [] } });
  assert.equal(await runOutboxOnce(ctxWith(fakeAdapter(), supa)), 0);
  const ctx = ctxWith(fakeAdapter(), fakeSupa(), testConfig({ channels: [] }));
  assert.equal(await runOutboxOnce(ctx), 0);
  assert.equal(ctx.supa.calls.rpc.length, 0);
});

test("a stop mid-batch leaves the rest leased for the sweeper", async () => {
  const rows = [outboxRow({ id: "aaaaaaaa-0000-0000-0000-000000000001" }), outboxRow({ id: "aaaaaaaa-0000-0000-0000-000000000002" })];
  const supa = fakeSupa({ rpc: { outbox_claim: rows } });
  const adapter = fakeAdapter();
  let stop = false;
  const ctx = { ...ctxWith(adapter, supa), stopping: () => stop };
  adapter.send = async () => { stop = true; adapter.calls.send += 1; return { providerId: "P", providerStatus: "sent" }; };
  await runOutboxOnce(ctx);
  assert.equal(adapter.calls.send, 1);
  assert.equal(supa.rpcs("outbox_sent").length, 1);
  assert.equal(ctx.active.outbox.size, 0, "the unsent tail leaves the active set: the final beat renews nothing and the sweeper retries it");
  assert.ok(ctx.log.events().includes("outbox.batch_cut_short"));
});

test("every claimed row is active from the claim until its own delivery ends, so a heartbeat mid-batch renews the whole batch", async () => {
  const ids = ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000003"];
  const rows = ids.map((id) => outboxRow({ id }));
  const supa = fakeSupa({ rpc: { outbox_claim: rows, worker_heartbeat: { worker_id: "w-test" } } });
  const seen = [];
  const state = { bootIso: "2026-10-05T18:00:00.000Z", lastBeatAt: 0, lastBeatError: null, depth: null };
  const adapter = fakeAdapter({ send: async () => {
    seen.push([...ctx.active.outbox].sort());
    if (seen.length === 1) await beat(ctx, state);   // the 30 s timer firing while row 1 is at the provider
    return { providerId: "P", providerStatus: "sent" };
  } });
  const ctx = ctxWith(adapter, supa);
  await runOutboxOnce(ctx);
  assert.deepEqual(seen[0], ids, "during row 1 the whole batch is in flight");
  assert.deepEqual(seen[1], ids.slice(1), "row 1 left the set when it settled");
  assert.deepEqual(seen[2], ids.slice(2));
  assert.equal(ctx.active.outbox.size, 0);
  assert.deepEqual(supa.rpcs("worker_heartbeat")[0].p_active_outbox.slice().sort(), ids, "the heartbeat named every claimed row, not only the one being sent");
  assert.ok(!ctx.log.events().includes("outbox.batch_cut_short"));
});
