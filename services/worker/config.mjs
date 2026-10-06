/* Worker configuration — everything comes from the environment (Fly secrets
   and fly.toml [env]). Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
   Optional: GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET (without both, the email
   lane stays off and email rows wait as pending), OWNER_CELL (without it, the
   dead-letter text is off; the dead-WORKER text is the database's job, not
   this process's), EMAIL_MAX_AGE_HOURS (default 48). Numbers are clamped so
   a typo cannot make the worker spin or go silent. */
import os from "node:os";

export const OUTBOX_AGENT_ID = "0a7ac824-5042-4bb5-ab0d-8569cea209b1"; // agents seed, migration 0004
export const EMAIL_MAX_AGE_HOURS_DEFAULT = 48;

export function loadConfig(env = process.env) {
  const url = String(env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const missing = [];
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) missing.push("SUPABASE_URL (https://<ref>.supabase.co)");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`worker: missing ${missing.join(", ")}`);
  // This project's legacy JWT keys are dead (03 §A). A pasted legacy
  // `service_role` JWT would boot fine and then 401 on every call, with the
  // machine showing healthy and the alarm never armed. Refuse it at boot.
  if (/^eyJ/.test(key)) {
    throw new Error("worker: SUPABASE_SERVICE_ROLE_KEY looks like a legacy JWT key, which this project has disabled. " +
      "Use a secret key (sb_secret_…): Supabase Dashboard → Project Settings → API Keys → Publishable and secret keys.");
  }
  // Same silent failure with the publishable key (the first one on that
  // Dashboard page, and the one that got pasted on 10/5): it boots, every
  // service-role call is refused, and no heartbeat ever arms the alarm.
  if (/^sb_publishable_/.test(key)) {
    throw new Error("worker: SUPABASE_SERVICE_ROLE_KEY is the publishable key. " +
      "Use a secret key (sb_secret_…) from the \"Secret keys\" section of Supabase Dashboard → Project Settings → API Keys.");
  }
  // A README placeholder typed as-is ("<sb_secret_… key>", "<same as the
  // gmail-proxy secret>", "sb_secret_PASTE_HERE") would boot and fail later,
  // far from the cause. Name the variable, never the value.
  const looksLikePlaceholder = (v) => /[<>…"']|\s|PASTE_/.test(v);
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "OWNER_CELL"]) {
    const v = String(env[name] ?? "").trim();
    if (v && looksLikePlaceholder(v) && !(name === "OWNER_CELL" && /^[\d\s()+.-]+$/.test(v))) {
      throw new Error(`worker: ${name} looks like a placeholder (< >, quotes, spaces or PASTE_). ` +
        `Set the real value: fly secrets set -a roybal-worker ${name}="…"`);
    }
  }
  // Same normalizing as roybal-notify's toE164: a US number or nothing. A
  // number it would reject must fail here, not at the first dead-letter text.
  const cellRaw = String(env.OWNER_CELL ?? "").trim();
  const cellDigits = cellRaw.replace(/\D/g, "");
  const ownerCell = !cellRaw ? ""
    : cellDigits.length === 10 ? `+1${cellDigits}`
    : cellDigits.length === 11 && cellDigits.startsWith("1") ? `+${cellDigits}`
    : null;
  if (ownerCell === null) {
    throw new Error("worker: OWNER_CELL is not a US phone number. Use the 10-digit cell, e.g. OWNER_CELL=\"+1907XXXXXXX\".");
  }

  // A blank value counts as unset: Number("") is 0, which would clamp a
  // knob to its floor (a 250 ms poll, a one-hour email limit) instead of
  // leaving the default in place.
  const num = (name, dflt, lo, hi) => {
    const raw = String(env[name] ?? "").trim();
    const n = raw === "" ? dflt : Number(raw);
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
    // The machine's identity, stable across restarts and deploys on purpose:
    // one worker_heartbeats row per machine. Rows a dead process left leased
    // under this same id are NOT ours to renew — the heartbeat extends only
    // the ids this process is working (ctx.active), so they expire and the
    // sweeper retries them.
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
    // An email row older than this when it would be sent is dead, not late:
    // a reminder approved while the email lane was off must not reach the
    // customer days later. Clamped like the other knobs; a non-number keeps
    // the default, so a typo can neither switch the limit off nor stop the
    // worker booting (which would take the text lane down with it).
    emailMaxAgeHours: num("EMAIL_MAX_AGE_HOURS", EMAIL_MAX_AGE_HOURS_DEFAULT, 1, 720),
    ownerCell,
    notifyUrl: String(env.NOTIFY_URL ?? "").trim() || `${url}/functions/v1/roybal-notify`,
    outboxAgentId: String(env.OUTBOX_AGENT_ID ?? "").trim() || OUTBOX_AGENT_ID,
    shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 25_000, 1_000, 60_000),
  };
}
