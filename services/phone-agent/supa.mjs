/* ============================================================
   Roybal phone agent — Supabase machine session (RLS-scoped)
   ------------------------------------------------------------
   Password-grant sign-in as the dedicated machine user; every
   REST call carries that JWT so RLS applies exactly as it does
   for a crew login — plus the restrictive deny policies that
   strip this email of UPDATE/DELETE rights (migration 204).
   Never a service key anywhere in this process.
   ============================================================ */
import { SUPABASE_URL, SUPABASE_ANON_KEY, MACHINE_EMAIL, MACHINE_PASSWORD } from "./config.mjs";

let session = null; // { access_token, refresh_token, expires_at }

async function tokenGrant(body, grant) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`auth ${grant} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  };
  return session;
}

export async function signIn() {
  if (!MACHINE_PASSWORD) throw new Error("MACHINE_PASSWORD not set — the agent has no Supabase identity");
  return tokenGrant({ email: MACHINE_EMAIL, password: MACHINE_PASSWORD }, "password");
}

async function ensureFresh() {
  if (!session) return signIn();
  if (session.expires_at - Date.now() < 60_000) {
    try { return await tokenGrant({ refresh_token: session.refresh_token }, "refresh_token"); }
    catch { return signIn(); } // refresh tokens are single-use — a lost race re-signs-in
  }
  return session;
}

export const accessToken = () => (session ? session.access_token : "");

/** Authenticated PostgREST call; retries once on 401 after a re-auth. */
export async function rest(path, opts = {}) {
  await ensureFresh();
  const call = () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json", ...(opts.headers || {}),
    },
  });
  let res = await call();
  if (res.status === 401) { await signIn(); res = await call(); }
  return res;
}

export async function insertRow(table, row) {
  const res = await rest(table, {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`insert ${table} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json().catch(() => []))[0] ?? null;
}

export async function patchCaptureEvent(id, patch) {
  try { await rest(`capture_events?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }); }
  catch { /* the envelope patch is best-effort */ }
}

const billingMonth = () => new Date().toISOString().slice(0, 7);

/** Month-to-date AI spend — paginated exactly like roybal-ai-office, so a
    busy month can't undercount its way past the cap. */
export async function monthSpend() {
  let sum = 0;
  for (let page = 0; page < 20; page++) {
    const from = page * 1000;
    const res = await rest(`ai_usage?select=cost_usd&billing_month=eq.${billingMonth()}`,
      { method: "GET", headers: { Range: `${from}-${from + 999}` } });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`spend read failed (${res.status})`);
    const rows = await res.json().catch(() => []);
    sum += rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
    if (rows.length < 1000) break;
  }
  return sum;
}

/** Month-to-date phone seconds (the voice-minutes cap's odometer). */
export async function monthPhoneSeconds() {
  let sum = 0;
  for (let page = 0; page < 20; page++) {
    const from = page * 1000;
    const res = await rest(
      `ai_usage?select=audio_seconds&billing_month=eq.${billingMonth()}&form_key=eq.phoneCall`,
      { method: "GET", headers: { Range: `${from}-${from + 999}` } });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`minutes read failed (${res.status})`);
    const rows = await res.json().catch(() => []);
    sum += rows.reduce((a, r) => a + (Number(r.audio_seconds) || 0), 0);
    if (rows.length < 1000) break;
  }
  return sum;
}
