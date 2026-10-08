/* The receipts.qbo_match queue kind — the nightly QuickBooks match (migration
   0023, receipts phase 3).

   pg_cron enqueues {run_date} for the Alaska date at 14:50 UTC, after the
   QuickBooks payment pull has refreshed the token; a manual run is
   {job_ids: [uuid, …]} (README). The lane reads every live receipt, asks
   qbo-proxy for the QuickBooks projects and for the expenses (Purchases)
   dated from a day before the oldest receipt it will match to today, and
   hands it all to the pure matcher (lanes/qbomatch.mjs). It then writes
   what the matcher found through the two 0023 doors and nothing else:

     receipt_qbo_links_note   the states that need no approval (in_qbo,
                              unmatched, conflict), one call for every job in
                              scope; it never touches a receipt the approval
                              path holds (queued, done, failed) and drops the
                              rows of receipts that left the job
     receipts_qbo_link_file   per job: the job's card (one receipts.qbo_link
                              proposal listing each expense to tag or attach
                              to), or no input, which supersedes the job's
                              open card when there is nothing left to do

   This lane never writes QuickBooks. The owner's approval writes one 'qbo'
   outbox row per receipt, and adapters/qbo.mjs delivers those.

   Matching is always over every live receipt, a manual run included, so an
   expense goes to the same receipt whichever run looks at it; a manual run
   writes notes and cards for the jobs it names only.

   Reads (service role): job_receipts (live rows, the columns the matcher
   reads, paged by (job_id, id)), receipt_qbo_links, job_qbo_links,
   field_projects (id, deleted, title, address, customer, qbJobcodeName of
   the jobs with receipts), app_settings receipts.qbo_store_accounts (the
   store-entry switch; unset = off). Through qbo-proxy under the service
   key: listProjects, listPurchases.

   One job's filing error is recorded and the run goes on. A read, a
   qbo-proxy answer or the note write that fails throws, and the queue
   retries the whole run: both doors are idempotent. qbo-proxy answering 404
   (an older build without these actions) ends the run with
   {skipped: "qbo_proxy_not_updated"} before anything is written.

   RECEIPTS_QBO=off (config.receiptsQbo false) answers {skipped: "off"}
   without reading anything; a run_date older than yesterday (Alaska)
   answers {skipped: "stale"}: the next night covers a missed one. */

import { errText } from "../log.mjs";
import { JobError } from "./queue.mjs";
import { alaskaDate } from "./billing.mjs";
import { matchReceipts, purchaseWindow, addDays } from "./qbomatch.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MANUAL_IDS = 100;
const MAX_ERRORS = 20;
const PAGE = { receipts: 1000, links: 1000, jobLinks: 1000, jobs: 100 };
// receipt_qbo_links_note takes at most 1000 jobs and 5000 rows per call
const NOTE_MAX_JOBS = 500;
const NOTE_MAX_ROWS = 5000;
// A QuickBooks read pages through every expense and attachment in the
// window; an edge function stops by itself well before this.
const PROXY_TIMEOUT_MS = 150_000;
export const STORE_ACCOUNTS_KEY = "receipts.qbo_store_accounts";

const RECEIPT_COLS = "job_id,id,vendor,receipt_date,amount,category,paid_with,card_last4,receipt_no,photo_ref";
const LINK_COLS = "receipt_id,job_id,state,qbo_txn_type,qbo_txn_id,qbo_sync_token,qbo_customer_id,amount,receipt_date,detail";
const JOB_LINK_COLS = "job_id,qbo_customer_id,qbo_project_ref,qbo_name,source";
const JOB_COLS = "id,deleted,title:data->>title,address:data->>address,customer:data->>customer,qbJobcodeName:data->>qbJobcodeName";

const lc = (v) => String(v ?? "").trim().toLowerCase();
const validDate = (s) => {
  const t = DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
// a value inside a PostgREST or=(…) list: quoted, so a comma or a
// parenthesis in a receipt id cannot end the list early
const quoted = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Every page of a table, keyset-paged on one unique column until a page
    comes back empty (PostgREST caps a response without saying so). */
async function pagedBy(supa, table, query, key, size) {
  const out = [];
  for (let after = null; ;) {
    const rows = await supa.select(table,
      `${query}&order=${key}.asc&limit=${size}${after === null ? "" : `&${key}=gt.${encodeURIComponent(after)}`}`);
    if (!rows.length) return out;
    out.push(...rows);
    after = rows[rows.length - 1][key];
  }
}

/** Every live receipt. job_receipts' key is (job_id, id), so the pages
    follow both columns: an id alone is not promised unique. */
async function readReceipts(supa) {
  const out = [];
  for (let after = null; ;) {
    const next = after === null ? ""
      : `&or=${encodeURIComponent(`(job_id.gt.${after.job_id},and(job_id.eq.${after.job_id},id.gt.${quoted(after.id)}))`)}`;
    const rows = await supa.select("job_receipts",
      `select=${RECEIPT_COLS}&deleted_at=is.null&order=job_id.asc,id.asc&limit=${PAGE.receipts}${next}`);
    if (!rows.length) return out;
    out.push(...rows);
    after = rows[rows.length - 1];
  }
}

/** The jobs the receipts are on, 100 ids to a request (the URL stays
    short), each request paged too: a server cap trims a page silently. */
async function readJobs(supa, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += PAGE.jobs) {
    out.push(...await pagedBy(supa, "field_projects", `select=${JOB_COLS}&id=in.(${ids.slice(i, i + PAGE.jobs).join(",")})`, "id", PAGE.jobs));
  }
  return out;
}

async function readStoreAccounts(supa) {
  const rows = await supa.select("app_settings", `select=key,value&key=eq.${STORE_ACCOUNTS_KEY}`);
  return rows[0]?.value ?? null;
}

class ProxyMissing extends Error {}

/** One qbo-proxy action under the service key; its reply body. A 404 is an
    older qbo-proxy (Unknown action) or none at all. */
async function callProxy(ctx, action, body = {}) {
  const { cfg } = ctx;
  let res;
  try {
    res = await (ctx.fetch ?? globalThis.fetch)(cfg.qboProxyUrl, {
      method: "POST",
      headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action }),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`qbo-proxy ${action} unreachable: ${errText(e, 200)}`);
  }
  const data = await res.json().catch(() => null);
  const why = String(data?.error ?? data?.message ?? "no reason given").slice(0, 300);
  if (res.status === 404) throw new ProxyMissing(`qbo-proxy ${action}: ${why}`);
  if (!res.ok || data?.ok !== true) throw new Error(`qbo-proxy ${action} answered ${res.status}: ${why}`);
  return data;
}
// qbo-proxy answers {...result, ok, data: result}; either place will do
const listOf = (data, key) => (Array.isArray(data?.[key]) ? data[key] : Array.isArray(data?.data?.[key]) ? data.data[key] : null);

/** The run's payload → { manual, ids, runDate }, a stale skip, or a dead job. */
function readPayload(payload, today) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (p.job_ids !== undefined) {
    const ids = Array.isArray(p.job_ids) ? p.job_ids : [];
    if (!ids.length || ids.length > MAX_MANUAL_IDS || !ids.every((x) => typeof x === "string" && UUID_RE.test(x))) {
      throw new JobError(`receipts.qbo_match: job_ids must be 1 to ${MAX_MANUAL_IDS} field job ids (uuids)`, { permanent: true });
    }
    return { manual: true, ids: [...new Set(ids.map(lc))], runDate: today };
  }
  const runDate = typeof p.run_date === "string" ? p.run_date : "";
  if (!validDate(runDate)) {
    throw new JobError("receipts.qbo_match: the payload needs run_date (YYYY-MM-DD) or job_ids", { permanent: true });
  }
  if (runDate < addDays(today, -1)) return { stale: runDate };
  return { manual: false, ids: null, runDate };
}

/** receipt_qbo_links_note for every job in scope: one call, split only past
    the door's limits (by whole jobs, since it removes per job). */
async function writeNotes(supa, jobIds, notes) {
  const byJob = new Map(jobIds.map((id) => [id, []]));
  for (const n of notes) {
    if (!byJob.has(n.job_id)) byJob.set(n.job_id, []);
    byJob.get(n.job_id).push(n);
  }
  const total = { written: 0, kept: 0, removed: 0 };
  let ids = [], rows = [];
  const flush = async () => {
    if (!ids.length) return;
    const r = await supa.rpc("receipt_qbo_links_note", { p_job_ids: ids, p_rows: rows });
    for (const k of Object.keys(total)) total[k] += Number(r?.[k]) || 0;
    ids = [];
    rows = [];
  };
  for (const [id, rs] of byJob) {
    if (ids.length && (ids.length >= NOTE_MAX_JOBS || rows.length + rs.length > NOTE_MAX_ROWS)) await flush();
    ids.push(id);
    rows.push(...rs);
  }
  await flush();
  return total;
}

export async function receiptsQboMatch(ctx, job) {
  if (ctx.cfg.receiptsQbo === false) return { skipped: "off" };
  const today = alaskaDate(ctx.now?.() ?? new Date());
  const run = readPayload(job.payload, today);
  if (run.stale) return { skipped: "stale", run_date: run.stale };
  const { supa } = ctx;

  const receipts = await readReceipts(supa);
  const window = purchaseWindow(receipts, today);
  let projects = [];
  let purchases = [];
  if (window) {
    try {
      projects = listOf(await callProxy(ctx, "listProjects"), "projects");
      purchases = listOf(await callProxy(ctx, "listPurchases", window), "purchases");
    } catch (e) {
      if (!(e instanceof ProxyMissing)) throw e;
      ctx.log("receipts.proxy_not_updated", { run_date: run.runDate, error: errText(e, 300) });
      return { skipped: "qbo_proxy_not_updated", run_date: run.runDate };
    }
    if (!projects || !purchases) throw new Error("qbo-proxy answered without projects or purchases");
  }

  const links = await pagedBy(supa, "receipt_qbo_links", `select=${LINK_COLS}`, "receipt_id", PAGE.links);
  const jobLinks = new Map((await pagedBy(supa, "job_qbo_links", `select=${JOB_LINK_COLS}`, "job_id", PAGE.jobLinks))
    .map((l) => [lc(l.job_id), l]));
  const storeAccounts = await readStoreAccounts(supa);
  const receiptJobs = [...new Set(receipts.map((r) => lc(r.job_id)).filter((id) => UUID_RE.test(id)))].sort();
  const jobs = (await readJobs(supa, receiptJobs)).map((j) => ({
    id: lc(j.id), deleted: j.deleted === true, title: j.title ?? "", address: j.address ?? "", customer: j.customer ?? "",
    qbJobcodeName: j.qbJobcodeName ?? "", link: jobLinks.get(lc(j.id)) ?? null,
  }));

  const out = matchReceipts({ receipts, purchases, links, jobs, projects, storeAccounts, today, scope: run.manual ? run.ids : null });

  const summary = {
    run_date: run.runDate, receipts: out.stats.receipts, matched: out.stats.matched, in_qbo: out.stats.in_qbo,
    unmatched: out.stats.unmatched, conflicts: out.stats.conflicts, cards_filed: 0, skipped: {}, errors: [],
  };
  const skip = (reason, n = 1) => { if (n) summary.skipped[reason] = (summary.skipped[reason] ?? 0) + n; };
  // receipts the approval path holds: shown as they stand, never re-matched
  for (const [state, n] of Object.entries(out.stats.owned)) skip(state, n);

  // Every job whose rows may need writing or removing: the jobs with live
  // receipts and the jobs rows still name (a receipt gone from all of them).
  const noteJobs = run.manual ? run.ids
    : [...new Set([...receiptJobs, ...links.map((l) => lc(l.job_id)).filter((id) => UUID_RE.test(id))])].sort();
  const noted = noteJobs.length ? await writeNotes(supa, noteJobs, out.notes) : { written: 0, kept: 0, removed: 0 };

  // The door for every job the run looked at: its card, or no input, which
  // supersedes a card that has nothing left to do.
  const cards = new Map(out.cards.map((c) => [c.job_id, c]));
  for (const id of run.manual ? run.ids : out.stats.jobs) {
    // a deploy mid-run: give the job back; the retry re-files nothing that was filed
    if (ctx.stopping?.()) throw new Error("receipts.qbo_match: the worker is stopping; the queue runs this again");
    const card = cards.get(id);
    try {
      const res = await supa.rpc("receipts_qbo_link_file", {
        p_job_id: id,
        p_input: card ? card.input : null,
        p_rationale: card ? card.rationale : null,
        p_evidence_refs: card ? card.evidence_refs : null,
      });
      if (res?.filed === true) {
        summary.cards_filed += 1;
        ctx.log("receipts.filed", { job_id: id, proposal_id: res.proposal_id ?? null, items: card?.input.items.length ?? 0,
          superseded: Number(res.superseded) || 0 });
      } else if (res?.filed === false && res.proposal_id) {
        skip("unchanged");      // the same card is still open, or was answered
      } else if (typeof res?.skipped === "string") {
        skip(res.skipped);
      } else {
        throw new Error(`receipts_qbo_link_file answered ${JSON.stringify(res) ?? "nothing"}`.slice(0, 300));
      }
    } catch (e) {
      const message = errText(e, 300);
      ctx.log("receipts.job_failed", { job_id: id, error: message });
      if (summary.errors.length < MAX_ERRORS) summary.errors.push({ job_id: id, message });
    }
  }

  ctx.log("receipts.run", {
    run_date: summary.run_date, manual: run.manual, receipts: summary.receipts, matched: summary.matched,
    in_qbo: summary.in_qbo, unmatched: summary.unmatched, conflicts: summary.conflicts, cards: out.cards.length,
    cards_filed: summary.cards_filed, purchases: purchases.length, notes_written: noted.written,
    notes_removed: noted.removed, errors: summary.errors.length,
  });
  return summary;
}
