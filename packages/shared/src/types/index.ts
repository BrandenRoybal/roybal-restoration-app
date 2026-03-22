/**
 * Roybal Restoration — Shared TypeScript Types
 *
 * These types mirror the Supabase Postgres schema exactly.
 * All dollar amounts are in cents (integer). All dates are UTC ISO strings.
 */

// ============================================================
// ENUMS
// ============================================================
export type JobStatus =
  | "lead"
  | "inspection_scheduled"
  | "inspection_complete"
  | "emergency_services"
  | "mitigation_active"
  | "monitoring"
  | "mitigation_complete"
  | "estimate_pending"
  | "estimate_approved"
  | "reconstruction_active"
  | "punch_list"
  | "invoice_submitted"
  | "payment_pending"
  | "closed";

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  lead:                   "Lead",
  inspection_scheduled:   "Inspection Scheduled",
  inspection_complete:    "Inspection Complete",
  emergency_services:     "Emergency Services",
  mitigation_active:      "Mitigation Active",
  monitoring:             "Monitoring",
  mitigation_complete:    "Mitigation Complete",
  estimate_pending:       "Estimate Pending",
  estimate_approved:      "Estimate Approved",
  reconstruction_active:  "Reconstruction Active",
  punch_list:             "Punch List",
  invoice_submitted:      "Invoice Submitted",
  payment_pending:        "Payment Pending",
  closed:                 "Closed",
};

export const JOB_STATUS_ORDER: JobStatus[] = [
  "lead","inspection_scheduled","inspection_complete","emergency_services",
  "mitigation_active","monitoring","mitigation_complete","estimate_pending",
  "estimate_approved","reconstruction_active","punch_list","invoice_submitted",
  "payment_pending","closed",
];

export const JOB_STATUS_COLORS: Record<JobStatus, string> = {
  lead:                   "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
  inspection_scheduled:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  inspection_complete:    "bg-blue-200 text-blue-800 dark:bg-blue-800/40 dark:text-blue-200",
  emergency_services:     "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  mitigation_active:      "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  monitoring:             "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  mitigation_complete:    "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  estimate_pending:       "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  estimate_approved:      "bg-purple-200 text-purple-800 dark:bg-purple-800/40 dark:text-purple-200",
  reconstruction_active:  "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  punch_list:             "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  invoice_submitted:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  payment_pending:        "bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300",
  closed:                 "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

export type LossType = "water" | "fire" | "mold" | "smoke" | "other";
export type LossCategory = "cat1" | "cat2" | "cat3";
export type PhotoCategory =
  | "before"
  | "during"
  | "after"
  | "moisture"
  | "equipment"
  | "general";

export type EquipmentType =
  | "lgr_dehumidifier"
  | "refrigerant_dehumidifier"
  | "air_mover"
  | "hepa_scrubber"
  | "hepa_vac"
  | "axial_fan"
  | "other";

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  lgr_dehumidifier: "LGR Dehumidifier",
  refrigerant_dehumidifier: "Refrigerant Dehumidifier",
  air_mover: "Air Mover",
  hepa_scrubber: "HEPA Air Scrubber",
  hepa_vac: "HEPA Vacuum",
  axial_fan: "Axial Fan",
  other: "Other",
};

export type BillingType = "tm" | "scope";
export type UserRole = "admin" | "tech" | "viewer";

// ============================================================
// CANVAS FLOOR PLAN GEOMETRY
// ============================================================

/** 2D point in feet on the canvas coordinate system */
export interface Point {
  x: number;
  y: number;
}

/** Checkbox flags for restoration work items on a room */
export interface RoomCheckboxFlags {
  remove_base?: boolean;
  flood_cut?: boolean;
  clean?: boolean;
  disinfect?: boolean;
  seal?: boolean;
  dry?: boolean;
  rebuild?: boolean;
}

/** In-app drawn floor plan (canvas-based, distinct from Magicplan file-based floor_plans) */
export interface CanvasPlan {
  id: string;
  job_id: string;
  name: string;
  level_name: string;
  /** Pixels per foot at zoom=1 */
  scale: number;
  unit_system: "imperial" | "metric";
  /** Logical canvas size in feet */
  canvas_width: number;
  canvas_height: number;
  background_image_url: string | null;
  background_opacity: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Door, window, or opening on a room wall */
export interface RoomOpening {
  id: string;
  room_id: string;
  type: "door" | "window" | "opening";
  /** Index of the polygon edge (0 = edge from point[0] to point[1]) */
  wall_index: number;
  /** Position along the wall as a 0–1 fraction */
  position: number;
  /** Width in feet */
  width: number;
  /** Height in feet */
  height: number;
  notes: string | null;
  created_at: string;
}

/** Pin marker on the canvas (equipment, label, moisture point, fixture) */
export interface RoomMarker {
  id: string;
  canvas_plan_id: string;
  room_id: string | null;
  type: "label" | "equipment" | "moisture" | "fixture";
  /** Position in feet */
  x: number;
  y: number;
  label: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============================================================
// DATABASE ROW TYPES
// ============================================================
export interface Profile {
  id: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  created_at: string;
  updated_at: string;
  job_number: string;
  status: JobStatus;
  loss_type: LossType | null;
  loss_category: LossCategory | null;
  date_of_loss: string | null;
  property_address: string;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  insurance_carrier: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  adjuster_phone: string | null;
  adjuster_email: string | null;
  assigned_tech_ids: string[];
  magicplan_project_id: string | null;
  notes: string | null;
  created_by: string | null;
  date_received?: string | null;
  cause_of_loss?: string | null;
  is_emergency?: boolean;
  billing_party?: string | null;
  property_manager_name?: string | null;
  property_manager_phone?: string | null;
  property_manager_email?: string | null;
  assigned_pm_id?: string | null;
  xactimate_file_number?: string | null;
  deductible_amount?: number;
  policy_number?: string | null;
  loss_location?: string | null;
  lead_source?: string | null;
}

export interface Room {
  id: string;
  job_id: string;
  name: string;
  floor_level: string;
  affected: boolean;
  created_at: string;
  // Canvas floor plan geometry (null when room has no drawn shape)
  canvas_plan_id: string | null;
  polygon_points: Point[] | null;
  height: number;
  floor_area: number | null;
  perimeter: number | null;
  wall_area: number | null;
  ceiling_area: number | null;
  centroid_x: number | null;
  centroid_y: number | null;
  color: string;
  // Restoration metadata
  room_notes: string | null;
  category_of_water: "cat1" | "cat2" | "cat3" | null;
  class_of_loss: "class1" | "class2" | "class3" | "class4" | null;
  demo_status: "none" | "partial" | "complete";
  drying_status: "not_started" | "in_progress" | "complete";
  checkbox_flags: RoomCheckboxFlags;
  updated_at: string;
}

export interface Photo {
  id: string;
  job_id: string;
  room_id: string | null;
  uploaded_by: string | null;
  storage_path: string;
  caption: string | null;
  category: PhotoCategory;
  taken_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  created_at: string;
  /** Resolved public/signed URL — populated by the app, not stored in DB */
  url?: string;
}

export interface MoistureReading {
  id: string;
  job_id: string;
  room_id: string;
  reading_date: string;
  location_description: string;
  material_type: string;
  moisture_pct: number;
  is_dry: boolean;
  recorded_by: string | null;
  created_at: string;
}

export interface EquipmentLog {
  id: string;
  job_id: string;
  room_id: string | null;
  equipment_type: EquipmentType;
  equipment_name: string;
  asset_number: string | null;
  serial_number: string | null;
  date_placed: string;
  date_removed: string | null;
  days_on_site: number; // computed by DB
  placed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LineItem {
  id: string;
  job_id: string;
  room_id: string | null;
  category: string;
  description: string;
  quantity: number;
  unit: string;
  /** Stored as cents: $12.50 = 1250 */
  unit_price: number;
  /** Computed by DB: round(quantity * unit_price) */
  total_cents: number;
  notes: string | null;
  billing_type: BillingType;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FloorPlan {
  id: string;
  job_id: string;
  magicplan_project_id: string;
  file_url: string | null;
  storage_path: string | null;
  version: number;
  synced_at: string;
  created_at: string;
}

// ============================================================
// FORM / INPUT TYPES (used by create/update flows)
// ============================================================
export type CreateJobInput = Omit<
  Job,
  "id" | "created_at" | "updated_at" | "job_number" | "assigned_tech_ids"
> & {
  assigned_tech_ids?: string[];
};

export type UpdateJobInput = Partial<CreateJobInput>;

export type CreateRoomInput = Omit<
  Room,
  | "id"
  | "created_at"
  | "updated_at"
  | "canvas_plan_id"
  | "polygon_points"
  | "floor_area"
  | "perimeter"
  | "wall_area"
  | "ceiling_area"
  | "centroid_x"
  | "centroid_y"
  | "color"
  | "room_notes"
  | "category_of_water"
  | "class_of_loss"
  | "demo_status"
  | "drying_status"
  | "checkbox_flags"
>;

export type CreatePhotoInput = Omit<Photo, "id" | "created_at" | "url">;

export type CreateMoistureReadingInput = Omit<
  MoistureReading,
  "id" | "is_dry" | "created_at"
>;

export type CreateEquipmentLogInput = Omit<
  EquipmentLog,
  "id" | "days_on_site" | "created_at" | "updated_at"
>;

export type CreateLineItemInput = Omit<
  LineItem,
  "id" | "total_cents" | "created_at" | "updated_at"
>;

// ============================================================
// MOISTURE DRY STANDARDS (IICRC S500)
// ============================================================
export interface DryStandard {
  label: string;
  maxPct: number;
}

/** Map of lowercase material keywords to their dry standard */
export const DRY_STANDARDS: Record<string, DryStandard> = {
  drywall: { label: "Drywall", maxPct: 1.0 },
  gypsum: { label: "Gypsum", maxPct: 1.0 },
  sheetrock: { label: "Sheetrock", maxPct: 1.0 },
  wood: { label: "Wood", maxPct: 19.0 },
  hardwood: { label: "Hardwood", maxPct: 19.0 },
  subfloor: { label: "Subfloor", maxPct: 19.0 },
  osb: { label: "OSB", maxPct: 19.0 },
  plywood: { label: "Plywood", maxPct: 19.0 },
  concrete: { label: "Concrete", maxPct: 4.0 },
  slab: { label: "Concrete Slab", maxPct: 4.0 },
  block: { label: "Block", maxPct: 4.0 },
};

export function getDryStandard(materialType: string): DryStandard {
  const key = materialType.toLowerCase();
  for (const [keyword, standard] of Object.entries(DRY_STANDARDS)) {
    if (key.includes(keyword)) return standard;
  }
  return { label: materialType, maxPct: 16.0 }; // generic
}

export type MoistureStatus = "dry" | "monitoring" | "wet";

/** Returns moisture status for UI color coding */
export function getMoistureStatus(
  moisture: number,
  materialType: string
): MoistureStatus {
  const { maxPct } = getDryStandard(materialType);
  if (moisture <= maxPct) return "dry";
  if (moisture <= maxPct * 1.5) return "monitoring";
  return "wet";
}

// ============================================================
// CURRENCY HELPERS
// ============================================================
/** Convert cents integer to display string: 1250 → "$12.50" */
export function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/** Convert dollar string/number to cents: "12.50" → 1250 */
export function dollarsToCents(dollars: number | string): number {
  return Math.round(parseFloat(String(dollars)) * 100);
}

// ============================================================
// DATE HELPERS
// ============================================================
const ALASKA_TZ = "America/Anchorage";

/** Format a UTC ISO date string for display in Alaska time */
export function formatAlaskaDate(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleDateString("en-US", {
    timeZone: ALASKA_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAlaskaDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString("en-US", {
    timeZone: ALASKA_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ============================================================
// MAGICPLAN TYPES
// ============================================================
export interface MagicplanProject {
  id: string;
  name: string;
  external_reference_id?: string;
  created_at: string;
  updated_at: string;
}

export interface MagicplanFile {
  type: "pdf" | "image" | "json";
  url: string;
  name: string;
}

// ============================================================
// COMMUNICATION TYPES
// ============================================================
export type CommType = "call" | "email" | "text" | "site_visit" | "internal_note" | "verbal_approval" | "other";
export type CommDirection = "inbound" | "outbound" | "internal";

export const COMM_TYPE_LABELS: Record<CommType, string> = {
  call: "Phone Call",
  email: "Email",
  text: "Text Message",
  site_visit: "Site Visit",
  internal_note: "Internal Note",
  verbal_approval: "Verbal Approval",
  other: "Other",
};

export const COMM_TYPE_ICONS: Record<CommType, string> = {
  call: "phone",
  email: "mail",
  text: "message-square",
  site_visit: "map-pin",
  internal_note: "file-text",
  verbal_approval: "check-circle",
  other: "more-horizontal",
};

export interface Communication {
  id: string;
  job_id: string;
  created_by: string | null;
  created_at: string;
  comm_type: CommType;
  direction: CommDirection | null;
  contact_name: string | null;
  contact_role: string | null;
  subject: string | null;
  body: string;
  is_internal: boolean;
  follow_up_needed: boolean;
  follow_up_date: string | null;
}

export interface CreateCommunicationInput {
  job_id: string;
  comm_type: CommType;
  direction?: CommDirection;
  contact_name?: string;
  contact_role?: string;
  subject?: string;
  body: string;
  is_internal?: boolean;
  follow_up_needed?: boolean;
  follow_up_date?: string;
}

// ============================================================
// TASK TYPES
// ============================================================
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskCategory = "photo" | "document" | "estimate" | "inspection" | "monitoring" | "invoice" | "communication" | "scheduling" | "other";

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low", normal: "Normal", high: "High", urgent: "Urgent",
};

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400",
  normal: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export interface Task {
  id: string;
  job_id: string;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  due_date: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  category: TaskCategory | null;
}

export interface CreateTaskInput {
  job_id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  due_date?: string;
  assigned_to?: string;
  category?: TaskCategory;
}

// ============================================================
// DOCUMENT TYPES
// ============================================================
export type DocType = "work_authorization" | "direction_to_pay" | "responsibility_acknowledgment" | "change_order" | "estimate" | "invoice" | "carrier_correspondence" | "permit" | "vendor_invoice" | "closeout" | "other";
export type DocStatus = "pending" | "signed" | "approved" | "rejected";

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  work_authorization: "Work Authorization",
  direction_to_pay: "Direction to Pay",
  responsibility_acknowledgment: "Responsibility Acknowledgment",
  change_order: "Change Order",
  estimate: "Estimate",
  invoice: "Invoice",
  carrier_correspondence: "Carrier Correspondence",
  permit: "Permit",
  vendor_invoice: "Vendor Invoice",
  closeout: "Closeout Document",
  other: "Other",
};

export interface JobDocument {
  id: string;
  job_id: string;
  uploaded_by: string | null;
  created_at: string;
  doc_type: DocType;
  title: string;
  storage_path: string | null;
  file_url: string | null;
  status: DocStatus | null;
  notes: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
}

// ============================================================
// INVOICE TYPES
// ============================================================
export type InvoiceType = "mitigation" | "reconstruction" | "tm" | "vendor_passthrough" | "supplement";
export type InvoiceStatus = "draft" | "submitted" | "partially_paid" | "paid" | "disputed" | "void";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft", submitted: "Submitted", partially_paid: "Partially Paid",
  paid: "Paid", disputed: "Disputed", void: "Void",
};

export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400",
  submitted: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  partially_paid: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  paid: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  disputed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  void: "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

export interface Invoice {
  id: string;
  job_id: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  invoice_number: string;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  amount_cents: number;
  paid_cents: number;
  due_date: string | null;
  submitted_date: string | null;
  paid_date: string | null;
  notes: string | null;
  xactimate_ref: string | null;
}

// ============================================================
// RECONSTRUCTION TYPES
// ============================================================
export type ReconTrade =
  | "drywall" | "insulation" | "paint" | "trim" | "flooring"
  | "cabinetry" | "plumbing" | "electrical" | "hvac" | "final_clean" | "other";

export type ReconStatus = "pending" | "in_progress" | "complete" | "skipped";

export const RECON_TRADE_LABELS: Record<ReconTrade, string> = {
  drywall: "Drywall",
  insulation: "Insulation",
  paint: "Paint",
  trim: "Trim & Millwork",
  flooring: "Flooring",
  cabinetry: "Cabinetry",
  plumbing: "Plumbing Reset",
  electrical: "Electrical Reset",
  hvac: "HVAC Reset",
  final_clean: "Final Clean",
  other: "Other",
};

export const RECON_STATUS_COLORS: Record<ReconStatus, string> = {
  pending: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  complete: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  skipped: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
};

export interface ReconstructionItem {
  id: string;
  job_id: string;
  room_id: string | null;
  created_at: string;
  updated_at: string;
  trade: ReconTrade;
  description: string | null;
  status: ReconStatus;
  notes: string | null;
  completed_by: string | null;
  completed_at: string | null;
  sort_order: number;
}

export interface CreateReconstructionItemInput {
  job_id: string;
  room_id?: string;
  trade: ReconTrade;
  description?: string;
  status?: ReconStatus;
  notes?: string;
  sort_order?: number;
}

// Default reconstruction checklist template (used to seed new jobs)
export const DEFAULT_RECON_TRADES: ReconTrade[] = [
  "insulation", "drywall", "paint", "trim", "flooring",
  "cabinetry", "plumbing", "electrical", "hvac", "final_clean"
];
