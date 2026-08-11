/* ============================================================
   Roybal Field Forms — minimal Supabase client (auth + REST)
   No SDK: just fetch calls, to keep the app dependency-free.
   ============================================================ */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const SESSION_KEY = "roybal-session";
const TABLE = "field_projects";

let session = loadSession();
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function isSignedIn() { return !!(session && session.access_token); }
export function currentEmail() { return session ? session.email : ""; }
export function accessToken() { return session ? session.access_token : ""; }

function authHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + (session ? session.access_token : SUPABASE_KEY),
    "Content-Type": "application/json",
  };
}

/* ---------- auth ---------- */
export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || body.error || "Sign-in failed");
  saveSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in || 3600) * 1000,
    email: (body.user && body.user.email) || email.trim(),
  });
  return true;
}

export function signOut() { saveSession(null); }

async function refresh() {
  if (!session || !session.refresh_token) throw new Error("No session");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { saveSession(null); throw new Error("Session expired — please sign in again"); }
  saveSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in || 3600) * 1000,
    email: session.email,
  });
}

async function ensureFresh() {
  if (session && session.expires_at && session.expires_at - Date.now() < 60000) await refresh();
}

async function api(path, opts = {}) {
  await ensureFresh();
  let res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (res.status === 401 && session && session.refresh_token) {
    await refresh();
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  }
  return res;
}

/* ---------- app build tag (server min-build gate) ----------
   The LIVE service-worker cache version is the only honest statement of what
   code this device is running — a stale cached PWA is exactly what the gate
   exists to catch, so a hardcoded constant would defeat it. Unknown stays ""
   and the server treats an unknown build as "don't block". */
let buildTag = "";
(async () => {
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      const keys = await caches.keys();
      const nums = keys.map((k) => (k.match(/^roybal-field-v(\d+)/) || [])[1]).filter(Boolean).map(Number);
      if (nums.length) buildTag = "v" + Math.max(...nums);
    }
  } catch { /* best-effort */ }
})();
export const appBuild = () => buildTag;

/* ---------- sync RPCs (the one authoritative write path) ----------
   Server-side CAS-or-merge: a device that started from a stale copy can no
   longer overwrite anyone — the SERVER unions the two copies (migrations
   217/218). Every call carries the build tag so the server can refuse writes
   from a pre-cutover build once the operator arms the gate. */
async function rpc(fn, args) {
  const res = await api(`rpc/${fn}`, { method: "POST", body: JSON.stringify({ ...args, p_build: buildTag || null }) });
  if (res.ok) return res.json();
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  const err = new Error((body && body.message) || `${fn} failed (${res.status})`);
  err.status = res.status;
  err.code = body && body.code;
  err.needsUpdate = err.code === "P0002";   // this build is older than the server floor
  throw err;
}

/** Push one project. → { status: insert|applied|merged|deleted, rev, data? }
    'merged'  — the server already COMMITTED the union at `rev`; adopt it
                clean (no updatedAt bump, no re-push).
    'deleted' — the row is a tombstone and nothing was written; the caller
                decides revive-vs-respect. */
export const pushProject = (id, base, data) =>
  rpc("push_project", { p_id: id, p_base_rev: base, p_data: data });

/** Soft-delete, carrying the job's last-known content inside the tombstone. */
export const tombstoneProject = (id, data) =>
  rpc("tombstone_project", { p_id: id, p_data: data || null });

/** Deliberately flip a tombstone back alive. → { status: revived|conflict|missing }
    'conflict' means another device already revived it (its live copy is
    returned) — merge against that instead of clobbering. */
export const reviveProject = (id, data) =>
  rpc("revive_project", { p_id: id, p_data: data });

/* ---------- data ---------- */
/** Upsert an array of { id, data, deleted } rows. Returns server rows. */
export async function upsertRows(rows) {
  if (!rows.length) return [];
  const res = await api(TABLE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("Push failed (" + res.status + "): " + (await res.text().catch(() => "")));
  return res.json();
}

/** Optimistic-concurrency write for one project row — the board's
    data->>rev guard (data.js guardedJobWrite), ported to field_projects.
    The PATCH only lands if the server still holds the rev this device
    started from; otherwise { conflict, server } comes back and the caller
    MERGES instead of clobbering. Legacy rows (no rev yet) match base 0. */
export async function guardedUpsertRow(id, base, data) {
  const eid = encodeURIComponent(id);
  const guard = base > 0 ? `data->>rev=eq.${base}` : `or=(data->>rev.is.null,data->>rev.eq.0)`;
  // deleted=eq.false: a routine push must NEVER silently revive a tombstone.
  // (A tombstone's data carries no rev, so it used to match the base-0 guard —
  // that's how deleted junk jobs kept resurrecting.) A push against a deleted
  // row falls through to the conflict check below, and the CALLER decides
  // whether the delete wins or the job is deliberately revived with its work.
  const res = await api(`${TABLE}?id=eq.${eid}&deleted=eq.false&${guard}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ data, deleted: false }),
  });
  if (!res.ok) throw new Error("Push failed (" + res.status + ")");
  const rows = await res.json();
  if (rows.length) return { ok: true };
  // 0 rows: the row doesn't exist yet (new job), moved (conflict), or is deleted
  const chk = await api(`${TABLE}?id=eq.${eid}&select=id,data,deleted`, { method: "GET" });
  if (!chk.ok) throw new Error("Push check failed (" + chk.status + ")");
  const existing = await chk.json();
  if (!existing.length) {
    const ins = await api(TABLE, {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ id, data, deleted: false }]),
    });
    if (ins.ok) return { ok: true };
    if (ins.status === 409) return { conflict: true, server: null };
    throw new Error("Push insert failed (" + ins.status + ")");
  }
  return { conflict: true, server: existing[0].data, serverDeleted: !!existing[0].deleted };
}

/** Deliberately flip a DELETED row back alive — the only sanctioned way to
    revive a tombstone. Guarded on deleted=eq.true: if another device already
    revived (or otherwise moved) the row, this matches 0 rows and the caller
    merges against the live copy instead of clobbering it. */
export async function reviveRow(id, data) {
  const res = await api(`${TABLE}?id=eq.${encodeURIComponent(id)}&deleted=eq.true`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ data, deleted: false }),
  });
  if (!res.ok) throw new Error("Revive failed (" + res.status + ")");
  const rows = await res.json();
  return { ok: rows.length > 0 };
}

/** Fetch one row (or null) — the tombstone push checks staleness with this. */
export async function fetchRow(id) {
  const res = await api(`${TABLE}?id=eq.${encodeURIComponent(id)}&select=id,data,deleted,updated_at`, { method: "GET" });
  if (!res.ok) throw new Error("Row check failed (" + res.status + ")");
  const rows = await res.json();
  return rows[0] || null;
}

/* ---------- media storage (field-media bucket) ----------
   Sync offloads big data-URL strings (photos, plan pages, sketches) to
   the private field-media bucket, content-addressed by sha256, so the
   field_projects JSON rows stay small enough to always back up. */
const MEDIA_BUCKET = "field-media";

/** Upload one media string. Idempotent: same content → same object. */
export async function uploadMedia(hash, text) {
  await ensureFresh();
  const url = `${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${hash}`;
  const send = () => fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "text/plain", "x-upsert": "true" },
    body: text,
  });
  let res = await send();
  if (res.status === 401 && session && session.refresh_token) { await refresh(); res = await send(); }
  if (!res.ok && res.status !== 409) throw new Error("Media upload failed (" + res.status + ")");
}

/** Cheap existence check (HEAD) — the photo-offload flow verifies a bucket
    copy exists before it drops the inline original. */
export async function mediaExists(hash) {
  await ensureFresh();
  const url = `${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${hash}`;
  const send = () => fetch(url, { method: "HEAD", headers: { ...authHeaders() } });
  let res = await send();
  if (res.status === 401 && session && session.refresh_token) { await refresh(); res = await send(); }
  return res.ok;
}

/** Download a media string; null when it no longer exists on the server. */
export async function downloadMedia(hash) {
  await ensureFresh();
  const url = `${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${hash}`;
  const send = () => fetch(url, { headers: { ...authHeaders() } });
  let res = await send();
  if (res.status === 401 && session && session.refresh_token) { await refresh(); res = await send(); }
  if (res.status === 404 || res.status === 400) return null;   // storage says "Object not found" with either
  if (!res.ok) throw new Error("Media download failed (" + res.status + ")");
  return res.text();
}

/** Fetch rows changed since an ISO timestamp (exclusive). */
export async function fetchSince(iso) {
  const q = iso ? `&updated_at=gt.${encodeURIComponent(iso)}` : "";
  const res = await api(`${TABLE}?select=id,data,deleted,updated_at&order=updated_at.asc${q}`, { method: "GET" });
  if (!res.ok) throw new Error("Pull failed (" + res.status + "): " + (await res.text().catch(() => "")));
  return res.json();
}

/** Call a Supabase Edge Function, forwarding the crew session token (so the
    function can gate on a valid user) and auto-refreshing like the REST path.
    Returns the raw fetch Response. */
export async function callFunction(name, body = {}) {
  await ensureFresh();
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  const send = () => fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && session && session.refresh_token) { await refresh(); res = await send(); }
  return res;
}

/* ---------- generic REST (shared by sibling office apps) ---------- */
/** Authenticated REST call against any table, sharing this login session.
    Auto-refreshes the token (and retries once on 401), exactly like the
    field sync. Used by the Job Board app, which has its own tables but the
    same shared crew login. Returns the raw fetch Response. */
export async function rest(path, opts = {}) {
  return api(path, opts);
}
