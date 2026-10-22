/* The phone's IndexedDB connection dying under a live page (apps/field/js/core.js).
   WebKit kills its storage process and the old handle then throws
   InvalidStateError "The database connection is closing." or its requests
   fail UnknownError "Connection to Indexed Database server lost" — for good,
   since the app cached that handle forever (the Oct 20 receipts freeze).
   core.js now reopens and retries once, says so when it cannot, resolves a
   write only when it commits, and never strands an autosave edit.
   Run: node apps/field/test/store-reconnect.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><span id="pill"></span></body></html>`, { url: "http://localhost/" });
globalThis.document = dom.window.document;

/* ---- fault injection on the real fake-indexeddb classes ---- */
const dead = new WeakSet();          // connections the "storage process" took with it
let lastDb = null, openFails = false, abortNextWrite = false, opens = 0;
const P = globalThis.IDBDatabase.prototype;
const origTx = P.transaction;
P.transaction = function (...a) {
  lastDb = this;
  if (dead.has(this)) throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
  const t = origTx.apply(this, a);
  if (abortNextWrite && a[1] === "readwrite") {
    abortNextWrite = false;
    // the request succeeds, then the commit is refused (quota, process gone mid-commit)
    const os = t.objectStore.bind(t);
    t.objectStore = (n) => { const s = os(n); const put = s.put.bind(s); s.put = (v) => { const r = put(v); r.addEventListener("success", () => queueMicrotask(() => t.abort())); return r; }; return s; };
  }
  return t;
};
const origOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (...a) => {
  opens++;
  if (openFails) {
    const req = { result: null, error: new DOMException("Connection to Indexed Database server lost. Refresh the page to try again", "UnknownError") };
    setTimeout(() => req.onerror && req.onerror(), 0);
    return req;
  }
  return origOpen(...a);
};
const killConnection = () => { dead.add(lastDb); };

const core = await import("../js/core.js");
const { Store, onProjectSaved, onStorageLost, onStorageBack, autosave, flushPending, unsavedProject, isConnectionLost } = core;

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
const saved = []; onProjectSaved((p) => saved.push(p.id + "@" + p.updatedAt));
const lost = []; onStorageLost((e) => lost.push(e)); let backs = 0; onStorageBack(() => backs++);
const unhandled = []; process.on("unhandledRejection", (e) => unhandled.push(e));
const job = (id, n = 1) => ({ id, customer: "Alston", receipts: Array.from({ length: n }, (_, i) => ({ id: "r" + i, photo: "data:image/jpeg;base64," + "A".repeat(9000) })) });
console.log("IndexedDB connection that heals (core.js)");

await test("a put on a connection that died reopens once and lands; listeners fire once, after commit", async () => {
  await Store.put(job("A"));
  saved.length = 0;
  const before = opens;
  killConnection();
  const p = job("A", 2);
  await Store.put(p);
  assert.equal(opens, before + 1, "one reopen");
  assert.equal((await Store.get("A")).receipts.length, 2);
  assert.equal(saved.length, 1);
  assert.equal(lost.length, 0);
});

await test("reads heal the same way (the pull's Store.get no longer throws forever)", async () => {
  killConnection();
  assert.equal((await Store.get("A")).receipts.length, 2);
  killConnection();
  assert.deepEqual(await Store.keys(), ["A"]);
});

await test("a 'close' event from the browser drops the handle; the next op opens a fresh one", async () => {
  await Store.get("A");
  const d = lastDb, before = opens;
  dead.add(d);
  d.onclose && d.onclose(new Event("close"));
  await Store.put(job("A", 3));
  assert.equal(opens, before + 1);
  assert.notEqual(lastDb, d);
});

await test("when the reopen fails too: the write rejects with code storage-lost, onStorageLost fires once, nothing is reported saved", async () => {
  saved.length = 0;
  killConnection(); openFails = true;
  const e1 = await Store.put(job("A", 4)).catch((e) => e);
  const e2 = await Store.get("A").catch((e) => e);
  assert.equal(e1.code, "storage-lost"); assert.equal(e2.code, "storage-lost");
  assert.equal(lost.length, 1, "told once, not per call");
  assert.equal(saved.length, 0);
  openFails = false;
  assert.equal((await Store.get("A")).receipts.length, 3, "the failed write never landed");
  assert.equal(backs, 1, "and told when it works again");
});

await test("a write the transaction aborts AFTER its request succeeded rejects and fires no listener (was: resolved, '✓ Saved')", async () => {
  saved.length = 0;
  abortNextWrite = true;
  const e = await Store.put(job("A", 9)).catch((x) => x);
  assert.ok(e instanceof Error || e instanceof DOMException, "rejected");
  assert.equal(saved.length, 0);
  assert.equal((await Store.get("A")).receipts.length, 3);
});

await test("putIf after a lost connection re-checks inside its own transaction", async () => {
  const cur = await Store.get("A");
  killConnection();
  const next = { ...cur, customer: "Alston rd.", updatedAt: "2026-10-21T03:10:00.000Z" };
  assert.equal(await Store.putIf(next, cur.updatedAt), true);
  assert.equal(await Store.putIf({ ...next, customer: "x" }, cur.updatedAt), false, "a second one sees the row moved");
  assert.equal(Store.stampOf("A"), next.updatedAt);
});

await test("autosave: a failed save keeps the edit queued, the pill says Not saved (never stuck on Saving…), the next flush lands it", async () => {
  const pill = document.getElementById("pill");
  const p = await Store.get("A");
  p.receipts.push({ id: "typed", vendor: "Spenard" });
  killConnection(); openFails = true;
  autosave(p, pill);
  assert.equal(pill.textContent, "Saving…");
  await new Promise((r) => setTimeout(r, 450));
  assert.match(pill.textContent, /Not saved/);
  assert.equal(unsavedProject("A"), p, "the router will open this copy, not the older stored one");
  await assert.rejects(flushPending(), (e) => e.code === "storage-lost");
  openFails = false;
  await flushPending();
  assert.equal(pill.textContent, "✓ Saved");
  assert.equal(unsavedProject("A"), null);
  assert.ok((await Store.get("A")).receipts.some((r) => r.id === "typed"));
});

await test("errors a retry cannot help are not retried (quota, clone)", async () => {
  assert.equal(isConnectionLost(new DOMException("x", "QuotaExceededError")), false);
  assert.equal(isConnectionLost(new DOMException("x", "DataCloneError")), false);
  assert.equal(isConnectionLost(new DOMException("Connection to Indexed Database server lost. Refresh the page to try again", "UnknownError")), true);
});

await test("stamps: sync can find what it owes without loading jobs", async () => {
  await Store.put(job("B"));
  const s = new Map(Store.stamps());
  assert.equal(s.get("B"), (await Store.get("B")).updatedAt);
  await Store.del("B", { quiet: true });
  assert.equal(Store.stampOf("B"), undefined);
});

await test("while an edit waits in the save queue, sync's conditional writes refuse (it is the newest copy), and land after it", async () => {
  const p = await Store.get("A");
  const at = p.updatedAt;
  killConnection(); openFails = true;
  p.customer = "typed while storage was down";
  autosave(p, null);
  await new Promise((r) => setTimeout(r, 450));
  openFails = false;
  assert.equal(await Store.putIf({ ...p, customer: "server copy" }, at), false, "putIf");
  assert.equal(await Store.delIf("A", at), false, "delIf");
  await flushPending();
  const now = await Store.get("A");
  assert.equal(now.customer, "typed while storage was down");
  assert.equal(await Store.putIf({ ...now, notes: "merged" }, now.updatedAt), true, "lands once the edit is on disk");
});

await test("deleting a job drops its edit still waiting to save: the retry doesn't write the job back", async () => {
  await Store.put(job("D"));
  const p = await Store.get("D");
  killConnection(); openFails = true;
  p.customer = "edit that never saved";
  autosave(p, null);
  await new Promise((r) => setTimeout(r, 450));
  openFails = false;
  await Store.del("D", { quiet: true });
  assert.equal(unsavedProject("D"), null);
  await flushPending();
  assert.equal(await Store.get("D"), null);
});

await test("a backup cut short by a lost connection keeps every snapshot (only a full disk sheds old ones)", async () => {
  for (let i = 0; i < 10; i++) await Store.backup({ ...job("S"), customer: "v" + i });
  assert.equal((await Store.backups("S")).length, 10);
  // the big snapshot write dies twice (the try and run()'s retry), as if it took the storage process with it
  let fails = 2;
  const tx = P.transaction;
  P.transaction = function (names, mode, ...rest) {
    if (mode === "readwrite" && [].concat(names).includes("backups") && fails > 0) { fails--; dead.add(this); }
    return tx.call(this, names, mode, ...rest);
  };
  const warn = console.warn; console.warn = () => {};    // backup() logs the skip
  await Store.backup({ ...job("S"), customer: "v10" });
  console.warn = warn;
  P.transaction = tx;
  const kept = await Store.backups("S");
  assert.equal(kept.length, 10, "none shed");
  assert.equal(kept[0].data.customer, "v9", "the snapshot that couldn't be written is skipped");
});

await test("one job that can't save (a full disk) doesn't hold up another job's edit: that one lands and says ✓ Saved", async () => {
  await Store.put(job("Q")); await Store.put(job("B2"));
  const OS = globalThis.IDBObjectStore.prototype, put = OS.put;
  OS.put = function (v, ...rest) {
    if (this.name === "projects" && v && v.id === "Q") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return put.call(this, v, ...rest);
  };
  const pillQ = document.createElement("span"), pillB = document.createElement("span");
  const q = await Store.get("Q"); q.customer = "won't fit";
  autosave(q, pillQ);
  await new Promise((r) => setTimeout(r, 450));
  assert.match(pillQ.textContent, /Not saved/);
  const b = await Store.get("B2"); b.customer = "typed in B";
  autosave(b, pillB);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(pillB.textContent, "✓ Saved", "was Saving… for good, behind Q");
  assert.equal(unsavedProject("B2"), null);
  assert.equal((await Store.get("B2")).customer, "typed in B");
  assert.match(pillQ.textContent, /Not saved/);
  assert.equal(unsavedProject("Q"), q);
  await assert.rejects(flushPending(), (e) => e.name === "QuotaExceededError");
  OS.put = put;
  await flushPending();
  assert.equal(pillQ.textContent, "✓ Saved");
  assert.equal((await Store.get("Q")).customer, "won't fit");
});

await new Promise((r) => setTimeout(r, 50));
assert.equal(unhandled.length, 0, "no unhandled rejections: " + unhandled.map(String).join("; "));
console.log(`\n${pass} passed`);
