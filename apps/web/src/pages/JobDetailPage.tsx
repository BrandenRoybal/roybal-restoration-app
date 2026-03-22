/**
 * Job Detail page — full tabbed view with all modules.
 */

import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, Room, MoistureReading, EquipmentLog, LineItem, FloorPlan, Photo, PhotoCategory, EquipmentType, Communication, CommType, CommDirection, CreateCommunicationInput, Task, TaskPriority, TaskCategory, ReconstructionItem, CreateReconstructionItemInput, ReconTrade, ReconStatus, Invoice, InvoiceType, InvoiceStatus, JobDocument, DocType } from "@roybal/shared";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_ORDER,
  JOB_STATUS_COLORS,
  formatAlaskaDate,
  formatAlaskaDateTime,
  centsToDisplay,
  dollarsToCents,
  getMoistureStatus,
  EQUIPMENT_TYPE_LABELS,
  COMM_TYPE_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
  RECON_TRADE_LABELS,
  RECON_STATUS_COLORS,
  DEFAULT_RECON_TRADES,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_COLORS,
  DOC_TYPE_LABELS,
} from "@roybal/shared";
import { ChevronLeft, ExternalLink, Trash2, Link, RefreshCw, Plus, Camera, Upload, X, FileDown, ChevronDown, MessageSquare, CheckSquare, Phone, Mail, MapPin, FileText, CheckCircle, MoreHorizontal, Flame, HardHat, Receipt, FolderOpen, AlertTriangle, ClipboardCheck, Package, Clock, Users, PenLine } from "lucide-react";
import { useCanvasPlansForJob } from "../hooks/useFloorPlan";
import clsx from "clsx";
import { PhotoReport, MoistureDryingReport, EquipmentLogReport, ScopeInvoiceReport, ClaimPackageReport } from "@roybal/shared";
import { pdf } from "@react-pdf/renderer";
import React from "react";

// ─── Dropdown item lists with localStorage persistence ───────────────────────
const DEFAULT_MATERIALS = ["Drywall", "Wood", "Hardwood", "Subfloor", "Concrete", "OSB", "Plywood", "Block"];
const MATERIALS_KEY = "roybal_custom_materials";

const DEFAULT_EQUIP_TYPES = Object.values(EQUIPMENT_TYPE_LABELS);
const EQUIP_TYPES_KEY = "roybal_custom_equipment_types";

const DEFAULT_EQUIP_NAMES = [
  "Dri-Eaz LGR 2800i", "Dri-Eaz PHD 200", "Dri-Eaz Revolution LGR",
  "Dri-Eaz Velo Pro", "Dri-Eaz Flex 970", "Dri-Eaz F203A Sahara",
  "Alorair Sentinel HDi90", "Alorair Sentinel HD55",
  "Xpower P-230AT", "Xpower P-80A",
  "Legend Brands Drizair 1200", "Nikro PD10120",
];
const EQUIP_NAMES_KEY = "roybal_custom_equipment_names";

function loadItems(key: string, defaults: string[]): string[] {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored) as string[];
  } catch { /* ignore */ }
  return defaults;
}

function saveItems(key: string, items: string[]) {
  localStorage.setItem(key, JSON.stringify(items));
}

function ItemSelect({ value, onChange, storageKey, defaults, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  storageKey: string;
  defaults: string[];
  placeholder?: string;
}) {
  const [items, setItems] = useState<string[]>(() => loadItems(storageKey, defaults));
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addItem = () => {
    const trimmed = newItem.trim();
    if (!trimmed || items.includes(trimmed)) { setNewItem(""); setAdding(false); return; }
    const updated = [...items, trimmed];
    setItems(updated);
    saveItems(storageKey, updated);
    onChange(trimmed);
    setNewItem("");
    setAdding(false);
    setOpen(false);
  };

  const deleteItem = (item: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = items.filter((i) => i !== item);
    setItems(updated);
    saveItems(storageKey, updated);
    if (value === item) onChange("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm focus:outline-none focus:border-[#F97316] hover:border-slate-400 dark:hover:border-[#4A4440] transition-colors"
      >
        <span className={value ? "text-slate-800 dark:text-slate-200" : "text-slate-400 dark:text-slate-500"}>{value || placeholder || "Select…"}</span>
        <ChevronDown size={14} className="text-slate-400 dark:text-slate-500 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl shadow-xl overflow-hidden">
          <div className="max-h-52 overflow-y-auto">
            {items.map((item) => (
              <div
                key={item}
                className={`flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[#F97316]/10 group ${value === item ? "bg-[#F97316]/15 text-[#F97316]" : "text-slate-800 dark:text-slate-200"}`}
                onClick={() => { onChange(item); setOpen(false); }}
              >
                <span className="text-sm">{item}</span>
                <button
                  type="button"
                  onClick={(e) => deleteItem(item, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-slate-400 dark:text-slate-500 hover:text-red-400"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-slate-200 dark:border-[#1E293B] p-2">
            {adding ? (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addItem(); if (e.key === "Escape") { setAdding(false); setNewItem(""); } }}
                  placeholder="New item…"
                  className="flex-1 bg-slate-50 dark:bg-[#0F172A] border border-[#F97316]/50 rounded-lg px-2 h-7 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-[#F97316]"
                />
                <button type="button" onClick={addItem} className="px-2 h-7 rounded-lg bg-[#F97316] text-[#0F172A] text-xs font-bold">Add</button>
                <button type="button" onClick={() => { setAdding(false); setNewItem(""); }} className="px-2 h-7 rounded-lg text-slate-500 dark:text-slate-400 text-xs">✕</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-[#F97316] hover:bg-[#F97316]/10 rounded-lg transition-colors"
              >
                <Plus size={12} /> Add item
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const PHOTO_CATEGORIES: { value: PhotoCategory; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "moisture", label: "Moisture Map" },
  { value: "equipment", label: "Equipment" },
  { value: "general", label: "General" },
];

// Call the Supabase Edge Function proxy instead of Magicplan directly (CORS)
const mpProxy = async (action: string, params: Record<string, unknown> = {}) => {
  const { data, error } = await supabase.functions.invoke("magicplan-proxy", {
    body: { action, ...params },
  });
  if (error) {
    // Try to extract the real error body from the gateway response
    let detail = error.message ?? "Magicplan proxy error";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (error as any).context;
      if (ctx?.json) {
        const body = await ctx.json();
        detail = body?.error ?? body?.message ?? JSON.stringify(body);
      }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (!data.ok) throw new Error(data.error ?? "Magicplan proxy error");
  return data.data;
};

type Tab = "overview" | "communications" | "tasks" | "photos" | "moisture" | "equipment" | "scope" | "floorplan" | "report" | "reconstruction" | "invoices" | "documents" | "closeout";

const MOISTURE_COLORS = { dry: "#22C55E", monitoring: "#EAB308", wet: "#EF4444" };

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Canvas floor plans for this job
  const { plans: canvasPlans, loading: canvasPlansLoading, createPlan, deletePlan } = useCanvasPlansForJob(id ?? "");
  const [newPlanName, setNewPlanName] = useState("");
  const [newPlanLevel, setNewPlanLevel] = useState("Main Floor");
  const [showNewPlanForm, setShowNewPlanForm] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);

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
  const [uploadingFloorPlan, setUploadingFloorPlan] = useState(false);

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

  // Communications
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [showCommForm, setShowCommForm] = useState(false);
  const [commForm, setCommForm] = useState<Partial<CreateCommunicationInput>>({ comm_type: "call", direction: "inbound", is_internal: false, follow_up_needed: false });
  const [savingComm, setSavingComm] = useState(false);

  // Tasks
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("all");
  const [taskForm, setTaskForm] = useState<{ title: string; priority: TaskPriority; category: TaskCategory | ""; due_date: string; description: string }>({ title: "", priority: "normal", category: "", due_date: "", description: "" });
  const [savingTask, setSavingTask] = useState(false);

  // Overview additional info expanded
  const [showAdditionalInfo, setShowAdditionalInfo] = useState(false);

  // Phase 4: Closeout checklist
  const [closeoutChecks, setCloseoutChecks] = useState<Record<string, boolean>>({});
  const [confirmCloseJob, setConfirmCloseJob] = useState(false);

  // Phase 3 state
  const [reconItems, setReconItems] = useState<ReconstructionItem[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [jobDocuments, setJobDocuments] = useState<JobDocument[]>([]);

  // Reconstruction form
  const [showReconForm, setShowReconForm] = useState(false);
  const [reconForm, setReconForm] = useState<Partial<CreateReconstructionItemInput>>({
    trade: "drywall", status: "pending"
  });

  // Invoice form
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({
    invoice_type: "mitigation" as InvoiceType,
    amount_cents: 0,
    amount_display: "",
    status: "draft" as InvoiceStatus,
    notes: "",
    due_date: "",
    xactimate_ref: "",
  });

  // Document form
  const [showDocForm, setShowDocForm] = useState(false);
  const [docForm, setDocForm] = useState({
    doc_type: "work_authorization" as DocType,
    title: "",
    status: "pending" as "pending" | "signed" | "approved" | "rejected",
    notes: "",
    signed_by_name: "",
  });


  // Load closeout checks from localStorage
  useEffect(() => {
    if (!id) return;
    try {
      const saved = localStorage.getItem(`roybal_closeout_${id}`);
      if (saved) setCloseoutChecks(JSON.parse(saved) as Record<string, boolean>);
    } catch { /* ignore */ }
  }, [id]);

  // Save closeout checks to localStorage when they change
  useEffect(() => {
    if (!id) return;
    localStorage.setItem(`roybal_closeout_${id}`, JSON.stringify(closeoutChecks));
  }, [closeoutChecks, id]);

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
      supabase.from("communications").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      supabase.from("tasks").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      supabase.from("reconstruction_items").select("*").eq("job_id", id).order("sort_order"),
      supabase.from("invoices").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      supabase.from("documents").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    ]).then(([j, r, m, e, l, p, fp, comms, tks, recon, inv, docs]) => {
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
      if (!comms.error) setCommunications((comms.data ?? []) as Communication[]);
      if (!tks.error) setTasks((tks.data ?? []) as Task[]);
      if (!recon.error) setReconItems((recon.data ?? []) as ReconstructionItem[]);
      if (!inv.error) setInvoices((inv.data ?? []) as Invoice[]);
      if (!docs.error) setJobDocuments((docs.data ?? []) as JobDocument[]);
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
    setMagicplanCreating(true);
    setMagicplanError("");
    try {
      const result = await mpProxy("createProject", { jobId: job.id, jobData: job });
      const magicplanProjectId = result.magicplanProjectId as string;
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
    setMagicplanSyncing(true);
    setMagicplanError("");
    try {
      const result = await mpProxy("syncFloorPlan", { projectId: job.magicplan_project_id });
      const fileUrl = result.fileUrl as string | null;
      const fileType = result.fileType as string | null;
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

  // Create new canvas floor plan
  const handleCreatePlan = async () => {
    if (!newPlanName.trim()) return;
    setCreatingPlan(true);
    const plan = await createPlan(newPlanName.trim(), newPlanLevel);
    setCreatingPlan(false);
    if (plan) {
      setShowNewPlanForm(false);
      setNewPlanName("");
      navigate(`/jobs/${id}/floor-plans/${plan.id}`);
    }
  };

  // Manual floor plan upload
  const handleFloorPlanUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !job) return;
    setUploadingFloorPlan(true);
    setMagicplanError("");
    const ext = file.name.split(".").pop();
    const path = `${job.id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("floor-plans").upload(path, file, { upsert: false });
    if (upErr) {
      setMagicplanError(`Upload failed: ${upErr.message}`);
      setUploadingFloorPlan(false);
      e.target.value = "";
      return;
    }
    const { data: { publicUrl } } = supabase.storage.from("floor-plans").getPublicUrl(path);
    const fileType = file.type.includes("pdf") ? "pdf" : "image";
    const nextVersion = (floorPlans[0]?.version ?? 0) + 1;
    const { data } = await supabase
      .from("floor_plans")
      .insert({ job_id: job.id, file_url: publicUrl, file_type: fileType, version: nextVersion, synced_at: new Date().toISOString() })
      .select()
      .single();
    if (data) setFloorPlans((prev) => [data as FloorPlan, ...prev]);
    setUploadingFloorPlan(false);
    e.target.value = "";
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

  // ─── Reconstruction handlers ───────────────────────────────────────────────
  const handleAddReconItem = async () => {
    if (!job || !reconForm.trade) return;
    const { data, error } = await supabase.from("reconstruction_items")
      .insert({ ...reconForm, job_id: job.id, sort_order: reconItems.length })
      .select().single();
    if (!error && data) {
      setReconItems(prev => [...prev, data as ReconstructionItem]);
      setShowReconForm(false);
      setReconForm({ trade: "drywall", status: "pending" });
    }
  };

  const handleUpdateReconStatus = async (itemId: string, newStatus: ReconStatus) => {
    const updates: Partial<ReconstructionItem> = { status: newStatus };
    if (newStatus === "complete") {
      updates.completed_at = new Date().toISOString();
    } else {
      updates.completed_at = null;
      updates.completed_by = null;
    }
    await supabase.from("reconstruction_items").update(updates).eq("id", itemId);
    setReconItems(prev => prev.map(i => i.id === itemId ? { ...i, ...updates } : i));
  };

  const handleDeleteReconItem = async (itemId: string) => {
    await supabase.from("reconstruction_items").delete().eq("id", itemId);
    setReconItems(prev => prev.filter(i => i.id !== itemId));
  };

  const handleSeedReconChecklist = async () => {
    if (!job) return;
    const items = DEFAULT_RECON_TRADES.map((trade, i) => ({
      job_id: job.id, trade, status: "pending" as ReconStatus, sort_order: i
    }));
    const { data, error } = await supabase.from("reconstruction_items").insert(items).select();
    if (!error && data) setReconItems(prev => [...prev, ...(data as ReconstructionItem[])]);
  };

  // ─── Invoice handlers ──────────────────────────────────────────────────────
  const handleCreateInvoice = async () => {
    if (!job) return;
    const amountCents = invoiceForm.amount_display
      ? dollarsToCents(invoiceForm.amount_display.replace(/[^0-9.]/g, ""))
      : invoiceForm.amount_cents;
    const { data, error } = await supabase.from("invoices")
      .insert({
        job_id: job.id,
        invoice_type: invoiceForm.invoice_type,
        status: invoiceForm.status,
        amount_cents: amountCents,
        paid_cents: 0,
        due_date: invoiceForm.due_date || null,
        notes: invoiceForm.notes || null,
        xactimate_ref: invoiceForm.xactimate_ref || null,
      })
      .select().single();
    if (!error && data) {
      setInvoices(prev => [data as Invoice, ...prev]);
      setShowInvoiceForm(false);
      setInvoiceForm({ invoice_type: "mitigation", amount_cents: 0, amount_display: "", status: "draft", notes: "", due_date: "", xactimate_ref: "" });
    }
  };

  const handleUpdateInvoiceStatus = async (invoiceId: string, newStatus: InvoiceStatus) => {
    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === "submitted") updates.submitted_date = new Date().toISOString().split("T")[0];
    if (newStatus === "paid") {
      updates.paid_date = new Date().toISOString().split("T")[0];
      const inv = invoices.find(i => i.id === invoiceId);
      if (inv) updates.paid_cents = inv.amount_cents;
    }
    await supabase.from("invoices").update(updates).eq("id", invoiceId);
    setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, ...updates } as Invoice : i));
  };

  const handleDeleteInvoice = async (invoiceId: string) => {
    await supabase.from("invoices").delete().eq("id", invoiceId);
    setInvoices(prev => prev.filter(i => i.id !== invoiceId));
  };

  // ─── Document handlers ─────────────────────────────────────────────────────
  const handleAddDocument = async () => {
    if (!job || !docForm.title) return;
    const { data, error } = await supabase.from("documents")
      .insert({
        job_id: job.id,
        doc_type: docForm.doc_type,
        title: docForm.title,
        status: docForm.status,
        notes: docForm.notes || null,
        signed_by_name: docForm.signed_by_name || null,
        signed_at: docForm.status === "signed" ? new Date().toISOString() : null,
      })
      .select().single();
    if (!error && data) {
      setJobDocuments(prev => [data as JobDocument, ...prev]);
      setShowDocForm(false);
      setDocForm({ doc_type: "work_authorization", title: "", status: "pending", notes: "", signed_by_name: "" });
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    await supabase.from("documents").delete().eq("id", docId);
    setJobDocuments(prev => prev.filter(d => d.id !== docId));
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
      const blob = await pdf(element as any).toBlob();
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

  const handleGenerateClaimPackage = async () => {
    if (!job) return;
    setGeneratingReport("claim_package");
    try {
      const photosWithBase64 = await Promise.all(
        photos.map(async (p) => {
          const rawUrl = p.url ?? getPhotoUrl(p.storage_path);
          const base64 = await toBase64(rawUrl);
          return { ...p, url: base64 };
        })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const element = React.createElement(ClaimPackageReport as any, {
        job,
        rooms,
        photos: photosWithBase64,
        moistureReadings: moisture,
        equipmentLogs: equipment,
        lineItems,
        invoices,
        communications,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = await pdf(element as any).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job.job_number}-claim-package.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Claim package PDF generation failed:", err);
      alert("PDF generation failed: " + (err instanceof Error ? err.message : String(err)));
    }
    setGeneratingReport(null);
  };

  const totalCents = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  const openTaskCount = tasks.filter((t) => t.status === "open").length;

  const reconCompleteCount = reconItems.filter(i => i.status === "complete").length;
  const totalInvoicedCents = invoices.reduce((s, i) => s + i.amount_cents, 0);

  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "communications", label: `Comms (${communications.length})` },
    { key: "tasks", label: `Tasks${openTaskCount > 0 ? ` (${openTaskCount})` : ""}` },
    { key: "photos", label: `Photos (${photos.length})` },
    { key: "moisture", label: `Moisture (${moisture.length})` },
    { key: "equipment", label: `Equipment (${equipment.length})` },
    { key: "scope", label: `Scope (${centsToDisplay(totalCents)})` },
    { key: "reconstruction", label: `Recon${reconItems.length > 0 ? ` (${reconCompleteCount}/${reconItems.length})` : ""}` },
    { key: "invoices", label: `Invoices${invoices.length > 0 ? ` (${centsToDisplay(totalInvoicedCents)})` : ""}` },
    { key: "documents", label: `Docs (${jobDocuments.length})` },
    { key: "floorplan", label: "Floor Plan" },
    { key: "report", label: "Reports" },
    { key: "closeout", label: "Closeout" },
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
      <div className="bg-white dark:bg-[#0A1628] border-b border-slate-200 dark:border-[#1E293B] px-6 py-4">
        <div className="flex items-start gap-4 flex-wrap">
          <button onClick={() => navigate("/jobs")} className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 mt-0.5">
            <ChevronLeft size={22} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-mono text-slate-400 dark:text-slate-500">{job.job_number}</span>

              {/* Emergency badge */}
              {job.is_emergency && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400 border border-red-200 dark:border-red-800/40">
                  <Flame size={11} /> EMERGENCY
                </span>
              )}

              {/* Cat 3 badge */}
              {job.loss_category === "cat3" && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-sm">
                  <AlertTriangle size={14} className="text-red-600 dark:text-red-400 flex-shrink-0" />
                  <span className="text-red-700 dark:text-red-300 font-semibold">Cat 3 — Contaminated Loss</span>
                </div>
              )}

              {/* Status toggle — all 14 statuses */}
              <div className="flex items-center gap-1 flex-wrap">
                {JOB_STATUS_ORDER.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={clsx(
                      "px-2.5 py-0.5 rounded-full text-xs font-bold transition-all border border-transparent",
                      job.status === s
                        ? JOB_STATUS_COLORS[s]
                        : "opacity-25 hover:opacity-60 bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                    )}
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
                    className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-600 hover:text-red-400 transition-colors ml-2"
                  title="Delete job"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white mt-1 truncate">{job.property_address}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
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
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E293B]"
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
                  <p className="text-slate-400 dark:text-slate-600 text-sm">No rooms yet — add them below.</p>
                ) : rooms.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-sm">
                    <span className={clsx("w-2 h-2 rounded-full flex-shrink-0", r.affected ? "bg-[#EF4444]" : "bg-[#22C55E]")} />
                    <span className="text-slate-800 dark:text-slate-200 flex-1">{r.name}</span>
                    <span className="text-slate-400 dark:text-slate-500 text-xs">{r.floor_level}</span>
                  </div>
                ))}
              </div>

              {showRoomForm ? (
                <div className="border-t border-slate-200 dark:border-[#1E293B] pt-3 space-y-2">
                  <input
                    type="text"
                    placeholder="Room name (e.g. Living Room)"
                    value={roomForm.name}
                    onChange={(e) => setRoomForm((f) => ({ ...f, name: e.target.value }))}
                    autoFocus
                    className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-lg px-3 h-8 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]"
                  />
                  <div className="flex gap-2">
                    <select
                      value={roomForm.floor_level}
                      onChange={(e) => setRoomForm((f) => ({ ...f, floor_level: e.target.value }))}
                      className="flex-1 bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-lg px-2 h-8 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]"
                    >
                      {["Basement", "Main", "Upper", "Attic", "Crawlspace"].map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">
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
                    <button onClick={() => setShowRoomForm(false)} className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">Cancel</button>
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

            {/* Additional Info collapsible */}
            <div className="md:col-span-2 xl:col-span-3 bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
              <button
                onClick={() => setShowAdditionalInfo((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-3 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider hover:bg-slate-50 dark:hover:bg-[#0F172A] transition-colors"
              >
                Additional Information
                <ChevronDown size={14} className={clsx("transition-transform", showAdditionalInfo && "rotate-180")} />
              </button>
              {showAdditionalInfo && (
                <div className="px-5 pb-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-3 border-t border-slate-200 dark:border-[#1E293B] pt-4">
                  <InfoPair label="Emergency" value={job.is_emergency ? "YES — Emergency" : "No"} />
                  <InfoPair label="Date Received" value={formatAlaskaDate(job.date_received)} />
                  <InfoPair label="Cause of Loss" value={job.cause_of_loss ?? "—"} />
                  <InfoPair label="Lead Source" value={job.lead_source ?? "—"} />
                  <InfoPair label="Billing Party" value={job.billing_party ?? "—"} />
                  <InfoPair label="Policy Number" value={job.policy_number ?? "—"} />
                  <InfoPair label="Deductible" value={job.deductible_amount ? `$${(job.deductible_amount / 100).toFixed(2)}` : "—"} />
                  <InfoPair label="Loss Location" value={job.loss_location ?? "—"} />
                  <InfoPair label="PM Name" value={job.property_manager_name ?? "—"} />
                  <InfoPair label="PM Phone" value={job.property_manager_phone ?? "—"} />
                  <InfoPair label="PM Email" value={job.property_manager_email ?? "—"} />
                  <InfoPair label="Xactimate File #" value={job.xactimate_file_number ?? "—"} />
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "communications" && (
          <CommTab
            jobId={job.id}
            communications={communications}
            setCommunications={setCommunications}
            showCommForm={showCommForm}
            setShowCommForm={setShowCommForm}
            commForm={commForm}
            setCommForm={setCommForm}
            savingComm={savingComm}
            setSavingComm={setSavingComm}
          />
        )}

        {activeTab === "tasks" && (
          <TaskTab
            jobId={job.id}
            tasks={tasks}
            setTasks={setTasks}
            showTaskForm={showTaskForm}
            setShowTaskForm={setShowTaskForm}
            taskForm={taskForm}
            setTaskForm={setTaskForm}
            taskFilter={taskFilter}
            setTaskFilter={setTaskFilter}
            savingTask={savingTask}
            setSavingTask={setSavingTask}
          />
        )}

        {activeTab === "moisture" && (
          <div className="max-w-5xl">
            {/* Add reading button */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-500 dark:text-slate-400 text-sm">{moisture.length} reading{moisture.length !== 1 ? "s" : ""}</p>
              <button
                onClick={() => setShowMoistureForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Reading
              </button>
            </div>

            {/* Inline form */}
            {showMoistureForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4">New Moisture Reading</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Date</label>
                    <input type="date" value={moistureForm.reading_date} onChange={(e) => setMoistureForm((f) => ({ ...f, reading_date: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Room *</label>
                    {rooms.length === 0 ? (
                      <button onClick={() => { setShowMoistureForm(false); setActiveTab("overview"); setShowRoomForm(true); }}
                        className="w-full bg-white dark:bg-[#0F172A] border border-[#F97316]/40 rounded-xl px-3 h-9 text-xs text-[#F97316] text-left hover:bg-[#F97316]/10 transition-colors">
                        + Add rooms in Overview tab first
                      </button>
                    ) : (
                      <select value={moistureForm.room_id} onChange={(e) => setMoistureForm((f) => ({ ...f, room_id: e.target.value }))}
                        className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                        <option value="">Select room…</option>
                        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Moisture % *</label>
                    <input type="number" min="0" max="100" step="0.1" placeholder="e.g. 18.5" value={moistureForm.moisture_pct}
                      onChange={(e) => setMoistureForm((f) => ({ ...f, moisture_pct: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Location</label>
                    <input type="text" placeholder="e.g. NW corner, baseboard" value={moistureForm.location_description}
                      onChange={(e) => setMoistureForm((f) => ({ ...f, location_description: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Material</label>
                    <ItemSelect
                      value={moistureForm.material_type}
                      onChange={(v) => setMoistureForm((f) => ({ ...f, material_type: v }))}
                      storageKey={MATERIALS_KEY}
                      defaults={DEFAULT_MATERIALS}
                      placeholder="e.g. Drywall, Wood"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={addMoistureReading} disabled={savingMoisture || !moistureForm.room_id || !moistureForm.moisture_pct}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    {savingMoisture ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingMoisture ? "Saving…" : "Save Reading"}
                  </button>
                  <button onClick={() => setShowMoistureForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                      {["Date", "Room", "Location", "Material", "Reading", "Status", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moisture.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400 dark:text-slate-600">No readings yet — click Add Reading above.</td></tr>
                    ) : moisture.map((m) => {
                      const status = getMoistureStatus(m.moisture_pct, m.material_type);
                      return (
                        <tr key={m.id} className="border-b border-slate-200/50 dark:border-[#1E293B]/50 group">
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{formatAlaskaDate(m.reading_date)}</td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{roomMap[m.room_id] ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{m.location_description}</td>
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{m.material_type}</td>
                          <td className="px-4 py-3 font-mono font-bold" style={{ color: MOISTURE_COLORS[status] }}>{m.moisture_pct}%</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: MOISTURE_COLORS[status] + "22", color: MOISTURE_COLORS[status] }}>
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => deleteMoistureReading(m.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10"
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
              <p className="text-slate-500 dark:text-slate-400 text-sm">{equipment.filter((e) => !e.date_removed).length} active · {equipment.filter((e) => e.date_removed).length} removed</p>
              <button
                onClick={() => setShowEquipForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Log Equipment
              </button>
            </div>

            {/* Inline form */}
            {showEquipForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4">Log Equipment Placement</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Type *</label>
                    <ItemSelect
                      value={equipForm.equipment_type ? (EQUIPMENT_TYPE_LABELS[equipForm.equipment_type] ?? equipForm.equipment_type) : ""}
                      onChange={(v) => {
                        // Map label back to key, or store raw if custom
                        const key = (Object.entries(EQUIPMENT_TYPE_LABELS).find(([, label]) => label === v)?.[0] ?? v) as EquipmentType;
                        setEquipForm((f) => ({ ...f, equipment_type: key }));
                      }}
                      storageKey={EQUIP_TYPES_KEY}
                      defaults={DEFAULT_EQUIP_TYPES}
                      placeholder="Select type…"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Name *</label>
                    <ItemSelect
                      value={equipForm.equipment_name}
                      onChange={(v) => setEquipForm((f) => ({ ...f, equipment_name: v }))}
                      storageKey={EQUIP_NAMES_KEY}
                      defaults={DEFAULT_EQUIP_NAMES}
                      placeholder="e.g. Dri-Eaz LGR 2800i"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Asset #</label>
                    <input type="text" placeholder="e.g. RC-042" value={equipForm.asset_number}
                      onChange={(e) => setEquipForm((f) => ({ ...f, asset_number: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Room</label>
                    <select value={equipForm.room_id} onChange={(e) => setEquipForm((f) => ({ ...f, room_id: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="">{rooms.length === 0 ? "No rooms — add in Overview" : "No room"}</option>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Date Placed</label>
                    <input type="date" value={equipForm.date_placed} onChange={(e) => setEquipForm((f) => ({ ...f, date_placed: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={logEquipment} disabled={savingEquip || !equipForm.equipment_name}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    {savingEquip ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingEquip ? "Saving…" : "Log Equipment"}
                  </button>
                  <button onClick={() => setShowEquipForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                      {["Equipment", "Asset #", "Room", "Placed", "Removed", "Days", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {equipment.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400 dark:text-slate-600">No equipment logged — click Log Equipment above.</td></tr>
                    ) : equipment.map((e) => (
                      <tr key={e.id} className="border-b border-slate-200/50 dark:border-[#1E293B]/50 group">
                        <td className="px-4 py-3">
                          <p className="text-slate-800 dark:text-slate-200 font-semibold">{e.equipment_name}</p>
                          <p className="text-slate-400 dark:text-slate-500 text-xs">{EQUIPMENT_TYPE_LABELS[e.equipment_type]}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 font-mono text-xs">{e.asset_number ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{e.room_id ? (roomMap[e.room_id] ?? "—") : "—"}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{formatAlaskaDate(e.date_placed)}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{e.date_removed ? formatAlaskaDate(e.date_removed) : <span className="text-[#F97316] font-semibold">Active</span>}</td>
                        <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{e.days_on_site}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {!e.date_removed && (
                              <button
                                onClick={() => removeEquipment(e.id)}
                                disabled={removingEquip === e.id}
                                className="text-xs font-bold text-slate-500 dark:text-slate-500 hover:text-amber-400 border border-slate-200 dark:border-[#1E293B] hover:border-amber-500/30 px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
                              >
                                {removingEquip === e.id ? "…" : "Remove"}
                              </button>
                            )}
                            <button
                              onClick={() => deleteEquipmentLog(e.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10"
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
              <p className="text-slate-500 dark:text-slate-400 text-sm">{lineItems.length} item{lineItems.length !== 1 ? "s" : ""} · Total: <span className="text-slate-900 dark:text-white font-bold">{centsToDisplay(totalCents)}</span></p>
              <button
                onClick={() => setShowScopeForm((v) => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Line Item
              </button>
            </div>

            {/* Inline form */}
            {showScopeForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-4">New Line Item</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Category</label>
                    <select value={scopeForm.category} onChange={(e) => setScopeForm((f) => ({ ...f, category: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {["demo","dry","equip","labor","material","disposal","other"].map((c) => (
                        <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-2">
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Description *</label>
                    <input type="text" placeholder="e.g. Carpet removal and disposal" value={scopeForm.description}
                      onChange={(e) => setScopeForm((f) => ({ ...f, description: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Room</label>
                    <select value={scopeForm.room_id} onChange={(e) => setScopeForm((f) => ({ ...f, room_id: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="">All / General</option>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Qty *</label>
                    <input type="number" min="0" step="any" placeholder="1" value={scopeForm.quantity}
                      onChange={(e) => setScopeForm((f) => ({ ...f, quantity: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Unit</label>
                    <select value={scopeForm.unit} onChange={(e) => setScopeForm((f) => ({ ...f, unit: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {["EA","SF","LF","HR","Day","LS","CY","SY","CF"].map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 dark:text-slate-500 mb-1 block">Unit Price ($) *</label>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={scopeForm.unit_price}
                      onChange={(e) => setScopeForm((f) => ({ ...f, unit_price: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  {scopeForm.quantity && scopeForm.unit_price && (
                    <div className="flex items-end pb-1">
                      <p className="text-sm text-slate-500 dark:text-slate-400">Line total: <span className="text-slate-900 dark:text-white font-bold">{centsToDisplay(Math.round(parseFloat(scopeForm.quantity || "0") * parseFloat(scopeForm.unit_price || "0") * 100))}</span></p>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 pt-2 border-t border-slate-200 dark:border-[#1E293B]">
                  <button onClick={addLineItem} disabled={savingScope || !scopeForm.description || !scopeForm.quantity || !scopeForm.unit_price}
                    className="flex items-center gap-1.5 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm disabled:opacity-50 transition-colors">
                    {savingScope ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {savingScope ? "Saving…" : "Add Item"}
                  </button>
                  <button onClick={() => setShowScopeForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1E293B]">
                      {["Category", "Description", "Room", "Qty", "Unit", "Unit Price", "Total", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400 dark:text-slate-600">No line items yet — click Add Line Item above.</td></tr>
                    ) : lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-slate-200/50 dark:border-[#1E293B]/50 group">
                        <td className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500 uppercase">{li.category}</td>
                        <td className="px-4 py-3 text-slate-800 dark:text-slate-200">{li.description}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{li.room_id ? (roomMap[li.room_id] ?? "—") : "All"}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{li.quantity}</td>
                        <td className="px-4 py-3 text-slate-400 dark:text-slate-500 text-xs">{li.unit}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-mono">{centsToDisplay(li.unit_price)}</td>
                        <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200 font-mono">{centsToDisplay(li.total_cents)}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => deleteLineItem(li.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                            title="Delete line item">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {lineItems.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0F172A]">
                        <td colSpan={7} className="px-4 py-3 text-right font-bold text-slate-700 dark:text-slate-300">Grand Total</td>
                        <td className="px-4 py-3 font-black text-slate-900 dark:text-white font-mono text-base">{centsToDisplay(totalCents)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}


        {activeTab === "reconstruction" && (
          <div className="max-w-4xl">
            {/* Cat 3 warning banner */}
            {job.loss_category === "cat3" && (
              <div className="flex items-start gap-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 mb-4">
                <AlertTriangle size={18} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-red-700 dark:text-red-300 text-sm">Category 3 — Contaminated Water Loss</p>
                  <p className="text-red-600 dark:text-red-400 text-xs mt-1">All porous materials must be removed and disposed of per IICRC S500 protocol. Document all removed materials. Do not leave contaminated materials in place.</p>
                </div>
              </div>
            )}

            {/* Progress bar */}
            {reconItems.length > 0 && (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Progress</span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">{reconCompleteCount} of {reconItems.length} items complete</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-3">
                  <div
                    className="bg-green-500 h-3 rounded-full transition-all"
                    style={{ width: `${reconItems.length > 0 ? (reconCompleteCount / reconItems.length) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <p className="text-slate-500 dark:text-slate-400 text-sm flex-1">{reconItems.length} item{reconItems.length !== 1 ? "s" : ""}</p>
              {reconItems.length === 0 && (
                <button
                  onClick={handleSeedReconChecklist}
                  className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold px-4 h-9 rounded-xl text-sm transition-colors"
                >
                  <HardHat size={15} /> Seed Default Checklist
                </button>
              )}
              <button
                onClick={() => setShowReconForm(v => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Item
              </button>
            </div>

            {/* Add Item form */}
            {showReconForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4">New Reconstruction Item</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Trade *</label>
                    <select value={reconForm.trade ?? "drywall"} onChange={e => setReconForm(f => ({ ...f, trade: e.target.value as ReconTrade }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {(Object.entries(RECON_TRADE_LABELS) as [ReconTrade, string][]).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Room (optional)</label>
                    <select value={reconForm.room_id ?? ""} onChange={e => {
                        const val = e.target.value;
                        setReconForm(f => { const { room_id: _r, ...rest } = f; return val ? { ...rest, room_id: val } : rest; });
                      }}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="">General</option>
                      {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Status</label>
                    <select value={reconForm.status ?? "pending"} onChange={e => setReconForm(f => ({ ...f, status: e.target.value as ReconStatus }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="pending">Pending</option>
                      <option value="in_progress">In Progress</option>
                      <option value="complete">Complete</option>
                      <option value="skipped">Skipped</option>
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-3">
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Description</label>
                    <input type="text" placeholder="Additional details…" value={reconForm.description ?? ""}
                      onChange={e => setReconForm(f => ({ ...f, description: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div className="col-span-2 sm:col-span-3">
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Notes</label>
                    <textarea rows={2} placeholder="Notes…" value={reconForm.notes ?? ""}
                      onChange={e => setReconForm(f => ({ ...f, notes: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={handleAddReconItem} disabled={!reconForm.trade}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    <Plus size={14} /> Save Item
                  </button>
                  <button onClick={() => setShowReconForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            {/* Items list */}
            {reconItems.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <HardHat size={32} className="text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500">No reconstruction items yet.</p>
                <p className="text-slate-400 dark:text-slate-600 text-sm mt-1">Use "Seed Default Checklist" to add standard trades, or add items manually.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {reconItems.map(item => {
                  const statusCycle: ReconStatus[] = ["pending", "in_progress", "complete", "pending"];
                  const nextStatus = statusCycle[statusCycle.indexOf(item.status) + 1] ?? "pending";
                  const dotColor = item.status === "complete" ? "bg-green-500" : item.status === "in_progress" ? "bg-blue-500" : item.status === "skipped" ? "bg-slate-400" : "bg-slate-300 dark:bg-slate-600";
                  return (
                    <div key={item.id} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4 flex items-start gap-3 group">
                      <button
                        onClick={() => handleUpdateReconStatus(item.id, nextStatus)}
                        className={clsx("w-5 h-5 rounded-full flex-shrink-0 mt-0.5 border-2 transition-colors", dotColor, item.status === "complete" ? "border-green-500" : "border-slate-300 dark:border-slate-600 hover:border-[#F97316]")}
                        title={`Mark as ${nextStatus}`}
                      >
                        {item.status === "complete" && <div className="w-full h-full rounded-full flex items-center justify-center text-white text-xs">✓</div>}
                        {item.status === "skipped" && <div className="w-full h-full rounded-full flex items-center justify-center text-white text-xs">✗</div>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{RECON_TRADE_LABELS[item.trade]}</span>
                          <span className={clsx("px-1.5 py-0.5 rounded text-xs font-semibold", RECON_STATUS_COLORS[item.status])}>{item.status.replace("_", " ")}</span>
                          {item.room_id && <span className="text-xs text-slate-400 dark:text-slate-500">{roomMap[item.room_id] ?? ""}</span>}
                        </div>
                        {item.description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{item.description}</p>}
                        {item.notes && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 italic">{item.notes}</p>}
                        {item.completed_at && <p className="text-xs text-green-500 mt-0.5">Completed {formatAlaskaDate(item.completed_at)}</p>}
                      </div>
                      <button
                        onClick={() => handleDeleteReconItem(item.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                        title="Delete item"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "invoices" && (
          <div className="max-w-4xl">
            {/* Summary KPI cards */}
            {invoices.length > 0 && (() => {
              const totalInv = invoices.reduce((s, i) => s + i.amount_cents, 0);
              const totalPaid = invoices.reduce((s, i) => s + i.paid_cents, 0);
              const outstanding = totalInv - totalPaid;
              return (
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl p-4 text-center">
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">Total Invoiced</p>
                    <p className="text-xl font-black text-blue-600 dark:text-blue-400">{centsToDisplay(totalInv)}</p>
                  </div>
                  <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl p-4 text-center">
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">Total Paid</p>
                    <p className="text-xl font-black text-green-600 dark:text-green-400">{centsToDisplay(totalPaid)}</p>
                  </div>
                  <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl p-4 text-center">
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">Outstanding</p>
                    <p className={clsx("text-xl font-black", outstanding > 0 ? "text-red-600 dark:text-red-400" : "text-slate-500")}>{centsToDisplay(outstanding)}</p>
                  </div>
                </div>
              );
            })()}

            {/* Action bar */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-500 dark:text-slate-400 text-sm">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""}</p>
              <button
                onClick={() => setShowInvoiceForm(v => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Create Invoice
              </button>
            </div>

            {/* Create Invoice form */}
            {showInvoiceForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4">New Invoice</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Invoice Type</label>
                    <select value={invoiceForm.invoice_type} onChange={e => setInvoiceForm(f => ({ ...f, invoice_type: e.target.value as InvoiceType }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="mitigation">Mitigation</option>
                      <option value="reconstruction">Reconstruction</option>
                      <option value="tm">T&M</option>
                      <option value="vendor_passthrough">Vendor Passthrough</option>
                      <option value="supplement">Supplement</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Amount ($)</label>
                    <input type="text" placeholder="e.g. 12500.00" value={invoiceForm.amount_display}
                      onChange={e => setInvoiceForm(f => ({ ...f, amount_display: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Status</label>
                    <select value={invoiceForm.status} onChange={e => setInvoiceForm(f => ({ ...f, status: e.target.value as InvoiceStatus }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {(Object.entries(INVOICE_STATUS_LABELS) as [InvoiceStatus, string][]).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Due Date</label>
                    <input type="date" value={invoiceForm.due_date}
                      onChange={e => setInvoiceForm(f => ({ ...f, due_date: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Xactimate Ref</label>
                    <input type="text" placeholder="e.g. XA-12345" value={invoiceForm.xactimate_ref}
                      onChange={e => setInvoiceForm(f => ({ ...f, xactimate_ref: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div className="col-span-2 sm:col-span-3">
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Notes</label>
                    <textarea rows={2} placeholder="Notes…" value={invoiceForm.notes}
                      onChange={e => setInvoiceForm(f => ({ ...f, notes: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={handleCreateInvoice}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    <Plus size={14} /> Create Invoice
                  </button>
                  <button onClick={() => setShowInvoiceForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            {/* Invoice list */}
            {invoices.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <Receipt size={32} className="text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500">No invoices yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {invoices.map(inv => (
                  <div key={inv.id} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4 group">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-sm font-bold text-slate-800 dark:text-slate-200">{inv.invoice_number}</span>
                          <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400">{inv.invoice_type}</span>
                          <span className={clsx("px-1.5 py-0.5 rounded text-xs font-semibold", INVOICE_STATUS_COLORS[inv.status])}>{INVOICE_STATUS_LABELS[inv.status]}</span>
                          <span className="text-xs text-slate-400 dark:text-slate-600 ml-auto">{formatAlaskaDate(inv.created_at)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-sm mb-2">
                          <span className="text-slate-700 dark:text-slate-300">Invoiced: <span className="font-bold">{centsToDisplay(inv.amount_cents)}</span></span>
                          <span className="text-green-600 dark:text-green-400">Paid: <span className="font-bold">{centsToDisplay(inv.paid_cents)}</span></span>
                          {inv.due_date && <span className="text-xs text-slate-400 dark:text-slate-500">Due: {inv.due_date}</span>}
                          {inv.xactimate_ref && <span className="text-xs font-mono text-slate-400 dark:text-slate-500">{inv.xactimate_ref}</span>}
                        </div>
                        {inv.notes && <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{inv.notes}</p>}
                        <div className="flex items-center gap-2 flex-wrap">
                          {inv.status === "draft" && (
                            <button onClick={() => handleUpdateInvoiceStatus(inv.id, "submitted")}
                              className="text-xs font-bold px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors">
                              Mark Submitted
                            </button>
                          )}
                          {inv.status !== "paid" && inv.status !== "void" && (
                            <button onClick={() => handleUpdateInvoiceStatus(inv.id, "paid")}
                              className="text-xs font-bold px-2.5 py-1 rounded-lg bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/50 transition-colors">
                              Mark Paid
                            </button>
                          )}
                          {inv.status !== "disputed" && inv.status !== "void" && inv.status !== "paid" && (
                            <button onClick={() => handleUpdateInvoiceStatus(inv.id, "disputed")}
                              className="text-xs font-bold px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">
                              Mark Disputed
                            </button>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteInvoice(inv.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                        title="Delete invoice"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "documents" && (
          <div className="max-w-4xl">
            {/* Document checklist */}
            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl p-4 mb-4">
              <p className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Required Document Checklist</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(["work_authorization", "direction_to_pay", "estimate", "invoice"] as DocType[]).map(dtype => {
                  const present = jobDocuments.some(d => d.doc_type === dtype && (d.status === "signed" || d.status === "approved"));
                  return (
                    <div key={dtype} className="flex items-center gap-2">
                      <span className={clsx("w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold", present ? "bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400" : "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400")}>
                        {present ? "✓" : "✗"}
                      </span>
                      <span className="text-xs text-slate-600 dark:text-slate-400">{DOC_TYPE_LABELS[dtype]}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Action bar */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-slate-500 dark:text-slate-400 text-sm">{jobDocuments.length} document{jobDocuments.length !== 1 ? "s" : ""}</p>
              <button
                onClick={() => setShowDocForm(v => !v)}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
              >
                <Plus size={16} /> Add Document
              </button>
            </div>

            {/* Add Document form */}
            {showDocForm && (
              <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4">New Document</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Document Type</label>
                    <select value={docForm.doc_type} onChange={e => {
                      const dt = e.target.value as DocType;
                      setDocForm(f => ({ ...f, doc_type: dt, title: DOC_TYPE_LABELS[dt] }));
                    }}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      {(Object.entries(DOC_TYPE_LABELS) as [DocType, string][]).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Title *</label>
                    <input type="text" placeholder="Document title" value={docForm.title}
                      onChange={e => setDocForm(f => ({ ...f, title: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Status</label>
                    <select value={docForm.status} onChange={e => setDocForm(f => ({ ...f, status: e.target.value as "pending" | "signed" | "approved" | "rejected" }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                      <option value="pending">Pending</option>
                      <option value="signed">Signed</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>
                  {docForm.status === "signed" && (
                    <div>
                      <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Signed By Name</label>
                      <input type="text" placeholder="Full name" value={docForm.signed_by_name}
                        onChange={e => setDocForm(f => ({ ...f, signed_by_name: e.target.value }))}
                        className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
                    </div>
                  )}
                  <div className={clsx(docForm.status === "signed" ? "" : "col-span-2 sm:col-span-3")}>
                    <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Notes</label>
                    <textarea rows={2} placeholder="Notes…" value={docForm.notes}
                      onChange={e => setDocForm(f => ({ ...f, notes: e.target.value }))}
                      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={handleAddDocument} disabled={!docForm.title}
                    className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
                    <Plus size={14} /> Save Document
                  </button>
                  <button onClick={() => setShowDocForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
                </div>
              </div>
            )}

            {/* Document list */}
            {jobDocuments.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <FolderOpen size={32} className="text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500">No documents yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {jobDocuments.map(doc => {
                  const statusColors: Record<string, string> = {
                    pending: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
                    signed: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
                    approved: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                    rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
                  };
                  return (
                    <div key={doc.id} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4 flex items-start gap-3 group">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400">{DOC_TYPE_LABELS[doc.doc_type]}</span>
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{doc.title}</span>
                          {doc.status && <span className={clsx("px-1.5 py-0.5 rounded text-xs font-semibold", statusColors[doc.status] ?? "")}>{doc.status}</span>}
                          <span className="text-xs text-slate-400 dark:text-slate-600 ml-auto">{formatAlaskaDate(doc.created_at)}</span>
                        </div>
                        {doc.signed_by_name && <p className="text-xs text-slate-500 dark:text-slate-400">Signed by: {doc.signed_by_name}</p>}
                        {doc.notes && <p className="text-xs text-slate-400 dark:text-slate-500 italic mt-0.5">{doc.notes}</p>}
                        {doc.file_url && (
                          <a href={doc.file_url} target="_blank" rel="noreferrer" className="text-xs text-[#F97316] hover:underline flex items-center gap-1 mt-1">
                            <ExternalLink size={11} /> View File
                          </a>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteDocument(doc.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                        title="Delete document"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "floorplan" && (
          <div className="max-w-4xl space-y-4">

            {/* ── Canvas Floor Plans ── */}
            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <PenLine size={16} className="text-[#F97316]" />
                  <h3 className="text-sm font-bold text-slate-300">Draw Floor Plans</h3>
                </div>
                <button
                  onClick={() => setShowNewPlanForm((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-3 h-8 rounded-lg hover:bg-[#F97316]/20 transition-colors"
                >
                  <Plus size={12} /> New Plan
                </button>
              </div>

              {/* New plan form */}
              {showNewPlanForm && (
                <div className="flex items-end gap-2 mb-4 flex-wrap">
                  <div className="flex-1 min-w-32">
                    <label className="text-xs text-slate-500 mb-1 block">Plan Name</label>
                    <input
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors"
                      placeholder="e.g. First Floor"
                      value={newPlanName}
                      onChange={(e) => setNewPlanName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreatePlan(); }}
                      autoFocus
                    />
                  </div>
                  <div className="min-w-28">
                    <label className="text-xs text-slate-500 mb-1 block">Level</label>
                    <select
                      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-200 focus:outline-none focus:border-[#F97316] transition-colors"
                      value={newPlanLevel}
                      onChange={(e) => setNewPlanLevel(e.target.value)}
                    >
                      {["Basement", "Main Floor", "Second Floor", "Third Floor", "Attic"].map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleCreatePlan}
                    disabled={creatingPlan || !newPlanName.trim()}
                    className="h-9 px-4 rounded-xl text-xs font-bold bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] disabled:opacity-50 transition-colors"
                  >
                    {creatingPlan ? "Creating…" : "Create"}
                  </button>
                  <button onClick={() => setShowNewPlanForm(false)} className="h-9 px-3 text-xs text-slate-500 hover:text-slate-300">
                    Cancel
                  </button>
                </div>
              )}

              {/* Canvas plan list */}
              {canvasPlansLoading ? (
                <p className="text-xs text-slate-500">Loading…</p>
              ) : canvasPlans.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-slate-500 text-sm mb-1">No drawn floor plans yet.</p>
                  <p className="text-xs text-slate-600">Click "New Plan" to start drawing rooms on an interactive canvas.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {canvasPlans.map((plan) => (
                    <div key={plan.id} className="flex items-center gap-3 bg-[#0F172A] rounded-xl px-4 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-bold text-slate-200">{plan.name}</p>
                        <p className="text-xs text-slate-500">{plan.level_name} · Created {new Date(plan.created_at).toLocaleDateString()}</p>
                      </div>
                      <button
                        onClick={() => navigate(`/jobs/${id}/floor-plans/${plan.id}`)}
                        className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-3 h-8 rounded-lg hover:bg-[#F97316]/20 transition-colors"
                      >
                        <PenLine size={12} /> Open Editor
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${plan.name}"?`)) deletePlan(plan.id); }}
                        className="text-slate-600 hover:text-red-400 transition-colors"
                        title="Delete plan"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Magicplan project link */}
            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Link size={16} className="text-[#F97316]" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">Magicplan Project</h3>
              </div>

              {job.magicplan_project_id && !magicplanEditing ? (
                <div className="flex items-center gap-3">
                  <code className="text-sm font-mono text-[#F97316] bg-slate-100 dark:bg-[#1E293B] px-3 py-1.5 rounded-lg flex-1 truncate">
                    {job.magicplan_project_id}
                  </code>
                  <button
                    onClick={() => { setMagicplanInput(job.magicplan_project_id ?? ""); setMagicplanEditing(true); }}
                    className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors px-3 py-1.5 rounded-lg border border-slate-200 dark:border-[#1E293B] hover:border-slate-300 dark:hover:border-[#4A4440]"
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
                    className="flex-1 bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors font-mono"
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
                      className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
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
                  <p className="text-xs text-slate-400 dark:text-slate-600">
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
                  <p className="text-xs text-slate-400 dark:text-slate-600">Floor plans also auto-sync via webhook when exported.</p>
                </div>
              )}
              {/* Manual upload — always visible */}
              <label className={clsx(
                "flex items-center gap-1.5 text-xs font-bold border px-3 h-8 rounded-lg transition-colors cursor-pointer",
                uploadingFloorPlan
                  ? "bg-[#1E293B] border-[#1E293B] text-slate-500 cursor-not-allowed"
                  : "bg-[#1E293B] border-[#1E293B] text-slate-300 hover:border-[#F97316]/40 hover:text-[#F97316]"
              )}>
                {uploadingFloorPlan ? <><RefreshCw size={12} className="animate-spin" /> Uploading…</> : <><Upload size={12} /> Upload File</>}
                <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleFloorPlanUpload} disabled={uploadingFloorPlan} />
              </label>
              {magicplanError && (
                <p className="text-xs text-red-400 mt-2">{magicplanError}</p>
              )}
            </div>

            {/* Floor plan versions */}
            {floorPlans.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
                <p className="text-slate-500 mb-2">No floor plans synced yet.</p>
                <p className="text-slate-400 dark:text-slate-600 text-sm">
                  {job.magicplan_project_id
                    ? "Export a floor plan from Magicplan — it will appear here automatically."
                    : "Link a Magicplan project above to get started."}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {floorPlans.map((fp) => (
                  <div key={fp.id} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4 flex items-center gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-200">Version {fp.version}</p>
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
                className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl px-3 h-10 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316] transition-colors"
              >
                {PHOTO_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <label className={clsx(
                "flex items-center gap-2 cursor-pointer font-bold px-4 h-10 rounded-xl transition-colors text-sm",
                uploadingPhotos ? "bg-slate-100 dark:bg-[#1E293B] text-slate-400 cursor-not-allowed" : "bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A]"
              )}>
                {uploadingPhotos ? (
                  <><RefreshCw size={16} className="animate-spin" /> Uploading…</>
                ) : (
                  <><Upload size={16} /> Upload Photos</>
                )}
                <input type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} disabled={uploadingPhotos} />
              </label>
              <span className="text-xs text-slate-400 dark:text-slate-500">Select multiple photos at once</span>
            </div>
            {photoError && <p className="text-red-400 text-sm mb-4">{photoError}</p>}

            {photos.length === 0 ? (
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-16 text-center">
                <Camera size={36} className="text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                <p className="text-slate-500 mb-1">No photos yet.</p>
                <p className="text-slate-400 dark:text-slate-600 text-sm">Choose a category above and click Upload Photos.</p>
              </div>
            ) : (
              <>
                {/* Group by category */}
                {PHOTO_CATEGORIES.filter((c) => photos.some((p) => p.category === c.value)).map((cat) => (
                  <div key={cat.value} className="mb-6">
                    <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">{cat.label}</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {photos.filter((p) => p.category === cat.value).map((p) => {
                        const url = p.url ?? getPhotoUrl(p.storage_path);
                        return (
                          <div
                            key={p.id}
                            className="relative bg-slate-100 dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-xl overflow-hidden aspect-square hover:border-[#F97316]/60 transition-colors group"
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
            <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">Generate and download PDF reports. Each opens a download dialog.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { key: "photos" as const, title: "Photo Report", desc: `${photos.length} photo${photos.length !== 1 ? "s" : ""} organized by category`, warn: photos.length === 0 ? "No photos yet" : null },
                { key: "moisture" as const, title: "Moisture / Drying Report", desc: `${moisture.length} reading${moisture.length !== 1 ? "s" : ""} + ${equipment.length} equipment log${equipment.length !== 1 ? "s" : ""}`, warn: moisture.length === 0 ? "No readings yet" : null },
                { key: "equipment" as const, title: "Equipment Log", desc: `${equipment.length} piece${equipment.length !== 1 ? "s" : ""} · ${equipment.filter(e => !e.date_removed).length} active`, warn: equipment.length === 0 ? "No equipment logged yet" : null },
                { key: "scope" as const, title: "Scope of Work / Invoice", desc: `${lineItems.length} line item${lineItems.length !== 1 ? "s" : ""} · Total: ${centsToDisplay(totalCents)}`, warn: lineItems.length === 0 ? "No line items yet" : null },
              ].map((r) => (
                <div key={r.key} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                  <p className="font-bold text-slate-800 dark:text-slate-200 mb-1">{r.title}</p>
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

            {/* Claim Package */}
            <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
              <div className="flex items-center gap-3 mb-3">
                <Package size={20} className="text-[#F97316]" />
                <div>
                  <p className="font-bold text-slate-800 dark:text-slate-200">Claim Package</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Full claim documentation bundle — cover page, job summary, photos, moisture, scope, and invoice summary</p>
                </div>
              </div>
              <button
                onClick={handleGenerateClaimPackage}
                disabled={generatingReport !== null}
                className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-xl text-sm font-bold hover:bg-[#EA6C0C] disabled:opacity-50 transition-colors"
              >
                {generatingReport === "claim_package" ? (
                  <><RefreshCw size={14} className="animate-spin" /> Building…</>
                ) : (
                  <><Package size={14} /> Build Claim Package PDF</>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Closeout Tab */}
        {activeTab === "closeout" && (() => {
          const CLOSEOUT_ITEMS = [
            { category: "Documentation", items: [
              { key: "work_auth_signed", label: "Work authorization signed" },
              { key: "dir_to_pay_signed", label: "Direction to pay signed" },
              { key: "change_orders_signed", label: "All change orders signed" },
              { key: "moisture_at_dry", label: "Final moisture readings at dry standard" },
              { key: "equip_removed", label: "Equipment removed from site" },
              { key: "all_photos_uploaded", label: "All photos uploaded (before/during/after)" },
              { key: "mitigation_report", label: "Mitigation report complete" },
              { key: "recon_scope_doc", label: "Reconstruction scope documented" },
            ]},
            { category: "Financial", items: [
              { key: "final_invoice_submitted", label: "Final invoice submitted" },
              { key: "invoice_payment_received", label: "Invoice payment received" },
              { key: "vendor_invoices", label: "All vendor invoices accounted for" },
              { key: "deductible_collected", label: "Deductible collected (if applicable)" },
            ]},
            { category: "Closeout", items: [
              { key: "final_walkthrough", label: "Final walkthrough complete" },
              { key: "punch_list_resolved", label: "Punch list items resolved" },
              { key: "customer_satisfaction", label: "Customer satisfaction confirmed" },
              { key: "job_closed_system", label: "Job closed in system" },
            ]},
          ];

          const allItems = CLOSEOUT_ITEMS.flatMap((c) => c.items);
          const checkedCount = allItems.filter((item) => closeoutChecks[item.key]).length;
          const completionPct = Math.round((checkedCount / allItems.length) * 100);

          // Documentation score calculation
          const hasBeforePhotos = photos.some((p) => p.category === "before");
          const hasAfterPhotos = photos.some((p) => p.category === "after");
          const hasMoistureReadings = moisture.length > 0;
          const allMoistureDry = moisture.length > 0 && moisture.every((m) => m.is_dry);
          const allEquipRemoved = equipment.length > 0 && equipment.every((e) => e.date_removed);
          const hasWorkAuth = jobDocuments.some((d) => d.doc_type === "work_authorization" && d.status === "signed");
          const hasEstimate = lineItems.length > 0;
          const hasSubmittedInvoice = invoices.some((i) => i.status !== "draft");
          const hasComms = communications.length > 0;
          const hasEnoughTasks = tasks.length >= 3;

          const docScore = [
            hasBeforePhotos ? 15 : 0,
            hasAfterPhotos ? 15 : 0,
            hasMoistureReadings ? 10 : 0,
            allMoistureDry ? 10 : 0,
            allEquipRemoved ? 10 : 0,
            hasWorkAuth ? 10 : 0,
            hasEstimate ? 10 : 0,
            hasSubmittedInvoice ? 10 : 0,
            hasComms ? 5 : 0,
            hasEnoughTasks ? 5 : 0,
          ].reduce((a, b) => a + b, 0);

          const docScoreColor = docScore >= 71 ? "text-green-600 dark:text-green-400" : docScore >= 41 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400";
          const docScoreBg = docScore >= 71 ? "bg-green-100 dark:bg-green-900/30" : docScore >= 41 ? "bg-yellow-100 dark:bg-yellow-900/30" : "bg-red-100 dark:bg-red-900/30";

          const progressColor = completionPct >= 71 ? "bg-green-500" : completionPct >= 41 ? "bg-yellow-500" : "bg-red-500";

          return (
            <div className="max-w-3xl space-y-6">
              {/* Progress bar */}
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <ClipboardCheck size={18} className="text-[#F97316]" />
                    <span className="font-bold text-slate-800 dark:text-slate-200">Closeout Checklist</span>
                  </div>
                  <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{checkedCount}/{allItems.length} — {completionPct}%</span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-[#1E293B] rounded-full h-2.5 mb-1">
                  <div className={`${progressColor} h-2.5 rounded-full transition-all`} style={{ width: `${completionPct}%` }} />
                </div>
              </div>

              {/* Checklist sections */}
              {CLOSEOUT_ITEMS.map((section) => (
                <div key={section.category} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                  <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-slate-200 dark:border-[#1E293B]">{section.category}</h3>
                  <div className="space-y-2">
                    {section.items.map((item) => (
                      <label key={item.key} className="flex items-center gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={!!closeoutChecks[item.key]}
                          onChange={(e) => setCloseoutChecks((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                          className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-[#F97316] accent-[#F97316] cursor-pointer"
                        />
                        <span className={clsx("text-sm transition-colors", closeoutChecks[item.key] ? "line-through text-slate-400 dark:text-slate-600" : "text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white")}>
                          {item.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {/* Documentation Score */}
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Documentation Completeness Score</h3>
                  <div className={`${docScoreBg} ${docScoreColor} px-3 py-1 rounded-full text-sm font-bold`}>{docScore}%</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "Before photos", val: hasBeforePhotos, pts: 15 },
                    { label: "After photos", val: hasAfterPhotos, pts: 15 },
                    { label: "Moisture readings", val: hasMoistureReadings, pts: 10 },
                    { label: "All readings at dry", val: allMoistureDry, pts: 10 },
                    { label: "Equipment removed", val: allEquipRemoved, pts: 10 },
                    { label: "Work auth signed", val: hasWorkAuth, pts: 10 },
                    { label: "Estimate/scope", val: hasEstimate, pts: 10 },
                    { label: "Invoice submitted", val: hasSubmittedInvoice, pts: 10 },
                    { label: "Communications logged", val: hasComms, pts: 5 },
                    { label: "3+ tasks logged", val: hasEnoughTasks, pts: 5 },
                  ].map(({ label, val, pts }) => (
                    <div key={label} className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-[#1E293B]">
                      <span className={`text-xs ${val ? "text-slate-700 dark:text-slate-300" : "text-slate-400 dark:text-slate-600"}`}>{label}</span>
                      <span className={`text-xs font-bold ${val ? "text-green-600 dark:text-green-400" : "text-slate-300 dark:text-slate-600"}`}>
                        {val ? `+${pts}` : `+0/${pts}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Job Notes (Final Notes) */}
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-slate-200 dark:border-[#1E293B]">Final Notes</h3>
                <textarea
                  className="w-full bg-slate-50 dark:bg-[#0F172A] border border-slate-200 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none"
                  rows={4}
                  placeholder="Add final notes for this job…"
                  defaultValue={job.notes ?? ""}
                  onBlur={async (e) => {
                    const val = e.target.value;
                    const { data } = await supabase.from("jobs").update({ notes: val || null }).eq("id", job.id).select().single();
                    if (data) setJob(data as Job);
                  }}
                />
              </div>

              {/* Close Job */}
              <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
                <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-slate-200 dark:border-[#1E293B]">Close This Job</h3>
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-sm text-slate-600 dark:text-slate-400">Current status:</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${JOB_STATUS_COLORS[job.status]}`}>{JOB_STATUS_LABELS[job.status]}</span>
                </div>
                {job.status === "closed" ? (
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <CheckCircle size={16} />
                    <span className="text-sm font-semibold">This job is closed.</span>
                  </div>
                ) : confirmCloseJob ? (
                  <div className="space-y-3">
                    <p className="text-sm text-slate-600 dark:text-slate-400">Mark this job as Closed? This cannot be easily undone.</p>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={async () => {
                          await setStatus("closed");
                          setConfirmCloseJob(false);
                        }}
                        className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700 transition-colors"
                      >
                        Yes, Close Job
                      </button>
                      <button
                        onClick={() => setConfirmCloseJob(false)}
                        className="px-4 py-2 border border-slate-200 dark:border-[#1E293B] text-slate-600 dark:text-slate-400 rounded-xl text-sm font-semibold hover:bg-slate-50 dark:hover:bg-[#1E293B] transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmCloseJob(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-800 dark:bg-slate-700 text-white rounded-xl text-sm font-bold hover:bg-slate-900 dark:hover:bg-slate-600 transition-colors"
                  >
                    <ClipboardCheck size={15} />
                    Close This Job
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5">
      <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-slate-200 dark:border-[#1E293B]">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-slate-400 dark:text-slate-600">{label}</span>
      <span className="text-sm text-slate-800 dark:text-slate-200 font-medium break-words">{value}</span>
    </div>
  );
}

// ─── Comm type icon helper ────────────────────────────────────────────────────
function CommIcon({ type }: { type: CommType }) {
  const cls = "flex-shrink-0";
  switch (type) {
    case "call": return <Phone size={14} className={cls} />;
    case "email": return <Mail size={14} className={cls} />;
    case "text": return <MessageSquare size={14} className={cls} />;
    case "site_visit": return <MapPin size={14} className={cls} />;
    case "internal_note": return <FileText size={14} className={cls} />;
    case "verbal_approval": return <CheckCircle size={14} className={cls} />;
    default: return <MoreHorizontal size={14} className={cls} />;
  }
}

// ─── Communications Tab ───────────────────────────────────────────────────────
interface CommTabProps {
  jobId: string;
  communications: Communication[];
  setCommunications: React.Dispatch<React.SetStateAction<Communication[]>>;
  showCommForm: boolean;
  setShowCommForm: React.Dispatch<React.SetStateAction<boolean>>;
  commForm: Partial<CreateCommunicationInput>;
  setCommForm: React.Dispatch<React.SetStateAction<Partial<CreateCommunicationInput>>>;
  savingComm: boolean;
  setSavingComm: (v: boolean) => void;
}

function CommTab({ jobId, communications, setCommunications, showCommForm, setShowCommForm, commForm, setCommForm, savingComm, setSavingComm }: CommTabProps) {

  const saveComm = async () => {
    if (!commForm.body?.trim()) return;
    setSavingComm(true);
    const { data } = await supabase.from("communications").insert({
      job_id: jobId,
      comm_type: commForm.comm_type ?? "call",
      direction: commForm.comm_type === "internal_note" ? "internal" : (commForm.direction ?? "inbound"),
      contact_name: commForm.contact_name || null,
      contact_role: commForm.contact_role || null,
      subject: commForm.subject || null,
      body: commForm.body,
      is_internal: commForm.is_internal ?? false,
      follow_up_needed: commForm.follow_up_needed ?? false,
      follow_up_date: commForm.follow_up_needed ? (commForm.follow_up_date || null) : null,
    }).select().single();
    if (data) {
      setCommunications((prev) => [data as Communication, ...prev]);
      setCommForm({ comm_type: "call", direction: "inbound", is_internal: false, follow_up_needed: false });
      setShowCommForm(false);
    }
    setSavingComm(false);
  };

  const deleteComm = async (commId: string) => {
    await supabase.from("communications").delete().eq("id", commId);
    setCommunications((prev) => prev.filter((c) => c.id !== commId));
  };

  const directionColor: Record<string, string> = {
    inbound: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    outbound: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    internal: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400",
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <p className="text-slate-500 dark:text-slate-400 text-sm">{communications.length} log{communications.length !== 1 ? "s" : ""}</p>
        <button
          onClick={() => setShowCommForm((v) => !v)}
          className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
        >
          <Plus size={16} /> Log Communication
        </button>
      </div>

      {showCommForm && (
        <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4 space-y-3">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">Log Communication</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Type *</label>
              <select value={commForm.comm_type ?? "call"}
                onChange={(e) => setCommForm((f) => ({ ...f, comm_type: e.target.value as CommType }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                {(Object.entries(COMM_TYPE_LABELS) as [CommType, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            {commForm.comm_type !== "internal_note" && (
              <div>
                <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Direction</label>
                <select value={commForm.direction ?? "inbound"}
                  onChange={(e) => setCommForm((f) => ({ ...f, direction: e.target.value as CommDirection }))}
                  className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                  <option value="internal">Internal</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Contact Name</label>
              <input type="text" placeholder="Jane Smith" value={commForm.contact_name ?? ""}
                onChange={(e) => setCommForm((f) => ({ ...f, contact_name: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Contact Role</label>
              <input type="text" placeholder="Adjuster / PM / Owner / etc." value={commForm.contact_role ?? ""}
                onChange={(e) => setCommForm((f) => ({ ...f, contact_role: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Subject (optional)</label>
              <input type="text" placeholder="Brief subject…" value={commForm.subject ?? ""}
                onChange={(e) => setCommForm((f) => ({ ...f, subject: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Notes / Body *</label>
              <textarea rows={3} placeholder="What was discussed, decided, or noted…" value={commForm.body ?? ""}
                onChange={(e) => setCommForm((f) => ({ ...f, body: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none" />
            </div>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={commForm.is_internal ?? false}
                onChange={(e) => setCommForm((f) => ({ ...f, is_internal: e.target.checked }))}
                className="accent-[#F97316]" />
              Internal note (not shared)
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={commForm.follow_up_needed ?? false}
                onChange={(e) => setCommForm((f) => ({ ...f, follow_up_needed: e.target.checked }))}
                className="accent-[#F97316]" />
              Follow-up needed
            </label>
            {commForm.follow_up_needed && (
              <input type="date" value={commForm.follow_up_date ?? ""}
                onChange={(e) => setCommForm((f) => ({ ...f, follow_up_date: e.target.value }))}
                className="bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-8 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={saveComm} disabled={savingComm || !commForm.body?.trim()}
              className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
              {savingComm ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
              {savingComm ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setShowCommForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {communications.length === 0 ? (
          <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
            <MessageSquare size={32} className="text-slate-300 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-slate-500">No communications logged yet.</p>
          </div>
        ) : communications.map((c) => (
          <div key={c.id} className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-4 group">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-[#1E293B] flex items-center justify-center text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5">
                <CommIcon type={c.comm_type} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{COMM_TYPE_LABELS[c.comm_type]}</span>
                  {c.direction && (
                    <span className={clsx("px-1.5 py-0.5 rounded text-xs font-semibold", directionColor[c.direction] ?? "bg-slate-100 text-slate-600")}>
                      {c.direction}
                    </span>
                  )}
                  {c.is_internal && <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400">Internal</span>}
                  {c.follow_up_needed && <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Follow-up {c.follow_up_date ?? ""}</span>}
                  <span className="text-xs text-slate-400 dark:text-slate-600 ml-auto">{formatAlaskaDateTime(c.created_at)}</span>
                </div>
                {(c.contact_name || c.contact_role) && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                    {c.contact_name}{c.contact_role ? ` — ${c.contact_role}` : ""}
                  </p>
                )}
                {c.subject && <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-1">{c.subject}</p>}
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{c.body}</p>
              </div>
              <button
                onClick={() => deleteComm(c.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Tasks Tab ────────────────────────────────────────────────────────────────
interface TaskTabProps {
  jobId: string;
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  showTaskForm: boolean;
  setShowTaskForm: React.Dispatch<React.SetStateAction<boolean>>;
  taskForm: { title: string; priority: TaskPriority; category: TaskCategory | ""; due_date: string; description: string };
  setTaskForm: React.Dispatch<React.SetStateAction<{ title: string; priority: TaskPriority; category: TaskCategory | ""; due_date: string; description: string }>>;
  taskFilter: "all" | "open" | "done";
  setTaskFilter: (v: "all" | "open" | "done") => void;
  savingTask: boolean;
  setSavingTask: (v: boolean) => void;
}

const TASK_CATEGORIES: { value: TaskCategory; label: string }[] = [
  { value: "photo", label: "Photo" },
  { value: "document", label: "Document" },
  { value: "estimate", label: "Estimate" },
  { value: "inspection", label: "Inspection" },
  { value: "monitoring", label: "Monitoring" },
  { value: "invoice", label: "Invoice" },
  { value: "communication", label: "Communication" },
  { value: "scheduling", label: "Scheduling" },
  { value: "other", label: "Other" },
];

function TaskTab({ jobId, tasks, setTasks, showTaskForm, setShowTaskForm, taskForm, setTaskForm, taskFilter, setTaskFilter, savingTask, setSavingTask }: TaskTabProps) {
  const today = new Date().toISOString().split("T")[0] ?? "";

  const saveTask = async () => {
    if (!taskForm.title.trim()) return;
    setSavingTask(true);
    const { data } = await supabase.from("tasks").insert({
      job_id: jobId,
      title: taskForm.title.trim(),
      priority: taskForm.priority,
      category: taskForm.category || null,
      due_date: taskForm.due_date || null,
      description: taskForm.description || null,
      status: "open",
    }).select().single();
    if (data) {
      setTasks((prev) => [data as Task, ...prev]);
      setTaskForm({ title: "", priority: "normal", category: "", due_date: "", description: "" });
      setShowTaskForm(false);
    }
    setSavingTask(false);
  };

  const toggleTaskDone = async (task: Task) => {
    const newStatus = task.status === "done" ? "open" : "done";
    const { data } = await supabase.from("tasks").update({ status: newStatus }).eq("id", task.id).select().single();
    if (data) setTasks((prev) => prev.map((t) => t.id === task.id ? data as Task : t));
  };

  const deleteTask = async (taskId: string) => {
    await supabase.from("tasks").delete().eq("id", taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const filtered = tasks.filter((t) => {
    if (taskFilter === "open") return t.status === "open" || t.status === "in_progress";
    if (taskFilter === "done") return t.status === "done" || t.status === "cancelled";
    return true;
  });

  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sorted = [...filtered].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

  const openCount = tasks.filter((t) => t.status === "open" || t.status === "in_progress").length;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {(["all", "open", "done"] as const).map((f) => (
            <button key={f} onClick={() => setTaskFilter(f)}
              className={clsx("px-3 h-8 rounded-xl text-xs font-bold transition-colors border",
                taskFilter === f
                  ? "bg-[#F97316] border-[#F97316] text-[#0F172A]"
                  : "bg-white dark:bg-[#0A1628] border-slate-200 dark:border-[#1E293B] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
              )}>
              {f === "all" ? `All (${tasks.length})` : f === "open" ? `Open (${openCount})` : "Done"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowTaskForm((v) => !v)}
          className="ml-auto flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors"
        >
          <Plus size={16} /> Add Task
        </button>
      </div>

      {showTaskForm && (
        <div className="bg-white dark:bg-[#0A1628] border border-[#F97316]/30 rounded-2xl p-5 mb-4 space-y-3">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">New Task</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="col-span-2 sm:col-span-3">
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Title *</label>
              <input type="text" placeholder="e.g. Take post-demo photos" value={taskForm.title}
                onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316]" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Priority</label>
              <select value={taskForm.priority}
                onChange={(e) => setTaskForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                {(Object.entries(TASK_PRIORITY_LABELS) as [TaskPriority, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Category</label>
              <select value={taskForm.category}
                onChange={(e) => setTaskForm((f) => ({ ...f, category: e.target.value as TaskCategory | "" }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]">
                <option value="">No category</option>
                {TASK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Due Date</label>
              <input type="date" value={taskForm.due_date}
                onChange={(e) => setTaskForm((f) => ({ ...f, due_date: e.target.value }))}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 h-9 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316]" />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">Description (optional)</label>
              <textarea rows={2} value={taskForm.description}
                onChange={(e) => setTaskForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Additional details…"
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] resize-none" />
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={saveTask} disabled={savingTask || !taskForm.title.trim()}
              className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-50 text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors">
              {savingTask ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
              {savingTask ? "Saving…" : "Add Task"}
            </button>
            <button onClick={() => setShowTaskForm(false)} className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-3">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-12 text-center">
            <CheckSquare size={32} className="text-slate-300 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-slate-500">No tasks yet.</p>
          </div>
        ) : sorted.map((task) => {
          const isDone = task.status === "done" || task.status === "cancelled";
          const isOverdue = !isDone && task.due_date && task.due_date < today;
          return (
            <div key={task.id} className={clsx(
              "bg-white dark:bg-[#0A1628] border rounded-2xl p-4 group flex items-start gap-3 transition-opacity",
              isDone ? "opacity-50 border-slate-200 dark:border-[#1E293B]" : "border-slate-200 dark:border-[#1E293B]"
            )}>
              <button
                onClick={() => toggleTaskDone(task)}
                className={clsx(
                  "w-5 h-5 rounded border-2 flex-shrink-0 mt-0.5 flex items-center justify-center transition-colors",
                  isDone ? "border-[#F97316] bg-[#F97316]/20" : "border-slate-300 dark:border-slate-600 hover:border-[#F97316]"
                )}
              >
                {isDone && <div className="w-2 h-2 rounded-full bg-[#F97316]" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={clsx("text-sm font-semibold text-slate-800 dark:text-slate-200", isDone && "line-through text-slate-400 dark:text-slate-600")}>
                    {task.title}
                  </span>
                  <span className={clsx("px-1.5 py-0.5 rounded text-xs font-bold", TASK_PRIORITY_COLORS[task.priority])}>
                    {TASK_PRIORITY_LABELS[task.priority]}
                  </span>
                  {task.category && (
                    <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                      {task.category}
                    </span>
                  )}
                  {task.due_date && (
                    <span className={clsx("text-xs font-mono", isOverdue ? "text-red-500 font-bold" : "text-slate-400 dark:text-slate-600")}>
                      {isOverdue ? "OVERDUE " : ""}{task.due_date}
                    </span>
                  )}
                </div>
                {task.description && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">{task.description}</p>
                )}
              </div>
              <button
                onClick={() => deleteTask(task.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-400 dark:text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                title="Delete task"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
