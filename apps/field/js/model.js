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
};

/* The 7 forms from the packet. `multi` forms can have many instances
   (you fill a new Drying Log / Moisture Map page each day/area). */
export const FORMS = [
  { key: "moistureMaps",     name: "Moisture Map",       icon: "🗺️", multi: true,  hero: true,
    blurb: "Sketch the affected area + daily MC% readings" },
  { key: "dryingLogs",       name: "Drying Log",         icon: "💧", multi: true,  hero: true,
    blurb: "Equipment runtime + psychrometric readings" },
  { key: "workAuth",         name: "Work Authorization", icon: "✍️", multi: false,
    blurb: "Sign on device or upload signed copy" },
  { key: "constructionLogs", name: "Daily Const. Log",   icon: "📋", multi: true,
    blurb: "Crew, tasks & hours" },
  { key: "certDrying",       name: "Cert. of Drying",    icon: "✅", multi: false,
    blurb: "IICRC S500 dry verification + sign-off" },
  { key: "changeOrders",     name: "Change Order",       icon: "🔁", multi: true,
    blurb: "Scope / supplement changes" },
  { key: "invoices",         name: "Invoice",            icon: "🧾", multi: true,
    blurb: "Mitigation billing" },
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
    // form data
    workAuth: null,
    certDrying: null,
    moistureMaps: [],
    dryingLogs: [],
    constructionLogs: [],
    changeOrders: [],
    invoices: [],
  };
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
    sketch: "",                                  // PNG dataURL
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
    dryoutStart: "", techSupervisor: "",
    equipment: [ blankEquipRow() ],
    readings: [ blankPsychroRow() ],
  };
}
export function blankEquipRow() {
  return { asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" };
}
export function blankPsychroRow() {
  return {
    date: todayISO(), timeIn: "", timeOut: "",
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
    uploadedDoc: "",             // dataURL of a wet-signed scan/photo
  };
}

export function newCertDrying() {
  return {
    certNo: "", issueDate: todayISO(), dryingDays: "",
    dryStart: "", dryComplete: "",
    affectedAreas: "",
    verification: [ blankVerifyRow() ],
    dehuDays: "", amDays: "", scrubDays: "", heaterDays: "",
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
