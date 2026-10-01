/**
 * Site Visit draft, direct run — the runner itself. Plain fetch and web
 * streams only, so the same code runs in two places:
 *   roybal-site-draft (Supabase edge, Deno): bounded by its worker's 400 s
 *     wall clock, so a long draft is cut off there and queued;
 *   the phone agent on Fly (Node, services/phone-agent/draft.mjs): always
 *     on, no wall clock, so a 20k-token draft finishes in one go.
 * roybal-ai-office tries Fly first, then the edge, then the batch queue.
 *
 * One job, one outcome written to its signed upload URL (see sitedraft.ts):
 *   message  the finished draft;
 *   batch    the same request queued as a Message Batch, because the call
 *            was overloaded, rate limited, cut off at the budget, or the
 *            host is shutting down;
 *   error    the request itself was refused (a 4xx the queue would refuse too).
 * Node-tested with a stubbed fetch in ./sitedraft-run.test.mjs.
 */

import {
  fallbackForStatus, batchBodyFor, splitSse, StreamAssembler, sealOutcome,
  type DraftJob, type DirectOutcome, type LostUsage,
} from "./sitedraft.ts";

export type RunnerEnv = {
  apiKey: string;
  supabaseUrl: string;
  anonKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
  writeBackoffMs?: number;   // tests only
};

const API = "https://api.anthropic.com/v1";
/* After the edge's 340 s stream budget there are 60 s left: the batch
   fallback (20 s at most) plus three writes (10 s each, 2 s and 4 s apart). */
export const BATCH_SUBMIT_TIMEOUT_MS = 20_000;
export const WRITE_TRIES = 3;
export const WRITE_TIMEOUT_MS = 10_000;
export const WRITE_BACKOFF_MS = 2_000;

/* storage's answer to a second write on a no-upsert upload URL */
const alreadyThere = (status: number, raw: string) =>
  (status === 409 || status === 400) && /duplicate|already exists/i.test(raw);

/** The 32-hex key of a job, from its result upload URL. */
export const draftKeyOf = (job: DraftJob): string =>
  job.resultUrl.replace(/^.*\/drafts\/([0-9a-f]{32})\.json.*$/, "$1");

export class DraftRun {
  private claimed = false;
  private asm = new StreamAssembler();
  private ctl = new AbortController();
  private job: DraftJob;
  private key: string;
  private env: RunnerEnv;
  private f: typeof fetch;
  private now: () => number;
  private started: number;

  constructor(job: DraftJob, env: RunnerEnv) {
    this.job = job;
    this.env = env;
    this.key = draftKeyOf(job);
    // wrapped, never stored bare: a host's fetch may not take a foreign `this`
    this.f = env.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.now = env.now ?? (() => Date.now());
    this.started = this.now();
  }

  private headers() {
    return { "x-api-key": this.env.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  }

  /** Exactly one outcome per job, whichever path gets there first. */
  private claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }

  /** The one outcome write. A paid draft must not be lost to a storage
      hiccup, so it is tried up to WRITE_TRIES times; "already exists" ends
      it (the upload URL takes one write, no upsert). */
  private async write(outcome: DirectOutcome): Promise<void> {
    let body: string;
    try { body = await sealOutcome(this.env.apiKey, this.key, outcome); }
    catch (e) { return this.log("write-failed", { error: `seal: ${e instanceof Error ? e.message : String(e)}` }); }
    let last = "";
    for (let i = 0; i < WRITE_TRIES; i++) {
      if (i) await new Promise((r) => setTimeout(r, (this.env.writeBackoffMs ?? WRITE_BACKOFF_MS) * i));
      try {
        const res = await this.f(`${this.env.supabaseUrl}/storage/v1${this.job.resultUrl}`, {
          method: "PUT",
          headers: { apikey: this.env.anonKey, "Content-Type": "application/json", "cache-control": "no-cache" },
          body,
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        });
        if (res.ok) return;
        const raw = await res.text().catch(() => "");
        if (alreadyThere(res.status, raw)) {
          // on a retry: an earlier try landed. First time: something else wrote it
          if (i === 0) this.log("write-skipped", { error: "an outcome was already written" });
          return;
        }
        // storage words many passing failures as a 400, so every one is retried
        last = `result upload ${res.status}: ${raw.slice(0, 200)}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    // the draft is lost; at least the logs show what it cost
    const u = outcome.type === "message" ? outcome.message.usage as { input_tokens?: number; output_tokens?: number } | undefined : undefined;
    this.log("write-failed", { error: last, type: outcome.type, ...(u ? { inTok: u.input_tokens ?? 0, outTok: u.output_tokens ?? 0 } : {}) });
  }

  private log(outcome: string, extra: Record<string, unknown> = {}) {
    const line = { draft: this.key, outcome, secs: Math.round((this.now() - this.started) / 1000), ...extra };
    (this.env.log ?? ((l) => console.log(JSON.stringify(l))))(line);
  }

  private async finish(outcome: DirectOutcome): Promise<void> {
    if (!this.claim()) return;
    await this.write(outcome);
  }

  /** Queue the same request as a Message Batch and point the outcome at it.
      A stream still going is stopped: the batch is the draft now. */
  async toBatch(reason: string): Promise<void> {
    if (!this.claim()) return;
    this.ctl.abort();
    const lost: LostUsage = this.asm.lost(this.now(), Number(this.job.params.max_tokens) || 64000);
    let outcome: DirectOutcome;
    try {
      const res = await this.f(`${API}/messages/batches`, {
        method: "POST", headers: this.headers(), body: JSON.stringify(batchBodyFor(this.job.customId, this.job.params)),
        signal: AbortSignal.timeout(BATCH_SUBMIT_TIMEOUT_MS),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`(${res.status}) ${raw.slice(0, 300)}`);
      const batchId = String((JSON.parse(raw) as { id?: string }).id ?? "");
      if (!batchId) throw new Error("no batch id came back");
      outcome = { v: 1, type: "batch", customId: this.job.customId, batchId, reason, ...(lost.inTok || lost.outTok ? { lost } : {}) };
      this.log("batch", { reason, lostIn: lost.inTok, lostOut: lost.outTok });
    } catch (e) {
      // what the direct call already streamed is still billed: the ledger sees it
      outcome = { v: 1, type: "error", customId: this.job.customId, error: `Couldn't start the draft: ${e instanceof Error ? e.message : String(e)}`, ...(lost.inTok || lost.outTok ? { lost } : {}) };
      this.log("error", { reason, batch: "failed" });
    }
    await this.write(outcome);
  }

  /** Stream the call; never throws. `budgetMs` is how long the stream may
      run before it is cut off and queued. */
  async run(budgetMs: number): Promise<void> {
    const ctl = this.ctl;
    let cutOff = false;
    const timer = setTimeout(() => { cutOff = true; ctl.abort(); }, Math.max(0, budgetMs));
    try {
      const res = await this.f(`${API}/messages`, {
        method: "POST", headers: this.headers(), body: JSON.stringify({ ...this.job.params, stream: true }), signal: ctl.signal,
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
        for (const e of events) this.asm.push(e, this.now());
        // stop at message_stop: the draft is whole, and a budget abort must
        // not land on a read that is only waiting for the connection to close
        if (this.asm.done || this.asm.error) { clearTimeout(timer); reader.cancel().catch(() => {}); break; }
      }
      for (const e of splitSse(buf + "\n\n").events) this.asm.push(e, this.now());
      if (this.asm.error) return await this.toBatch(`stream error: ${this.asm.error}`);
      if (!this.asm.done) return await this.toBatch("the stream ended before the draft finished");
      if (this.claimed) return;   // queued while the last bytes came in
      const message = this.asm.message();
      const u = message.usage as { input_tokens?: number; output_tokens?: number };
      this.log("message", { stop: message.stop_reason, inTok: u.input_tokens ?? 0, outTok: u.output_tokens ?? 0 });
      await this.finish({ v: 1, type: "message", customId: this.job.customId, message, ms: this.now() - this.started });
    } catch (e) {
      const why = cutOff
        ? `ran past the ${Math.round(budgetMs / 1000)} s this host allows`
        : `network: ${e instanceof Error ? e.message : String(e)}`;
      await this.toBatch(why);
    } finally {
      clearTimeout(timer);
    }
  }
}
