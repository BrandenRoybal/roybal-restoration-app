/**
 * Dashboard — KPI cards + job pipeline kanban summary.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, JobStatus, MoistureReading, EquipmentLog } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_ORDER, centsToDisplay, formatAlaskaDate } from "@roybal/shared";
import {
  Briefcase,
  Droplets,
  FileText,
  HardDrive,
  DollarSign,
  ChevronRight,
  TrendingUp,
  CircleAlert,
  CircleCheckBig,
} from "lucide-react";

/** Per-job flags for the Drying Watch panel */
interface DryingFlag {
  job: Job;
  missingReading: boolean;
  stalledLocations: number;
  wetLocations: number;
  equipmentOver7d: number;
}

function computeDryingFlags(
  jobs: Job[],
  readings: MoistureReading[],
  equipment: EquipmentLog[]
): DryingFlag[] {
  const now = Date.now();
  const watchJobs = jobs.filter((j) => j.status === "active" || j.status === "drying");
  return watchJobs
    .map((job) => {
      const jobReadings = readings.filter((r) => r.job_id === job.id);

      // Latest reading recency (active/drying jobs should have daily readings)
      const lastDate = jobReadings.reduce<string | null>(
        (max, r) => (!max || r.reading_date > max ? r.reading_date : max),
        null
      );
      const missingReading =
        !lastDate || now - new Date(lastDate + "T00:00:00").getTime() > 36 * 3600 * 1000;

      // Group by monitoring location; compare the last two readings
      const byLocation = new Map<string, MoistureReading[]>();
      for (const r of jobReadings) {
        const key = `${r.room_id}|${r.location_description}|${r.material_type}`;
        if (!byLocation.has(key)) byLocation.set(key, []);
        byLocation.get(key)!.push(r);
      }
      let stalledLocations = 0;
      let wetLocations = 0;
      for (const locReadings of byLocation.values()) {
        const sorted = [...locReadings].sort((a, b) => a.reading_date.localeCompare(b.reading_date));
        const latest = sorted[sorted.length - 1];
        if (!latest || latest.is_dry) continue;
        wetLocations++;
        const previous = sorted[sorted.length - 2];
        if (previous && latest.moisture_pct >= previous.moisture_pct) stalledLocations++;
      }

      const equipmentOver7d = equipment.filter(
        (e) =>
          e.job_id === job.id &&
          !e.date_removed &&
          now - new Date(e.date_placed + "T00:00:00").getTime() >= 7 * 86400000
      ).length;

      return { job, missingReading, stalledLocations, wetLocations, equipmentOver7d };
    })
    .filter((f) => f.missingReading || f.stalledLocations > 0 || f.equipmentOver7d > 0)
    .sort((a, b) => b.stalledLocations - a.stalledLocations);
}

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
  const [dryingFlags, setDryingFlags] = useState<DryingFlag[] | null>(null);
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
          .select("*")
          .is("date_removed", null),
      ]);
      const jobRows = (jobsRes.data ?? []) as Job[];
      const equipRows = (equipRes.data ?? []) as EquipmentLog[];
      if (!jobsRes.error) setJobs(jobRows);
      setEquipmentCount(equipRows.length);
      setLoading(false);

      // Drying Watch: readings for active/drying jobs (last 14 days is plenty)
      const watchIds = jobRows
        .filter((j) => j.status === "active" || j.status === "drying")
        .map((j) => j.id);
      if (watchIds.length) {
        const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const { data: readings } = await supabase
          .from("moisture_readings")
          .select("*")
          .in("job_id", watchIds)
          .gte("reading_date", since);
        setDryingFlags(computeDryingFlags(jobRows, (readings ?? []) as MoistureReading[], equipRows));
      } else {
        setDryingFlags([]);
      }
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
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-1">Roybal Construction LLC — Field Operations</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4"
          >
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
              style={{ backgroundColor: kpi.color + "22" }}
            >
              <kpi.icon size={18} style={{ color: kpi.color }} />
            </div>
            <p className="text-2xl font-black text-white">{kpi.value}</p>
            <p className="text-xs font-semibold text-slate-400 mt-0.5">{kpi.label}</p>
            {kpi.sub && <p className="text-xs text-slate-600 mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* Drying Watch */}
      <div className="mb-3 flex items-center gap-2">
        <Droplets size={18} className="text-[#3B82F6]" />
        <h2 className="text-lg font-bold text-white">Drying Watch</h2>
        <span className="text-xs text-slate-500">daily check on every active/drying job</span>
      </div>
      <div className="mb-8">
        {dryingFlags === null ? (
          <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4 text-sm text-slate-500">Checking drying progress…</div>
        ) : dryingFlags.length === 0 ? (
          <div className="bg-[#0A1628] border border-green-500/20 rounded-2xl p-4 flex items-center gap-3">
            <CircleCheckBig size={18} className="text-green-400 flex-shrink-0" />
            <p className="text-sm text-slate-300">
              All active and drying jobs are on track — readings are current and moisture is trending down.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {dryingFlags.map((f) => (
              <button
                key={f.job.id}
                onClick={() => navigate(`/jobs/${f.job.id}`)}
                className="w-full text-left bg-[#0A1628] border border-amber-500/25 hover:border-amber-500/50 rounded-2xl p-4 flex items-start gap-3 transition-colors"
              >
                <CircleAlert size={18} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-200 truncate">
                    {f.job.property_address} <span className="text-xs font-mono text-slate-500 ml-1">{f.job.job_number}</span>
                  </p>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    {f.missingReading && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">No moisture reading in 24h+</span>
                    )}
                    {f.stalledLocations > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-semibold">
                        {f.stalledLocations} location{f.stalledLocations !== 1 ? "s" : ""} not drying down
                      </span>
                    )}
                    {f.wetLocations > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-semibold">
                        {f.wetLocations} still wet
                      </span>
                    )}
                    {f.equipmentOver7d > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">
                        {f.equipmentOver7d} unit{f.equipmentOver7d !== 1 ? "s" : ""} on site 7+ days
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} className="text-slate-600 flex-shrink-0 mt-1" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Job Pipeline */}
      <div className="mb-6 flex items-center gap-2">
        <TrendingUp size={18} className="text-[#F97316]" />
        <h2 className="text-lg font-bold text-white">Active Pipeline</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        {pipeline.map(({ status, jobs: statusJobs }) => (
          <div key={status} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: STATUS_COLORS[status] }}
              />
              <span className="text-xs font-bold text-slate-300">
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
                  className="w-full text-left bg-[#0F172A] rounded-xl p-3 border border-[#1E293B] hover:border-[#F97316]/40 transition-colors group"
                >
                  <p className="text-xs font-bold text-slate-300 truncate group-hover:text-white">
                    {job.property_address}
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">{job.job_number}</p>
                  {job.date_of_loss && (
                    <p className="text-xs text-slate-600">DOL: {formatAlaskaDate(job.date_of_loss)}</p>
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
                <p className="text-xs text-slate-700 px-1">No jobs</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
