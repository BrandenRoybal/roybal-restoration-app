/**
 * FloorPlanEditorPage — full-screen route wrapper for the canvas floor plan editor.
 * Route: /jobs/:jobId/floor-plans/:planId
 *
 * Handles:
 *   - Loading job + plan metadata
 *   - Plan rename via toolbar callback
 *   - Back navigation to job
 */

import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import FloorPlanEditor from "../components/floorplan/FloorPlanEditor";
import type { Job, CanvasPlan } from "@roybal/shared";

export default function FloorPlanEditorPage() {
  const { jobId, planId } = useParams<{ jobId: string; planId: string }>();
  const navigate = useNavigate();

  const [job, setJob] = useState<Job | null>(null);
  const [plan, setPlan] = useState<CanvasPlan | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!jobId || !planId) return;
    Promise.all([
      supabase.from("jobs").select("id,job_number,property_address").eq("id", jobId).single(),
      supabase.from("canvas_plans").select("*").eq("id", planId).single(),
    ]).then(([jobRes, planRes]) => {
      if (jobRes.data) setJob(jobRes.data as unknown as Job);
      if (planRes.data) setPlan(planRes.data as CanvasPlan);
      setLoading(false);
    });
  }, [jobId, planId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#080500]">
        <Loader2 className="animate-spin text-[#C9A84C]" size={32} />
      </div>
    );
  }

  if (!jobId || !planId) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#080500] text-red-400">
        Missing job or plan ID.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#080500] overflow-hidden">
      {/* Top nav bar */}
      <div className="flex items-center gap-3 px-4 h-11 bg-[#080500] border-b border-[#2C1E00] shrink-0 z-10">
        <button
          onClick={() => navigate(`/jobs/${jobId}?tab=floorplan`)}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ChevronLeft size={16} />
          {job?.job_number ?? "Job"}
        </button>
        <span className="text-slate-600">·</span>
        <span className="text-sm text-slate-500 truncate max-w-xs">
          {job?.property_address ?? ""}
        </span>
        <span className="text-slate-600 ml-auto text-xs">
          {plan?.level_name ?? ""}
        </span>
      </div>

      {/* Editor fills remaining height */}
      <div className="flex-1 overflow-hidden">
        <FloorPlanEditor planId={planId} jobId={jobId} />
      </div>
    </div>
  );
}
