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
