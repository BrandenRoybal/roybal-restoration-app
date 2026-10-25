/* ============================================================
   Roybal Field Forms — core utilities
   DOM helpers, IndexedDB persistence, signature/sketch pads,
   psychrometric (GPP) math. No build step, no dependencies.
   ============================================================ */

/* ---------- tiny DOM helper (hyperscript) ---------- */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/* Drop control characters from a single-line field value. Barcode scanners and
   PDF pastes smuggle in C0/C1 bytes (a live job carries "100250382\b \b" as its
   claim #) — invisible on screen, but they break every downstream text match
   and ride out to the Board, the spine, and the email lane. Nothing typed into
   a one-line input can legitimately be a control char, so drop them on write.
   NOT trimmed: a trailing space is the user mid-word, not junk. Pure. */
export const stripCtrl = (v) => String(v ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

/* ---------- shared network belief ----------
   navigator.onLine has FALSE NEGATIVES: a home-screen app woken from sleep can
   report offline on perfect wifi and never fire "online" again. Every offline
   gate in this app used to read that flag directly, so one stuck flag disabled
   sync, AI, voice and photo moves at once, with no way back from inside the
   app (reported from the office, Aug 2026).
   The flag is now only half the answer: any request that actually SUCCEEDS
   stamps proof here, and recent proof outranks the flag. Gates ask
   likelyOffline() — "the flag says offline AND nothing has worked lately" —
   so a lie expires instead of stranding the device. */
const NET_PROOF_MS = 5 * 60 * 1000;
let lastNetOk = 0;
/** Record that a real request just succeeded — evidence we have a network. */
export function noteNetworkOk() { lastNetOk = Date.now(); }
/** Best guess, evidence first. Never treat as proof of being offline. */
export function likelyOffline() {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return false;
  return Date.now() - lastNetOk > NET_PROOF_MS;
}

/* ---------- ids / dates / money ---------- */
export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const nowLocalISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const money = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

/* ---------- IndexedDB store ("projects" + on-device "backups" + the
   "media_queue" of clips waiting to upload) ----------
   THE CONNECTION HEALS. On an iPhone the database lives in a separate WebKit
   process, and iOS can kill that process while the page stays alive (Oct 2026,
   a receipts session on a 30 MB job: four times in ten minutes). WebKit then
   fails every request on the old handle ("Connection to Indexed Database server
   lost" / "The database connection is closing.") and this module used to keep
   that dead handle forever: every save failed, "Saving…" never cleared and the
   app looked frozen until it was killed. Now a lost connection is dropped,
   reopened and the operation tried ONCE more; if that fails too the app is
   told (onStorageLost) so it can say so and offer a reload.
   EVERY WRITE RESOLVES ON COMMIT (transaction complete), not on request
   success: a write the storage process aborts after the request succeeded
   used to be reported saved — listeners fired, the pill said ✓ Saved — and
   the receipt quietly never existed. */
const DB_NAME = "roybal-field";
const DB_VERSION = 3;          // 3: media_queue (Walkthrough V1). Bump = onupgradeneeded on every installed phone: add stores, never drop.
const STORE = "projects";
const BACKUPS = "backups";
export const MEDIA_STORE = "media_queue";
let _db = null, _opening = null;
function db() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(BACKUPS)) d.createObjectStore(BACKUPS, { keyPath: "id" });
      if (!d.objectStoreNames.contains(MEDIA_STORE)) {
        const m = d.createObjectStore(MEDIA_STORE, { keyPath: "id" });
        m.createIndex("projectId", "projectId", { unique: false });
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      // the browser closed it under us (storage process gone, or cleared):
      // forget it, so the next operation opens a fresh one
      d.onclose = () => { if (_db === d) _db = null; };
      _db = d; resolve(d);
    };
    req.onerror = () => reject(req.error);
    // another tab holds the old version open: don't hang — the reload picks it up
    req.onblocked = () => reject(new Error("The app is open in another tab on an older version. Close it and reopen."));
  });
  const p = _opening;
  p.then(() => { if (_opening === p) _opening = null; }, () => { if (_opening === p) _opening = null; });
  return p;
}
/* The errors a dead connection produces. InvalidStateError: a transaction
   asked of a closing/closed handle. UnknownError: WebKit's "server lost" (and
   genuine I/O trouble, for which one reopen is the right first move too).
   QuotaExceededError / ConstraintError / DataCloneError are NOT here: a retry
   cannot help them and they must reach the caller as they are. */
export function isConnectionLost(e) {
  if (!e) return false;
  if (e.name === "InvalidStateError" || e.name === "UnknownError") return true;
  return /connection.*(lost|closing|closed)|database.*closed/i.test(String(e.message || ""));
}
function dropConnection() {
  const d = _db; _db = null;
  try { d && d.close(); } catch { /* already gone */ }
}
const _lostFns = [], _backFns = [];
let _storageLost = false;
/** fn(error): the store failed even after a reopen — the app should say so. */
export function onStorageLost(fn) { _lostFns.push(fn); }
/** fn(): a store operation succeeded again after onStorageLost. */
export function onStorageBack(fn) { _backFns.push(fn); }
export const storageLost = () => _storageLost;
function markLost(e) {
  if (_storageLost) return;
  _storageLost = true;
  _lostFns.forEach((f) => { try { f(e); } catch {} });
}
function markBack() {
  if (!_storageLost) return;
  _storageLost = false;
  _backFns.forEach((f) => { try { f(); } catch {} });
}
/* One transaction. `body(t, setResult)` issues the requests; the promise
   settles when the TRANSACTION does — complete → the result, abort → its
   error (the request's own error when the transaction carries none). */
function attempt(names, mode, body) {
  return db().then((d) => new Promise((resolve, reject) => {
    let t;
    try { t = d.transaction(names, mode); } catch (e) { reject(e); return; }
    let out, reqErr = null;
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error || reqErr || new DOMException("The save was abandoned.", "AbortError"));
    t.onerror = (ev) => { reqErr = reqErr || (ev && ev.target && ev.target.error) || null; };
    try { body(t, (v) => { out = v; }); }
    catch (e) { try { t.abort(); } catch {} reject(e); }
  }));
}
/* attempt, and once more on a fresh connection when the first failed because
   the connection died. Safe to repeat: every write here is a put/delete by key
   (idempotent), and the conditional ones re-check inside their own
   transaction — a first attempt that did land makes the second answer "moved"
   (false), which every caller already treats as "try again next cycle". */
async function run(names, mode, body) {
  let v;
  try { v = await attempt(names, mode, body); }
  catch (e) {
    if (!isConnectionLost(e)) throw e;
    dropConnection();
    try { v = await attempt(names, mode, body); }
    catch (e2) {
      if (isConnectionLost(e2)) {
        dropConnection();
        markLost(e2);
        throw Object.assign(new Error("This phone's storage stopped responding (" + (e2.message || e2.name) + ")."), { code: "storage-lost", cause: e2 });
      }
      throw e2;
    }
  }
  markBack();
  return v;
}
const req1 = (r, set, map = (x) => x) => { r.onsuccess = () => set(map(r.result)); };

/* ---------- backup snapshot keys ----------
   One record per snapshot, keyed "<job id>#<takenAt>#<bytes>" in the backups
   store, so a job's snapshots are found, ordered and pruned from their KEYS
   (getAllKeys) without loading a single copy. A key is read from the right,
   and a job's range is filtered to its own id, so an id holding "#" cannot
   claim another job's snapshots. A record from before the split is keyed by
   the bare job id, which sorts below the range. */
const SNAP_SEP = "#";
export const SNAP_MAX = 10;                       // newest snapshots kept per job…
export const SNAP_BUDGET = 64 * 1024 * 1024;      // …while their estimated size fits this…
export const SNAP_MIN = 2;                        // …but never fewer than the newest two
const snapRange = (id) => IDBKeyRange.bound(id + SNAP_SEP, id + SNAP_SEP + "\uffff");
export const snapKey = (id, takenAt, bytes) => [id, takenAt, bytes].join(SNAP_SEP);
export function parseSnapKey(key) {
  const parts = String(key).split(SNAP_SEP);
  const bytes = Number(parts.pop()) || 0;
  const takenAt = parts.pop() || "";
  return { key: String(key), jobId: parts.join(SNAP_SEP), takenAt, bytes };
}
/* the job's own snapshot keys out of a range read, newest first (takenAt is a
   fixed-width ISO stamp, so key order is time order) */
export const ownSnapKeys = (id, keys) =>
  (keys || []).map(String).filter((k) => parseSnapKey(k).jobId === id).sort().reverse();
/* The keys (newest first) that fall outside the retention line: past `max`,
   or past `min` once the running size passes `budget`. */
export function snapVictims(keysNewestFirst, max = SNAP_MAX, budget = SNAP_BUDGET, min = SNAP_MIN) {
  let total = 0;
  return keysNewestFirst.filter((k, i) => {
    total += parseSnapKey(k).bytes;
    return i >= max || (i >= min && total > budget);
  });
}
/* Rough in-memory size of a job: the length of every string in it (inline
   photos are nearly all of it). A walk, not JSON.stringify — stringifying a
   100 MB job just to measure it would hold a second copy of it in memory. */
export function approxBytes(node) {
  if (typeof node === "string") return node.length;
  if (!node || typeof node !== "object") return 8;
  let n = 0;
  if (Array.isArray(node)) { for (const v of node) n += approxBytes(v); return n; }
  for (const k in node) n += k.length + approxBytes(node[k]);
  return n;
}
const isQuotaError = (e) => !!e && (e.name === "QuotaExceededError" || e.code === 22);

/* save/delete listeners — the sync engine subscribes to push changes up */
const _savedFns = [], _deletedFns = [];
export function onProjectSaved(fn) { _savedFns.push(fn); }
export function onProjectDeleted(fn) { _deletedFns.push(fn); }

/* updatedAt of every row this page has read or written, by id. Lets the sync
   engine find what it owes the server WITHOUT loading every job (a phone holds
   every job on the account: 200+ MB of inline media in Oct 2026, and two
   whole-store reads per sync cycle were the moments iOS killed its storage).
   Exact for this page's own writes — all of them pass through Store below;
   another tab's writes show up at the next full scan (sync.js). */
const _stamps = new Map();
const stampRow = (p) => { if (p && p.id != null) _stamps.set(p.id, p.updatedAt || ""); };

export const Store = {
  async all() {
    const rows = await run(STORE, "readonly", (t, set) => req1(t.objectStore(STORE).getAll(), set, (x) => x || []));
    rows.forEach(stampRow);
    return rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  },
  /** Every job id — keys only, no job is loaded. */
  async keys() {
    return run(STORE, "readonly", (t, set) => req1(t.objectStore(STORE).getAllKeys(), set, (x) => x || []));
  },
  async get(id) {
    const row = await run(STORE, "readonly", (t, set) => req1(t.objectStore(STORE).get(id), set, (x) => x || null));
    if (row) stampRow(row); else _stamps.delete(id);
    return row;
  },
  /** updatedAt of a row as this page last saw it (undefined = not seen). */
  stampOf(id) { return _stamps.get(id); },
  /** [id, updatedAt] for every row this page has seen. */
  stamps() { return [..._stamps]; },
  /* opts.bump:false keeps the existing updatedAt; opts.quiet:true skips
     listeners (used by sync when writing rows pulled from the server).
     A bump is STRICTLY MONOTONIC: an edit in the same millisecond as the
     previous save still advances updatedAt, so sync's dirty-check
     (pushed[id] !== updatedAt) can never mistake a fresh edit for clean.
     Resolves once the write is COMMITTED; listeners fire only then. */
  async put(project, opts = {}) {
    if (opts.bump !== false) {
      const prev = Date.parse(project.updatedAt) || 0;
      project.updatedAt = new Date(Math.max(Date.now(), prev + 1)).toISOString();
    }
    await run(STORE, "readwrite", (t) => { t.objectStore(STORE).put(project); });
    stampRow(project);
    if (!opts.quiet) _savedFns.forEach((f) => { try { f(project); } catch {} });
    return project;
  },
  async del(id, opts = {}) {
    // a deleted job's edit still waiting to save (autosave below) must not
    // write the job back: let a save in flight finish, then drop the rest
    await saveChain;
    _unsaved.delete(id);
    await run(STORE, "readwrite", (t) => { t.objectStore(STORE).delete(id); });
    _stamps.delete(id);
    if (!opts.quiet) _deletedFns.forEach((f) => { try { f(id); } catch {} });
  },

  /* conditional put: only lands if the stored row's updatedAt still matches
     what the caller read (get+put in ONE transaction, so a concurrent save
     can't slip between them). Quiet by design — sync-engine use only.
     Returns true when the write landed, false when the row moved. An edit
     still in the save queue (autosave below) counts as the row having moved:
     it is the newest copy of the job even though it hasn't reached the disk,
     and the sync write would otherwise land under it — then be overwritten
     by the queued save (or grafted over it on screen). */
  async putIf(project, expectedUpdatedAt) {
    if (_unsaved.has(project.id)) return false;
    const landed = await run(STORE, "readwrite", (t, set) => {
      const os = t.objectStore(STORE);
      const g = os.get(project.id);
      g.onsuccess = () => {
        const cur = g.result;
        if ((cur ? cur.updatedAt : undefined) !== expectedUpdatedAt) { set(false); if (cur) stampRow(cur); return; }
        os.put(project); set(true);
      };
    });
    if (landed) stampRow(project);
    return landed;
  },

  /* conditional delete: only removes the row if its updatedAt still matches
     what the caller last read — an edit that landed in between keeps the row
     (get+delete in ONE transaction). Quiet by design — sync-engine use only.
     Returns true when the delete landed, false when the row moved (or an
     edit is still in the save queue, as for putIf). */
  async delIf(id, expectedUpdatedAt) {
    if (_unsaved.has(id)) return false;
    const gone = await run(STORE, "readwrite", (t, set) => {
      const os = t.objectStore(STORE);
      const g = os.get(id);
      g.onsuccess = () => {
        const cur = g.result;
        if ((cur ? cur.updatedAt : undefined) !== expectedUpdatedAt) { set(false); return; }
        os.delete(id); set(true);
      };
    });
    if (gone) _stamps.delete(id);
    return gone;
  },

  /* ---------- on-device backups ----------
     Snapshotted automatically right before cloud sync merges or replaces a
     local job with a copy from another device — the safety net under the
     merge engine. This device only (never synced), restorable from the job
     page. Snapshots hold the job AS STORED ON DEVICE — full inline photos.

     ONE RECORD PER SNAPSHOT. They used to share one record per job (up to 10
     full copies), and every backup read that whole record into memory to add
     a copy, then wrote it all back. On a photo-heavy job that is hundreds of
     MB per sync: in October 2026 an iPhone crashed on every launch ("A
     problem repeatedly occurred") because each launch re-pulled a ~124 MB job
     and backed it up first, loading every older copy with it. Now a backup
     writes only itself and prunes by key, so nothing old is loaded: the
     newest SNAP_MAX within SNAP_BUDGET, never fewer than SNAP_MIN. A full
     disk makes room first and tries once more; a snapshot that still can't
     be written is skipped rather than ever blocking a sync.

     A record from before the split (keyed by the bare job id) is never read
     by sync or by opening a job; the job page loads it only on request
     (olderBackups). Its copies are older than every new snapshot, so it goes
     the first time the new ones outgrow their retention.

     opts.keep: a snapshot key (or the bare job id, for the pre-split record)
     this backup must not prune — the one a Restore is reading from, so the
     backup of the current copy taken just before can't delete it. */
  async backup(project, opts = {}) {
    if (!project || !project.id) return;
    const id = project.id;
    const keep = opts.keep;
    let rec;
    /* one transaction, all or nothing: read the job's keys, drop what the new
       copy pushes out of retention, write the new copy.
       The new copy is stamped after the job's newest stored one, whatever the
       clock says: key order IS snapshot order, and a clock that ran ahead and
       was set back would otherwise leave its stamps sorting as newest for
       good — retention pruning the real newest copies, latestBackup handing
       out a stale one. The stamp is read inside the transaction, so two
       backups of one job in the same millisecond still get two keys, and set
       once, so run()'s retry looks for the same key. */
    const save = () => run(BACKUPS, "readwrite", (t) => {
      const os = t.objectStore(BACKUPS);
      const keys = os.getAllKeys(snapRange(id));
      keys.onsuccess = () => {
        const mine = ownSnapKeys(id, keys.result);
        if (!rec.id) {
          const after = mine.length ? Date.parse(parseSnapKey(mine[0]).takenAt) + 1 : 0;
          rec.takenAt = new Date(Math.max(Date.now(), after || 0)).toISOString();
          rec.id = snapKey(id, rec.takenAt, rec.bytes);
        }
        // run()'s retry after a lost connection may find this copy already
        // written (the first try committed, the page just never heard)
        const older = mine.filter((k) => k !== rec.id);
        const victims = snapVictims([rec.id, ...older]).filter((k) => k !== keep);
        for (const k of victims) os.delete(k);
        if (victims.length && keep !== id) os.delete(id);   // the pre-split record is older still
        if (older.length === mine.length) os.put(rec);      // not again when the retry finds it there
      };
    });
    try {
      rec = { jobId: id, bytes: approxBytes(project), data: project };
      try {
        await save();
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        // a full disk: free space in its own transaction first (a delete only
        // counts once it commits), keeping the job's newest other snapshot —
        // two copies with the new one, as the old format kept — then retry
        await run(BACKUPS, "readwrite", (t) => {
          const os = t.objectStore(BACKUPS);
          const keys = os.getAllKeys(snapRange(id));
          keys.onsuccess = () => {
            const older = ownSnapKeys(id, keys.result).filter((k) => k !== rec.id && k !== keep);
            for (const k of older.slice(1)) os.delete(k);
          };
          if (keep !== id) os.delete(id);
        });
        // the failed try wrote nothing: stamp again, after any copy saved meanwhile
        rec.id = undefined;
        await save();
      }
    } catch (e) {
      try { console.warn("backup snapshot skipped:", e); } catch {}
    }
  },
  /** A job's snapshots, newest first, as { key, jobId, takenAt, bytes } —
      keys only, no copy is loaded. Open one with snapshot(key). */
  async snapshots(id) {
    const keys = await run(BACKUPS, "readonly", (t, set) => req1(t.objectStore(BACKUPS).getAllKeys(snapRange(id)), set));
    return ownSnapKeys(id, keys).map(parseSnapKey);
  },
  /** One snapshot's copy of the job, or null when it is gone. */
  async snapshot(key) {
    const rec = await run(BACKUPS, "readonly", (t, set) => req1(t.objectStore(BACKUPS).get(key), set));
    return (rec && rec.data) || null;
  },
  /** The newest snapshot's copy of the job (one record loaded), or null. */
  async latestBackup(id) {
    const [newest] = await Store.snapshots(id);
    return newest ? Store.snapshot(newest.key) : null;
  },
  /** Every snapshot, newest first, loaded: [{ takenAt, bytes, data }]. Bounded
      by the retention above — still, the job page lists keys instead. */
  async backups(id) {
    const out = [];
    for (const s of await Store.snapshots(id)) {
      const data = await Store.snapshot(s.key);
      if (data) out.push({ takenAt: s.takenAt, bytes: s.bytes, data });
    }
    return out;
  },
  /** Whether the job still has a record from before the split (a key count —
      the record itself is never loaded to answer). */
  async hasOlderBackups(id) {
    return (await run(BACKUPS, "readonly", (t, set) => req1(t.objectStore(BACKUPS).count(id), set))) > 0;
  },
  /** The pre-split record's snapshots, newest first: [{ takenAt, data }]. It
      holds up to 10 full copies of the job and loads all at once, which on a
      photo-heavy job is more than a phone can hold — so only the job page's
      "Show older backups" button calls this. */
  async olderBackups(id) {
    const row = await run(BACKUPS, "readonly", (t, set) => req1(t.objectStore(BACKUPS).get(id), set));
    return row && Array.isArray(row.snaps) ? row.snaps : [];
  },
};

/* ---------- debounced autosave with a visual "Saved" pulse ----------
   An edit leaves this queue only when its write COMMITTED. A failed save
   keeps it (newest object per job), says so on the pill, and retries on its
   own — it used to be dropped before the write was even tried, leaving
   "Saving…" on screen for good and the edit nowhere. Passes run one at a
   time, so a flush waits for a save already in flight: "flushed" means on
   disk, or still queued and the flush rejects. */
const _unsaved = new Map();          // job id -> { project, pill, failed } not yet on disk
let saveTimer = null, retryTimer = null, retryMs = 2000, saveChain = Promise.resolve();
function paintPill(pill, state) {
  if (!pill) return;
  if (state === "saving") { pill.textContent = "Saving…"; pill.style.color = "var(--muted)"; pill.onclick = null; }
  else if (state === "saved") { pill.textContent = "✓ Saved"; pill.style.color = "var(--green)"; pill.onclick = null; }
  else {
    pill.textContent = "⚠ Not saved — tap to retry"; pill.style.color = "var(--red)";
    pill.onclick = () => { paintPill(pill, "saving"); flushPending().catch(() => {}); };
  }
}
async function saveQueued() {
  let firstErr = null;
  for (const [id, entry] of [..._unsaved]) {
    if (_unsaved.get(id) !== entry) continue;      // a newer edit for this job replaced it — that one goes next
    // it stays queued while its write is in flight, so Store.putIf can't land
    // a sync write under it in the meantime
    try {
      await Store.put(entry.project);
    } catch (e) {
      const kept = _unsaved.get(id);              // it, or a newer edit that queued itself meanwhile
      if (kept) { kept.failed = true; paintPill(kept.pill, "failed"); }
      if (!firstErr) firstErr = e;
      continue;                                    // one job that can't save must not hold the others
    }
    if (_unsaved.get(id) === entry) { _unsaved.delete(id); paintPill(entry.pill, "saved"); }
  }
  if (firstErr) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { doSave().catch(() => {}); }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
    throw firstErr;
  }
  retryMs = 2000;
}
function doSave() {
  const pass = saveChain.then(saveQueued);
  saveChain = pass.catch(() => {});
  return pass;
}
export function autosave(project, pill) {
  // no pill of its own (a read landing off screen): the job's page keeps its pill
  const prev = _unsaved.get(project.id);
  if (!pill && prev) pill = prev.pill;
  _unsaved.set(project.id, { project, pill, failed: false });
  clearTimeout(saveTimer);
  paintPill(pill, "saving");
  saveTimer = setTimeout(() => { doSave().catch(() => { /* the pill and onStorageLost say so */ }); }, 350);
}
/* write any pending edit immediately (call before navigating / reloading).
   Rejects when it could not — the edit stays queued. */
export async function flushPending() {
  clearTimeout(saveTimer);
  await doSave();
}
/** The in-memory copy of a job whose last edit has not reached the disk yet
    (null when everything is saved) — the router opens THAT, never the older
    stored row, so a failed save is never overwritten by the next edit. */
export function unsavedProject(id) { const e = _unsaved.get(id); return e ? e.project : null; }
export const hasUnsaved = () => _unsaved.size > 0;
/** A page that (re)renders a job with an edit still queued takes over that
    edit's pill, so the retry that lands it turns THIS pill green (formkit
    setCtx calls it) — the old pill left with the old page. */
export function bindPill(project, pill) {
  const e = project && pill ? _unsaved.get(project.id) : null;
  if (!e || e.project !== project) return;
  e.pill = pill;
  paintPill(pill, e.failed ? "failed" : "saving");
}

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- trigger a client-side file download (CSV export, etc.) ---------- */
export function downloadFile(filename, content, mime = "text/plain;charset=utf-8") {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch {
    return false;
  }
}

/* ---------- CSV cell escaping ---------- */
export function csvRow(cells) {
  return cells.map((c) => {
    const s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",");
}

/* ---------- file → compressed dataURL (for photos / uploaded docs) ---------- */
export function fileToDataURL(file, maxDim = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result); // non-image (e.g. PDF) → keep raw
      img.onload = () => {
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- shrink an existing image dataURL (for emailable reports) ----------
   Re-encodes a stored photo down to maxDim / quality so a photo-heavy PDF stays
   small enough to email. Non-destructive: the caller keeps the original src and
   uses the returned value only for display/print. Non-raster or already-tiny
   inputs come back unchanged. */
export function shrinkDataURL(src, maxDim = 1100, quality = 0.6) {
  return new Promise((resolve) => {
    if (!src || !/^data:image\//.test(src)) return resolve(src);
    const img = new Image();
    img.onerror = () => resolve(src);
    img.onload = () => {
      let { width, height } = img;
      const s = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * s); height = Math.round(height * s);
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      c.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.src = src;
  });
}

/* ============================================================
   Signature pad — draw on canvas, returns PNG dataURL.
   Mounts into a container; supports clear + restore from value.
   ============================================================ */
export function signaturePad(initial, onChange) {
  const wrap = h("div", { class: "sigpad" });
  const canvas = h("canvas");
  const line = h("div", { class: "sigpad__line" });
  const hint = h("div", { class: "sigpad__hint" }, "Sign with finger or stylus");
  wrap.append(canvas, line, hint);

  let drawing = false, dirty = !!initial, last = null;
  const ctx = canvas.getContext("2d");

  function size() {
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 300;
    canvas.width = w * ratio; canvas.height = 180 * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#10233f";
    if (initial) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, 180);
      img.src = initial;
      hint.style.display = "none";
    }
  }
  // size after insertion into DOM
  requestAnimationFrame(size);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); drawing = true; dirty = true; hint.style.display = "none"; last = pos(e); };
  const move = (e) => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  };
  const end = () => { if (!drawing) return; drawing = false; onChange && onChange(canvas.toDataURL("image/png")); };

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);

  return {
    el: wrap,
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; initial = null; hint.style.display = "flex"; onChange && onChange(""); },
    isEmpty: () => !dirty,
    dataURL: () => (dirty ? canvas.toDataURL("image/png") : ""),
  };
}

/* ============================================================
   Sketch pad — freehand drawing for the Moisture Map affected-area
   diagram, over an optional imported floor-plan background. A
   "number" stamp mode drops incrementing markers at the moisture-
   reading locations. Background and strokes are kept on separate
   layers; export flattens them for printing.
   ============================================================ */
export function sketchPad({ strokes = null, background = null, markerStart = 1, onChange } = {}) {
  const wrap = h("div", { class: "sketch" });
  const bgImg = h("img", { class: "sketch__bg", alt: "" });
  const canvas = h("canvas");
  const hint = h("div", { class: "sketch__hint app-only" }, "✋ Scroll mode — tap a color to draw");
  wrap.append(bgImg, canvas, hint);
  const ctx = canvas.getContext("2d");
  // Start in "off" (scroll) mode so a finger scrolling past the map never draws
  // on it — the tech must tap a color (or Number) to arm a tool first.
  let pen = "#10233f", mode = "off", nextNum = markerStart || 1, drawing = false, last = null;

  function showBg() {
    if (background) { bgImg.src = background; bgImg.style.display = "block"; }
    else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; }
  }
  let curH = 320, curW = 320;   // current canvas display size (px); curH tracks the floor-plan aspect
  function size() {
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 320;
    curW = w;
    // Lock the canvas to the floor plan's aspect ratio: the plan then fills it
    // UNDISTORTED and the markers stay aligned in any orientation. No plan -> 320.
    const planAR = (background && bgImg.naturalWidth && bgImg.naturalHeight) ? bgImg.naturalWidth / bgImg.naturalHeight : 0;
    curH = planAR ? Math.max(140, Math.round(w / planAR)) : 320;
    canvas.width = w * ratio; canvas.height = curH * ratio;
    // Size by aspect-ratio, not a fixed px height, so the canvas keeps the
    // plan's proportions at ANY display width — including print (where the page
    // width differs from the screen). A fixed height warped the markers on PDF.
    canvas.style.aspectRatio = w + " / " + curH;
    canvas.style.height = "auto";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (strokes) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, curH);
      img.src = strokes;
    }
  }
  bgImg.addEventListener("load", size);   // re-fit the canvas when the floor plan loads/changes
  showBg();
  requestAnimationFrame(size);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const strokesData = () => canvas.toDataURL("image/png");
  function drawContain(o, img, W, H) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const s = Math.min(W / iw, H / ih);
    const dw = iw * s, dh = ih * s;
    o.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  /* flatten background + strokes into one image for print/thumbnail */
  function composite() {
    const W = canvas.width, H = canvas.height;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const o = out.getContext("2d");
    o.fillStyle = "#ffffff"; o.fillRect(0, 0, W, H);
    // fill (stretch), matching .sketch__bg object-fit:fill, so markers stay aligned
    if (background && bgImg.complete && bgImg.naturalWidth) o.drawImage(bgImg, 0, 0, W, H);
    o.drawImage(canvas, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  }
  const emit = () => onChange && onChange({ strokes: strokesData(), background, composite: composite(), markerNext: nextNum });

  /* Undo: the strokes layer is raster, so snapshot it before each stroke/stamp
     and pop+restore on undo. Snapshots are sparse PNGs (small); cap the depth. */
  const history = [];
  const snapshot = () => { history.push({ url: canvas.toDataURL("image/png"), num: nextNum }); if (history.length > 30) history.shift(); };
  function undo() {
    const prev = history.pop();
    if (!prev) return;                       // nothing to undo this session
    nextNum = prev.num;
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, curW, curH); emit(); };
    img.src = prev.url;
  }

  function stamp(p) {
    snapshot();
    ctx.fillStyle = "#f26a21"; ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(nextNum++), p.x, p.y);
    ctx.lineWidth = 2.6; ctx.strokeStyle = pen;
    emit();
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (mode === "off") return;   // scroll mode: let the page scroll, never draw
    e.preventDefault();
    if (mode === "number") return stamp(pos(e));
    snapshot();
    drawing = true; last = pos(e); ctx.strokeStyle = pen;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  window.addEventListener("pointerup", () => { if (drawing) { drawing = false; emit(); } });

  const swatches = [];
  const swatch = (color) => {
    const s = h("button", { type: "button", class: "swatch" + (color === pen ? " active" : ""), style: `background:${color}`, dataset: { color } });
    s.addEventListener("click", () => { pen = color; mode = "draw"; refresh(); });
    swatches.push(s);
    return s;
  };
  function refresh() {
    swatches.forEach((s) => s.classList.toggle("active", s.dataset.color === pen && mode === "draw"));
    numBtn.classList.toggle("active", mode === "number");
    numBtn.style.background = mode === "number" ? "var(--orange)" : "#fff";
    numBtn.style.color = mode === "number" ? "#fff" : "var(--navy)";
    const off = mode === "off";
    moveBtn.classList.toggle("active", off);
    moveBtn.style.background = off ? "var(--orange)" : "#fff";
    moveBtn.style.color = off ? "#fff" : "var(--navy)";
    // Only capture touch (block page scroll) while a draw/stamp tool is armed.
    wrap.style.touchAction = off ? "pan-y" : "none";
    canvas.style.touchAction = off ? "pan-y" : "none";
    hint.style.display = off ? "block" : "none";
  }
  const moveBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Scroll the page without drawing" }, "✋ Move");
  moveBtn.addEventListener("click", () => { mode = "off"; refresh(); });
  const numBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "①  Number");
  numBtn.addEventListener("click", () => { mode = mode === "number" ? "off" : "number"; refresh(); });
  const clearBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↺ Clear drawing");
  clearBtn.addEventListener("click", () => { history.length = 0; nextNum = 1; ctx.clearRect(0, 0, canvas.width, canvas.height); emit(); });
  const undoBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↩ Undo");
  undoBtn.addEventListener("click", undo);

  const toolsEl = h("div", { class: "sketch__tools app-only" },
    moveBtn, swatch("#10233f"), swatch("#f26a21"), swatch("#d23b2e"), swatch("#1f9d55"), numBtn, undoBtn, clearBtn);
  refresh();   // apply the initial "off" state (scroll enabled, hint shown, no tool active)

  return {
    tools: toolsEl, el: wrap, composite, hasBackground: () => !!background,
    setBackground(url) {
      background = url || null;
      if (background) { bgImg.onload = () => emit(); bgImg.src = background; bgImg.style.display = "block"; }  // 'load' listener also re-fits via size()
      else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; size(); emit(); }
    },
  };
}

/* ============================================================
   Equipment-placement pad — drop directional equipment icons on the
   Moisture Map's floor plan (air mover / dehumidifier / air scrubber /
   heater), then move, rotate, and delete them. Icons are objects
   ({type,x,y,angle}, x/y normalized 0–1) so they stay editable; the
   canvas prints as-is in the packet.
   ============================================================ */
export const EQUIP_TYPES = [
  { key: "air_mover", label: "Air mover" },
  { key: "lgr_dehumidifier", label: "Dehumidifier" },
  { key: "air_scrubber", label: "Air scrubber" },
  { key: "heater", label: "Heater" },
];
const EQUIP_STYLE = {
  air_mover:        { color: "#0f1b2d", label: "AM",   dir: true  },
  lgr_dehumidifier: { color: "#1f6feb", label: "LGR",  dir: false },
  air_scrubber:     { color: "#0f9d8f", label: "HEPA", dir: false },
  heater:           { color: "#e0552b", label: "HT",   dir: false },
};

/* pure helpers (unit-tested) */
export const stepAngle = (a, d) => ((((Number(a) || 0) + d) % 360) + 360) % 360;
export const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
/* nearest placed item to a pixel point, within `radius` px, else null */
export function nearestEquip(items, px, py, W, H, radius = 26) {
  let best = null, bestD = radius * radius;
  for (const it of items || []) {
    const dx = it.x * W - px, dy = it.y * H - py, d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = it; }
  }
  return best;
}

function rrect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawEquip(ctx, type, cx, cy, angleDeg, s, selected) {
  const st = EQUIP_STYLE[type] || EQUIP_STYLE.air_mover;
  ctx.save();
  ctx.translate(cx, cy);
  if (selected) {
    ctx.strokeStyle = "#f26a21"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(0, 0, s + 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.rotate((angleDeg * Math.PI) / 180);
  // direction arrow points "up" (the way it faces / blows) at angle 0
  ctx.fillStyle = st.dir ? "#f26a21" : "rgba(15,27,45,0.4)";
  ctx.beginPath(); ctx.moveTo(0, -s - 10); ctx.lineTo(-7, -s - 1); ctx.lineTo(7, -s - 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = st.color; rrect(ctx, -s, -s, s * 2, s * 2, 5); ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#fff"; ctx.font = `bold ${Math.max(9, Math.round(s * 0.78))}px sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(st.label, cx, cy);
}

export function equipmentPad({ items = [], background = null, onChange } = {}) {
  const wrap = h("div", { class: "sketch" });
  const bgImg = h("img", { class: "sketch__bg", alt: "" });
  const canvas = h("canvas");
  wrap.append(bgImg, canvas);
  const ctx = canvas.getContext("2d");
  const ICON = 16;   // icon half-size (px) — sized to stay legible on the enlarged printed map
  let list = (items || []).map((it) => ({ id: it.id || uid(), type: it.type, x: clamp01(it.x), y: clamp01(it.y), angle: Number(it.angle) || 0 }));
  let armed = null, selected = null, dragging = false, W = 320, H = 320;

  function showBg() {
    if (background) { bgImg.src = background; bgImg.style.display = "block"; }
    else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; }
  }
  function size() {
    const ratio = window.devicePixelRatio || 1;
    W = wrap.clientWidth || 320;
    // Match the floor plan's aspect ratio (shared with the moisture sketch) so
    // icons stay aligned + undistorted across orientations. No plan -> 320.
    const planAR = (background && bgImg.naturalWidth && bgImg.naturalHeight) ? bgImg.naturalWidth / bgImg.naturalHeight : 0;
    H = planAR ? Math.max(140, Math.round(W / planAR)) : 320;
    canvas.width = W * ratio; canvas.height = H * ratio;
    // Aspect-ratio sizing (see sketchPad): keeps equipment icons undistorted at
    // any width, so they don't stretch on the printed PDF.
    canvas.style.aspectRatio = W + " / " + H;
    canvas.style.height = "auto";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const it of list) drawEquip(ctx, it.type, it.x * W, it.y * H, it.angle, ICON, it.id === selected);
  }
  bgImg.addEventListener("load", size);   // re-fit when the shared floor plan loads/changes
  showBg();
  requestAnimationFrame(size);

  const pos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  function composite() {
    const Wd = canvas.width, Hd = canvas.height;
    const out = document.createElement("canvas"); out.width = Wd; out.height = Hd;
    const o = out.getContext("2d");
    o.fillStyle = "#fff"; o.fillRect(0, 0, Wd, Hd);
    // fill (stretch), matching .sketch__bg object-fit:fill, so icons stay aligned
    if (background && bgImg.complete && bgImg.naturalWidth) o.drawImage(bgImg, 0, 0, Wd, Hd);
    o.drawImage(canvas, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  }
  const stripped = () => list.map(({ id, type, x, y, angle }) => ({ id, type, x, y, angle }));
  const emit = () => onChange && onChange({ items: stripped(), composite: composite() });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = pos(e);
    if (armed) { const it = { id: uid(), type: armed, x: clamp01(p.x / W), y: clamp01(p.y / H), angle: 0 }; list.push(it); selected = it.id; redraw(); emit(); return; }
    const hit = nearestEquip(list, p.x, p.y, W, H, ICON + 10);
    selected = hit ? hit.id : null;
    dragging = !!hit;
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || !selected) return; e.preventDefault();
    const p = pos(e); const it = list.find((x) => x.id === selected);
    if (it) { it.x = clamp01(p.x / W); it.y = clamp01(p.y / H); redraw(); }
  });
  window.addEventListener("pointerup", () => { if (dragging) { dragging = false; emit(); } });

  const selectedItem = () => list.find((x) => x.id === selected);
  function rotate(d) { const it = selectedItem(); if (!it) return; it.angle = stepAngle(it.angle, d); redraw(); emit(); }
  function del() { if (!selected) return; list = list.filter((x) => x.id !== selected); selected = null; redraw(); emit(); }
  function clear() { list = []; selected = null; armed = null; redraw(); emit(); refresh(); }

  const typeBtns = EQUIP_TYPES.map((t) => {
    const b = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, t.label);
    b.dataset.key = t.key;
    b.addEventListener("click", () => { armed = armed === t.key ? null : t.key; selected = null; refresh(); redraw(); });
    return b;
  });
  const rotL = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Rotate left" }, "↺");
  const rotR = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Rotate right" }, "↻");
  const delB = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "✕ Remove");
  const clrB = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Clear all");
  rotL.addEventListener("click", () => rotate(-45));
  rotR.addEventListener("click", () => rotate(45));
  delB.addEventListener("click", del);
  clrB.addEventListener("click", clear);
  function refresh() {
    typeBtns.forEach((b) => {
      const on = b.dataset.key === armed;
      b.style.background = on ? "var(--orange,#f26a21)" : "";
      b.style.color = on ? "#fff" : "";
    });
  }
  refresh();
  const toolsEl = h("div", { class: "sketch__tools app-only" }, ...typeBtns, rotL, rotR, delB, clrB);

  return {
    el: wrap, tools: toolsEl, composite,
    counts: () => list.reduce((m, it) => ((m[it.type] = (m[it.type] || 0) + 1), m), {}),
    setBackground(url) {
      background = url || null;
      if (background) { bgImg.onload = () => emit(); bgImg.src = background; bgImg.style.display = "block"; }  // 'load' listener re-fits via size()
      else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; size(); emit(); }
    },
  };
}

/* ============================================================
   Psychrometrics — grains per pound (GPP) of moisture per pound
   of dry air, from dry-bulb temp (°F) and relative humidity (%).
   Uses standard sat-vapor-pressure approximation; field-grade.
   ============================================================ */
export function gpp(tempF, rh) {
  const t = Number(tempF), r = Number(rh);
  if (!isFinite(t) || !isFinite(r) || r < 0) return null;
  const tc = (t - 32) * 5 / 9;                         // °C
  // Saturation vapor pressure (hPa) — Magnus formula
  const es = 6.1078 * Math.pow(10, (7.5 * tc) / (237.3 + tc));
  const e = es * (r / 100);                            // actual vapor pressure (hPa)
  const p = 1013.25;                                   // sea-level atmospheric (hPa)
  const w = 0.62198 * e / (p - e);                     // humidity ratio (lb/lb)
  return Math.round(w * 7000);                         // grains per pound
}
/* grain depression = unaffected GPP − affected GPP */
export function grainDepression(unaffectedGpp, affectedGpp) {
  if (unaffectedGpp == null || affectedGpp == null) return null;
  return unaffectedGpp - affectedGpp;
}

/* ---------- IICRC S500 dry standards ---------- */
/* goal = numeric MC% threshold a reading must be at or below to be "dry" */
export const DRY_STANDARDS = [
  { material: "Drywall / Gypsum", goal: 1 },
  { material: "Plaster", goal: 1.5 },
  { material: "Concrete / Slab", goal: 4 },
  { material: "Hardwood Flooring", goal: 12 },
  { material: "Carpet / Pad", goal: 15 },
  { material: "Framing / Wood / Subfloor", goal: 19 },
  { material: "OSB / Particle Board", goal: 16 },
  { material: "Other / Generic", goal: 16 },
];
export const goalFor = (material) => DRY_STANDARDS.find((d) => d.material === material)?.goal ?? null;

/* ---------- date helpers ---------- */
export function daysSince(iso) {
  if (!iso) return null;
  const start = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(start)) return null;
  return Math.floor((Date.now() - start.getTime()) / 86400000);
}
export function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round(Math.abs(b - a) / 86400000);
}


/* ---------- the media queue: clips (and their stills) waiting to upload ----------
   A row holds the Blob itself — the File the Camera handed us is gone the
   moment Safari reloads, so it goes in here BEFORE stills are pulled or
   anything is shown as saved (docs/Narrated_Walkthrough_Design.md §4.3).
   Rows are removed only after the server acknowledged the last byte. No
   listeners: the queue (mediaqueue.js) owns the lifecycle. */
export const MediaStore = {
  async put(row) {
    return run(MEDIA_STORE, "readwrite", (t, set) => req1(t.objectStore(MEDIA_STORE).put(row), set));
  },
  async get(id) {
    return run(MEDIA_STORE, "readonly", (t, set) => req1(t.objectStore(MEDIA_STORE).get(id), set, (x) => x || null));
  },
  /** Every queued row, oldest first. */
  async all() {
    const rows = await run(MEDIA_STORE, "readonly", (t, set) => req1(t.objectStore(MEDIA_STORE).getAll(), set, (x) => x || []));
    return rows.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));
  },
  async del(id) {
    return run(MEDIA_STORE, "readwrite", (t) => { t.objectStore(MEDIA_STORE).delete(id); });
  },
};
