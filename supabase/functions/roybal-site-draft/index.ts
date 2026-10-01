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
 * The runner itself is ../_shared/sitedraft-run.ts, shared with the phone
 * agent on Fly (no wall clock there), which roybal-ai-office tries first.
 *
 * Deploy: the Function deploy workflow (verify_jwt pinned true in
 * supabase/config.toml; roybal-ai-office forwards the caller's session).
 * Deploy this function before roybal-ai-office: until a runner answers, the
 * start queues every draft as a batch, exactly as before.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { readJob, signBody, sameSignature, runBudgetMs, MIN_DIRECT_BUDGET_MS, type DraftJob } from "../_shared/sitedraft.ts";
import { DraftRun, draftKeyOf } from "../_shared/sitedraft-run.ts";

// the worker's 400 s wall clock runs from here
const BOOT = Date.now();
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const ENV = { apiKey: LLM_API_KEY, supabaseUrl: Deno.env.get("SUPABASE_URL")!, anonKey: Deno.env.get("SUPABASE_ANON_KEY")! };

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/* Runs still in flight in this worker: if the runtime shuts it down early
   (CPU or memory, not the budget), each one tries to queue itself. */
const live = new Set<DraftRun>();

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
  // a warm worker a few minutes old can't finish a draft: say so before a
  // token is spent, and the start queues it instead
  const budget = runBudgetMs(BOOT, Date.now());
  if (budget < MIN_DIRECT_BUDGET_MS) {
    console.log(JSON.stringify({ draft: draftKeyOf(job), outcome: "refused", budgetSecs: Math.round(budget / 1000) }));
    return reply(503, { ok: false, error: "this worker is too close to its time limit", budgetSecs: Math.round(budget / 1000) });
  }
  const run = new DraftRun(job, ENV);
  live.add(run);
  const task = run.run(budget).finally(() => live.delete(run));
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(task); else await task;
  return reply(202, { ok: true, accepted: true, budgetSecs: Math.round(budget / 1000) });
});
