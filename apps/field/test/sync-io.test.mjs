/* Sync's disk reads on the receipts hot path (apps/field/js/sync.js +
   core.js). Receipt photos live inline in the job on the phone (about a
   megabyte each), and every sync cycle used to load EVERY job on the phone
   twice (push and the thumbnail sweep), and a relaunch that lost its
   bookkeeping wrote a full backup copy of the job for a push the server
   called current. With a few receipts entered back to back, that load is
   the likely reason iOS dropped the app's storage on Oct 20. Now a cycle reads only the
   jobs that changed, an echo settles on its stamp without loading the job,
   and a 'current' answer writes nothing. The fake server is test/sync.mjs's.
   Run: node apps/field/test/sync-io.test.mjs   (from repo root) */
import "fake-indexeddb/auto";
import { mergeProjects } from "../js/merge.js";   // the fake server's merge == the SQL merge (proven equivalent)
import { SYNC_VIA_RPC } from "../js/config.js";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

/* ---- minimal globals ---- */
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

/* ---- fake Supabase server ---- */
const serverRows = new Map();
let onPatch = null;      // test hook: runs while a push PATCH is "in flight"
let clock = 1;
const nowIso = () => new Date(1700000000000 + clock++ * 1000).toISOString();
/* Every body comes back the way Postgres hands out jsonb: object keys sorted
   by length, then bytes — never in the order the client wrote them. A
   client check that reads key order (rather than content) sees a change on
   every server copy and re-pushes forever, the Jul 2026 loop; this keeps
   every case below honest about that. */
const jsonbOrder = (v) => Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === "object"
  ? Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).reduce((o, k) => { o[k] = jsonbOrder(v[k]); return o; }, {}) : v;
const resp = (status, body) => ({ ok: status < 400, status, json: async () => jsonbOrder(body), text: async () => JSON.stringify(jsonbOrder(body)) });

const mediaStore = new Map();   // field-media bucket: hash -> text
let mediaGets = 0;              // GETs that actually went to the "network"
let failUploads = false;        // test hook: make the bucket refuse writes
let onMediaGet = null;          // test hook: runs while a pull is downloading media

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
  if (u.pathname.startsWith("/storage/v1/object/field-media/")) {
    const hash = u.pathname.split("/").pop();
    if (method === "POST" || method === "PUT") {
      if (failUploads) return resp(500, {});          // test hook: storage refuses
      mediaStore.set(hash, opts.body); return resp(200, {});
    }
    mediaGets++;   // counted so a test can prove a pull downloaded NOTHING
    if (onMediaGet) { const f = onMediaGet; onMediaGet = null; await f(); }   // a save lands mid-download
    if (mediaStore.has(hash)) return { ok: true, status: 200, json: async () => ({}), text: async () => mediaStore.get(hash) };
    return resp(404, {});
  }
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.pathname === "/auth/v1/token") {
    return resp(200, { access_token: "tok", refresh_token: "ref", expires_in: 3600, user: { email: body.email } });
  }
  /* ---- sync RPCs: the server-side merge authority (migrations 217/218).
     Mirrors the SQL exactly, including the "strictly newer than both inputs
     and never behind the server clock" merge stamp. ---- */
  // DETERMINISTIC SERVER CLOCK, still a faithful mirror of the SQL. Production
  // is greatest(both inputs)+1ms FLOORED AT now() (218:258-260, 241:270-272) —
  // both halves are kept below; only the clock term is skewed, to model what
  // the field actually looks like: a server whose clock leads a tablet that
  // stamped an edit moments earlier. Reading the bare wall clock here made
  // which branch ran depend on whether a millisecond boundary happened to fall
  // inside the gap between the mid-flight edit and this call, so the case below
  // exercised the dangerous branch only sometimes — rarely on an idle laptop,
  // far more often on a loaded CI runner, which is why CI found it first.
  // This STRENGTHENS the suite: do NOT "fix" a failure here by removing the
  // skew, which pins the test to the branch that accidentally passes and hides
  // a live data-loss path.
  // 37s, not 60s/120s — those two are already used as hand-set row stamps
  // further down this file, and reusing them would couple unrelated scenarios.
  // Overridable so BOTH clock regimes stay covered: CI runs this file again with
  // SYNC_SERVER_SKEW_MS=0, which restores the equal-clock case (union stamp lands
  // exactly one ms past the newest input, the pull tie-guard's boundary) that a
  // fixed skew would otherwise retire. 0 is safe because the `+ 1` below is
  // unconditional, exactly as the SQL is — the fake server can never emit a stamp
  // EQUAL to an input, which the real one cannot do either.
  const SERVER_AHEAD_MS = Number(process.env.SYNC_SERVER_SKEW_MS ?? 37_000);
  const mergeStamp = (a, b) =>
    new Date(Math.max(Math.max(Date.parse(a) || 0, Date.parse(b) || 0) + 1,
                      Date.now() + SERVER_AHEAD_MS)).toISOString();
  // a real request/response crosses the wire as JSON: neither side may hold a
  // reference into the other's objects (the client mutates what it receives)
  const wire = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  // jsonb compares by value, not key order — mirror that when detecting a self-echo
  const canonKeys = (v) => Array.isArray(v) ? v.map(canonKeys)
    : (v && typeof v === "object")
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonKeys(v[k])]))
      : v;
  if (u.pathname === "/rest/v1/rpc/push_project" && method === "POST") {
    if (onPatch) { const f = onPatch; onPatch = null; await f(); }   // an edit lands mid-push
    const id = body.p_id, base = Number(body.p_base_rev) || 0;
    const incoming = wire(body.p_data); delete incoming.rev;
    const row = serverRows.get(id);
    if (!row) {
      serverRows.set(id, { id, data: { ...incoming, rev: 1 }, deleted: false, updated_at: nowIso() });
      return resp(200, { status: "insert", rev: 1 });
    }
    const curRev = Number(row.data && row.data.rev) || 0;
    if (row.deleted) return resp(200, { status: "deleted", rev: curRev, data: wire(row.data) });
    if (curRev === base) {
      row.data = { ...incoming, rev: curRev + 1 };
      row.deleted = false; row.updated_at = nowIso();
      return resp(200, { status: "applied", rev: curRev + 1 });
    }
    const { merged } = mergeProjects(incoming, row.data);
    const strip = ({ rev, updatedAt, ...rest }) => JSON.stringify(canonKeys(rest));
    if (strip(merged) === strip(row.data)) {          // self-echo: write nothing
      return resp(200, { status: "current", rev: curRev, data: wire(row.data) });
    }
    merged.rev = curRev + 1;
    merged.updatedAt = mergeStamp(incoming.updatedAt, row.data.updatedAt);
    row.data = merged; row.deleted = false; row.updated_at = nowIso();
    return resp(200, { status: "merged", rev: merged.rev, data: wire(merged) });
  }
  if (u.pathname === "/rest/v1/rpc/tombstone_project" && method === "POST") {
    const id = body.p_id, row = serverRows.get(id);
    const incoming = body.p_data ? wire(body.p_data) : null;
    if (incoming) delete incoming.rev;
    if (!row) {
      serverRows.set(id, { id, data: incoming || { id }, deleted: true, updated_at: nowIso() });
      return resp(200, { status: "tombstoned", created: true });
    }
    if (row.deleted) return resp(200, { status: "already_deleted" });
    // jsonb measures canonical text (keys sorted), not insertion order
    const len = (v) => JSON.stringify(canonKeys(v || {})).length;
    const keepRicher = incoming && len(incoming) >= len(row.data);
    const kept = keepRicher ? incoming : row.data;    // (do not shadow `body`)
    // HIGH-WATER REV (migration 220): the tombstone carries the highest rev the
    // row ever held, so a later revive can never re-issue a rev a stale device
    // is still holding
    const hw = Math.max(Number(row.data && row.data.rev) || 0,
                        Number(kept && kept.rev) || 0);
    row.data = { ...kept, rev: hw };
    row.deleted = true; row.updated_at = nowIso();
    return resp(200, { status: "tombstoned", rev: hw });
  }
  if (u.pathname === "/rest/v1/rpc/revive_project" && method === "POST") {
    const id = body.p_id, row = serverRows.get(id);
    const incoming = wire(body.p_data); delete incoming.rev;
    if (!row) return resp(200, { status: "missing" });
    const curRev = Number(row.data && row.data.rev) || 0;
    if (!row.deleted) return resp(200, { status: "conflict", rev: curRev, data: wire(row.data) });
    row.data = { ...incoming, rev: curRev + 1 };
    row.deleted = false; row.updated_at = nowIso();
    return resp(200, { status: "revived", rev: curRev + 1 });
  }
  if (u.pathname === "/rest/v1/field_projects" && method === "POST") {
    const out = body.map((r) => {
      const row = { id: r.id, data: r.data, deleted: !!r.deleted, updated_at: nowIso() };
      serverRows.set(r.id, row);
      return row;
    });
    return resp(201, out);
  }
  // rev-guarded PATCH — PostgREST semantics: 0 rows when the guard misses
  if (u.pathname === "/rest/v1/field_projects" && method === "PATCH") {
    if (onPatch) { const f = onPatch; onPatch = null; await f(); }   // simulate an edit landing mid-upload
    const idQ = u.searchParams.get("id") || "";
    const id = idQ.startsWith("eq.") ? idQ.slice(3) : "";
    const revQ = u.searchParams.get("data->>rev");
    const orQ = u.searchParams.get("or");
    const delQ = u.searchParams.get("deleted");               // deleted=eq.false / eq.true filters
    const row = serverRows.get(id);
    let match = false;
    const delOk = !delQ || (delQ === "eq.false" ? !row?.deleted : delQ === "eq.true" ? !!row?.deleted : true);
    if (row && delOk) {
      const rowRev = Number(row.data && row.data.rev) || 0;
      if (revQ && revQ.startsWith("eq.")) match = rowRev === Number(revQ.slice(3));
      else if (orQ) match = rowRev === 0;
      else match = true;                                      // no rev guard (reviveRow) — filter-only PATCH
    }
    if (!match) return resp(200, []);
    row.data = body.data;
    row.deleted = false;
    row.updated_at = nowIso();
    return resp(200, [row]);
  }
  if (u.pathname === "/rest/v1/field_projects" && method === "GET") {
    const idQ = u.searchParams.get("id");
    if (idQ && idQ.startsWith("eq.")) {                       // conflict check / staleness check
      const row = serverRows.get(idQ.slice(3));
      return resp(200, row ? [{ id: row.id, data: row.data, deleted: row.deleted, updated_at: row.updated_at }] : []);
    }
    const raw = u.searchParams.get("updated_at");
    const since = raw && raw.startsWith("gt.") ? raw.slice(3) : "";
    const rows = [...serverRows.values()]
      .filter((r) => !since || r.updated_at > since)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return resp(200, rows);
  }
  return resp(404, {});
};

/* ---- count whole-row IndexedDB reads per phase on a phone that holds many big jobs ---- */
const io = { getAll: 0, get: 0, put: 0, backupsPut: 0, sha: 0 };
const OS = globalThis.IDBObjectStore.prototype;
const og = OS.get, oga = OS.getAll, op = OS.put;
OS.get = function (...a) { if (this.name === "projects") io.get++; return og.apply(this, a); };
OS.getAll = function (...a) { if (this.name === "projects") io.getAll++; return oga.apply(this, a); };
OS.put = function (...a) { if (this.name === "projects") io.put++; if (this.name === "backups") io.backupsPut++; return op.apply(this, a); };
const odig = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (...a) => { io.sha++; return odig(...a); };
const reset = () => { for (const k in io) io[k] = 0; };
const snap = () => ({ ...io });

localStorage.setItem("roybal-sync-rebased-v211", "1");     // a phone that already ran the one-time rebase
const { Store } = await import("../js/core.js");
const { signIn } = await import("../js/supa.js");
const sync1 = await import("../js/sync.js");
sync1.sweepTuning.pauseMs = 0;
sync1.sweepTuning.shrink = async (src) => "data:image/jpeg;base64," + src.slice(-40);
await signIn("crew@roybalconstruction.com", "pw");

const photo = (tag, kb = 60) => "data:image/jpeg;base64," + tag + "A".repeat(kb * 1000);
const receipt = (i) => ({ id: "rc" + i, vendor: "V" + i, amount: "1", photo: photo("R" + i) });
// the fleet a signed-in phone holds: every job on the account
for (let j = 0; j < 8; j++) await Store.put({ id: "job" + j, customer: "J" + j, receipts: [receipt("j" + j + "a"), receipt("j" + j + "b")] }, { quiet: true });
await Store.put({ id: "alston", customer: "Alston", receipts: Array.from({ length: 6 }, (_, i) => receipt("al" + i)) }, { quiet: true });

reset();
await sync1.syncNow();
let s = snap();
ok(s.getAll === 0, `first cycle: no whole-store getAll (full scan is keys + one job at a time) — getAll=${s.getAll}, get=${s.get}`);
ok(serverRows.size === 9, "…and every job reached the server");
await sync1.syncNow();      // own echoes come back

/* one receipt, the way Branden enters it: snap (put), AI read (put), Done (no-op, no put) */
const al = await Store.get("alston");
al.receipts.push(receipt("new1"));
await Store.put(al);
al.receipts.at(-1).vendor = "Spenard";
await Store.put(al);
reset();
await sync1.syncNow();
s = snap();
ok(s.getAll === 0, `receipt cycle: no getAll of every job (was 2 per cycle: push + sweep) — getAll=${s.getAll}`);
ok(s.get === 1, `receipt cycle: exactly one job read (the dirty one) — get=${s.get}`);
ok(s.sha <= 8, `receipt cycle: one deflate of the dirty job only (7 photos, plus thumbs) — sha=${s.sha}`);
reset();
await sync1.syncNow();      // the echo of our own push
s = snap();
ok(s.get === 0 && s.getAll === 0, `echo pull settled on the stamp, nothing loaded — get=${s.get} getAll=${s.getAll}`);
ok(serverRows.get("alston").data.receipts.length === 7, "the receipt is on the server");

/* a write this page did not make (another tab) is still pushed — at the next full scan */
await new Promise((ok2, bad) => {
  const req = indexedDB.open("roybal-field", 3);
  req.onsuccess = () => {
    const d = req.result, t = d.transaction("projects", "readwrite");
    t.objectStore("projects").put({ id: "job3", customer: "J3-other-tab", receipts: [], updatedAt: new Date(Date.now() + 1000).toISOString() });
    t.oncomplete = () => { d.close(); ok2(); }; t.onerror = () => bad(t.error);
  };
});
await sync1.syncNow();
ok(serverRows.get("job3").data.customer === "J3", "another tab's write waits for the full scan (by design)…");
sync1.syncTuning.fullScanMs = 0;
await sync1.syncNow();
sync1.syncTuning.fullScanMs = 10 * 60 * 1000;
ok(serverRows.get("job3").data.customer === "J3-other-tab", "…and the full scan ships it");

/* RELAUNCH WITH LOST BOOKKEEPING (Oct 21: three times): the last localStorage
   writes (revs, pushed) never reached disk. The new context pushes the same
   bytes on a stale base; the server answers 'current'. */
const al2 = await Store.get("alston");
al2.receipts.at(-1).amount = "155.26";
const staleRevs = localStorage.getItem("roybal-sync-revs"), stalePushed = localStorage.getItem("roybal-sync-pushed");
await Store.put(al2);
await sync1.syncNow();                                // applied — then the "crash" loses these two writes:
localStorage.setItem("roybal-sync-revs", staleRevs); localStorage.setItem("roybal-sync-pushed", stalePushed);
const backupsBefore = (await Store.backups("alston")).length;
const revBefore = serverRows.get("alston").data.rev;
const sync2 = await import("../js/sync.js?relaunch=1");   // a fresh JS context reading the stale bookkeeping
reset();
await sync2.syncNow();
s = snap();
ok(serverRows.get("alston").data.rev === revBefore, "the stale push was 'current' (server wrote nothing)");
ok((await Store.backups("alston")).length === backupsBefore && s.backupsPut === 0, `…and no whole-job backup was written for it — backupsPut=${s.backupsPut}`);
ok(s.put === 0, `…and the job was not rewritten — projects.put=${s.put}`);
reset();
await sync2.syncNow();
s = snap();
ok(s.get === 0 && s.put === 0, `…and the next cycle finds it clean — get=${s.get} put=${s.put}`);

/* AN EDIT STUCK IN THE SAVE QUEUE (core.js autosave): its write failed while
   the phone's storage was down, so the disk row looks clean. Sync must not
   land another device's copy under it (the retry would write the old copy
   back over that copy and the next push would erase it on the server), and a
   job deleted meanwhile must not come back with it. */
{
  const { autosave, flushPending, unsavedProject } = await import("../js/core.js");
  const { graftProject } = await import("../js/graft.js");
  let writesDown = false;
  const DBP = globalThis.IDBDatabase.prototype, origTx = DBP.transaction;
  DBP.transaction = function (names, mode, ...rest) {
    if (writesDown && mode === "readwrite") throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
    return origTx.call(this, names, mode, ...rest);
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // app.js: a row sync rewrote is grafted into the job on screen
  let live = null;
  sync2.onSyncRowChanged(async (id) => { if (!live || live.id !== id) return; const fresh = await Store.get(id); if (fresh) graftProject(live, fresh); });

  await Store.put({ id: "queued", customer: "Queued", notes: "", receipts: [{ id: "q1", vendor: "", amount: "", photo: photo("Q1") }] });
  await sync2.syncNow(); await sync2.syncNow();
  live = await Store.get("queued");                       // the receipt editor's job
  writesDown = true;
  live.receipts[0].vendor = "Spenard"; live.receipts[0].amount = "155.26";
  autosave(live, null);
  await settle(450);
  ok(unsavedProject("queued") === live, "the typed receipt waits in the save queue (storage down)");
  const srow = serverRows.get("queued");                  // the office adds a note to the same job
  srow.data = { ...srow.data, notes: "office note", updatedAt: new Date().toISOString(), rev: srow.data.rev + 1 };
  srow.updated_at = new Date().toISOString();
  writesDown = false;                                     // storage back; a sync tick runs before the queue's retry
  await sync2.syncNow();
  await flushPending().catch(() => {});
  for (let i = 0; i < 3; i++) await sync2.syncNow();
  const d = await Store.get("queued"), sv = serverRows.get("queued").data;
  ok(d.receipts[0].vendor === "Spenard" && d.notes === "office note", `both edits on the phone — vendor=${d.receipts[0].vendor} notes=${d.notes}`);
  ok(sv.receipts[0].vendor === "Spenard" && sv.notes === "office note", `both edits on the server — vendor=${sv.receipts[0].vendor} notes=${sv.notes}`);

  // a job deleted while an edit for it still waits to save stays deleted
  await Store.put({ id: "gone", customer: "Delete me", receipts: [{ id: "g1", vendor: "" }] });
  await sync2.syncNow();
  const doomed = await Store.get("gone");
  writesDown = true;
  doomed.receipts[0].vendor = "late edit";
  autosave(doomed, null);
  await settle(450);
  writesDown = false;
  await Store.del("gone");
  await flushPending().catch(() => {});
  await settle(2300);                                     // the queue's own retry timer
  ok((await Store.get("gone")) === null, "a queued edit does not bring a deleted job back");
  DBP.transaction = origTx;
}

console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL SYNC I/O CHECKS PASSED"));
process.exit(failures ? 1 : 0);
