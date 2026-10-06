import { test } from "node:test";
import assert from "node:assert/strict";
import { emailAdapter, classifyGmailError, staleEmailReason } from "../adapters/email.mjs";
import { deliverOne } from "../lanes/outbox.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, outboxRow } from "./helpers.mjs";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN = "https://oauth2.googleapis.com/token";
const HOUR = 3600_000;
const emailRow = (over = {}) => outboxRow({
  channel: "email", operation: "email.send@1",
  payload: { to: "pm@example.com", subject: "Estimate", body: "Hello", cc: "cc@example.com" },
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});
const freshToken = { id: "t1", account: "info@roybalconstruction.com", access_token: "at-1", refresh_token: "rt-1",
  expires_at: new Date(Date.now() + 3600_000).toISOString() };

test("send uses the stored token when fresh, posts the raw message, and writes the adopt record", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([{ match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-1", threadId: "th-1" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [{ id: "c-1" }] } });
  const log = recordingLog();
  const row = emailRow();
  const out = await emailAdapter({ cfg, supa, log, fetch }).send(row);
  assert.deepEqual(out, { providerId: "gm-1", providerStatus: "sent" });
  assert.equal(fetch.calls.length, 1, "no token refresh");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer at-1");
  const raw = Buffer.from(fetch.calls[0].body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.match(raw, /^From: info@roybalconstruction\.com\r\nTo: pm@example\.com\r\nCc: cc@example\.com\r\nSubject: Estimate/);
  const rec = supa.calls.insert.find((c) => c.table === "email_messages");
  assert.ok(rec, "email_messages row written");
  assert.equal(rec.rows[0].sent_by, `outbox:${row.id}`);
  assert.equal(rec.rows[0].direction, "out");
  assert.equal(rec.rows[0].gmail_id, "gm-1");
  assert.equal(rec.rows[0].thread_id, "th-1");
  assert.equal(rec.rows[0].contact_id, "c-1");
  assert.equal(rec.rows[0].read_by_office, true);
  assert.equal(rec.rows[0].matched_by, "sent");
  assert.equal(rec.rows[0].job_id, row.job_id, "filed under the outbox row's job, as gmail-proxy files its sends");
});

test("the sent record carries the job id as text, and null when the row has no job", async () => {
  const send = async (over) => {
    const fetch = fakeFetch([{ match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-j", threadId: "th-j" } }) }]);
    const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [] } });
    await emailAdapter({ cfg: testConfig(), supa, log: recordingLog(), fetch }).send(emailRow(over));
    return supa.calls.insert.find((c) => c.table === "email_messages").rows[0].job_id;
  };
  assert.equal(await send({ job_id: "9a1b7c3e-0000-4000-8000-00000000abcd" }), "9a1b7c3e-0000-4000-8000-00000000abcd");
  assert.equal(await send({ job_id: null }), null);
  assert.equal(await send({ job_id: undefined }), null);
});

test("an expiring token is refreshed with the Fly-held client secret and written back", async () => {
  const cfg = testConfig();
  const stale = { ...freshToken, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const fetch = fakeFetch([
    { match: (u) => u === TOKEN, reply: () => ({ body: { access_token: "at-2", expires_in: 3599 } }) },
    { match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-2", threadId: "th-2" } }) },
  ]);
  const supa = fakeSupa({ select: { gmail_tokens: [stale], contacts: [] } });
  await emailAdapter({ cfg, supa, log: recordingLog(), fetch }).send(emailRow());
  const refresh = fetch.calls.find((c) => c.url === TOKEN);
  const params = new URLSearchParams(refresh.init.body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "rt-1");
  assert.equal(params.get("client_id"), "gid");
  assert.equal(params.get("client_secret"), "gsecret");
  const send = fetch.calls.find((c) => c.url === GMAIL);
  assert.equal(send.init.headers.Authorization, "Bearer at-2");
  const wb = supa.calls.patch.find((c) => c.table === "gmail_tokens");
  assert.ok(wb && wb.query === "id=eq.t1");
  assert.equal(wb.patch.access_token, "at-2");
});

test("no connected account, a bad address, and Gmail's verdicts are classified", async () => {
  const cfg = testConfig();
  const ctx = { cfg, supa: fakeSupa({ select: { gmail_tokens: [] } }), log: recordingLog(), fetch: fakeFetch([]) };
  await assert.rejects(emailAdapter(ctx).send(emailRow()), (e) => e.permanent === false && /not connected/.test(e.message));

  const ctx2 = { ...ctx, supa: fakeSupa({ select: { gmail_tokens: [freshToken] } }) };
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "nope", subject: "x", body: "y" } })), (e) => e.permanent === true);
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "a@b.co", subject: "x", body: "" } })), (e) => e.permanent === true);
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "a@b.co", subject: "", body: "y" } })), (e) => e.permanent === true);
  assert.equal(ctx.fetch.calls.length, 0, "nothing sent for a row that can never send");

  assert.equal(classifyGmailError(400, '{"error":{"message":"Invalid to header"}}').permanent, true);
  assert.equal(classifyGmailError(400, '{"error":{"message":"Recipient address required"}}').permanent, true);
  assert.equal(classifyGmailError(401, "unauthorized").permanent, false);
  assert.equal(classifyGmailError(429, "rate").permanent, false);
  assert.equal(classifyGmailError(503, "backend").permanent, false);
});

test("findPrior adopts the email_messages row tagged with the outbox id", async () => {
  const cfg = testConfig();
  const row = emailRow({ attempts: 2 });
  const supa = fakeSupa({ select: { email_messages: [{ id: "e1", gmail_id: "gm-9", thread_id: "th-9" }] } });
  const prior = await emailAdapter({ cfg, supa, log: recordingLog() }).findPrior(row);
  assert.deepEqual(prior, { providerId: "gm-9", providerStatus: "sent" });
  assert.match(supa.calls.select[0].query, /direction=eq\.out&sent_by=eq\.outbox%3A/);
  assert.equal(await emailAdapter({ cfg, supa: fakeSupa(), log: recordingLog() }).findPrior(row), null);
});

test("an email older than EMAIL_MAX_AGE_HOURS is refused as permanent before any Google call, naming its age", async () => {
  const fetch = fakeFetch([{ match: () => true, reply: () => ({ body: { id: "gm-late" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [] } });
  const adapter = emailAdapter({ cfg: testConfig({ emailMaxAgeHours: 48 }), supa, log: recordingLog(), fetch });

  await assert.rejects(adapter.send(emailRow({ created_at: new Date(Date.now() - 50 * HOUR).toISOString() })), (e) => {
    assert.equal(e.permanent, true);
    assert.match(e.message, /waited 50 hours/);
    assert.match(e.message, /48-hour limit \(EMAIL_MAX_AGE_HOURS\)/);
    assert.match(e.message, /not sent/);
    return true;
  });
  await assert.rejects(adapter.send(emailRow({ created_at: new Date(Date.now() - 5 * 24 * HOUR).toISOString() })),
    (e) => e.permanent === true && /waited 5 days/.test(e.message));
  await assert.rejects(adapter.send(emailRow({ created_at: null })),
    (e) => e.permanent === true && /age can't be checked; it was not sent/.test(e.message));
  assert.equal(fetch.calls.length, 0, "no token refresh and no Gmail send for a stale row");
  assert.equal(supa.calls.select.filter((c) => c.table === "gmail_tokens").length, 0, "the token is not even read");

  // Inside the limit it sends; the limit follows the config.
  await adapter.send(emailRow({ created_at: new Date(Date.now() - 47 * HOUR).toISOString() }));
  assert.equal(fetch.calls.filter((c) => c.url === GMAIL).length, 1);
  const tight = emailAdapter({ cfg: testConfig({ emailMaxAgeHours: 2 }), supa, log: recordingLog(), fetch });
  await assert.rejects(tight.send(emailRow({ created_at: new Date(Date.now() - 3 * HOUR).toISOString() })),
    (e) => e.permanent === true && /waited 3 hours in line, past the 2-hour limit/.test(e.message));
  // A config built without the field (an older caller) still gets the 48-hour default, never no limit.
  const bare = testConfig();
  delete bare.emailMaxAgeHours;
  await assert.rejects(emailAdapter({ cfg: bare, supa, log: recordingLog(), fetch })
    .send(emailRow({ created_at: new Date(Date.now() - 49 * HOUR).toISOString() })), (e) => e.permanent === true);

  assert.equal(staleEmailReason({ created_at: "2026-10-01T00:00:00Z" }, 48, Date.parse("2026-10-03T00:00:00Z")), null, "exactly at the limit still sends");
  assert.match(staleEmailReason({ created_at: "2026-10-01T00:00:00Z" }, 1, Date.parse("2026-10-01T01:30:00Z")), /waited 1 hour in line/);
});

test("through the lane: a stale email goes dead with the reason, but an old one an earlier attempt sent is adopted", async () => {
  const cfg = testConfig({ emailMaxAgeHours: 48 });
  const old = new Date(Date.now() - 72 * HOUR).toISOString();

  const fetch = fakeFetch([{ match: () => true, reply: () => ({ body: { id: "gm-late" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], email_messages: [] } });
  const ctx = { cfg, supa, log: recordingLog(), fetch, active: { outbox: new Set() } };
  ctx.adapters = { email: emailAdapter(ctx) };
  await deliverOne(ctx, emailRow({ created_at: old }));
  const [failed] = supa.rpcs("outbox_failed");
  assert.equal(failed.p_permanent, true);
  assert.match(failed.p_error, /waited 3 days in line, past the 48-hour limit/);
  assert.equal(supa.rpcs("outbox_sent").length, 0);
  assert.equal(fetch.calls.length, 0, "nothing reached Google");
  assert.equal(supa.calls.insert.filter((c) => c.table === "email_messages").length, 0);

  const supa2 = fakeSupa({ select: { email_messages: [{ id: "e1", gmail_id: "gm-early", thread_id: "th" }] } });
  const ctx2 = { cfg, supa: supa2, log: recordingLog(), fetch, active: { outbox: new Set() } };
  ctx2.adapters = { email: emailAdapter(ctx2) };
  await deliverOne(ctx2, emailRow({ created_at: old, attempts: 2 }));
  assert.equal(supa2.rpcs("outbox_failed").length, 0, "an old row that did go out is not refused");
  const [sent] = supa2.rpcs("outbox_sent");
  assert.equal(sent.p_adopted, true);
  assert.equal(sent.p_provider_id, "gm-early");
});
