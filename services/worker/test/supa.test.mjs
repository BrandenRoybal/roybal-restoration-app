import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSupa, parseCount, SupaError } from "../supa.mjs";
import { fakeFetch } from "./helpers.mjs";
import { loadConfig } from "../config.mjs";

test("parseCount reads PostgREST's Content-Range", () => {
  assert.equal(parseCount("0-9/123"), 123);
  assert.equal(parseCount("*/0"), 0);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount("0-9/*"), null);
});

test("every verb carries the service key twice and surfaces PostgREST errors with their code", async () => {
  const fetch = fakeFetch([
    { match: (u) => u.endsWith("/rest/v1/rpc/finish_job"), reply: () => ({ status: 400, body: { code: "55000", message: "finish_job: job x is done (held by nobody), not leased by w", details: null } }) },
    { match: (u) => u.includes("/rest/v1/outbox?select=id&limit=1&status=eq.dead"), reply: () => ({ body: [], headers: { "Content-Range": "0-0/4" } }) },
    { match: (u) => u.includes("/rest/v1/app_settings?on_conflict=key"), reply: (_u, init) => ({ body: JSON.parse(init.body) }) },
    { match: (u) => u.includes("/rest/v1/gmail_tokens?id=eq.t1"), reply: () => ({ body: [{ id: "t1" }] }) },
    { match: (u) => u.endsWith("/rest/v1/rpc/sweep_leases"), reply: () => ({ body: 3 }) },
  ]);
  const supa = makeSupa({ supabaseUrl: "https://x.supabase.co", serviceKey: "sb_secret_k", fetchImpl: fetch });

  await assert.rejects(supa.rpc("finish_job", { p_job_id: "x" }), (e) => {
    assert.ok(e instanceof SupaError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "55000");
    assert.match(e.message, /not leased by w/);
    return true;
  });
  assert.equal(await supa.count("outbox", "status=eq.dead"), 4);
  assert.equal(await supa.rpc("sweep_leases"), 3);
  const up = await supa.upsert("app_settings", [{ key: "k", value: {} }], "key");
  assert.equal(up[0].key, "k");
  assert.equal((await supa.patch("gmail_tokens", "id=eq.t1", { access_token: "a" }))[0].id, "t1");

  for (const c of fetch.calls) {
    assert.equal(c.init.headers.apikey, "sb_secret_k");
    assert.equal(c.init.headers.Authorization, "Bearer sb_secret_k");
  }
  const upsertCall = fetch.calls.find((c) => c.url.includes("app_settings"));
  assert.match(upsertCall.init.headers.Prefer, /resolution=merge-duplicates/);
  const countCall = fetch.calls.find((c) => c.url.includes("/outbox?"));
  assert.equal(countCall.init.headers.Prefer, "count=exact");
});

test("loadConfig requires the url and key, clamps numbers, and turns email off without both Gmail secrets", () => {
  assert.throws(() => loadConfig({}), /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => loadConfig({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k" }), /SUPABASE_URL/);
  const base = { SUPABASE_URL: "https://ref.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" };
  const c = loadConfig({ ...base, WORKER_POLL_MS: "10", WORKER_HEARTBEAT_MS: "9999999", FLY_APP_NAME: "roybal-worker", FLY_MACHINE_ID: "abc" });
  assert.equal(c.supabaseUrl, "https://ref.supabase.co");
  assert.equal(c.pollMs, 250);
  assert.equal(c.heartbeatMs, 120_000);
  assert.equal(c.workerId, "roybal-worker-abc");
  assert.equal(c.emailEnabled, false);
  assert.deepEqual(c.channels, ["sms"]);
  assert.equal(c.notifyUrl, "https://ref.supabase.co/functions/v1/roybal-notify");
  assert.equal(c.outboxAgentId, "0a7ac824-5042-4bb5-ab0d-8569cea209b1");
  const e = loadConfig({ ...base, GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "s" });
  assert.equal(e.emailEnabled, true);
  assert.deepEqual(e.channels, ["sms", "email"]);
  const half = loadConfig({ ...base, GMAIL_CLIENT_ID: "id" });
  assert.equal(half.emailEnabled, false);
});

test("loadConfig refuses the wrong Supabase key and pasted placeholders at boot, naming the variable but never the value", () => {
  const base = { SUPABASE_URL: "https://ref.supabase.co" };
  const refuses = (env, re) => {
    let err;
    try { loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k", ...env }); } catch (e) { err = e; }
    assert.ok(err, `expected a refusal for ${JSON.stringify(Object.keys(env))}`);
    assert.match(err.message, re);
    for (const v of Object.values(env)) if (v.length > 6) assert.ok(!err.message.includes(v), "the value must not be echoed");
    return err;
  };
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.x.y" }, /legacy JWT/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123def456" }, /publishable key/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "<sb_secret_… key>" }, /SUPABASE_SERVICE_ROLE_KEY looks like a placeholder/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_PASTE_HERE" }, /SUPABASE_SERVICE_ROLE_KEY looks like a placeholder/);
  refuses({ GMAIL_CLIENT_ID: "<same as the gmail-proxy secret>" }, /GMAIL_CLIENT_ID looks like a placeholder/);
  refuses({ GMAIL_CLIENT_SECRET: "<its client secret>" }, /GMAIL_CLIENT_SECRET looks like a placeholder/);
  refuses({ OWNER_CELL: "<+19075550199>" }, /OWNER_CELL looks like a placeholder/);
  refuses({ OWNER_CELL: "907-555-019" }, /OWNER_CELL is not a US phone number/);
  refuses({ OWNER_CELL: "+44 20 7946 0958" }, /OWNER_CELL is not a US phone number/);

  // Real shapes pass; the cell is normalized the way roybal-notify's toE164 does it.
  const ok = (cell) => loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: " sb_secret_k\n", OWNER_CELL: cell });
  assert.equal(ok("9075550199").ownerCell, "+19075550199");
  assert.equal(ok("(907) 555-0199").ownerCell, "+19075550199");
  assert.equal(ok("+1 907 555 0199").ownerCell, "+19075550199");
  assert.equal(ok("").ownerCell, "");
  assert.equal(ok("9075550199").serviceKey, "sb_secret_k");
  const g = loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k",
    GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com", GMAIL_CLIENT_SECRET: "GOCSPX-abc_DEF-123" });
  assert.equal(g.emailEnabled, true);
});
