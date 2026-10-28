/* On-device backups, one record per snapshot. They used to share one record
   per job, and every backup read the whole record (up to 10 full copies of
   the job) into memory to add a copy — on a photo-heavy job that crashed an
   iPhone on every launch, because each launch re-pulled the job and backed it
   up first. These pin the split: a backup reads no stored copy, prunes by
   key, and a record from before the split is left alone until it ages out.
   Run: node apps/field/test/backups.test.mjs */
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("On-device backups");

/* every read of a stored VALUE on the backups store, as [method, key] —
   getAllKeys and count read keys only and are not counted */
const reads = [];
for (const m of ["get", "getAll", "openCursor"]) {
  const real = IDBObjectStore.prototype[m];
  IDBObjectStore.prototype[m] = function (...args) {
    if (this.name === "backups") reads.push([m, args[0]]);
    return real.apply(this, args);
  };
}
/* the next N puts into backups fail the way a full disk does: asynchronously,
   aborting the transaction with QuotaExceededError (fake-indexeddb's own
   request runner, so the transaction's earlier deletes roll back as real) */
let quotaFailures = 0;
const realPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value, key) {
  if (this.name === "backups" && quotaFailures > 0) {
    quotaFailures--;
    return this.transaction._execRequestAsync({
      source: this,
      operation: () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
    });
  }
  return realPut.call(this, value, key);
};

const { Store, snapKey, parseSnapKey, ownSnapKeys, snapVictims, approxBytes, SNAP_MAX, SNAP_BUDGET, SNAP_MIN } = await import("../js/core.js");
const MB = 1024 * 1024;

/* a record in the format from before the split, written straight to the store */
async function putOldRecord(id, snaps) {
  await Store.all();                                   // the app opens (and creates) the database
  await new Promise((ok, bad) => {
    const req = indexedDB.open("roybal-field");
    req.onsuccess = () => {
      const d = req.result;
      const t = d.transaction("backups", "readwrite");
      t.objectStore("backups").put({ id, snaps });
      t.oncomplete = () => { d.close(); ok(); };
      t.onabort = () => bad(t.error);
    };
    req.onerror = () => bad(req.error);
  });
}
const job = (id, n, extra = {}) => ({ id, customer: "Job " + n, updatedAt: `2026-10-0${1 + (n % 9)}T00:00:00.000Z`, photos: [], ...extra });

await test("a snapshot key reads back from the right, even with # in the job id", async () => {
  const k = snapKey("a#b", "2026-10-24T10:00:00.000Z", 123);
  assert.deepEqual(parseSnapKey(k), { key: k, jobId: "a#b", takenAt: "2026-10-24T10:00:00.000Z", bytes: 123 });
  const keys = [snapKey("a", "2026-10-24T10:00:00.000Z", 1), k, snapKey("a", "2026-10-24T11:00:00.000Z", 2)];
  assert.deepEqual(ownSnapKeys("a", keys), [keys[2], keys[0]], "only job a's own keys, newest first");
});

await test("retention: the newest 10, cut to what fits 64 MB, but never fewer than the newest 2", async () => {
  assert.equal(SNAP_MAX, 10); assert.equal(SNAP_BUDGET, 64 * MB); assert.equal(SNAP_MIN, 2);
  const keys = (sizes) => sizes.map((b, i) => snapKey("j", `2026-10-24T10:00:${String(59 - i).padStart(2, "0")}.000Z`, b));
  const small = keys(Array(12).fill(1000));
  assert.deepEqual(snapVictims(small), small.slice(10), "12 small copies: the 2 oldest go");
  const mid = keys([30 * MB, 30 * MB, 30 * MB, 1000]);
  assert.deepEqual(snapVictims(mid), mid.slice(2), "the third 30 MB copy passes 64 MB — it and everything older go");
  const huge = keys([124 * MB, 124 * MB, 124 * MB]);
  assert.deepEqual(snapVictims(huge), huge.slice(2), "a 124 MB job still keeps its newest two");
  assert.deepEqual(snapVictims(keys([10 * MB, 10 * MB, 10 * MB])), [], "30 MB in all fits");
});

await test("a job's size is measured by walking it, not by serializing it", async () => {
  assert.equal(approxBytes({ a: "xxxx", b: ["yy"] }), 1 + 4 + 1 + 2);
  assert.equal(approxBytes({ n: 5, ok: true, none: null }), 1 + 8 + 2 + 8 + 4 + 8);
  const photo = "data:image/jpeg;base64," + "A".repeat(50_000);
  assert.ok(approxBytes(job("s", 1, { photos: [{ id: "p", src: photo }] })) > 50_000);
});

await test("each backup is its own record, listed newest first by key alone", async () => {
  for (let n = 1; n <= 3; n++) await Store.backup(job("j1", n));
  reads.length = 0;
  const snaps = await Store.snapshots("j1");
  assert.equal(reads.length, 0, "listing reads keys, never a copy");
  assert.equal(snaps.length, 3);
  assert.ok(snaps[0].takenAt > snaps[1].takenAt && snaps[1].takenAt > snaps[2].takenAt, "newest first");
  assert.ok(snaps.every((s) => s.jobId === "j1" && s.bytes > 0));
  assert.equal((await Store.snapshot(snaps[2].key)).customer, "Job 1");
  assert.equal((await Store.latestBackup("j1")).customer, "Job 3");
  assert.deepEqual((await Store.backups("j1")).map((s) => s.data.customer), ["Job 3", "Job 2", "Job 1"]);
  assert.equal(await Store.latestBackup("nothing-here"), null);
  assert.equal(await Store.snapshot("gone#2026-01-01T00:00:00.000Z#1"), null);
});

await test("two backups in the same instant still keep two snapshots", async () => {
  await Promise.all([Store.backup(job("j2", 1)), Store.backup(job("j2", 2))]);
  assert.equal((await Store.snapshots("j2")).length, 2);
});

await test("a job keeps its newest 10; its neighbours' snapshots are untouched", async () => {
  await Store.backup(job("j3#x", 0));                                 // an id that shares j3's prefix and separator
  await Store.backup(job("j30", 0));                                  // and one that shares its prefix
  for (let n = 1; n <= 12; n++) await Store.backup(job("j3", n));
  const kept = await Store.backups("j3");
  assert.equal(kept.length, 10);
  assert.equal(kept[0].data.customer, "Job 12");
  assert.equal(kept[9].data.customer, "Job 3", "Jobs 1 and 2 aged out");
  assert.equal((await Store.snapshots("j3#x")).length, 1);
  assert.equal((await Store.snapshots("j30")).length, 1);
});

await test("a backup reads no stored copy — the old 10-copy record is never loaded (the iPhone crash)", async () => {
  const fat = "data:image/jpeg;base64," + "B".repeat(200_000);
  await putOldRecord("j4", Array.from({ length: 6 }, (_, i) => ({ takenAt: `2026-10-1${i}T00:00:00.000Z`, data: job("j4", i, { photos: [{ id: "p" + i, src: fat }] }) })));
  reads.length = 0;
  await Store.backup(job("j4", 7));
  await Store.backup(job("j4", 8));
  await Store.snapshots("j4");
  assert.deepEqual(reads, [], "backing up and listing read nothing but keys");
  await Store.latestBackup("j4");
  assert.equal(reads.length, 1, "the newest snapshot alone is loaded to read it");
  assert.notEqual(reads[0][1], "j4", "…and never the old record");
  assert.equal(await Store.hasOlderBackups("j4"), true, "the old record is still there");
  assert.equal((await Store.olderBackups("j4")).length, 6, "and opens on request");
});

await test("the old record stays until the new snapshots outgrow retention, then goes", async () => {
  await putOldRecord("j5", [{ takenAt: "2026-10-01T00:00:00.000Z", data: job("j5", 0) }]);
  for (let n = 1; n <= 10; n++) await Store.backup(job("j5", n));
  assert.equal(await Store.hasOlderBackups("j5"), true, "10 new snapshots: nothing has aged out yet");
  await Store.backup(job("j5", 11));
  assert.equal(await Store.hasOlderBackups("j5"), false, "the 11th pushes one out, and the older record with it");
  assert.equal((await Store.snapshots("j5")).length, 10);
  assert.deepEqual(await Store.olderBackups("j5"), []);
});

await test("a full disk: room is made, the new copy lands, and two copies stay", async () => {
  await putOldRecord("j6", [{ takenAt: "2026-10-01T00:00:00.000Z", data: job("j6", 0) }]);
  for (let n = 1; n <= 4; n++) await Store.backup(job("j6", n));
  quotaFailures = 1;
  await Store.backup(job("j6", 5));
  assert.equal(quotaFailures, 0);
  assert.deepEqual((await Store.backups("j6")).map((s) => s.data.customer), ["Job 5", "Job 4"]);
  assert.equal(await Store.hasOlderBackups("j6"), false, "the older record went to make room");
});

await test("a disk that stays full skips the snapshot and never throws", async () => {
  for (let n = 1; n <= 3; n++) await Store.backup(job("j7", n));
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    quotaFailures = 2;
    await Store.backup(job("j7", 4));
  } finally { console.warn = warn; }
  assert.equal(warned, 1, "skipped with a warning");
  assert.deepEqual((await Store.backups("j7")).map((s) => s.data.customer), ["Job 3"], "room was made; the new copy didn't fit");
});

await test("a clock that ran ahead and was set back never leaves old copies sorting as newest", async () => {
  const realNow = Date.now;
  Date.now = () => realNow() + 864e5;                               // a day fast…
  try { await Store.backup(job("c1", 1)); await Store.backup(job("c1", 2)); } finally { Date.now = realNow; }
  // …then set right, and the app relaunched (a fresh module, as a reload is)
  const { Store: Relaunched } = await import("../js/core.js?relaunch");
  for (let n = 3; n <= 14; n++) await Relaunched.backup(job("c1", n));
  assert.equal((await Relaunched.latestBackup("c1")).customer, "Job 14", "the copy taken last is the newest");
  assert.deepEqual((await Relaunched.backups("c1")).map((s) => s.data.customer).slice(0, 3), ["Job 14", "Job 13", "Job 12"]);
  assert.equal((await Relaunched.snapshots("c1")).length, 10, "and the fast-clock copies aged out like any other");
});

await test("two backups of one job on a full disk at once each land, in the order they were taken", async () => {
  // a sync's backup and a Restore's together, both first tries out of room, in one millisecond:
  // the first tries get one stamp, so each retry must stamp again
  const realNow = Date.now;
  const both = async (id, a, b) => {
    const t = realNow();
    Date.now = () => t;
    quotaFailures = 2;
    try { await Promise.all([Store.backup(a), Store.backup(b)]); } finally { Date.now = realNow; }
    assert.equal(quotaFailures, 0);
    return (await Store.backups(id)).map((s) => s.data.customer);
  };
  await Store.backup(job("c2", 1));
  // the same size (one number differs): a reused stamp makes the same key, and the second copy was dropped
  assert.deepEqual(await both("c2", job("c2", 2), job("c2", 3)), ["Job 3", "Job 2", "Job 1"]);
  assert.equal((await Store.latestBackup("c2")).customer, "Job 3");
  // the later copy bigger, 99 bytes against 100: a reused stamp left the order to the size, compared as text
  await Store.backup(job("c3", 1));
  const sized = (n, bytes) => { const p = job("c3", n, { note: "" }); p.note = "x".repeat(bytes - approxBytes(p)); return p; };
  const [a, b] = [sized(2, 99), sized(3, 100)];
  assert.deepEqual([approxBytes(a), approxBytes(b)], [99, 100]);
  assert.deepEqual(await both("c3", a, b), ["Job 3", "Job 2", "Job 1"]);
});

await test("a job that can't even be measured is skipped, never thrown at the sync that asked", async () => {
  const odd = job("j9", 1); odd.self = odd;                            // no real job does this; backup() still must not throw
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try { await Store.backup(odd); } finally { console.warn = warn; }
  assert.equal(warned, 1);
  assert.deepEqual(await Store.snapshots("j9"), []);
});

await test("a failed backup that isn't a full disk rolls back whole — no snapshot is lost to it", async () => {
  for (let n = 1; n <= 10; n++) await Store.backup(job("j8", n));
  const warn = console.warn; console.warn = () => {};
  const realGetAllKeys = IDBObjectStore.prototype.getAllKeys;
  IDBObjectStore.prototype.getAllKeys = function (...args) {
    const req = realGetAllKeys.apply(this, args);
    if (this.name === "backups") {
      const store = this;
      queueMicrotask(() => {
        const ok = req.onsuccess;
        req.onsuccess = (e) => { ok(e); store.put({ id: "bad", fn: () => {} }); };   // DataCloneError mid-transaction
      });
    }
    return req;
  };
  try {
    await Store.backup(job("j8", 11));
  } finally { IDBObjectStore.prototype.getAllKeys = realGetAllKeys; console.warn = warn; }
  const kept = await Store.backups("j8");
  assert.equal(kept.length, 10, "the delete of the oldest rolled back with the failed write");
  assert.equal(kept[0].data.customer, "Job 10");
  assert.equal(kept[9].data.customer, "Job 1");
});

await test("a Restore's backup never prunes the copy being restored: an older-format backup outliving retention", async () => {
  await putOldRecord("k1", [{ takenAt: "2026-10-01T00:00:00.000Z", data: job("k1", 0) }]);
  for (let n = 1; n <= 10; n++) await Store.backup(job("k1", n));
  await Store.backup(job("k1", 11), { keep: "k1" });                 // restoring from "Show older backups"
  assert.equal(await Store.hasOlderBackups("k1"), true, "the older record being restored stays");
  assert.equal((await Store.snapshots("k1")).length, 10, "the oldest snapshot still made room");
  await Store.backup(job("k1", 12));                                   // no restore: it ages out as usual
  assert.equal(await Store.hasOlderBackups("k1"), false);
});

await test("a Restore's backup on a full disk frees room around the snapshot being restored", async () => {
  for (let n = 1; n <= 10; n++) await Store.backup(job("k2", n));
  const oldest = (await Store.snapshots("k2")).at(-1).key;
  quotaFailures = 1;
  await Store.backup(job("k2", 11), { keep: oldest });
  assert.equal(quotaFailures, 0);
  const kept = (await Store.snapshots("k2")).map((s) => s.key);
  assert.ok(kept.includes(oldest), "the snapshot being restored survives the free-up");
  assert.equal((await Store.snapshot(oldest)).customer, "Job 1");
  assert.equal((await Store.latestBackup("k2")).customer, "Job 11", "and the backup of the current copy landed");
});

await test("a Restore's backup on a full disk keeps the older-format backup being restored", async () => {
  await putOldRecord("k3", [{ takenAt: "2026-10-01T00:00:00.000Z", data: job("k3", 0) }]);
  for (let n = 1; n <= 3; n++) await Store.backup(job("k3", n));
  quotaFailures = 1;
  await Store.backup(job("k3", 4), { keep: "k3" });
  assert.equal(quotaFailures, 0);
  assert.equal(await Store.hasOlderBackups("k3"), true, "the older record being restored stays");
  assert.equal((await Store.olderBackups("k3"))[0].data.customer, "Job 0");
});

console.log(`\n${pass} passed`);
