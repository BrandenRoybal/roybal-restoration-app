/**
 * Jobs list page with filter, search, new job button, and delete.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, JobStatus } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_ORDER, JOB_STATUS_COLORS, formatAlaskaDate } from "@roybal/shared";
import { Plus, Search, X, Trash2, Flame } from "lucide-react";
import clsx from "clsx";

export default function JobsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialStatus = params.get("status") as JobStatus | null;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">(initialStatus ?? "all");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const handleDelete = async (jobId: string) => {
    setDeleting(true);
    await supabase.from("jobs").delete().eq("id", jobId);
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setConfirmDeleteId(null);
    setDeleting(false);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Jobs</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{filtered.length} job{filtered.length !== 1 ? "s" : ""} shown</p>
        </div>
        <button
          onClick={() => navigate("/jobs/new")}
          className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-10 rounded-xl transition-colors"
        >
          <Plus size={18} />
          New Job
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            placeholder="Search address, job #, owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white dark:bg-[#0A1628] border border-slate-300 dark:border-[#1E293B] rounded-xl pl-9 pr-9 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
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
                  ? "bg-[#F97316] border-[#F97316] text-[#0F172A]"
                  : "bg-white dark:bg-[#0A1628] border-slate-200 dark:border-[#1E293B] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
              )}
            >
              {s === "all" ? "All" : JOB_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                {["Job #", "Address", "Owner", "Status", "Loss Type", "Date of Loss", "Carrier", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400 dark:text-slate-600">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400 dark:text-slate-600">No jobs found.</td></tr>
              ) : (
                filtered.map((job) => (
                  confirmDeleteId === job.id ? (
                    <tr key={job.id} className="border-b border-slate-200/50 dark:border-[#1E293B]/50 bg-red-50 dark:bg-red-950/20">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <p className="text-sm text-red-600 dark:text-red-300 flex-1">
                            Delete <span className="font-bold">{job.job_number} — {job.property_address}</span>? This cannot be undone.
                          </p>
                          <button
                            onClick={() => handleDelete(job.id)}
                            disabled={deleting}
                            className="px-3 h-8 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg disabled:opacity-60 transition-colors"
                          >
                            {deleting ? "Deleting…" : "Yes, Delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-3 h-8 bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg hover:bg-slate-200 dark:hover:bg-[#4A4440] transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={job.id}
                      className="border-b border-slate-200/50 dark:border-[#1E293B]/50 hover:bg-slate-50 dark:hover:bg-[#0F172A] cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3" onClick={() => navigate(`/jobs/${job.id}`)}>
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400 group-hover:text-[#F97316] transition-colors">
                          {job.job_number}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-800 dark:text-slate-200 font-semibold max-w-xs" onClick={() => navigate(`/jobs/${job.id}`)}>
                        <div className="flex items-center gap-2">
                          {job.is_emergency && <span title="Emergency"><Flame size={13} className="text-red-500 flex-shrink-0" /></span>}
                          <span className="truncate">{job.property_address}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400 truncate" onClick={() => navigate(`/jobs/${job.id}`)}>{job.owner_name ?? "—"}</td>
                      <td className="px-4 py-3" onClick={() => navigate(`/jobs/${job.id}`)}>
                        <span className={clsx("px-2.5 py-1 rounded-full text-xs font-bold", JOB_STATUS_COLORS[job.status] ?? "bg-slate-100 text-slate-600")}>
                          {JOB_STATUS_LABELS[job.status] ?? job.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400 uppercase text-xs" onClick={() => navigate(`/jobs/${job.id}`)}>
                        {job.loss_type ?? "—"} {job.loss_category ? `/ ${job.loss_category}` : ""}
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400" onClick={() => navigate(`/jobs/${job.id}`)}>{formatAlaskaDate(job.date_of_loss)}</td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400" onClick={() => navigate(`/jobs/${job.id}`)}>{job.insurance_carrier ?? "—"}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(job.id); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                          title="Delete job"
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  )
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
