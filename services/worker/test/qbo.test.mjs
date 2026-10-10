import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qboAdapter, classifyQboError } from "../adapters/qbo.mjs";
import { DeliveryError } from "../adapters/sms.mjs";
import { deliverOne } from "../lanes/outbox.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, outboxRow } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = fs.readFileSync(path.join(REPO, "supabase/migrations/0023_receipts_qbo_link.sql"), "utf8");
const MIGRATION_V2 = fs.readFileSync(path.join(REPO, "supabase/migrations/0025_receipts_qbo_bills_parts.sql"), "utf8");

/* An outbox 'qbo' row as op_exec_receipts_qbo_link writes it (0023): Purchase
   10577, Home Depot, tag to Pollen Apartments and attach the receipt photo. */
const qboRow = (over = {}) => outboxRow({
  channel: "qbo",
  operation: "receipts.qbo_link@1",
  payload: {
    receipt_id: "4f1c2a9e-0d3b-4c55-9e1a-7b2f3c4d5e6f", job_id: "a628eea5-0000-4000-8000-000000000001",
    proposal_id: "66666666-6666-4666-8666-666666666666", qbo_txn_type: "Purchase", qbo_txn_id: "10577",
    expect_sync_token: "0", expect_total: 1369.5, changes: ["tag", "attach"], customer_id: "112", project_ref: "412739523",
    photo_refs: [`media:${"ab".repeat(32)}:183211`], file_base: "The Home Depot #1303 2026-09-30 1303-00001-50615",
  },
  proposal_id: "66666666-6666-4666-8666-666666666666",
  ...over,
});
const done = (over = {}) => ({ body: { ok: true, purchaseId: "10577", syncToken: "1", tagged: "done", attached: 1,
  already_attached: false, adopted: { create: false, tag: false, attach: 0 }, data: {}, ...over } });

function setup(reply) {
  const cfg = testConfig({ channels: ["sms", "email", "qbo"] });
  const fetch = fakeFetch([{ match: (u) => u === cfg.qboProxyUrl, reply }]);
  const ctx = { cfg, supa: fakeSupa({ rpc: { outbox_sent: { ok: true }, outbox_failed: { ok: true } } }), log: recordingLog(), fetch,
    settleRetryMs: [1], active: { jobs: new Set(), outbox: new Set() } };
  return { ctx, fetch, adapter: qboAdapter(ctx) };
}

test("send posts the row's payload to qbo-proxy completePurchase under the service key", async () => {
  const { ctx, fetch, adapter } = setup(() => done());
  assert.equal(adapter.channel, "qbo");
  assert.equal(adapter.connection, "qbo");
  const row = qboRow();
  const out = await adapter.send(row);
  assert.deepEqual(out, { providerId: "Purchase:10577:1", providerStatus: "tagged=done;attached=1", costUsd: 0 });
  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "https://stub.supabase.co/functions/v1/qbo-proxy");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, ctx.cfg.serviceKey);
  assert.equal(init.headers.Authorization, `Bearer ${ctx.cfg.serviceKey}`);
  assert.ok(init.signal, "a hung call cannot hold the outbox lane");
  assert.deepEqual(body, { ...row.payload, action: "completePurchase" });
});

test("the provider id is exactly what the 0023 trigger reads back into the receipt's link row", async () => {
  const pattern = /regexp_match\(coalesce\(new\.provider_id, ''\), '(\^Purchase:[^']+)'\)/.exec(MIGRATION);
  assert.ok(pattern, "outbox_qbo_link_result parses provider_id with a ^Purchase:… pattern");
  assert.equal(pattern[1], "^Purchase:([0-9]{1,20}):([0-9]{1,20})$");
  const re = new RegExp(pattern[1]);
  for (const reply of [done(), done({ purchaseId: 12345678901, syncToken: 0, tagged: "adopted", attached: 0, already_attached: true })]) {
    const { adapter } = setup(() => reply);
    const out = await adapter.send(qboRow());
    assert.match(out.providerId, re);
  }
  const { adapter } = setup(() => done({ purchaseId: 12345678901, syncToken: 0, tagged: "not_needed", attached: 0, already_attached: true }));
  assert.deepEqual(await adapter.send(qboRow()),
    { providerId: "Purchase:12345678901:0", providerStatus: "tagged=not_needed;attached=0;already_attached=true", costUsd: 0 });
});

test("a photo QuickBooks refused after the write is sent with attach_error=<code> in its status, not retried or killed", async () => {
  const { adapter } = setup(() => done({ purchaseId: 10700, syncToken: 0, tagged: "done", attached: 0,
    attach_error: { code: "qbo_refused", message: "QuickBooks refused the upload (400)" } }));
  assert.deepEqual(await adapter.send(qboRow()),
    { providerId: "Purchase:10700:0", providerStatus: "tagged=done;attached=0;attach_error=qbo_refused", costUsd: 0 });
  const odd = setup(() => done({ attach_error: { code: "BAD;CODE=1" } }));
  assert.match((await odd.adapter.send(qboRow())).providerStatus, /;attach_error=unknown$/);
});

test("findPrior adopts nothing: completePurchase finishes its own earlier work, so a retry is the adopt", async () => {
  const { fetch, adapter } = setup(() => done());
  assert.equal(await adapter.findPrior(qboRow()), null);
  assert.equal(fetch.calls.length, 0);
});

test("a permanent refusal (HTTP 409 or permanent: true) is permanent, with qbo-proxy's words; anything else is retried", async () => {
  const cases = [
    [409, { ok: false, error: "tagged_other: Purchase 10577 is tagged to 264 Cindy dr.", code: "tagged_other", permanent: true }, true],
    [409, { ok: false, error: "changed_in_qbo: the expense changed since the card was filed" }, true],
    [400, { ok: false, error: "bad_request: receipt_id", code: "bad_request", permanent: true }, true],
    [503, { ok: false, error: "qbo_throttled: QuickBooks asked us to slow down", code: "qbo_throttled", permanent: false }, false],
    [502, { ok: false, error: "stale_object: SyncToken moved twice", code: "stale_object", permanent: false }, false],
    [401, { ok: false, error: "completePurchase is server-only" }, false],
    [500, "<html>gateway</html>", false],
    [200, { ok: false, error: "QuickBooks not connected" }, false],
  ];
  for (const [status, body, permanent] of cases) {
    const { adapter } = setup(() => ({ status, body }));
    await assert.rejects(adapter.send(qboRow()), (e) => {
      assert.ok(e instanceof DeliveryError);
      assert.equal(e.permanent, permanent, `${status} ${JSON.stringify(body)}`);
      assert.equal(e.status, status);
      if (typeof body === "object") assert.equal(e.message, body.error);
      else assert.equal(e.message, `qbo-proxy answered ${status}`);
      return true;
    });
  }
  assert.equal(classifyQboError(undefined, null).message, "qbo-proxy answered nothing");
  assert.equal(classifyQboError(409, { error: "x".repeat(3000) }).message.length, 2000);
});

test("an unreachable qbo-proxy, or an ok without the expense id and SyncToken, is retried; a row with no payload is dead", async () => {
  let r = setup(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(r.adapter.send(qboRow()), (e) => e instanceof DeliveryError && e.permanent === false && /unreachable/.test(e.message));
  for (const body of [{ ok: true }, { ok: true, purchaseId: "10577" }, { ok: true, purchaseId: "P-1", syncToken: "1" }, { ok: true, purchaseId: "10577", syncToken: "" }]) {
    r = setup(() => ({ body }));
    await assert.rejects(r.adapter.send(qboRow()), (e) => e instanceof DeliveryError && e.permanent === false && /SyncToken/.test(e.message),
      JSON.stringify(body));
  }
  for (const payload of [null, "tag it", [1]]) {
    r = setup(() => done());
    await assert.rejects(r.adapter.send(qboRow({ payload })), (e) => e instanceof DeliveryError && e.permanent === true);
    assert.equal(r.fetch.calls.length, 0);
  }
});

test("through the outbox lane: a delivered row is recorded sent with the provider id; a 409 goes dead with the code first", async () => {
  let s = setup(() => done());
  s.ctx.adapters = { qbo: s.adapter };
  await deliverOne(s.ctx, qboRow());
  const sent = s.ctx.supa.rpcs("outbox_sent")[0];
  assert.equal(sent.p_provider_id, "Purchase:10577:1");
  assert.equal(sent.p_provider_status, "tagged=done;attached=1");
  assert.equal(sent.p_cost_usd, 0);
  assert.equal(sent.p_adopted, false);

  s = setup(() => ({ status: 409, body: { ok: false, error: "photo_missing: the receipt photo is not in field-media", permanent: true } }));
  s.ctx.adapters = { qbo: s.adapter };
  await deliverOne(s.ctx, qboRow());
  const failed = s.ctx.supa.rpcs("outbox_failed")[0];
  assert.equal(failed.p_permanent, true);
  assert.match(failed.p_error, /^photo_missing: /);
});

/* ---- 0025: a receipt paid in two or three card charges ---- */

/* The outbox row 0025's executor writes for the Rental Zone receipt: the
   top level names no charge, each part names one. */
const partsRow = (over = {}) => qboRow({
  payload: {
    ...qboRow().payload, receipt_id: "995d2795-0000-4000-8000-000000000001", job_id: "0b32c79a-0000-4000-8000-000000000002",
    qbo_txn_id: "", expect_sync_token: "", expect_total: null, customer_id: "502", project_ref: "807760362",
    file_base: "The Rental Zone 2026-10-07 R284290",
    parts: [{ qbo_txn_id: "10615", expect_sync_token: "0", expect_total: 126.9, changes: ["tag", "attach"] },
      { qbo_txn_id: "10661", expect_sync_token: "0", expect_total: 224.1, changes: ["tag", "attach"] }],
  },
  ...over,
});
const partsDone = (over = {}) => done({ purchaseId: "10615", syncToken: "1", attached: 2,
  parts: [{ purchaseId: "10615", syncToken: "1", tagged: "done", attached: 1, already_attached: false },
    { purchaseId: "10661", syncToken: "1", tagged: "done", attached: 1, already_attached: false }], ...over });

test("a receipt in parts: the provider id is the first charge's Purchase id, and the status lists every charge's new SyncToken as 0025's trigger reads it", async () => {
  const { fetch, adapter } = setup(() => partsDone());
  const out = await adapter.send(partsRow());
  assert.deepEqual(out, { providerId: "Purchase:10615:1", providerStatus: "tagged=done;attached=2;parts=10615:1,10661:1", costUsd: 0 });
  assert.deepEqual(fetch.calls[0].body, { ...partsRow().payload, action: "completePurchase" });
  // the 0025 trigger: the provider id still Purchase:<id>:<token>, the charges from provider_status parts=
  const idPattern = /v_m\s+text\[\] := regexp_match\(coalesce\(new\.provider_id, ''\), '(\^Purchase:[^']+)'\)/.exec(MIGRATION_V2);
  assert.ok(idPattern, "outbox_qbo_link_result parses provider_id with a ^Purchase:… pattern");
  assert.match(out.providerId, new RegExp(idPattern[1]));
  const partsPattern = /regexp_match\(coalesce\(new\.provider_status, ''\), '([^']+)'\)/.exec(MIGRATION_V2);
  assert.ok(partsPattern, "outbox_qbo_link_result reads parts= from provider_status");
  assert.deepEqual(new RegExp(partsPattern[1]).exec(out.providerStatus)?.[1], "10615:1,10661:1");
  // with an attach_error and a part_error beside it, the trigger still finds the charges
  const both = setup(() => partsDone({ attach_error: { code: "qbo_refused", message: "part 2 of 2: refused" },
    part_error: { code: "changed_in_qbo", message: "part 2 of 2 (expense 10661): changed" } }));
  const status = (await both.adapter.send(partsRow())).providerStatus;
  assert.equal(status, "tagged=done;attached=2;parts=10615:1,10661:1;attach_error=qbo_refused;part_error=changed_in_qbo");
  assert.equal(new RegExp(partsPattern[1]).exec(status)?.[1], "10615:1,10661:1");
  // three charges
  const three = setup(() => partsDone({ parts: [{ purchaseId: "1", syncToken: "0" }, { purchaseId: "2", syncToken: "5" }, { purchaseId: "3", syncToken: "12" }],
    purchaseId: "1", syncToken: "0" }));
  const threeRow = partsRow();
  threeRow.payload.parts = [1, 2, 3].map((n) => ({ qbo_txn_id: String(n), expect_sync_token: "0", expect_total: 117, changes: ["tag"] }));
  assert.deepEqual(await three.adapter.send(threeRow),
    { providerId: "Purchase:1:0", providerStatus: "tagged=done;attached=2;parts=1:0,2:5,3:12", costUsd: 0 });
});

test("a later charge QuickBooks refused after an earlier one was written is sent with part_error=<code>, not retried or killed", async () => {
  const { adapter } = setup(() => partsDone({ parts: [{ purchaseId: "10615", syncToken: "1", tagged: "done", attached: 1 },
    { purchaseId: "10661", syncToken: "0", tagged: "refused", attached: 0, error: { code: "tagged_other", message: "tagged to 264 Cindy dr." } }],
  attached: 1, part_error: { code: "tagged_other", message: "part 2 of 2 (expense 10661): tagged to 264 Cindy dr." } }));
  assert.deepEqual(await adapter.send(partsRow()),
    { providerId: "Purchase:10615:1", providerStatus: "tagged=done;attached=1;parts=10615:1,10661:0;part_error=tagged_other", costUsd: 0 });
  const odd = setup(() => partsDone({ part_error: { code: "BAD;CODE=1" } }));
  assert.match((await odd.adapter.send(partsRow())).providerStatus, /;part_error=unknown$/);
  // part_error with no parts asked for is reported the same way (qbo-proxy only sends it for parts)
  const single = setup(() => done({ part_error: { code: "qbo_refused" } }));
  assert.equal((await single.adapter.send(qboRow())).providerStatus, "tagged=done;attached=1;part_error=qbo_refused");
});

test("an ok for a receipt in parts without every charge's id and SyncToken is retried, never recorded half", async () => {
  for (const parts of [undefined, [], [{ purchaseId: "10615", syncToken: "1" }], [{ purchaseId: "10615", syncToken: "1" }, { purchaseId: "10661" }],
    [{ purchaseId: "10615", syncToken: "1" }, { purchaseId: "P-1", syncToken: "1" }]]) {
    const { adapter } = setup(() => partsDone({ parts }));
    await assert.rejects(adapter.send(partsRow()), (e) => e instanceof DeliveryError && e.permanent === false && /each charge/.test(e.message),
      JSON.stringify(parts));
  }
  // one charge (no parts asked): qbo-proxy's parts are not read
  const { adapter } = setup(() => done({ parts: "ignored" }));
  assert.equal((await adapter.send(qboRow())).providerStatus, "tagged=done;attached=1");
});
