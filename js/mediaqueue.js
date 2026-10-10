/* ============================================================
   Roybal Field Forms — the media queue
   ------------------------------------------------------------
   Walk clips are recorded with no signal at a job in Salcha and have to
   upload themselves in the truck on the Richardson. So a clip (and each of
   its stills) is written to IndexedDB (core.js MediaStore) the moment it is
   captured — BEFORE stills are pulled or anything is shown as saved — and
   this module drains that store whenever the phone can: on app open, on
   `online`, on the tab becoming visible. Big files go up resumably (tusup.js,
   6 MiB chunks, resume from the server's offset after a drop); small ones
   by the plain POST. A row leaves the store only after the last byte is
   acknowledged. Five failed attempts park a row as "failed" until someone
   taps retry. Nothing here writes to a job record: the queue's presence IS
   the truth, and the Site Visit panel reconciles against it when it opens
   (docs/Narrated_Walkthrough_Design.md §4.3, §10 V1).

   The drain is pure enough to run under Node with injected `deps`
   (test/mediaqueue.test.mjs). The banner at the bottom is the only DOM.
   ============================================================ */
import { h, MediaStore, likelyOffline } from "./core.js";
import { isSignedIn, uploadSiteFile, uploadSiteFileResumable } from "./supa.js";
import { retryable } from "./tusup.js";

export const MAX_ATTEMPTS = 5;
export const RESUMABLE_MIN_BYTES = 6 * 1024 * 1024;   // under one chunk: the plain POST is simpler and just as safe

/* ---------- injectable edges (tests swap these) ---------- */
export const deps = {
  upload: (path, blob, mime) => uploadSiteFile(path, blob, mime),
  uploadResumable: (path, blob, mime, opts) => uploadSiteFileResumable(path, blob, mime, opts),
  online: () => (typeof navigator === "undefined" || navigator.onLine !== false) && !likelyOffline(),
  signedIn: () => isSignedIn(),
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  now: () => new Date().toISOString(),
};

/* ---------- events ---------- */
const listeners = new Set();
/** fn({ type: queued|progress|uploaded|error|failed|paused|removed, row }) — row never carries the blob. */
export function onMedia(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let uploadingId = null;
export function publicRow(r) {
  if (!r) return null;
  const attempts = Number(r.attempts) || 0, size = Number(r.size) || 0, sent = Math.min(size, Number(r.bytesSent) || 0);
  return {
    id: r.id, projectId: r.projectId, kind: r.kind, name: r.name || "", path: r.path || "", mime: r.mime || "", size,
    bytesSent: sent, pct: size ? Math.floor(sent * 100 / size) : 0, attempts, lastError: r.lastError || "", createdAt: r.createdAt || "",
    status: attempts >= MAX_ATTEMPTS ? "failed" : uploadingId === r.id ? "uploading" : "queued",
  };
}
const emit = (type, row) => { const pub = publicRow(row); for (const fn of listeners) { try { fn({ type, row: pub }); } catch { /* a listener must never stop the queue */ } } };

/* ---------- the queue ---------- */
/** Put a capture in the queue. Resolves once it is safely in IndexedDB. */
export async function enqueueMedia({ id, projectId, kind, blob, mime, name, path }) {
  if (!id || !projectId || !path || !blob) throw new Error("enqueueMedia: id, projectId, path and blob are required");
  const row = { id, projectId, kind: kind || "walk", blob, mime: mime || blob.type || "application/octet-stream", size: blob.size || 0,
    name: name || "", path, bytesSent: 0, tusUrl: "", createdAt: deps.now(), attempts: 0, lastError: "" };
  await MediaStore.put(row);
  emit("queued", row);
  scheduleDrain();
  return publicRow(row);
}
/** Rows waiting (or failed), oldest first; without blobs. */
export async function queueRows(projectId = null) {
  const rows = await MediaStore.all();
  return rows.filter((r) => !projectId || r.projectId === projectId).map(publicRow);
}
/** What the banners show: how many, how big, how far, and whose. */
export async function queueSummary(projectId = null) {
  const rows = await queueRows(projectId);
  const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  return {
    count: rows.length, clips: rows.filter((r) => r.kind === "walk" || r.kind === "meeting").length,
    bytes: sum("size"), bytesSent: sum("bytesSent"), failed: rows.filter((r) => r.status === "failed").length,
    uploading: rows.find((r) => r.status === "uploading") || null,
    projects: [...new Set(rows.map((r) => r.projectId))],
  };
}
/** The bytes of a file still waiting in the queue (a clip recorded with no
    signal plays from the phone), or null once it has uploaded. */
export async function queuedBlob(id) {
  try { const r = await MediaStore.get(id); return (r && r.blob) || null; } catch { return null; }
}

export async function retryMedia(id) {
  const row = await MediaStore.get(id);
  if (!row) return null;
  row.attempts = 0; row.lastError = "";
  await MediaStore.put(row);
  emit("queued", row);
  scheduleDrain();
  return publicRow(row);
}
export async function removeMedia(id) {
  const row = await MediaStore.get(id);
  if (!row) return false;
  if (uploadingId === id) pauseMediaQueue();
  await MediaStore.del(id);
  emit("removed", row);
  return true;
}

/* ---------- the drain: one row at a time, oldest first ---------- */
let draining = null, ctl = null, wanted = false;
function scheduleDrain() { if (typeof queueMicrotask === "function") queueMicrotask(() => { drainMediaQueue().catch(() => {}); }); }

/** Upload everything it can, then return. Safe to call from anywhere, any
    time: a call while a drain is running joins it (and asks it to look
    again before it stops), so awaiting this always means "the queue had
    its chance". */
export function drainMediaQueue() {
  if (draining) { wanted = true; return draining; }
  draining = drainOnce().finally(() => { draining = null; });
  return draining;
}
async function drainOnce() {
  const tried = new Set();
  try {
    do {
      wanted = false;
      while (deps.signedIn() && deps.online() && deps.visible()) {
        const rows = (await MediaStore.all()).filter((r) => (Number(r.attempts) || 0) < MAX_ATTEMPTS && !tried.has(r.id));
        if (!rows.length) break;
        const row = rows[0];
        tried.add(row.id);
        uploadingId = row.id; ctl = typeof AbortController === "function" ? new AbortController() : null;
        emit("progress", row);
        try {
          if (row.size >= RESUMABLE_MIN_BYTES) {
            await deps.uploadResumable(row.path, row.blob, row.mime, {
              uploadUrl: row.tusUrl, offset: row.bytesSent, signal: ctl ? ctl.signal : undefined,
              onProgress: async (sent, _total, url) => { row.bytesSent = sent; row.tusUrl = url || row.tusUrl; await MediaStore.put(row); emit("progress", row); },
            });
          } else {
            await deps.upload(row.path, row.blob, row.mime);
          }
          uploadingId = null;
          await MediaStore.del(row.id);
          emit("uploaded", row);
        } catch (e) {
          uploadingId = null;
          if (e && e.name === "AbortError") { emit("paused", row); return; }   // paused on purpose: progress is on the server, come back later
          if (e && (e.status === 404 || e.status === 410)) { row.tusUrl = ""; row.bytesSent = 0; }   // the upload URL expired: next try starts over
          row.attempts = retryable(e) ? (Number(row.attempts) || 0) + 1 : MAX_ATTEMPTS;
          row.lastError = String((e && e.message) || e).slice(0, 200);
          await MediaStore.put(row);
          emit(row.attempts >= MAX_ATTEMPTS ? "failed" : "error", row);
          if (e instanceof TypeError || !deps.online()) return;   // the network went away: `online` brings us back
        } finally {
          uploadingId = null; ctl = null;
        }
      }
    } while (wanted);
  } finally {
    uploadingId = null; ctl = null;
  }
}
/** Stop the in-flight chunk (the tab went to the background). Progress so far stays on the server. */
export function pauseMediaQueue() { if (ctl) { try { ctl.abort(); } catch { /* already done */ } } }

let started = false;
/** Wire the browser events once, then drain. Called at app boot. */
export function startMediaQueue() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => drainMediaQueue().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") drainMediaQueue().catch(() => {});
    else pauseMediaQueue();
  });
  drainMediaQueue().catch(() => {});
}

/* ---------- the field-home banner ----------
   "2 clips waiting to upload · 410 MB" — visible from the truck without
   opening the job. Tap opens the job when they all belong to one. */
export const fmtMB = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB");
export function bannerText(sum) {
  if (!sum || !sum.count) return "";
  const what = sum.clips ? `${sum.clips} clip${sum.clips === 1 ? "" : "s"}` : `${sum.count} file${sum.count === 1 ? "" : "s"}`;
  if (sum.failed && sum.failed === sum.count) return `${what} failed to upload — open the job to retry`;
  const up = sum.uploading ? ` · uploading ${sum.uploading.pct}%` : "";
  return `${what} waiting to upload · ${fmtMB(sum.bytes - sum.bytesSent)}${up}${sum.failed ? ` · ${sum.failed} failed` : ""}`;
}
export function mediaQueueBanner({ onOpen } = {}) {
  const el = h("div", { class: "card", hidden: true, style: "margin:8px 0;padding:8px 12px;background:#fff4e5;border:1px solid #f0b463;font-size:13px;cursor:pointer" });
  let projects = [];
  el.addEventListener("click", () => { if (onOpen && projects.length === 1) onOpen(projects[0]); else drainMediaQueue().catch(() => {}); });
  const refresh = async () => {
    try {
      const sum = await queueSummary();
      projects = sum.projects;
      const text = bannerText(sum);
      el.hidden = !text;
      el.textContent = text ? `📤 ${text}` + (projects.length === 1 ? " — tap to open the job" : "") : "";
    } catch { el.hidden = true; }
  };
  const off = onMedia(() => refresh());
  el.addEventListener("DOMNodeRemovedFromDocument", off);   // best effort; a leaked listener only repaints a detached node
  refresh();
  return el;
}
