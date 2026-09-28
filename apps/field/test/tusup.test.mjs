/* Resumable uploads — the tus client against a mock of Supabase's endpoint.
   Run: node apps/field/test/tusup.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { tusUpload, uploadMetadata, resolveLocation, CHUNK_BYTES, TusError, retryable } from "../js/tusup.js";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Resumable uploads (tus)");

const MiB = 1024 * 1024;
const ENDPOINT = "https://proj.supabase.co/storage/v1/upload/resumable";
const headers = () => ({ apikey: "anon", authorization: "Bearer jwt" });

/* A tiny tus server: one upload at a time, remembers its offset, can be told
   to drop a connection, expire, or lie about the offset once. */
function mockServer(opts = {}) {
  const st = { created: 0, patches: 0, heads: 0, offset: 0, length: 0, meta: "", url: opts.relative ? "/storage/v1/upload/resumable/abc" : "https://proj.supabase.co/storage/v1/upload/resumable/abc", expired: false, bodies: [] };
  const res = (status, hdrs = {}, body = "") => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => hdrs[k.toLowerCase()] ?? null }, text: async () => body });
  const fetch = async (url, init) => {
    assert.equal(init.headers["tus-resumable"], "1.0.0");
    assert.equal(init.headers.authorization, "Bearer jwt");
    if (init.method === "POST") {
      st.created++; st.offset = 0; st.length = Number(init.headers["upload-length"]); st.meta = init.headers["upload-metadata"]; st.expired = false;
      assert.equal(init.headers["x-upsert"], "true");
      return res(opts.createStatus || 201, { location: st.url });
    }
    if (st.expired) return res(404);
    if (init.method === "HEAD") { st.heads++; return res(200, { "upload-offset": String(st.offset), "upload-length": String(st.length) }); }
    if (init.method === "PATCH") {
      st.patches++;
      const off = Number(init.headers["upload-offset"]);
      if (opts.dropOnPatch && st.patches === opts.dropOnPatch) throw new TypeError("Failed to fetch");
      if (opts.lieOnce && !st.lied) { st.lied = true; return res(409); }
      assert.equal(off, st.offset, "client sent the offset the server expects");
      assert.equal(init.headers["content-type"], "application/offset+octet-stream");
      const size = init.body.size;
      st.bodies.push(size);
      assert.ok(size <= CHUNK_BYTES);
      st.offset += size;
      if (opts.expireAfterPatch && st.patches === opts.expireAfterPatch) st.expired = true;
      return res(204, { "upload-offset": String(st.offset) });
    }
    throw new Error("unexpected " + init.method);
  };
  return { st, fetch };
}
const blobOf = (bytes) => new Blob([new Uint8Array(bytes)]);

await test("Upload-Metadata carries bucket, object name and type as base64 pairs", () => {
  const m = uploadMetadata({ bucket: "field-media", path: "sitevisit/j/w1-IMG_1.MOV", contentType: "video/quicktime" });
  const pairs = Object.fromEntries(m.split(",").map((kv) => { const [k, v] = kv.split(" "); return [k, Buffer.from(v, "base64").toString("utf8")]; }));
  assert.deepEqual(pairs, { bucketName: "field-media", objectName: "sitevisit/j/w1-IMG_1.MOV", contentType: "video/quicktime", cacheControl: "3600" });
  assert.equal(resolveLocation("/storage/v1/upload/resumable/x", ENDPOINT), "https://proj.supabase.co/storage/v1/upload/resumable/x");
  assert.equal(resolveLocation("https://other/x", ENDPOINT), "https://other/x");
  assert.equal(resolveLocation("", ENDPOINT), "");
});

await test("a 13 MiB clip goes up as 6 + 6 + 1 MiB chunks, in order, with progress after each", async () => {
  const { st, fetch } = mockServer();
  const seen = [];
  const r = await tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "field-media", path: "sitevisit/j/w1-c.mov", blob: blobOf(13 * MiB), contentType: "video/quicktime",
    onProgress: (sent, total, url) => seen.push([sent, total, !!url]) });
  assert.deepEqual(st.bodies, [6 * MiB, 6 * MiB, 1 * MiB]);
  assert.deepEqual(seen, [[6 * MiB, 13 * MiB, true], [12 * MiB, 13 * MiB, true], [13 * MiB, 13 * MiB, true]]);
  assert.equal(r.complete, true); assert.equal(r.offset, 13 * MiB); assert.equal(r.uploadUrl, st.url);
  assert.equal(st.created, 1); assert.equal(st.heads, 0);
});

await test("a dropped connection mid-clip resumes from the server's offset, not from zero", async () => {
  const { st, fetch } = mockServer({ dropOnPatch: 2 });
  let saved = null;
  const first = tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(13 * MiB), chunkBytes: 6 * MiB,
    onProgress: (sent, total, url) => { saved = { offset: sent, uploadUrl: url }; } });
  await assert.rejects(first, (e) => e instanceof TypeError);
  assert.ok(retryable(new TypeError("x")));
  assert.deepEqual(saved, { offset: 6 * MiB, uploadUrl: st.url });
  const r = await tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(13 * MiB), uploadUrl: saved.uploadUrl, offset: saved.offset });
  assert.equal(r.complete, true);
  assert.equal(st.created, 1, "no second upload was created");
  assert.equal(st.heads, 1, "one HEAD to ask where we were");
  assert.deepEqual(st.bodies, [6 * MiB, 6 * MiB, 1 * MiB], "the dropped chunk was re-sent once, nothing before it");
});

await test("an expired upload URL (24 h) starts over from byte 0 with a fresh create", async () => {
  const { st, fetch } = mockServer();
  st.expired = true;
  const r = await tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(2 * MiB), uploadUrl: "https://proj.supabase.co/storage/v1/upload/resumable/old", offset: 1 * MiB });
  assert.equal(r.complete, true);
  assert.equal(st.created, 1);
  assert.deepEqual(st.bodies, [2 * MiB]);
});

await test("expiry during a PATCH surfaces as a 404/410 TusError so the queue can reset the row", async () => {
  const { fetch } = mockServer({ expireAfterPatch: 1 });
  await assert.rejects(
    tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(7 * MiB) }),
    (e) => e instanceof TusError && e.status === 404 && e.phase === "patch" && retryable(e));
});

await test("an offset disagreement (409) is settled by asking the server, then continuing", async () => {
  const { st, fetch } = mockServer({ lieOnce: true });
  const r = await tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(7 * MiB) });
  assert.equal(r.complete, true);
  assert.equal(st.heads, 1);
  assert.deepEqual(st.bodies, [6 * MiB, 1 * MiB]);
});

await test("a relative Location resolves against the endpoint; a refused create is not retried", async () => {
  const { st, fetch } = mockServer({ relative: true });
  const r = await tusUpload({ endpoint: ENDPOINT, headers, fetch, bucket: "b", path: "p", blob: blobOf(1024) });
  assert.equal(r.uploadUrl, "https://proj.supabase.co/storage/v1/upload/resumable/abc");
  assert.equal(st.bodies[0], 1024);
  const bad = mockServer({ createStatus: 400 });
  await assert.rejects(tusUpload({ endpoint: ENDPOINT, headers, fetch: bad.fetch, bucket: "b", path: "p", blob: blobOf(10) }),
    (e) => e instanceof TusError && e.phase === "create" && e.retryable === false && !retryable(e));
});

await test("a pause (AbortSignal) stops the in-flight chunk and is retryable", async () => {
  const { st, fetch } = mockServer();
  const ctl = new AbortController();
  const slowFetch = async (url, init) => { if (init.method === "PATCH" && st.patches === 1) { ctl.abort(); const e = new Error("aborted"); e.name = "AbortError"; throw e; } return fetch(url, init); };
  await assert.rejects(tusUpload({ endpoint: ENDPOINT, headers, fetch: slowFetch, bucket: "b", path: "p", blob: blobOf(13 * MiB), signal: ctl.signal }), (e) => e.name === "AbortError" && retryable(e));
});

console.log(`\n${pass} passed`);
