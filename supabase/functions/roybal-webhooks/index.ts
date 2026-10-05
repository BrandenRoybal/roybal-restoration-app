/**
 * Supabase Edge Function: roybal-webhooks
 *
 * Inbound calls from the database itself. One route today:
 *
 *   POST /alert   — the dead-worker alarm. pg_cron runs worker_liveness_check()
 *                   every 5 minutes (migration 0015); when no worker has
 *                   checked in for 10 minutes it POSTs here through pg_net with
 *                   the vault secret `worker_alert_secret` in x-roybal-secret.
 *                   This function verifies the secret, RE-READS worker_heartbeats
 *                   (a forged or replayed POST can only ever cause a true alarm),
 *                   texts the owner once per 24 h through roybal-notify (kind
 *                   `brief`: owner-directed, quiet-hours exempt — a dead worker
 *                   at 2am is the whole point), and records the text in
 *                   app_settings `worker.alert_texted`.
 *
 *   GET  /healthz — 200, for a thread checking the function is deployed.
 *
 * verify_jwt is false (supabase/config.toml): pg_net sends no JWT. The secret
 * header is the gate, and the heartbeat re-read is the floor under it.
 * The rules live in alert.ts and are tested under Node (alert.test.mjs).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { decideAlert, alertText, safeEqual, parseAlertBody } from "./alert.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OWNER_CELL = Deno.env.get("OWNER_CELL") ?? "";

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svc, ...(init.headers ?? {}) } });
}

async function expectedSecret(): Promise<string> {
  const res = await rest("rpc/worker_alert_secret", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`worker_alert_secret rpc ${res.status}`);
  const v = await res.json().catch(() => null);
  return typeof v === "string" ? v : "";
}

async function handleAlert(req: Request): Promise<Response> {
  let expected = "";
  try {
    expected = await expectedSecret();
  } catch (e) {
    console.error("alert: cannot read the vault secret", String((e as Error)?.message ?? e));
    return json({ ok: false, error: "secret unavailable" }, 503);
  }
  if (!expected || !safeEqual(req.headers.get("x-roybal-secret") ?? "", expected)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const body = parseAlertBody(await req.json().catch(() => ({})));
  if (body.kind !== "worker_down") return json({ ok: false, error: "unknown alert kind" }, 400);

  // The floor: the heartbeat table itself, under the service key.
  const hb = await rest("worker_heartbeats?select=worker_id,at&order=at.desc&limit=1");
  const rows = hb.ok ? ((await hb.json().catch(() => [])) as Array<{ worker_id: string; at: string }>) : [];
  const st = await rest("app_settings?select=value&key=eq.worker.alert_texted");
  const prev = st.ok ? ((await st.json().catch(() => [])) as Array<{ value: { texted_at?: string } }>)[0]?.value : undefined;

  const now = Date.now();
  const decision = decideAlert({ now, lastHeartbeatAt: rows[0]?.at ?? null, lastTextedAt: prev?.texted_at ?? null });
  console.log(`alert: ${decision.reason}; last heartbeat ${rows[0]?.at ?? "none"} (${rows[0]?.worker_id ?? "-"}); db says ${body.last_heartbeat_at ?? "-"}`);
  if (!decision.text) return json({ ok: true, texted: false, reason: decision.reason });
  if (!OWNER_CELL) {
    console.error("alert: OWNER_CELL is not set; nobody to text");
    return json({ ok: false, texted: false, error: "OWNER_CELL unset" }, 500);
  }

  const text = alertText({ now, lastHeartbeatAt: rows[0]?.at ?? null, workerId: rows[0]?.worker_id ?? body.worker_id });
  const send = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ action: "sendSms", to: OWNER_CELL, body: text, kind: "brief", captured_by: "worker-liveness" }),
  });
  const sd = (await send.json().catch(() => ({}))) as { ok?: boolean; sid?: string; error?: string };
  if (!send.ok || sd.ok !== true) {
    console.error("alert: roybal-notify refused", send.status, String(sd.error ?? "").slice(0, 200));
    return json({ ok: false, texted: false, error: sd.error ?? `notify ${send.status}` }, 502);
  }

  await rest("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{
      key: "worker.alert_texted",
      value: { texted_at: new Date(now).toISOString(), sid: sd.sid ?? null, worker_id: rows[0]?.worker_id ?? body.worker_id ?? null, last_heartbeat_at: rows[0]?.at ?? null },
      updated_at: new Date(now).toISOString(),
    }]),
  }).catch((e) => console.error("alert: could not record the text", String(e)));

  return json({ ok: true, texted: true, sid: sd.sid ?? null });
}

serve(async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && /\/healthz\/?$/.test(path)) return json({ ok: true, fn: "roybal-webhooks" });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (/\/alert\/?$/.test(path)) {
    try {
      return await handleAlert(req);
    } catch (e) {
      console.error("alert failed", String((e as Error)?.message ?? e));
      return json({ ok: false, error: "alert failed" }, 500);
    }
  }
  return json({ ok: false, error: "not found" }, 404);
});
