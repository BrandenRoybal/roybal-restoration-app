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
import { buildBrief, invoiceTotals, reminderEmail, type Blob } from "./digest.ts";
import { buildWeekly } from "./weekly.ts";

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

    // ---------- weekly mode: "what the AI did" (cron, Sundays) ----------
    const mode = String((await req.clone().json().catch(() => ({})))?.mode || "");
    if (mode === "weekly") {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const count = (path: string) =>
        fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
          headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, Prefer: "count=exact", Range: "0-0" },
        }).then((r) => (r.ok ? Number((r.headers.get("content-range") || "").split("/")[1]) || 0 : 0)).catch(() => 0);
      const [events, emailsFiled, emailsSent] = await Promise.all([
        rest(jwt, `capture_events?select=source_type,captured_by,result&processed_at=gte.${encodeURIComponent(weekAgo)}&limit=1000`).catch(() => []),
        count(`email_messages?select=id&direction=eq.in&received_at=gte.${encodeURIComponent(weekAgo)}`),
        count(`email_messages?select=id&direction=eq.out&received_at=gte.${encodeURIComponent(weekAgo)}`),
      ]);
      const fmt = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/Anchorage", month: "short", day: "numeric" });
      const weekLabel = `${fmt(new Date(Date.now() - 6 * 86400000))} – ${fmt(new Date())}`;
      const weekly = buildWeekly({ events: events as Blob[], emailsFiled, emailsSent, weekLabel });
      const send = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sendSms", to: OWNER_CELL, body: weekly.text, kind: "brief", captured_by: "weekly-report" }),
      });
      const sd = await send.json().catch(() => ({}));
      await fetch(`${SUPABASE_URL}/rest/v1/capture_events`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify([{
          source_type: "weekly_report", form_key: "weeklyReport", captured_by: "weekly-report",
          status: "extracted", processed_at: new Date().toISOString(),
          raw_payload: { items: weekly.items, chars: weekly.text.length },
          result: { sent: send.ok && sd.ok !== false },
        }]),
      }).catch(() => {});
      if (!(send.ok && sd.ok !== false)) return json({ ok: false, error: `notify failed: ${String(sd.error || send.status)}` }, 502);
      return json({ ok: true, mode: "weekly", items: weekly.items, chars: weekly.text.length });
    }

    const [projRows, boardRows, portalWaiting, emailRows] = await Promise.all([
      rest(jwt, "field_projects?select=id,data,updated_at&deleted=eq.false&limit=300"),
      rest(jwt, "coordination_jobs?select=id,data&deleted=eq.false&limit=300"),
      fetch(`${SUPABASE_URL}/rest/v1/portal_messages?select=id&direction=eq.in&read_by_office=eq.false`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, Prefer: "count=exact", Range: "0-0" },
      }).then((r) => (r.ok ? Number((r.headers.get("content-range") || "").split("/")[1]) || 0 : null))
        .catch(() => null),
      // job-matched unread email (the lane may not exist yet — degrade to null)
      rest(jwt, "email_messages?select=received_at&direction=eq.in&read_by_office=eq.false&order=received_at.asc&limit=50")
        .catch(() => null),
    ]);
    const emailsWaiting = Array.isArray(emailRows)
      ? { count: emailRows.length, oldest: emailRows[0] ? String(emailRows[0].received_at || "").slice(0, 10) : undefined }
      : null;
    const projects: Blob[] = projRows
      .filter((r: Blob) => r?.data)
      .map((r: Blob) => ({ ...r.data, _rowUpdated: r.updated_at }));
    const boardJobs: Blob[] = boardRows
      .filter((r: Blob) => r?.data && r.id !== "__settings__")
      .map((r: Blob) => r.data);
    // the board's baseline snapshot (Gantt "Baseline") rides the settings row —
    // it's the reference that catches phased jobs the live engine keeps
    // re-dating to >= today (they're never "past target", only "behind baseline")
    const boardBaseline: Blob | null =
      (boardRows.find((r: Blob) => r?.id === "__settings__")?.data?.baseline as Blob) || null;

    // ---------- approve-by-text proposals (max 2) ----------
    // The brief may PROPOSE (an insert changes nothing until the owner texts
    // YES — migration 210's RLS lets the read-only machine user do exactly
    // this and nothing else). v1 proposes overdue-invoice reminder emails for
    // jobs with a customer email on file, skipping invoices already proposed
    // or reminded within 7 days.
    const proposals: { code: number; label: string }[] = [];
    try {
      const today = akDate();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const recent = await rest(jwt,
        `pending_actions?kind=eq.emailSend&created_at=gte.${encodeURIComponent(weekAgo)}&select=code,status,params,expires_at&limit=100`)
        .catch(() => []) as Blob[];
      const alreadyKeys = new Set(recent
        .filter((a) => a.status === "pending" || a.status === "approved" || a.status === "executed")
        .map((a) => String(a.params?.invoiceKey || "")));
      const usedCodes = new Set(recent.filter((a) => a.status === "pending").map((a) => Number(a.code)));
      let nextCode = 11;
      const takeCode = () => { while (usedCodes.has(nextCode)) nextCode++; usedCodes.add(nextCode); return nextCode; };

      const candidates: { p: Blob; inv: Blob; days: number }[] = [];
      for (const p of projects) {
        if (!String(p.email || "").includes("@")) continue;
        for (const inv of p.invoices || []) {
          if (!["sent", "viewed", "partially_paid"].includes(inv?.status)) continue;
          if (!inv.dueDate || inv.dueDate >= today) continue;
          const key = `${p.id}:${inv.invoiceNo || inv.id || ""}`;
          if (alreadyKeys.has(key)) continue;
          candidates.push({ p, inv, days: Math.floor((Date.parse(today) - Date.parse(inv.dueDate)) / 86400000) });
        }
      }
      candidates.sort((a, b) => b.days - a.days);
      for (const c of candidates.slice(0, 2)) {
        const balance = invoiceTotals(c.inv).total;
        if (!(balance > 0)) continue;
        const mail = reminderEmail(c.p, c.inv, balance);
        const code = takeCode();
        const label = `email the ${c.inv.invoiceNo || "overdue invoice"} reminder to ${c.p.customer || c.p.address || "the customer"}`;
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/pending_actions`, {
          method: "POST",
          headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify([{
            code, kind: "emailSend", label, job_id: c.p.id, proposed_by: "morning-brief",
            params: {
              to: String(c.p.email).trim(), subject: mail.subject, body: mail.body,
              jobId: c.p.id, invoiceKey: `${c.p.id}:${c.inv.invoiceNo || c.inv.id || ""}`,
            },
          }]),
        });
        if (ins.ok) proposals.push({ code, label });
      }
    } catch (e) { console.error("proposals skipped:", (e as Error).message); }

    const brief = buildBrief({
      projects, boardJobs, boardBaseline, portalWaiting, emailsWaiting, proposals,
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
