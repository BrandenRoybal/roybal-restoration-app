import { test } from "node:test";
import assert from "node:assert/strict";
import { smsAdapter, classifySmsError, tagFor, DeliveryError } from "../adapters/sms.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, outboxRow } from "./helpers.mjs";

test("roybal-notify refusals are classified: bad input permanent, caps and quiet hours transient", () => {
  const perm = (m, s) => assert.equal(classifySmsError(m, s).permanent, true, m);
  const tran = (m, s) => assert.equal(classifySmsError(m, s).permanent, false, m);
  perm("Provide `to` as a valid US phone number.", 400);
  perm("Provide `body` — the message text.", 400);
  perm("send_failed: The 'To' number +1907 is not a valid phone number.", 400);
  perm("send_failed: To number is not a mobile number", 400);
  perm("send_failed: The message From/To pair violates a blacklist rule.", 400);
  tran("quiet_hours: customer texts send between 7am and 8pm Alaska time — it's 2am there now.", 400);
  tran("sms_cap_reached: 500 of 500 texts this month — raise SMS_MONTHLY_CAP if intended.", 400);
  tran("sms_reserve_reached: 360 of 500 used — the last 150 are held for the phone lane.", 400);
  tran("texting_not_configured: set the TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM function secrets", 400);
  tran("send_failed: could not reach Twilio — the message was not sent", 400);
  tran("", 500);
  tran("Missing Authorization bearer token", 401);
  perm("Unknown action. Expected one of: sendSms", 400);
  assert.ok(classifySmsError("x", 500) instanceof DeliveryError);
});

test("send posts to roybal-notify under the service key, tagged with the outbox id", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([{
    match: (u) => u === cfg.notifyUrl,
    reply: () => ({ body: { ok: true, sid: "SM123", status: "queued", month_count: 12 } }),
  }]);
  const ctx = { cfg, supa: fakeSupa(), log: recordingLog(), fetch };
  const row = outboxRow();
  const out = await smsAdapter(ctx).send(row);
  assert.deepEqual(out, { providerId: "SM123", providerStatus: "queued" });
  assert.equal(fetch.calls.length, 1);
  const { init, body } = fetch.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, cfg.serviceKey);
  assert.equal(init.headers.Authorization, `Bearer ${cfg.serviceKey}`);
  assert.equal(body.action, "sendSms");
  assert.equal(body.to, "+19075550100");
  assert.equal(body.body, "On our way");
  assert.equal(body.kind, "onOurWay");
  assert.equal(body.unified_job_id, row.job_id);
  assert.equal(body.captured_by, tagFor(row));
  assert.equal(body.captured_by, `outbox:${row.id}`);
});

test("a refusal becomes a DeliveryError with roybal-notify's message and verdict", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([{
    match: (u) => u === cfg.notifyUrl,
    reply: () => ({ status: 400, body: { ok: false, error: "quiet_hours: customer texts send between 7am and 8pm Alaska time" } }),
  }]);
  const ctx = { cfg, supa: fakeSupa(), log: recordingLog(), fetch };
  await assert.rejects(smsAdapter(ctx).send(outboxRow()), (e) => {
    assert.ok(e instanceof DeliveryError);
    assert.equal(e.permanent, false);
    assert.match(e.message, /^quiet_hours/);
    return true;
  });
});

test("an unreachable roybal-notify is transient; an empty `to` is permanent before any call", async () => {
  const cfg = testConfig();
  const fetch = async () => { throw new Error("ECONNRESET"); };
  const ctx = { cfg, supa: fakeSupa(), log: recordingLog(), fetch };
  await assert.rejects(smsAdapter(ctx).send(outboxRow()), (e) => e.permanent === false && /unreachable/.test(e.message));
  let called = false;
  const ctx2 = { ...ctx, fetch: async () => { called = true; } };
  await assert.rejects(smsAdapter(ctx2).send(outboxRow({ payload: { to: "", body: "x" } })), (e) => e.permanent === true);
  assert.equal(called, false);
});

test("findPrior adopts the sms_messages row the earlier attempt wrote, and ignores a failed one", async () => {
  const cfg = testConfig();
  const row = outboxRow({ attempts: 2 });
  const supa = fakeSupa({ select: { sms_messages: [{ id: "m1", twilio_sid: "SM999", status: "sent" }] } });
  const prior = await smsAdapter({ cfg, supa, log: recordingLog() }).findPrior(row);
  assert.deepEqual(prior, { providerId: "SM999", providerStatus: "sent" });
  const q = supa.calls.select[0].query;
  assert.match(q, /sent_by=eq\.outbox%3A11111111/);
  assert.match(q, /direction=eq\.outbound/);
  assert.match(q, /status=neq\.failed/);
  const none = await smsAdapter({ cfg, supa: fakeSupa(), log: recordingLog() }).findPrior(row);
  assert.equal(none, null);
});
