/**
 * Dashboard — KPI cards + job pipeline kanban summary.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, JobStatus, Invoice, Task } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_COLORS, JOB_STATUS_ORDER, centsToDisplay, formatAlaskaDate } from "@roybal/shared";
import {
  Briefcase,
  Flame,
  Droplets,
  ClipboardList,
  DollarSign,
  TrendingUp,
  ChevronRight,
  AlertCircle,
} from "lucide-react";

interface Profile {
  id: string;
  full_name: string;
}

// 5 pipeline groups (excluding closed)
const PIPELINE_GROUPS: { label: string; statuses: JobStatus[] }[] = [
  { label: "Intake", statuses: ["lead", "inspection_scheduled", "inspection_complete"] },
  { label: "Mitigation", statuses: ["emergency_services", "mitigation_active", "monitoring", "mitigation_complete"] },
  { label: "Estimate", statuses: ["estimate_pending", "estimate_approved"] },
  { label: "Reconstruction", statuses: ["reconstruction_active", "punch_list"] },
  { label: "Billing", statuses: ["invoice_submitted", "payment_pending"] },
];

const GROUP_COLORS: Record<string, string> = {
  Intake: "#64748B",
  Mitigation: "#F97316",
  Estimate: "#A855F7",
  Reconstruction: "#3B82F6",
  Billing: "#22C55E",
};

function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [overdueTasks, setOverdueTasks] = useState<Task[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboard = async () => {
      const today = new Date().toISOString().split("T")[0];
      const [jobsRes, invoicesRes, tasksRes, profilesRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("*")
          .neq("status", "closed")
          .order("created_at", { ascending: false }),
        supabase
          .from("invoices")
          .select("*")
          .not("status", "in", '("paid","void")'),
        supabase
          .from("tasks")
          .select("*")
          .eq("status", "open")
          .lt("due_date", today ?? "")
          .order("due_date", { ascending: true })
          .limit(10),
        supabase.from("profiles").select("id, full_name"),
      ]);
      if (!jobsRes.error && jobsRes.data) setJobs(jobsRes.data as Job[]);
      if (!invoicesRes.error && invoicesRes.data) setInvoices(invoicesRes.data as Invoice[]);
      if (!tasksRes.error && tasksRes.data) setOverdueTasks(tasksRes.data as Task[]);
      if (!profilesRes.error && profilesRes.data) setProfiles(profilesRes.data as Profile[]);
      setLoading(false);
    };
    fetchDashboard();
  }, []);

  const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.full_name]));

  // KPI computations
  const activeJobs = jobs.filter((j) => j.status !== "lead").length;
  const emergencyJobs = jobs.filter((j) => j.is_emergency).length;
  const monitoringJobs = jobs.filter((j) => j.status === "monitoring").length;
  const estimatePendingJobs = jobs.filter((j) => j.status === "estimate_pending").length;
  const openAR = invoices.reduce((sum, inv) => sum + (inv.amount_cents - inv.paid_cents), 0);

  const kpis = [
    { label: "Active Jobs", value: activeJobs, icon: Briefcase, color: "#F97316" },
    { label: "Emergency", value: emergencyJobs, icon: Flame, color: "#EF4444" },
    { label: "Monitoring", value: monitoringJobs, icon: Droplets, color: "#3B82F6" },
    { label: "Awaiting Estimate", value: estimatePendingJobs, icon: ClipboardList, color: "#A855F7" },
    { label: "Outstanding A/R", value: centsToDisplay(openAR), icon: DollarSign, color: "#22C55E" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Dashboard</h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Roybal Construction LLC — Field Operations</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4"
          >
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
              style={{ backgroundColor: kpi.color + "22" }}
            >
              <kpi.icon size={18} style={{ color: kpi.color }} />
            </div>
            <p className="text-2xl font-black text-slate-900 dark:text-white">{kpi.value}</p>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-0.5">{kpi.label}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="w-6 h-6 border-2 border-[#F97316] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Overdue Tasks */}
          {overdueTasks.length > 0 && (
            <div className="mb-8 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle size={16} className="text-red-500" />
                <h2 className="text-sm font-bold text-red-700 dark:text-red-400">Overdue Tasks ({overdueTasks.length})</h2>
              </div>
              <div className="space-y-1.5">
                {overdueTasks.slice(0, 5).map((task) => (
                  <div key={task.id} className="flex items-center gap-3 text-sm">
                    <span className="text-red-400 text-xs font-mono">{task.due_date}</span>
                    <span className="text-slate-800 dark:text-slate-200 flex-1 truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Job Pipeline */}
          <div className="mb-6 flex items-center gap-2">
            <TrendingUp size={18} className="text-[#F97316]" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Active Pipeline</h2>
            <span className="text-xs text-slate-400 dark:text-slate-600 ml-1">(closed jobs not shown)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
            {PIPELINE_GROUPS.map(({ label, statuses }) => {
              const groupJobs = jobs.filter((j) => statuses.includes(j.status));
              const color = GROUP_COLORS[label] ?? "#64748B";
              return (
                <div key={label} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{label}</span>
                    <span
                      className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: color + "22", color }}
                    >
                      {groupJobs.length}
                    </span>
                  </div>

                  {/* Sub-status breakdown */}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {statuses.map((s) => {
                      const count = jobs.filter((j) => j.status === s).length;
                      if (count === 0) return null;
                      return (
                        <span key={s} className={`px-1.5 py-0.5 rounded text-xs font-semibold ${JOB_STATUS_COLORS[s]}`}>
                          {count} {JOB_STATUS_LABELS[s]}
                        </span>
                      );
                    })}
                  </div>

                  <div className="space-y-2">
                    {groupJobs.slice(0, 4).map((job) => {
                      const dol = daysSince(job.date_of_loss);
                      const pmName = job.assigned_pm_id ? profileMap[job.assigned_pm_id] : null;
                      return (
                        <button
                          key={job.id}
                          onClick={() => navigate(`/jobs/${job.id}`)}
                          className="w-full text-left bg-slate-50 dark:bg-[#0F172A] rounded-xl p-3 border border-slate-200 dark:border-[#1E293B] hover:border-[#F97316]/40 transition-colors group"
                        >
                          <div className="flex items-start gap-1.5 mb-1">
                            {job.is_emergency && <Flame size={11} className="text-red-500 flex-shrink-0 mt-0.5" />}
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate group-hover:text-slate-900 dark:group-hover:text-white flex-1">
                              {job.property_address}
                            </p>
                          </div>
                          <div className="flex items-center justify-between gap-1">
                            <p className="text-xs text-slate-400 dark:text-slate-600">{job.job_number}</p>
                            {dol !== null && (
                              <p className="text-xs text-slate-400 dark:text-slate-600">DOL +{dol}d</p>
                            )}
                          </div>
                          <div className="flex items-center justify-between mt-1">
                            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${JOB_STATUS_COLORS[job.status]}`}>
                              {JOB_STATUS_LABELS[job.status]}
                            </span>
                            {pmName && (
                              <span className="text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400 px-1.5 py-0.5 rounded font-mono">
                                {getInitials(pmName)}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                    {groupJobs.length > 4 && (
                      <button
                        onClick={() => navigate(`/jobs?status=${statuses[0]}`)}
                        className="flex items-center gap-1 text-xs text-[#F97316] hover:underline w-full px-1"
                      >
                        +{groupJobs.length - 4} more <ChevronRight size={12} />
                      </button>
                    )}
                    {groupJobs.length === 0 && (
                      <p className="text-xs text-slate-400 dark:text-slate-700 px-1">No jobs</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Status breakdown reference */}
          <div className="mt-6 bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4">
            <p className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">All Status Counts</p>
            <div className="flex flex-wrap gap-2">
              {JOB_STATUS_ORDER.filter((s) => s !== "closed").map((s) => {
                const count = jobs.filter((j) => j.status === s).length;
                return (
                  <button
                    key={s}
                    onClick={() => navigate(`/jobs?status=${s}`)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold transition-opacity hover:opacity-80 ${JOB_STATUS_COLORS[s]}`}
                  >
                    {JOB_STATUS_LABELS[s]} {count > 0 ? `(${count})` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
