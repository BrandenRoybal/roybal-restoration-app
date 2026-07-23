/* ============================================================
   Roybal Field Forms — offline-first sync engine
   Local IndexedDB stays the source of truth; this pushes local
   changes up and pulls others' changes down. Concurrent edits
   MERGE instead of clobbering:
   - every push is rev-guarded (the board's data->>rev pattern):
     a device that started from a stale copy gets a CONFLICT back,
     merges the server's copy into its own (merge.js — photos,
     logs, readings, receipts union by id; a filled form beats an
     empty slot), and pushes the union. Crew work can no longer be
     silently erased by whoever's clock ran latest;
   - a pull that lands on top of UNSYNCED local edits merges the
     same way instead of replacing;
   - a remote DELETE never destroys unsynced local edits: the
     dirty copy survives (backed up first) and re-pushes, so the
     job resurrects with the work intact;
   - the row's rev lives in sync-owned bookkeeping (K_REVS), never
     in the project blob: a successful push writes NOTHING back to
     the local row (an edit made while the push was in flight can't
     be reverted), and a form page holding a stale in-memory copy
     can't regress the rev and self-conflict;
   - big media (photos, plan pages, sketches) is offloaded to the
     field-media storage bucket on push and re-inflated on pull,
     so job rows stay far under the 5MB row cap (media.js);
   - before any merge or overwrite, the local copy is snapshotted
     to the on-device backups store (restorable from the job page).
   ============================================================ */
import { Store, onProjectSaved, onProjectDeleted } from "./core.js";
import { isSignedIn, upsertRows, guardedUpsertRow, fetchSince, uploadMedia, downloadMedia } from "./supa.js";
import { deflateProject, inflateProject } from "./media.js";
import { mergeProjects } from "./merge.js";

const K_CURSOR = "roybal-sync-cursor";
const K_PUSHED = "roybal-sync-pushed";     // { projectId: updatedAt last pushed }
const K_REVS = "roybal-sync-revs";         // { projectId: server rev this device is based on }
const K_DELETES = "roybal-sync-deletes";   // [ids pending delete on server ]
const K_MEDIA = "roybal-media-pushed";     // [sha256 hashes known to be in the bucket]
const MAX_ROW = 5_000_000;                 // slimmed rows are ~KBs; this is a last-ditch backstop
const STALL_CYCLES = 3;                    // media-missing retries before the status light goes red

let cursor = localStorage.getItem(K_CURSOR) || "";
let pushed = load(K_PUSHED, {});
let revs = load(K_REVS, {});
let deletes = new Set(load(K_DELETES, []));
let mediaPushed = new Set(load(K_MEDIA, []));
let mediaWait = new Map();                 // projectId -> consecutive cycles blocked on missing bucket media
let statusCb = () => {};
let mergeCb = () => {};                    // fires after a two-device merge (app shows a toast)
let rowCb = () => {};                      // fires when sync changes a stored row (app refreshes open pages)
let syncing = false, started = false, skipped = 0, pushTimer = null, needsAnotherPass = false;

/** Register a listener for "changes from another device were merged in". */
export function onSyncMerge(fn) { mergeCb = fn || (() => {}); }
/** Register a listener for "sync rewrote this stored row" (merge OR clean
    apply) — the app grafts the fresh copy into any open page's in-memory
    project so the next autosave can't write a stale fork back over it. */
export function onSyncRowChanged(fn) { rowCb = fn || (() => {}); }
const rowChanged = (id) => { try { rowCb(id); } catch { /* refresh is a bonus */ } };

/* merge the server's copy into ours, adopt the server's rev, and leave the
   union locally as an UNSYNCED edit — the next pass pushes it guarded on the
   rev we just adopted. Both inputs must be INFLATED (real media, no markers).
   Re-reads the freshest local copy and lands the union with a conditional put,
   so an edit typed while merge media was downloading is merged, not lost. */
async function absorb(localRef, serverFull, why) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = (await Store.get(localRef.id)) || localRef;
    await Store.backup(local);                     // our side, restorable (never throws)
    const { merged, added, filledForms } = mergeProjects(local, serverFull);
    merged.id = localRef.id;
    delete merged.rev;                             // revs live in sync bookkeeping, not the blob
    merged.updatedAt = new Date().toISOString();   // marks it dirty → re-pushes
    if (!(await Store.putIf(merged, local.updatedAt))) continue;   // an edit just landed — redo against it
    revs[localRef.id] = Number(serverFull.rev) || 0; saveRevs();
    mediaWait.delete(localRef.id);
    needsAnotherPass = true;
    if (added || filledForms) {                    // a self-echo merge recovers nothing — no toast for those
      try { mergeCb({ id: localRef.id, customer: merged.customer || merged.address || "job", added, filledForms, why }); } catch { /* toast is a bonus */ }
    }
    rowChanged(localRef.id);
    return merged;
  }
  return null;   // constant editing beat us 4 times — row stays dirty, next cycle retries
}

function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
const savePushed = () => localStorage.setItem(K_PUSHED, JSON.stringify(pushed));
const saveRevs = () => localStorage.setItem(K_REVS, JSON.stringify(revs));
const saveDeletes = () => localStorage.setItem(K_DELETES, JSON.stringify([...deletes]));
const saveCursor = () => localStorage.setItem(K_CURSOR, cursor);
const saveMediaPushed = () => localStorage.setItem(K_MEDIA, JSON.stringify([...mediaPushed].slice(-3000)));
function bumpCursor(ts) { if (ts && ts > cursor) { cursor = ts; saveCursor(); } }

function setStatus(state, extra = {}) { statusCb({ state, pending: pendingCount(), skipped, ...extra }); }
function pendingCount() { return deletes.size; }   // approximate; recomputed on demand

/* a media object we just downloaded provably exists in the bucket — remember
   that so a later push of the same content skips the re-upload */
async function downloadRemembered(hash) {
  const text = await downloadMedia(hash);
  if (text != null && !mediaPushed.has(hash)) { mediaPushed.add(hash); saveMediaPushed(); }
  return text;
}

/* ---------- push local changes (rev-guarded) ---------- */
async function push() {
  const all = await Store.all();
  let skippedNow = 0, lastErr = null;
  for (const p of all) {
    if (pushed[p.id] === p.updatedAt) continue;        // already up to date
    try {
      const { slim, media } = await deflateProject(p);
      for (const m of media) {
        if (mediaPushed.has(m.hash)) continue;         // content-addressed — already in the bucket
        await uploadMedia(m.hash, m.text);
        mediaPushed.add(m.hash); saveMediaPushed();
      }
      const base = Number(revs[p.id] ?? p.rev) || 0;   // p.rev: legacy fallback for rows pulled before K_REVS
      const next = { ...slim, rev: base + 1 };
      const json = JSON.stringify(next);
      if (json.length > MAX_ROW) { skippedNow++; continue; } // huge even without media — surfaced LOUD in status
      const r = await guardedUpsertRow(p.id, base, next);
      if (r.ok) {
        // NOTE: nothing is written back to the local row. The new rev goes to
        // sync bookkeeping only — an edit the user typed while this push was
        // in flight stays in the store untouched (still dirty vs pushed[],
        // so it goes up next cycle on the rev we just recorded).
        revs[p.id] = base + 1; saveRevs();
        pushed[p.id] = p.updatedAt; savePushed();
        mediaWait.delete(p.id);
        continue;
      }
      // conflict: another device moved the row since we last synced.
      // NEVER clobber, NEVER drop — merge their copy into ours and let the
      // next pass push the union guarded on the rev we just adopted.
      if (!r.server) continue;                         // insert race — pull will bring their row
      let serverFull, missing;
      const localMedia = new Map(media.map((m) => [m.hash, m.text]));  // their row may reference OUR photos — reuse, don't re-download
      try { ({ project: serverFull, missing } = await inflateProject(r.server, (h) => localMedia.has(h) ? localMedia.get(h) : downloadRemembered(h))); }
      catch { lastErr = new Error("merge media fetch failed"); continue; }
      if (missing > 0) {                               // their media still propagating — retry next cycle
        mediaWait.set(p.id, (mediaWait.get(p.id) || 0) + 1);   // …but surface it if it never resolves
        continue;
      }
      await absorb(p, serverFull, "push-conflict");
    } catch (e) {
      lastErr = e;   // one failing job (network blip mid-cycle) must not stall the rest
    }
  }
  skipped = skippedNow;
  for (const id of [...deletes]) {
    try {
      await upsertRows([{ id, data: { id }, deleted: true }]);
      deletes.delete(id); delete pushed[id]; delete revs[id];
      saveDeletes(); savePushed(); saveRevs();
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  // NOTE: the cursor is NOT advanced from push responses. Our own row's
  // server timestamp is "now" — jumping the cursor there would skip rows
  // other devices changed in the meantime. Pull walks everything instead
  // (our own echoes fall out of the local-wins-on-tie guard below).
}

/* ---------- pull others' changes ---------- */
async function pull() {
  const rows = await fetchSince(cursor);
  for (const row of rows) {
    if (row.deleted) {
      const local = await Store.get(row.id);
      if (local && pushed[row.id] !== local.updatedAt) {
        // this device holds UNSYNCED work on the job — a tombstone must not
        // eat it. Keep the dirty copy (snapshotted anyway); push re-creates
        // the job, so an edit wins over a stale delete.
        await Store.backup(local);
        revs[row.id] = 0; saveRevs();      // tombstone rows carry no rev — re-assert from base 0
        bumpCursor(row.updated_at);
        continue;
      }
      if (local) await Store.backup(local);  // clean delete — keep a restorable snapshot
      await Store.del(row.id, { quiet: true });
      delete pushed[row.id]; delete revs[row.id]; saveRevs();
      mediaWait.delete(row.id);
      rowChanged(row.id);
      bumpCursor(row.updated_at);
      continue;
    }
    const remote = row.data;
    if (!remote || !remote.id) { bumpCursor(row.updated_at); continue; }
    const local = await Store.get(row.id);
    // local wins ties: only a STRICTLY newer remote may touch local work
    if (local && (remote.updatedAt || "") <= (local.updatedAt || "")) { bumpCursor(row.updated_at); continue; }
    let full, missing;
    try {
      ({ project: full, missing } = await inflateProject(remote, downloadRemembered));
    } catch {
      break;   // media fetch failed (network) — retry this row from the same cursor next cycle
    }
    // Some referenced media (photos, plan pages) came back empty — a transient
    // auth gap, or objects still propagating just after another device uploaded
    // them. NEVER overwrite a good local copy with blank markers and advance past
    // it (that stranded photos on desktop until a full re-pull). Leave the cursor
    // put and retry this row next cycle; it resolves once the downloads succeed.
    if (missing > 0 && local) {
      mediaWait.set(row.id, (mediaWait.get(row.id) || 0) + 1);   // goes red if it never resolves
      break;
    }
    const localDirty = local && pushed[row.id] !== local.updatedAt;   // unsynced edits on this device
    if (localDirty) {
      // both sides moved — merge, never replace (backs up our copy first)
      await absorb(local, full, "pull-merge");
    } else {
      if (local) await Store.backup(local); // safety net: the outgoing copy stays restorable on-device
      delete full.rev;                      // revs live in sync bookkeeping, not the blob
      await Store.put(full, { quiet: true, bump: false });
      revs[row.id] = Number(remote.rev) || 0; saveRevs();
      pushed[row.id] = remote.updatedAt;             // local now matches server
      mediaWait.delete(row.id);
      rowChanged(row.id);
    }
    bumpCursor(row.updated_at);
  }
  savePushed();
}

/* ---------- run a full sync cycle ---------- */
export async function syncNow() {
  if (!isSignedIn() || syncing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) { setStatus("offline"); return; }
  syncing = true; setStatus("syncing");
  try {
    // PULL FIRST: absorb (and merge) everyone else's changes before asserting
    // ours — a device coming back from the field folds the office's edits in,
    // then pushes the union. Also shields rollout: a not-yet-updated device
    // still pushing unguarded rows gets merged here instead of overwritten by
    // our next guarded push. (Trade-off: a just-deleted job can transiently
    // reappear locally for one cycle; the next pull removes it.)
    await pull();
    await push();
    // both of these mean DATA NOT BACKED UP — show red, not a quiet counter
    const stalled = [...mediaWait.values()].filter((n) => n >= STALL_CYCLES).length;
    const problems = [];
    if (skipped > 0) problems.push(`${skipped} job(s) too large to back up — remove some inline attachments`);
    if (stalled > 0) problems.push(`${stalled} job(s) waiting on photos another device hasn't finished uploading`);
    if (problems.length) setStatus("error", { message: problems.join("; ") });
    else setStatus("synced", { lastSync: Date.now() });
  } catch (e) {
    setStatus("error", { message: String(e && e.message || e) });
  } finally {
    syncing = false;
    if (needsAnotherPass) { needsAnotherPass = false; schedulePush(); }  // push freshly merged unions
  }
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 1500);
}

/* ---------- lifecycle ---------- */
export function startSync(onStatus) {
  statusCb = onStatus || (() => {});
  if (started) { syncNow(); return; }
  started = true;

  onProjectSaved(() => schedulePush());
  onProjectDeleted((id) => { deletes.add(id); saveDeletes(); schedulePush(); });

  if (typeof window !== "undefined") {
    window.addEventListener("online", syncNow);
    window.addEventListener("offline", () => setStatus("offline"));
    setInterval(() => { if (isSignedIn()) syncNow(); }, 45000);  // catch others' changes
  }
  syncNow();
}

/* clear sync bookkeeping on sign-out (local job data is kept) */
export function resetSync() {
  cursor = ""; pushed = {}; revs = {}; deletes = new Set(); mediaPushed = new Set(); mediaWait = new Map(); skipped = 0;
  localStorage.removeItem(K_CURSOR);
  localStorage.removeItem(K_PUSHED);
  localStorage.removeItem(K_REVS);
  localStorage.removeItem(K_DELETES);
  localStorage.removeItem(K_MEDIA);
}
