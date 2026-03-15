/**
 * Job Detail page — full tabbed view with all modules.
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, Room, MoistureReading, EquipmentLog, LineItem, FloorPlan, Photo, PhotoCategory, EquipmentType } from "@roybal/shared";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_ORDER,
  formatAlaskaDate,
  formatAlaskaDateTime,
  centsToDisplay,
  getMoistureStatus,
  EQUIPMENT_TYPE_LABELS,
} from "@roybal/shared";
import { ChevronLeft, ExternalLink, Trash2, Link, RefreshCw, Plus, Camera, Upload, X, FileDown } from "lucide-react";
import clsx from "clsx";
import { MagicplanService, PhotoReport, MoistureDryingReport, EquipmentLogReport, ScopeInvoiceReport } from "@roybal/shared";
import { pdf } from "@react-pdf/renderer";
import React from "react";

const PHOTO_CATEGORIES: { value: PhotoCategory; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "moisture", label: "Moisture Map" },
  { value: "equipment", label: "Equipment" },
  { value: "general", label: "General" },
];

const getMagicplanService = () => {
  const apiKey = import.meta.env.VITE_MAGICPLAN_API_KEY as string | undefined;
  const customerId = import.meta.env.VITE_MAGICPLAN_CUSTOMER_ID as string | undefined;
  if (!apiKey || !customerId || apiKey === "your-magicplan-api-key") return null;
  return new MagicplanService(apiKey, customerId);
};

type Tab = "overview" | "photos" | "moisture" | "equipment" | "scope" | "floorplan" | "report";

const STATUS_COLORS: Record<string, string> = {
  new: "#64748B", active: "#F97316", drying: "#3B82F6",
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

  // Photos
  const [photoCategory, setPhotoCategory] = useState<PhotoCategory>("general");
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  // Moisture form
  const [showMoistureForm, setShowMoistureForm] = useState(false);
  const [moistureForm, setMoistureForm] = useState({ room_id: "", reading_date: new Date().toISOString().slice(0, 10), location_description: "", material_type: "", moisture_pct: "" });
  const [savingMoisture, setSavingMoisture] = useState(false);

  // Room form
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [roomForm, setRoomForm] = useState({ name: "", floor_level: "Main", affected: true });
  const [savingRoom, setSavingRoom] = useState(false);

  // Equipment form
  const [showEquipForm, setShowEquipForm] = useState(false);
  const [equipForm, setEquipForm] = useState({ equipment_type: "air_mover" as EquipmentType, equipment_name: "", asset_number: "", room_id: "", date_placed: new Date().toISOString().slice(0, 10) });
  const [savingEquip, setSavingEquip] = useState(false);
  const [removingEquip, setRemovingEquip] = useState<string | null>(null);

  // Scope / line items form
  const [showScopeForm, setShowScopeForm] = useState(false);
  const [scopeForm, setScopeForm] = useState({ category: "demo", description: "", room_id: "", quantity: "", unit: "EA", unit_price: "" });
  const [savingScope, setSavingScope] = useState(false);

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

  const addRoom = async () => {
    if (!job || !roomForm.name.trim()) return;
    setSavingRoom(true);
    const { data } = await supabase.from("rooms").insert({
      job_id: job.id,
      name: roomForm.name.trim(),
      floor_level: roomForm.floor_level,
      affected: roomForm.affected,
    }).select().single();
    if (data) {
      setRooms((prev) => [...prev, data as Room].sort((a, b) => a.name.localeCompare(b.name)));
      setRoomForm({ name: "", floor_level: "Main", affected: true });
      setShowRoomForm(false);
    }
    setSavingRoom(false);
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

  // Photo upload
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length || !job) return;
    setUploadingPhotos(true);
    setPhotoError("");
    for (const file of files) {
      const ext = file.name.split(".").pop();
      const path = `${job.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("job-photos").upload(path, file, { upsert: false });
      if (upErr) { setPhotoError(`Upload failed: ${upErr.message}`); continue; }
      const { data: { publicUrl } } = supabase.storage.from("job-photos").getPublicUrl(path);
      const { data: photoData } = await supabase.from("photos").insert({
        job_id: job.id, storage_path: path, category: photoCategory,
        taken_at: new Date().toISOString(),
      }).select().single();
      if (photoData) setPhotos((prev) => [{ ...(photoData as Photo), url: publicUrl }, ...prev]);
    }
    setUploadingPhotos(false);
    e.target.value = "";
  };

  // Load photo URLs on mount
  const getPhotoUrl = (path: string) =>
    supabase.storage.from("job-photos").getPublicUrl(path).data.publicUrl;

  // Add moisture reading
  const addMoistureReading = async () => {
    if (!job || !moistureForm.room_id || !moistureForm.moisture_pct) return;
    setSavingMoisture(true);
    const { data } = await supabase.from("moisture_readings").insert({
      job_id: job.id,
      room_id: moistureForm.room_id,
      reading_date: moistureForm.reading_date,
      location_description: moistureForm.location_description,
      material_type: moistureForm.material_type,
      moisture_pct: parseFloat(moistureForm.moisture_pct),
      is_dry: parseFloat(moistureForm.moisture_pct) < 16,
    }).select().single();
    if (data) {
      setMoisture((prev) => [data as MoistureReading, ...prev]);
      setMoistureForm({ room_id: "", reading_date: new Date().toISOString().slice(0, 10), location_description: "", material_type: "", moisture_pct: "" });
      setShowMoistureForm(false);
    }
    setSavingMoisture(false);
  };

  // Log equipment
  const logEquipment = async () => {
    if (!job || !equipForm.equipment_name) return;
    setSavingEquip(true);
    const { data } = await supabase.from("equipment_logs").insert({
      job_id: job.id,
      equipment_type: equipForm.equipment_type,
      equipment_name: equipForm.equipment_name,
      asset_number: equipForm.asset_number || null,
      room_id: equipForm.room_id || null,
      date_placed: equipForm.date_placed,
    }).select().single();
    if (data) {
      setEquipment((prev) => [...prev, data as EquipmentLog]);
      setEquipForm({ equipment_type: "air_mover", equipment_name: "", asset_number: "", room_id: "", date_placed: new Date().toISOString().slice(0, 10) });
      setShowEquipForm(false);
    }
    setSavingEquip(false);
  };

  // Remove equipment (set date_removed = today)
  const removeEquipment = async (equipId: string) => {
    setRemovingEquip(equipId);
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from("equipment_logs").update({ date_removed: today }).eq("id", equipId).select().single();
    if (data) setEquipment((prev) => prev.map((e) => e.id === equipId ? data as EquipmentLog : e));
    setRemovingEquip(null);
  };

  // Delete handlers
  const deleteMoistureReading = async (readingId: string) => {
    await supabase.from("moisture_readings").delete().eq("id", readingId);
    setMoisture((prev) => prev.filter((m) => m.id !== readingId));
  };

  const deleteEquipmentLog = async (equipId: string) => {
    await supabase.from("equipment_logs").delete().eq("id", equipId);
    setEquipment((prev) => prev.filter((e) => e.id !== equipId));
  };

  const deletePhoto = async (photo: Photo) => {
    await supabase.storage.from("job-photos").remove([photo.storage_path]);
    await supabase.from("photos").delete().eq("id", photo.id);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  };

  const addLineItem = async () => {
    if (!job || !scopeForm.description || !scopeForm.quantity || !scopeForm.unit_price) return;
    setSavingScope(true);
    const unit_price = Math.round(parseFloat(scopeForm.unit_price) * 100);
    const quantity = parseFloat(scopeForm.quantity);
    const { data } = await supabase.from("line_items").insert({
      job_id: job.id,
      category: scopeForm.category,
      description: scopeForm.description,
      room_id: scopeForm.room_id || null,
      quantity,
      unit: scopeForm.unit,
      unit_price,
      billing_type: "scope",
      sort_order: lineItems.length,
    }).select().single();
    if (data) {
      setLineItems((prev) => [...prev, data as LineItem]);
      setScopeForm({ category: "demo", description: "", room_id: "", quantity: "", unit: "EA", unit_price: "" });
      setShowScopeForm(false);
    }
    setSavingScope(false);
  };

  const deleteLineItem = async (itemId: string) => {
    await supabase.from("line_items").delete().eq("id", itemId);
    setLineItems((prev) => prev.filter((li) => li.id !== itemId));
  };

  // PDF generation
  const [generatingReport, setGeneratingReport] = useState<string | null>(null);

  // Convert a remote image URL to a base64 data URL so @react-pdf/renderer can embed it
  const toBase64 = async (url: string): Promise<string> => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return url; // fallback — let react-pdf try the URL directly
    }
  };

  const generateReport = async (type: "photos" | "moisture" | "equipment" | "scope") => {
    if (!job) return;
    setGeneratingReport(type);
    try {
      // Fetch all photos as base64 so the PDF renderer can embed them without CORS issues
      const photosWithBase64 = await Promise.all(
        photos.map(async (p) => {
          const rawUrl = p.url ?? getPhotoUrl(p.storage_path);
          const base64 = await toBase64(rawUrl);
          return { ...p, url: base64 };
        })
      );
      let element: React.ReactElement;
      let filename: string;
      if (type === "photos") {
        element = React.createElement(PhotoReport, { job, photos: photosWithBase64, rooms });
        filename = `${job.job_number}-photo-report.pdf`;
      } else if (type === "moisture") {
        element = React.createElement(MoistureDryingReport, { job, rooms, moistureReadings: moisture, equipmentLogs: equipment });
        filename = `${job.job_number}-moisture-drying-report.pdf`;
      } else if (type === "equipment") {
        element = React.createElement(EquipmentLogReport, { job, equipmentLogs: equipment, rooms });
        filename = `${job.job_number}-equipment-log.pdf`;
      } else {
        element = React.createElement(ScopeInvoiceReport, { job, lineItems, rooms });
        filename = `${job.job_number}-invoice.pdf`;
      }
      const blob = await pdf(element).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF generation failed:", err);
      alert("PDF generation failed: " + (err instanceof Error ? err.message : String(err)));
    }
    setGeneratingReport(null);
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
        <div className="w-8 h-8 border-2 border-[#F97316] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-6 text-slate-500">Job not found.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-[#0A1628] border-b border-[#1E293B] px-6 py-4">
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
                  ? "bg-[#F97316]/15 text-[#F97316]"
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]"
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
              <div className="space-y-1 mb-3">
                {rooms.length === 0 ? (
                  <p className="text-slate-600 text-sm">No rooms yet — add them below.</p>
                ) : rooms.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-sm">
                    <span className={clsx("w-2 h-2 rounded-full flex-shrink-0", r.affected ? "bg-[#EF4444]" : "bg-[#22C55E]")} />
                    <span className="text-slate-200 flex-1">{r.name}</span>
                    <span className="text-slate-500 text-xs">{r.floor_level}</span>
                  </div>
                ))}
              </div>

              {showRoomForm ? (
                <div className="border-t border-[#1E293B] pt-3 space-y-2">
                  <input
                    type="text"
                    placeholder="Room name (e.g. Living Room)"
                    value={roomForm.name}
                    onChange={(e) => setRoomForm((f) => ({ ...f, name: e.target.value }))}
                    autoFocus
                    className="w-full bg-[#0F172A] border border-[#1E293B] rounded-lg px-3 h-8 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316]"
                  />
                  <div className="flex gap-2">
                    <select
                      value={roomForm.floor_level}
                      onChange={(e) => setRoomForm((f) => ({ ...f, floor_level: e.target.value }))}
                      className="flex-1 bg-[#0F172A] border border-[#1E293B] rounded-lg px-2 h-8 text-xs text-slate-200 focus:outline-none focus:border-[#F97316]"
                    >
                      {["Basement", "Main", "Upper", "Attic", "Crawlspace"].map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={roomForm.affected}
                        onChange={(e) => setRoomForm((f) => ({ ...f, affected: e.target.checked }))}
                        className="accent-[#F97316]"
                      />
                      Affected
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={addRoom}
                      disabled={savingRoom || !roomForm.name.trim()}
                      className="flex items-center gap-1 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-3 h-7 rounded-lg text-xs transition-colors"
                    >
                      {savingRoom ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
                      Add
                    </button>
                    <button onClick={() => setShowRoomForm(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowRoomForm(true)}
                  className="flex items-center gap-1 text-xs text-[#F97316] hover:text-[#EA6C0C] transition-colors mt-1"
                >
                  <Plus size={12} /> Add Room
                </button>
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
            {/* Add reading button */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-400 text-sm">{moisture.length} reading{moisture.length !== 1 ? "s" : ""}</p>
              <button
                onClick={() => setShowMoistureForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Reading
              </button>
            </div>

            {/* Inline form */}
            {showMoistureForm && (
              <div className="bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-300 mb-4">New Moisture Reading</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Date</label>
                    <input type="date" value={moistureForm.reading_date} onChange={(e) => setMoistureForm((f) => ({ ...f, reading_date: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Room *</label>
                    {rooms.length === 0 ? (
                      <button onClick={() => { setShowMoistureForm(false); setActiveTab("overview"); setShowRoomForm(true); }}
                        className="w-full bg-[#0F172A] border border-[#F97316]/40 rounded-xl px-3 h-9 text-xs text-[#F97316] text-left hover:bg-[#F97316]/10 transition-colors">
                        + Add rooms in Overview tab first
                      </button>
                    ) : (
                      <select value={moistureForm.room_id} onChange={(e) => setMoistureForm((f) => ({ ...f, room_id: e.target.value }))}
                        className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                        <option value="">Select room…</option>
                        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Moisture % *</label>
                    <input type="number" min="0" max="100" step="0.1" placeholder="e.g. 18.5" value={moistureForm.moisture_pct}
                      onChange={(e) => setMoistureForm((f) => ({ ...f, moisture_pct: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Location</label>
                    <input type="text" placeholder="e.g. NW corner, baseboard" value={moistureForm.location_description}
                      onChange={(e) => setMoistureForm((f) => ({ ...f, location_description: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Material</label>
                    <input type="text" placeholder="e.g. Drywall, Wood" value={moistureForm.material_type}
                      onChange={(e) => setMoistureForm((f) => ({ ...f, material_type: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={addMoistureReading} disabled={savingMoisture || !moistureForm.room_id || !moistureForm.moisture_pct}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    {savingMoisture ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingMoisture ? "Saving…" : "Save Reading"}
                  </button>
                  <button onClick={() => setShowMoistureForm(false)} className="text-sm text-slate-500 hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Date", "Room", "Location", "Material", "Reading", "Status", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moisture.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">No readings yet — click Add Reading above.</td></tr>
                    ) : moisture.map((m) => {
                      const status = getMoistureStatus(m.moisture_pct, m.material_type);
                      return (
                        <tr key={m.id} className="border-b border-[#1E293B]/50 group">
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
                          <td className="px-4 py-3">
                            <button
                              onClick={() => deleteMoistureReading(m.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                              title="Delete reading"
                            >
                              <Trash2 size={14} />
                            </button>
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
            {/* Add equipment button */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-400 text-sm">{equipment.filter((e) => !e.date_removed).length} active · {equipment.filter((e) => e.date_removed).length} removed</p>
              <button
                onClick={() => setShowEquipForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Log Equipment
              </button>
            </div>

            {/* Inline form */}
            {showEquipForm && (
              <div className="bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-300 mb-4">Log Equipment Placement</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Type *</label>
                    <select value={equipForm.equipment_type} onChange={(e) => setEquipForm((f) => ({ ...f, equipment_type: e.target.value as EquipmentType, equipment_name: EQUIPMENT_TYPE_LABELS[e.target.value as EquipmentType] }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {Object.entries(EQUIPMENT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Name *</label>
                    <input type="text" placeholder="e.g. Dri-Eaz LGR 2800i" value={equipForm.equipment_name}
                      onChange={(e) => setEquipForm((f) => ({ ...f, equipment_name: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Asset #</label>
                    <input type="text" placeholder="e.g. RC-042" value={equipForm.asset_number}
                      onChange={(e) => setEquipForm((f) => ({ ...f, asset_number: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Room</label>
                    <select value={equipForm.room_id} onChange={(e) => setEquipForm((f) => ({ ...f, room_id: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="">{rooms.length === 0 ? "No rooms — add in Overview" : "No room"}</option>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Date Placed</label>
                    <input type="date" value={equipForm.date_placed} onChange={(e) => setEquipForm((f) => ({ ...f, date_placed: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={logEquipment} disabled={savingEquip || !equipForm.equipment_name}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    {savingEquip ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingEquip ? "Saving…" : "Log Equipment"}
                  </button>
                  <button onClick={() => setShowEquipForm(false)} className="text-sm text-slate-500 hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Equipment", "Asset #", "Room", "Placed", "Removed", "Days", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {equipment.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">No equipment logged — click Log Equipment above.</td></tr>
                    ) : equipment.map((e) => (
                      <tr key={e.id} className="border-b border-[#1E293B]/50 group">
                        <td className="px-4 py-3">
                          <p className="text-slate-200 font-semibold">{e.equipment_name}</p>
                          <p className="text-slate-500 text-xs">{EQUIPMENT_TYPE_LABELS[e.equipment_type]}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-400 font-mono text-xs">{e.asset_number ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-400">{e.room_id ? (roomMap[e.room_id] ?? "—") : "—"}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{formatAlaskaDate(e.date_placed)}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{e.date_removed ? formatAlaskaDate(e.date_removed) : <span className="text-[#F97316] font-semibold">Active</span>}</td>
                        <td className="px-4 py-3 font-bold text-slate-200">{e.days_on_site}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {!e.date_removed && (
                              <button
                                onClick={() => removeEquipment(e.id)}
                                disabled={removingEquip === e.id}
                                className="text-xs font-bold text-slate-500 hover:text-amber-400 border border-[#1E293B] hover:border-amber-500/30 px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
                              >
                                {removingEquip === e.id ? "…" : "Remove"}
                              </button>
                            )}
                            <button
                              onClick={() => deleteEquipmentLog(e.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                              title="Delete log entry"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
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
            {/* Add line item button */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-400 text-sm">{lineItems.length} item{lineItems.length !== 1 ? "s" : ""} · Total: <span className="text-white font-bold">{centsToDisplay(totalCents)}</span></p>
              <button
                onClick={() => setShowScopeForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Line Item
              </button>
            </div>

            {/* Inline form */}
            {showScopeForm && (
              <div className="bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <p className="text-sm font-bold text-slate-200 mb-4">New Line Item</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Category</label>
                    <select value={scopeForm.category} onChange={(e) => setScopeForm((f) => ({ ...f, category: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {["demo","dry","equip","labor","material","disposal","other"].map((c) => (
                        <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-2">
                    <label className="text-xs text-slate-500 mb-1 block">Description *</label>
                    <input type="text" placeholder="e.g. Carpet removal and disposal" value={scopeForm.description}
                      onChange={(e) => setScopeForm((f) => ({ ...f, description: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Room</label>
                    <select value={scopeForm.room_id} onChange={(e) => setScopeForm((f) => ({ ...f, room_id: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="">All / General</option>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Qty *</label>
                    <input type="number" min="0" step="any" placeholder="1" value={scopeForm.quantity}
                      onChange={(e) => setScopeForm((f) => ({ ...f, quantity: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Unit</label>
                    <select value={scopeForm.unit} onChange={(e) => setScopeForm((f) => ({ ...f, unit: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {["EA","SF","LF","HR","Day","LS","CY","SY","CF"].map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Unit Price ($) *</label>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={scopeForm.unit_price}
                      onChange={(e) => setScopeForm((f) => ({ ...f, unit_price: e.target.value }))}
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  {scopeForm.quantity && scopeForm.unit_price && (
                    <div className="flex items-end pb-1">
                      <p className="text-sm text-slate-400">Line total: <span className="text-white font-bold">{centsToDisplay(Math.round(parseFloat(scopeForm.quantity || "0") * parseFloat(scopeForm.unit_price || "0") * 100))}</span></p>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 pt-2 border-t border-[#1E293B]">
                  <button onClick={addLineItem} disabled={savingScope || !scopeForm.description || !scopeForm.quantity || !scopeForm.unit_price}
                    className="flex items-center gap-1.5 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm disabled:opacity-50 transition-colors">
                    {savingScope ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingScope ? "Saving…" : "Add Item"}
                  </button>
                  <button onClick={() => setShowScopeForm(false)} className="text-sm text-slate-500 hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Category", "Description", "Room", "Qty", "Unit", "Unit Price", "Total", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-600">No line items yet — click Add Line Item above.</td></tr>
                    ) : lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-[#1E293B]/50 group">
                        <td className="px-4 py-3 text-xs text-slate-500 uppercase">{li.category}</td>
                        <td className="px-4 py-3 text-slate-200">{li.description}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{li.room_id ? (roomMap[li.room_id] ?? "—") : "All"}</td>
                        <td className="px-4 py-3 text-slate-300">{li.quantity}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">{li.unit}</td>
                        <td className="px-4 py-3 text-slate-300 font-mono">{centsToDisplay(li.unit_price)}</td>
                        <td className="px-4 py-3 font-bold text-slate-200 font-mono">{centsToDisplay(li.total_cents)}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => deleteLineItem(li.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                            title="Delete line item">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {lineItems.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-[#1E293B] bg-[#0F172A]">
                        <td colSpan={7} className="px-4 py-3 text-right font-bold text-slate-300">Grand Total</td>
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
            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Link size={16} className="text-[#F97316]" />
                <h3 className="text-sm font-bold text-slate-300">Magicplan Project</h3>
              </div>

              {job.magicplan_project_id && !magicplanEditing ? (
                <div className="flex items-center gap-3">
                  <code className="text-sm font-mono text-[#F97316] bg-[#1E293B] px-3 py-1.5 rounded-lg flex-1 truncate">
                    {job.magicplan_project_id}
                  </code>
                  <button
                    onClick={() => { setMagicplanInput(job.magicplan_project_id ?? ""); setMagicplanEditing(true); }}
                    className="text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors px-3 py-1.5 rounded-lg border border-[#1E293B] hover:border-[#4A4440]"
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
                    className="flex-1 bg-[#0F172A] border border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors font-mono"
                  />
                  <button
                    onClick={saveMagicplanId}
                    disabled={magicplanSaving}
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] px-3 h-10 rounded-xl disabled:opacity-60 transition-colors"
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
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-3 h-8 rounded-lg hover:bg-[#F97316]/20 disabled:opacity-60 transition-colors"
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
                    className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-3 h-8 rounded-lg hover:bg-[#F97316]/20 disabled:opacity-60 transition-colors"
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
              <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-12 text-center">
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
                  <div key={fp.id} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4 flex items-center gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-200">Version {fp.version}</p>
                      <p className="text-xs text-slate-500">Synced: {formatAlaskaDateTime(fp.synced_at)}</p>
                    </div>
                    {fp.file_url && (
                      <a href={fp.file_url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 text-sm font-bold text-[#F97316] hover:underline">
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
            {/* Upload bar */}
            <div className="flex items-center gap-3 mb-5 flex-wrap">
              <select
                value={photoCategory}
                onChange={(e) => setPhotoCategory(e.target.value as PhotoCategory)}
                className="bg-[#0A1628] border border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-200 focus:outline-none focus:border-[#F97316] transition-colors"
              >
                {PHOTO_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <label className={clsx(
                "flex items-center gap-2 cursor-pointer font-bold px-4 h-10 rounded-xl transition-colors text-sm",
                uploadingPhotos ? "bg-[#1E293B] text-slate-400 cursor-not-allowed" : "bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A]"
              )}>
                {uploadingPhotos ? (
                  <><RefreshCw size={16} className="animate-spin" /> Uploading…</>
                ) : (
                  <><Upload size={16} /> Upload Photos</>
                )}
                <input type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} disabled={uploadingPhotos} />
              </label>
              <span className="text-xs text-slate-500">Select multiple photos at once</span>
            </div>
            {photoError && <p className="text-red-400 text-sm mb-4">{photoError}</p>}

            {photos.length === 0 ? (
              <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-16 text-center">
                <Camera size={36} className="text-slate-600 mx-auto mb-3" />
                <p className="text-slate-500 mb-1">No photos yet.</p>
                <p className="text-slate-600 text-sm">Choose a category above and click Upload Photos.</p>
              </div>
            ) : (
              <>
                {/* Group by category */}
                {PHOTO_CATEGORIES.filter((c) => photos.some((p) => p.category === c.value)).map((cat) => (
                  <div key={cat.value} className="mb-6">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">{cat.label}</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {photos.filter((p) => p.category === cat.value).map((p) => {
                        const url = p.url ?? getPhotoUrl(p.storage_path);
                        return (
                          <div
                            key={p.id}
                            className="relative bg-[#0A1628] border border-[#1E293B] rounded-xl overflow-hidden aspect-square hover:border-[#F97316]/60 transition-colors group"
                          >
                            <button onClick={() => setSelectedPhoto(p)} className="w-full h-full block">
                              <img src={url} alt={p.caption ?? cat.label} className="w-full h-full object-cover" />
                            </button>
                            {p.caption && (
                              <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 pointer-events-none">
                                <p className="text-white text-xs truncate">{p.caption}</p>
                              </div>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); deletePhoto(p); }}
                              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 hover:bg-red-600 text-white p-1.5 rounded-lg"
                              title="Delete photo"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Lightbox */}
            {selectedPhoto && (
              <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={() => setSelectedPhoto(null)}>
                <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setSelectedPhoto(null)}><X size={28} /></button>
                <button
                  className="absolute top-4 left-4 flex items-center gap-2 bg-red-600/80 hover:bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-xl transition-colors"
                  onClick={(e) => { e.stopPropagation(); deletePhoto(selectedPhoto); setSelectedPhoto(null); }}
                >
                  <Trash2 size={14} /> Delete Photo
                </button>
                <img
                  src={selectedPhoto.url ?? getPhotoUrl(selectedPhoto.storage_path)}
                  alt={selectedPhoto.caption ?? ""}
                  className="max-h-[90vh] max-w-full rounded-xl object-contain"
                  onClick={(e) => e.stopPropagation()}
                />
                {selectedPhoto.caption && <p className="absolute bottom-6 text-white text-sm bg-black/60 px-4 py-2 rounded-full">{selectedPhoto.caption}</p>}
              </div>
            )}
          </div>
        )}

        {activeTab === "report" && (
          <div className="max-w-2xl">
            <p className="text-slate-400 text-sm mb-6">Generate and download PDF reports. Each opens a download dialog.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { key: "photos" as const, title: "Photo Report", desc: `${photos.length} photo${photos.length !== 1 ? "s" : ""} organized by category`, warn: photos.length === 0 ? "No photos yet" : null },
                { key: "moisture" as const, title: "Moisture / Drying Report", desc: `${moisture.length} reading${moisture.length !== 1 ? "s" : ""} + ${equipment.length} equipment log${equipment.length !== 1 ? "s" : ""}`, warn: moisture.length === 0 ? "No readings yet" : null },
                { key: "equipment" as const, title: "Equipment Log", desc: `${equipment.length} piece${equipment.length !== 1 ? "s" : ""} · ${equipment.filter(e => !e.date_removed).length} active`, warn: equipment.length === 0 ? "No equipment logged yet" : null },
                { key: "scope" as const, title: "Scope of Work / Invoice", desc: `${lineItems.length} line item${lineItems.length !== 1 ? "s" : ""} · Total: ${centsToDisplay(totalCents)}`, warn: lineItems.length === 0 ? "No line items yet" : null },
              ].map((r) => (
                <div key={r.key} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
                  <p className="font-bold text-slate-200 mb-1">{r.title}</p>
                  <p className="text-xs text-slate-500 mb-1">{r.desc}</p>
                  {r.warn && <p className="text-xs text-amber-500/80 mb-3">⚠ {r.warn} — PDF will be mostly empty</p>}
                  {!r.warn && <div className="mb-3" />}
                  <button
                    onClick={() => generateReport(r.key)}
                    disabled={generatingReport !== null}
                    className="w-full flex items-center justify-center gap-2 bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] font-bold text-sm h-9 rounded-xl hover:bg-[#F97316]/20 disabled:opacity-50 transition-colors"
                  >
                    {generatingReport === r.key ? (
                      <><RefreshCw size={14} className="animate-spin" /> Generating…</>
                    ) : (
                      <><FileDown size={14} /> Download PDF</>
                    )}
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
    <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-[#1E293B]">{title}</h3>
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
