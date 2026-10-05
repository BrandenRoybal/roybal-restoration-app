import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverOne, runOutboxOnce } from "../lanes/outbox.mjs";
import { DeliveryError } from "../adapters/sms.mjs";
import { fakeSupa, testConfig, recordingLog, outboxRow } from "./helpers.mjs";

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
  ({ cfg, supa, log: recordingLog(), adapters: { sms: adapter }, stopping: () => false });

test("first attempt: send, then outbox_sent as agent:outbox, plus an integration run", async () => {
  const adapter = fakeAdapter();
  const ctx = ctxWith(adapter);
  const row = outboxRow({ attempts: 1 });
  await deliverOne(ctx, row);
  assert.equal(adapter.calls.findPrior, 0, "no adopt lookup on a first attempt");
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

test("outbox_sent failing after a real send is NOT reported as a failure (the retry adopts)", async () => {
  const adapter = fakeAdapter();
  const supa = fakeSupa({ rpc: { outbox_sent: () => { const e = new Error("db down"); e.code = null; throw e; } } });
  const ctx = ctxWith(adapter, supa);
  await deliverOne(ctx, outboxRow());
  assert.equal(adapter.calls.send, 1);
  assert.equal(supa.rpcs("outbox_failed").length, 0, "no outbox_failed: the lease expires into a retry");
  assert.ok(ctx.log.events().includes("outbox.sent_report_failed"));
});

test("a lost lease (55000) on outbox_sent is logged as such", async () => {
  const supa = fakeSupa({ rpc: { outbox_sent: () => { const e = new Error("not sending for w-test"); e.code = "55000"; throw e; } } });
  const ctx = ctxWith(fakeAdapter(), supa);
  await deliverOne(ctx, outboxRow());
  assert.ok(ctx.log.events().includes("outbox.lease_lost_after_send"));
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
});
