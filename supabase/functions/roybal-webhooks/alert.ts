/* roybal-webhooks /alert — pure rules (no Deno, no network), tested under
   Node from alert.test.mjs.

   The database's worker_liveness_check() POSTs here when no worker has
   checked in for 10 minutes. These functions decide whether that POST
   becomes a text to the owner: the heartbeat table is re-read and must
   really be stale (a forged or replayed POST can cause nothing a true alarm
   would not), and the owner hears about one outage once per 24 hours. */

export const STALE_MS = 10 * 60_000;
export const GUARD_MS = 24 * 3_600_000;

export type Decision = { text: boolean; reason: string; staleMinutes: number | null };

export function decideAlert(args: {
  now: number;
  lastHeartbeatAt: string | null;
  lastTextedAt: string | null;
  staleMs?: number;
  guardMs?: number;
}): Decision {
  const staleMs = args.staleMs ?? STALE_MS;
  const guardMs = args.guardMs ?? GUARD_MS;
  const texted = args.lastTextedAt ? Date.parse(args.lastTextedAt) : NaN;
  if (Number.isFinite(texted) && args.now - texted < guardMs) {
    return { text: false, reason: "texted within 24 h", staleMinutes: null };
  }
  if (!args.lastHeartbeatAt) {
    return { text: true, reason: "no heartbeat on record", staleMinutes: null };
  }
  const last = Date.parse(args.lastHeartbeatAt);
  if (!Number.isFinite(last)) {
    return { text: true, reason: "unreadable heartbeat time", staleMinutes: null };
  }
  const age = args.now - last;
  if (age < staleMs) {
    return { text: false, reason: "heartbeat is fresh", staleMinutes: Math.floor(age / 60_000) };
  }
  return { text: true, reason: "stale", staleMinutes: Math.floor(age / 60_000) };
}

const fmtAk = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Anchorage", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

/** The owner's text. Under 300 characters, Alaska time, says what to do. */
export function alertText(args: { now: number; lastHeartbeatAt: string | null; workerId?: string | null }): string {
  const last = args.lastHeartbeatAt ? Date.parse(args.lastHeartbeatAt) : NaN;
  const when = Number.isFinite(last)
    ? `no check-in since ${fmtAk(last)} Alaska time (${Math.floor((args.now - last) / 60_000)} min)`
    : "it has never checked in";
  return `Roybal worker is down: ${when}. Approved texts and emails are waiting in the outbox. ` +
    `Check it with: fly status -a roybal-worker`;
}

/** Constant-time string compare over UTF-8 bytes. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a ?? ""));
  const y = new TextEncoder().encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

export type AlertBody = { kind: string; worker_id: string | null; last_heartbeat_at: string | null };

export function parseAlertBody(b: unknown): AlertBody {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (v == null ? null : String(v).slice(0, max));
  return {
    kind: str(o.kind, 40) ?? "",
    worker_id: str(o.worker_id, 120),
    last_heartbeat_at: str(o.last_heartbeat_at, 40),
  };
}
