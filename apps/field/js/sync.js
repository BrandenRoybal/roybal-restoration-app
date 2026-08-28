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
     dirty copy survives (backed up first) and the push path
     deliberately revives the job with the work intact — UNLESS
     the local copy is a blank scaffold or adds nothing over what
     the tombstone preserved, in which case the delete wins (so
     repeat-tap junk jobs stay deletable instead of resurrecting
     from every device that ever held them);
   - a delete pushes the job's last-known content INSIDE the
     tombstone (media offloaded as usual), so a deleted job is
     recoverable from the server, not only from a device;
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
import { Store, onProjectSaved, onProjectDeleted, likelyOffline } from "./core.js";
import { isSignedIn, upsertRows, guardedUpsertRow, reviveRow, fetchRow, fetchSince, uploadMedia, downloadMedia,
         pushProject, tombstoneProject, reviveProject } from "./supa.js";
import { SYNC_VIA_RPC } from "./config.js";
import { deflateProject, inflateProject } from "./media.js";
import { mergeProjects, ID_COLLECTIONS, FORM_SLOTS } from "./merge.js";
import { isBlankProject } from "./model.js";

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
let deletes = loadDeletes();               // Map: projectId -> ISO time the delete was queued
let mediaPushed = new Set(load(K_MEDIA, []));
let mediaWait = new Map();                 // projectId -> consecutive cycles blocked on missing bucket media
let statusCb = () => {};
let mergeCb = () => {};                    // fires after a two-device merge (app shows a toast)
let rowCb = () => {};                      // fires when sync changes a stored row (app refreshes open pages)
let syncing = false, started = false, skipped = 0, pushTimer = null, needsAnotherPass = false;
let updateRequired = false;   // server refused this build (P0002) — the app must be updated

/** Register a listener for "changes from another device were merged in". */
export function onSyncMerge(fn) { mergeCb = fn || (() => {}); }
/** Register a listener for "sync rewrote this stored row" (merge OR clean
    apply) — the app grafts the fresh copy into any open page's in-memory
    project so the next autosave can't write a stale fork back over it. */
export function onSyncRowChanged(fn) { rowCb = fn || (() => {}); }
const rowChanged = (id) => { try { rowCb(id); } catch { /* refresh is a bonus */ } };

/* content equality ignoring the sync-volatile top-level fields (rev lives in
   bookkeeping; updatedAt is a clock stamp, not content). How absorb spots a
   SELF-ECHO merge: the union holds nothing the server doesn't already have.
   KEY ORDER IS CANONICALIZED: Postgres jsonb reorders object keys, so a
   server round-trip of byte-identical content stringifies differently from
   the device's insertion-ordered copy — without sorting, every comparison
   here false-negatives for the device that CREATED the row. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function sameContent(a, b) {
  const strip = ({ rev, updatedAt, ...content }) => content;
  return JSON.stringify(canon(strip(a))) === JSON.stringify(canon(strip(b)));
}

/* merge the server's copy into ours, adopt the server's rev, and leave the
   union locally as an UNSYNCED edit — the next pass pushes it guarded on the
   rev we just adopted. Both inputs must be INFLATED (real media, no markers).
   Re-reads the freshest local copy and lands the union with a conditional put,
   so an edit typed while merge media was downloading is merged, not lost.
   SELF-ECHO GUARD: when the union adds NOTHING over the server's copy, adopt
   it as CLEAN instead of bumping updatedAt and re-pushing a contentless
   rev+1. Without this, a tab whose bookkeeping went stale (a second open tab,
   another device) re-dirtied the row on every 45 s cycle and two such tabs
   fed each other rev bumps forever — 6k pointless row rewrites in one day
   (Jul 2026 disk-IO incident). */
async function absorb(localRef, serverFull, why) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = (await Store.get(localRef.id)) || localRef;
    await Store.backup(local);                     // our side, restorable (never throws)
    const { merged, added, filledForms } = mergeProjects(local, serverFull);
    merged.id = localRef.id;
    delete merged.rev;                             // revs live in sync bookkeeping, not the blob
    if (sameContent(merged, serverFull)) {
      // nothing to assert over the server — take its copy and go clean
      merged.updatedAt = serverFull.updatedAt || local.updatedAt;
      if (!(await Store.putIf(merged, local.updatedAt))) continue;   // an edit just landed — redo against it
      revs[localRef.id] = Number(serverFull.rev) || 0; saveRevs();
      pushed[localRef.id] = merged.updatedAt; savePushed();          // stored row now matches server → not dirty
      mediaWait.delete(localRef.id);
      rowChanged(localRef.id);
      return merged;
    }
    // strictly newer than BOTH sides and never behind this clock: a server
    // merge stamps on the SERVER clock, which can be ahead of a skewed tablet,
    // and a regressive stamp is silently skipped by everyone's pull tie-guard
    merged.updatedAt = laterThan(local.updatedAt, serverFull.updatedAt);   // marks it dirty → re-pushes
    if (!(await Store.putIf(merged, local.updatedAt))) continue;   // an edit just landed — redo against it
    revs[localRef.id] = Number(serverFull.rev) || 0; saveRevs();
    mediaWait.delete(localRef.id);
    needsAnotherPass = true;
    if (added || filledForms) {                    // a merge that recovered nothing gets no toast
      try { mergeCb({ id: localRef.id, customer: merged.customer || merged.address || "job", added, filledForms, why }); } catch { /* toast is a bonus */ }
    }
    rowChanged(localRef.id);
    return merged;
  }
  return null;   // constant editing beat us 4 times — row stays dirty, next cycle retries
}

/* ---------- adopt a union the SERVER already committed (RPC path) ----------
   push_project returns status 'merged' AFTER storing the union at the returned
   rev. Unlike absorb() — which merges locally and still owes a push — there is
   nothing left to assert, so the row is adopted CLEAN: no updatedAt bump, no
   re-push. Bumping here would re-dirty a row that already matches the server,
   and two devices would feed each other rev bumps forever (the Jul 2026
   disk-IO incident). Returns true when the union landed locally. */
async function adoptServerMerge(localRef, res, fetchMedia) {
  const id = localRef.id;
  let full, missing;
  try {
    ({ project: full, missing } = await inflateProject(res.data, fetchMedia || downloadRemembered));
  } catch {
    return "media-fetch-failed";                   // caller raises it: green status would be a lie
  }
  if (missing > 0) {
    // Another device's photos are still propagating, so we cannot store this
    // union yet. Deliberately do NOT adopt the new rev: if we did, the next
    // push would look up to date and wholesale-overwrite the server's copy
    // with ours — erasing the very photo we are waiting for. Staying on the
    // old base means the next cycle re-merges (a no-op on the server, which
    // returns 'current') until the bucket catches up.
    mediaWait.set(id, (mediaWait.get(id) || 0) + 1);
    return "media-missing";
  }
  const local = (await Store.get(id)) || localRef;
  await Store.backup(local);                       // our side stays restorable
  const { added, filledForms } = countRecovered(local, full);
  full.id = id;
  delete full.rev;                                 // revs live in sync bookkeeping
  // CAS on the SNAPSHOT this push was built from, not on the row we just read:
  // the union the server built cannot contain anything typed after that
  // snapshot (deflate + media upload + round-trip can take minutes on a
  // photo-heavy cycle). If the row moved, refuse to overwrite — the row stays
  // dirty and next cycle merges the newer local copy in.
  if (!(await Store.putIf(full, localRef.updatedAt))) return "raced";
  revs[id] = Number(res.rev) || 0; saveRevs();
  pushed[id] = full.updatedAt; savePushed();       // clean: the stored row matches the server
  mediaWait.delete(id);
  if (added || filledForms) {
    try { mergeCb({ id, customer: full.customer || full.address || "job", added, filledForms, why: "server-merge" }); }
    catch { /* toast is a bonus */ }
  }
  rowChanged(id);
  return true;
}

/* What the server's union holds that this device didn't. The server merge
   returns no stats, so the "recovered N items / M forms" toast is derived
   here — and it must cover the same ground mergeProjects reported, or a
   signed work auth arriving from the office lands with no signal at all. */
const emptyish = (v) => v == null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
function countRecovered(local, merged) {
  let added = 0, filledForms = 0;
  for (const key of ID_COLLECTIONS) {
    const mine = new Set((Array.isArray(local[key]) ? local[key] : []).map((x) => x && x.id).filter(Boolean));
    for (const el of (Array.isArray(merged[key]) ? merged[key] : [])) {
      if (el && el.id && !mine.has(el.id)) added++;
    }
  }
  const myRooms = new Set(Array.isArray(local.rooms) ? local.rooms : []);
  for (const r of (Array.isArray(merged.rooms) ? merged.rooms : [])) if (!myRooms.has(r)) added++;
  for (const key of FORM_SLOTS) {
    if (emptyish(local[key]) && !emptyish(merged[key])) filledForms++;
  }
  return { added, filledForms };
}

/* an ISO stamp strictly newer than both inputs and never behind this clock */
function laterThan(a, b) {
  const floor = Math.max(Date.parse(a) || 0, Date.parse(b) || 0);
  return new Date(Math.max(Date.now(), floor + 1)).toISOString();
}

function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
/* pending deletes were once a bare id array — migrate to {id: queuedAtISO}
   (a queue entry with no timestamp still tombstones unconditionally) */
function loadDeletes() {
  const raw = load(K_DELETES, {});
  if (Array.isArray(raw)) return new Map(raw.map((id) => [id, ""]));
  return new Map(Object.entries(raw));
}
const savePushed = () => localStorage.setItem(K_PUSHED, JSON.stringify(pushed));
const saveRevs = () => localStorage.setItem(K_REVS, JSON.stringify(revs));
const saveDeletes = () => localStorage.setItem(K_DELETES, JSON.stringify(Object.fromEntries(deletes)));
const saveCursor = () => localStorage.setItem(K_CURSOR, cursor);
const saveMediaPushed = () => localStorage.setItem(K_MEDIA, JSON.stringify([...mediaPushed].slice(-3000)));
function bumpCursor(ts) { if (ts && ts > cursor) { cursor = ts; saveCursor(); } }

function setStatus(state, extra = {}) { statusCb({ state, pending: pendingCount(), skipped, updateRequired, ...extra }); }
function pendingCount() { return deletes.size; }   // approximate; recomputed on demand

/* a media object we just downloaded provably exists in the bucket — remember
   that so a later push of the same content skips the re-upload */
async function downloadRemembered(hash) {
  const text = await downloadMedia(hash);
  if (text != null && !mediaPushed.has(hash)) { mediaPushed.add(hash); saveMediaPushed(); }
  return text;
}

/* upload any media object not yet known to be in the bucket (content-addressed) */
async function uploadNewMedia(media) {
  for (const m of media) {
    if (mediaPushed.has(m.hash)) continue;           // already in the bucket
    await uploadMedia(m.hash, m.text);
    mediaPushed.add(m.hash); saveMediaPushed();
  }
}

/* ---------- push local changes (rev-guarded) ---------- */
async function push() {
  const all = await Store.all();
  let skippedNow = 0, lastErr = null;
  for (const p of all) {
    if (pushed[p.id] === p.updatedAt) continue;        // already up to date
    try {
      const { slim, media } = await deflateProject(p);
      await uploadNewMedia(media);
      const base = Number(revs[p.id] ?? p.rev) || 0;   // p.rev: legacy fallback for rows pulled before K_REVS
      const next = { ...slim, rev: base + 1 };
      // measure what actually goes on the wire for the active path
      if (JSON.stringify(SYNC_VIA_RPC ? slim : next).length > MAX_ROW) { skippedNow++; continue; } // huge even without media — surfaced LOUD in status
      // the server's copy references OUR photos too — reuse the bytes we just
      // deflated instead of pulling them back down over cell data
      const localMedia = new Map(media.map((m) => [m.hash, m.text]));
      const resolveMedia = (h) => (localMedia.has(h) ? localMedia.get(h) : downloadRemembered(h));
      // SERVER-AUTHORITATIVE PUSH (migrations 217/218): the server does the
      // CAS and, on a stale base, the MERGE itself — a device that started
      // from an old copy can no longer overwrite anyone, even if its own
      // merge logic is stale or buggy. Legacy path stays behind the kill
      // switch until direct writes are revoked (219).
      let serverBlob = null, serverIsDeleted = false;
      if (SYNC_VIA_RPC) {
        const res = await pushProject(p.id, base, slim);
        if (res.status === "insert" || res.status === "applied") {
          // NOTE: nothing is written back to the local row. The new rev goes to
          // sync bookkeeping only — an edit the user typed while this push was
          // in flight stays in the store untouched (still dirty vs pushed[],
          // so it goes up next cycle on the rev we just recorded).
          revs[p.id] = Number(res.rev) || base + 1; saveRevs();
          pushed[p.id] = p.updatedAt; savePushed();
          mediaWait.delete(p.id);
          continue;
        }
        if (res.status === "merged" || res.status === "current") {
          // 'merged'  — the server committed the union; adopt it clean.
          // 'current' — our push added nothing the server lacked (self-echo);
          //             it wrote nothing, so adopt its copy and go clean.
          const why = await adoptServerMerge(p, res, resolveMedia);
          if (why === "media-fetch-failed") lastErr = new Error("merge media fetch failed");
          if (why !== true) needsAnotherPass = true;   // retry in 1.5s, not 45s
          continue;
        }
        // FAIL CLOSED. Anything we do not recognise must not fall into the
        // tombstone branch below — that path can DELETE the local job. A
        // future server status reaching an older build would otherwise erase
        // live work.
        if (res.status !== "deleted" || !res.data) {
          lastErr = new Error("push_project: unexpected status " + (res && res.status));
          continue;
        }
        serverBlob = res.data;                         // tombstone, nothing written
        serverIsDeleted = true;
      } else {
        const r = await guardedUpsertRow(p.id, base, next);
        if (r.ok) {
          revs[p.id] = base + 1; saveRevs();
          pushed[p.id] = p.updatedAt; savePushed();
          mediaWait.delete(p.id);
          continue;
        }
        // conflict: another device moved (or deleted) the row since we last
        // synced. NEVER clobber, NEVER drop — merge their copy into ours.
        if (!r.server) continue;                       // insert race — pull will bring their row
        serverBlob = r.server;
        serverIsDeleted = !!r.serverDeleted;
      }
      let serverFull, missing;
      try { ({ project: serverFull, missing } = await inflateProject(serverBlob, resolveMedia)); }
      catch { lastErr = new Error("merge media fetch failed"); continue; }
      if (missing > 0) {                               // their media still propagating — retry next cycle
        mediaWait.set(p.id, (mediaWait.get(p.id) || 0) + 1);   // …but surface it if it never resolves
        continue;
      }
      if (serverIsDeleted) {
        // the job was deleted on the server while this device held a copy it
        // believes is unsynced (often just reset bookkeeping after a sign-out).
        // The delete wins unless we hold REAL work the tombstone doesn't keep.
        // Decide on a FRESH read — `p` is a snapshot from the top of the loop,
        // minutes old on a photo-heavy cycle, and the user may have started
        // filling this very job in since (the reused-blank flow steers them
        // into exactly these rows).
        const cur = await Store.get(p.id);
        if (!cur) {                                    // already gone locally — settle bookkeeping
          delete pushed[p.id]; delete revs[p.id]; savePushed(); saveRevs();
          mediaWait.delete(p.id);
          continue;
        }
        const { merged } = mergeProjects(cur, serverFull);
        merged.id = p.id;
        delete merged.rev;
        if (isBlankProject(cur) || sameContent(merged, serverFull)) {
          // a repeat-tap blank scaffold, or content the tombstone already
          // preserves — accept the delete instead of resurrecting junk
          await Store.backup(cur);                     // still restorable on-device
          if (!(await Store.delIf(p.id, cur.updatedAt))) continue;  // an edit just landed — re-decide next cycle
          delete pushed[p.id]; delete revs[p.id]; savePushed(); saveRevs();
          mediaWait.delete(p.id);
          rowChanged(p.id);
          continue;
        }
        // we DO hold work the tombstone lacks — revive the job with the union,
        // EXPLICITLY and GUARDED on the row still being deleted (two devices
        // reviving at once: the second sees 0 rows, stays dirty, and merges
        // against the first's copy next cycle instead of clobbering it)
        merged.updatedAt = laterThan(cur.updatedAt, serverFull.updatedAt);
        if (!(await Store.putIf(merged, cur.updatedAt))) continue;   // an edit just landed — retry next cycle
        const { slim: reviveSlim, media: reviveMedia } = await deflateProject(merged);
        await uploadNewMedia(reviveMedia);
        const nextRev = (Number(serverBlob && serverBlob.rev) || 0) + 1;
        let revivedRev = nextRev;
        if (SYNC_VIA_RPC) {
          const rr = await reviveProject(p.id, reviveSlim);
          if (rr.status !== "revived") continue;       // someone beat us to it — merge next cycle
          revivedRev = Number(rr.rev) || nextRev;
        } else {
          const revived = await reviveRow(p.id, { ...reviveSlim, rev: nextRev });
          if (!revived.ok) continue;                   // someone beat us to it — stay dirty, merge next cycle
        }
        revs[p.id] = revivedRev; saveRevs();
        pushed[p.id] = merged.updatedAt; savePushed();
        mediaWait.delete(p.id);
        rowChanged(p.id);
        continue;
      }
      await absorb(p, serverFull, "push-conflict");
    } catch (e) {
      // This build is older than the floor the server accepts — the device is
      // running stale cached code. Nothing it retries will help, so say so
      // plainly instead of showing a generic "sync issue" forever.
      if (e && e.needsUpdate) updateRequired = true;
      lastErr = e;   // one failing job (network blip mid-cycle) must not stall the rest
    }
  }
  skipped = skippedNow;
  for (const [id, queuedAt] of [...deletes]) {
    try {
      // STALENESS GUARD: a queued delete can now outlive a sign-out, so it may
      // fire long after it was tapped. If the server copy moved AFTER the
      // delete was queued, the crew kept working on the job — drop the stale
      // delete instead of tombstoning fresh work.
      if (queuedAt) {
        const srv = await fetchRow(id);
        if (srv && !srv.deleted && String((srv.data && srv.data.updatedAt) || "") > queuedAt) {
          deletes.delete(id); saveDeletes();
          continue;                          // the job lives on; pull keeps it
        }
      }
      // ship the job's last-known content INSIDE the tombstone (media already
      // offloaded to the bucket) — a deleted job stays recoverable from the
      // server instead of only from whichever device still holds a copy
      let data = null;                       // null → the server keeps the copy it already holds
      try {
        const snaps = await Store.backups(id);
        const snap = snaps.length ? snaps[0].data : null;
        if (snap && snap.id === id) {
          const { slim, media } = await deflateProject(snap);
          await uploadNewMedia(media);
          const { rev, ...content } = slim;
          if (JSON.stringify(content).length <= MAX_ROW) data = content;
        }
      } catch { /* a bare tombstone still beats blocking the delete */ }
      if (SYNC_VIA_RPC) await tombstoneProject(id, data);
      else await upsertRows([{ id, data: data || { id }, deleted: true }]);
      deletes.delete(id); delete pushed[id]; delete revs[id];
      saveDeletes(); savePushed(); saveRevs();
      // the pull earlier in THIS cycle may have re-stored the job (cursor
      // reset, or its row changed server-side after the local delete). The
      // user deleted it — drop the ghost, or it reads as "dirty work" next
      // cycle and revives the job we just tombstoned. Conditional: an edit
      // typed since the ghost was read keeps the row (it re-pushes as work).
      const ghost = await Store.get(id);
      if (ghost) {
        await Store.backup(ghost);
        if (await Store.delIf(id, ghost.updatedAt)) rowChanged(id);
      }
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
  // A row stuck waiting on bucket media must not stall everything behind it
  // (one 187-photo job used to block every other job's sync). Later rows still
  // apply, but the cursor FREEZES at the first stuck row so it is refetched
  // next cycle — already-applied later rows then fall out of the tie guard.
  let stuckOnMedia = false;
  const bump = (ts) => { if (!stuckOnMedia) bumpCursor(ts); };
  for (const row of rows) {
    if (row.deleted) {
      const local = await Store.get(row.id);
      if (local && pushed[row.id] !== local.updatedAt && !isBlankProject(local)) {
        // this device holds UNSYNCED work on the job — a tombstone must not
        // eat it. Keep the dirty copy (snapshotted anyway); the push path
        // decides whether to revive the job with the work or let the delete
        // stand. A dirty-but-BLANK scaffold falls through: repeat-tap junk
        // must stay deletable.
        await Store.backup(local);
        revs[row.id] = 0; saveRevs();      // tombstone rows carry no rev — re-assert from base 0
        bump(row.updated_at);
        continue;
      }
      if (local) {
        await Store.backup(local);           // delete — keep a restorable snapshot
        if (!(await Store.delIf(row.id, local.updatedAt))) {
          // an edit landed while we were backing up — treat it as dirty work
          revs[row.id] = 0; saveRevs();
          bump(row.updated_at);
          continue;
        }
      }
      delete pushed[row.id]; delete revs[row.id]; saveRevs();
      mediaWait.delete(row.id);
      rowChanged(row.id);
      bump(row.updated_at);
      continue;
    }
    const remote = row.data;
    if (!remote || !remote.id) { bump(row.updated_at); continue; }
    const local = await Store.get(row.id);
    // local wins ties: only a STRICTLY newer remote may touch local work
    if (local && (remote.updatedAt || "") <= (local.updatedAt || "")) { bump(row.updated_at); continue; }
    let full, missing;
    try {
      ({ project: full, missing } = await inflateProject(remote, downloadRemembered));
    } catch {
      break;   // media fetch failed (network) — retry this row from the same cursor next cycle
    }
    // Some referenced media (photos, plan pages) came back empty — a transient
    // auth gap, or objects still propagating just after another device uploaded
    // them. NEVER store a copy with marker strings where photos should be (a
    // fresh device used to save one and go clean — its photos rendered as
    // garbage until the job changed again), and never advance the cursor past
    // the row. Other rows keep syncing; this one retries next cycle and turns
    // the status red if it never resolves.
    if (missing > 0) {
      mediaWait.set(row.id, (mediaWait.get(row.id) || 0) + 1);
      stuckOnMedia = true;
      continue;
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
    bump(row.updated_at);
  }
  savePushed();
}

/* ---------- run a full sync cycle ---------- */
/* navigator.onLine is ADVISORY, never the last word. It has false negatives:
   a home-screen PWA woken from sleep can report offline on perfect office wifi
   and never fire "online" again. This check used to return unconditionally,
   which stranded the device — ↻ Sync, sign-out/in and a restart all funnel
   through here, so there was no way back short of rebooting the tablet.
   Now: skip the routine passes when the flag says offline (no point burning a
   fetch), but ALWAYS let an explicit ↻ Sync try, and probe the network anyway
   every PROBE_EVERY skips so a stuck flag heals itself within a few minutes.
   A request that genuinely fails still reports offline — from evidence. */
const PROBE_EVERY = 4;          // ~3 min at the 45s interval
let flagSkips = 0;

export async function syncNow(opts = {}) {
  if (!isSignedIn() || syncing) return;
  if (likelyOffline() && !opts.force) {
    if (++flagSkips % PROBE_EVERY !== 0) { setStatus("offline"); return; }
  }
  flagSkips = 0;
  syncing = true; updateRequired = false; setStatus("syncing");
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
    // push() rethrows the cycle's last error, so a build rejection lands here
    // fetch() rejects (TypeError) when the request never reached the network —
    // that's the honest "offline", proven by a real attempt rather than by a
    // flag that lies. Anything else is a server/app problem and stays an error.
    if (e instanceof TypeError && !updateRequired) setStatus("offline");
    else setStatus("error", {
      needsUpdate: updateRequired,
      message: updateRequired
        ? "This app is out of date — close and reopen it to update, then sync."
        : String((e && e.message) || e),
    });
  } finally {
    syncing = false;
    if (needsAnotherPass) { needsAnotherPass = false; schedulePush(); }  // push freshly merged unions
  }
}

/* ---------- take the cloud's copy of one job, wholesale ----------
   The escape hatch for the one case the merge cannot fix by design. Sync
   NEVER replaces a job this device has unsynced edits on — it merges, and
   the merge is a union. So a job carrying elements another device deleted
   on a build that predates per-item tombstones (merge.js) can sit wrong on
   this device forever: every cycle re-adds them, and every sign-out/in makes
   it worse, because resetSync() marks every local row unsynced and forces
   the merge path. No amount of re-syncing can clear that; a deliberate
   "their copy wins for this job" can.

   Deliberately NOT a merge and deliberately NOT a delete: it drops only THIS
   DEVICE's copy (snapshotted to backups first, so the discarded work is one
   tap away on the job page) and adopts the server row CLEAN, so the next
   cycle pushes nothing back. No tombstone is queued and no other device is
   touched. Throws with a message worth showing the user. */
export async function reloadFromCloud(id) {
  if (!isSignedIn()) throw new Error("Sign in first — this takes the cloud's copy of the job.");
  const row = await fetchRow(id);
  if (!row || row.deleted || !row.data || !row.data.id) {
    throw new Error("The cloud has no copy of this job yet, so there is nothing to take. Let it sync first.");
  }
  const { project: full, missing } = await inflateProject(row.data, downloadRemembered);
  if (missing > 0) {
    // storing markers-as-photos is how second devices used to end up with
    // garbage images — refuse rather than write a corrupt copy
    throw new Error(`${missing} photo${missing === 1 ? "" : "s"} on the cloud copy haven't finished uploading from the other device. Try again in a minute.`);
  }
  const local = await Store.get(id);
  if (local) await Store.backup(local);       // the discarded copy stays restorable on this device
  full.id = id;
  delete full.rev;                            // revs live in sync bookkeeping, not the blob
  await Store.put(full, { quiet: true, bump: false });
  revs[id] = Number(row.data.rev) || 0; saveRevs();
  pushed[id] = full.updatedAt; savePushed();  // clean: nothing left to assert back
  mediaWait.delete(id);
  rowChanged(id);
  return full;
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
  onProjectDeleted((id) => { deletes.set(id, new Date().toISOString()); saveDeletes(); schedulePush(); });

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => syncNow({ force: true }));
    window.addEventListener("offline", () => setStatus("offline"));
    setInterval(() => { if (isSignedIn()) syncNow(); }, 45000);  // catch others' changes
  }
  syncNow();
}

/* clear sync bookkeeping on sign-out (local job data is kept). PENDING DELETES
   are kept too: a delete is user intent, not derived bookkeeping — signing out
   before the tombstone pushed must not silently un-delete the job. */
export function resetSync() {
  cursor = ""; pushed = {}; revs = {}; mediaPushed = new Set(); mediaWait = new Map(); skipped = 0;
  deletes = loadDeletes();                   // kept on disk; reload so memory matches
  localStorage.removeItem(K_CURSOR);
  localStorage.removeItem(K_PUSHED);
  localStorage.removeItem(K_REVS);
  localStorage.removeItem(K_MEDIA);
}
