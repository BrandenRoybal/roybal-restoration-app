/**
 * Job Detail page — full tabbed view with all modules.
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, Room, MoistureReading, EquipmentLog, LineItem, FloorPlan, Photo } from "@roybal/shared";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_ORDER,
  formatAlaskaDate,
  formatAlaskaDateTime,
  centsToDisplay,
  getMoistureStatus,
  EQUIPMENT_TYPE_LABELS,
} from "@roybal/shared";
import { ChevronLeft, ExternalLink, Trash2, Link, RefreshCw, Plus } from "lucide-react";
import clsx from "clsx";
import { MagicplanService } from "@roybal/shared";

const getMagicplanService = () => {
  const apiKey = import.meta.env.VITE_MAGICPLAN_API_KEY as string | undefined;
  const customerId = import.meta.env.VITE_MAGICPLAN_CUSTOMER_ID as string | undefined;
  if (!apiKey || !customerId || apiKey === "your-magicplan-api-key") return null;
  return new MagicplanService(apiKey, customerId);
};

type Tab = "overview" | "photos" | "moisture" | "equipment" | "scope" | "floorplan" | "report";

const STATUS_COLORS: Record<string, string> = {
  new: "#64748B", active: "#C9A84C", drying: "#3B82F6",
  final_inspection: "#EAB308", invoicing: "#A855F7", closed: "#22C55E",
};

const MOISTURE_COLORS = { dry: "#22C55E", monitoring: "#EAB308", wet: "#EF4444" };

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [moisture, setMoisture] = useState<MoistureReading[]>([]);
  const [equipment, setEquipment] = useState<EquipmentLog[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [magicplanInput, setMagicplanInput] = useState("");
  const [magicplanEditing, setMagicplanEditing] = useState(false);
  const [magicplanSaving, setMagicplanSaving] = useState(false);
  const [magicplanCreating, setMagicplanCreating] = useState(false);
  const [magicplanSyncing, setMagicplanSyncing] = useState(false);
  const [magicplanError, setMagicplanError] = useState("");

  useEffect(() => {
    if (!id) return;
    Promise.all([
      supabase.from("jobs").select("*").eq("id", id).single(),
      supabase.from("rooms").select("*").eq("job_id", id).order("name"),
      supabase.from("moisture_readings").select("*").eq("job_id", id).order("reading_date", { ascending: false }),
      supabase.from("equipment_logs").select("*").eq("job_id", id).order("date_placed"),
      supabase.from("line_items").select("*").eq("job_id", id).order("sort_order"),
      supabase.from("photos").select("*").eq("job_id", id).order("taken_at", { ascending: false }),
      supabase.from("floor_plans").select("*").eq("job_id", id).order("version", { ascending: false }),
    ]).then(([j, r, m, e, l, p, fp]) => {
      if (!j.error && j.data) {
        const jobData = j.data as Job;
        setJob(jobData);
        setMagicplanInput(jobData.magicplan_project_id ?? "");
      }
      if (!r.error) setRooms((r.data ?? []) as Room[]);
      if (!m.error) setMoisture((m.data ?? []) as MoistureReading[]);
      if (!e.error) setEquipment((e.data ?? []) as EquipmentLog[]);
      if (!l.error) setLineItems((l.data ?? []) as LineItem[]);
      if (!p.error) setPhotos((p.data ?? []) as Photo[]);
      if (!fp.error) setFloorPlans((fp.data ?? []) as FloorPlan[]);
      setLoading(false);
    });
  }, [id]);

  const setStatus = async (status: string) => {
    if (!job || job.status === status) return;
    const { data } = await supabase.from("jobs").update({ status }).eq("id", job.id).select().single();
    if (data) setJob(data as Job);
  };

  const deleteJob = async () => {
    if (!job) return;
    setDeleting(true);
    await supabase.from("jobs").delete().eq("id", job.id);
    navigate("/jobs");
  };

  const createMagicplanProject = async () => {
    if (!job) return;
    const mp = getMagicplanService();
    if (!mp) { setMagicplanError("Magicplan API key not configured. Add VITE_MAGICPLAN_API_KEY to .env"); return; }
    setMagicplanCreating(true);
    setMagicplanError("");
    try {
      const { magicplanProjectId } = await mp.createProject(job.id, job);
      const { data } = await supabase
        .from("jobs")
        .update({ magicplan_project_id: magicplanProjectId })
        .eq("id", job.id)
        .select()
        .single();
      if (data) { setJob(data as Job); setMagicplanInput(magicplanProjectId); }
    } catch (err) {
      setMagicplanError(err instanceof Error ? err.message : "Failed to create project");
    }
    setMagicplanCreating(false);
  };

  const syncFromMagicplan = async () => {
    if (!job?.magicplan_project_id) return;
    const mp = getMagicplanService();
    if (!mp) { setMagicplanError("Magicplan API key not configured. Add VITE_MAGICPLAN_API_KEY to .env"); return; }
    setMagicplanSyncing(true);
    setMagicplanError("");
    try {
      const { fileUrl, fileType } = await mp.syncFloorPlan(job.magicplan_project_id);
      if (fileUrl) {
        const nextVersion = (floorPlans[0]?.version ?? 0) + 1;
        const { data } = await supabase
          .from("floor_plans")
          .insert({ job_id: job.id, file_url: fileUrl, file_type: fileType ?? "pdf", version: nextVersion, synced_at: new Date().toISOString() })
          .select()
          .single();
        if (data) setFloorPlans((prev) => [data as FloorPlan, ...prev]);
      } else {
        setMagicplanError("No files found in this Magicplan project yet.");
      }
    } catch (err) {
      setMagicplanError(err instanceof Error ? err.message : "Sync failed");
    }
    setMagicplanSyncing(false);
  };

  const saveMagicplanId = async () => {
    if (!job) return;
    setMagicplanSaving(true);
    const value = magicplanInput.trim() || null;
    const { data } = await supabase
      .from("jobs")
      .update({ magicplan_project_id: value })
      .eq("id", job.id)
      .select()
      .single();
    if (data) setJob(data as Job);
    setMagicplanEditing(false);
    setMagicplanSaving(false);
  };

  const totalCents = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "photos", label: `Photos (${photos.length})` },
    { key: "moisture", label: `Moisture (${moisture.length})` },
    { key: "equipment", label: `Equipment (${equipment.length})` },
    { key: "scope", label: `Scope (${centsToDisplay(totalCents)})` },
    { key: "floorplan", label: "Floor Plan" },
    { key: "report", label: "Reports" },
  ];

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#C9A84C] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-6 text-slate-500">Job not found.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-[#2B1D09] border-b border-[#4A3318] px-6 py-4">
        <div className="flex items-start gap-4 flex-wrap">
          <button onClick={() => navigate("/jobs")} className="text-slate-400 hover:text-slate-200 mt-0.5">
            <ChevronLeft size={22} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-mono text-slate-500">{job.job_number}</span>

              {/* Status toggle — all 6 statuses */}
              <div className="flex items-center gap-1 flex-wrap">
                {JOB_STATUS_ORDER.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={clsx(
                      "px-2.5 py-0.5 rounded-full text-xs font-bold transition-colors border",
                      job.status === s
                        ? "border-transparent"
                        : "border-transparent opacity-30 hover:opacity-70"
                    )}
                    style={
                      job.status === s
                        ? { backgroundColor: (STATUS_COLORS[s] ?? "#64748B") + "22", color: STATUS_COLORS[s] ?? "#64748B" }
                        : { backgroundColor: (STATUS_COLORS[s] ?? "#64748B") + "15", color: STATUS_COLORS[s] ?? "#64748B" }
                    }
                    title={`Set to ${JOB_STATUS_LABELS[s]}`}
                  >
                    {JOB_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>

              {/* Delete button */}
              {confirmDelete ? (
                <div className="flex items-center gap-2 ml-2">
                  <span className="text-xs text-red-400">Delete this job?</span>
                  <button
                    onClick={deleteJob}
                    disabled={deleting}
                    className="text-xs font-bold text-white bg-red-600 hover:bg-red-700 px-2 py-0.5 rounded disabled:opacity-60 transition-colors"
                  >
                    {deleting ? "…" : "Yes"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-xs font-bold text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-red-400 transition-colors ml-2"
                  title="Delete job"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <h1 className="text-xl font-bold text-white mt-1 truncate">{job.property_address}</h1>
            <p className="text-sm text-slate-400">
              {job.loss_type?.toUpperCase()} {job.loss_category ? `· ${job.loss_category.toUpperCase()}` : ""}
              {job.date_of_loss ? ` · DOL: ${formatAlaskaDate(job.date_of_loss)}` : ""}
            </p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mt-4 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                "px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-colors",
                activeTab === tab.key
                  ? "bg-[#C9A84C]/15 text-[#C9A84C]"
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#4A3318]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 max-w-6xl">
            <InfoCard title="Loss Details">
              <InfoPair label="Type" value={`${job.loss_type?.toUpperCase() ?? "—"} / ${job.loss_category?.toUpperCase() ?? "—"}`} />
              <InfoPair label="Date of Loss" value={formatAlaskaDate(job.date_of_loss)} />
              <InfoPair label="Notes" value={job.notes ?? "—"} />
            </InfoCard>
            <InfoCard title="Property Owner">
              <InfoPair label="Name" value={job.owner_name ?? "—"} />
              <InfoPair label="Phone" value={job.owner_phone ?? "—"} />
              <InfoPair label="Email" value={job.owner_email ?? "—"} />
            </InfoCard>
            <InfoCard title="Insurance">
              <InfoPair label="Carrier" value={job.insurance_carrier ?? "—"} />
              <InfoPair label="Claim #" value={job.claim_number ?? "—"} />
              <InfoPair label="Adjuster" value={job.adjuster_name ?? "—"} />
              <InfoPair label="Adj. Phone" value={job.adjuster_phone ?? "—"} />
              <InfoPair label="Adj. Email" value={job.adjuster_email ?? "—"} />
            </InfoCard>
            <InfoCard title="Rooms">
              {rooms.length === 0 ? (
                <p className="text-slate-600 text-sm">No rooms added yet.</p>
              ) : (
                <div className="space-y-1">
                  {rooms.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-sm">
                      <span className={clsx("w-2 h-2 rounded-full", r.affected ? "bg-[#EF4444]" : "bg-[#22C55E]")} />
                      <span className="text-slate-200">{r.name}</span>
                      <span className="text-slate-500 text-xs ml-auto">{r.floor_level}</span>
                    </div>
                  ))}
                </div>
              )}
            </InfoCard>
            <InfoCard title="Meta">
              <InfoPair label="Created" value={formatAlaskaDateTime(job.created_at)} />
              <InfoPair label="Updated" value={formatAlaskaDateTime(job.updated_at)} />
              <InfoPair label="Job #" value={job.job_number} />
            </InfoCard>
          </div>
        )}

        {activeTab === "moisture" && (
          <div className="max-w-5xl">
            <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#4A3318]">
                      {["Date", "Room", "Location", "Material", "Reading", "Status"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moisture.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-600">No moisture readings yet.</td></tr>
                    ) : moisture.map((m) => {
                      const status = getMoistureStatus(m.moisture_pct, m.material_type);
                      return (
                        <tr key={m.id} className="border-b border-[#4A3318]/50">
                          <td className="px-4 py-3 text-slate-400 text-xs">{formatAlaskaDate(m.reading_date)}</td>
                          <td className="px-4 py-3 text-slate-300">{roomMap[m.room_id] ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-300">{m.location_description}</td>
                          <td className="px-4 py-3 text-slate-400">{m.material_type}</td>
                          <td className="px-4 py-3 font-mono font-bold" style={{ color: MOISTURE_COLORS[status] }}>{m.moisture_pct}%</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: MOISTURE_COLORS[status] + "22", color: MOISTURE_COLORS[status] }}>
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "equipment" && (
          <div className="max-w-5xl">
            <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#4A3318]">
                      {["Equipment", "Asset #", "Room", "Placed", "Removed", "Days"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {equipment.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-600">No equipment logged.</td></tr>
                    ) : equipment.map((e) => (
                      <tr key={e.id} className="border-b border-[#4A3318]/50">
                        <td className="px-4 py-3">
                          <p className="text-slate-200 font-semibold">{e.equipment_name}</p>
                          <p className="text-slate-500 text-xs">{EQUIPMENT_TYPE_LABELS[e.equipment_type]}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-400 font-mono text-xs">{e.asset_number ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-400">{e.room_id ? (roomMap[e.room_id] ?? "—") : "—"}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{formatAlaskaDate(e.date_placed)}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{e.date_removed ? formatAlaskaDate(e.date_removed) : <span className="text-[#C9A84C]">Active</span>}</td>
                        <td className="px-4 py-3 font-bold text-slate-200">{e.days_on_site}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "scope" && (
          <div className="max-w-5xl">
            <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#4A3318]">
                      {["Category", "Description", "Room", "Qty", "Unit", "Unit Price", "Total"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">No line items.</td></tr>
                    ) : lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-[#4A3318]/50">
                        <td className="px-4 py-3 text-xs text-slate-500 uppercase">{li.category}</td>
                        <td className="px-4 py-3 text-slate-200">{li.description}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{li.room_id ? (roomMap[li.room_id] ?? "—") : "All"}</td>
                        <td className="px-4 py-3 text-slate-300">{li.quantity}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">{li.unit}</td>
                        <td className="px-4 py-3 text-slate-300 font-mono">{centsToDisplay(li.unit_price)}</td>
                        <td className="px-4 py-3 font-bold text-slate-200 font-mono">{centsToDisplay(li.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {lineItems.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-[#4A3318] bg-[#140D03]">
                        <td colSpan={6} className="px-4 py-3 text-right font-bold text-slate-300">Grand Total</td>
                        <td className="px-4 py-3 font-black text-white font-mono text-base">{centsToDisplay(totalCents)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "floorplan" && (
          <div className="max-w-4xl space-y-4">
            {/* Magicplan project link */}
            <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Link size={16} className="text-[#C9A84C]" />
                <h3 className="text-sm font-bold text-slate-300">Magicplan Project</h3>
              </div>

              {job.magicplan_project_id && !magicplanEditing ? (
                <div className="flex items-center gap-3">
                  <code className="text-sm font-mono text-[#C9A84C] bg-[#4A3318] px-3 py-1.5 rounded-lg flex-1 truncate">
                    {job.magicplan_project_id}
                  </code>
                  <button
                    onClick={() => { setMagicplanInput(job.magicplan_project_id ?? ""); setMagicplanEditing(true); }}
                    className="text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors px-3 py-1.5 rounded-lg border border-[#4A3318] hover:border-[#6B4A20]"
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={magicplanInput}
                    onChange={(e) => setMagicplanInput(e.target.value)}
                    placeholder="Enter Magicplan project ID…"
                    className="flex-1 bg-[#140D03] border border-[#4A3318] rounded-xl px-4 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#C9A84C] transition-colors font-mono"
                  />
                  <button
                    onClick={saveMagicplanId}
                    disabled={magicplanSaving}
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#C9A84C] hover:bg-[#A8842A] text-[#140D03] px-3 h-10 rounded-xl disabled:opacity-60 transition-colors"
                  >
                    <RefreshCw size={13} className={magicplanSaving ? "animate-spin" : ""} />
                    {magicplanSaving ? "Saving…" : "Save"}
                  </button>
                  {magicplanEditing && (
                    <button
                      onClick={() => setMagicplanEditing(false)}
                      className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}

              {!job.magicplan_project_id && !magicplanEditing && (
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <button
                    onClick={createMagicplanProject}
                    disabled={magicplanCreating}
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#C9A84C]/10 border border-[#C9A84C]/30 text-[#C9A84C] px-3 h-8 rounded-lg hover:bg-[#C9A84C]/20 disabled:opacity-60 transition-colors"
                  >
                    <Plus size={12} className={magicplanCreating ? "animate-spin" : ""} />
                    {magicplanCreating ? "Creating…" : "Create in Magicplan"}
                  </button>
                  <p className="text-xs text-slate-600">
                    or paste a project ID above to link an existing one
                  </p>
                </div>
              )}
              {job.magicplan_project_id && (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={syncFromMagicplan}
                    disabled={magicplanSyncing}
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#C9A84C]/10 border border-[#C9A84C]/30 text-[#C9A84C] px-3 h-8 rounded-lg hover:bg-[#C9A84C]/20 disabled:opacity-60 transition-colors"
                  >
                    <RefreshCw size={12} className={magicplanSyncing ? "animate-spin" : ""} />
                    {magicplanSyncing ? "Syncing…" : "Sync Now"}
                  </button>
                  <p className="text-xs text-slate-600">Floor plans also auto-sync via webhook when exported.</p>
                </div>
              )}
              {magicplanError && (
                <p className="text-xs text-red-400 mt-2">{magicplanError}</p>
              )}
            </div>

            {/* Floor plan versions */}
            {floorPlans.length === 0 ? (
              <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-12 text-center">
                <p className="text-slate-500 mb-2">No floor plans synced yet.</p>
                <p className="text-slate-600 text-sm">
                  {job.magicplan_project_id
                    ? "Export a floor plan from Magicplan — it will appear here automatically."
                    : "Link a Magicplan project above to get started."}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {floorPlans.map((fp) => (
                  <div key={fp.id} className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-4 flex items-center gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-200">Version {fp.version}</p>
                      <p className="text-xs text-slate-500">Synced: {formatAlaskaDateTime(fp.synced_at)}</p>
                    </div>
                    {fp.file_url && (
                      <a href={fp.file_url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 text-sm font-bold text-[#C9A84C] hover:underline">
                        View <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "photos" && (
          <div className="max-w-5xl">
            {photos.length === 0 ? (
              <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-12 text-center">
                <p className="text-slate-500">No photos uploaded yet. Use the mobile app to capture photos on-site.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {photos.map((p) => (
                  <div key={p.id} className="relative bg-[#2B1D09] border border-[#4A3318] rounded-xl overflow-hidden aspect-square">
                    <div className="w-full h-full bg-[#4A3318] flex items-center justify-center text-slate-600 text-xs">{p.category}</div>
                    {p.caption && (
                      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1">
                        <p className="text-white text-xs truncate">{p.caption}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "report" && (
          <div className="max-w-2xl">
            <p className="text-slate-400 text-sm mb-6">Generate and download PDF reports for this job.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { title: "Photo Report", desc: "Photos organized by room and category" },
                { title: "Moisture / Drying Report", desc: "Daily readings + equipment summary" },
                { title: "Equipment Log", desc: "Placement dates, locations, days on site" },
                { title: "Scope of Work / Invoice", desc: "Line items, totals, signature block" },
              ].map((r) => (
                <div key={r.title} className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-5">
                  <p className="font-bold text-slate-200 mb-1">{r.title}</p>
                  <p className="text-xs text-slate-500 mb-4">{r.desc}</p>
                  <button className="w-full bg-[#C9A84C]/10 border border-[#C9A84C]/30 text-[#C9A84C] font-bold text-sm h-9 rounded-xl hover:bg-[#C9A84C]/20 transition-colors">
                    Generate PDF
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#2B1D09] border border-[#4A3318] rounded-2xl p-5">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-[#4A3318]">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-slate-600">{label}</span>
      <span className="text-sm text-slate-200 font-medium break-words">{value}</span>
    </div>
  );
}
