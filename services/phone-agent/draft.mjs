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
   build, 401, 400, 503 busy) and the start hands the draft to
   the edge runner instead. Nothing here touches the database or
   the phone line; one log line per draft, never the packet.

   Shutdown (a deploy or a restart): every run still going is
   queued as a Message Batch before the process exits
   (drainDrafts, wired in server.mjs), so a draft is never lost;
   the next poll follows it there.
   ============================================================ */
import { readJob, signBody, sameSignature, FLY_RUN_BUDGET_MS } from "../../supabase/functions/_shared/sitedraft.ts";
import { DraftRun, draftKeyOf } from "../../supabase/functions/_shared/sitedraft-run.ts";
import { LLM_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.mjs";

export const MAX_DRAFT_BODY = 16 * 1024 * 1024;  // a packet is links, rules and the catalog: well under this
export const MAX_LIVE_DRAFTS = 3;                // a 256 MB phone machine; the edge takes the overflow

/* draft key → run, while it streams */
const live = new Map();
export const liveDraftCount = () => live.size;

const reply = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** The whole body, or null past `limit` (read to the end and dropped). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else chunks.length = 0;
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleDraft(req, res) {
  try {
    if (req.method !== "POST") return reply(res, 405, { ok: false, error: "Use POST" });
    if (!LLM_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) return reply(res, 503, { ok: false, error: "this machine isn't set up to run drafts" });
    const raw = await readBody(req, MAX_DRAFT_BODY);
    if (raw === null) return reply(res, 413, { ok: false, error: "draft job too large" });
    const want = await signBody(LLM_API_KEY, raw);
    if (!sameSignature(String(req.headers["x-draft-signature"] ?? ""), want)) return reply(res, 401, { ok: false, error: "bad signature" });
    let job = null;
    try { job = readJob(JSON.parse(raw), Date.now()); } catch { job = null; }
    if (!job) return reply(res, 400, { ok: false, error: "not a draft job" });
    const key = draftKeyOf(job);
    // a retried start: the first one is already running it
    if (live.has(key)) return reply(res, 202, { ok: true, accepted: true, runner: "fly", already: true });
    if (live.size >= MAX_LIVE_DRAFTS) {
      console.log(JSON.stringify({ draft: key, outcome: "refused", live: live.size }));
      return reply(res, 503, { ok: false, error: "busy with other drafts" });
    }
    const run = new DraftRun(job, { apiKey: LLM_API_KEY, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    live.set(key, run);
    run.run(FLY_RUN_BUDGET_MS)
      .catch((e) => console.error(JSON.stringify({ draft: key, outcome: "crashed", error: String(e?.message ?? e) })))
      .finally(() => live.delete(key));
    return reply(res, 202, { ok: true, accepted: true, runner: "fly", budgetSecs: Math.round(FLY_RUN_BUDGET_MS / 1000) });
  } catch (e) {
    console.error("draft intake failed", e?.message ?? e);
    if (!res.headersSent) reply(res, 500, { ok: false, error: "draft intake failed" });
  }
}

/** Queue every run still going as a Message Batch (the machine is stopping). */
export function drainDrafts(reason) {
  return Promise.all([...live.values()].map((r) => r.toBatch(reason).catch(() => {})));
}
