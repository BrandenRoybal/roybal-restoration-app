/**
 * Site Visit draft, direct run — the pure half (no Deno, no network,
 * Node-tested in ./sitedraft.test.mjs).
 *
 * Branden's call (2026-09-30): an estimate draft is the most important
 * document the company produces, and he would rather pay full price than
 * wait on the half-price Message Batches queue (a draft sat "drafting" for
 * 75+ minutes that day). So a draft now runs straight through the Messages
 * API, and the batch queue is only the fallback.
 *
 * Two functions share this file:
 *   roybal-ai-office  starts the draft (siteVisitStart) and collects it
 *                     (siteVisitResult);
 *   roybal-site-draft runs it: one streamed Messages call in a background
 *                     task, the finished message written to storage.
 *
 * The run lives in its own function because an edge worker has a 400 s wall
 * clock from the moment it boots (Supabase paid plan), and roybal-ai-office's
 * workers are kept busy by polls, so a background task started there could
 * inherit a worker with seconds left. A job that reaches a worker without
 * enough time left is refused, and the start queues it as a batch instead; a
 * run still going near the limit is cut off and queued. The worst case is the
 * old behavior.
 *
 * The run leaves one file, field-media sitevisit/drafts/<key>.json: the
 * finished message, the batch it fell back to, or the error. The request
 * itself is never stored (it can carry the owner-only Xactimate reference
 * prices, and the bucket is readable by every login).
 */

/* ---------- ids and paths ---------- */
/* The field app stores whatever id siteVisitStart returns as `batchId` and
   hands it back on every poll, so a direct run needs no field-app change to
   be collected: batch ids stay msgbatch_…, direct ids are svd_<start>_<key>. */
const DIRECT_ID = /^svd_([0-9a-z]{6,12})_([0-9a-f]{32})$/;
export const DIRECT_FOLDER = "sitevisit/drafts/";

export function directIdFor(startMs: number, key: string): string {
  if (!/^[0-9a-f]{32}$/.test(key)) throw new Error("draft key must be 32 hex characters");
  return `svd_${Math.max(0, Math.floor(startMs)).toString(36)}_${key}`;
}

export function parseDirectId(id: unknown): { startMs: number; key: string } | null {
  const m = DIRECT_ID.exec(String(id ?? ""));
  if (!m) return null;
  const startMs = parseInt(m[1], 36);
  return Number.isFinite(startMs) ? { startMs, key: m[2] } : null;
}

export function directPaths(key: string): { result: string } {
  return { result: `${DIRECT_FOLDER}${key}.json` };
}

/* ---------- timing ---------- */
/* Of the draft worker's 400 s: the stream gets up to 340 s from the worker's
   boot, which leaves time to submit the batch fallback and write the outcome
   before the runtime shuts the worker down. */
export const DIRECT_RUN_BUDGET_MS = 340_000;
/* A job that reaches a worker with less than this left is refused (the start
   queues it instead): a warm worker a few minutes old could not finish a
   draft, and a stream cut off part way is paid for and thrown away. */
export const MIN_DIRECT_BUDGET_MS = 180_000;
/* No outcome this long after the start means the run died without writing
   one (the worker was killed outright, with no chance to queue it). */
export const DIRECT_STALE_MS = 8 * 60_000;
/* A signed job older than this is refused (a replayed request). */
export const JOB_MAX_AGE_MS = 120_000;

export function runBudgetMs(bootMs: number, nowMs: number): number {
  return Math.max(0, bootMs + DIRECT_RUN_BUDGET_MS - nowMs);
}

/** A direct call that failed this way is worth queueing: the batch runs the
    same request later (rate limits, overload, server errors). A 4xx is the
    request itself; the queue would refuse it too. */
export function fallbackForStatus(status: number): "batch" | "error" {
  return status === 429 || status >= 500 ? "batch" : "error";
}

/* ---------- the outcome file ---------- */
export type LostUsage = { inTok: number; outTok: number };
export type DirectOutcome =
  | { v: 1; type: "message"; customId: string; message: Record<string, unknown>; ms: number }
  | { v: 1; type: "batch"; customId: string; batchId: string; reason: string; lost?: LostUsage }
  | { v: 1; type: "error"; customId: string; error: string };

export function readOutcome(raw: unknown): DirectOutcome | null {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  const customId = String(o.customId ?? "");
  if (o.type === "message" && o.message && typeof o.message === "object")
    return { v: 1, type: "message", customId, message: o.message as Record<string, unknown>, ms: Number(o.ms) || 0 };
  if (o.type === "batch" && /^msgbatch_[A-Za-z0-9]+$/.test(String(o.batchId ?? ""))) {
    const l = (o.lost ?? null) as Record<string, unknown> | null;
    const lost = l ? { inTok: Math.max(0, Number(l.inTok) || 0), outTok: Math.max(0, Number(l.outTok) || 0) } : undefined;
    return { v: 1, type: "batch", customId, batchId: String(o.batchId), reason: String(o.reason ?? ""), ...(lost ? { lost } : {}) };
  }
  if (o.type === "error") return { v: 1, type: "error", customId, error: String(o.error ?? "the draft failed") };
  return null;
}

/** The finished message in the shape of one batch results line, so the one
    parser (parseBatchResult) reads both paths. */
export function asBatchLine(customId: string, message: Record<string, unknown>): Record<string, unknown> {
  return { custom_id: customId, result: { type: "succeeded", message } };
}

/** One Message Batches request carrying the same params as the direct call. */
export function batchBodyFor(customId: string, params: Record<string, unknown>): Record<string, unknown> {
  return { requests: [{ custom_id: customId, params }] };
}

/* ---------- the signed job (roybal-ai-office → roybal-site-draft) ---------- */
export type DraftJob = { v: 1; issuedAt: number; customId: string; params: Record<string, unknown>; resultUrl: string };
/* Output tokens a stream is assumed to generate per second, for the ledger
   when a run is abandoned: thinking streams no text (display omitted) and the
   real count only arrives at the end, so time is the only measure. Kept on
   the high side: the spend cap should over-count, not under-count. */
export const LOST_TOK_PER_SEC = 60;
const RESULT_URL = /^\/object\/upload\/sign\/field-media\/sitevisit\/drafts\/[0-9a-f]{32}\.json\?token=[^\s&#]+$/;

/** Validate a parsed job body; null when anything is off. */
export function readJob(raw: unknown, nowMs: number): DraftJob | null {
  const j = (raw ?? null) as Record<string, unknown> | null;
  if (!j || typeof j !== "object" || j.v !== 1) return null;
  const issuedAt = Number(j.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(nowMs - issuedAt) > JOB_MAX_AGE_MS) return null;
  const customId = String(j.customId ?? "");
  if (!/^sv-[A-Za-z0-9-]{1,80}$/.test(customId)) return null;
  const params = j.params as Record<string, unknown> | null;
  if (!params || typeof params !== "object" || typeof params.model !== "string" || !Array.isArray(params.messages)) return null;
  const resultUrl = String(j.resultUrl ?? "");
  if (!RESULT_URL.test(resultUrl)) return null;
  return { v: 1, issuedAt, customId, params, resultUrl };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of the raw body under a secret both functions hold. */
export async function signBody(secret: string, body: string): Promise<string> {
  if (!secret) throw new Error("no signing secret");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

export function sameSignature(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- the stream ---------- */
/** Split server-sent events out of a text buffer. Returns the parsed `data:`
    payloads of every complete event and the unfinished tail to carry into
    the next chunk. Events without JSON data (comments, pings) are skipped. */
export function splitSse(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const text = buffer.replace(/\r\n/g, "\n");
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: Record<string, unknown>[] = [];
  for (const part of parts) {
    const data = part.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try {
      const e = JSON.parse(data);
      if (e && typeof e === "object") events.push(e as Record<string, unknown>);
    } catch { /* a malformed event is skipped; a stream without message_stop fails as incomplete */ }
  }
  return { events, rest };
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** Rebuilds the final message from Messages API stream events: model, stop
    reason, usage and the text blocks (thinking is never shown, so thinking
    blocks are dropped). `done` once message_stop arrives; `error` when the
    stream carried an error event (overload mid-run, for one). */
export class StreamAssembler {
  model = "";
  stopReason: string | null = null;
  usage: Usage = {};
  done = false;
  error = "";
  textChars = 0;
  private genStartMs = 0;
  private blocks = new Map<number, { type: string; text: string }>();

  push(e: Record<string, unknown>, nowMs = Date.now()): void {
    const type = String(e.type ?? "");
    // the first block starts when the input has been read and output begins
    if (type === "content_block_start" && !this.genStartMs) this.genStartMs = nowMs;
    if (type === "message_start") {
      const m = (e.message ?? {}) as { model?: string; usage?: Usage };
      this.model = String(m.model ?? "");
      this.usage = { ...(m.usage ?? {}) };
    } else if (type === "content_block_start") {
      const b = (e.content_block ?? {}) as { type?: string; text?: string };
      const text = b.type === "text" ? String(b.text ?? "") : "";
      this.textChars += text.length;
      this.blocks.set(Number(e.index), { type: String(b.type ?? ""), text });
    } else if (type === "content_block_delta") {
      const d = (e.delta ?? {}) as { type?: string; text?: string };
      if (d.type !== "text_delta") return;
      const b = this.blocks.get(Number(e.index)) ?? { type: "text", text: "" };
      const t = String(d.text ?? "");
      b.text += t;
      this.textChars += t.length;
      this.blocks.set(Number(e.index), b);
    } else if (type === "message_delta") {
      const d = (e.delta ?? {}) as { stop_reason?: string | null };
      if (d.stop_reason !== undefined) this.stopReason = d.stop_reason ?? null;
      const u = (e.usage ?? {}) as Usage;
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const)
        if (typeof u[k] === "number") this.usage[k] = u[k];
    } else if (type === "message_stop") {
      this.done = true;
    } else if (type === "error") {
      const err = (e.error ?? {}) as { type?: string; message?: string };
      this.error = `${err.type ?? "error"}: ${err.message ?? "the stream reported an error"}`;
    }
  }

  /** The message, shaped like a non-streamed Messages API response. */
  message(): Record<string, unknown> {
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.type === "text").map(([, b]) => ({ type: "text", text: b.text }));
    return { type: "message", role: "assistant", model: this.model, stop_reason: this.stopReason, usage: { ...this.usage }, content };
  }

  /** What an abandoned stream had already cost, for the spend ledger: the
      input is known from message_start; the output is estimated from how long
      it had been generating (thinking is billed but never streamed), never
      below the streamed text (~4 characters a token), never above max_tokens. */
  lost(nowMs = Date.now(), maxTokens = 64000): LostUsage {
    const u = this.usage;
    const inTok = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    const genSecs = this.genStartMs ? Math.max(0, nowMs - this.genStartMs) / 1000 : 0;
    const byTime = Math.min(Math.max(0, maxTokens), Math.ceil(genSecs * LOST_TOK_PER_SEC));
    return { inTok, outTok: Math.max(Number(u.output_tokens) || 0, Math.ceil(this.textChars / 4), byTime) };
  }
}
