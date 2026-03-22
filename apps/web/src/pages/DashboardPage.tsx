/**
 * Dashboard — KPI cards + job pipeline kanban summary.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, JobStatus } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_ORDER, centsToDisplay, formatAlaskaDate } from "@roybal/shared";
import {
  Briefcase,
  Droplets,
  FileText,
  HardDrive,
  DollarSign,
  ChevronRight,
  TrendingUp,
} from "lucide-react";

interface KPI {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}

const STATUS_COLORS: Record<JobStatus, string> = {
  new: "#64748B",
  active: "#F97316",
  drying: "#3B82F6",
  final_inspection: "#EAB308",
  invoicing: "#A855F7",
  closed: "#22C55E",
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [equipmentCount, setEquipmentCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboard = async () => {
      const [jobsRes, equipRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("*")
          .neq("status", "closed")
          .order("created_at", { ascending: false }),
        supabase
          .from("equipment_logs")
          .select("id", { count: "exact" })
          .is("date_removed", null),
      ]);
      if (!jobsRes.error && jobsRes.data) setJobs(jobsRes.data as Job[]);
      setEquipmentCount(equipRes.count ?? 0);
      setLoading(false);
    };
    fetchDashboard();
  }, []);

  const activeJobs = jobs.filter((j) => j.status === "active").length;
  const dryingJobs = jobs.filter((j) => j.status === "drying").length;
  const invoicingJobs = jobs.filter((j) => j.status === "invoicing");

  // Simplified AR estimate — count of invoicing jobs × $5000 average placeholder
  // In production this would sum line_items.total_cents
  const arEstimate = invoicingJobs.length * 500000; // cents placeholder

  const kpis: KPI[] = [
    {
      label: "Active Jobs",
      value: activeJobs,
      icon: Briefcase,
      color: "#F97316",
    },
    {
      label: "In Drying",
      value: dryingJobs,
      icon: Droplets,
      color: "#3B82F6",
    },
    {
      label: "Awaiting Invoice",
      value: invoicingJobs.length,
      icon: FileText,
      color: "#A855F7",
    },
    {
      label: "Equipment Out",
      value: equipmentCount,
      sub: "pieces deployed",
      icon: HardDrive,
      color: "#EAB308",
    },
    {
      label: "Open A/R (est.)",
      value: centsToDisplay(arEstimate),
      sub: "invoicing stage",
      icon: DollarSign,
      color: "#22C55E",
    },
  ];

  // Group active jobs by status for pipeline view
  const pipeline = JOB_STATUS_ORDER.filter((s) => s !== "closed").map((status) => ({
    status,
    jobs: jobs.filter((j) => j.status === status),
  }));

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
            {kpi.sub && <p className="text-xs text-slate-400 dark:text-slate-600 mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* Job Pipeline */}
      <div className="mb-6 flex items-center gap-2">
        <TrendingUp size={18} className="text-[#F97316]" />
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">Active Pipeline</h2>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="w-6 h-6 border-2 border-[#F97316] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
          {pipeline.map(({ status, jobs: statusJobs }) => (
            <div key={status} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: STATUS_COLORS[status] }}
                />
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  {JOB_STATUS_LABELS[status]}
                </span>
                <span
                  className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: STATUS_COLORS[status] + "22",
                    color: STATUS_COLORS[status],
                  }}
                >
                  {statusJobs.length}
                </span>
              </div>

              <div className="space-y-2">
                {statusJobs.slice(0, 4).map((job) => (
                  <button
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="w-full text-left bg-slate-50 dark:bg-[#0F172A] rounded-xl p-3 border border-slate-200 dark:border-[#1E293B] hover:border-[#F97316]/40 transition-colors group"
                  >
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate group-hover:text-slate-900 dark:group-hover:text-white">
                      {job.property_address}
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-600 mt-0.5">{job.job_number}</p>
                    {job.date_of_loss && (
                      <p className="text-xs text-slate-400 dark:text-slate-600">DOL: {formatAlaskaDate(job.date_of_loss)}</p>
                    )}
                  </button>
                ))}
                {statusJobs.length > 4 && (
                  <button
                    onClick={() => navigate(`/jobs?status=${status}`)}
                    className="flex items-center gap-1 text-xs text-[#F97316] hover:underline w-full px-1"
                  >
                    +{statusJobs.length - 4} more <ChevronRight size={12} />
                  </button>
                )}
                {statusJobs.length === 0 && (
                  <p className="text-xs text-slate-400 dark:text-slate-700 px-1">No jobs</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
