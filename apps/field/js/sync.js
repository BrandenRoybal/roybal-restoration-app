/* ============================================================
   Roybal Field Forms — offline-first sync engine
   Local IndexedDB stays the source of truth; this pushes local
   changes up and pulls others' changes down. Last edit wins.
   ============================================================ */
import { Store, onProjectSaved, onProjectDeleted } from "./core.js";
import { isSignedIn, upsertRows, fetchSince } from "./supa.js";

const K_CURSOR = "roybal-sync-cursor";
const K_PUSHED = "roybal-sync-pushed";     // { projectId: updatedAt last pushed }
const K_DELETES = "roybal-sync-deletes";   // [ids pending delete on server ]
const MAX_ROW = 5_000_000;                 // skip >5MB rows for now (media → storage later)

let cursor = localStorage.getItem(K_CURSOR) || "";
let pushed = load(K_PUSHED, {});
let deletes = new Set(load(K_DELETES, []));
let statusCb = () => {};
let syncing = false, started = false, skipped = 0, pushTimer = null;

function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
const savePushed = () => localStorage.setItem(K_PUSHED, JSON.stringify(pushed));
const saveDeletes = () => localStorage.setItem(K_DELETES, JSON.stringify([...deletes]));
const saveCursor = () => localStorage.setItem(K_CURSOR, cursor);
function bumpCursor(ts) { if (ts && ts > cursor) { cursor = ts; saveCursor(); } }

function setStatus(state, extra = {}) { statusCb({ state, pending: pendingCount(), skipped, ...extra }); }
function pendingCount() { return deletes.size; }   // approximate; recomputed on demand

/* ---------- push local changes ---------- */
async function push() {
  const all = await Store.all();
  for (const p of all) {
    if (pushed[p.id] === p.updatedAt) continue;        // already up to date
    const json = JSON.stringify(p);
    if (json.length > MAX_ROW) { skipped++; continue; } // too big until media→storage
    const out = await upsertRows([{ id: p.id, data: p, deleted: false }]);
    pushed[p.id] = p.updatedAt; savePushed();
    if (out[0] && out[0].updated_at) bumpCursor(out[0].updated_at);
  }
  for (const id of [...deletes]) {
    const out = await upsertRows([{ id, data: { id }, deleted: true }]);
    deletes.delete(id); delete pushed[id]; saveDeletes(); savePushed();
    if (out[0] && out[0].updated_at) bumpCursor(out[0].updated_at);
  }
}

/* ---------- pull others' changes ---------- */
async function pull() {
  const rows = await fetchSince(cursor);
  for (const row of rows) {
    bumpCursor(row.updated_at);
    if (row.deleted) {
      await Store.del(row.id, { quiet: true });
      delete pushed[row.id];
      continue;
    }
    const remote = row.data;
    if (!remote || !remote.id) continue;
    const local = await Store.get(row.id);
    if (!local || (remote.updatedAt || "") >= (local.updatedAt || "")) {
      await Store.put(remote, { quiet: true, bump: false });
      pushed[row.id] = remote.updatedAt;               // local now matches server
    }
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
  cursor = ""; pushed = {}; deletes = new Set(); skipped = 0;
  localStorage.removeItem(K_CURSOR);
  localStorage.removeItem(K_PUSHED);
  localStorage.removeItem(K_DELETES);
}
