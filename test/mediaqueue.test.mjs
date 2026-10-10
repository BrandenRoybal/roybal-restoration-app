/* The media queue — enqueue, drain in order, resume, fail, retry, pause —
   against fake-indexeddb with the network edges injected.
   Run: node apps/field/test/mediaqueue.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { MediaStore } from "../js/core.js";
import { deps, enqueueMedia, queueRows, queueSummary, drainMediaQueue, retryMedia, removeMedia, pauseMediaQueue, onMedia, bannerText, MAX_ATTEMPTS, RESUMABLE_MIN_BYTES } from "../js/mediaqueue.js";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Media queue");

const MiB = 1024 * 1024;
const blob = (bytes, type = "video/quicktime") => new Blob([new Uint8Array(bytes)], { type });
const events = [];
onMedia((e) => events.push(e.type + ":" + e.row.id + (e.type === "progress" ? "@" + e.row.pct : "")));
const clear = async () => { for (const r of await MediaStore.all()) await MediaStore.del(r.id); events.length = 0; };

// the injected network: records calls, can drop, can refuse
const net = { calls: [], dropOnce: false, refuse: false, abortOnce: false };
deps.online = () => net.online !== false;
deps.signedIn = () => true;
deps.visible = () => true;
deps.upload = async (path, b, mime) => { net.calls.push(["post", path, b.size]); if (net.refuse) { const e = new Error("Upload failed (400)"); throw e; } };
deps.uploadResumable = async (path, b, mime, opts) => {
  net.calls.push(["tus", path, b.size, opts.uploadUrl || "", opts.offset || 0]);
  const url = opts.uploadUrl || "https://s/up/" + path.split("/").pop();
  let off = opts.uploadUrl ? opts.offset : 0;
  while (off < b.size) {
    if (net.abortOnce) { net.abortOnce = false; const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    off = Math.min(b.size, off + 6 * MiB);
    await opts.onProgress(off, b.size, url);
    if (net.dropOnce && off < b.size) { net.dropOnce = false; throw new TypeError("Failed to fetch"); }
  }
  return { uploadUrl: url, offset: off, complete: true };
};
let t = 0; deps.now = () => new Date(1790000000000 + (t++) * 1000).toISOString();

await test("captures land in the store immediately and drain oldest first: small by POST, big by tus", async () => {
  await clear(); net.online = false;   // capture with no signal
  await enqueueMedia({ id: "s1", projectId: "j1", kind: "frames", blob: blob(90_000, "image/jpeg"), path: "sitevisit/j1/s1.jpg" });
  await enqueueMedia({ id: "w1", projectId: "j1", kind: "walk", blob: blob(13 * MiB), path: "sitevisit/j1/w1-IMG.MOV", name: "IMG.MOV" });
  await enqueueMedia({ id: "s2", projectId: "j1", kind: "frames", blob: blob(80_000, "image/jpeg"), path: "sitevisit/j1/s2.jpg" });
  const before = await queueSummary("j1");
  assert.equal(before.count, 3); assert.equal(before.clips, 1);
  assert.ok(RESUMABLE_MIN_BYTES === 6 * MiB);
  net.online = true;                    // signal is back
  await drainMediaQueue();
  assert.deepEqual(net.calls.map((c) => c[0] + ":" + c[1].split("/").pop()), ["post:s1.jpg", "tus:w1-IMG.MOV", "post:s2.jpg"]);
  assert.equal((await queueRows()).length, 0, "rows leave the store only after the upload completed");
  assert.ok(events.includes("uploaded:w1") && events.includes("progress:w1@46") && events.includes("progress:w1@92"));
});

await test("offline: nothing moves; back online: it drains", async () => {
  await clear(); net.calls.length = 0; net.online = false;
  await enqueueMedia({ id: "w2", projectId: "j1", kind: "walk", blob: blob(7 * MiB), path: "sitevisit/j1/w2.mov" });
  await drainMediaQueue();
  assert.equal(net.calls.length, 0);
  assert.equal((await queueRows("j1")).length, 1);
  net.online = true;
  await drainMediaQueue();
  assert.equal((await queueRows("j1")).length, 0);
  assert.equal(net.calls.length, 1);
});

await test("a dropped connection keeps the row with its offset and upload URL; the next drain resumes from there", async () => {
  await clear(); net.calls.length = 0; net.dropOnce = true;
  await enqueueMedia({ id: "w3", projectId: "j2", kind: "walk", blob: blob(13 * MiB), path: "sitevisit/j2/w3.mov" });
  await drainMediaQueue();
  const [row] = await queueRows("j2");
  assert.equal(row.status, "queued"); assert.equal(row.attempts, 1); assert.equal(row.bytesSent, 6 * MiB); assert.equal(row.pct, 46);
  assert.match(row.lastError, /Failed to fetch/);
  const stored = await MediaStore.get("w3");
  assert.equal(stored.tusUrl, "https://s/up/w3.mov");
  await drainMediaQueue();
  const resumed = net.calls[net.calls.length - 1];
  assert.deepEqual(resumed, ["tus", "sitevisit/j2/w3.mov", 13 * MiB, "https://s/up/w3.mov", 6 * MiB]);
  assert.equal((await queueRows("j2")).length, 0);
});

await test("a refused upload is parked as failed at once; retry puts it back to work", async () => {
  await clear(); net.calls.length = 0; net.refuse = true;
  await enqueueMedia({ id: "s3", projectId: "j3", kind: "frames", blob: blob(1000, "image/jpeg"), path: "sitevisit/j3/s3.jpg" });
  await drainMediaQueue();
  let [row] = await queueRows("j3");
  // a plain-POST 4xx is not a TusError, so it counts as one attempt of five
  assert.equal(row.attempts, 1);
  for (let i = 0; i < MAX_ATTEMPTS; i++) await drainMediaQueue();
  [row] = await queueRows("j3");
  assert.equal(row.status, "failed"); assert.equal(row.attempts, MAX_ATTEMPTS);
  const calls = net.calls.length;
  await drainMediaQueue();
  assert.equal(net.calls.length, calls, "a failed row is not attempted again by itself");
  assert.equal(bannerText(await queueSummary("j3")), "1 file failed to upload — open the job to retry");
  net.refuse = false;
  await retryMedia("s3");
  await new Promise((r) => setTimeout(r, 20));
  await drainMediaQueue();
  assert.equal((await queueRows("j3")).length, 0);
});

await test("pause (tab hidden) aborts the chunk in flight and leaves the row resumable", async () => {
  await clear(); net.calls.length = 0; net.abortOnce = true;
  await enqueueMedia({ id: "w4", projectId: "j4", kind: "walk", blob: blob(13 * MiB), path: "sitevisit/j4/w4.mov" });
  await drainMediaQueue();
  const [row] = await queueRows("j4");
  assert.equal(row.attempts, 0, "a pause is not a failure");
  assert.ok(events.includes("paused:w4"));
  await drainMediaQueue();
  assert.equal((await queueRows("j4")).length, 0);
  pauseMediaQueue();   // nothing in flight: harmless
});

await test("removing a queued capture drops it before it ever uploads; the banner text reads right", async () => {
  await clear(); net.calls.length = 0; net.online = false;
  await enqueueMedia({ id: "w5", projectId: "j5", kind: "walk", blob: blob(400 * MiB), path: "sitevisit/j5/w5.mov" });
  await enqueueMedia({ id: "w6", projectId: "j5", kind: "walk", blob: blob(10 * MiB), path: "sitevisit/j5/w6.mov" });
  assert.equal(bannerText(await queueSummary()), "2 clips waiting to upload · 430 MB");
  assert.equal(await removeMedia("w5"), true);
  assert.equal(await removeMedia("nope"), false);
  assert.equal(bannerText(await queueSummary()), "1 clip waiting to upload · 10 MB");
  assert.equal(bannerText({ count: 0 }), "");
  net.online = true; await drainMediaQueue();
  assert.deepEqual(net.calls.map((c) => c[1]), ["sitevisit/j5/w6.mov"]);
});

console.log(`\n${pass} passed`);
