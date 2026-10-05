/* Worker configuration — everything comes from the environment (Fly secrets
   and fly.toml [env]). Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
   Optional: GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET (without both, the email
   lane stays off and email rows wait as pending), OWNER_CELL (without it, the
   dead-letter text is off; the dead-WORKER text is the database's job, not
   this process's). Numbers are clamped so a typo cannot make the worker spin
   or go silent. */
import os from "node:os";

export const OUTBOX_AGENT_ID = "0a7ac824-5042-4bb5-ab0d-8569cea209b1"; // agents seed, migration 0004

export function loadConfig(env = process.env) {
  const url = String(env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const missing = [];
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) missing.push("SUPABASE_URL (https://<ref>.supabase.co)");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`worker: missing ${missing.join(", ")}`);

  const num = (name, dflt, lo, hi) => {
    const n = Number(env[name] ?? dflt);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dflt;
  };
  const list = (name, dflt) =>
    String(env[name] ?? dflt).split(",").map((s) => s.trim()).filter(Boolean);

  const gmailClientId = String(env.GMAIL_CLIENT_ID ?? "").trim();
  const gmailClientSecret = String(env.GMAIL_CLIENT_SECRET ?? "").trim();
  const emailEnabled = Boolean(gmailClientId && gmailClientSecret);
  const channels = list("OUTBOX_CHANNELS", "sms,email").filter((c) => c !== "email" || emailEnabled);

  return {
    supabaseUrl: url,
    serviceKey: key,
    workerId: String(env.WORKER_ID ?? "").trim()
      || `${env.FLY_APP_NAME || "roybal-worker"}-${env.FLY_MACHINE_ID || os.hostname()}`,
    version: String(env.WORKER_VERSION || env.FLY_IMAGE_REF || "dev").slice(0, 120),
    region: String(env.FLY_REGION ?? ""),
    port: num("PORT", 8080, 1, 65535),
    pollMs: num("WORKER_POLL_MS", 5000, 250, 60_000),
    heartbeatMs: num("WORKER_HEARTBEAT_MS", 30_000, 5_000, 120_000),
    queueLeaseS: num("QUEUE_LEASE_S", 300, 30, 3600),
    outboxLeaseS: num("OUTBOX_LEASE_S", 120, 30, 3600),
    outboxBatch: num("OUTBOX_BATCH", 10, 1, 100),
    channels,
    queueKinds: list("QUEUE_KINDS", "proposal.execute"),
    emailEnabled,
    gmailClientId,
    gmailClientSecret,
    ownerCell: String(env.OWNER_CELL ?? "").trim(),
    notifyUrl: String(env.NOTIFY_URL ?? "").trim() || `${url}/functions/v1/roybal-notify`,
    outboxAgentId: String(env.OUTBOX_AGENT_ID ?? "").trim() || OUTBOX_AGENT_ID,
    shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 25_000, 1_000, 60_000),
  };
}
