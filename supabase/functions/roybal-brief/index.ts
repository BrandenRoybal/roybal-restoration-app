/**
 * Supabase Edge Function: roybal-brief
 *
 * The server-side brain's first organ: the MORNING BRIEF. Every morning
 * (pg_cron, migration 206) this function reads the whole operation under a
 * read-only machine login, computes what needs the owner's attention, and
 * texts one message to OWNER_CELL through roybal-notify. v1 is DELIBERATELY
 * LLM-free — a deterministic digest costs nothing, can't hallucinate, and
 * always sends. (The assistant lanes stay for conversation; this is the
 * employee who opens the office before you do.)
 *
 * What it watches (v1) — the digest itself is pure and unit-tested, see
 * ./digest.ts:
 *   💵 overdue invoices (chip-tracked lifecycles)   📈 budget-hot jobs
 *   🌀 equipment out ≥7d      🧊 stale jobs          📅 board slips
 *   🧱 materials not ordered near start              📨 portal messages
 *   ❓ questions — what looks MISSING, asked instead of assumed
 *
 * Auth: the cron call carries x-cron-secret (same CRON_SECRET pattern as
 * qb-time-proxy). Reads run as office-brief@roybalconstruction.com — a
 * dedicated machine user whose writes are denied by migration 205, so a
 * compromised brief can read the shop but never change it. The only rows it
 * creates: one capture_events envelope per run (the audit trail) and the
 * sms_messages row roybal-notify logs for the text itself.
 *
 * SETUP (owner, once):
 *   1. Supabase Dashboard → Auth → Add user: office-brief@roybalconstruction.com,
 *      strong password, auto-confirm. (Migration 205 fences it.)
 *   2. supabase secrets set BRIEF_MACHINE_PASSWORD="<that password>"
 *      (CRON_SECRET and OWNER_CELL already exist from earlier lanes.)
 *   3. Deploy:  supabase functions deploy roybal-brief --no-verify-jwt
 *   4. Run migration 206 in the SQL editor with __CRON_SECRET__ filled in.
 *   Manual test:  curl -X POST <url>/functions/v1/roybal-brief \
 *                   -H "x-cron-secret: $CRON_SECRET"
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildBrief, type Blob } from "./digest.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const OWNER_CELL = Deno.env.get("OWNER_CELL") ?? "";
const MACHINE_EMAIL = Deno.env.get("BRIEF_MACHINE_EMAIL") ?? "office-brief@roybalconstruction.com";
const MACHINE_PASSWORD = Deno.env.get("BRIEF_MACHINE_PASSWORD") ?? "";
const BUDGET_THRESHOLD = Number(Deno.env.get("BRIEF_BUDGET_THRESHOLD") ?? "0.9") || 0.9;

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

const akDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Anchorage" });
const akPretty = () => new Date().toLocaleDateString("en-US",
  { timeZone: "America/Anchorage", weekday: "short", month: "short", day: "numeric" });

async function signIn(): Promise<string> {
  if (!MACHINE_PASSWORD) throw new Error("BRIEF_MACHINE_PASSWORD not set");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: MACHINE_EMAIL, password: MACHINE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`machine sign-in failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).access_token as string;
}
async function rest(jwt: string, path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`read ${path.split("?")[0]} failed (${res.status})`);
  return res.json();
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET)
    return json({ ok: false, error: "bad cron secret" }, 401);
  if (!OWNER_CELL) return json({ ok: false, error: "OWNER_CELL not set" }, 500);

  try {
    const jwt = await signIn();
    const [projRows, boardRows, portalWaiting] = await Promise.all([
      rest(jwt, "field_projects?select=id,data,updated_at&deleted=eq.false&limit=300"),
      rest(jwt, "coordination_jobs?select=id,data&deleted=eq.false&limit=300"),
      fetch(`${SUPABASE_URL}/rest/v1/portal_messages?select=id&direction=eq.in&read_by_office=eq.false`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, Prefer: "count=exact", Range: "0-0" },
      }).then((r) => (r.ok ? Number((r.headers.get("content-range") || "").split("/")[1]) || 0 : null))
        .catch(() => null),
    ]);
    const projects: Blob[] = projRows
      .filter((r: Blob) => r?.data)
      .map((r: Blob) => ({ ...r.data, _rowUpdated: r.updated_at }));
    const boardJobs: Blob[] = boardRows
      .filter((r: Blob) => r?.data && r.id !== "__settings__")
      .map((r: Blob) => r.data);

    const brief = buildBrief({
      projects, boardJobs, portalWaiting,
      today: akDate(), pretty: akPretty(), budgetThreshold: BUDGET_THRESHOLD,
    });

    // the text rides roybal-notify so it lands in the same SMS ledger as
    // everything else ("brief" is quiet-hours exempt — it's FOR the owner)
    const send = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sendSms", to: OWNER_CELL, body: brief.text, kind: "brief", captured_by: "morning-brief" }),
    });
    const sendData = await send.json().catch(() => ({}));
    const sent = send.ok && sendData.ok !== false;

    // audit envelope — one row per run, same ledger as every AI lane
    await fetch(`${SUPABASE_URL}/rest/v1/capture_events`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify([{
        source_type: "daily_brief", form_key: "dailyBrief", captured_by: "morning-brief",
        status: "extracted", processed_at: new Date().toISOString(),
        raw_payload: { flags: brief.flags, chars: brief.text.length },
        result: { sent, flags: brief.flags, error: sent ? undefined : String(sendData.error || send.status) },
      }]),
    }).catch(() => { /* the brief itself matters more than its receipt */ });

    if (!sent) return json({ ok: false, error: `notify failed: ${String(sendData.error || send.status)}` }, 502);
    return json({ ok: true, flags: brief.flags, chars: brief.text.length });
  } catch (e) {
    console.error("brief failed:", (e as Error).message);
    return json({ ok: false, error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
