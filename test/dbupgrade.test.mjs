/* The IndexedDB schema bump for the media queue: a phone on version 2 with
   jobs in it must come up on version 3 with every job intact and a working
   media_queue store. Run: node apps/field/test/dbupgrade.test.mjs */
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("IndexedDB upgrade (v2 → v3)");

// 1. a phone as it was: version 2, projects + backups, one job saved
await new Promise((ok, bad) => {
  const req = indexedDB.open("roybal-field", 2);
  req.onupgradeneeded = () => { const d = req.result; d.createObjectStore("projects", { keyPath: "id" }); d.createObjectStore("backups", { keyPath: "id" }); };
  req.onsuccess = () => {
    const d = req.result;
    const t = d.transaction("projects", "readwrite");
    t.objectStore("projects").put({ id: "job-1", customer: "Hebard", updatedAt: "2026-09-01T00:00:00.000Z" });
    t.oncomplete = () => { d.close(); ok(); };
    t.onerror = () => bad(t.error);
  };
  req.onerror = () => bad(req.error);
});

// 2. the app opens it
const { Store, MediaStore, MEDIA_STORE } = await import("../js/core.js");

await test("the saved job survives the upgrade", async () => {
  const p = await Store.get("job-1");
  assert.equal(p && p.customer, "Hebard");
  assert.equal((await Store.all()).length, 1);
});

await test("the media_queue store exists with a projectId index and round-trips a Blob", async () => {
  const blob = new Blob([new Uint8Array(3000)], { type: "video/quicktime" });
  await MediaStore.put({ id: "f-1", projectId: "job-1", kind: "walk", blob, mime: "video/quicktime", size: 3000, name: "IMG_1.MOV", path: "sitevisit/job-1/f-1-IMG_1.MOV", bytesSent: 0, tusUrl: "", createdAt: "2026-09-28T10:00:01.000Z", attempts: 0, lastError: "" });
  await MediaStore.put({ id: "f-0", projectId: "job-1", kind: "frames", blob: new Blob([new Uint8Array(10)]), size: 10, createdAt: "2026-09-28T10:00:00.000Z" });
  const rows = await MediaStore.all();
  assert.deepEqual(rows.map((r) => r.id), ["f-0", "f-1"], "oldest first");
  const back = await MediaStore.get("f-1");
  assert.equal(back.blob.size, 3000);
  assert.equal(back.blob.type, "video/quicktime");
  await MediaStore.del("f-0");
  assert.deepEqual((await MediaStore.all()).map((r) => r.id), ["f-1"]);
  assert.equal(MEDIA_STORE, "media_queue");
});

await test("re-opening at the same version is a no-op (no data loss, no upgrade)", async () => {
  await new Promise((ok, bad) => {
    const req = indexedDB.open("roybal-field", 3);
    req.onupgradeneeded = () => bad(new Error("unexpected upgrade"));
    req.onsuccess = () => { const d = req.result; assert.ok(d.objectStoreNames.contains("media_queue") && d.objectStoreNames.contains("projects")); d.close(); ok(); };
    req.onerror = () => bad(req.error);
  });
});

console.log(`\n${pass} passed`);
