/* The packet.build queue kind — the carrier packet (migration 0026,
   docs/Carrier_Packet_Design.md §10-§13).

   pg_cron enqueues one run an Alaska hour. A run looks at the jobs
   carrier_packet_candidates lists, one after another, each in its own
   try/catch so one job's trouble never stops the next:

     read      the job blob (field_projects), and the customer's portal
               approval of the Certificate of Drying when the job has a
               portal (a signature on its way holds the packet, §4)
     gate      packetGate (packet/model.mjs). A "no" for a job that left
               scope withdraws its open card, so a voided invoice or a
               cleared certificate never leaves an approvable PDF; a "no"
               the owner can fix (no numbered invoice, readings to check)
               also records a hold with one heads-up text per job and reason
     model     buildModel, keeping the photo numbers the job's last row used,
               then its hash, the media budget (full or compact photos, from
               the stored sizes, before anything is downloaded) and the
               storage cap
     reserve   carrier_packet_reserve decides: skip, re-offer the PDF already
               stored for this same model, or build a new one
     build     download the media (PACKET_DOWNLOADS at a time), render,
               refuse a PDF too large to email, upload it, pick the To,
               sign a 15-day link and file the card through
               carrier_packet_file; then the "ready" text
     reoffer   the stored PDF on a fresh card through carrier_packet_reoffer

   and after the jobs, the PDF cleanup: the rows nobody can send any more
   lose their stored PDF.

   The storage cap is checked before the reserve, not after: a reserve that
   finds no room has to fail its row, and a failure counts as one of the
   model's three tries, so a full bucket would end up holding every job as
   "couldn't be built" long after it was emptied.

   Builds are capped at PACKET_MAX_BUILDS a run; once the cap is reached no
   further job is reserved this run (a reserve that answered "build" and was
   never built would sit as building until it is marked abandoned, which is
   a try). Re-offers do not count.

   Any error after a reserve answered "build" fails that row
   (carrier_packet_fail; permanent for a PDF too large to email and for what
   can never render), and when that spends the model's tries the job is
   held with a text. The uploaded PDF is deleted whenever the row is known
   not to have been filed.

   Texts go to OWNER_CELL through roybal-notify (sendSms, kind brief, as the
   dead-letter text does); PACKET_TEXTS=off silences them. A text that fails
   is logged, never thrown, and a hold is marked texted only once its text
   went, so the next run tries again.

   The run's result and its log lines carry job ids, packet ids, numbers and
   counts only: never a name, an address, a claim number or an email.

   CARRIER_PACKET=off (cfg.carrierPacket false) answers {skipped: "off"}
   without reading anything; a run more than 2 hours after its run_after
   answers {skipped: "stale"} (the next hour covers it); without the
   'packet' channel nothing could send a card, {skipped: "lane_off"}.

   ctx.packetDeps replaces the model, recipient, renderer and storage
   modules in tests; otherwise they are loaded on first use, so this file
   loads even where they cannot. */

import { createHash } from "node:crypto";
import { errText, redact } from "../log.mjs";
import { alaskaDate } from "./billing.mjs";

const BUCKET = "carrier-packets";
const MEDIA_BUCKET = "field-media";
const BUCKET_OPTS = { public: false, fileSizeLimit: 26_214_400, allowedMimeTypes: ["application/pdf"] };
// the lane-wide hold (storage full) is filed under the nil uuid
const LANE_HOLD = "00000000-0000-0000-0000-000000000000";
const STALE_MS = 2 * 3600_000;
const SIGN_PENDING_MS = 72 * 3600_000;
const LINK_SECONDS = 15 * 86_400;
const CANDIDATE_LIMIT = 200;
const CLEANUP_LIMIT = 20;
const INBOUND_LIMIT = 50;
// carrier_packet_media_sizes takes at most 5000 names a call
const SIZE_NAMES = 1000;
const TEXT_TIMEOUT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
// a stored packet PDF: <job id>/<name>.pdf, never anything else
const PDF_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]{1,200}\.pdf$/i;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const inSet = (s, v) => (typeof s?.has === "function" ? s.has(v) : Array.isArray(s) && s.includes(v));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mb = (bytes) => `${(Number(bytes) / 1_048_576).toFixed(1)} MB`;
// a skip reason as a result key: a short word, whatever the answer held
const reasonKey = (r) => String(r ?? "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "unknown";

/* Data that can never render: the same inputs fail the same way every
   try, so the row is failed permanent instead of spending three hours. */
const badData = (message) => Object.assign(new Error(message), { permanent: true });
const isBadData = (e) => e?.permanent === true || e?.code === "22023";   // invalid_parameter_value from a door

let loaded = null;
/** The packet modules, imported once; a failed import is tried again next run. */
function loadDeps() {
  loaded ??= Promise.all([
    import("../packet/model.mjs"),
    import("../packet/recipient.mjs"),
    import("../packet/render.mjs"),
    import("../storage.mjs"),
  ]).then(([model, recipient, render, storage]) => ({
    ...model,
    pickRecipient: recipient.pickRecipient,
    renderPacket: render.renderPacket,
    makeStorage: storage.makeStorage,
  })).catch((e) => { loaded = null; throw e; });
  return loaded;
}

/** The customer's portal signature on the Certificate of Drying is on its
    way (§4): the approval is pending with a document, or approved while the
    blob has not had the signature copied back yet. Only for 72 hours from
    the approval's updatedAt, so a customer who never signs cannot hold the
    packet forever. */
export function certSignPending(approvals, cert, now) {
  const a = arr(approvals).find((x) => isObj(x) && x.id === "certDrying");
  if (!a) return false;
  const at = Date.parse(String(a.updatedAt ?? ""));
  if (!Number.isFinite(at) || now.getTime() - at >= SIGN_PENDING_MS) return false;
  if (a.status === "pending") return isObj(a.doc) && !!a.doc.html;
  if (a.status === "approved") {
    const c = isObj(cert) ? cert : {};
    return !c.sigOwner && !c.portalSignedAt;
  }
  return false;
}

/** A stored media text → image bytes; null for nothing, or for a data URL
    that is not an image (an uploaded PDF page counts as missing). */
export function imageBytes(text) {
  const s = typeof text === "string" ? text : "";
  const m = IMAGE_URL.exec(s);
  if (!m) return null;
  const buf = Buffer.from(s.slice(m[0].length), "base64");
  return buf.length ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
}

export async function packetBuild(ctx, job) {
  const { cfg } = ctx;
  if (cfg.carrierPacket === false) return { skipped: "off" };
  const now = ctx.now?.() ?? new Date();
  const queuedAt = Date.parse(String(job?.run_after ?? job?.created_at ?? ""));
  if (Number.isFinite(queuedAt) && now.getTime() - queuedAt > STALE_MS) return { skipped: "stale" };
  if (!arr(cfg.channels).includes("packet")) return { skipped: "lane_off" };

  const deps = ctx.packetDeps ?? await loadDeps();
  const storage = deps.makeStorage({ supabaseUrl: cfg.supabaseUrl, serviceKey: cfg.serviceKey, fetchImpl: ctx.fetch });
  try {
    await storage.ensureBucket(BUCKET, BUCKET_OPTS);
  } catch (e) {
    ctx.log("packet.bucket_missing", { error: errText(e, 300) });
    return { skipped: "bucket_missing" };
  }

  const today = alaskaDate(now);
  const summary = { seen: 0, in_scope: 0, built: 0, reoffered: 0, withdrawn: 0, held: 0, skipped: {}, failed: [] };
  const run = {
    ctx, cfg, deps, storage, now, today, year: Number(today.slice(0, 4)), summary,
    builds: 0, storageUsed: null, storageFull: false,
    skip: (reason) => { const k = reasonKey(reason); summary.skipped[k] = (summary.skipped[k] ?? 0) + 1; },
  };

  const rows = await ctx.supa.rpc("carrier_packet_candidates", {
    p_lookback_days: cfg.packetLookbackDays, p_limit: CANDIDATE_LIMIT,
  });
  const candidates = arr(rows).filter(isObj);
  summary.seen = candidates.length;

  for (const cand of candidates) {
    // a deploy mid-run: give the run back; every door is safe to call again
    if (ctx.stopping?.()) throw new Error("packet.build: the worker is stopping; the queue runs this again");
    const id = String(cand.job_id ?? "");
    try {
      await packetOne(run, cand, id);
    } catch (e) {
      ctx.log("packet.job_failed", { job_id: id, error: redact(errText(e, 300)) });
      if (!summary.failed.includes(id)) summary.failed.push(id);
    }
  }

  await cleanup(run);
  ctx.log("packet.run", {
    seen: summary.seen, in_scope: summary.in_scope, built: summary.built, reoffered: summary.reoffered,
    withdrawn: summary.withdrawn, held: summary.held, skipped: summary.skipped, failed: summary.failed.length,
  });
  return summary;
}

async function packetOne(run, cand, id) {
  const { ctx, cfg, deps, summary } = run;
  if (!UUID_RE.test(id)) throw new Error("a candidate with no job id");
  const rows = await ctx.supa.select("field_projects", `select=id,data,deleted,updated_at&id=eq.${id}`);
  const row = rows[0] ?? null;
  const project = row && isObj(row.data) ? { ...row.data, id: row.id ?? id } : null;

  let gate;
  if (!project) {
    // the row is gone: whatever card it had must not stay approvable
    gate = { ok: false, reason: "deleted", detail: "the job is gone" };
  } else {
    gate = deps.packetGate(project, {
      today: run.today,
      now: run.now,
      lookbackDays: cfg.packetLookbackDays,
      settleMin: cfg.packetSettleMin,
      updatedAt: row.updated_at,
      deleted: row.deleted === true,
      hasRow: cand.has_row === true,
      certSignPending: await signaturePending(ctx, project, run.now),
    });
  }
  if (!gate?.ok) return gateNo(run, cand, id, project, gate);
  summary.in_scope += 1;

  const state = await ctx.supa.rpc("carrier_packet_state", { p_job_id: id });
  const model = deps.buildModel(project, {
    today: run.today, now: run.now, prevPhotoNums: isObj(state?.photo_nums) ? state.photo_nums : null,
  });
  const hash = deps.modelHash(model);
  const sections = deps.sectionHashes(model);

  // Past the build cap, or with no room for this estimate, the reserve may
  // still answer a skip or a re-offer (neither needs room); it only may not
  // build. So a job that would not build never holds the lane.
  const plan = await planFor(run, model);
  const capped = run.builds >= (cfg.packetMaxBuilds ?? 3);
  const room = !capped && !run.storageFull && (await storageRoom(run, plan.estimateBytes));

  const r = await ctx.supa.rpc("carrier_packet_reserve", {
    p_job_id: id,
    p_model_hash: hash,
    p_section_hashes: sections,
    p_photo_nums: isObj(model.photoNums) ? model.photoNums : {},
    p_meta: metaOf(model, gate),
    p_year: run.year,
    p_build: room,
  });
  const job = { id, project, state, model, hash, sections, plan };
  if (r?.action === "build") {
    run.builds += 1;
    return build(run, job, r);
  }
  if (r?.action === "reoffer") return reoffer(run, job, r);
  if (r?.action === "skip") {
    if (r.reason === "no_build") {
      if (capped) return run.skip("max_builds");
      // the first job this run that needs a build and has no room holds
      // the lane; nothing more is built this run
      if (!run.storageFull) await storageFullHold(run);
      return run.skip("storage_full");
    }
    // Every run re-reads these, so a text that failed, or was off, goes on
    // the next run, and a cap the reserve itself reached (a third build
    // abandoned mid-run) is heard of too. The hold texts once per reason.
    if (r.reason === "failed_cap") {
      const detail = String(r.error ?? "").slice(0, 200) || "3 tries";
      const opts = { permanent: r.permanent === true };
      await hold(run, id, "failed_cap", detail, () => deps.holdText("failed_cap", model, detail, opts));
    } else if (r.reason === "too_large") {
      const detail = String(r.error ?? "").replace(/^too_large:\s*/, "").slice(0, 200);
      await hold(run, id, "too_large", detail, () => deps.holdText("too_large", model, detail));
    }
    return run.skip(r.reason || "skip");
  }
  throw new Error(`carrier_packet_reserve answered ${JSON.stringify(r) ?? "nothing"}`.slice(0, 300));
}

async function signaturePending(ctx, project, now) {
  const portalId = String(project.portalShare?.id ?? "").trim();
  // portal_jobs.id is a uuid: anything else would be a 400, not "no portal"
  if (!UUID_RE.test(portalId) || !isObj(project.certDrying)) return false;
  const rows = await ctx.supa.select("portal_jobs", `id=eq.${portalId}&select=approvals`);
  return certSignPending(rows[0]?.approvals, project.certDrying, now);
}

async function gateNo(run, cand, id, project, gate) {
  const { ctx, deps, summary } = run;
  const reason = String(gate?.reason || "out_of_scope");
  run.skip(reason);
  if (inSet(deps.WITHDRAW_REASONS, reason) && cand.open_row === true) {
    const out = await ctx.supa.rpc("carrier_packet_withdraw", { p_job_id: id, p_reason: reason });
    if (out?.withdrawn === true) {
      summary.withdrawn += 1;
      ctx.log("packet.withdrawn", { job_id: id, reason });
    }
  }
  if (inSet(deps.HOLD_REASONS, reason)) {
    await hold(run, id, reason, gate.detail, () => deps.holdText(reason, project, gate.detail));
  }
}

/* A hold, and its heads-up text when this job has not been told about
   this reason yet; texted only once the text went. */
async function hold(run, jobId, reason, detail, words) {
  const { ctx, summary } = run;
  const d = detail == null ? "" : String(detail).slice(0, 500);
  const out = await ctx.supa.rpc("carrier_packet_hold", { p_job_id: jobId, p_reason: reason, p_detail: d || null });
  summary.held += 1;
  ctx.log("packet.held", { job_id: jobId, reason });
  if (out?.text_due !== true) return;
  if (await sendText(run, words(), jobId)) {
    await ctx.supa.rpc("carrier_packet_hold_texted", { p_job_id: jobId, p_reason: reason });
  }
}

/** One text to the owner; true when roybal-notify took it. Never throws. */
async function sendText(run, body, jobId) {
  const { ctx, cfg } = run;
  if (!cfg.ownerCell || cfg.packetTexts === false) return false;
  try {
    const res = await (ctx.fetch ?? globalThis.fetch)(cfg.notifyUrl, {
      method: "POST",
      headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sendSms", to: cfg.ownerCell, kind: "brief", captured_by: "worker-packet", body }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) {
      ctx.log("packet.text_failed", { job_id: jobId, error: redact(data?.error ?? res.status) });
      return false;
    }
    return true;
  } catch (e) {
    ctx.log("packet.text_failed", { job_id: jobId, error: redact(errText(e)) });
    return false;
  }
}

/* The media budget (§10): every image's stored size, then planMedia picks
   full or compact and names the one copy of each image to download. */
async function planFor(run, model) {
  const { ctx, cfg, deps } = run;
  const names = arr(deps.mediaNames(model));
  const sizes = new Map();
  for (let i = 0; i < names.length; i += SIZE_NAMES) {
    const rows = await ctx.supa.rpc("carrier_packet_media_sizes", { p_names: names.slice(i, i + SIZE_NAMES) });
    for (const r of arr(rows)) {
      const n = Number(r?.bytes);
      if (r?.name != null && r.bytes != null && Number.isFinite(n)) sizes.set(String(r.name), n);
    }
  }
  const plan = deps.planMedia(model, sizes, { fullKb: cfg.packetFullKb });
  const load = arr(plan?.load);
  return {
    mode: plan?.mode === "compact" ? "compact" : "full",
    estimateBytes: Number(plan?.estimateBytes) || 0,
    load,
    // stored images the bucket does not list: they print "Image not available"
    absent: load.filter((x) => isObj(x?.source) && typeof x.source.hash === "string" && !sizes.has(x.source.hash)).length,
  };
}

/* The storage cap: whether what the bucket holds plus this estimate fits.
   Read once a run; each build adds its PDF. */
async function storageRoom(run, estimate) {
  const { ctx, cfg } = run;
  if (run.storageUsed == null) run.storageUsed = Number(await ctx.supa.rpc("carrier_packet_storage_bytes", {})) || 0;
  return run.storageUsed + estimate <= (cfg.packetStorageMb ?? 300) * 1_048_576;
}

/* A build with no room: the lane is held once (nil uuid) and nothing more
   is built this run. */
async function storageFullHold(run) {
  const { cfg, deps } = run;
  run.storageFull = true;
  const detail = `${mb(run.storageUsed ?? 0)} of ${cfg.packetStorageMb ?? 300} MB used`;
  await hold(run, LANE_HOLD, "storage_full", detail, () => deps.holdText("storage_full", null, detail));
}

/* what the card shows beside the packet, kept on the row */
function metaOf(model, gate) {
  return {
    counts: isObj(model.counts) ? model.counts : {},
    missing: Number(model.missing) || 0,
    units_out: arr(model.unitsOut).slice(0, 50),
    hard_gaps: arr(model.hardGaps).slice(0, 50),
    anchor: gate?.anchor ?? null,
  };
}

/* The label the PDF, the email and the card are written with: number,
   version, the sent version this one replaces and what changed since. */
function labelFor(run, job, r, mode) {
  const rep = isObj(r.replaces) ? r.replaces : null;
  const changed = rep && isObj(rep.section_hashes)
    ? arr(run.deps.changedSections(rep.section_hashes, job.sections, job.model)) : [];
  return {
    number: r.number, version: r.version,
    replaces: rep ? { version: rep.version, sentAt: rep.sent_at } : null,
    changed, built: run.now, mode, hash: job.hash,
  };
}

/* Every image the plan names, at most PACKET_DOWNLOADS at a time. A
   missing object prints "Image not available"; an outage fails the build,
   and only once every download in flight has settled. */
async function loadImages(run, load) {
  const { cfg, storage } = run;
  const items = load.filter((x) => isObj(x) && x.key != null);
  const images = new Map();
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const item = items[next++];
      try {
        const src = isObj(item.source) ? item.source : {};
        let bytes = null;
        if (typeof src.inline === "string") bytes = imageBytes(src.inline);
        else if (typeof src.hash === "string" && src.hash) bytes = imageBytes(await storage.getText(MEDIA_BUCKET, src.hash));
        images.set(String(item.key), bytes);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  const width = Math.max(1, Math.min(Number(cfg.packetDownloads) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw failure;
  return images;
}

/* Upload with x-upsert false. A 409 means an earlier try of this same row
   stored it (the path names the row): the same bytes are kept, anything
   else is replaced, since that row was never filed. */
async function upload(run, path, bytes, digest) {
  const { storage } = run;
  const put = async () => {
    try {
      await storage.put(BUCKET, path, bytes, "application/pdf");
      return true;
    } catch (e) {
      if (e?.status === 409) return false;
      if (e?.status === 400 || e?.status === 413 || e?.status === 415) throw badData(`upload refused: ${errText(e, 300)}`);
      throw e;
    }
  };
  if (await put()) return "stored";
  const there = await storage.getBytes(BUCKET, path);
  if (there && sha256(there) === digest) return "reused";
  await storage.remove(BUCKET, [path]);
  if (await put()) return "replaced";
  throw new Error("the packet PDF's path is taken and could not be replaced");
}

/* The suggested To (§12): the address the last sent version went to, else
   the job's inbound email, else its Adjuster field. Only the connected
   account's address is read from gmail_tokens, never a token. */
async function recipientFor(run, job) {
  const { ctx, deps } = run;
  const emails = await ctx.supa.select("email_messages",
    `select=from_addr,matched_by,received_at,direction&job_id=eq.${job.id}&direction=eq.in&order=received_at.desc&limit=${INBOUND_LIMIT}`);
  const tokens = await ctx.supa.select("gmail_tokens", "select=account&order=created_at.desc&limit=1");
  const picked = deps.pickRecipient({
    project: job.project,
    emails,
    account: String(tokens[0]?.account ?? ""),
    lastSentTo: job.state?.last_sent?.sent_to ?? "",
  });
  return { to: String(picked?.to ?? ""), source: String(picked?.source ?? "") };
}

/* the card's input (never a To: the owner confirms it on the card) and its Why */
function wordsFor(run, job, label, recipient, facts) {
  const { deps } = run;
  const email = deps.emailText(job.model, label);
  // the renderer's own count when there is one (it already holds the model's
  // missing images and the empty downloads); a re-offer has only those two
  const missing = Number.isSafeInteger(facts.unavailable) ? facts.unavailable
    : (Number(job.model.missing) || 0) + (Number(facts.lost) || 0);
  const rationale = deps.rationaleText(job.model, label, {
    recipient, bytes: facts.bytes, pages: facts.pages, mode: facts.mode, missing, changed: label.changed,
  });
  return {
    input: {
      subject: email.subject, body: email.body, filename: email.filename,
      suggested_to: recipient.to, suggested_from: deps.suggestedFrom(recipient.source, label),
    },
    rationale,
  };
}

async function linkTo(run, path) {
  const url = await run.storage.sign(BUCKET, path, LINK_SECONDS);
  if (!url) throw new Error("the packet PDF is not in storage");
  return url;
}

async function build(run, job, r) {
  const { ctx, cfg, deps, summary } = run;
  const { id, model, plan } = job;
  const path = `${id}/${r.number}-v${r.version}-b${r.seq}.pdf`;
  const label = labelFor(run, job, r, plan.mode);
  let uploaded = false;
  try {
    const images = await loadImages(run, plan.load);
    let pdf;
    try {
      pdf = deps.renderPacket(model, { label, mode: plan.mode, images, now: run.now });
    } catch (e) {
      throw badData(`render: ${errText(e, 300)}`);
    }
    const bytes = pdf?.bytes?.byteLength ?? 0;
    if (!bytes) throw badData("render: no PDF bytes");

    if (bytes > (cfg.packetHardKb ?? 17000) * 1024) {
      // too large to email even compact: never uploaded, never tried again
      const size = mb(bytes);
      await ctx.supa.rpc("carrier_packet_fail", {
        p_packet_id: r.packet_id, p_build_token: r.build_token, p_error: `too_large: ${size}`, p_permanent: true,
      });
      run.skip("too_large");
      ctx.log("packet.too_large", { job_id: id, packet_id: r.packet_id, bytes, mode: plan.mode });
      await hold(run, id, "too_large", size, () => deps.holdText("too_large", model, size));
      return;
    }

    // the digest the email adapter checks the download against, taken here
    // from the bytes themselves
    const digest = sha256(pdf.bytes);
    await upload(run, path, pdf.bytes, digest);
    uploaded = true;
    run.storageUsed = (run.storageUsed ?? 0) + bytes;

    const recipient = await recipientFor(run, job);
    // the card says how many images print "Image not available": the
    // renderer's count (one that did not load, or would not embed: a HEIC, a
    // TIFF); `lost`, the downloads that came back empty, is only the fallback
    // for a renderer that does not count
    const lost = plan.load.filter((x) => isObj(x) && x.key != null && images.get(String(x.key)) == null).length;
    const words = wordsFor(run, job, label, recipient, { bytes, pages: pdf.pages, mode: plan.mode, lost, unavailable: pdf.unavailable });
    const url = await linkTo(run, path);
    const out = await ctx.supa.rpc("carrier_packet_file", {
      p_packet_id: r.packet_id,
      p_build_token: r.build_token,
      p_pdf: { bucket: BUCKET, path, sha256: digest, bytes, pages: pdf.pages, mode: plan.mode },
      p_input: words.input,
      p_rationale: words.rationale,
      p_evidence_refs: [{ kind: "pdf", label: "Open the PDF", url }],
    });
    if (out?.status === "filed") {
      summary.built += 1;
      ctx.log("packet.filed", {
        job_id: id, packet_id: r.packet_id, proposal_id: out.proposal_id ?? null, number: r.number,
        version: r.version, seq: r.seq, pages: pdf.pages, bytes, mode: plan.mode,
      });
      await sendText(run, deps.readyText(model, label), id);
      await removeQuietly(run, out.superseded);
      return;
    }
    if (out?.status === "relabel" || out?.status === "lost") {
      // never filed: the label moved while it was built, or the row moved on
      run.skip(out.status);
      ctx.log("packet.not_filed", { job_id: id, packet_id: r.packet_id, status: out.status });
      await removeQuietly(run, [{ bucket: BUCKET, path }]);
      return;
    }
    throw new Error(`carrier_packet_file answered ${JSON.stringify(out) ?? "nothing"}`.slice(0, 300));
  } catch (e) {
    let failed = null;
    try {
      failed = await ctx.supa.rpc("carrier_packet_fail", {
        p_packet_id: r.packet_id, p_build_token: r.build_token, p_error: errText(e, 500), p_permanent: isBadData(e),
      });
    } catch (e2) {
      // the row stays building and is marked abandoned in 30 minutes
      ctx.log("packet.fail_failed", { job_id: id, packet_id: r.packet_id, error: errText(e2, 300) });
    }
    // Only a row this call failed is sure never to have been filed; one
    // that moved on may be a filed card whose PDF must stay.
    if (uploaded && failed?.status === "failed") await removeQuietly(run, [{ bucket: BUCKET, path }]);
    if (failed?.capped === true) {
      const detail = errText(e, 200);
      const opts = { permanent: isBadData(e) };
      await hold(run, id, "failed_cap", detail, () => deps.holdText("failed_cap", model, detail, opts));
    }
    throw e;
  }
}

async function reoffer(run, job, r) {
  const { ctx, deps, summary } = run;
  const { id, model } = job;
  const mode = r.mode === "compact" ? "compact" : "full";
  const label = labelFor(run, job, r, mode);
  const recipient = await recipientFor(run, job);
  const words = wordsFor(run, job, label, recipient, {
    bytes: Number(r.bytes) || 0, pages: Number(r.pages) || 0, mode, lost: Number(job.plan?.absent) || 0,
  });
  const url = await linkTo(run, String(r.path ?? ""));
  const out = await ctx.supa.rpc("carrier_packet_reoffer", {
    p_packet_id: r.packet_id,
    p_input: words.input,
    p_rationale: words.rationale,
    p_evidence_refs: [{ kind: "pdf", label: "Open the PDF", url }],
  });
  if (out?.status === "filed") {
    summary.reoffered += 1;
    ctx.log("packet.reoffered", {
      job_id: id, packet_id: r.packet_id, proposal_id: out.proposal_id ?? null, number: r.number,
      version: r.version, offer: out.offer ?? null,
    });
    await sendText(run, deps.readyText(model, label), id);
    return;
  }
  if (out?.status === "lost") return run.skip("lost");
  throw new Error(`carrier_packet_reoffer answered ${JSON.stringify(out) ?? "nothing"}`.slice(0, 300));
}

/* Packet PDFs, grouped by bucket. Only carrier-packets objects under a job
   folder are ever deleted here, whatever a row says. */
function packetObjects(list) {
  const out = [];
  for (const x of arr(list)) {
    if (isObj(x) && x.bucket === BUCKET && typeof x.path === "string" && PDF_PATH.test(x.path)) out.push(x);
  }
  return out;
}

/* PDFs nobody will send: deleted now if Storage answers, else left to the
   cleanup, which finds them again from their rows. */
async function removeQuietly(run, list) {
  const paths = packetObjects(list).map((x) => x.path);
  if (!paths.length) return;
  try {
    await run.storage.remove(BUCKET, paths);
  } catch (e) {
    run.ctx.log("packet.remove_failed", { count: paths.length, error: errText(e, 300) });
  }
}

async function cleanup(run) {
  const { ctx, storage } = run;
  try {
    const rows = packetObjects(await ctx.supa.rpc("carrier_packet_pdfs_to_remove", { p_limit: CLEANUP_LIMIT }))
      .filter((x) => UUID_RE.test(String(x.id ?? "")));
    if (!rows.length) return;
    await storage.remove(BUCKET, rows.map((x) => x.path));
    const stamped = await ctx.supa.rpc("carrier_packet_pdfs_removed", { p_ids: rows.map((x) => x.id) });
    ctx.log("packet.cleanup", { removed: rows.length, stamped: Number(stamped) || 0 });
  } catch (e) {
    ctx.log("packet.cleanup_failed", { error: errText(e, 300) });
  }
}
