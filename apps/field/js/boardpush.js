/* ============================================================
   Roybal Field Forms — Job Board bridge (Phase 5)
   ------------------------------------------------------------
   The field app PROPOSES a plan; the Board SCHEDULES it.

   Ownership rule (keeps the two apps from fighting):
     field owns  — scope, phase-hour proposals, actuals (daily logs)
     board owns  — dates, crew assignments, dependencies, stage

   Pure mapping/matching functions live up top (Node-tested); the
   network calls below use the same Supabase REST + rev-guard
   idiom as the Board's own data layer (apps/board/js/data.js):
   a job save only lands when the server is still on the rev the
   write started from — a stale copy can never clobber newer edits.
   ============================================================ */
import { uid, Store } from "./core.js";
import { rest, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";
import { matchCoordinationId, normClaim } from "./spine.js";
import { jobType, TRADES, newProject } from "./model.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const norm = (s) => String(s || "").trim().toLowerCase();

/* The model promises an ISO date for notBefore, but nothing enforces prose
   like "next Tuesday" — garbage here would reach the Board's date math. */
export const isoDateOnly = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");

/* jsonb does not preserve key order — compare canonically or the
   "unchanged" check loops forever once two phases have hours. */
const sortedJson = (obj) => JSON.stringify(
  Object.keys(obj || {}).sort().reduce((o, k) => ((o[k] = obj[k]), o), {}));

/* ---------- pure: AI draft -> board-shaped phases ---------- */
/* The Board's subtask shape (apps/board/js/board.js):
   { id, name, durationDays, estimatedHours, lagDays, crewIds }
   durationDays stays null so the Board computes it from hours ÷ crew;
   crewIds stay empty — crew is the coordinator's call. */
export function planPhases(draft) {
  return arr(draft && draft.phases)
    .filter((p) => norm(p.name))
    .map((p) => ({
      name: String(p.name).trim(),
      estimatedHours: Number(p.estimatedHours) > 0 ? Number(p.estimatedHours) : "",
      lagDays: Math.max(0, Math.round(Number(p.lagDays) || 0)),
      // review-UI hint only — toSubtasks never sends it to the board
      confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : undefined,
    }));
}

const toSubtasks = (phases) => arr(phases).map((p) => ({
  id: uid(), name: p.name, durationDays: null,
  estimatedHours: p.estimatedHours, lagDays: p.lagDays || 0, crewIds: [],
}));

/* constructionType -> board job type; water jobs get the board's own
   "Water Mitigation" column color instead of masquerading as a remodel */
const BOARD_TYPE = { remodel: "remodel", new_construction: "new_build", reconstruction: "restoration" };
const boardTypeFor = (project) =>
  jobType(project) === "construction" ? (BOARD_TYPE[project.constructionType] || "remodel") : "water";

/* ---------- pure: build a brand-new board job from a field project ---------- */
export function boardJobFromProject(project, plan, nowISO) {
  const phases = arr(plan && plan.phases);
  return {
    id: uid(),
    stage: project.startDate ? "scheduled" : "lead",
    type: boardTypeFor(project),
    priority: "normal", materials: "none",
    crewIds: [],
    title: project.customer || project.address || "Job",
    customer: project.customer || "",
    address: project.address || "",
    phone: project.phone || "",
    claimNo: project.claimNo || "",           // lets the spine's claim matching find it
    startDate: "", targetDate: "",            // the Board's scheduler owns dates
    estimatedHours: phases.reduce((t, p) => t + (Number(p.estimatedHours) || 0), 0) || "",
    contractValue: Number(project.contractAmount) || "",
    billedToDate: "",
    deps: [], durationDays: null, scheduleMode: "auto", pinnedStart: "",
    notBefore: isoDateOnly(plan && plan.notBefore),
    notBeforeLabel: isoDateOnly(plan && plan.notBefore) ? (plan.notBeforeLabel || "") : "",
    notes: "Pushed from the field app" + (project.workOrderNo ? " — WO " + project.workOrderNo : ""),
    fieldJobId: project.id,
    subtasks: toSubtasks(phases),
    isMilestone: false,
    createdAt: nowISO, updatedAt: nowISO,
    rev: 0,
  };
}

/* ---------- pure: merge a plan into an EXISTING board job ----------
   Never clobbers the coordinator's territory (dates, crew, deps, stage,
   scheduleMode). If the board job already has meaningful phases, the plan
   becomes data.fieldPlanProposal for the Board to reconcile; otherwise the
   phases land directly. Returns { data, mode: "direct" | "proposal" }. */
export function mergePlanIntoBoardJob(existing, project, plan, nowISO) {
  const data = { ...existing, fieldJobId: project.id };
  const hasPhases = arr(existing.subtasks).some((st) => norm(st.name));
  const phases = arr(plan && plan.phases);
  if (!data.contractValue && Number(project.contractAmount)) data.contractValue = Number(project.contractAmount);
  if (!data.notBefore && plan && isoDateOnly(plan.notBefore)) {
    data.notBefore = isoDateOnly(plan.notBefore);
    data.notBeforeLabel = plan.notBeforeLabel || "";
  }
  if (hasPhases) {
    data.fieldPlanProposal = {
      phases, assumptions: arr(plan && plan.assumptions),
      notBefore: (plan && plan.notBefore) || "", notBeforeLabel: (plan && plan.notBeforeLabel) || "",
      from: project.id, at: nowISO,
    };
    return { data, mode: "proposal" };
  }
  data.subtasks = toSubtasks(phases);
  if (!data.estimatedHours) data.estimatedHours = phases.reduce((t, p) => t + (Number(p.estimatedHours) || 0), 0) || "";
  delete data.fieldPlanProposal;
  return { data, mode: "direct" };
}

/* ---------- pure: daily-log hours rolled up per phase name ----------
   Simple contains-match either way ("Drywall" phase ↔ "hang drywall" task);
   good enough for a progress readout, cheap enough to run at sync time. */
export function rollupActuals(project, phaseNames) {
  const out = {};
  const names = arr(phaseNames).filter(Boolean).map((n) => ({ raw: n, n: norm(n) })).filter((x) => x.n);
  if (!names.length) return out;
  const add = (task, hours) => {
    if (!task || !hours) return;
    const hit = names.find((x) => task.includes(x.n) || x.n.includes(task));
    if (hit) out[hit.raw] = Math.round(((out[hit.raw] || 0) + hours) * 100) / 100;
  };
  // legacy per-day work-log rows (the Field Report no longer collects them)
  for (const log of arr(project && project.constructionLogs)) {
    for (const row of arr(log.rows)) add(norm(row.task), parseFloat(row.hours) || 0);
  }
  // the living source: QuickBooks Time hours from the Labor Log
  for (const e of arr(project && project.laborLog && project.laborLog.entries)) {
    add(norm(e.note || e.task || e.service), parseFloat(e.hours) || 0);
  }
  return out;
}

/* ---------- pure: estimate-calibration digest ----------
   From finished board jobs that carry fieldActuals: how estimates compared
   to reality, per phase name. Compact (≲1k tokens) — feeds the next
   timeline estimate so it improves over time. */
export function historyDigest(boardRows) {
  const byName = new Map();
  for (const row of arr(boardRows)) {
    const d = row && row.data;
    if (!d || d.stage !== "done" || !d.fieldActuals) continue;
    for (const st of arr(d.subtasks)) {
      const est = Number(st.estimatedHours) || 0;
      const act = Number(d.fieldActuals[st.name]) || 0;
      if (!est || !act || !norm(st.name)) continue;
      const key = norm(st.name);
      if (!byName.has(key)) byName.set(key, { name: st.name, est: 0, act: 0, jobs: 0 });
      const g = byName.get(key);
      g.est += est; g.act += act; g.jobs += 1;
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.jobs - a.jobs)
    .slice(0, 20)
    .map((g) => ({ phase: g.name, jobs: g.jobs, estHours: Math.round(g.est), actualHours: Math.round(g.act),
      ratio: Math.round((g.act / g.est) * 100) / 100 }));
}

/* ---------- pure: board phases -> sub-schedule prefill rows ---------- */
export function phasesToSubRows(subtasks, blankFn) {
  return arr(subtasks).filter((st) => norm(st.name)).map((st) => {
    const row = blankFn();
    const match = TRADES.find((t) => norm(st.name).includes(norm(t)) || norm(t).includes(norm(st.name)));
    row.trade = match || "Other";
    row.notes = match ? (st.estimatedHours ? st.estimatedHours + "h planned" : "")
      : [st.name, st.estimatedHours ? st.estimatedHours + "h planned" : ""].filter(Boolean).join(" — ");
    return row;
  });
}

/* ============================================================
   Network (browser-only; every call is fail-safe for the UI)
   ============================================================ */
const ready = () => SYNC_ENABLED && isSignedIn() &&
  !(typeof navigator !== "undefined" && navigator.onLine === false);

async function fetchBoardRows() {
  const res = await rest(`coordination_jobs?select=id,data&deleted=is.false`, { method: "GET" });
  if (!res.ok) throw new Error("board read failed (" + res.status + ")");
  return (await res.json()).filter((r) => r && r.id !== "__settings__");
}

/* ---------- pure: fuzzy identity matching ----------
   The coordinator's hand-built tiles rarely say exactly what the field job
   says: the tile is titled "Smith Rebuild" while the job's customer is
   "John Smith", or the claim # only lives on one side. Exact-equality
   matching missed those and every miss CREATED A DUPLICATE tile. */

/* street addresses, normalized hard: "415 Birch Ln." == "415 birch lane" */
const ADDR_NOISE = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|way|place|pl|boulevard|blvd|highway|hwy|suite|ste|apt|unit|north|south|east|west|n|s|e|w)\b/g;
export const normAddr = (s) => norm(s).replace(/[^a-z0-9 ]/g, " ").replace(ADDR_NOISE, "").replace(/\s+/g, " ").trim();

/* names match on equality OR containment ("smith" ⊂ "john smith" /
   "smith rebuild") — the contained side needs 5+ chars so "jo" never links */
export const nameLike = (a, b) => {
  a = norm(a).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  b = norm(b).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b));
};

/* mitigation tiles (water/fire/mold) and build tiles (remodel/new build/
   restoration) legitimately coexist for one customer — one claim often has
   BOTH a mitigation tile and a rebuild tile. Never match across the groups.
   A tile with no/other type (older hand-built ones) is compatible with both. */
const MITIGATION_TYPES = new Set(["water", "fire", "mold"]);
const BUILD_TYPES = new Set(["remodel", "new_build", "restoration"]);
export const sameWorkGroup = (typeA, typeB) => {
  const a = String(typeA || ""), b = String(typeB || "");
  if (!(MITIGATION_TYPES.has(a) || BUILD_TYPES.has(a))) return true;
  if (!(MITIGATION_TYPES.has(b) || BUILD_TYPES.has(b))) return true;
  return MITIGATION_TYPES.has(a) === MITIGATION_TYPES.has(b);
};

/* every live tile this field job COULD be: right work group, not a
   milestone, not done, not linked to a different field job, and the
   customer/title name-matches OR the street address matches */
export function looseCandidates(rows, project) {
  const pAddr = normAddr(project && project.address);
  const group = boardTypeFor(project || {});
  return arr(rows).filter((r) => {
    const d = r && r.data;
    if (!d || d.isMilestone || d.stage === "done") return false;
    if (d.fieldJobId && d.fieldJobId !== project.id) return false;
    if (!sameWorkGroup(d.type, group)) return false;
    if (nameLike(d.customer, project.customer) || nameLike(d.title, project.customer)) return true;
    const dAddr = normAddr(d.address);
    return !!pAddr && pAddr.length >= 4 && dAddr === pAddr;
  });
}

/* Only an UNAMBIGUOUS single hit counts — two lookalikes mean "don't guess"
   (and the callers then skip tile creation rather than duplicate). */
export function matchCustomerRow(rows, project) {
  if (!norm(project && project.customer) && !norm(project && project.address)) return null;
  const hits = looseCandidates(rows, project);
  return hits.length === 1 ? hits[0] : null;
}

/* ---------- pure: match a project to its board row ----------
   Explicit fieldJobId link first, claim # second, unambiguous customer-name
   match last. A restoration job that spawned a reconstruction job shares its
   claim # AND customer with the recon job — the board tile belongs to the
   recon side, so fallback matching is skipped for it (fieldJobId still wins). */
export function boardRowFor(rows, project) {
  const linked = arr(rows).find((r) => r.data && r.data.fieldJobId === project.id);
  if (linked) return linked;
  if (project && project.linkedConstructionId) return null;
  const byClaim = matchCoordinationId(rows, project && project.claimNo);
  if (byClaim) return arr(rows).find((r) => r.id === byClaim) || null;
  return matchCustomerRow(rows, project);
}

/** Find this project's board row (one network fetch + boardRowFor). */
export async function findBoardRow(project) {
  return boardRowFor(await fetchBoardRows(), project);
}

/** One batched read of every live board row, for stamping a whole job list.
    Fail-safe: null when offline / signed out / anything goes wrong — the
    caller just skips stage chips. */
export async function fetchBoardRowsSafe() {
  try {
    if (!ready()) return null;
    return await fetchBoardRows();
  } catch (_) {
    return null;
  }
}

/* Same optimistic-concurrency guard as the Board's data layer. */
async function guardedWrite(id, base, next) {
  const eid = encodeURIComponent(id);
  const guard = base > 0 ? `data->>rev=eq.${base}` : `or=(data->>rev.is.null,data->>rev.eq.0)`;
  const res = await rest(`coordination_jobs?id=eq.${eid}&${guard}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ data: next, deleted: false }),
  });
  if (!res.ok) throw new Error("board save failed (" + res.status + ")");
  if ((await res.json()).length) return { ok: true };
  const chk = await rest(`coordination_jobs?id=eq.${eid}&select=id,data`, { method: "GET" });
  const existing = chk.ok ? await chk.json() : [];
  if (!existing.length) {
    const ins = await rest("coordination_jobs", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ id, data: next, deleted: false }]),
    });
    if (ins.ok) return { ok: true };
    throw new Error("board insert failed (" + ins.status + ")");
  }
  return { conflict: true, server: existing[0].data };
}

/* ============================================================
   Duplicate healing — merge a field-created tile into the tile the
   coordinator already built, losing NOTHING they built into it.
   ============================================================ */
export const STAGE_ORDER = ["lead", "scheduled", "in_progress", "on_hold", "final", "done"];
const stageIdx = (s) => Math.max(0, STAGE_ORDER.indexOf(String(s)));
const hasPhaseWork = (d) => arr(d && d.subtasks).some((st) => norm(st.name));
const isMachineNotes = (s) => /^Pushed from the field app/.test(String(s || "").trim());

/* ---------- pure: merge the duplicate INTO the hand-built tile ----------
   `keep` is the coordinator's tile — its stage, dates, crew, deps, phases,
   and settings all survive untouched. The dupe only ever FILLS BLANKS
   (identity fields, contract value, dates the keeper never set), carries
   its field link + actuals over, and a phase plan the keeper doesn't have
   arrives as the standard fieldPlanProposal for the Board to reconcile —
   the same reconcile path a plan push uses. Stage only ever moves FORWARD. */
export function mergeBoardTiles(keep, dupe, nowISO) {
  const out = { ...keep };
  out.fieldJobId = keep.fieldJobId || dupe.fieldJobId || "";
  for (const k of ["customer", "address", "phone", "claimNo", "title", "notBefore", "notBeforeLabel", "startDate", "targetDate", "pinnedStart"])
    if (!norm(out[k]) && norm(dupe[k])) out[k] = dupe[k];
  for (const k of ["contractValue", "estimatedHours", "billedToDate"])
    if (!Number(out[k]) && Number(dupe[k])) out[k] = dupe[k];
  if (!arr(out.crewIds).length && arr(dupe.crewIds).length) out.crewIds = [...dupe.crewIds];
  if (!arr(out.deps).length && arr(dupe.deps).length) out.deps = arr(dupe.deps).filter((dp) => (dp && dp.predId) !== keep.id);
  if (out.materials === "none" && dupe.materials && dupe.materials !== "none") out.materials = dupe.materials;
  if (out.priority === "normal" && dupe.priority && dupe.priority !== "normal") out.priority = dupe.priority;
  if (stageIdx(dupe.stage) > stageIdx(out.stage)) out.stage = dupe.stage;
  if (!hasPhaseWork(out) && hasPhaseWork(dupe)) out.subtasks = arr(dupe.subtasks).map((st) => ({ ...st }));
  else if (hasPhaseWork(out) && hasPhaseWork(dupe) && !out.fieldPlanProposal) {
    out.fieldPlanProposal = dupe.fieldPlanProposal || {
      phases: arr(dupe.subtasks).filter((st) => norm(st.name))
        .map((st) => ({ name: st.name, estimatedHours: st.estimatedHours || "", lagDays: st.lagDays || 0 })),
      assumptions: [], notBefore: dupe.notBefore || "", notBeforeLabel: dupe.notBeforeLabel || "",
      from: dupe.fieldJobId || "", at: nowISO,
    };
  }
  if (!out.fieldPlanProposal && dupe.fieldPlanProposal) out.fieldPlanProposal = dupe.fieldPlanProposal;
  if (!out.fieldActuals && dupe.fieldActuals) out.fieldActuals = dupe.fieldActuals;
  // human-typed notes on the dupe ride along; the machine boilerplate doesn't
  if (norm(dupe.notes) && !isMachineNotes(dupe.notes) && !norm(out.notes).includes(norm(dupe.notes)))
    out.notes = [out.notes, dupe.notes].filter((s) => norm(s)).join("\n");
  out.updatedAt = nowISO;
  return out;
}

/* ---------- pure: find (machine dupe, hand-built keeper) pairs ----------
   A dupe is a tile the FIELD side created (fieldJobId + the machine notes
   marker) sitting next to a tile the coordinator built by hand (never
   field-linked). Pairing uses the same fuzzy identity rules as matching —
   claim #, name, or address, within the same work group — and refuses to
   guess: two possible keepers means no merge. */
export function duplicateTilePairs(rows) {
  const live = arr(rows).filter((r) => r && r.data && !r.data.isMilestone);
  const dupes = live.filter((r) => r.data.fieldJobId && isMachineNotes(r.data.notes));
  const keepers = live.filter((r) => !r.data.fieldJobId && !isMachineNotes(r.data.notes) && r.data.stage !== "done");
  const pairs = [];
  const used = new Set();
  for (const dupe of dupes) {
    const d = dupe.data;
    const hits = keepers.filter((k) => {
      if (used.has(k.id) || !sameWorkGroup(k.data.type, d.type)) return false;
      const claimA = normClaim(d.claimNo), claimB = normClaim(k.data.claimNo);
      if (claimA && claimB) return claimA === claimB;
      if (nameLike(k.data.customer, d.customer) || nameLike(k.data.title, d.customer) ||
          nameLike(k.data.title, d.title) || nameLike(k.data.customer, d.title)) return true;
      const a = normAddr(d.address), b = normAddr(k.data.address);
      return !!a && a.length >= 4 && a === b;
    });
    if (hits.length !== 1) continue;
    used.add(hits[0].id);
    pairs.push({ keep: hits[0], dupe });
  }
  return pairs;
}

/** Merge field-created duplicate tiles into the coordinator's hand-built
    ones: survivor gets the union (guarded write), the dupe is tombstoned
    (restorable — its data stays on the deleted row), dependencies pointing
    at the dupe are re-pointed, and the spine link follows the survivor.
    Fail-safe + re-entrancy-guarded; fires from the jobs list on load. */
let _healing = false;
export async function healBoardDuplicates(rows) {
  if (_healing || !ready()) return 0;
  _healing = true;
  let merged = 0;
  try {
    for (const { keep, dupe } of duplicateTilePairs(rows)) {
      const nowISO = new Date().toISOString();
      const union = mergeBoardTiles(keep.data, dupe.data, nowISO);
      const base = Number(keep.data.rev) || 0;
      const r = await guardedWrite(keep.id, base, { ...union, rev: base + 1 });
      if (r.conflict) continue;                        // coordinator mid-edit — next pass
      await rest(`coordination_jobs?id=eq.${encodeURIComponent(dupe.id)}`, {
        method: "PATCH", body: JSON.stringify({ deleted: true }),
      });
      for (const other of arr(rows)) {
        if (!other || !other.data || other.id === keep.id || other.id === dupe.id) continue;
        const deps = arr(other.data.deps);
        if (!deps.some((dp) => dp && dp.predId === dupe.id)) continue;
        const nd = deps.map((dp) => (dp && dp.predId === dupe.id ? { ...dp, predId: keep.id } : dp))
          .filter((dp, i, a) => a.findIndex((x) => x && dp && x.predId === dp.predId) === i);
        const ob = Number(other.data.rev) || 0;
        try { await guardedWrite(other.id, ob, { ...other.data, deps: nd, rev: ob + 1 }); } catch (_) {}
      }
      if (union.fieldJobId) await linkSpine({ id: union.fieldJobId }, keep.id);
      merged++;
    }
  } catch (_) { /* offline mid-loop — whatever merged stands */ }
  _healing = false;
  return merged;
}

/* Best-effort: record the board link on the unified_jobs spine row. */
async function linkSpine(project, coordinationJobId) {
  try {
    await rest(`unified_jobs?field_project_id=eq.${encodeURIComponent(project.id)}`, {
      method: "PATCH", body: JSON.stringify({ coordination_job_id: coordinationJobId }),
    });
  } catch (_) { /* the claim-number match will catch up on the next spine sync */ }
}

/** Push project.boardPlan to the Board. Returns { mode: "created"|"direct"|"proposal" }.
    Retries a rev conflict once against the fresh server copy. */
export async function pushPlanToBoard(project) {
  if (!ready()) throw new Error("Sign in (online) to send the plan to the board.");
  const plan = project.boardPlan;
  if (!plan || !arr(plan.phases).length) throw new Error("No timeline to send — estimate it first.");
  const nowISO = new Date().toISOString();
  const attempt = async (row) => {
    if (!row) {
      const job = boardJobFromProject(project, plan, nowISO);
      const r = await guardedWrite(job.id, 0, job);
      if (r.conflict) throw new Error("board insert conflicted — try again");
      await linkSpine(project, job.id);
      return { mode: "created", boardJobId: job.id };
    }
    const base = Number(row.data && row.data.rev) || 0;
    const { data, mode } = mergePlanIntoBoardJob(row.data || { id: row.id }, project, plan, nowISO);
    data.updatedAt = nowISO;
    const r = await guardedWrite(row.id, base, { ...data, rev: base + 1 });
    if (r.conflict) return null;   // caller retries once with the fresh copy
    await linkSpine(project, row.id);
    return { mode, boardJobId: row.id };
  };
  // Refuse to guess between lookalike tiles: creating "a second Smith"
  // is exactly the duplicate bug this lookup exists to prevent.
  const lookup = async () => {
    const rows = await fetchBoardRows();
    const row = boardRowFor(rows, project);
    if (!row && looseCandidates(rows, project).length >= 2)
      throw new Error("Two board tiles look like this job — put the claim # on the right one (or match its name) and try again.");
    return row;
  };
  let out = await attempt(await lookup());
  if (!out) out = await attempt(await lookup());   // one retry after a conflict
  if (!out) throw new Error("The board job changed while sending — try again.");
  return out;
}

/** Fire-and-forget: write the daily-log rollup onto the linked board job as
    data.fieldActuals. Only writes when the numbers changed; never throws.

    IMPORTANT — this write keeps the SAME rev on purpose. fieldActuals is a
    field-owned annotation, not an edit: if it consumed a revision, a
    coordinator holding the job modal open (the board pauses polling there)
    would have their save REFUSED and dropped because hours rolled up in the
    background. At the same rev their save wins and simply overwrites the
    annotation — which the next rollup re-pushes. */
const _pushedActuals = new Map();   // projectId -> local signature already confirmed this session
export async function pushActuals(project) {
  try {
    if (!ready() || jobType(project) !== "construction") return { skipped: true };
    // cheap local gate first — no network when nothing changed since the last push
    const planNames = arr(project.boardPlan && project.boardPlan.phases).map((p) => p.name);
    const localSig = planNames.length ? sortedJson(rollupActuals(project, planNames)) : null;
    if (localSig && _pushedActuals.get(project.id) === localSig) return { unchanged: true };
    const row = await findBoardRow(project);
    if (!row || !row.data || row.data.fieldJobId !== project.id) return { skipped: true };
    const actuals = rollupActuals(project, arr(row.data.subtasks).map((st) => st.name));
    const done = () => { if (localSig) _pushedActuals.set(project.id, localSig); };
    if (sortedJson(actuals) === sortedJson(row.data.fieldActuals)) { done(); return { unchanged: true }; }
    const base = Number(row.data.rev) || 0;
    const r = await guardedWrite(row.id, base, { ...row.data, fieldActuals: actuals, rev: base });
    if (r.conflict) return { skipped: true };
    done();
    return { ok: true };
  } catch (_) {
    return { skipped: true };
  }
}

/** History digest for the estimator prompt — best-effort, empty on any failure. */
export async function fetchHistoryDigest() {
  try {
    if (!ready()) return [];
    return historyDigest(await fetchBoardRows());
  } catch (_) {
    return [];
  }
}

/* ============================================================
   Phase 6 — one job, two views (no double entry)
   The FIELD side runs both directions; the board app is untouched:
     field job saved with real details -> a board tile appears (Leads,
                                          or Scheduled with a start date)
     board tile reaches Scheduled /
     In Progress                       -> a field job file appears
   ============================================================ */

/* ---------- pure: which field projects could this tile belong to? ----------
   Claim # first, customer/title second — ARCHIVED jobs count too (an
   archived file must still block re-creation). ANY candidate means "don't
   create a file"; actual linking happens from the project side
   (ensureBoardTile), where the match rules are strict. */
export function tileCandidates(d, projects) {
  const claim = normClaim(d && (d.claimNo || d.claimNumber || d.claim));
  if (claim) {
    const hits = arr(projects).filter((p) => normClaim(p.claimNo) === claim);
    if (hits.length) return hits;
  }
  const want = norm(d && d.customer) || norm(d && d.title);
  if (!want) return [];
  return arr(projects).filter((p) => norm(p.customer) === want);
}

/* ---------- pure: which tiles are real work with no job file? ----------
   Leads/bids stay board-only (dead leads must not litter crew phones);
   milestones are calendar markers, never jobs. A tile that EVER linked a
   field job (fieldJobId set) is respected even if that job was deleted —
   deleting a job file must not resurrect it on the next open. */
export function tilesNeedingFieldFile(rows, projects) {
  return arr(rows).filter((r) => {
    const d = r && r.data;
    if (!d || d.isMilestone) return false;
    if (d.stage !== "scheduled" && d.stage !== "in_progress") return false;
    if (d.fieldJobId) return false;
    return tileCandidates(d, projects).length === 0;
  });
}

/* ---------- pure: board tile -> a fresh field job file ----------
   The id derives from the tile id, so two crew devices adopting the same
   tile at the same moment converge on ONE row instead of duplicating. */
const FIELD_TYPE = { remodel: "remodel", new_build: "new_construction", restoration: "reconstruction" };
export function fieldSeedFromBoardJob(row, blank) {
  const d = (row && row.data) || {};
  const p = { ...blank, id: "bj-" + row.id };
  p.jobType = (d.type === "water" || d.type === "fire" || d.type === "mold") ? "restoration" : "construction";
  if (p.jobType === "construction") {
    p.constructionType = FIELD_TYPE[d.type] || "";
    p.startDate = d.startDate || "";
    p.targetCompletion = d.targetDate || "";
    if (Number(d.contractValue)) p.contractAmount = String(d.contractValue);
  }
  p.customer = d.customer || d.title || "";
  p.address = d.address || "";
  p.phone = d.phone || "";
  p.claimNo = d.claimNo || "";
  return p;
}

/* Has this id ever existed on the server (live or tombstoned)? A tombstone
   means someone deliberately deleted the auto-created file — never recreate.
   Fails CLOSED: if the check can't run, no file is created this pass. */
async function serverHasProject(id) {
  const res = await rest(`field_projects?id=eq.${encodeURIComponent(id)}&select=id`, { method: "GET" });
  if (!res.ok) return true;
  return (await res.json()).length > 0;
}

/** Create job files for board tiles that reached real work. Returns how many
    were created. Fail-safe and re-entrancy-guarded — safe to fire from the
    jobs list on every load. */
let _adopting = false;
export async function adoptBoardJobs(rows, projects) {
  if (_adopting || !ready()) return 0;
  _adopting = true;
  let created = 0;
  try {
    for (const row of tilesNeedingFieldFile(rows, projects)) {
      if (await serverHasProject("bj-" + row.id)) continue;
      const p = fieldSeedFromBoardJob(row, newProject());
      await Store.put(p);   // the sync engine's saved-listener pushes it up
      // Stamp the link on the tile (same-rev annotation — never blocks a
      // coordinator's save; ensureBoardTile re-stamps if this write loses).
      const base = Number(row.data.rev) || 0;
      try { await guardedWrite(row.id, base, { ...row.data, fieldJobId: p.id, rev: base }); } catch (_) {}
      await linkSpine(p, row.id);
      created++;
    }
  } catch (_) { /* offline mid-loop etc. — whatever was created stands */ }
  _adopting = false;
  return created;
}

/* ---------- field job -> board tile (no double entry) ----------
   Fires from the job home. Creates a phase-less tile the first time a job
   has real details; afterwards keeps the tile's identity fields (customer,
   address, phone, claim #, unset contract value) in step. The FIELD app owns
   identity; the board owns stage/dates/crew/phases. Identity writes keep the
   SAME rev (annotation semantics, like pushActuals): a coordinator mid-edit
   always wins, and the next job-home visit re-pushes. */
const _tileEnsured = new Map();   // projectId -> identity signature confirmed this session
export async function ensureBoardTile(project) {
  try {
    if (!ready() || project.archivedAt) return { skipped: true };
    if (!norm(project.customer) && !norm(project.address)) return { skipped: true };   // still a blank "+ New Job"
    const sig = JSON.stringify([project.customer, project.address, project.phone, project.claimNo, project.contractAmount]);
    if (_tileEnsured.get(project.id) === sig) return { unchanged: true };
    const rows = await fetchBoardRows();
    const row = boardRowFor(rows, project);
    if (!row) {
      // ≥2 lookalike tiles: never guess, never create a duplicate — a claim #
      // or an exact name on either side resolves it on a later visit
      if (looseCandidates(rows, project).length >= 2) return { skipped: true };
      const job = boardJobFromProject(project, null, new Date().toISOString());
      const r = await guardedWrite(job.id, 0, job);
      if (r.conflict) return { skipped: true };
      await linkSpine(project, job.id);
      _tileEnsured.set(project.id, sig);
      return { mode: "created", boardJobId: job.id };
    }
    const d = row.data || { id: row.id };
    const next = { ...d, fieldJobId: project.id };
    let changed = d.fieldJobId !== project.id;
    for (const [key, val] of [["customer", project.customer], ["address", project.address],
                              ["phone", project.phone], ["claimNo", project.claimNo]]) {
      const v = String(val || "").trim();
      if (v && d[key] !== v) { next[key] = v; changed = true; }
    }
    if (!Number(d.contractValue) && Number(project.contractAmount)) { next.contractValue = Number(project.contractAmount); changed = true; }
    if (changed) {
      const base = Number(d.rev) || 0;
      const r = await guardedWrite(row.id, base, { ...next, rev: base });
      if (r.conflict) return { skipped: true };
      await linkSpine(project, row.id);
    }
    _tileEnsured.set(project.id, sig);
    return changed ? { mode: "synced", boardJobId: row.id } : { unchanged: true };
  } catch (_) {
    return { skipped: true };
  }
}
