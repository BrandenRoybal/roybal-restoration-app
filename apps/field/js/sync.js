/* ============================================================
   Roybal Field Forms — offline-first sync engine
   Local IndexedDB stays the source of truth; this pushes local
   changes up and pulls others' changes down. Last edit wins,
   with two protections:
   - big media (photos, plan pages, sketches) is offloaded to the
     field-media storage bucket on push and re-inflated on pull,
     so job rows stay far under the 5MB row cap and photo-heavy
     jobs never silently stop backing up (media.js);
   - before a pulled row overwrites a local job, the local copy is
     snapshotted to the on-device backups store (restorable from
     the job page) — a stale copy from another device can no
     longer permanently destroy newer work.
   ============================================================ */
import { Store, onProjectSaved, onProjectDeleted } from "./core.js";
import { isSignedIn, upsertRows, fetchSince, uploadMedia, downloadMedia } from "./supa.js";
import { deflateProject, inflateProject } from "./media.js";

const K_CURSOR = "roybal-sync-cursor";
const K_PUSHED = "roybal-sync-pushed";     // { projectId: updatedAt last pushed }
const K_DELETES = "roybal-sync-deletes";   // [ids pending delete on server ]
const K_MEDIA = "roybal-media-pushed";     // [sha256 hashes known to be in the bucket]
const MAX_ROW = 5_000_000;                 // slimmed rows are ~KBs; this is a last-ditch backstop

let cursor = localStorage.getItem(K_CURSOR) || "";
let pushed = load(K_PUSHED, {});
let deletes = new Set(load(K_DELETES, []));
let mediaPushed = new Set(load(K_MEDIA, []));
let statusCb = () => {};
let syncing = false, started = false, skipped = 0, pushTimer = null;

function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
const savePushed = () => localStorage.setItem(K_PUSHED, JSON.stringify(pushed));
const saveDeletes = () => localStorage.setItem(K_DELETES, JSON.stringify([...deletes]));
const saveCursor = () => localStorage.setItem(K_CURSOR, cursor);
const saveMediaPushed = () => localStorage.setItem(K_MEDIA, JSON.stringify([...mediaPushed].slice(-3000)));
function bumpCursor(ts) { if (ts && ts > cursor) { cursor = ts; saveCursor(); } }

function setStatus(state, extra = {}) { statusCb({ state, pending: pendingCount(), skipped, ...extra }); }
function pendingCount() { return deletes.size; }   // approximate; recomputed on demand

/* ---------- push local changes ---------- */
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
      const json = JSON.stringify(slim);
      if (json.length > MAX_ROW) { skippedNow++; continue; } // huge even without media — surfaced in status
      await upsertRows([{ id: p.id, data: slim, deleted: false }]);
      pushed[p.id] = p.updatedAt; savePushed();
    } catch (e) {
      lastErr = e;   // one failing job (network blip mid-cycle) must not stall the rest
    }
  }
  skipped = skippedNow;
  for (const id of [...deletes]) {
    try {
      await upsertRows([{ id, data: { id }, deleted: true }]);
      deletes.delete(id); delete pushed[id]; saveDeletes(); savePushed();
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
      await Store.del(row.id, { quiet: true });
      delete pushed[row.id];
      bumpCursor(row.updated_at);
      continue;
    }
    const remote = row.data;
    if (!remote || !remote.id) { bumpCursor(row.updated_at); continue; }
    const local = await Store.get(row.id);
    // local wins ties: only a STRICTLY newer remote may replace local work
    if (local && (remote.updatedAt || "") <= (local.updatedAt || "")) { bumpCursor(row.updated_at); continue; }
    let full, missing;
    try {
      ({ project: full, missing } = await inflateProject(remote, downloadMedia));
    } catch {
      break;   // media fetch failed (network) — retry this row from the same cursor next cycle
    }
    // Some referenced media (photos, plan pages) came back empty — a transient
    // auth gap, or objects still propagating just after another device uploaded
    // them. NEVER overwrite a good local copy with blank markers and advance past
    // it (that stranded photos on desktop until a full re-pull). Leave the cursor
    // put and retry this row next cycle; it resolves once the downloads succeed.
    if (missing > 0 && local) break;
    if (local) await Store.backup(local);   // safety net: the outgoing copy stays restorable on-device
    await Store.put(full, { quiet: true, bump: false });
    pushed[row.id] = remote.updatedAt;               // local now matches server
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
    await push();
    await pull();
    setStatus("synced", { lastSync: Date.now() });
  } catch (e) {
    setStatus("error", { message: String(e && e.message || e) });
  } finally {
    syncing = false;
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
  cursor = ""; pushed = {}; deletes = new Set(); mediaPushed = new Set(); skipped = 0;
  localStorage.removeItem(K_CURSOR);
  localStorage.removeItem(K_PUSHED);
  localStorage.removeItem(K_DELETES);
  localStorage.removeItem(K_MEDIA);
}
