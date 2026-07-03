/* ============================================================
   Roybal Field Forms — Drying Watch (pure, no AI, no cost)
   ------------------------------------------------------------
   Rule-based attention flags for jobs still in active drying,
   computed from the documented data and shown on the job list:
     • stale    — no moisture-map reading in 36+ hours
     • stalled  — a moisture map's latest max MC% isn't below the
                  previous reading (and is still over the dry goal)
     • equip7d  — drying equipment placed 7+ days ago, not removed
   A job with a signed/issued Certificate of Drying is done — never
   flagged. Pure + dependency-free so it's Node-testable.
   ============================================================ */

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };
const maxMC = (values) => {
  const ns = arr(values).map(num).filter((n) => n != null);
  return ns.length ? Math.max(...ns) : null;
};
const hoursSince = (iso, now) => {
  if (!iso) return null;
  const d = new Date(String(iso).length <= 10 ? iso + "T12:00:00" : iso);
  if (isNaN(d)) return null;
  return (now - d.getTime()) / 3600000;
};

/** True once the job's drying is certified — no more watching needed. */
export function isCertified(p) {
  const cd = p && p.certDrying;
  return !!(cd && (cd.sigTech || cd.issueDate || (cd.uploadedPages && cd.uploadedPages.length)));
}

/**
 * dryingFlags(project, now?) -> [{ kind, label, tone }]
 * tone: 'bad' (needs action today) | 'warn' (watch it)
 */
export function dryingFlags(p, now = Date.now()) {
  if (!p || isCertified(p)) return [];
  const flags = [];

  // Only watch jobs that actually have drying documentation started.
  const maps = arr(p.moistureMaps).filter((m) => arr(m.readings).some((r) => maxMC(r.values) != null));
  const equip = arr(p.dryingLogs).flatMap((d) => arr(d.equipment));
  if (!maps.length && !equip.length) return [];

  // stale — latest reading anywhere on the job is 36+ hours old
  const lastDates = maps
    .map((m) => arr(m.readings).filter((r) => maxMC(r.values) != null).map((r) => r.date).sort().slice(-1)[0])
    .filter(Boolean);
  if (lastDates.length) {
    const h = hoursSince(lastDates.sort().slice(-1)[0], now);
    if (h != null && h >= 36) flags.push({ kind: "stale", tone: "bad", label: "No reading in " + Math.floor(h / 24) + "+ days" });
  }

  // stalled — latest max MC% not improving and still over the dry goal
  let stalled = 0;
  for (const m of maps) {
    const rows = arr(m.readings).filter((r) => maxMC(r.values) != null);
    if (rows.length < 2) continue;
    const last = maxMC(rows[rows.length - 1].values);
    const prev = maxMC(rows[rows.length - 2].values);
    const goal = num(m.dryGoal);
    const overGoal = goal == null ? true : last > goal;
    if (last != null && prev != null && last >= prev && overGoal) stalled += 1;
  }
  if (stalled) flags.push({ kind: "stalled", tone: "warn", label: stalled + (stalled === 1 ? " area not drying down" : " areas not drying down") });

  // equip7d — placed 7+ days ago, no removal date
  const over = equip.filter((e) => {
    if (!e.placed || e.removed) return false;
    const h = hoursSince(e.placed, now);
    return h != null && h >= 7 * 24;
  }).length;
  if (over) flags.push({ kind: "equip7d", tone: "warn", label: over + (over === 1 ? " unit on site 7+ days" : " units on site 7+ days") });

  return flags;
}
