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
   page per day/area). `types` says which job kinds see the form —
   restoration (water mitigation) and/or construction (remodel / rebuild);
   an entry without `types` shows for both. */
export const FORMS = [
  { key: "floorPlan",        name: "Floor Plan",         icon: "📏", multi: false,
    types: ["restoration", "construction"],
    blurb: "Dimensioned plan — prints FULL PAGE so measurements stay readable" },
  { key: "supportDocs",      name: "Supporting Docs",    icon: "📎", multi: true,
    types: ["restoration", "construction"],
    blurb: "Engineer's reports, estimates, letters — print full page + the AI reads them" },
  { key: "moistureMaps",     name: "Moisture Map",       icon: "🗺️", multi: true,
    types: ["restoration"],
    blurb: "Sketch the affected area + daily MC% readings" },
  { key: "dryingLogs",       name: "Drying Log",         icon: "💧", multi: true,
    types: ["restoration"],
    blurb: "Equipment runtime + psychrometric readings" },
  { key: "photos",           name: "Job Photos",         icon: "📷", multi: false,
    types: ["restoration", "construction"],
    blurb: "Before / during / after pictures" },
  { key: "contents",         name: "Contents",           icon: "📦", multi: false,
    types: ["restoration", "construction"],
    blurb: "Personal property inventory + pack-out" },
  { key: "workAuth",         name: "Work Authorization", icon: "✍️", multi: false,
    types: ["restoration", "construction"],
    blurb: "Sign on device or upload signed copy" },
  { key: "constructionLogs", name: "Field Report",       icon: "📋", multi: true,
    types: ["restoration", "construction"],
    blurb: "Crew → office: notes, issues, materials + photos (internal — not in packet)" },
  { key: "laborLog",         name: "Labor Log",          icon: "⏱", multi: false,
    types: ["restoration", "construction"],
    blurb: "Every job hour from QuickBooks Time — one page for the packet" },
  { key: "certDrying",       name: "Cert. of Drying",    icon: "✅", multi: false,
    types: ["restoration"],
    blurb: "IICRC S500 dry verification + sign-off" },
  { key: "scopeOfWork",      name: "Scope of Work",      icon: "📐", multi: false,
    types: ["construction"],
    blurb: "Per-area line items + allowances" },
  { key: "preConChecklist",  name: "Pre-Construction",   icon: "🗒️", multi: false,
    types: ["construction"],
    blurb: "Contract, deposit, permits, selections" },
  { key: "selections",       name: "Selections",         icon: "🎨", multi: false,
    types: ["construction"],
    blurb: "Owner finish & fixture choices vs. allowances" },
  { key: "subSchedule",      name: "Sub Schedule",       icon: "👷", multi: false,
    types: ["construction"],
    blurb: "Trades, dates, status & COI tracking" },
  { key: "inspections",      name: "Inspection Log",     icon: "🏛️", multi: true,
    types: ["construction"],
    blurb: "Permit inspections, results & corrections" },
  { key: "punchList",        name: "Punch List",         icon: "🔧", multi: false,
    types: ["construction"],
    blurb: "Walkthrough items to closeout + owner sign-off" },
  { key: "drawSchedule",     name: "Draw Schedule",      icon: "💰", multi: false,
    types: ["construction"],
    blurb: "Payment milestones — one tap to invoice a draw" },
  { key: "certCompletion",   name: "Cert. of Completion", icon: "🏁", multi: false,
    types: ["construction"],
    blurb: "Final checklist, warranty + signatures" },
  { key: "changeOrders",     name: "Change Order",       icon: "🔁", multi: true,
    types: ["restoration", "construction"],
    blurb: "Scope / supplement changes" },
  { key: "invoices",         name: "Construction Invoice", icon: "🧾", multi: true,
    types: ["restoration", "construction"],
    blurb: "T&M or contract billing — AI-drafted from the job's documentation or built by hand" },
  { key: "reconEstimates",   name: "Reconstruction Estimate", icon: "🏗️", multi: true,
    types: ["restoration"],
    blurb: "Proposed rebuild scope & pricing — AI-drafted from the documented damage, sends with the packet alongside the mitigation invoice" },
];

/* Job kind. Jobs created before this field existed carry no jobType, so
   always read it through this helper — never the raw field. */
export const jobType = (p) => (p && p.jobType === "construction" ? "construction" : "restoration");

/* The forms a job shows: its kind's forms, plus any form that already has
   data — so a job switched between kinds never hides documents it holds
   (tiles, packet, and old bookmarks all stay reachable). Entries without
   `types` apply to both kinds. */
export const formsFor = (p) => {
  const t = jobType(p);
  return FORMS.filter((f) => !f.types || f.types.includes(t) || formCount(p, f.key) > 0);
};

export const CONSTRUCTION_TYPES = [
  { value: "remodel",          label: "Remodel" },
  { value: "new_construction", label: "New Construction" },
  { value: "reconstruction",   label: "Reconstruction" },
];
export const constructionTypeLabel = (v) => CONSTRUCTION_TYPES.find((t) => t.value === v)?.label || "";

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
    // job kind + construction header (construction jobs only; blank on water jobs)
    jobType: "restoration",   // "restoration" | "construction"
    constructionType: "",     // remodel | new_construction | reconstruction
    contractAmount: "",
    startDate: "",
    targetCompletion: "",
    permitNumbers: "",
    lender: "",               // optional — lender on draw-schedule jobs
    linkedRestorationId: "",  // set when converted from a restoration job
    // project-level job photos (before/during/after, with caption + room)
    photos: [],
    // contents / personal property
    rooms: [],          // shared room list (strings), reused across the app
    boxes: [],          // pack-out boxes
    contents: [],       // inventory items
    // AI construction narrative (packet cover) — markdown prose + date generated
    narrative: "",
    narrativeDate: "",
    // AI progress update (construction jobs) — weekly owner/adjuster/lender summary
    progressNarrative: "",
    progressNarrativeDate: "",
    // form data
    workAuth: null,
    certDrying: null,
    moistureMaps: [],
    dryingLogs: [],
    constructionLogs: [],
    laborLog: null,
    changeOrders: [],
    invoices: [],
    reconEstimates: [],   // reconstruction estimates (restoration jobs — sent with the claim packet)
    // construction / remodel forms
    scopeOfWork: null,
    preConChecklist: null,
    selections: null,
    subSchedule: null,
    inspections: [],
    punchList: null,
    drawSchedule: null,
    certCompletion: null,
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

/* Porous categories — IICRC S500: generally non-restorable in Cat 3 losses */
export const POROUS_CATEGORIES = ["Clothing", "Bedding / Linens", "Documents", "Toys"];

export function newContentsItem() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    name: "", qty: "1", category: "", room: "", boxId: "",
    noBox: false, destination: "",   // large/loose items ship unboxed with their own destination
    condition: "", disposition: "salvageable",
    value: "",                       // estimated unit replacement cost (RCV)
    brand: "", model: "", age: "",   // for depreciation / loss claims
    lossJust: "",                    // one-line total-loss justification (AI-drafted, editable)
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
  return { id: uid(), label: "Box " + n, room: "", destination: "Storage", packedBy: "", packedDate: todayISO(),
    aiContents: "" };   // AI-listed contents from a box snapshot (editable text)
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
    rows: [],                                    // legacy work-log rows (form no longer collects them)
    notes: "", issues: "", materials: "", photos: [],
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
    startDate: "",      // count labor from this date (separates reconstruction from mitigation hours)
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
    billingModel: "tm",                   // "tm" (hourly + materials) | "contract" (set amount)
    contractAmount: "",                   // the agreed figure when billingModel = contract
    overheadPct: "10", profitPct: "10",   // Xactimate-style 10 & 10 O&P (T&M mode)
    deductible: "", previousPayments: "", taxRate: "",
    notes: "",
    attachments: [],   // supporting docs: [{ label, pages: [dataURL…] }]
  };
}
export function blankLineItem() {
  return { room: "", desc: "", qty: "", unit: "", price: "" };
}

/* Reconstruction estimate — same shape as an invoice (shared editor/AI
   machinery) flagged kind:"estimate": proposed rebuild scope priced line
   by line + O&P, not billing for performed work. */
export function newReconEstimate() {
  const e = newInvoice();
  e.kind = "estimate";
  e.terms = "";
  return e;
}

/* Supporting document — engineer's report, hygienist report, adjuster
   estimate, permit letter… Pages print FULL PAGE in the packet; the AI
   digest (aiDigest, tech-editable) rides the facts so the narrative,
   invoice, rebuild scope and assistant can cite it. */
export function newSupportDoc() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    title: "", docType: "", mode: "upload", uploadedPages: [], aiDigest: "",
  };
}

/* Floor plan — an uploaded dimensioned plan (PDF/photo) whose pages print
   FULL PAGE in the packet; mode stays "upload" so the packet's uploaded-
   document path renders it instead of a form. */
export function newFloorPlan() {
  return { createdAt: new Date().toISOString(), mode: "upload", uploadedPages: [] };
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

/* ============================================================
   Construction / remodel forms (jobType "construction")
   ============================================================ */
export const TRADES = [
  "Demo", "Framing", "Electrical", "Plumbing", "HVAC", "Insulation",
  "Drywall", "Paint", "Flooring", "Trim / Doors", "Cabinets / Counters", "Roofing", "Other",
];
export const SELECTION_STATUSES = ["pending", "ordered", "delivered", "installed"];
export const SUB_STATUSES = ["scheduled", "on-site", "done", "no-show"];
export const PUNCH_STATUSES = ["open", "in-progress", "done", "verified"];
export const PUNCH_PRIORITIES = ["low", "normal", "high"];
export const INSPECTION_TYPES = [
  "Footing / Foundation", "Framing", "Rough Electrical", "Rough Plumbing", "Rough Mechanical",
  "Insulation", "Drywall / Nailing", "Final Electrical", "Final Plumbing", "Final Mechanical", "Final / CO",
];
export const INSPECTION_RESULTS = ["pass", "fail", "partial"];

export function newScopeOfWork() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    date: todayISO(),
    summary: "",
    areas: [ blankScopeArea() ],
    allowances: [ blankAllowanceRow() ],
    exclusions: "",
    referencePlans: [],   // floor plans / sketches (carried over from a linked restoration job)
  };
}
export function blankScopeArea() {
  return { id: uid(), name: "", items: [ blankScopeItem() ] };
}
export function blankScopeItem() {
  return { trade: "", desc: "", qty: "", unit: "", notes: "" };
}
export function blankAllowanceRow() {
  return { item: "", amount: "", notes: "" };
}

/* Pre-construction checklist items — completeness gates on the indexes below. */
export const PRECON_ITEMS = [
  "Contract signed",
  "Deposit received",
  "Permits pulled (list below)",
  "HOA / covenant approval (if required)",
  "Utilities located (dig line called)",
  "Selections finalized with owner",
  "Material lead times confirmed",
  "Pre-construction photos taken",
];
export const PRECON_CONTRACT = 0;
export const PRECON_PERMITS = 2;

export function newPreConChecklist() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    items: {},           // checkbox map keyed by PRECON_ITEMS index
    permits: [ blankPermitRow() ],
    notes: "",
  };
}
export function blankPermitRow() {
  return { type: "", number: "", pulled: "", notes: "" };
}

export function newSelections() {
  return { id: uid(), createdAt: new Date().toISOString(), rows: [ blankSelectionRow() ], notes: "" };
}
export function blankSelectionRow() {
  return {
    area: "", item: "", spec: "", allowance: "", actual: "", status: "pending",
    leadWeeks: "", neededBy: "", decidedDate: "", ownerInit: "",
  };
}

export function newSubSchedule() {
  return { id: uid(), createdAt: new Date().toISOString(), rows: [ blankSubRow() ], notes: "" };
}
export function blankSubRow() {
  return {
    trade: "", company: "", contact: "", schedStart: "", schedEnd: "",
    actStart: "", actEnd: "", status: "scheduled", coi: false, notes: "",
  };
}

export function newInspection() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    type: "", scheduled: "", inspector: "", result: "",
    corrections: "", reinspection: "", notes: "",
  };
}

export function newPunchList() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    rows: [ blankPunchRow() ],
    walkthroughDate: "",
    sigOwner: "", sigOwnerName: "", sigOwnerDate: "",
  };
}
export function blankPunchRow() {
  return {
    area: "", item: "", trade: "", priority: "normal", status: "open",
    photos: [], completedBy: "", completedDate: "",
  };
}

export function newDrawSchedule() {
  return { id: uid(), createdAt: new Date().toISOString(), rows: [ blankDrawRow() ], notes: "" };
}
export function blankDrawRow() {
  return { desc: "", pct: "", amount: "", invoicedDate: "", paidDate: "", invoiceId: "" };
}

/* Certificate of Completion checklist — mirrors certDrying's structure. */
export const COMPLETION_ITEMS = [
  "All contracted scope complete",
  "Punch list cleared & verified",
  "Final inspections passed / CO issued (if required)",
  "Site cleaned & debris removed",
  "Owner walkthrough completed",
  "Manuals / warranties / registrations delivered",
  "Final invoice issued",
];
export function newCertCompletion() {
  return {
    id: uid(), createdAt: new Date().toISOString(),
    certNo: "", issueDate: todayISO(), completionDate: "",
    scopeSummary: "",
    checklist: {},        // keyed by COMPLETION_ITEMS index
    warrantyWorkmanship: "1 year", warrantyNotes: "",
    mode: "sign", uploadedDoc: "", uploadedPages: [],
    sigContractor: "", sigContractorName: "", sigContractorDate: todayISO(),
    sigOwner: "", sigOwnerName: "", sigOwnerDate: todayISO(),
  };
}
