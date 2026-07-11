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
import { uid } from "./core.js";
import { rest, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";
import { matchCoordinationId } from "./spine.js";
import { jobType, TRADES } from "./model.js";

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

/* constructionType -> board job type */
const BOARD_TYPE = { remodel: "remodel", new_construction: "new_build", reconstruction: "restoration" };

/* ---------- pure: build a brand-new board job from a field project ---------- */
export function boardJobFromProject(project, plan, nowISO) {
  const phases = arr(plan && plan.phases);
  return {
    id: uid(),
    stage: project.startDate ? "scheduled" : "lead",
    type: BOARD_TYPE[project.constructionType] || "remodel",
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

/* ---------- pure: customer-name fallback match ----------
   The coordinator's board jobs rarely carry the claim # and never the
   fieldJobId until the first push — without this, a push would create a
   DUPLICATE tile next to the job they already track. Only an unambiguous
   single hit counts: active (not done), not a milestone, not already
   linked to a different field job, customer or title equal (normalized). */
export function matchCustomerRow(rows, project) {
  const want = norm(project && project.customer);
  if (!want) return null;
  const hits = arr(rows).filter((r) => {
    const d = r && r.data;
    if (!d || d.isMilestone || d.stage === "done") return false;
    if (d.fieldJobId && d.fieldJobId !== project.id) return false;
    return norm(d.customer) === want || norm(d.title) === want;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Find this project's board row: explicit fieldJobId link first, claim #
    second, unambiguous customer-name match last. */
export async function findBoardRow(project) {
  const rows = await fetchBoardRows();
  const linked = rows.find((r) => r.data && r.data.fieldJobId === project.id);
  if (linked) return linked;
  const byClaim = matchCoordinationId(rows, project.claimNo);
  if (byClaim) return rows.find((r) => r.id === byClaim) || null;
  return matchCustomerRow(rows, project);
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
  let out = await attempt(await findBoardRow(project));
  if (!out) out = await attempt(await findBoardRow(project));   // one retry after a conflict
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
