/**
 * Reports Page — AR Aging, Documentation Completeness, Payment Summary
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import clsx from "clsx";
import {
  BarChart2,
  FileText,
  DollarSign,
  RefreshCw,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  centsToDisplay,
  formatAlaskaDate,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_COLORS,
} from "@roybal/shared";
import type { Job, Invoice, JobDocument } from "@roybal/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobWithInvoices extends Job {
  invoices: Invoice[];
}

interface JobDocCounts {
  job_id: string;
  photo_before: number;
  photo_after: number;
  moisture_count: number;
  moisture_dry_count: number;
  equipment_count: number;
  equipment_removed_count: number;
  line_item_count: number;
  invoice_submitted_count: number;
  comm_count: number;
  task_count: number;
  has_work_auth: boolean;
}

type ReportsTab = "ar_aging" | "doc_completeness" | "payment_summary";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const today = new Date();

const daysSince = (dateStr: string | null | undefined): number => {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
};

const agingBucket = (days: number): "current" | "30" | "60" | "90" => {
  if (days > 90) return "90";
  if (days > 60) return "60";
  if (days > 30) return "30";
  return "current";
};

const agingRowClass = (days: number): string => {
  if (days > 90) return "bg-red-50 dark:bg-red-900/20";
  if (days > 60) return "bg-orange-50 dark:bg-orange-900/20";
  if (days > 30) return "bg-yellow-50 dark:bg-yellow-900/20";
  return "";
};

const docScoreCalc = (c: JobDocCounts): number => {
  let score = 0;
  if (c.photo_before > 0) score += 15;
  if (c.photo_after > 0) score += 15;
  if (c.moisture_count > 0) score += 10;
  if (c.moisture_count > 0 && c.moisture_dry_count === c.moisture_count) score += 10;
  if (c.equipment_count > 0 && c.equipment_removed_count === c.equipment_count) score += 10;
  if (c.has_work_auth) score += 10;
  if (c.line_item_count > 0) score += 10;
  if (c.invoice_submitted_count > 0) score += 10;
  if (c.comm_count > 0) score += 5;
  if (c.task_count >= 3) score += 5;
  return score;
};

const scoreColor = (score: number) => {
  if (score >= 80) return "bg-green-500";
  if (score >= 50) return "bg-yellow-500";
  return "bg-red-500";
};

const scoreTextColor = (score: number) => {
  if (score >= 80) return "text-green-600 dark:text-green-400";
  if (score >= 50) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
};

const formatMonth = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/Anchorage" });

const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
const currentYearStart = new Date(today.getFullYear(), 0, 1).toISOString();

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReportsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<ReportsTab>("ar_aging");
  const [loading, setLoading] = useState(true);

  // Data
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allInvoices, setAllInvoices] = useState<Invoice[]>([]);
  const [docCounts, setDocCounts] = useState<JobDocCounts[]>([]);

  // AR Aging filter
  const [arFilter, setArFilter] = useState<"all" | "mitigation" | "reconstruction" | "tm">("all");

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      const [jobsRes, invoicesRes, photosRes, moistureRes, equipRes, lineItemsRes, commsRes, tasksRes, docsRes] =
        await Promise.all([
          supabase.from("jobs").select("*").order("created_at", { ascending: false }),
          supabase.from("invoices").select("*").order("created_at", { ascending: false }),
          supabase.from("photos").select("job_id, category"),
          supabase.from("moisture_readings").select("job_id, is_dry"),
          supabase.from("equipment_logs").select("job_id, date_removed"),
          supabase.from("line_items").select("job_id"),
          supabase.from("communications").select("job_id"),
          supabase.from("tasks").select("job_id"),
          supabase.from("documents").select("job_id, doc_type, status"),
        ]);

      const jobList = (jobsRes.data ?? []) as Job[];
      const invoiceList = (invoicesRes.data ?? []) as Invoice[];
      const photoList = (photosRes.data ?? []) as { job_id: string; category: string }[];
      const moistureList = (moistureRes.data ?? []) as { job_id: string; is_dry: boolean }[];
      const equipList = (equipRes.data ?? []) as { job_id: string; date_removed: string | null }[];
      const lineItemList = (lineItemsRes.data ?? []) as { job_id: string }[];
      const commList = (commsRes.data ?? []) as { job_id: string }[];
      const taskList = (tasksRes.data ?? []) as { job_id: string }[];
      const docList = (docsRes.data ?? []) as JobDocument[];

      setJobs(jobList);
      setAllInvoices(invoiceList);

      // Build doc counts per job
      const counts: JobDocCounts[] = jobList.map((j) => ({
        job_id: j.id,
        photo_before: photoList.filter((p) => p.job_id === j.id && p.category === "before").length,
        photo_after: photoList.filter((p) => p.job_id === j.id && p.category === "after").length,
        moisture_count: moistureList.filter((m) => m.job_id === j.id).length,
        moisture_dry_count: moistureList.filter((m) => m.job_id === j.id && m.is_dry).length,
        equipment_count: equipList.filter((e) => e.job_id === j.id).length,
        equipment_removed_count: equipList.filter((e) => e.job_id === j.id && e.date_removed).length,
        line_item_count: lineItemList.filter((li) => li.job_id === j.id).length,
        invoice_submitted_count: invoiceList.filter((i) => i.job_id === j.id && i.status !== "draft").length,
        comm_count: commList.filter((c) => c.job_id === j.id).length,
        task_count: taskList.filter((t) => t.job_id === j.id).length,
        has_work_auth: docList.some((d) => d.job_id === j.id && d.doc_type === "work_authorization" && d.status === "signed"),
      }));

      setDocCounts(counts);
      setLoading(false);
    };

    fetchAll();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw size={24} className="text-[#F97316] animate-spin" />
      </div>
    );
  }

  // ─── AR Aging Data ────────────────────────────────────────────────────────
  const jobMap = Object.fromEntries(jobs.map((j) => [j.id, j]));

  // Unpaid invoices (submitted, partially_paid, disputed)
  const unpaidInvoices = allInvoices.filter((inv) =>
    ["submitted", "partially_paid", "disputed"].includes(inv.status)
  );

  const filteredUnpaid = unpaidInvoices.filter((inv) => {
    if (arFilter === "all") return true;
    if (arFilter === "mitigation") return inv.invoice_type === "mitigation";
    if (arFilter === "reconstruction") return inv.invoice_type === "reconstruction";
    if (arFilter === "tm") return inv.invoice_type === "tm";
    return true;
  });

  // Sort by days outstanding desc
  const sortedUnpaid = [...filteredUnpaid].sort((a, b) => {
    const daysA = daysSince(a.submitted_date ?? a.created_at);
    const daysB = daysSince(b.submitted_date ?? b.created_at);
    return daysB - daysA;
  });

  const totalAR = filteredUnpaid.reduce((s, i) => s + (i.amount_cents - (i.paid_cents ?? 0)), 0);
  const count30 = filteredUnpaid.filter((i) => daysSince(i.submitted_date ?? i.created_at) > 30).length;
  const count60 = filteredUnpaid.filter((i) => daysSince(i.submitted_date ?? i.created_at) > 60).length;
  const count90 = filteredUnpaid.filter((i) => daysSince(i.submitted_date ?? i.created_at) > 90).length;

  // ─── Doc Completeness Data ────────────────────────────────────────────────
  const activeJobs = jobs.filter((j) => j.status !== "closed");
  const activeDocCounts = docCounts.filter((c) => activeJobs.some((j) => j.id === c.job_id));

  const sortedDocJobs = [...activeDocCounts]
    .map((c) => ({ counts: c, job: jobMap[c.job_id]!, score: docScoreCalc(c) }))
    .filter((r) => r.job)
    .sort((a, b) => a.score - b.score); // worst first

  // ─── Payment Summary Data ─────────────────────────────────────────────────
  const invoicesByStatus = ["draft", "submitted", "partially_paid", "paid", "disputed", "void"] as const;

  const paidThisMonth = allInvoices.filter(
    (i) => i.status === "paid" && i.paid_date && i.paid_date >= currentMonthStart
  );
  const paidYTD = allInvoices.filter(
    (i) => i.status === "paid" && i.paid_date && i.paid_date >= currentYearStart
  );

  const totalPaidThisMonth = paidThisMonth.reduce((s, i) => s + (i.paid_cents ?? 0), 0);
  const totalPaidYTD = paidYTD.reduce((s, i) => s + (i.paid_cents ?? 0), 0);

  // ─── Render ───────────────────────────────────────────────────────────────

  const TABS: { key: ReportsTab; label: string; icon: React.ElementType }[] = [
    { key: "ar_aging", label: "AR Aging", icon: TrendingUp },
    { key: "doc_completeness", label: "Documentation", icon: FileText },
    { key: "payment_summary", label: "Payment Summary", icon: DollarSign },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white dark:bg-[#0A1628] border-b border-slate-200 dark:border-[#1E293B] px-6 py-4">
        <div className="flex items-center gap-3 mb-4">
          <BarChart2 size={22} className="text-[#F97316]" />
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Reports</h1>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={clsx(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-colors",
                activeTab === key
                  ? "bg-[#F97316]/15 text-[#F97316]"
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E293B]"
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* ── AR Aging ── */}
        {activeTab === "ar_aging" && (
          <div className="space-y-6 max-w-7xl">
            {/* KPI Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Total Outstanding AR", value: centsToDisplay(totalAR), color: "text-slate-800 dark:text-slate-200" },
                { label: "30+ Days", value: String(count30), color: "text-yellow-600 dark:text-yellow-400" },
                { label: "60+ Days", value: String(count60), color: "text-orange-600 dark:text-orange-400" },
                { label: "90+ Days", value: String(count90), color: "text-red-600 dark:text-red-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</p>
                </div>
              ))}
            </div>

            {/* Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold">Filter:</span>
              {(["all", "mitigation", "reconstruction", "tm"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setArFilter(f)}
                  className={clsx(
                    "px-3 py-1 rounded-lg text-xs font-bold transition-colors",
                    arFilter === f
                      ? "bg-[#F97316]/15 text-[#F97316]"
                      : "bg-slate-100 dark:bg-[#1E293B] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                  )}
                >
                  {f === "all" ? "All" : f === "mitigation" ? "Mitigation" : f === "reconstruction" ? "Reconstruction" : "T&M"}
                </button>
              ))}
            </div>

            {/* Table */}
            {sortedUnpaid.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <CheckCircle2 size={32} className="text-green-500 mx-auto mb-3" />
                <p className="text-slate-500 dark:text-slate-400 font-semibold">No outstanding AR</p>
                <p className="text-xs text-slate-400 dark:text-slate-600 mt-1">All invoices are paid or draft.</p>
              </div>
            ) : (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                        {["Job #", "Address", "Carrier", "Invoice #", "Type", "Amount", "Paid", "Balance", "Invoice Date", "Days Out", "Status"].map((h) => (
                          <th key={h} className="px-3 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUnpaid.map((inv) => {
                        const jobData = jobMap[inv.job_id];
                        const balance = inv.amount_cents - (inv.paid_cents ?? 0);
                        const invDate = inv.submitted_date ?? inv.created_at;
                        const days = daysSince(invDate);
                        return (
                          <tr
                            key={inv.id}
                            className={clsx("border-b border-slate-100 dark:border-[#1E293B] cursor-pointer hover:bg-[#F97316]/5 transition-colors", agingRowClass(days))}
                            onClick={() => jobData && navigate(`/jobs/${jobData.id}`)}
                          >
                            <td className="px-3 py-2.5 font-mono text-xs text-[#F97316] whitespace-nowrap">{jobData?.job_number ?? "—"}</td>
                            <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300 max-w-xs truncate">{jobData?.property_address ?? "—"}</td>
                            <td className="px-3 py-2.5 text-slate-600 dark:text-slate-400 whitespace-nowrap">{jobData?.insurance_carrier ?? "—"}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">{inv.invoice_number}</td>
                            <td className="px-3 py-2.5 text-slate-600 dark:text-slate-400 capitalize whitespace-nowrap">{inv.invoice_type.replace(/_/g, " ")}</td>
                            <td className="px-3 py-2.5 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{centsToDisplay(inv.amount_cents)}</td>
                            <td className="px-3 py-2.5 text-green-600 dark:text-green-400 whitespace-nowrap">{centsToDisplay(inv.paid_cents ?? 0)}</td>
                            <td className="px-3 py-2.5 font-bold text-slate-800 dark:text-slate-200 whitespace-nowrap">{centsToDisplay(balance)}</td>
                            <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatAlaskaDate(invDate)}</td>
                            <td className={clsx("px-3 py-2.5 font-bold whitespace-nowrap", days > 90 ? "text-red-600 dark:text-red-400" : days > 60 ? "text-orange-600 dark:text-orange-400" : days > 30 ? "text-yellow-600 dark:text-yellow-400" : "text-slate-600 dark:text-slate-400")}>
                              {days}d
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${INVOICE_STATUS_COLORS[inv.status]}`}>
                                {INVOICE_STATUS_LABELS[inv.status]}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Documentation Completeness ── */}
        {activeTab === "doc_completeness" && (
          <div className="space-y-6 max-w-7xl">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-500 dark:text-slate-400">Active jobs (not closed) — sorted by score (worst first)</p>
              <p className="text-xs text-slate-400 dark:text-slate-600">{sortedDocJobs.length} jobs</p>
            </div>

            {sortedDocJobs.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <FileText size={32} className="text-slate-400 mx-auto mb-3" />
                <p className="text-slate-500 dark:text-slate-400 font-semibold">No active jobs</p>
              </div>
            ) : (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                        {["Job #", "Address", "Status", "Score", "Photos Before", "Photos After", "Moisture", "Equipment", "Work Auth", "Estimate", "Invoice"].map((h) => (
                          <th key={h} className="px-3 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDocJobs.map(({ job: j, counts: c, score }) => {
                        const CheckIcon = ({ val }: { val: boolean }) =>
                          val
                            ? <CheckCircle2 size={14} className="text-green-500 mx-auto" />
                            : <XCircle size={14} className="text-red-400 dark:text-red-600 mx-auto" />;

                        return (
                          <tr
                            key={j.id}
                            className="border-b border-slate-100 dark:border-[#1E293B] cursor-pointer hover:bg-[#F97316]/5 transition-colors"
                            onClick={() => navigate(`/jobs/${j.id}`)}
                          >
                            <td className="px-3 py-2.5 font-mono text-xs text-[#F97316] whitespace-nowrap">{j.job_number}</td>
                            <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300 max-w-xs truncate">{j.property_address}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 capitalize">
                                {j.status.replace(/_/g, " ")}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                <div className="w-16 bg-slate-200 dark:bg-[#1E293B] rounded-full h-1.5">
                                  <div className={`${scoreColor(score)} h-1.5 rounded-full`} style={{ width: `${score}%` }} />
                                </div>
                                <span className={`text-xs font-bold ${scoreTextColor(score)}`}>{score}%</span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.photo_before > 0} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.photo_after > 0} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.moisture_count > 0} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.equipment_count > 0 && c.equipment_removed_count === c.equipment_count} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.has_work_auth} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.line_item_count > 0} /></td>
                            <td className="px-3 py-2.5 text-center"><CheckIcon val={c.invoice_submitted_count > 0} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Payment Summary ── */}
        {activeTab === "payment_summary" && (
          <div className="space-y-6 max-w-5xl">
            {/* KPI Row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider mb-1">Collected This Month</p>
                <p className="text-3xl font-bold text-green-600 dark:text-green-400">{centsToDisplay(totalPaidThisMonth)}</p>
                <p className="text-xs text-slate-400 dark:text-slate-600 mt-1">{paidThisMonth.length} payment{paidThisMonth.length !== 1 ? "s" : ""}</p>
              </div>
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider mb-1">Collected YTD</p>
                <p className="text-3xl font-bold text-green-600 dark:text-green-400">{centsToDisplay(totalPaidYTD)}</p>
                <p className="text-xs text-slate-400 dark:text-slate-600 mt-1">{paidYTD.length} payment{paidYTD.length !== 1 ? "s" : ""}</p>
              </div>
            </div>

            {/* Grouped by status */}
            {invoicesByStatus.map((status) => {
              const group = allInvoices.filter((i) => i.status === status);
              if (group.length === 0) return null;
              const total = group.reduce((s, i) => s + i.amount_cents, 0);
              return (
                <div key={status} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
                  {/* Group header */}
                  <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0F172A]">
                    <div className="flex items-center gap-3">
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${INVOICE_STATUS_COLORS[status]}`}>
                        {INVOICE_STATUS_LABELS[status]}
                      </span>
                      <span className="text-sm text-slate-500 dark:text-slate-400">{group.length} invoice{group.length !== 1 ? "s" : ""}</span>
                    </div>
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-200">{centsToDisplay(total)}</span>
                  </div>

                  {/* Invoice list */}
                  <div className="divide-y divide-slate-100 dark:divide-[#1E293B]">
                    {group.map((inv) => {
                      const jobData = jobMap[inv.job_id];
                      return (
                        <div
                          key={inv.id}
                          className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-[#F97316]/5 transition-colors"
                          onClick={() => jobData && navigate(`/jobs/${jobData.id}`)}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
                              {jobData?.property_address ?? "Unknown Job"}
                            </p>
                            <p className="text-xs text-slate-400 dark:text-slate-600">
                              {jobData?.job_number ?? "—"} · {inv.invoice_number} · {inv.invoice_type.replace(/_/g, " ")}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{centsToDisplay(inv.amount_cents)}</p>
                            <p className="text-xs text-slate-400 dark:text-slate-600">
                              {inv.submitted_date ? formatAlaskaDate(inv.submitted_date) : inv.paid_date ? formatAlaskaDate(inv.paid_date) : formatAlaskaDate(inv.created_at)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {allInvoices.length === 0 && (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <AlertCircle size={32} className="text-slate-400 mx-auto mb-3" />
                <p className="text-slate-500 dark:text-slate-400 font-semibold">No invoices yet</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
