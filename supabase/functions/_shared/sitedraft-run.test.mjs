/* Site Visit direct run — the runner (sitedraft-run.ts), with fetch stubbed:
   the Messages stream, the batch fallback and the one outcome write.
   Run: node --experimental-strip-types sitedraft-run.test.mjs */
import assert from "node:assert/strict";
import { DraftRun, draftKeyOf } from "./sitedraft-run.ts";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };

const KEY = "0123456789abcdef0123456789abcdef";
const RESULT_URL = `/object/upload/sign/field-media/sitevisit/drafts/${KEY}.json?token=up.tok-1`;
const PARAMS = { model: "claude-fable-5-1", max_tokens: 64000, messages: [{ role: "user", content: [{ type: "text", text: "packet" }] }] };
const JOB = { v: 1, issuedAt: 0, customId: "sv-x-1", params: PARAMS, resultUrl: RESULT_URL };

const enc = new TextEncoder();
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const draft = JSON.stringify({ lossSummary: "x", items: [{ desc: "Remove drywall", qty: 1, unit: "SF" }] });
const GOOD = [
  sse({ type: "message_start", message: { model: "claude-fable-5-1", usage: { input_tokens: 1000, output_tokens: 1 } } }),
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: draft } }),
  sse({ type: "content_block_stop", index: 0 }),
  sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } }),
  sse({ type: "message_stop" }),
];

/** A stubbed world: `mode` decides what the Messages call does. */
function world(mode, { batchFails = false, writeFails = false, writeAnswers = [] } = {}) {
  const w = { calls: [], writes: [], batches: [], logs: [] };
  w.fetch = async (input, init = {}) => {
    const url = String(input);
    w.calls.push({ url, init });
    if (url === "https://api.anthropic.com/v1/messages") {
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "529") return new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 });
      if (mode === "400") return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', { status: 400 });
      const events = mode === "midError" ? [GOOD[0], sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]
        : mode === "noStop" ? GOOD.slice(0, 4) : mode === "hang" ? [GOOD[0], GOOD[1], GOOD[2].slice(0, 50)] : GOOD;
      const signal = init.signal;
      return new Response(new ReadableStream({
        start(c) {
          for (const e of events) for (let i = 0; i < e.length; i += 17) c.enqueue(enc.encode(e.slice(i, i + 17)));
          // hang: no more bytes; linger: message_stop sent but the connection stays open
          if (mode === "hang" || mode === "linger") {
            signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
            return;
          }
          c.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url === "https://api.anthropic.com/v1/messages/batches") {
      w.batches.push(JSON.parse(init.body));
      if (batchFails) return new Response('{"type":"error","error":{"type":"api_error"}}', { status: 500 });
      return new Response(JSON.stringify({ id: "msgbatch_test" + w.batches.length }), { status: 200 });
    }
    if (url === `https://proj.supabase.co/storage/v1${RESULT_URL}`) {
      assert.equal(init.method, "PUT");
      const sealed = JSON.parse(init.body);
      w.writes.push({ body: JSON.parse(sealed.body), sealed, headers: init.headers });
      const a = writeAnswers.shift();
      if (a) return new Response(a.body, { status: a.status });
      return writeFails ? new Response('{"statusCode":"500","error":"internal"}', { status: 500 }) : new Response('{"Key":"x"}', { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  w.env = { apiKey: "sk-test", supabaseUrl: "https://proj.supabase.co", anonKey: "anon", fetch: w.fetch, log: (l) => w.logs.push(l), writeBackoffMs: 1 };
  w.run = () => new DraftRun(JOB, w.env);
  return w;
}

await test("the job's key is read off its result upload", () => {
  assert.equal(draftKeyOf(JOB), KEY);
});

await test("a clean stream writes the finished message once, and queues nothing", async () => {
  const w = world("ok");
  await w.run().run(60_000);
  assert.equal(w.writes.length, 1);
  const out = w.writes[0].body;
  assert.equal(out.type, "message");
  assert.equal(out.customId, "sv-x-1");
  assert.deepEqual(out.message.content, [{ type: "text", text: draft }]);
  assert.equal(w.batches.length, 0);
  const sent = JSON.parse(w.calls[0].init.body);
  assert.equal(sent.stream, true);
  assert.deepEqual({ ...sent, stream: undefined }, { ...PARAMS, stream: undefined }, "the params go out as built");
  assert.equal(w.logs.at(-1).outcome, "message");
});

await test("the outcome is sealed for its own draft, so a login can't forge one", async () => {
  const { openOutcome } = await import("./sitedraft.ts");
  const w = world("ok");
  await w.run().run(60_000);
  const sealed = w.writes[0].sealed;
  assert.equal(sealed.v, 2);
  assert.equal((await openOutcome("sk-test", KEY, sealed)).type, "message");
  assert.equal(await openOutcome("sk-test", "f".repeat(32), sealed), null, "not another draft's");
  assert.equal(await openOutcome("other-key", KEY, sealed), null, "not under another key");
  assert.equal(await openOutcome("sk-test", KEY, { ...sealed, body: sealed.body.replace("Remove drywall", "Remove roof") }), null, "not edited");
  assert.equal(await openOutcome("sk-test", KEY, JSON.parse(sealed.body)), null, "not unsealed");
});

await test("the Anthropic key goes only to Anthropic, never to storage", async () => {
  const w = world("ok");
  await w.run().run(60_000);
  const h = w.writes[0].headers;
  assert.equal(h.apikey, "anon");
  assert.equal("x-api-key" in h, false);
  assert.equal(w.calls[0].init.headers["x-api-key"], "sk-test");
});

await test("overloaded or rate limited: the same request is queued, without the stream flag", async () => {
  for (const mode of ["529"]) {
    const w = world(mode);
    await w.run().run(60_000);
    assert.equal(w.batches.length, 1);
    assert.deepEqual(w.batches[0], { requests: [{ custom_id: "sv-x-1", params: PARAMS }] });
    assert.equal(w.writes.length, 1);
    assert.deepEqual({ type: w.writes[0].body.type, batchId: w.writes[0].body.batchId }, { type: "batch", batchId: "msgbatch_test1" });
  }
});

await test("a bad request is an error outcome, never queued", async () => {
  const w = world("400");
  await w.run().run(60_000);
  assert.equal(w.batches.length, 0);
  assert.equal(w.writes[0].body.type, "error");
  assert.match(w.writes[0].body.error, /refused \(400\)/);
});

await test("an error mid-stream, or a stream that stops short, is queued and keeps what it already cost", async () => {
  const mid = world("midError");
  await mid.run().run(60_000);
  assert.equal(mid.writes[0].body.type, "batch");
  assert.match(mid.writes[0].body.reason, /overloaded_error/);
  assert.equal(mid.writes[0].body.lost.inTok, 1000);
  const short = world("noStop");
  await short.run().run(60_000);
  assert.equal(short.writes[0].body.type, "batch");
  assert.match(short.writes[0].body.reason, /ended before the draft finished/);
});

await test("a network failure is queued", async () => {
  const w = world("network");
  await w.run().run(60_000);
  assert.equal(w.writes[0].body.type, "batch");
  assert.match(w.writes[0].body.reason, /network: fetch failed/);
});

await test("a run past its budget is cut off and queued", async () => {
  const w = world("hang");
  await w.run().run(40);
  assert.equal(w.batches.length, 1);
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].body.type, "batch");
  assert.match(w.writes[0].body.reason, /ran past the/);
});

await test("message_stop ends the read even while the connection lingers", async () => {
  const w = world("linger");
  const t0 = Date.now();
  await w.run().run(5_000);
  assert.ok(Date.now() - t0 < 2_000, "did not wait for the budget");
  assert.equal(w.writes[0].body.type, "message");
  assert.equal(w.batches.length, 0);
});

await test("one outcome per job: a shutdown during the run queues it, and the cut-off after is a no-op", async () => {
  const w = world("hang");
  const run = w.run();
  const going = run.run(80);
  await new Promise((r) => setTimeout(r, 20));
  await run.toBatch("the draft machine restarted (SIGINT)");
  await going;
  assert.equal(w.batches.length, 1);
  assert.equal(w.writes.length, 1);
  assert.match(w.writes[0].body.reason, /restarted/);
  const done = world("ok");
  const r2 = done.run();
  await r2.run(60_000);
  await r2.toBatch("late shutdown");
  assert.equal(done.batches.length, 0, "a finished draft is never queued again");
  assert.equal(done.writes.length, 1);
});

await test("the queue refusing too leaves a clear error that still carries what the stream cost", async () => {
  const w = world("529", { batchFails: true });
  await w.run().run(60_000);
  assert.equal(w.writes[0].body.type, "error");
  assert.match(w.writes[0].body.error, /Couldn't start the draft/);
  assert.equal(w.writes[0].body.lost, undefined, "nothing streamed, nothing lost");
  const mid = world("midError", { batchFails: true });
  await mid.run().run(60_000);
  assert.equal(mid.writes[0].body.type, "error");
  assert.equal(mid.writes[0].body.lost.inTok, 1000);
});

await test("a paid draft survives a storage hiccup: the write is retried, and a write that never lands is logged, not thrown", async () => {
  const flaky = world("ok", { writeAnswers: [{ status: 500, body: "{}" }, { status: 400, body: '{"statusCode":"544","error":"DatabaseTimeout"}' }] });
  await flaky.run().run(60_000);
  assert.equal(flaky.writes.length, 3);
  assert.equal(flaky.logs.some((l) => l.outcome === "write-failed"), false);
  const landed = world("ok", { writeAnswers: [{ status: 503, body: "{}" }, { status: 400, body: '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}' }] });
  await landed.run().run(60_000);
  assert.equal(landed.writes.length, 2, "an earlier try landed: stop");
  const taken = world("ok", { writeAnswers: [{ status: 400, body: '{"statusCode":"409","error":"Duplicate"}' }] });
  await taken.run().run(60_000);
  assert.equal(taken.writes.length, 1, "already written by someone else: no retries");
  assert.equal(taken.logs.some((l) => l.outcome === "write-skipped"), true);
  const down = world("ok", { writeFails: true });
  await down.run().run(60_000);
  assert.equal(down.writes.length, 3);
  const failed = down.logs.find((l) => l.outcome === "write-failed");
  assert.deepEqual([failed.type, failed.inTok, failed.outTok], ["message", 1000, 500], "the lost draft's cost is in the log");
});

await test("without an injected fetch it calls the host's fetch as it is at call time", async () => {
  const w = world("ok");
  const real = globalThis.fetch;
  globalThis.fetch = w.fetch;
  try {
    const { fetch: _f, ...env } = w.env;
    await new DraftRun(JOB, env).run(60_000);
  } finally { globalThis.fetch = real; }
  assert.equal(w.writes[0].body.type, "message");
});

console.log(`sitedraft-run: ${pass} passed`);
