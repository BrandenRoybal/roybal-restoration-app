/* Sync engine test — drives push/pull/merge against a fake Supabase.
   Run: node test/sync.mjs */
import "fake-indexeddb/auto";
import { mergeProjects } from "../js/merge.js";   // the fake server's merge == the SQL merge (proven equivalent)

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
const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const mediaStore = new Map();   // field-media bucket: hash -> text

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
  if (u.pathname.startsWith("/storage/v1/object/field-media/")) {
    const hash = u.pathname.split("/").pop();
    if (method === "POST" || method === "PUT") { mediaStore.set(hash, opts.body); return resp(200, {}); }
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
  const mergeStamp = (a, b) =>
    new Date(Math.max(Math.max(Date.parse(a) || 0, Date.parse(b) || 0) + 1, Date.now())).toISOString();
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
    const keepRicher = incoming && JSON.stringify(incoming).length >= JSON.stringify(row.data || {}).length;
    row.data = keepRicher ? incoming : row.data;
    row.deleted = true; row.updated_at = nowIso();
    return resp(200, { status: "tombstoned" });
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

const { Store } = await import("../js/core.js");
const { signIn, isSignedIn } = await import("../js/supa.js");
const { syncNow, startSync, resetSync } = await import("../js/sync.js");

(async () => {
  await signIn("crew@roybalconstruction.com", "pw");
  ok(isSignedIn(), "sign-in stores a session");

  // local job → push to server
  await Store.put({ id: "p1", customer: "Alpha" });
  await syncNow();
  ok(serverRows.has("p1"), "local job pushes up to the server");

  // another device adds a job → pulls down
  serverRows.set("p2", { id: "p2", data: { id: "p2", customer: "Beta", updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  const beta = await Store.get("p2");
  ok(beta && beta.customer === "Beta", "remote job pulls down to this device");

  // remote edit wins (newer)
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-EDITED", updatedAt: new Date(Date.now() + 9e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-EDITED", "newer remote edit is applied (last-write-wins)");

  // remote delete propagates
  serverRows.set("p2", { id: "p2", data: { id: "p2" }, deleted: true, updated_at: nowIso() });
  await syncNow();
  ok(!(await Store.get("p2")), "remote delete removes the job locally");

  // ---------- media offload: photo-heavy jobs stay under the row cap ----------
  const BIG = "data:image/jpeg;base64," + "P".repeat(80_000);
  await Store.put({ id: "p3", customer: "Gamma", photos: [{ id: "ph1", src: BIG }] });
  await syncNow();
  const row3 = serverRows.get("p3");
  ok(row3 && !JSON.stringify(row3.data).includes("PPPPPPPP"), "photo bytes never reach the job row");
  ok(/^media:[0-9a-f]{64}:\d+$/.test(row3.data.photos[0].src), "row carries a media marker instead");
  ok(mediaStore.size === 1 && [...mediaStore.values()][0] === BIG, "photo uploaded to the field-media bucket");

  // another device's row referencing that media inflates on pull
  serverRows.set("p4", { id: "p4", data: { ...row3.data, id: "p4", customer: "Delta", updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p4")).photos[0].src === BIG, "pulled marker re-inflates to the original photo");

  // ---------- clobber protection ----------
  // equal timestamps: local wins the tie, remote is NOT applied
  const p1 = await Store.get("p1");
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-TIE", updatedAt: p1.updatedAt }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-EDITED", "equal-timestamp remote does not overwrite local work");
  const snapsBefore = (await Store.backups("p1")).length;   // the legit overwrite above already took one

  // a strictly newer (stale-content) copy still wins — but the outgoing
  // local copy is snapshotted to on-device backups first
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-CLOBBER", updatedAt: new Date(Date.now() + 18e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-CLOBBER", "strictly newer remote still applies (last-edit-wins)");
  const snaps = await Store.backups("p1");
  ok(snaps.length === snapsBefore + 1 && snaps[0].data.customer === "Alpha-EDITED", "overwritten copy saved to on-device backups (newest first)");

  // ---------- unresolvable media never blanks a good local copy ----------
  // A good photo lives locally (data URL). A strictly-newer remote references a
  // media hash the bucket can't serve yet (transient auth gap / not-yet-uploaded).
  await Store.put({ id: "p5", customer: "Echo", photos: [{ id: "ph5", src: BIG }] });
  await syncNow();                       // push the good copy up
  const HASH = "a".repeat(64);           // a hash the bucket doesn't have (download → 404 → null)
  const missMarker = `media:${HASH}:${BIG.length}`;
  serverRows.set("p5", { id: "p5", data: { id: "p5", customer: "Echo-NEW", photos: [{ id: "ph5", src: missMarker }], updatedAt: new Date(Date.now() + 27e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p5")).photos[0].src === BIG, "failed media download does NOT overwrite the good local photo");

  // once the object is actually in the bucket, the next sync resolves it
  mediaStore.set(HASH, BIG);
  await syncNow();
  const p5done = await Store.get("p5");
  ok(p5done.customer === "Echo-NEW" && p5done.photos[0].src === BIG, "the row re-inflates and applies once the media is downloadable");

  // ============================================================
  // TWO-DEVICE MERGE — the hardening this suite exists to prove
  // ============================================================

  // ---------- push-conflict merge: a stale writer no longer erases work ----------
  await Store.put({ id: "p6", customer: "Foxtrot", photos: [{ id: "A", src: "small-a" }] });
  await syncNow();                                    // server rev 1, this device clean
  // ANOTHER device (which synced rev 1) adds photo B and pushes rev 2
  const mine6 = await Store.get("p6");
  serverRows.set("p6", { id: "p6", deleted: false, updated_at: nowIso(), data: {
    id: "p6", customer: "Foxtrot", rev: 2, photos: [{ id: "A", src: "small-a" }, { id: "B", src: "small-b" }],
    updatedAt: new Date(Date.parse(mine6.updatedAt) - 60_000).toISOString(),   // their clock even ran EARLIER
  } });
  // meanwhile THIS device (still on rev 1) adds photo C
  const p6 = await Store.get("p6");
  p6.photos.push({ id: "C", src: "small-c" });
  await Store.put(p6, { quiet: true });               // quiet: drive syncNow by hand below
  await syncNow();                                    // pull ties/skips (their updatedAt older), push conflicts → merge
  await syncNow();                                    // second pass pushes the union
  const local6 = await Store.get("p6");
  ok(local6.photos.map((x) => x.id).sort().join("") === "ABC", "push conflict merges BOTH devices' photos locally");
  const server6 = serverRows.get("p6").data;
  ok(server6.photos.map((x) => x.id).sort().join("") === "ABC", "…and the pushed union carries all three to the server");
  ok(Number(server6.rev) === 3, "merged union lands as the next rev (no clobber, no fork)");
  ok((await Store.backups("p6")).length >= 1, "the pre-merge local copy was snapshotted first");

  // ---------- pull merge: dirty local + newer remote = union, not replace ----------
  await Store.put({ id: "p7", customer: "Golf", receipts: [{ id: "R1", amount: 40 }] });
  await syncNow();                                    // server rev 1, clean
  const p7 = await Store.get("p7");
  p7.receipts.push({ id: "R2", amount: 60 });
  await Store.put(p7, { quiet: true });               // dirty local edit
  // a LEGACY device (old app version, unguarded push) overwrote the row with
  // its own newer-clock copy that lacks R2 but adds R3 — rev untouched
  serverRows.set("p7", { id: "p7", deleted: false, updated_at: nowIso(), data: {
    id: "p7", customer: "Golf", rev: 1, receipts: [{ id: "R1", amount: 40 }, { id: "R3", amount: 25 }],
    updatedAt: new Date(Date.now() + 9e5).toISOString(),
  } });
  await syncNow();                                    // pull-first: merge, then push the union
  const local7 = await Store.get("p7");
  ok(local7.receipts.map((x) => x.id).sort().join("") === "R1R2R3", "pull over dirty local merges receipts from both sides");
  ok(serverRows.get("p7").data.receipts.length === 3, "the union pushed back up in the same cycle");

  // ---------- a remote delete must never destroy unsynced local edits ----------
  await Store.put({ id: "p8", customer: "Hotel", photos: [{ id: "H1", src: "h1" }] });
  await syncNow();                                    // server rev 1, clean
  const p8 = await Store.get("p8");
  p8.notes = "unsynced field notes";
  await Store.put(p8, { quiet: true });               // dirty
  serverRows.set("p8", { id: "p8", data: { id: "p8" }, deleted: true, updated_at: nowIso() });  // office deleted the job meanwhile
  await syncNow();
  const local8 = await Store.get("p8");
  ok(!!local8 && local8.notes === "unsynced field notes", "a tombstone does NOT erase a dirty local copy");
  const srv8 = serverRows.get("p8");
  ok(srv8 && srv8.deleted === false && srv8.data.notes === "unsynced field notes", "the dirty copy re-creates the job (edit wins over a stale delete)");
  ok((await Store.backups("p8")).length >= 1, "…and the copy was snapshotted before the tombstone was handled");

  // ---------- an edit typed WHILE a push is in flight survives ----------
  await Store.put({ id: "p9", customer: "India" });
  await syncNow();                                    // rev 1, clean
  const p9 = await Store.get("p9");
  p9.customer = "India-EDIT";
  await Store.put(p9, { quiet: true });               // dirty
  onPatch = async () => {                             // lands during the PATCH round-trip
    const cur = await Store.get("p9");
    cur.notes = "typed during upload";
    await Store.put(cur, { quiet: true });
  };
  await syncNow();
  ok((await Store.get("p9")).notes === "typed during upload", "an edit made mid-push is not reverted (no stale write-back)");
  await syncNow();                                    // it stayed dirty → next cycle ships it
  ok((serverRows.get("p9").data.notes || "") === "typed during upload", "…and it reaches the server on the next cycle");

  // ---------- putIf: the conditional write under absorb ----------
  await Store.put({ id: "p11", customer: "Kilo" }, { quiet: true });
  const cur11 = await Store.get("p11");
  ok(!(await Store.putIf({ ...cur11, customer: "STALE" }, "1999-01-01T00:00:00.000Z")), "putIf refuses when the row moved since the read");
  ok(await Store.putIf({ ...cur11, customer: "FRESH" }, cur11.updatedAt), "putIf lands when updatedAt still matches");
  ok((await Store.get("p11")).customer === "FRESH", "…and the conditional write took effect");

  // ---------- self-echo conflict: a contentless union must NOT re-push ----------
  // (a tab with stale bookkeeping used to bump updatedAt on every no-op merge;
  //  two such tabs fed each other rev+1 every 45 s forever — Jul 2026 incident)
  await Store.put({ id: "p12", customer: "Lima", photos: [{ id: "L1", src: "small-l" }] });
  await syncNow();                                    // server rev 1, clean
  // another tab already pushed the SAME content as rev 2 (a pure echo)…
  const mine12 = await Store.get("p12");
  serverRows.set("p12", { id: "p12", deleted: false, updated_at: nowIso(),
    data: { ...JSON.parse(JSON.stringify(mine12)), rev: 2 } });
  // …while THIS tab still thinks it's on rev 1 and re-saves identical content
  await Store.put(mine12, { quiet: true });           // dirty again, content unchanged
  await syncNow();                                    // push conflicts → absorb sees a self-echo
  await syncNow();                                    // old code re-pushed a contentless rev 3 here
  ok(Number(serverRows.get("p12").data.rev) === 2, "a self-echo conflict does not push a contentless rev");
  const local12 = await Store.get("p12");
  ok(local12.updatedAt === serverRows.get("p12").data.updatedAt, "…the server copy is adopted in place (no dirty bump)");
  ok(local12.customer === "Lima" && local12.photos[0].src === "small-l", "…and the content survives untouched");
  await syncNow();
  ok(Number(serverRows.get("p12").data.rev) === 2, "…and the row stays clean on later cycles (echo loop is dead)");

  // ---------- self-echo pull: identical newer remote over a dirty local ----------
  await Store.put({ id: "p13", customer: "Mike", receipts: [{ id: "M1", amount: 10 }] });
  await syncNow();                                    // server rev 1, clean
  const p13 = await Store.get("p13");
  p13.notes = "same everywhere";
  await Store.put(p13, { quiet: true });              // dirty local edit
  // another tab already pushed EXACTLY this content as rev 2 with a newer stamp
  serverRows.set("p13", { id: "p13", deleted: false, updated_at: nowIso(), data: {
    ...JSON.parse(JSON.stringify(p13)), rev: 2,
    updatedAt: new Date(Date.parse(p13.updatedAt) + 60_000).toISOString(),
  } });
  await syncNow();                                    // pull-merge → absorb sees a self-echo
  await syncNow();                                    // old code re-pushed a contentless rev 3 here
  ok(Number(serverRows.get("p13").data.rev) === 2, "an identical newer remote over a dirty local pushes nothing back");
  const local13 = await Store.get("p13");
  ok(local13.notes === "same everywhere" && local13.updatedAt === serverRows.get("p13").data.updatedAt,
    "…and it is adopted in place as clean");

  // ---------- a job stuck on missing server media goes RED, not green ----------
  let lastStatus = null;
  startSync((s) => { lastStatus = s; });              // wires the status callback (fires one un-awaited cycle)
  await new Promise((r) => setTimeout(r, 60));        // let that cycle finish before driving our own
  await Store.put({ id: "p10", customer: "Juliet" }, { quiet: true });
  await syncNow();                                    // rev 1, clean
  const p10 = await Store.get("p10");
  p10.customer = "Juliet-LOCAL";
  await Store.put(p10, { quiet: true });              // dirty
  const GHOST = "b".repeat(64);                       // referenced by the server copy, absent from the bucket
  serverRows.set("p10", { id: "p10", deleted: false, updated_at: nowIso(), data: {
    id: "p10", customer: "Juliet-REMOTE", rev: 5, photos: [{ id: "G", src: `media:${GHOST}:1234` }],
    updatedAt: new Date(Date.parse(p10.updatedAt) - 60_000).toISOString(),  // older clock → pull skips, push conflicts
  } });
  await syncNow(); await syncNow(); await syncNow();  // three blocked cycles
  ok(!!lastStatus && lastStatus.state === "error" && /waiting on photos/.test(lastStatus.message || ""),
    "3 cycles blocked on missing media turns the status red instead of lying green");
  mediaStore.set(GHOST, "data:image/jpeg;base64,tiny");
  await syncNow();                                    // media exists now → merge lands
  ok(!!lastStatus && lastStatus.state === "synced", "status recovers once the media resolves and the merge lands");
  const merged10 = await Store.get("p10");
  ok(merged10.customer === "Juliet-LOCAL" && (merged10.photos || []).some((x) => x.id === "G"),
    "…and the merge kept our edit AND their photo");

  // ============================================================
  // DELETES THAT STICK + RECOVERABLE TOMBSTONES (Aug 2026 fixes)
  // ============================================================

  // ---------- a delete ships the job's content inside the tombstone ----------
  await Store.put({ id: "t1", customer: "Trash Me", photos: [{ id: "T1", src: "small-t" }] }, { quiet: true });
  await syncNow();                                    // on the server, clean
  const t1 = await Store.get("t1");
  await Store.backup(t1);                             // what deleteProject does before Store.del
  await Store.del("t1");                              // delete listener queues the tombstone
  await syncNow();
  const srvT1 = serverRows.get("t1");
  ok(srvT1 && srvT1.deleted === true, "deleting a job tombstones the server row");
  ok(srvT1.data && srvT1.data.customer === "Trash Me" && srvT1.data.photos[0].id === "T1",
    "…and the tombstone preserves the job's content (server-side recovery exists)");

  // ---------- blank scaffolds stay deleted: the resurrection loop is dead ----------
  // Eight repeat-tap blanks kept coming back: a device with reset bookkeeping
  // (sign-out, evicted localStorage) treated every row as unsynced work, so
  // every pulled tombstone was ignored and every blank re-pushed at base 0.
  await Store.put({ id: "b1", customer: "", address: "", photos: [], dryingLogs: [] }, { quiet: true });
  await syncNow();                                    // pushed, clean
  serverRows.set("b1", { id: "b1", data: { id: "b1" }, deleted: true, updated_at: nowIso() });  // office deletes it
  resetSync();                                        // sign-out: bookkeeping gone, every row now looks dirty
  await syncNow();
  ok(!(await Store.get("b1")), "a deleted blank scaffold does NOT survive a stale-bookkeeping pull");
  ok(serverRows.get("b1").deleted === true, "…and is not pushed back to the server (delete finally sticks)");

  // push path: tombstone is BEHIND the cursor, so only push sees it
  await Store.put({ id: "b2", customer: "", photos: [] }, { quiet: true });   // never synced
  serverRows.set("b2", { id: "b2", data: { id: "b2" }, deleted: true, updated_at: "1970-01-01T00:00:00.000Z" });
  await syncNow();
  ok(!(await Store.get("b2")), "pushing a blank against a tombstone drops the blank instead of reviving it");
  ok(serverRows.get("b2").deleted === true, "…the deleted row stays deleted");

  // ---------- a copy identical to the tombstone's content is not revived ----------
  await Store.put({ id: "t2", customer: "Kept In Trash", receipts: [{ id: "R9", amount: 12 }] }, { quiet: true });
  await syncNow();
  const t2 = await Store.get("t2");
  await Store.backup(t2);
  await Store.del("t2");
  await syncNow();                                    // tombstone (with content) on the server
  ok(serverRows.get("t2").deleted === true && serverRows.get("t2").data.customer === "Kept In Trash",
    "tombstone carries the content");
  const copy = JSON.parse(JSON.stringify(serverRows.get("t2").data));
  delete copy.rev;
  await Store.put(copy, { quiet: true });             // the job re-appears locally, dirty, same content
  await syncNow();
  ok(!(await Store.get("t2")), "a dirty copy holding NOTHING beyond the tombstone's content accepts the delete");
  ok(serverRows.get("t2").deleted === true, "…no resurrection push");

  // ---------- but REAL unsynced work still revives the job (existing promise) ----------
  await Store.put({ id: "t4", customer: "Revive Me" }, { quiet: true });
  await syncNow();
  const t4 = await Store.get("t4");
  t4.receipts = [{ id: "RN", amount: 99 }];           // work the tombstone does NOT have
  await Store.put(t4, { quiet: true });               // dirty
  serverRows.set("t4", { id: "t4", data: { id: "t4" }, deleted: true, updated_at: nowIso() });
  await syncNow();
  const srvT4 = serverRows.get("t4");
  ok(srvT4.deleted === false && srvT4.data.receipts && srvT4.data.receipts[0].id === "RN",
    "unsynced real work still revives a deleted job WITH the work");
  ok(!!(await Store.get("t4")), "…and the local copy stays");

  // ---------- a pending delete survives sign-out ----------
  await Store.put({ id: "t3", customer: "Deleted Offline" }, { quiet: true });
  await syncNow();
  await Store.del("t3");                              // queued, not yet pushed
  resetSync();                                        // sign-out used to wipe the queue → silent un-delete
  await syncNow();
  ok(serverRows.get("t3").deleted === true, "a delete made before sign-out still lands after sign-in");
  ok(!(await Store.get("t3")), "…and a copy re-pulled mid-cycle is dropped, not left to revive the job");

  // ---------- key order differs device vs jsonb — the delete still sticks ----------
  // Postgres jsonb reorders object keys; without canonicalization the
  // content-equality check false-negatives for the device that CREATED the
  // row, and deleted jobs resurrect from it forever (the original incident).
  await Store.put({ id: "t5", customer: "Order Test", receipts: [{ id: "R5", amount: 5 }] }, { quiet: true });
  await syncNow();
  const t5 = await Store.get("t5");
  await Store.backup(t5);
  await Store.del("t5");
  await syncNow();                                    // tombstone carries the content
  const shuffled = { receipts: t5.receipts, customer: t5.customer, id: "t5", createdAt: t5.createdAt, updatedAt: t5.updatedAt };
  await Store.put(shuffled, { quiet: true });         // same content, different key insertion order
  await syncNow();
  ok(!(await Store.get("t5")), "a content-equal copy with DIFFERENT key order still accepts the delete (jsonb reorders keys)");
  ok(serverRows.get("t5").deleted === true, "…and does not resurrect the job");

  // ---------- a STALE queued delete is dropped instead of killing fresh work ----------
  await Store.put({ id: "t6", customer: "Keep Me" }, { quiet: true });
  await syncNow();
  await Store.del("t6");                              // queued now (survives sign-out)
  // meanwhile another device pushes newer work on the same job
  serverRows.set("t6", { id: "t6", deleted: false, updated_at: nowIso(), data: {
    id: "t6", customer: "Keep Me", notes: "fresh crew work", rev: 5,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  await syncNow();
  ok(serverRows.get("t6").deleted === false, "a queued delete older than fresh server work is dropped, not pushed");
  const t6 = await Store.get("t6");
  ok(!!t6 && t6.notes === "fresh crew work", "…and the fresh copy lives on locally");

  // ============================================================
  // ONE STUCK PHOTO JOB NO LONGER BLOCKS EVERY JOB BEHIND IT
  // ============================================================
  const GHOST2 = "c".repeat(64);
  serverRows.set("mA", { id: "mA", data: { id: "mA", customer: "Stuck", photos: [{ id: "S1", src: `media:${GHOST2}:99` }], updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  serverRows.set("mB", { id: "mB", data: { id: "mB", customer: "Behind", updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok(!(await Store.get("mA")), "a row with unreachable media is NOT stored half-broken (no marker garbage on fresh devices)");
  const mB = await Store.get("mB");
  ok(!!mB && mB.customer === "Behind", "…while the row BEHIND it still syncs in the same cycle");
  mediaStore.set(GHOST2, "data:image/jpeg;base64,ok");
  await syncNow();
  const mA = await Store.get("mA");
  ok(!!mA && mA.photos[0].src === "data:image/jpeg;base64,ok", "the stuck row lands intact once its media is reachable");

  console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL SYNC CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
