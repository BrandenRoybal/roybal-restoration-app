/* The billing.reconcile queue kind — the nightly billing check (migration
   0021, phase 2).

   pg_cron enqueues {run_date} for the Alaska date at 14:45 UTC; a manual run
   is {job_ids: [uuid, …]} (README). For each water job in scope the pure
   detector (apps/field/js/reconcile.js, copied into the image at the path
   this import uses) compares what the job documents with what its invoices
   bill, and whatever is missing is filed through ONE door,
   billing_review_gaps_file: it stamps the invoice fingerprint, files
   invoice.review_gaps as agent:billing and supersedes the job's older open
   card. This lane never writes a job; the owner's approval does, in SQL.

   Reads (service role, projected to what the detector reads):
     coordination_jobs  the board stage of each linked field job
     field_projects     a scan of the scope keys, paged by id; then each
                        candidate re-read with every key the detector needs
     time_entries       the job's QuickBooks Time rows by jobcode, as
                        {id, date, hours, qbTimesheetId, updated_at, source}:
                        never a name, a note or a QB user id

   Per job: lines → filed (a new card; the door offers the same findings on
   the same invoices again only when their card expired or was superseded
   unanswered) or unchanged (that card is still open, or was declined, failed
   or executed: it stands, and the door supersedes the job's other open cards
   as findings_changed, counted in superseded); no lines →
   the door is called with a null input so an open card is superseded
   (no_gaps), and a job with hints but no lines is listed in hints_only. A
   job saved between the read and the filing (rev_moved) is read again, once.
   One job's error is recorded and the run goes on. A read that fails before
   any job is reached throws, and the queue retries the whole run: the door's
   key makes a second filing of the same findings a no-op.

   BILLING_RECONCILE=off (config.billingReconcile false) answers
   {skipped: "off"} without reading anything; a run_date older than
   yesterday (Alaska) answers {skipped: "stale"}: a night the worker missed is
   covered by the next night, never caught up days late. */

import { createHash } from "node:crypto";
import * as detector from "../../../apps/field/js/reconcile.js";
import { errText } from "../log.mjs";
import { JobError } from "./queue.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MANUAL_IDS = 100;
const MAX_HINTS_ONLY = 50;
const MAX_ERRORS = 20;
const PAGE = { scan: 200, stages: 1000, time: 1000 };
// the board's stage order (apps/field/js/boardpush.js STAGE_ORDER)
const STAGE_ORDER = ["lead", "scheduled", "in_progress", "on_hold", "final", "done"];

/* What scopeOf reads (jobType, lossTypesOf's inputs, archivedAt, invoices),
   and on top of it everything reconcileJob reads. A key missing here reads as
   absent to the detector: lossTypesOf, for one, calls a job with no loss
   fields at all water. test/billing.test.mjs holds both lists to the
   detector's source. */
export const SCOPE_KEYS = ["jobType", "lossTypes", "waterCategory", "waterClass", "dryingSystem", "smokeType",
  "fireDamage", "moldCondition", "moldExtent", "stormCause", "envelopeBreached", "archivedAt", "invoices"];
export const JOB_KEYS = [...SCOPE_KEYS, "rev", "customer", "dateOfLoss", "qbJobcodeId", "laborLog", "dryingLogs",
  "moistureMaps", "photos", "changeOrders", "cat3Justification"];
const TIME_SELECT = "id,updated_at,date:data->>date,hours:data->hours,qbTimesheetId:data->>qbTimesheetId,source:data->>source";

const projection = (keys) => ["id", "deleted", ...keys.map((k) => `${k}:data->${k}`)].join(",");

/** A projected row → the job blob the detector reads (absent keys stay absent). */
function asProject(row, keys) {
  const p = { id: row.id };
  if (row.deleted === true) p.deleted = true;
  for (const k of keys) if (row[k] != null) p[k] = row[k];
  return p;
}

/** Every page of a query, keyset-paged by id until a page comes back empty:
    PostgREST caps a response (1000 rows here) without saying so, and an
    offset page skips a row when one before it is deleted. */
async function forEachPage(supa, table, query, size, fn) {
  for (let after = null; ;) {
    const rows = await supa.select(table, `${query}&order=id.asc&limit=${size}${after ? `&id=gt.${after}` : ""}`);
    if (!rows.length) return;
    await fn(rows);
    after = rows[rows.length - 1].id;
  }
}

/** field job id → its board stage. Two tiles linked to one job (a duplicate
    the board has not healed yet): the one further along decides. */
async function readStages(supa) {
  const stages = new Map();
  await forEachPage(supa, "coordination_jobs",
    "select=id,fieldJobId:data->>fieldJobId,stage:data->>stage&deleted=eq.false&data->>fieldJobId=not.is.null",
    PAGE.stages, (rows) => {
      for (const r of rows) {
        const id = String(r.fieldJobId ?? "").trim().toLowerCase();
        if (!id) continue;
        if (!stages.has(id) || STAGE_ORDER.indexOf(r.stage) > STAGE_ORDER.indexOf(stages.get(id))) stages.set(id, r.stage ?? null);
      }
    });
  return stages;
}

async function readJob(supa, id) {
  const rows = await supa.select("field_projects", `select=${projection(JOB_KEYS)}&id=eq.${id}`);
  return rows[0] ? asProject(rows[0], JOB_KEYS) : null;
}

/** The field app's Labor Log query (qbtime.js allEntriesFor), every page,
    each row cut to the six fields the detector reads. */
async function readTimeEntries(supa, jobcode) {
  const jc = String(jobcode ?? "").trim();
  if (!jc) return [];
  const out = [];
  await forEachPage(supa, "time_entries",
    `select=${TIME_SELECT}&deleted=eq.false&data->>qbJobcodeId=eq.${encodeURIComponent(jc)}&data->>source=eq.qbtime`,
    PAGE.time, (rows) => {
      for (const r of rows) {
        out.push({ id: r.id, date: r.date ?? "", hours: r.hours ?? 0, qbTimesheetId: r.qbTimesheetId ?? "",
          updated_at: r.updated_at ?? "", source: r.source ?? "" });
      }
    });
  return out;
}

/** "YYYY-MM-DD" in Alaska for an instant. */
export function alaskaDate(now) {
  const parts = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Anchorage", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)) parts[x.type] = x.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const validDate = (s) => {
  const t = DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// data.rev as the door compares it; a blob with no usable rev files with none
const revOf = (v) => (v != null && v !== "" && Number.isInteger(Number(v)) ? Number(v) : null);
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** The run's payload → { manual, ids, runDate }, a stale skip, or a dead job. */
function readPayload(payload, today) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (p.job_ids !== undefined) {
    const ids = Array.isArray(p.job_ids) ? p.job_ids : [];
    if (!ids.length || ids.length > MAX_MANUAL_IDS || !ids.every((x) => typeof x === "string" && UUID_RE.test(x))) {
      throw new JobError(`billing.reconcile: job_ids must be 1 to ${MAX_MANUAL_IDS} field job ids (uuids)`, { permanent: true });
    }
    return { manual: true, ids: [...new Set(ids.map((x) => x.toLowerCase()))], runDate: today };
  }
  const runDate = typeof p.run_date === "string" ? p.run_date : "";
  if (!validDate(runDate)) {
    throw new JobError("billing.reconcile: the payload needs run_date (YYYY-MM-DD) or job_ids", { permanent: true });
  }
  if (runDate < addDays(today, -1)) return { stale: runDate };
  return { manual: false, ids: null, runDate };
}

export async function billingReconcile(ctx, job) {
  if (ctx.cfg.billingReconcile === false) return { skipped: "off" };
  const today = alaskaDate(ctx.now?.() ?? new Date());
  const run = readPayload(job.payload, today);
  if (run.stale) return { skipped: "stale", run_date: run.stale };
  // ctx.detector replaces parts of the detector in tests, as ctx.handlers does the lanes
  const det = { ...detector, ...(ctx.detector ?? {}) };

  const summary = {
    run_date: run.runDate, jobs_seen: 0, in_scope: 0, filed: 0, unchanged: 0, superseded: 0,
    skipped: {}, hints_only: [], errors: [],
  };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };

  // A manual run ignores the board stage (scopeOf), so it reads no tiles.
  const stages = run.manual ? new Map() : await readStages(ctx.supa);
  let candidates = run.ids;
  if (run.manual) {
    summary.jobs_seen = candidates.length;
  } else {
    candidates = [];
    await forEachPage(ctx.supa, "field_projects", `select=${projection(SCOPE_KEYS)}&deleted=eq.false`, PAGE.scan, (rows) => {
      for (const row of rows) {
        summary.jobs_seen += 1;
        const s = det.scopeOf(asProject(row, SCOPE_KEYS), { boardStage: stages.get(row.id) ?? null });
        if (s.ok) candidates.push(row.id); else skip(s.reason);
      }
    });
  }

  for (const id of candidates) {
    // a deploy mid-run: give the job back; the retry re-files nothing that was filed
    if (ctx.stopping?.()) throw new Error("billing.reconcile: the worker is stopping; the queue runs this again");
    try {
      await reconcileOne(ctx, det, { id, today, manual: run.manual, boardStage: stages.get(id) ?? null }, summary, skip);
    } catch (e) {
      const message = errText(e, 300);
      ctx.log("billing.job_failed", { job_id: id, error: message });
      if (summary.errors.length < MAX_ERRORS) summary.errors.push({ job_id: id, message });
    }
  }

  ctx.log("billing.run", {
    run_date: summary.run_date, manual: run.manual, jobs_seen: summary.jobs_seen, in_scope: summary.in_scope,
    filed: summary.filed, unchanged: summary.unchanged, superseded: summary.superseded,
    hints_only: summary.hints_only.length, errors: summary.errors.length,
  });
  return summary;
}

async function reconcileOne(ctx, det, { id, today, manual, boardStage }, summary, skip) {
  let counted = false;
  for (let attempt = 1; ; attempt++) {
    const project = await readJob(ctx.supa, id);
    if (!project) return skip("missing");
    const timeEntries = await readTimeEntries(ctx.supa, project.qbJobcodeId);
    const r = det.reconcileJob(project, { timeEntries, today, boardStage, manual });
    if (!r.scope?.ok) return skip(r.scope?.reason || "out_of_scope");
    if (!counted) { summary.in_scope += 1; counted = true; }

    const rev = revOf(project.rev);
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const hints = Array.isArray(r.hints) ? r.hints : [];
    const args = { p_job_id: id, p_base_rev: rev, p_input: null, p_rationale: null, p_evidence_refs: null };
    if (lines.length) {
      args.p_input = {
        job_id: id,
        findings_hash: md5(det.findingsKey(lines)),
        ...(rev === null ? {} : { base_rev: rev }),
        rate_invoice_id: r.rate_invoice_id ?? "",
        rate_invoice_no: r.rate_invoice_no ?? "",
        sent: r.sent === true,
        lines,
        hints,
        total_usd: r.total_usd,
        unpriced_count: r.unpriced_count,
        detector: det.DETECTOR,
        limits: det.LIMITS,
      };
      args.p_rationale = r.rationale;
      args.p_evidence_refs = Array.isArray(r.evidence_refs) ? r.evidence_refs : [];
    }
    const out = await ctx.supa.rpc("billing_review_gaps_file", args);
    if (out?.skipped === "rev_moved" && attempt === 1) continue;

    if (out?.filed === true) {
      summary.filed += 1;
      summary.superseded += Number(out.superseded) || 0;
      ctx.log("billing.filed", { job_id: id, proposal_id: out.proposal_id ?? null, lines: lines.length, superseded: Number(out.superseded) || 0 });
    } else if (out?.filed === false && out.proposal_id) {
      summary.unchanged += 1;
      summary.superseded += Number(out.superseded) || 0;
    } else if (out?.filed === false && !lines.length) {
      summary.superseded += Number(out.superseded) || 0;
      if (hints.length) {
        skip("hints_only");
        if (summary.hints_only.length < MAX_HINTS_ONLY) summary.hints_only.push(id);
      } else {
        skip("no_gaps");
      }
    } else if (typeof out?.skipped === "string") {
      skip(out.skipped);
    } else {
      throw new Error(`billing_review_gaps_file answered ${JSON.stringify(out) ?? "nothing"}`.slice(0, 300));
    }
    return;
  }
}
