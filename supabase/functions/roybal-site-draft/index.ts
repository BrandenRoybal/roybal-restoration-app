/**
 * roybal-site-draft — runs ONE Site Visit estimate draft straight through
 * the Messages API, so a draft lands in minutes instead of waiting in the
 * Message Batches queue (Branden, 2026-09-30: he would rather pay full price
 * than wait; the queue had held a draft for over an hour).
 *
 * Called only by roybal-ai-office siteVisitStart, never by an app. The job
 * arrives signed (HMAC-SHA256 of the body under LLM_API_KEY, which both
 * functions hold) and fresh (issued within two minutes); anything else is
 * refused before a token is spent. It carries the full Messages params the
 * start built (packet files by signed URL, rules, catalog) and a signed
 * upload URL for the one file this function writes.
 *
 * WHAT ONE JOB DOES
 *   Answers 202 at once, then in a background task streams the call and
 *   writes the outcome to field-media sitevisit/drafts/<key>.json:
 *     { type: "message" }  the finished message (collected by the next poll)
 *     { type: "batch" }    the same request queued as a Message Batch,
 *                          because the direct call was overloaded, rate
 *                          limited, cut off, or ran near the wall clock
 *     { type: "error" }    the request itself was refused (a 4xx)
 *   The worker's 400 s wall clock runs from its boot, so the stream gets
 *   DIRECT_RUN_BUDGET_MS from BOOT and is then cut off and queued. A job
 *   that reaches a warm worker with less than MIN_DIRECT_BUDGET_MS left is
 *   refused with 503 before anything is spent, and the start queues it. Nothing
 *   here reads or writes the database: the ledger row is written when
 *   roybal-ai-office collects the draft, under the caller's session.
 *
 * Logs one line per job (key, outcome, seconds, tokens), never the packet.
 *
 * Deploy: the Function deploy workflow (verify_jwt pinned true in
 * supabase/config.toml; roybal-ai-office forwards the caller's session).
 * Deploy this function before roybal-ai-office: until it answers, the start
 * queues every draft as a batch, exactly as before.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  readJob, signBody, sameSignature, runBudgetMs, fallbackForStatus, batchBodyFor, splitSse, StreamAssembler,
  MIN_DIRECT_BUDGET_MS, type DraftJob, type DirectOutcome, type LostUsage,
} from "../_shared/sitedraft.ts";

// the worker's 400 s wall clock runs from here
const BOOT = Date.now();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const API = "https://api.anthropic.com/v1";
const HEADERS = () => ({ "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/* Runs still in flight in this worker: if the runtime shuts it down early
   (CPU or memory, not the budget below), each one tries to queue itself. */
const live = new Set<Run>();

class Run {
  private claimed = false;
  private asm = new StreamAssembler();
  private started = Date.now();
  constructor(private job: DraftJob, private key: string) {}

  /** Exactly one outcome per job, whichever path gets there first. */
  private claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }

  private async write(outcome: DirectOutcome): Promise<void> {
    const res = await fetch(`${SUPABASE_URL}/storage/v1${this.job.resultUrl}`, {
      method: "PUT",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json", "cache-control": "no-cache" },
      body: JSON.stringify(outcome),
    });
    if (!res.ok) throw new Error(`result upload ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  private log(outcome: string, extra: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ draft: this.key, outcome, secs: Math.round((Date.now() - this.started) / 1000), ...extra }));
  }

  async finish(outcome: DirectOutcome): Promise<void> {
    if (!this.claim()) return;
    try { await this.write(outcome); } catch (e) { console.error(`draft ${this.key}: ${e instanceof Error ? e.message : e}`); }
  }

  /** Queue the same request as a Message Batch and point the outcome at it. */
  async toBatch(reason: string): Promise<void> {
    if (!this.claim()) return;
    const lost: LostUsage = this.asm.lost(Date.now(), Number(this.job.params.max_tokens) || 64000);
    let outcome: DirectOutcome;
    try {
      const res = await fetch(`${API}/messages/batches`, {
        method: "POST", headers: HEADERS(), body: JSON.stringify(batchBodyFor(this.job.customId, this.job.params)),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`(${res.status}) ${raw.slice(0, 300)}`);
      const batchId = String((JSON.parse(raw) as { id?: string }).id ?? "");
      if (!batchId) throw new Error("no batch id came back");
      outcome = { v: 1, type: "batch", customId: this.job.customId, batchId, reason, ...(lost.inTok || lost.outTok ? { lost } : {}) };
      this.log("batch", { reason, lostIn: lost.inTok, lostOut: lost.outTok });
    } catch (e) {
      outcome = { v: 1, type: "error", customId: this.job.customId, error: `Couldn't start the draft: ${e instanceof Error ? e.message : String(e)}` };
      this.log("error", { reason, batch: "failed" });
    }
    try { await this.write(outcome); } catch (e) { console.error(`draft ${this.key}: ${e instanceof Error ? e.message : e}`); }
  }

  async run(budget: number): Promise<void> {
    live.add(this);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);
    try {
      const res = await fetch(`${API}/messages`, {
        method: "POST", headers: HEADERS(), body: JSON.stringify({ ...this.job.params, stream: true }), signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => "");
        if (fallbackForStatus(res.status) === "batch") return await this.toBatch(`direct call answered ${res.status}`);
        this.log("error", { status: res.status });
        return await this.finish({ v: 1, type: "error", customId: this.job.customId, error: `The draft was refused (${res.status}): ${raw.slice(0, 300)}` });
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = splitSse(buf + value);
        buf = rest;
        for (const e of events) this.asm.push(e);
        // stop at message_stop: the draft is whole, and a budget abort must
        // not land on a read that is only waiting for the connection to close
        if (this.asm.done || this.asm.error) { clearTimeout(timer); reader.cancel().catch(() => {}); break; }
      }
      for (const e of splitSse(buf + "\n\n").events) this.asm.push(e);
      if (this.asm.error) return await this.toBatch(`stream error: ${this.asm.error}`);
      if (!this.asm.done) return await this.toBatch("the stream ended before the draft finished");
      const message = this.asm.message();
      const u = message.usage as { input_tokens?: number; output_tokens?: number };
      this.log("message", { stop: message.stop_reason, inTok: u.input_tokens ?? 0, outTok: u.output_tokens ?? 0 });
      await this.finish({ v: 1, type: "message", customId: this.job.customId, message, ms: Date.now() - this.started });
    } catch (e) {
      const why = ctl.signal.aborted
        ? `ran past the ${Math.round(budget / 1000)} s this worker had left`
        : `network: ${e instanceof Error ? e.message : String(e)}`;
      await this.toBatch(why);
    } finally {
      clearTimeout(timer);
      live.delete(this);
    }
  }
}

addEventListener("beforeunload", (ev) => {
  const why = String((ev as Event & { detail?: { reason?: string } }).detail?.reason ?? "shutdown");
  for (const r of live) r.toBatch(`worker shutting down (${why})`).catch(() => {});
});

serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { ok: false, error: "Use POST" });
  if (!LLM_API_KEY) return reply(500, { ok: false, error: "llm_key_missing" });
  const raw = await req.text();
  const want = await signBody(LLM_API_KEY, raw);
  if (!sameSignature(req.headers.get("x-draft-signature") ?? "", want)) return reply(401, { ok: false, error: "bad signature" });
  let job: DraftJob | null = null;
  try { job = readJob(JSON.parse(raw), Date.now()); } catch (_) { job = null; }
  if (!job) return reply(400, { ok: false, error: "not a draft job" });
  const key = job.resultUrl.replace(/^.*\/drafts\/([0-9a-f]{32})\.json.*$/, "$1");
  // a warm worker a few minutes old can't finish a draft: say so before a
  // token is spent, and the start queues it instead
  const budget = runBudgetMs(BOOT, Date.now());
  if (budget < MIN_DIRECT_BUDGET_MS) {
    console.log(JSON.stringify({ draft: key, outcome: "refused", budgetSecs: Math.round(budget / 1000) }));
    return reply(503, { ok: false, error: "this worker is too close to its time limit", budgetSecs: Math.round(budget / 1000) });
  }
  const task = new Run(job, key).run(budget).catch((e) => console.error(`draft ${key}: ${e instanceof Error ? e.message : e}`));
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(task); else await task;
  return reply(202, { ok: true, accepted: true, budgetSecs: Math.round(budget / 1000) });
});
