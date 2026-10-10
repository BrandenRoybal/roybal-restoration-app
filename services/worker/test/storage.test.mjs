/* storage.mjs against a stand-in for Supabase Storage: the URL, method,
   headers and body of every call; the retries (429, 5xx, no answer) and
   what is never retried; a missing object as null; an existing one as 409;
   and both error shapes Storage answers with (HTTP 400 carrying the real
   status in the body's statusCode, or the real status itself). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStorage, StorageError } from "../storage.mjs";

const URL_BASE = "https://stub.supabase.co";
const KEY = "sb_secret_test";
const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
const PDF = `${JOB}/PKT-2026-0001-v1-b1.pdf`;
const HASH = "ab".repeat(32);

/* replies: a list of (url, init) → Response, used in turn (the last one
   repeats); every call is recorded */
function stub(...replies) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return r(String(url), init);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (body, status = 200) => () => new Response(body, { status });
const bytes = (u8, status = 200) => () => new Response(u8, { status, headers: { "Content-Type": "application/pdf" } });
const boom = (msg = "fetch failed") => () => { throw new TypeError(msg); };

function storageWith(fetchImpl, over = {}) {
  const delays = [];
  const storage = makeStorage({
    supabaseUrl: URL_BASE, serviceKey: KEY, fetchImpl, retryDelaysMs: [7, 11],
    sleepImpl: async (ms) => { delays.push(ms); }, ...over,
  });
  return { storage, delays };
}

const assertAuth = (call) => {
  assert.equal(call.init.headers.apikey, KEY);
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(call.init.signal instanceof AbortSignal, "every call carries a timeout");
};

test("each call goes to its Storage endpoint with the service key, the right method and body", async () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 45]);
  const fetch = stub(
    json({ name: "carrier-packets" }),
    text("data:image/jpeg;base64,/9j/AA=="),
    bytes(pdf),
    json({ Key: `carrier-packets/${PDF}`, Id: "x" }),
    json({ signedURL: `/object/sign/carrier-packets/${PDF}?token=t0k` }),
    json([{ name: PDF }]),
  );
  const { storage, delays } = storageWith(fetch);

  assert.equal(await storage.ensureBucket("carrier-packets",
    { public: false, fileSizeLimit: 26214400, allowedMimeTypes: ["application/pdf"] }), true);
  assert.equal(await storage.getText("field-media", HASH), "data:image/jpeg;base64,/9j/AA==");
  assert.deepEqual(await storage.getBytes("carrier-packets", PDF), pdf);
  await storage.put("carrier-packets", PDF, pdf, "application/pdf");
  assert.equal(await storage.sign("carrier-packets", PDF, 15 * 86400),
    `${URL_BASE}/storage/v1/object/sign/carrier-packets/${PDF}?token=t0k`);
  assert.deepEqual(await storage.remove("carrier-packets", [PDF]), [{ name: PDF }]);

  const [bucket, get, getB, put, sign, del] = fetch.calls;
  for (const c of fetch.calls) assertAuth(c);
  assert.equal(bucket.url, `${URL_BASE}/storage/v1/bucket`);
  assert.equal(bucket.init.method, "POST");
  assert.equal(bucket.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(bucket.init.body), {
    id: "carrier-packets", name: "carrier-packets", public: false,
    file_size_limit: 26214400, allowed_mime_types: ["application/pdf"],
  });
  assert.equal(get.url, `${URL_BASE}/storage/v1/object/field-media/${HASH}`);
  assert.equal(get.init.method, "GET");
  assert.equal(get.init.body, undefined);
  assert.equal(getB.url, `${URL_BASE}/storage/v1/object/carrier-packets/${PDF}`);
  assert.equal(put.url, `${URL_BASE}/storage/v1/object/carrier-packets/${PDF}`);
  assert.equal(put.init.method, "POST");
  assert.equal(put.init.headers["Content-Type"], "application/pdf");
  assert.equal(put.init.headers["x-upsert"], "false", "an upload never replaces an object");
  assert.equal(put.init.body, pdf);
  assert.equal(sign.url, `${URL_BASE}/storage/v1/object/sign/carrier-packets/${PDF}`);
  assert.equal(sign.init.method, "POST");
  assert.deepEqual(JSON.parse(sign.init.body), { expiresIn: 1296000 });
  assert.equal(del.url, `${URL_BASE}/storage/v1/object/carrier-packets`);
  assert.equal(del.init.method, "DELETE");
  assert.deepEqual(JSON.parse(del.init.body), { prefixes: [PDF] });
  assert.deepEqual(delays, [], "nothing was retried");
});

test("object names are encoded a segment at a time, and a name that would climb out is refused before any call", async () => {
  const fetch = stub(text("x"));
  const { storage } = storageWith(fetch);
  await storage.getText("field-media", "sitevisit/job 1/a#b?.txt");
  assert.equal(fetch.calls[0].url, `${URL_BASE}/storage/v1/object/field-media/sitevisit/job%201/a%23b%3F.txt`);
  for (const bad of ["../other", "a/../b", "/abs", "a//b", "", "a/."]) {
    await assert.rejects(storage.getText("field-media", bad), StorageError, bad);
    await assert.rejects(storage.remove("carrier-packets", [bad]), StorageError, bad);
  }
  await assert.rejects(storage.getText("field/media", HASH), StorageError);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(await storage.remove("carrier-packets", []), [], "nothing to delete is no call");
  assert.equal(fetch.calls.length, 1);
});

test("429, 5xx and no answer are tried again, three tries in all, with the configured pauses", async () => {
  {
    const fetch = stub(text("busy", 503), text("data:image/png;base64,AAAA"));
    const { storage, delays } = storageWith(fetch);
    assert.equal(await storage.getText("field-media", HASH), "data:image/png;base64,AAAA");
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(delays, [7]);
  }
  {
    const fetch = stub(json({ statusCode: "429", error: "too many" }, 429), boom(), json({ signedURL: "/object/sign/b/x?token=1" }));
    const { storage, delays } = storageWith(fetch);
    assert.equal(await storage.sign("b", "x", 60), `${URL_BASE}/storage/v1/object/sign/b/x?token=1`);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(delays, [7, 11]);
  }
  {
    const fetch = stub(text("down", 502));
    const { storage, delays } = storageWith(fetch);
    await assert.rejects(storage.put("carrier-packets", PDF, new Uint8Array([1]), "application/pdf"), (e) => {
      assert.ok(e instanceof StorageError);
      assert.equal(e.status, 502);
      return true;
    });
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(delays, [7, 11]);
  }
  {
    const fetch = stub(boom("getaddrinfo ENOTFOUND"));
    const { storage } = storageWith(fetch);
    await assert.rejects(storage.remove("carrier-packets", [PDF]), (e) => {
      assert.equal(e.status, 0);
      assert.match(e.message, /no answer: getaddrinfo ENOTFOUND/);
      return true;
    });
    assert.equal(fetch.calls.length, 3);
  }
  {
    // a 4xx is an answer: never retried
    const fetch = stub(json({ statusCode: "403", error: "Unauthorized", message: "invalid signature" }, 403));
    const { storage, delays } = storageWith(fetch);
    await assert.rejects(storage.getBytes("carrier-packets", PDF), (e) => e.status === 403);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(delays, []);
  }
});

test("a timed-out attempt is abandoned at timeoutMs and tried again", async () => {
  let n = 0;
  const fetch = async (_url, init) => {
    n += 1;
    if (n === 1) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }
    return new Response("data:image/jpeg;base64,AA==");
  };
  const { storage } = storageWith(fetch, { timeoutMs: 20 });
  // AbortSignal.timeout's timer does not hold the event loop open by itself
  const hold = setInterval(() => {}, 1000);
  try {
    assert.equal(await storage.getText("field-media", HASH), "data:image/jpeg;base64,AA==");
  } finally {
    clearInterval(hold);
  }
  assert.equal(n, 2);
});

test("a missing object is null, in either shape Storage reports it", async () => {
  const notFound = { statusCode: "404", error: "not_found", message: "Object not found" };
  for (const reply of [json(notFound, 404), json(notFound, 400), text("", 404)]) {
    const { storage } = storageWith(stub(reply));
    assert.equal(await storage.getText("field-media", HASH), null);
    const { storage: s2 } = storageWith(stub(reply));
    assert.equal(await s2.getBytes("carrier-packets", PDF), null);
    const { storage: s3 } = storageWith(stub(reply));
    assert.equal(await s3.sign("carrier-packets", PDF, 60), null);
  }
  // a 400 that is not a missing object still throws
  const { storage } = storageWith(stub(json({ statusCode: "400", error: "InvalidKey", message: "Invalid key" }, 400)));
  await assert.rejects(storage.getText("field-media", HASH), (e) => e.status === 400 && /Invalid key/.test(e.message));
});

test("an upload over an existing object throws 409, in either shape", async () => {
  const dup = { statusCode: "409", error: "Duplicate", message: "The resource already exists" };
  for (const reply of [json(dup, 409), json(dup, 400)]) {
    const fetch = stub(reply);
    const { storage, delays } = storageWith(fetch);
    await assert.rejects(storage.put("carrier-packets", PDF, new Uint8Array([1, 2]), "application/pdf"), (e) => {
      assert.ok(e instanceof StorageError);
      assert.equal(e.status, 409);
      assert.match(e.message, /already exists/);
      return true;
    });
    assert.equal(fetch.calls.length, 1, "a conflict is an answer, not an outage");
    assert.deepEqual(delays, []);
  }
});

test("ensureBucket takes a bucket that already exists as success, in either shape, and throws on anything else", async () => {
  const dup = { statusCode: "409", error: "Duplicate", message: "The resource already exists" };
  for (const reply of [json(dup, 409), json(dup, 400), json({ statusCode: "400", error: "Bad Request", message: "The resource already exists" }, 400)]) {
    const { storage } = storageWith(stub(reply));
    assert.equal(await storage.ensureBucket("carrier-packets", {}), false);
  }
  {
    const fetch = stub(json({ name: "carrier-packets" }));
    const { storage } = storageWith(fetch);
    assert.equal(await storage.ensureBucket("carrier-packets"), true);
    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { id: "carrier-packets", name: "carrier-packets", public: false },
      "no limits asked for, none sent");
  }
  for (const reply of [json({ statusCode: "400", error: "Invalid", message: "Bucket name invalid" }, 400),
    json({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }, 403)]) {
    const { storage } = storageWith(stub(reply));
    await assert.rejects(storage.ensureBucket("carrier-packets", {}), StorageError);
  }
  {
    const fetch = stub(text("bad gateway", 502));
    const { storage } = storageWith(fetch);
    await assert.rejects(storage.ensureBucket("carrier-packets", {}), (e) => e.status === 502);
    assert.equal(fetch.calls.length, 3);
  }
});

test("sign joins the relative signedURL onto /storage/v1, with or without its leading slash", async () => {
  for (const [body, want] of [
    [{ signedURL: "/object/sign/carrier-packets/a/b.pdf?token=x" }, `${URL_BASE}/storage/v1/object/sign/carrier-packets/a/b.pdf?token=x`],
    [{ signedURL: "object/sign/carrier-packets/a/b.pdf?token=x" }, `${URL_BASE}/storage/v1/object/sign/carrier-packets/a/b.pdf?token=x`],
    [{ signedUrl: "/object/sign/carrier-packets/a/b.pdf?token=y" }, `${URL_BASE}/storage/v1/object/sign/carrier-packets/a/b.pdf?token=y`],
  ]) {
    const { storage } = storageWith(stub(json(body)));
    assert.equal(await storage.sign("carrier-packets", "a/b.pdf", 60), want);
  }
  const { storage } = storageWith(stub(json({})));
  await assert.rejects(storage.sign("carrier-packets", "a/b.pdf", 60), /no signedURL/);
});
