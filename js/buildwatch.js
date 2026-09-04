/* ============================================================
   Roybal Field Forms — Build Watch (pure, no AI, no cost)
   ------------------------------------------------------------
   Rule-based attention flags for construction jobs, computed from
   the documented data and shown on the job list:
     • inspFail — a failed inspection with no reinspection scheduled
     • subNoShow — a trade marked no-show on the sub schedule
     • subLate  — a trade past its scheduled end and not done
     • selOrder — a pending selection at/past its ordering deadline
                  (needed-by date minus its lead time)
     • tradeUnscheduled / tradeQuiet — daily logs vs sub schedule
     • phaseOver / phaseHot — daily-log hours vs the board-plan
       estimate (red past 110%, amber from 80%)
     • coStale — a change order signed after the last timeline
   A job with a signed/issued Certificate of Completion is done —
   never flagged. Pure (rollupActuals is pure too) — Node-testable.
   ============================================================ */
import { rollupActuals } from "./boardpush.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const dayMs = 86400000;
const toTime = (iso) => {
  if (!iso) return null;
  const d = new Date(String(iso).length <= 10 ? iso + "T12:00:00" : iso);
  return isNaN(d) ? null : d.getTime();
};

/** True once the job's completion is certified — no more watching needed.
    Signature or uploaded signed copy ONLY: the factory prefills issueDate,
    so merely opening the form must never count as complete. */
export function isComplete(p) {
  const cc = p && p.certCompletion;
  return !!(cc && (cc.sigContractor || (cc.uploadedPages && cc.uploadedPages.length)));
}

/* ---------- daily-log ↔ schedule cross-check (Phase 4) ----------
   The daily construction logs and the sub schedule should agree:
     • tradeUnscheduled — recent log tasks name a trade that isn't on
       the sub schedule at all (someone's on site off-plan)
     • tradeQuiet — a trade the schedule says should be on site now
       has no log mention for 2+ days (stalled or ghosting)
   Trade detection is deliberately dumb keyword matching — good enough
   for a flag chip, cheap enough to run on every job-list paint. */
const TRADE_WORDS = {
  "Demo": ["demo", "tear out", "tear-out", "teardown"],
  "Framing": ["fram"],
  "Electrical": ["electric", "wiring", "wire "],
  "Plumbing": ["plumb", "pipe"],
  "HVAC": ["hvac", "duct", "furnace"],
  "Insulation": ["insulat"],
  "Drywall": ["drywall", "sheetrock", "taping", "mudding"],
  "Paint": ["paint", "primer", "priming"],
  "Flooring": ["floor", "carpet", "vinyl", "tile", "lvp"],
  "Trim / Doors": ["trim", "casing", "baseboard", "door"],
  "Cabinets / Counters": ["cabinet", "counter"],
  "Roofing": ["roof", "shingle"],
};
function tradesInText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return [];
  return Object.keys(TRADE_WORDS).filter((trade) => TRADE_WORDS[trade].some((w) => t.includes(w)));
}

function crossCheckFlags(p, now) {
  const flags = [];
  const logs = arr(p.constructionLogs);
  const subs = arr(p.subSchedule && p.subSchedule.rows).filter((r) => r.trade);
  if (!logs.length || !subs.length) return flags;   // needs both sides to compare

  const recentTrades = (days) => {
    const found = new Set();
    for (const log of logs) {
      const t = toTime(log.date);
      if (t == null || now - t > days * dayMs) continue;
      for (const row of arr(log.rows)) for (const tr of tradesInText(row.task)) found.add(tr);
    }
    return found;
  };

  // tradeUnscheduled — a trade worked in the last 3 days that the schedule doesn't know
  const scheduled = new Set(subs.map((r) => r.trade));
  const offPlan = [...recentTrades(3)].filter((tr) => !scheduled.has(tr));
  if (offPlan.length) flags.push({ kind: "tradeUnscheduled", icon: "🕐", tone: "warn",
    label: "On site but not scheduled: " + offPlan.join(", ") });

  // tradeQuiet — should be on site now per the schedule, silent in the logs for 2+ days
  const workedLately = recentTrades(2);
  const quiet = subs.filter((r) => {
    if (!TRADE_WORDS[r.trade]) return false;                    // "Other" etc. — unobservable in log text, never flag
    if (r.status !== "scheduled" && r.status !== "on-site") return false;
    const start = toTime(r.schedStart), end = toTime(r.schedEnd);
    if (start == null || now < start) return false;             // not due yet
    if (end != null && now > end + dayMs) return false;         // window passed — subLate covers that
    return !workedLately.has(r.trade);
  }).map((r) => r.trade);
  if (quiet.length) flags.push({ kind: "tradeQuiet", icon: "🕐", tone: "warn",
    label: quiet.join(", ") + (quiet.length === 1 ? " has" : " have") + " no log entry in 2+ days" });

  return flags;
}

/**
 * buildFlags(project, now?) -> [{ kind, icon, label, tone }]
 * tone: 'bad' (needs action today) | 'warn' (watch it)
 */
export function buildFlags(p, now = Date.now()) {
  if (!p || isComplete(p)) return [];
  const flags = [];

  // inspFail — failed inspection with no reinspection on the calendar
  const failed = arr(p.inspections).filter((i) => i.result === "fail" && !i.reinspection);
  if (failed.length) {
    flags.push({ kind: "inspFail", icon: "🏛️", tone: "bad",
      label: failed.length === 1 ? "Failed " + (failed[0].type || "inspection") : failed.length + " failed inspections" });
  }

  const subs = arr(p.subSchedule && p.subSchedule.rows);

  // subNoShow — explicitly marked no-show
  const noShow = subs.filter((r) => r.status === "no-show").length;
  if (noShow) flags.push({ kind: "subNoShow", icon: "🕐", tone: "bad",
    label: noShow + (noShow === 1 ? " sub no-show" : " sub no-shows") });

  // subLate — past scheduled end, still not done
  const late = subs.filter((r) => {
    if (r.status === "done" || r.status === "no-show" || !r.schedEnd) return false;
    const t = toTime(r.schedEnd);
    return t != null && now > t + dayMs;   // a full day past the scheduled end
  }).length;
  if (late) flags.push({ kind: "subLate", icon: "🕐", tone: "warn",
    label: late + (late === 1 ? " trade behind schedule" : " trades behind schedule") });

  // daily-log ↔ schedule cross-check (Phase 4)
  for (const f of crossCheckFlags(p, now)) flags.push(f);

  // phaseOver / phaseHot — daily-log hours against the board-plan estimates
  const plan = p.boardPlan;
  if (plan && arr(plan.phases).length) {
    const actuals = rollupActuals(p, plan.phases.map((x) => x.name));
    const over = [], hot = [];
    for (const ph of arr(plan.phases)) {
      const est = Number(ph.estimatedHours) || 0;
      if (!est || !ph.name) continue;
      const act = actuals[ph.name] || 0;
      if (act >= est * 1.1) over.push(ph.name);
      else if (act >= est * 0.8) hot.push(ph.name);
    }
    if (over.length) flags.push({ kind: "phaseOver", icon: "⏱", tone: "bad",
      label: over.join(", ") + " over the estimate" });
    if (hot.length) flags.push({ kind: "phaseHot", icon: "⏱", tone: "warn",
      label: hot.join(", ") + " nearing the estimate" });

    // coStale — scope changed after the plan was estimated
    if (plan.generatedAt && arr(p.changeOrders).some((co) => (co.createdAt || "") > plan.generatedAt)) {
      flags.push({ kind: "coStale", icon: "📅", tone: "warn",
        label: "Change order since the timeline — re-estimate?" });
    }
  }

  // selOrder — pending selection at/past its ordering deadline.
  // Deadline = needed-by (or the job's target completion) minus lead time.
  const targetT = toTime(p.targetCompletion);
  const due = arr(p.selections && p.selections.rows).filter((r) => {
    if (r.status !== "pending") return false;
    const needT = toTime(r.neededBy) ?? targetT;
    if (needT == null) return false;
    const deadline = needT - (Number(r.leadWeeks) || 0) * 7 * dayMs;
    return now >= deadline;
  });
  if (due.length) {
    const past = due.some((r) => {
      const needT = toTime(r.neededBy) ?? targetT;
      return needT != null && now >= needT;
    });
    flags.push({ kind: "selOrder", icon: "🎨", tone: past ? "bad" : "warn",
      label: due.length + (due.length === 1 ? " selection needs ordering" : " selections need ordering") });
  }

  return flags;
}
