/**
 * QuickBooks Time Proxy — Supabase Edge Function
 *
 * Handles all OAuth token exchange/refresh and QB Time API calls
 * server-side so the Client Secret is never exposed to the browser.
 *
 * Actions:
 *   exchangeCode   — swap auth code for access/refresh tokens
 *   getStatus      — check connection status
 *   disconnect     — delete stored tokens
 *   syncJobcodes   — fetch jobcodes from QB Time and upsert to DB
 *   getTimesheets  — get time entries for a jobcode / date range
 *   getUsers       — list employees
 *   getCurrentTotals — who is currently clocked in
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  matchPhase, reconcileRows, phasedJobForDate, clusterUnmatched, jobLabel, isOpenForMatching, workText,
  type BoardJobLite, type Subtask,
} from "./phasematch.ts";
import { buildRequestBody, applyAiMatches, MAX_BATCH, type AiEntry } from "./aiphase.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// QuickBooks Time (TSheets) OAuth 2.0 — its OWN server, not QuickBooks Online's.
// Token exchange/refresh put client_id/secret in the form body (no Basic auth,
// no Intuit oauth.platform endpoint). No `scope`; no `realmId`.
const QB_TOKEN_URL = "https://rest.tsheets.com/api/v1/grant";
const QB_TIME_BASE = "https://rest.tsheets.com/api/v1";
const QB_TIME_REALM = "tsheets"; // single-company placeholder for the token row key

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return json({ ok: true, data });
}

function err(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function qbFetch(
  path: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`${QB_TIME_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB Time API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Local wall-clock "HH:MM" from a QB timestamp like 2020-03-08T09:00:00-08:00.
    We intentionally read the string, not a Date, to preserve the time the crew
    actually saw on the clock (no UTC conversion). */
function hhmm(ts: string | undefined): string {
  const m = /T(\d{2}:\d{2})/.exec(ts ?? "");
  return m ? m[1] : "";
}

/** Reject anyone who isn't a signed-in user of this project. pullDay writes
    data with the service role, so gate it on a valid caller JWT (the field/
    admin apps forward the crew session token). */
async function requireUser(
  supabase: ReturnType<typeof createClient>,
  req: Request
): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data?.user;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getValidToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  const clientId = Deno.env.get("QB_TIME_CLIENT_ID")!;
  const clientSecret = Deno.env.get("QB_TIME_CLIENT_SECRET")!;

  const { data: tokenRow, error } = await supabase
    .from("qb_time_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !tokenRow) throw new Error("QuickBooks Time is not connected");

  const expiresAt = new Date(tokenRow.expires_at).getTime();
  const nowPlusFive = Date.now() + 5 * 60 * 1000;

  // Token still valid
  if (expiresAt > nowPlusFive) return tokenRow.access_token;

  // Refresh the token — TSheets wants the client creds in the form body.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenRow.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase
    .from("qb_time_tokens")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: newExpiry,
    })
    .eq("id", tokenRow.id);

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Shared: map QB timesheets -> time_entries rows (reusing ids for idempotency)
// ---------------------------------------------------------------------------

type QbTimesheet = {
  id: number; user_id: number; jobcode_id: number;
  start: string; end: string; duration: number; date: string; notes: string;
  customfields?: Record<string, string>;
};

// The QB Time "Service Item" custom field id varies per account — resolve it by
// name from the timesheet supplemental_data (fallback: any field named ~service).
function findServiceFieldId(defs?: Record<string, { name?: string }>): string | null {
  if (!defs) return null;
  for (const [id, d] of Object.entries(defs)) if (String(d?.name || "").toLowerCase() === "service item") return id;
  for (const [id, d] of Object.entries(defs)) if (String(d?.name || "").toLowerCase().includes("service")) return id;
  return null;
}

function qbRowsFrom(
  timesheets: QbTimesheet[],
  users: Record<string, { first_name: string; last_name: string }>,
  jobcodes: Record<string, { name: string }>,
  jobcodeId: string,
  fieldProjectId: string | null,
  idByTs: Map<string, string>,
  serviceFieldId: string | null,
  boardJobs: BoardJobLite[] | null = null
) {
  const nowIso = new Date().toISOString();
  return timesheets.map((ts) => {
    const u = users[String(ts.user_id)];
    const employee = u ? `${u.first_name} ${u.last_name}`.trim() : `QB user ${ts.user_id}`;
    const jc = jobcodes[String(ts.jobcode_id)];
    const id = idByTs.get(String(ts.id)) ?? crypto.randomUUID();
    const service = serviceFieldId ? (ts.customfields?.[serviceFieldId] || "") : "";
    // Content-aware phase stamp: match the crew's service item + note against
    // the linked board job's phases (hoursFrom-scoped when a jobcode backs
    // several jobs). The board's phaseActuals honors an explicit phaseId over
    // its date fallback, so a stamp here flows through everything. NO
    // timestamp inside phaseMatch — the stamp must be deterministic so the
    // unchanged-row skip in reconcileRows can do its job. A manual stamp is
    // re-asserted later by reconcileRows regardless of what we compute here.
    const pj = boardJobs && boardJobs.length ? phasedJobForDate(boardJobs, ts.date) : null;
    const m = pj ? matchPhase({ service, note: ts.notes || "" }, pj.subtasks || []) : null;
    return {
      id,
      deleted: false,
      data: {
        id,
        jobId: fieldProjectId,
        fieldProjectId,
        qbJobcodeId: jobcodeId,
        jobcodeName: jc?.name ?? null,
        date: ts.date,
        employee,
        task: ts.notes || jc?.name || "",   // construction log "Task Performed"
        service,                             // QB Time "Service Item" custom field
        note: ts.notes || "",               // crew timesheet note
        start: hhmm(ts.start),
        finish: hhmm(ts.end),
        hours: Number((ts.duration ? ts.duration / 3600 : 0).toFixed(2)),
        source: "qbtime",
        qbTimesheetId: String(ts.id),
        qbUserId: String(ts.user_id),
        enteredBy: "quickbooks-time",
        createdAt: nowIso,
        updatedAt: nowIso,
        ...(m ? { phaseId: m.phaseId, phaseMatch: { by: m.by, score: m.score } } : {}),
      },
    };
  });
}

/** Board jobs (with phases) linked to a jobcode — the matcher's phase source.
    Light rows only; callers may also prebuild these from an existing
    coordination_jobs read (pullAllLinked does). */
function boardJobLite(id: string, data: Record<string, unknown>, jobcodeId: string): BoardJobLite {
  return {
    id,
    qbJobcodeId: jobcodeId,
    hoursFrom: (data?.hoursFrom as string) || "",
    subtasks: (data?.subtasks as Subtask[]) || [],
    title: (data?.title as string) || "",
    customer: (data?.customer as string) || "",
  };
}

async function fetchPhasedBoardJobs(
  supabase: ReturnType<typeof createClient>,
  jobcodeId: string
): Promise<BoardJobLite[]> {
  const { data } = await supabase
    .from("coordination_jobs")
    .select("id, data")
    .eq("deleted", false)
    .filter("data->>qbJobcodeId", "eq", jobcodeId);
  return ((data ?? []) as { id: string; data: Record<string, unknown> }[])
    .map((r) => boardJobLite(r.id, r.data, jobcodeId))
    .filter((j) => (j.subtasks || []).length > 0);
}

// ---------------------------------------------------------------------------
// AI fallback + phase proposals — the paid pass, run ONCE per jobcode per
// night (not per day-pull), over whatever the free deterministic matcher
// left unstamped.
// ---------------------------------------------------------------------------

/* How many phase suggestions may be in flight at once. The brief offers a
   couple a morning and each expires in a day, so proposing faster than the
   owner can answer just burns the queue: the first backfill raised 14 and
   twelve would have evaporated unseen (and then gone quiet for 30 days,
   because an unanswered ask still counts as asked). Trickle instead. */
const MAX_PROPOSALS_PER_JOB = 2;
const MAX_LIVE_PROPOSALS = 3;

const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
// Pinned to Haiku on purpose — deliberately NOT inheriting the project-wide
// LLM_MODEL, which the office assistant may point at Opus. Phase matching is
// high-frequency, low-stakes, and abstention is always safe, so the cheap
// model is the right one. Override with PHASE_LLM_MODEL if that ever changes.
const LLM_MODEL = Deno.env.get("PHASE_LLM_MODEL") ?? "claude-haiku-4-5";
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");
const LLM_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};
const LLM_PRICE_IN = Number(Deno.env.get("LLM_PRICE_IN") ?? (LLM_PRICES[LLM_MODEL]?.in ?? 1.0));
const LLM_PRICE_OUT = Number(Deno.env.get("LLM_PRICE_OUT") ?? (LLM_PRICES[LLM_MODEL]?.out ?? 5.0));

/** Month-to-date AI spend across every lane (same ledger the field app bills to). */
async function monthSpend(supabase: ReturnType<typeof createClient>): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const { data } = await supabase
    .from("ai_usage")
    .select("cost_usd")
    .eq("billing_month", month)
    .limit(5000);
  return ((data ?? []) as { cost_usd: number }[]).reduce((t, r) => t + (Number(r.cost_usd) || 0), 0);
}

type EntryRow = { id: string; data: Record<string, unknown> };

/** One batched forced-tool call. Returns validated assignments + token usage. */
async function aiAssignPhases(entries: AiEntry[], phases: Subtask[]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(LLM_MODEL, entries, phases)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const inTok = Number(data.usage?.input_tokens) || 0;
  const outTok = Number(data.usage?.output_tokens) || 0;
  // A truncated tool call yields half a JSON object — drop the batch rather
  // than stamp a partial one (the entries just stay on the date fallback).
  const block = data.stop_reason === "max_tokens"
    ? null
    : (data.content ?? []).find((b) => b.type === "tool_use" && b.name === "assign");
  return { assignments: block ? applyAiMatches(block.input, entries, phases) : [], inTok, outTok };
}

/** Codes the owner texts back ("YES 14") must be unique across every LIVE
    proposal, not just this kind — the brief hands out 11+ for its own. */
async function takeCodes(supabase: ReturnType<typeof createClient>, n: number): Promise<number[]> {
  const { data } = await supabase.from("pending_actions").select("code").eq("status", "pending").limit(200);
  const used = new Set(((data ?? []) as { code: number }[]).map((r) => Number(r.code)));
  const out: number[] = [];
  let next = 11;
  while (out.length < n) {
    while (used.has(next)) next++;
    used.add(next);
    out.push(next++);
  }
  return out;
}

/** AI-stamp what the matcher couldn't, then propose phases for what's STILL
    unexplained. Returns counters; never throws into the pull path. */
async function enrichJobcode(
  supabase: ReturnType<typeof createClient>,
  jobcodeId: string,
  boardJobs: BoardJobLite[],
  opts: { ai?: boolean; propose?: boolean } = {}
): Promise<{ stamped: number; aiStamped: number; proposed: number; capped: boolean; spent: number }> {
  const useAi = opts.ai !== false && !!LLM_API_KEY;
  const propose = opts.propose !== false;
  let stamped = 0, aiStamped = 0, proposed = 0, capped = false, spent = 0;
  if (!boardJobs.length) return { stamped, aiStamped, proposed, capped, spent };

  const { data: rows } = await supabase
    .from("time_entries")
    .select("id, data")
    .eq("deleted", false)
    .filter("data->>qbJobcodeId", "eq", jobcodeId)
    .limit(2000);

  // Unstamped, and not something the owner already decided by hand.
  const open = ((rows ?? []) as EntryRow[]).filter((r) => isOpenForMatching(r.data));
  if (!open.length) return { stamped, aiStamped, proposed, capped, spent };

  // Group by the board job whose hours window owns each entry's date.
  const byJob = new Map<string, { job: BoardJobLite; rows: EntryRow[] }>();
  for (const r of open) {
    const j = phasedJobForDate(boardJobs, String(r.data?.date || ""));
    if (!j) continue;
    const g = byJob.get(j.id) || { job: j, rows: [] };
    g.rows.push(r);
    byJob.set(j.id, g);
  }

  for (const { job, rows: jobRows0 } of byJob.values()) {
    const phases = (job.subtasks || []).filter((st) => st && st.id && String(st.name || "").trim());
    if (!phases.length) continue;
    let jobRows = jobRows0;

    // ---- free re-match first ----
    // The phase list is not static: the owner adds one (often by approving a
    // proposal made right here). Ingest only matched the rows it pulled that
    // day, so without this the very entries a new phase was created FOR would
    // never attach to it — and the phase would sit at 0 logged hours forever.
    const redo: { id: string; deleted: boolean; data: Record<string, unknown> }[] = [];
    for (const r of jobRows) {
      const m = matchPhase(
        { service: String(r.data?.service || ""), note: String(r.data?.note || ""), task: String(r.data?.task || "") },
        phases
      );
      if (!m) continue;
      redo.push({
        id: r.id, deleted: false,
        data: { ...r.data, phaseId: m.phaseId, phaseMatch: { by: m.by, score: m.score } },
      });
    }
    if (redo.length) {
      const { error } = await supabase.from("time_entries").upsert(redo, { onConflict: "id" });
      if (!error) {
        stamped += redo.length;
        const done = new Set(redo.map((w) => w.id));
        jobRows = jobRows.filter((r) => !done.has(r.id));
      }
    }
    let left = jobRows;

    // ---- AI pass (only entries that actually said something) ----
    if (useAi) {
      // Only entries that actually described work. workText excludes the
      // jobcode-name fallback in `task`, so a note-less row is correctly
      // silent — asking the model to classify "3018 Nate Circle" produced
      // confident nonsense. Also skip anything it already looked at and
      // passed on: each entry costs at most one call, ever.
      const speakers = jobRows
        .filter((r) => workText(r.data as Record<string, string>).length > 0)
        .filter((r) => (r.data?.phaseMatch as { by?: string } | undefined)?.by !== "ai")
        .slice(0, MAX_BATCH);
      if (speakers.length) {
        spent = await monthSpend(supabase);
        if (SPEND_CAP_USD > 0 && spent >= SPEND_CAP_USD) {
          capped = true;
          await supabase.from("ai_usage").insert({
            provider: "none", capped: true, cost_usd: 0,
            form_key: "qbtime_phase", note: "monthly spend cap reached",
          });
        } else {
          const batch: AiEntry[] = speakers.map((r) => ({
            id: r.id,
            hours: Number(r.data?.hours) || 0,
            date: String(r.data?.date || ""),
            note: String(r.data?.note || ""),
            task: String(r.data?.task || ""),
            jobcodeName: String(r.data?.jobcodeName || ""),
            service: String(r.data?.service || ""),
          }));
          try {
            const { assignments, inTok, outTok } = await aiAssignPhases(batch, phases);
            const cost = (inTok / 1e6) * LLM_PRICE_IN + (outTok / 1e6) * LLM_PRICE_OUT;
            await supabase.from("ai_usage").insert({
              provider: "anthropic", llm_model: LLM_MODEL,
              input_tokens: inTok, output_tokens: outTok,
              llm_cost_usd: cost, cost_usd: cost, capped: false,
              form_key: "qbtime_phase", note: `phase match — ${batch.length} entries`,
            });
            const byId = new Map(jobRows.map((r) => [r.id, r]));
            const chosen = new Map(assignments.map((a) => [a.entryId, a]));
            // Write BOTH outcomes: a match, and a "looked at it, no phase fits"
            // marker. The marker is what stops us re-asking (and re-paying) for
            // the same vague note every night.
            const writes = speakers.map((r) => {
              const a = chosen.get(r.id);
              return {
                id: r.id, deleted: false,
                data: a
                  ? { ...r.data, phaseId: a.phaseId, phaseMatch: { by: "ai", score: a.confidence } }
                  : { ...r.data, phaseMatch: { by: "ai", score: 0 } },
              };
            });
            if (writes.length) {
              const { error } = await supabase.from("time_entries").upsert(writes, { onConflict: "id" });
              if (!error) {
                aiStamped += chosen.size;
                left = left.filter((r) => !chosen.has(r.id));
              }
            }
          } catch (e) {
            // A model hiccup must never break the nightly pull — the entries
            // simply stay on the board's date fallback until tomorrow.
            console.error(`ai phase match failed for ${jobcodeId}:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }

    // ---- propose a phase for work nothing covers ----
    // Nothing new while a queue is already waiting on the owner.
    const { count: liveCount } = await supabase
      .from("pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("kind", "boardEdit")
      .eq("status", "pending");
    if (propose && left.length && (liveCount ?? 0) < MAX_LIVE_PROPOSALS) {
      const clusters = clusterUnmatched(
        left.map((r) => ({
          id: r.id, hours: Number(r.data?.hours) || 0,
          note: String(r.data?.note || ""), task: String(r.data?.task || ""),
        })),
        phases
      );
      if (clusters.length) {
        // Don't nag: a boardEdit raised for this job+phase in the last 30 days
        // counts as asked — including one the owner ignored or declined.
        // EXCEPT a failed one: the owner said yes and it lost a rev race, so
        // that question deserves asking again tomorrow.
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const { data: recent } = await supabase
          .from("pending_actions")
          .select("params, status, created_at")
          .eq("kind", "boardEdit")
          .gte("created_at", since)
          .limit(200);
        const asked = new Set(
          ((recent ?? []) as { params: Record<string, unknown>; status: string }[])
            .filter((r) => r.status !== "failed")
            .map((r) => {
              const p = r.params as { rowId?: string; phase?: { name?: string } };
              return `${p?.rowId || ""}::${String(p?.phase?.name || "").toLowerCase()}`;
            })
        );
        // The brief can only offer a couple a morning and a proposal expires in
        // a day, so raising 14 at once (the first backfill did) just burns 12 of
        // them. Biggest first, a few at a time; the rest come back tomorrow.
        const fresh = clusters
          .filter((c) => !asked.has(`${job.id}::${c.name.toLowerCase()}`))
          .slice(0, MAX_PROPOSALS_PER_JOB);
        if (fresh.length) {
          const codes = await takeCodes(supabase, fresh.length);
          const inserts = fresh.map((c, i) => ({
            code: codes[i],
            kind: "boardEdit",
            label: `add phase "${c.name}" to ${jobLabel(job)} (${c.hours}h logged)`,
            job_id: job.id,
            proposed_by: "qb-time",
            params: {
              op: "addPhase",
              rowId: job.id,
              phase: {
                id: crypto.randomUUID(),
                name: c.name,
                durationDays: null,
                lagDays: 0,
                estimatedHours: c.hours,
                crewIds: [],
              },
              entryIds: c.entryIds,
            },
          }));
          const { error } = await supabase.from("pending_actions").insert(inserts);
          if (!error) proposed += inserts.length;
        }
      }
    }
  }
  return { stamped, aiStamped, proposed, capped, spent };
}

// ---------------------------------------------------------------------------
// Shared pull: one jobcode, one day -> time_entries (idempotent + delete-aware)
// ---------------------------------------------------------------------------

async function pullOneDay(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  jobcodeId: string,
  date: string,
  fieldProjectId: string | null,
  boardJobs: BoardJobLite[] | null = null
): Promise<{ pulled: number; written: number; skipped: number; removed: number }> {
  const qs = new URLSearchParams({
    jobcode_ids: jobcodeId,
    start_date: date,
    end_date: date,
    on_the_clock: "no",
    per_page: "200",
    supplemental_data: "yes",
  });

  const res = (await qbFetch(`/timesheets?${qs}`, accessToken)) as {
    results: { timesheets: Record<string, QbTimesheet> };
    supplemental_data: {
      users?: Record<string, { id: number; first_name: string; last_name: string }>;
      jobcodes?: Record<string, { id: number; name: string }>;
      customfields?: Record<string, { name?: string }>;
    };
  };

  const timesheets = Object.values(res.results?.timesheets ?? {});
  const users = res.supplemental_data?.users ?? {};
  const jobcodes = res.supplemental_data?.jobcodes ?? {};
  const serviceFieldId = findServiceFieldId(res.supplemental_data?.customfields);

  // Existing QB rows for this jobcode+date: reuse ids (update in place) and
  // detect timesheets that were removed in QuickBooks since the last pull.
  const { data: existing } = await supabase
    .from("time_entries")
    .select("id, data")
    .eq("deleted", false)
    .filter("data->>qbJobcodeId", "eq", jobcodeId)
    .filter("data->>date", "eq", date);

  const idByTs = new Map<string, string>();
  for (const r of (existing ?? []) as { id: string; data: { qbTimesheetId?: string } }[]) {
    if (r.data?.qbTimesheetId) idByTs.set(String(r.data.qbTimesheetId), r.id);
  }

  const seen = new Set<string>(timesheets.map((ts) => String(ts.id)));
  if (boardJobs === null) boardJobs = await fetchPhasedBoardJobs(supabase, jobcodeId);
  const rows = qbRowsFrom(timesheets, users, jobcodes, jobcodeId, fieldProjectId, idByTs, serviceFieldId, boardJobs);

  // Only write what actually changed: preserves original createdAt and any
  // manual phase assignment, and stops the nightly re-pull from rewriting
  // every unchanged row (it used to — pure DB churn).
  const existingById = new Map<string, Record<string, unknown>>();
  for (const r of (existing ?? []) as { id: string; data: Record<string, unknown> }[]) existingById.set(r.id, r.data);
  const { toWrite, skipped } = reconcileRows(rows, existingById);

  if (toWrite.length > 0) {
    const { error } = await supabase.from("time_entries").upsert(toWrite, { onConflict: "id" });
    if (error) throw new Error(`time_entries upsert failed: ${error.message}`);
  }

  // Soft-delete QB rows whose timesheet no longer exists for this day.
  const staleIds: string[] = [];
  for (const [ts, id] of idByTs) if (!seen.has(ts)) staleIds.push(id);
  if (staleIds.length > 0) {
    await supabase.from("time_entries").update({ deleted: true }).in("id", staleIds);
  }

  return { pulled: rows.length, written: toWrite.length, skipped, removed: staleIds.length };
}

// ---------------------------------------------------------------------------
// Ranged backfill: one jobcode over a date range -> time_entries (paged upsert).
// Additive (no per-day delete sweep — the nightly pullOneDay handles removals).
// Used by the board's "Sync hours" to backfill a job's history.
// ---------------------------------------------------------------------------

async function pullRange(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  jobcodeId: string,
  startDate: string,
  endDate: string,
  fieldProjectId: string | null,
  boardJobs: BoardJobLite[] | null = null
): Promise<{ pulled: number; written: number; skipped: number; pages: number }> {
  const all: QbTimesheet[] = [];
  const users: Record<string, { first_name: string; last_name: string }> = {};
  const jobcodes: Record<string, { name: string }> = {};
  const customfieldDefs: Record<string, { name?: string }> = {};
  let page = 1;
  let more = true;
  while (more && page <= 25) {
    const qs = new URLSearchParams({
      jobcode_ids: jobcodeId,
      start_date: startDate,
      end_date: endDate,
      on_the_clock: "no",
      per_page: "200",
      page: String(page),
      supplemental_data: "yes",
    });
    const res = (await qbFetch(`/timesheets?${qs}`, accessToken)) as {
      results: { timesheets: Record<string, QbTimesheet> };
      supplemental_data: {
        users?: Record<string, { first_name: string; last_name: string }>;
        jobcodes?: Record<string, { name: string }>;
        customfields?: Record<string, { name?: string }>;
      };
    };
    const ts = Object.values(res.results?.timesheets ?? {});
    all.push(...ts);
    Object.assign(users, res.supplemental_data?.users ?? {});
    Object.assign(jobcodes, res.supplemental_data?.jobcodes ?? {});
    Object.assign(customfieldDefs, res.supplemental_data?.customfields ?? {});
    more = ts.length >= 200; // a full page probably means there's another
    page++;
  }
  const serviceFieldId = findServiceFieldId(customfieldDefs);

  const { data: existing } = await supabase
    .from("time_entries")
    .select("id, data")
    .eq("deleted", false)
    .filter("data->>qbJobcodeId", "eq", jobcodeId)
    .filter("data->>date", "gte", startDate)
    .filter("data->>date", "lte", endDate);

  const idByTs = new Map<string, string>();
  for (const r of (existing ?? []) as { id: string; data: { qbTimesheetId?: string } }[]) {
    if (r.data?.qbTimesheetId) idByTs.set(String(r.data.qbTimesheetId), r.id);
  }

  if (boardJobs === null) boardJobs = await fetchPhasedBoardJobs(supabase, jobcodeId);
  const rows = qbRowsFrom(all, users, jobcodes, jobcodeId, fieldProjectId, idByTs, serviceFieldId, boardJobs);

  // Same reconcile as pullOneDay: preserve createdAt + manual phase stamps,
  // skip rows whose content didn't change.
  const existingById = new Map<string, Record<string, unknown>>();
  for (const r of (existing ?? []) as { id: string; data: Record<string, unknown> }[]) existingById.set(r.id, r.data);
  const { toWrite, skipped } = reconcileRows(rows, existingById);

  if (toWrite.length > 0) {
    const { error } = await supabase.from("time_entries").upsert(toWrite, { onConflict: "id" });
    if (error) throw new Error(`time_entries upsert failed: ${error.message}`);
  }
  return { pulled: rows.length, written: toWrite.length, skipped, pages: page - 1 };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const clientId = Deno.env.get("QB_TIME_CLIENT_ID");
  const clientSecret = Deno.env.get("QB_TIME_CLIENT_SECRET");
  const redirectUri = Deno.env.get("QB_TIME_REDIRECT_URI");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Service-role client (bypasses RLS for token storage)
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const action = body.action as string;

  // ── exchangeCode ──────────────────────────────────────────────────────────
  if (action === "exchangeCode") {
    const code = body.code as string;
    const userId = body.userId as string;

    if (!code) return err("Missing code");
    if (!clientId || !clientSecret || !redirectUri) {
      return err("QB_TIME_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI not configured");
    }

    // TSheets grant: client creds go in the form body (no Basic auth).
    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return err(`Token exchange failed: ${text}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase.from("qb_time_tokens").upsert(
      {
        realm_id: QB_TIME_REALM,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        connected_by: userId ?? null,
      },
      { onConflict: "realm_id" }
    );

    return ok({ connected: true });
  }

  // ── getStatus ─────────────────────────────────────────────────────────────
  /* ⚠️ "Connected" used to mean nothing more than "a token row exists" — it
     selected expires_at and never looked at it. So the admin panel showed a
     green ● Connected for 19 days while every call that actually needed the
     token 400'd on a failed refresh, and the only visible symptom was a stale
     "updated" date nobody had reason to distrust.

     A status that cannot report failure is worse than no status: it actively
     tells you to look elsewhere. This one proves the token works by USING it,
     which is the only honest answer to "are we connected?". */
  if (action === "getStatus") {
    const { data, error } = await supabase
      .from("qb_time_tokens")
      .select("realm_id, expires_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return ok({ connected: false, reason: "never_connected" });

    const expiresAt = new Date(data.expires_at).getTime();
    const expired = !(expiresAt > Date.now());

    // Exercise the credential. getAccessToken refreshes when needed, so a
    // success here means the link genuinely works right now, and a failure
    // names the reason instead of hiding it.
    let healthy = false;
    let reason: string | null = null;
    try {
      await getValidToken(supabase);
      healthy = true;
    } catch (e) {
      reason = String((e as Error)?.message ?? e).slice(0, 200);
    }

    return ok({
      connected: healthy,
      needsReconnect: !healthy,
      // kept so the panel can still show when the link was last refreshed
      realmId: data.realm_id,
      updatedAt: data.updated_at,
      expiresAt: data.expires_at,
      accessTokenExpired: expired,
      reason,
    });
  }

  // ── disconnect ────────────────────────────────────────────────────────────
  // TSheets has no simple token-revoke endpoint; dropping the stored token is
  // enough to disconnect this app (the user can also revoke in QuickBooks Time).
  if (action === "disconnect") {
    await supabase.from("qb_time_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    return ok({ disconnected: true });
  }

  // ── syncJobcodes ──────────────────────────────────────────────────────────
  if (action === "syncJobcodes") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch(
        "/jobcodes?active=yes&type=regular&per_page=200",
        accessToken
      )) as { results: { jobcodes: Record<string, { id: number; name: string; parent_id: number; type: string; active: boolean }> } };

      const jobcodes = Object.values(res.results?.jobcodes ?? {});

      if (jobcodes.length > 0) {
        await supabase.from("qb_time_jobcodes").upsert(
          jobcodes.map((jc) => ({
            qb_id: String(jc.id),
            name: jc.name,
            parent_id: jc.parent_id ? String(jc.parent_id) : null,
            jobcode_type: jc.type,
            active: jc.active,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: "qb_id" }
        );
      }

      return ok({ synced: jobcodes.length });
    } catch (e) {
      return err(e instanceof Error ? e.message : "syncJobcodes failed");
    }
  }

  // ── getTimesheets ─────────────────────────────────────────────────────────
  if (action === "getTimesheets") {
    const jobcodeId = body.jobcodeId as string;
    const startDate = (body.startDate as string) ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const endDate = (body.endDate as string) ?? new Date().toISOString().slice(0, 10);

    if (!jobcodeId) return err("Missing jobcodeId");

    try {
      const accessToken = await getValidToken(supabase);
      const qs = new URLSearchParams({
        jobcode_ids: jobcodeId,
        start_date: startDate,
        end_date: endDate,
        on_the_clock: "no",
        per_page: "200",
        supplemental_data: "yes",
      });

      const res = (await qbFetch(`/timesheets?${qs}`, accessToken)) as {
        results: {
          timesheets: Record<string, {
            id: number;
            user_id: number;
            jobcode_id: number;
            start: string;
            end: string;
            duration: number;
            date: string;
            notes: string;
          }>;
        };
        supplemental_data: {
          users: Record<string, { id: number; first_name: string; last_name: string; email: string }>;
        };
      };

      const timesheets = Object.values(res.results?.timesheets ?? {});
      const users = res.supplemental_data?.users ?? {};
      const customfields = (res.supplemental_data as { customfields?: unknown })?.customfields ?? {};

      return ok({ timesheets, users, customfields });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getTimesheets failed");
    }
  }

  // ── getUsers ──────────────────────────────────────────────────────────────
  if (action === "getUsers") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch("/users?active=yes&per_page=200", accessToken)) as {
        results: { users: Record<string, { id: number; first_name: string; last_name: string; email: string; employee_number: string }> };
      };
      const users = Object.values(res.results?.users ?? {});
      return ok({ users });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getUsers failed");
    }
  }

  // ── getCurrentTotals ──────────────────────────────────────────────────────
  if (action === "getCurrentTotals") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch(
        "/reports/current_totals?on_the_clock=yes&supplemental_data=yes",
        accessToken
      )) as {
        results: {
          totals: Record<string, {
            user_id: number;
            jobcode_id: number;
            shift_seconds: number;
            on_the_clock: boolean;
          }>;
        };
        supplemental_data: {
          users: Record<string, { id: number; first_name: string; last_name: string }>;
          jobcodes: Record<string, { id: number; name: string }>;
        };
      };

      const totals = Object.values(res.results?.totals ?? {}).filter((t) => t.on_the_clock);
      const users = res.supplemental_data?.users ?? {};
      const jobcodes = res.supplemental_data?.jobcodes ?? {};

      return ok({ totals, users, jobcodes });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getCurrentTotals failed");
    }
  }

  // ── pullDay ───────────────────────────────────────────────────────────────
  // Pull one day's timesheets for a jobcode and upsert them into time_entries,
  // tagged to a field project. Idempotent on qbTimesheetId. Called by the field
  // app's "Pull today's hours" button and (phase 2) the nightly cron.
  if (action === "pullDay") {
    if (!(await requireUser(supabase, req))) return err("Not authorized", 401);

    const jobcodeId = body.jobcodeId as string;
    const date = (body.date as string) ?? new Date().toISOString().slice(0, 10);
    const fieldProjectId = (body.fieldProjectId as string) ?? null;
    if (!jobcodeId) return err("Missing jobcodeId");

    try {
      const accessToken = await getValidToken(supabase);
      const { pulled, written, skipped, removed } = await pullOneDay(supabase, accessToken, jobcodeId, date, fieldProjectId);
      return ok({ pulled, written, skipped, removed, date, jobcodeId });
    } catch (e) {
      return err(e instanceof Error ? e.message : "pullDay failed");
    }
  }

  // ── pullRange (board backfill) ────────────────────────────────────────────
  // Backfill a whole date range of one jobcode's hours into time_entries.
  if (action === "pullRange") {
    if (!(await requireUser(supabase, req))) return err("Not authorized", 401);

    const jobcodeId = body.jobcodeId as string;
    if (!jobcodeId) return err("Missing jobcodeId");
    const endDate = (body.endDate as string) ?? new Date().toISOString().slice(0, 10);
    const startDate = (body.startDate as string) ?? new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const fieldProjectId = (body.fieldProjectId as string) ?? null;

    try {
      const accessToken = await getValidToken(supabase);
      const { pulled, written, skipped, pages } = await pullRange(supabase, accessToken, jobcodeId, startDate, endDate, fieldProjectId);
      return ok({ pulled, written, skipped, pages, startDate, endDate, jobcodeId });
    } catch (e) {
      return err(e instanceof Error ? e.message : "pullRange failed");
    }
  }

  // ── pullAllLinked (nightly cron) ──────────────────────────────────────────
  // For every FIELD project AND BOARD job linked to a QB jobcode, pull the given
  // date(s) into time_entries. Deduped by jobcode. Gated by CRON_SECRET (pg_cron
  // via pg_net) OR a valid user.
  if (action === "pullAllLinked") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const provided = (body.cronSecret as string) ?? req.headers.get("x-cron-secret") ?? "";
    const isCron = !!cronSecret && provided === cronSecret;
    if (!isCron && !(await requireUser(supabase, req))) return err("Not authorized", 401);

    const today = new Date().toISOString().slice(0, 10);
    const dates: string[] = Array.isArray(body.dates)
      ? (body.dates as string[])
      : [(body.date as string) ?? today];

    try {
      const [{ data: fps }, { data: cjs }] = await Promise.all([
        supabase.from("field_projects").select("id, data").eq("deleted", false),
        supabase.from("coordination_jobs").select("id, data").eq("deleted", false),
      ]);

      // Dedupe by jobcode across both apps; keep one representative project id.
      const byJobcode = new Map<string, string>();
      for (const p of (fps ?? []) as { id: string; data: { qbJobcodeId?: string } }[]) {
        const jc = p.data?.qbJobcodeId;
        if (jc && !byJobcode.has(jc)) byJobcode.set(jc, p.id);
      }
      for (const j of (cjs ?? []) as { id: string; data: { qbJobcodeId?: string } }[]) {
        const jc = j.data?.qbJobcodeId;
        if (jc && !byJobcode.has(jc)) byJobcode.set(jc, j.id);
      }

      // Phased board jobs per jobcode, built from the read we already did —
      // the matcher's phase source (see qbRowsFrom).
      const phasedByJobcode = new Map<string, BoardJobLite[]>();
      for (const j of (cjs ?? []) as { id: string; data: Record<string, unknown> }[]) {
        const jc = j.data?.qbJobcodeId as string | undefined;
        const subtasks = (j.data?.subtasks as BoardJobLite["subtasks"]) || [];
        if (!jc || !subtasks.length) continue;
        const list = phasedByJobcode.get(jc) || [];
        list.push({ id: j.id, qbJobcodeId: jc, hoursFrom: (j.data?.hoursFrom as string) || "", subtasks });
        phasedByJobcode.set(jc, list);
      }

      const linked = [...byJobcode.entries()].map(([jobcodeId, projId]) => ({ jobcodeId, projId }));
      if (linked.length === 0) return ok({ jobcodes: 0, totalPulled: 0, totalRemoved: 0, results: [] });

      const accessToken = await getValidToken(supabase);
      let totalPulled = 0;
      let totalWritten = 0;
      let totalSkipped = 0;
      let totalRemoved = 0;
      let totalAiStamped = 0;
      let totalProposed = 0;
      const results: unknown[] = [];
      for (const { jobcodeId, projId } of linked) {
        for (const d of dates) {
          try {
            const { pulled, written, skipped, removed } =
              await pullOneDay(supabase, accessToken, jobcodeId, d, projId, phasedByJobcode.get(jobcodeId) ?? []);
            totalPulled += pulled;
            totalWritten += written;
            totalSkipped += skipped;
            totalRemoved += removed;
            results.push({ jobcodeId, date: d, pulled, written, skipped, removed });
          } catch (e) {
            results.push({ jobcodeId, date: d, error: e instanceof Error ? e.message : String(e) });
          }
        }
        // Once per jobcode, AFTER its days landed: the paid AI pass over what
        // the free matcher missed, then phase proposals for what nothing
        // covers. Isolated so a model/ledger problem can't fail the pull.
        const phased = phasedByJobcode.get(jobcodeId) ?? [];
        if (phased.length) {
          try {
            const { stamped, aiStamped, proposed } = await enrichJobcode(supabase, jobcodeId, phased);
            totalWritten += stamped;
            totalAiStamped += aiStamped;
            totalProposed += proposed;
          } catch (e) {
            results.push({ jobcodeId, enrichError: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      return ok({
        jobcodes: linked.length, totalPulled, totalWritten, totalSkipped, totalRemoved,
        totalAiStamped, totalProposed, results,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : "pullAllLinked failed");
    }
  }

  // ── rematchAll (one-time backfill) ────────────────────────────────────────
  // Re-attribute HISTORICAL entries now that matching exists: deterministic
  // pass over every unstamped entry of every phased job, then (opt-in) the AI
  // pass and phase proposals. Manual stamps are never touched. Safe to re-run.
  //   { action:"rematchAll", ai?:false, propose?:false, jobcodeId?:"…" }
  if (action === "rematchAll") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const provided = (body.cronSecret as string) ?? req.headers.get("x-cron-secret") ?? "";
    const isCron = !!cronSecret && provided === cronSecret;
    if (!isCron && !(await requireUser(supabase, req))) return err("Not authorized", 401);

    const onlyJobcode = (body.jobcodeId as string) || "";
    const useAi = body.ai === true;              // costs money — opt in explicitly
    const propose = body.propose !== false;

    try {
      const { data: cjs } = await supabase
        .from("coordination_jobs")
        .select("id, data")
        .eq("deleted", false);

      const phasedByJobcode = new Map<string, BoardJobLite[]>();
      for (const j of (cjs ?? []) as { id: string; data: Record<string, unknown> }[]) {
        const jc = j.data?.qbJobcodeId as string | undefined;
        if (!jc || (onlyJobcode && jc !== onlyJobcode)) continue;
        const lite = boardJobLite(j.id, j.data, jc);
        if (!(lite.subtasks || []).length) continue;
        phasedByJobcode.set(jc, [...(phasedByJobcode.get(jc) ?? []), lite]);
      }
      if (phasedByJobcode.size === 0) return ok({ jobcodes: 0, stamped: 0, aiStamped: 0, proposed: 0, results: [] });

      let stamped = 0, aiStamped = 0, proposed = 0;
      const results: unknown[] = [];
      for (const [jobcodeId, jobs] of phasedByJobcode) {
        try {
          // enrichJobcode already re-matches everything still open (free pass),
          // then optionally spends on the tail and proposes missing phases.
          const enriched = await enrichJobcode(supabase, jobcodeId, jobs, { ai: useAi, propose });
          stamped += enriched.stamped;
          aiStamped += enriched.aiStamped;
          proposed += enriched.proposed;
          results.push({ jobcodeId, ...enriched });
        } catch (e) {
          results.push({ jobcodeId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return ok({ jobcodes: phasedByJobcode.size, stamped, aiStamped, proposed, results });
    } catch (e) {
      return err(e instanceof Error ? e.message : "rematchAll failed");
    }
  }

  return err(`Unknown action: ${action}`, 404);
});
