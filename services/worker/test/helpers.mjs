/* Test doubles. A recording Supabase client whose behaviour comes from a
   script of handlers, a config like loadConfig() would build, and a log that
   keeps its lines. (This file has no .test. in its name so node --test does
   not run it.) */

export function fakeSupa(script = {}) {
  const calls = { rpc: [], select: [], count: [], insert: [], upsert: [], patch: [] };
  const run = (kind, key, args, dflt) => {
    const h = script[kind]?.[key] ?? script[kind]?.["*"];
    if (typeof h === "function") return h(...args);
    if (h !== undefined) return h;
    return dflt;
  };
  return {
    calls,
    async rpc(fn, args = {}) { calls.rpc.push({ fn, args }); return run("rpc", fn, [args], null); },
    async select(table, query) { calls.select.push({ table, query }); return run("select", table, [query], []); },
    async count(table, query) { calls.count.push({ table, query }); return run("count", table, [query], 0); },
    async insert(table, rows) { calls.insert.push({ table, rows }); return run("insert", table, [rows], rows); },
    async upsert(table, rows, onConflict) { calls.upsert.push({ table, rows, onConflict }); return run("upsert", table, [rows], rows); },
    async patch(table, query, patch) { calls.patch.push({ table, query, patch }); return run("patch", table, [query, patch], []); },
    /** Every rpc call to `fn`, in order. */
    rpcs(fn) { return calls.rpc.filter((c) => c.fn === fn).map((c) => c.args); },
  };
}

export function testConfig(over = {}) {
  return {
    supabaseUrl: "https://stub.supabase.co",
    serviceKey: "sb_secret_test",
    workerId: "w-test",
    version: "test",
    region: "sjc",
    port: 0,
    pollMs: 250,
    heartbeatMs: 5000,
    queueLeaseS: 300,
    outboxLeaseS: 120,
    outboxBatch: 10,
    channels: ["sms", "email"],
    queueKinds: ["proposal.execute"],
    emailEnabled: true,
    gmailClientId: "gid",
    gmailClientSecret: "gsecret",
    ownerCell: "+19075550199",
    notifyUrl: "https://stub.supabase.co/functions/v1/roybal-notify",
    outboxAgentId: "0a7ac824-5042-4bb5-ab0d-8569cea209b1",
    shutdownGraceMs: 2000,
    ...over,
  };
}

export function recordingLog() {
  const lines = [];
  const log = (event, fields = {}) => { lines.push({ event, ...fields }); };
  log.lines = lines;
  log.events = () => lines.map((l) => l.event);
  return log;
}

/** A fetch stub: routes[] of { match(url, init) → bool, reply(url, init) → {status, body} }. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init, body: init.body ? safeJson(init.body) : null });
    for (const r of routes) {
      if (r.match(u, init)) {
        const out = await r.reply(u, init);
        return jsonResponse(out.body, out.status ?? 200, out.headers);
      }
    }
    return jsonResponse({ error: `unrouted ${u}` }, 599);
  };
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...headers } });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

export const outboxRow = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  channel: "sms",
  operation: "sms.send@1",
  payload: { to: "+19075550100", body: "On our way", kind: "onOurWay" },
  status: "sending",
  attempts: 1,
  max_attempts: 6,
  job_id: "22222222-2222-2222-2222-222222222222",
  proposal_id: null,
  principal_kind: "human",
  principal_id: "33333333-3333-3333-3333-333333333333",
  locked_by: "w-test",
  ...over,
});

export const jobRow = (over = {}) => ({
  id: "44444444-4444-4444-4444-444444444444",
  kind: "proposal.execute",
  payload: { proposal_id: "55555555-5555-5555-5555-555555555555" },
  principal_kind: "human",
  principal_id: "33333333-3333-3333-3333-333333333333",
  attempts: 1,
  max_attempts: 5,
  status: "leased",
  locked_by: "w-test",
  ...over,
});
