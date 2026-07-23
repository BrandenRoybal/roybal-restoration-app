/* ============================================================
   Morning brief — pure digest builder (no Deno, no network)
   ------------------------------------------------------------
   Everything the brief says is computed here from plain data, so
   it can be unit-tested from Node exactly like personas.ts is
   (node --experimental-strip-types digest.test.mjs). The money
   math is a hand-kept mirror of apps/field/js/fincalc.js — the
   field copy carries the canonical unit tests.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function invoiceTotals(inv: Blob) {
  const subtotal = (inv.items || []).reduce((a: number, it: Blob) => a + num(it?.qty) * num(it?.price), 0);
  const contract = inv.billingModel === "contract";
  const amtMode = inv.opMode === "amount";
  const base = contract ? num(inv.contractAmount) : subtotal;
  const overhead = contract ? 0 : (amtMode ? num(inv.overheadAmount) : subtotal * (num(inv.overheadPct) / 100));
  const profit = contract ? 0 : (amtMode ? num(inv.profitAmount) : subtotal * (num(inv.profitPct) / 100));
  const tax = base * (num(inv.taxRate) / 100);
  return { total: base + overhead + profit + tax - num(inv.deductible) - num(inv.previousPayments) };
}

export function loggedCosts(p: Blob) {
  let sum = 0;
  for (const r of p.receipts || []) sum += num(r?.amount);
  for (const key of ["invoices", "reconEstimates"]) {
    for (const inv of p[key] || []) {
      for (const att of inv?.attachments || []) {
        if (!att?.ai || att.isPricingSource) continue;
        sum += num(att.ai.totalAmount);
      }
    }
  }
  return sum;
}

export function budgetStatus(p: Blob, threshold = 0.9) {
  const approved = (p.reconEstimates || [])
    .filter((e: Blob) => e?.status === "approved")
    .map((e: Blob) => invoiceTotals(e).total)
    .filter((t: number) => t > 0);
  const base = approved.length ? Math.max(...approved) : (num(p.contractAmount) > 0 ? num(p.contractAmount) : null);
  if (base == null) return null;
  const costs = loggedCosts(p);
  return { pct: Math.round((costs / base) * 100), over: costs / base > threshold };
}

export const money = (n: number) => "$" + Math.abs(Math.round(n)).toLocaleString("en-US");

/* date helpers take "today" (YYYY-MM-DD) so tests are deterministic */
export const daysBefore = (todayISO: string, iso: string) => {
  const a = Date.parse(String(iso).slice(0, 10) + "T00:00:00");
  const b = Date.parse(todayISO + "T00:00:00");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : null;
};
export const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface BriefInput {
  projects: Blob[];          // field project blobs, each with _rowUpdated (row updated_at)
  boardJobs: Blob[];         // coordination_jobs data blobs (settings row excluded)
  portalWaiting: number | null;
  today: string;             // Alaska YYYY-MM-DD
  pretty: string;            // "Wed, Jul 23"
  budgetThreshold?: number;
}

/** One SMS-sized morning digest: attention lines + up to 3 questions. */
export function buildBrief({ projects, boardJobs, portalWaiting, today, pretty, budgetThreshold = 0.9 }: BriefInput) {
  const jobName = (p: Blob) => String(p.customer || p.address || "job");
  const since = (iso: string) => daysBefore(today, iso);
  const lines: string[] = [];
  const questions: string[] = [];

  // 💵 overdue invoices (chip-tracked lifecycles only — a hand-typed invoice
  // joins the chase the first time its status is set)
  const overdue: { label: string; days: number; bal: number }[] = [];
  for (const p of projects) {
    for (const inv of p.invoices || []) {
      if (!["sent", "viewed", "partially_paid"].includes(inv?.status)) continue;
      if (!inv.dueDate || inv.dueDate >= today) continue;
      overdue.push({ label: `${inv.invoiceNo || "invoice"} ${jobName(p)}`, days: since(inv.dueDate) ?? 0, bal: invoiceTotals(inv).total });
    }
  }
  overdue.sort((a, b) => b.days - a.days);
  if (overdue.length) {
    lines.push(`💵 ${overdue.length} overdue: ` + overdue.slice(0, 3)
      .map((o) => `${o.label} ${money(o.bal)} (${o.days}d)`).join(" · "));
  }

  // 📈 budget-hot
  const hot = projects.map((p) => ({ p, b: budgetStatus(p, budgetThreshold) })).filter((x) => x.b && x.b.over);
  if (hot.length) lines.push(`📈 budget hot: ` + hot.slice(0, 3).map((x) => `${jobName(x.p)} at ${x.b!.pct}%`).join(" · "));

  // 🌀 drying equipment out ≥7 days
  const equip = projects.filter((p) => (p.dryingLogs || []).some((d: Blob) =>
    (d.equipment || []).some((e: Blob) => e.placed && !e.removed && (since(e.placed) ?? 0) >= 7)));
  if (equip.length) lines.push(`🌀 equipment out 7d+: ${equip.slice(0, 3).map(jobName).join(", ")}${equip.length > 3 ? ` +${equip.length - 3}` : ""}`);

  // 📅 board slips + materials not ordered near start
  const late = boardJobs.filter((j) => !j.isMilestone && j.targetDate && j.targetDate < today && (j.stage || "lead") !== "done");
  if (late.length) lines.push(`📅 past target: ${late.slice(0, 3).map((j) => j.title || j.customer || "job").join(", ")}${late.length > 3 ? ` +${late.length - 3}` : ""}`);
  const noMat = boardJobs.filter((j) => !j.isMilestone && j.materials === "none" && j.startDate &&
    j.startDate >= today && j.startDate <= plusDays(today, 3) && ["scheduled", "in_progress"].includes(j.stage));
  if (noMat.length) lines.push(`🧱 starts soon, materials not ordered: ${noMat.slice(0, 3).map((j) => j.title || j.customer || "job").join(", ")}`);

  // 📨 customers waiting
  if (portalWaiting && portalWaiting > 0) lines.push(`📨 ${portalWaiting} customer portal message${portalWaiting === 1 ? "" : "s"} waiting`);

  // ❓ proactive questions — what looks MISSING, asked instead of assumed
  for (const p of projects) {
    const logs = (p.dryingLogs || []).map((d: Blob) => String(d.date || "")).filter(Boolean).sort();
    const last = logs[logs.length - 1];
    const gearOut = (p.dryingLogs || []).some((d: Blob) => (d.equipment || []).some((e: Blob) => e.placed && !e.removed));
    if (gearOut && last && (since(last) ?? 0) >= 2) {
      questions.push(`No drying log since ${last.slice(5)} on ${jobName(p)} — is the crew on it?`);
    }
  }
  for (const p of projects.filter((p) => (since(String(p._rowUpdated || "").slice(0, 10)) ?? 0) > 14).slice(0, 2)) {
    questions.push(`${jobName(p)} untouched ${since(String(p._rowUpdated).slice(0, 10))}d — on hold, or done and unclosed?`);
  }

  const head = `☀️ Roybal brief — ${pretty}`;
  if (!lines.length && !questions.length) {
    return { text: `${head}\nAll quiet: ${projects.length} jobs on file, nothing needs you this morning.`, flags: 0 };
  }
  const q = questions.slice(0, 3).map((s) => `❓ ${s}`);
  return { text: [head, ...lines, ...q].join("\n").slice(0, 1200), flags: lines.length + q.length };
}
