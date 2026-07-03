/* ============================================================
   Roybal Field Forms — data model + company constants
   ============================================================ */
import { uid, todayISO } from "./core.js";

export const COMPANY = {
  name: "Roybal Construction, LLC",
  dba: "Roybal Restoration",
  address: "2170 Chateau Court, North Pole, AK 99705",
  phone: "907-371-9868",
  email: "branden@roybalconstruction.com",
  web: "roybalconstruction.com",
  tagline: "General Contracting | Restoration & Mitigation | IICRC WRT Certified",
  // Credentials — printed in the document footer + cited in the construction narrative.
  licenses: [
    "AK GC Lic. #199401",
    "Bus. Lic. #2177519",
    "Residential Endorsement #105588",
    "IICRC WRT #70233261",
    "EPA RRP #RI8866-26-0533",
  ],
  signatory: "Branden Roybal",
  signatoryTitle: "Owner / IICRC WRT-Certified",
};

/* The forms shown in the field app. (Invoice moved to the office admin.)
   `multi` forms can have many instances (a new Drying Log / Moisture Map
   page per day/area). */
export const FORMS = [
  { key: "moistureMaps",     name: "Moisture Map",       icon: "🗺️", multi: true,
    blurb: "Sketch the affected area + daily MC% readings" },
  { key: "dryingLogs",       name: "Drying Log",         icon: "💧", multi: true,
    blurb: "Equipment runtime + psychrometric readings" },
  { key: "photos",           name: "Job Photos",         icon: "📷", multi: false,
    blurb: "Before / during / after pictures" },
  { key: "contents",         name: "Contents",           icon: "📦", multi: false,
    blurb: "Personal property inventory + pack-out" },
  { key: "workAuth",         name: "Work Authorization", icon: "✍️", multi: false,
    blurb: "Sign on device or upload signed copy" },
  { key: "constructionLogs", name: "Daily Const. Log",   icon: "📋", multi: true,
    blurb: "Crew, tasks & hours (internal — not in packet)" },
  { key: "laborLog",         name: "Labor Log",          icon: "⏱", multi: false,
    blurb: "Every job hour from QuickBooks Time — one page for the packet" },
  { key: "certDrying",       name: "Cert. of Drying",    icon: "✅", multi: false,
    blurb: "IICRC S500 dry verification + sign-off" },
  { key: "changeOrders",     name: "Change Order",       icon: "🔁", multi: true,
    blurb: "Scope / supplement changes" },
  { key: "invoices",         name: "Mitigation Invoice", icon: "🧾", multi: true,
    blurb: "Xactimate-style invoice — AI-drafted from the job's documentation or built by hand" },
];

export function newProject() {
  return {
    id: uid(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // shared header — entered once, flows into every form
    workOrderNo: "",
    claimNo: "",
    customer: "",
    address: "",
    phone: "",
    email: "",
    carrier: "",
    adjuster: "",
    lossCause: "",
    dateOfLoss: "",
    waterCategory: "",   // 1 | 2 | 3
    waterClass: "",      // 1 | 2 | 3 | 4
    dryingSystem: "",    // Open | Closed | Hybrid
    // project-level job photos (before/during/after, with caption + room)
    photos: [],
    // contents / personal property
    rooms: [],          // shared room list (strings), reused across the app
    boxes: [],          // pack-out boxes
    contents: [],       // inventory items
    // AI construction narrative (packet cover) — markdown prose + date generated
    narrative: "",
    narrativeDate: "",
    // form data
    workAuth: null,
    certDrying: null,
    moistureMaps: [],
    dryingLogs: [],
    constructionLogs: [],
    laborLog: null,
    changeOrders: [],
    invoices: [],
  };
}

export function newPhoto() {
  return { id: uid(), src: "", caption: "", room: "", stage: "during", ts: new Date().toISOString() };
}

/* ---------- Contents (personal property) ---------- */
export const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged", "Destroyed"];
export const DISPOSITIONS = [
  { value: "salvageable", label: "Salvageable", short: "Salv." },
  { value: "non-salvageable", label: "Non-Salvageable (Loss)", short: "LOSS" },
  { value: "cleaned", label: "Cleaned", short: "Cleaned" },
  { value: "disposed", label: "Disposed", short: "Disposed" },
];
export const dispositionLabel = (v) => DISPOSITIONS.find((d) => d.value === v)?.label || "";
export const dispositionShort = (v) => DISPOSITIONS.find((d) => d.value === v)?.short || "";
export const CONTENT_CATEGORIES = [
  "Furniture", "Electronics", "Appliance", "Clothing", "Kitchenware", "Décor",
  "Bedding / Linens", "Tools", "Documents", "Toys", "Sporting / Outdoor", "Other",
];
export const BOX_DESTINATIONS = ["On-site", "Storage", "Cleaning", "Returned", "Disposed"];

export function newContentsItem() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    name: "", qty: "1", category: "", room: "", boxId: "",
    condition: "", disposition: "salvageable",
    value: "",                       // estimated unit replacement cost (RCV)
    brand: "", model: "", age: "",   // for depreciation / loss claims
    notes: "", photos: [],
    returned: false, returnedDate: "", // pack-back tracking
  };
}

/* IICRC/insurance-style useful life (years) by category — drives ACV depreciation */
export const USEFUL_LIFE = {
  "Furniture": 15, "Electronics": 5, "Appliance": 10, "Clothing": 5,
  "Kitchenware": 10, "Décor": 10, "Bedding / Linens": 5, "Tools": 10,
  "Documents": 0, "Toys": 5, "Sporting / Outdoor": 8, "Other": 8,
};
const MAX_DEPRECIATION = 0.8;        // never depreciate below 20% salvage value

/* Replacement Cost (RCV), depreciation %, and Actual Cash Value (ACV) for an item */
export function depreciation(item) {
  const unit = Number(item.value) || 0;
  const qty = Number(item.qty) || 1;
  const rcv = unit * qty;
  const life = USEFUL_LIFE[item.category] ?? 10;
  const age = Number(item.age);
  let rate = 0;
  if (rcv && life > 0 && isFinite(age) && age > 0) rate = Math.min(age / life, MAX_DEPRECIATION);
  const acv = rcv * (1 - rate);
  return { rcv, rate, acv, dep: rcv - acv };
}
export function newBox(n) {
  return { id: uid(), label: "Box " + n, room: "", destination: "Storage", packedBy: "", packedDate: todayISO() };
}

export const formByKey = (k) => FORMS.find((f) => f.key === k);

/* count of completed/started instances for the project home tiles */
export function formCount(project, key) {
  const v = project[key];
  if (Array.isArray(v)) return v.length;
  return v ? 1 : 0;
}

/* Factory builders for multi-instance forms */
export function newMoistureMap() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    label: "", material: "", dryGoal: "", meter: "",
    ambientTemp: "", ambientRH: "", equipmentOnSite: "", technician: "",
    sketch: "",                                  // flattened composite (bg + drawing) for print
    floorPlan: "",                               // imported floor-plan background (PDF/image → image)
    strokes: "",                                 // drawing layer only (PNG)
    markerNext: 1,                               // next reading-location marker number
    equipmentPlan: [],                           // placed equipment icons [{id,type,x,y,angle}] over the floor plan
    equipmentPlanImg: "",                        // flattened equipment-plan composite for print
    photos: [],                                  // alt: photos of the area
    page: "", pageOf: "",
    // reading grid: rows are dates; locations 1..13
    readings: [ blankReadingRow() ],
  };
}
export function blankReadingRow() {
  return { date: todayISO(), values: Array(13).fill(""), notes: "" };
}

export function newDryingLog() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    dryoutStart: "", dryoutFinish: "", techSupervisor: "",
    equipment: [ blankEquipRow() ],
    readings: [ blankPsychroRow() ],
  };
}
export function blankEquipRow() {
  return { asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" };
}
export function blankPsychroRow() {
  return {
    date: todayISO(), time: "",
    outT: "", outRH: "", outGPP: "",
    refT: "", refRH: "", refGPP: "",
    affT: "", affRH: "", affGPP: "",
    gd: "", dehu: "", am: "", scrub: "", tech: "", notes: "",
  };
}

export function newConstructionLog() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    date: todayISO(),
    rows: [ blankWorkRow() ],
    notes: "", issues: "", materials: "",
    completedBy: "", signature: "", signDate: todayISO(),
  };
}
export function blankWorkRow() {
  return { employee: "", task: "", start: "", finish: "", hours: "" };
}

export function newLaborLog() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    syncedAt: "",       // last QuickBooks Time pull
    entries: [],        // snapshot: [{ date, employee, start, finish, hours, task, qbId }]
  };
}

export function newChangeOrder() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    coNo: "", coDate: todayISO(),
    reasons: {},                 // checkbox map
    description: "",
    items: [ blankLineItem() ],
    daysAdded: "", origCompletion: "", revisedCompletion: "", effectiveDate: "",
    origAmount: "", prevCO: "",
    sigOwner: "", sigContractor: "", sigAdjuster: "",
    sigOwnerDate: "", sigContractorDate: "", sigAdjusterDate: "",
  };
}
export function newInvoice() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    invoiceNo: "", invoiceDate: todayISO(), dueDate: "", terms: "Due on receipt",
    lossSummary: "",
    items: [ blankLineItem() ],
    deductible: "", previousPayments: "", taxRate: "",
    notes: "",
  };
}
export function blankLineItem() {
  return { desc: "", qty: "", unit: "", price: "" };
}

export function newWorkAuth() {
  return {
    date: todayISO(),
    scope: {                     // pre-checked authorized scope items
      0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true,
    },
    mode: "sign",                // "sign" | "upload"
    ownerSig: "", ownerName: "", ownerDate: todayISO(),
    repSig: "", repName: "", repDate: todayISO(),
    uploadedDoc: "",             // legacy: single dataURL of a wet-signed scan/photo
    uploadedPages: [],           // dataURL per page of an uploaded signed PDF/scan
  };
}

export function newCertDrying() {
  return {
    certNo: "", issueDate: todayISO(), dryingDays: "",
    dryStart: "", dryComplete: "",
    affectedAreas: "",
    verification: [ blankVerifyRow() ],
    dehuDays: "", amDays: "", scrubDays: "", heaterDays: "",
    mode: "sign",                // "sign" | "upload"
    uploadedDoc: "", uploadedPages: [],   // an uploaded signed Cert of Drying PDF/scan
    sigTech: "", sigTechName: "", sigTechDate: todayISO(),
    sigOwner: "", sigOwnerName: "", sigOwnerDate: todayISO(),
    sigAdjuster: "", sigAdjusterName: "", sigAdjusterDate: "",
  };
}
export function blankVerifyRow() {
  return { material: "", meter: "", goal: "", final: "", reference: "", dry: false };
}

export const SCOPE_ITEMS = [
  "Emergency water extraction and surface drying.",
  "Moisture mapping, readings, and documentation per IICRC S500 standard.",
  "Placement and daily monitoring of drying equipment (air movers, dehumidifiers, HEPA scrubbers as needed).",
  "Removal of unsalvageable materials (flood cuts, flooring, insulation) as warranted by moisture readings.",
  "Application of EPA-registered antimicrobial / antifungal treatment to affected structural surfaces.",
  "Photo documentation and drying logs for insurance carrier submission.",
  "Additional scope items identified during mitigation — owner / adjuster notified before execution.",
];

export const CHANGE_REASONS = [
  "Concealed / Unforeseen Condition",
  "Owner-Directed Scope Change",
  "Carrier Supplement / Insurance-Approved",
  "Code / Permit Requirement",
  "Scope Clarification",
  "Material / Unit Price Adjustment",
];
