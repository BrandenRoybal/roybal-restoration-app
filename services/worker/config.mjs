/* Worker configuration — everything comes from the environment (Fly secrets
   and fly.toml [env]). Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
   Optional: GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET (without both, the email
   lane stays off and email rows wait as pending), OWNER_CELL (without it, the
   dead-letter text is off; the dead-WORKER text is the database's job, not
   this process's), EMAIL_MAX_AGE_HOURS (default 48), BILLING_RECONCILE
   (`off` = the nightly billing check answers {skipped:"off"} and reads
   nothing; anything else, or unset, leaves it on), RECEIPTS_QBO (`off` = the
   nightly QuickBooks match answers {skipped:"off"} and the 'qbo' outbox
   channel is not served, so approved QuickBooks changes wait as pending and
   no new card is filed; anything else, or unset, leaves both on),
   QBO_PROXY_URL (default: the project's qbo-proxy). The carrier packet
   (docs/Carrier_Packet_Design.md §11): CARRIER_PACKET (`off` = the hourly
   packet.build answers {skipped:"off"} and the 'packet' outbox channel is
   not served, so no packet card is filed and an approved one waits as
   pending; 'packet' is also never served without Gmail, since it is the
   email adapter that sends it), PACKET_LOOKBACK_DAYS (default 14, 1..90: how
   recent a job's drying or invoice date must be for its first packet),
   PACKET_SETTLE_MIN (120, 0..1440: minutes a job must sit unedited before a
   build), PACKET_MAX_BUILDS (3, 1..10 per run), PACKET_DOWNLOADS (4, 1..8
   media downloads at a time), PACKET_FULL_KB (9500, 1000..17000: the media
   budget for full-size photos, above which a packet goes compact),
   PACKET_HARD_KB (17000, 2000..18000: a rendered PDF over this is refused as
   too large to email), PACKET_STORAGE_MB (300, 50..900: the carrier-packets
   bucket's cap), PACKET_TEXTS (`off` stops the packet texts only). Numbers
   are clamped so a typo cannot make the worker spin or go silent. */
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
  const receiptsQbo = String(env.RECEIPTS_QBO ?? "").trim().toLowerCase() !== "off";
  const carrierPacket = String(env.CARRIER_PACKET ?? "").trim().toLowerCase() !== "off";
  // The heartbeat reports these channels, and a channel listed there is
  // what the database's filing doors take as "someone delivers this"
  // (outbox_channel_ready): with RECEIPTS_QBO=off, 'qbo' is not served, so
  // receipts_qbo_link_file files no card either. 'packet' the same way for
  // carrier_packet_reserve, and it needs Gmail: a packet card filed while
  // nothing can send it would only wait out its age limit and go dead.
  const channels = list("OUTBOX_CHANNELS", "sms,email,qbo,packet")
    .filter((c) => (c !== "email" || emailEnabled) && (c !== "qbo" || receiptsQbo)
      && (c !== "packet" || (emailEnabled && carrierPacket)));
  // A full-photo budget above the hard ceiling would pick full mode for a
  // packet that is then refused as too large, never trying compact.
  const packetHardKb = num("PACKET_HARD_KB", 17000, 2000, 18000);
  const packetFullKb = Math.min(num("PACKET_FULL_KB", 9500, 1000, 17000), packetHardKb);

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
    // An unlisted kind waits `queued` forever, so a QUEUE_KINDS set on the
    // app (fly.toml [env] or a secret) must name billing.reconcile,
    // receipts.qbo_match and packet.build too.
    queueKinds: list("QUEUE_KINDS", "proposal.execute,billing.reconcile,receipts.qbo_match,packet.build"),
    // The billing check's kill switch (README, Day-2 ops): the queue row is
    // still claimed and finished, done with {skipped:"off"}.
    billingReconcile: String(env.BILLING_RECONCILE ?? "").trim().toLowerCase() !== "off",
    // The QuickBooks link's kill switch: the nightly match finishes done with
    // {skipped:"off"} and the 'qbo' channel is dropped above.
    receiptsQbo,
    // The carrier packet's kill switch: packet.build finishes done with
    // {skipped:"off"} and the 'packet' channel is dropped above. The rest
    // are the lane's knobs (§10, §11); PACKET_TEXTS=off silences its texts
    // and nothing else.
    carrierPacket,
    packetLookbackDays: num("PACKET_LOOKBACK_DAYS", 14, 1, 90),
    packetSettleMin: num("PACKET_SETTLE_MIN", 120, 0, 1440),
    packetMaxBuilds: num("PACKET_MAX_BUILDS", 3, 1, 10),
    packetDownloads: num("PACKET_DOWNLOADS", 4, 1, 8),
    packetFullKb,
    packetHardKb,
    packetStorageMb: num("PACKET_STORAGE_MB", 300, 50, 900),
    packetTexts: String(env.PACKET_TEXTS ?? "").trim().toLowerCase() !== "off",
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
    qboProxyUrl: String(env.QBO_PROXY_URL ?? "").trim() || `${url}/functions/v1/qbo-proxy`,
    outboxAgentId: String(env.OUTBOX_AGENT_ID ?? "").trim() || OUTBOX_AGENT_ID,
    shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 25_000, 1_000, 60_000),
  };
}
