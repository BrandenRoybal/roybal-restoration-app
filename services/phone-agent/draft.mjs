/* ============================================================
   Site Visit estimate drafts — the long-running runner
   ------------------------------------------------------------
   POST /draft takes one signed draft job from roybal-ai-office
   and streams it straight through the Messages API on this
   always-on machine. Fly has no wall clock; the edge runner
   (roybal-site-draft) is cut off at its worker's 400 s, and a
   20k-token draft can take longer than that. Same job, same
   runner code, same outcome file:
   supabase/functions/_shared/sitedraft-run.ts.

   Auth: the body's HMAC under LLM_API_KEY (x-draft-signature).
   A match also proves this machine holds the same Anthropic key
   as the edge functions, so the run can't fail on a wrong key.
   202 = the run is under way. Anything else (404 from an older
   build, 401, 400, 413, 503 busy or restarting) and the start
   hands the draft to the edge runner instead. The door is public,
   so a body is only read with a well-formed signature header and
   a declared length under FLY_MAX_JOB_BYTES, two at a time. Nothing here touches the database or
   the phone line; one log line per draft, never the packet.

   Shutdown (a deploy or a restart): every run still going is
   queued as a Message Batch before the process exits
   (drainDrafts, wired in server.mjs), so a draft is never lost;
   the next poll follows it there.
   ============================================================ */
import { readJob, signBody, sameSignature, FLY_RUN_BUDGET_MS, FLY_MAX_JOB_BYTES } from "../../supabase/functions/_shared/sitedraft.ts";
import { DraftRun, draftKeyOf } from "../../supabase/functions/_shared/sitedraft-run.ts";
import { LLM_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.mjs";

export const MAX_LIVE_DRAFTS = 3;   // a 256 MB phone machine; the edge takes the overflow
/* Bodies are read before their signature can be checked, so the door is
   narrow: a declared length up to FLY_MAX_JOB_BYTES, two at a time, read
   within INTAKE_TIMEOUT_MS. A real job is well under 2 MB (media go as links). */
export const MAX_INTAKES = 2;
export const INTAKE_TIMEOUT_MS = 15_000;   // the start gives up on this runner at 20 s

/* draft key → { run, done }, while it streams and writes its outcome */
const live = new Map();
let intakes = 0;
let draining = false;
export const liveDraftCount = () => live.size;

const reply = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
/* turned away before the body is read: close the connection behind it */
const refuse = (req, res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body), () => req.destroy());
};

/** The whole body; null past `limit` or too slow, undefined if the client left. */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; clearTimeout(timer); chunks.length = 0; resolve(v); };
    const timer = setTimeout(() => settle(null), INTAKE_TIMEOUT_MS);
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) return settle(null);
      chunks.push(c);
    });
    req.on("end", () => { if (settled) return; settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", () => settle(undefined));
    req.on("close", () => settle(undefined));
  });
}

export async function handleDraft(req, res) {
  try {
    if (req.method !== "POST") return reply(res, 405, { ok: false, error: "Use POST" });
    if (!LLM_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) return refuse(req, res, 503, { ok: false, error: "this machine isn't set up to run drafts" });
    if (draining) return refuse(req, res, 503, { ok: false, error: "this machine is restarting" });
    if (!/^[0-9a-f]{64}$/.test(String(req.headers["x-draft-signature"] ?? ""))) return refuse(req, res, 401, { ok: false, error: "bad signature" });
    const len = Number(req.headers["content-length"]);
    if (!Number.isFinite(len) || len <= 0 || len > FLY_MAX_JOB_BYTES) return refuse(req, res, 413, { ok: false, error: "draft job too large, or no length" });
    if (intakes >= MAX_INTAKES) return refuse(req, res, 503, { ok: false, error: "busy reading other drafts" });
    intakes++;
    let raw;
    try { raw = await readBody(req, FLY_MAX_JOB_BYTES); } finally { intakes--; }
    if (raw === undefined) return;   // the caller left
    if (raw === null) return refuse(req, res, 413, { ok: false, error: "draft job too large or too slow" });
    const want = await signBody(LLM_API_KEY, raw);
    if (!sameSignature(String(req.headers["x-draft-signature"] ?? ""), want)) return reply(res, 401, { ok: false, error: "bad signature" });
    let job = null;
    try { job = readJob(JSON.parse(raw), Date.now()); } catch { job = null; }
    if (!job) return reply(res, 400, { ok: false, error: "not a draft job" });
    const key = draftKeyOf(job);
    // a retried start: the first one is already running it
    if (live.has(key)) return reply(res, 202, { ok: true, accepted: true, runner: "fly", already: true });
    if (draining) return reply(res, 503, { ok: false, error: "this machine is restarting" });
    if (live.size >= MAX_LIVE_DRAFTS) {
      console.log(JSON.stringify({ draft: key, outcome: "refused", live: live.size }));
      return reply(res, 503, { ok: false, error: "busy with other drafts" });
    }
    const run = new DraftRun(job, { apiKey: LLM_API_KEY, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    // run() never throws and settles only once its outcome write is done
    const done = run.run(FLY_RUN_BUDGET_MS)
      .catch((e) => console.error(JSON.stringify({ draft: key, outcome: "crashed", error: String(e?.message ?? e) })))
      .finally(() => live.delete(key));
    live.set(key, { run, done });
    return reply(res, 202, { ok: true, accepted: true, runner: "fly", budgetSecs: Math.round(FLY_RUN_BUDGET_MS / 1000) });
  } catch (e) {
    console.error("draft intake failed", e?.message ?? e);
    if (!res.headersSent) reply(res, 500, { ok: false, error: "draft intake failed" });
  }
}

/** The machine is stopping: take no new drafts, queue every run still
    streaming as a Message Batch, and wait for each run's outcome write
    (one already finishing, or already queueing itself, included). */
export function drainDrafts(reason) {
  draining = true;
  return Promise.all([...live.values()].map(({ run, done }) =>
    Promise.all([run.toBatch(reason).catch(() => {}), done])));
}
