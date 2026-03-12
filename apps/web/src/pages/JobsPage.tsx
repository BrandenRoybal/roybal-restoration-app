/**
 * Jobs list page with filter, search, and new job button.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, JobStatus } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_ORDER, formatAlaskaDate } from "@roybal/shared";
import { Plus, Search, X } from "lucide-react";
import clsx from "clsx";

const STATUS_COLORS: Record<JobStatus, string> = {
  new: "#64748B",
  active: "#F97316",
  drying: "#3B82F6",
  final_inspection: "#EAB308",
  invoicing: "#A855F7",
  closed: "#22C55E",
};

export default function JobsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialStatus = params.get("status") as JobStatus | null;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">(initialStatus ?? "all");

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("jobs").select("*").order("created_at", { ascending: false });
    if (statusFilter !== "all") query = query.eq("status", statusFilter);
    const { data } = await query;
    if (data) setJobs(data as Job[]);
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const filtered = jobs.filter((j) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      j.property_address.toLowerCase().includes(q) ||
      j.job_number.toLowerCase().includes(q) ||
      (j.owner_name ?? "").toLowerCase().includes(q) ||
      (j.claim_number ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Jobs</h1>
          <p className="text-slate-400 text-sm mt-1">{filtered.length} job{filtered.length !== 1 ? "s" : ""} shown</p>
        </div>
        <button
          onClick={() => navigate("/jobs/new")}
          className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-white font-bold px-4 h-10 rounded-xl transition-colors"
        >
          <Plus size={18} />
          New Job
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search address, job #, owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[#0A1628] border border-[#1E293B] rounded-xl pl-9 pr-9 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["all", ...JOB_STATUS_ORDER] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={clsx(
                "px-3 h-9 rounded-xl text-xs font-bold transition-colors border",
                statusFilter === s
                  ? "bg-[#F97316] border-[#F97316] text-white"
                  : "bg-[#0A1628] border-[#1E293B] text-slate-400 hover:text-slate-200"
              )}
            >
              {s === "all" ? "All" : JOB_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#1E293B]">
                {["Job #", "Address", "Owner", "Status", "Loss Type", "Date of Loss", "Carrier"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">No jobs found.</td></tr>
              ) : (
                filtered.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="border-b border-[#1E293B]/50 hover:bg-[#0F172A] cursor-pointer transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-slate-400 group-hover:text-[#F97316] transition-colors">
                        {job.job_number}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-200 font-semibold max-w-xs truncate">
                      {job.property_address}
                    </td>
                    <td className="px-4 py-3 text-slate-400 truncate">{job.owner_name ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2.5 py-1 rounded-full text-xs font-bold"
                        style={{
                          backgroundColor: (STATUS_COLORS[job.status] ?? "#64748B") + "22",
                          color: STATUS_COLORS[job.status] ?? "#64748B",
                        }}
                      >
                        {JOB_STATUS_LABELS[job.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 uppercase text-xs">
                      {job.loss_type ?? "—"} {job.loss_category ? `/ ${job.loss_category}` : ""}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatAlaskaDate(job.date_of_loss)}</td>
                    <td className="px-4 py-3 text-slate-400">{job.insurance_carrier ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
