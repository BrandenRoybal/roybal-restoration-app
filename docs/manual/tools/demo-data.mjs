/* Demo data for the manual's screenshots.
   EVERYTHING here is made up: names, addresses (no real street numbers),
   555 phone numbers, example.com emails, claim numbers and amounts.
   Never paste a real customer, job or receipt into this file. */

const DAY = 864e5;
const NOW = Date.parse("2026-10-06T18:00:00Z");
const iso = (dOff = 0) => new Date(NOW + dOff * DAY).toISOString();
const ymd = (dOff = 0) => iso(dOff).slice(0, 10);

/* ---------- placeholder pictures (drawn, not photographed) ---------- */
const svg = (w, h, body) => "data:image/svg+xml;base64," +
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`).toString("base64");

export function roomPhoto(wall = "#d9cbb3", floor = "#8a6a4a", stain = true, label = "") {
  return svg(800, 600, `
    <rect width="800" height="420" fill="${wall}"/>
    <rect y="420" width="800" height="180" fill="${floor}"/>
    <rect y="405" width="800" height="18" fill="#f4efe6"/>
    <rect x="520" y="110" width="170" height="295" fill="#bfae92" stroke="#7b6a52" stroke-width="6"/>
    <circle cx="665" cy="265" r="8" fill="#7b6a52"/>
    ${stain ? `<path d="M40 405 C 90 330 160 360 220 300 C 280 250 330 320 380 290 C 420 270 450 350 470 405 Z" fill="#7a5b3a" opacity=".35"/>
               <ellipse cx="260" cy="500" rx="230" ry="45" fill="#3d5a73" opacity=".35"/>` : ""}
    ${label ? `<text x="24" y="580" font-family="Arial" font-size="26" fill="#fff" opacity=".85">${label}</text>` : ""}`);
}
export function cutPhoto() {
  return svg(800, 600, `
    <rect width="800" height="600" fill="#e7dfcf"/>
    <rect y="300" width="800" height="120" fill="#c9a77a"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="${60 + i * 125}" y="300" width="18" height="120" fill="#a07c50"/>`).join("")}
    <rect y="420" width="800" height="180" fill="#9b9b95"/>
    <rect x="100" y="470" width="90" height="60" rx="10" fill="#1f3354"/><rect x="560" y="455" width="140" height="90" rx="8" fill="#f26a21"/>`);
}
export function receiptImg(store, lines, total) {
  const rows = lines.map((l, i) => `<text x="30" y="${150 + i * 34}" font-family="Courier New" font-size="22">${l[0]}</text><text x="370" y="${150 + i * 34}" font-family="Courier New" font-size="22" text-anchor="end">${l[1]}</text>`).join("");
  const y = 150 + lines.length * 34 + 30;
  return svg(400, y + 90, `<rect width="400" height="${y + 90}" fill="#fbfaf6"/>
    <text x="200" y="60" font-family="Arial" font-weight="bold" font-size="28" text-anchor="middle">${store}</text>
    <text x="200" y="95" font-family="Courier New" font-size="18" text-anchor="middle">DEMO RECEIPT · NOT REAL</text>${rows}
    <line x1="30" x2="370" y1="${y - 18}" y2="${y - 18}" stroke="#000" stroke-dasharray="6 4"/>
    <text x="30" y="${y + 14}" font-family="Courier New" font-weight="bold" font-size="24">TOTAL</text>
    <text x="370" y="${y + 14}" font-family="Courier New" font-weight="bold" font-size="24" text-anchor="end">${total}</text>`);
}
export function signature(name) {
  return svg(500, 140, `<path d="M20 100 C 60 20 90 130 130 70 S 190 40 210 95 S 280 30 310 80 S 380 110 470 60" fill="none" stroke="#14213d" stroke-width="4" stroke-linecap="round"/>
    <text x="480" y="130" font-family="Arial" font-size="14" fill="#8a94a6" text-anchor="end">${name}</text>`);
}
export function floorPlan() {
  return svg(900, 600, `<rect width="900" height="600" fill="#fff"/>
    <g fill="none" stroke="#1f3354" stroke-width="8"><rect x="40" y="40" width="820" height="520"/><path d="M420 40 V330 M40 330 H600 M600 330 V560"/></g>
    <g font-family="Arial" font-size="24" fill="#44556b"><text x="160" y="190">Kitchen 14'x12'</text><text x="560" y="190">Living Room 18'x16'</text><text x="200" y="450">Hall / Laundry</text><text x="660" y="450">Bath</text></g>`);
}

/* ---------- jobs (field_projects rows) ---------- */
const reading = (dOff, vals) => ({ date: ymd(dOff), values: [...vals, ...Array(13 - vals.length).fill("")], notes: "" });

const whitaker = {
  id: "demo-job-whitaker", createdAt: iso(-6), updatedAt: iso(-0.1), createdBy: "cj@example.com",
  jobType: "restoration", workOrderNo: "RC-DEMO-1001", claimNo: "DEMO-CLM-48213",
  customer: "Dana Whitaker", address: "100 Demo Spruce Ln, North Pole, AK 99705",
  phone: "907-555-0142", email: "dana.whitaker@example.com",
  carrier: "Northstar Mutual (demo)", adjuster: "Sam Ortega", lossCause: "Washing machine supply line burst",
  dateOfLoss: ymd(-6), waterCategory: "2", waterClass: "2", dryingSystem: "Closed", lossTypes: ["water"],
  rooms: ["Kitchen", "Hall / Laundry", "Living Room"],
  photos: [
    { id: "ph1", by: "cj@example.com", src: roomPhoto("#d9cbb3", "#8a6a4a", true, "Before"), caption: "Standing water at laundry", room: "Hall / Laundry", stage: "before", ts: iso(-6) },
    { id: "ph2", by: "cj@example.com", src: roomPhoto("#cfd8dc", "#7d6b55", true), caption: "Wicking on kitchen drywall", room: "Kitchen", stage: "before", ts: iso(-6) },
    { id: "ph3", by: "cj@example.com", src: cutPhoto(), caption: "2 ft flood cut, air movers set", room: "Hall / Laundry", stage: "during", ts: iso(-5) },
    { id: "ph4", by: "cj@example.com", src: cutPhoto(), caption: "Dehu + 3 air movers, day 2", room: "Kitchen", stage: "during", ts: iso(-4) },
    { id: "ph5", by: "cj@example.com", src: roomPhoto("#e6e1d6", "#8a6a4a", false, "After"), caption: "Dry, ready for rebuild", room: "Kitchen", stage: "after", ts: iso(-1) },
  ],
  moistureMaps: [{
    id: "mm1", by: "cj@example.com", createdAt: iso(-6), label: "Kitchen / laundry wall", material: "Drywall", dryGoal: "12",
    meter: "Delmhorst BD-2100", ambientTemp: "70", ambientRH: "38", equipmentOnSite: "1 LGR dehu, 4 air movers", technician: "CJ",
    floorPlan: floorPlan(), sketch: floorPlan(), strokes: "", markerNext: 6, equipmentPlan: [], equipmentPlanImg: "", photos: [],
    readings: [reading(-6, ["38", "41", "35", "29", "22"]), reading(-5, ["27", "30", "24", "19", "15"]), reading(-4, ["18", "21", "16", "13", "11"]), reading(-3, ["12", "13", "11", "10", "10"])],
  }],
  dryingLogs: [{
    id: "dl1", by: "cj@example.com", createdAt: iso(-6), dryoutStart: ymd(-6), dryoutFinish: ymd(-3), techSupervisor: "CJ",
    equipment: [
      { asset: "DH-03", type: "LGR Dehumidifier", location: "Kitchen", placed: ymd(-6), removed: ymd(-3), hours: "72", notes: "" },
      { asset: "AM-11", type: "Air Mover", location: "Laundry", placed: ymd(-6), removed: ymd(-3), hours: "72", notes: "" },
      { asset: "AM-12", type: "Air Mover", location: "Kitchen", placed: ymd(-6), removed: ymd(-3), hours: "72", notes: "" },
    ],
    readings: [
      { date: ymd(-6), time: "09:00", outT: "38", outRH: "70", outGPP: "", refT: "70", refRH: "35", refGPP: "", affT: "72", affRH: "62", affGPP: "", gd: "", dehu: "1", am: "4", scrub: "0", tech: "CJ", notes: "Set" },
      { date: ymd(-5), time: "09:30", outT: "35", outRH: "72", outGPP: "", refT: "70", refRH: "34", refGPP: "", affT: "78", affRH: "40", affGPP: "", gd: "", dehu: "1", am: "4", scrub: "0", tech: "CJ", notes: "" },
      { date: ymd(-4), time: "10:00", outT: "33", outRH: "68", outGPP: "", refT: "70", refRH: "34", refGPP: "", affT: "80", affRH: "30", affGPP: "", gd: "", dehu: "1", am: "3", scrub: "0", tech: "Greg", notes: "" },
    ],
  }],
  workAuth: { date: ymd(-6), scope: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, mode: "sign", smsConsent: true,
    ownerSig: signature("Dana Whitaker"), ownerName: "Dana Whitaker", ownerDate: ymd(-6), repSig: signature("CJ"), repName: "CJ (Roybal)", repDate: ymd(-6), uploadedDoc: "", uploadedPages: [] },
  receipts: [
    { id: "rc1", by: "cj@example.com", createdAt: iso(-6), vendor: "Demo Hardware", date: ymd(-6), amount: "186.42", subtotal: "186.42", tax: "0",
      category: "materials", paidWith: "card", cardLast4: "0000", receiptNo: "D-55102", notes: "Antimicrobial, poly, tape",
      photo: receiptImg("DEMO HARDWARE", [["ANTIMICROBIAL 1GAL", "64.98"], ["6MIL POLY 10x100", "82.47"], ["ZIP POLE TAPE", "38.97"]], "186.42"),
      extraPages: [], items: [{ id: "i1", desc: "Antimicrobial 1 gal", qty: "2", unit: "ea", price: "32.49", sku: "" }, { id: "i2", desc: "6 mil poly 10x100", qty: "1", unit: "ea", price: "82.47", sku: "" }, { id: "i3", desc: "Zip pole tape", qty: "3", unit: "ea", price: "12.99", sku: "" }],
      ai: { at: iso(-6), model: "demo", confidence: 0.96 } },
    { id: "rc2", by: "greg@example.com", createdAt: iso(-4), vendor: "Demo Landfill", date: ymd(-4), amount: "48.00", subtotal: "48.00", tax: "0",
      category: "dump", paidWith: "cash", cardLast4: "", receiptNo: "T-2231", notes: "Wet drywall + pad", photo: receiptImg("DEMO LANDFILL", [["MIXED C&D 0.4T", "48.00"]], "48.00"),
      extraPages: [], items: [], ai: { at: iso(-4), model: "demo", confidence: 0.9 } },
  ],
  constructionLogs: [], contents: [], boxes: [], changeOrders: [], invoices: [], reconEstimates: [], inspections: [],
  certDrying: null, laborLog: null, portalShare: { id: "demo-portal-1", enabled: true, shareToken: "demo-token", status: "drying", sharedPhotoIds: ["ph1", "ph3", "ph5"], sharedDocIds: [], shareDrying: true, publishedAt: iso(-1), notifyOnStatus: true, selectionsSource: null, lastNotifiedStatus: "drying" },
};

const kessler = {
  id: "demo-job-kessler", createdAt: iso(-2), updatedAt: iso(-0.3), createdBy: "branden@example.com",
  jobType: "restoration", workOrderNo: "RC-DEMO-1002", claimNo: "DEMO-CLM-50977",
  customer: "Kessler Rentals (Unit B)", address: "200 Example Birch Ct, Fairbanks, AK 99709", phone: "907-555-0188", email: "pm@example.com",
  carrier: "Aurora Casualty (demo)", adjuster: "Lee Park", lossCause: "Frozen pipe in exterior wall", dateOfLoss: ymd(-2),
  waterCategory: "1", waterClass: "3", dryingSystem: "Closed", lossTypes: ["water"], rooms: ["Bedroom 1", "Bath"],
  photos: [{ id: "k1", by: "branden@example.com", src: roomPhoto("#e8e2d0", "#6d5a46", true, "Before"), caption: "Ceiling + wall wet", room: "Bedroom 1", stage: "before", ts: iso(-2) }],
  moistureMaps: [], dryingLogs: [{ id: "dl2", by: "", createdAt: iso(-2), dryoutStart: ymd(-2), dryoutFinish: "", techSupervisor: "Greg",
    equipment: [{ asset: "DH-05", type: "LGR Dehumidifier", location: "Bedroom 1", placed: ymd(-9), removed: "", hours: "", notes: "" }], readings: [] }],
  workAuth: null, receipts: [], constructionLogs: [], contents: [], boxes: [], changeOrders: [], invoices: [], reconEstimates: [], inspections: [],
  certDrying: null, laborLog: null, portalShare: null,
};

const marsh = {
  id: "demo-job-marsh", createdAt: iso(-30), updatedAt: iso(-0.2), createdBy: "branden@example.com",
  jobType: "construction", constructionType: "remodel", workOrderNo: "RC-DEMO-2001", claimNo: "",
  customer: "Jordan & Casey Marsh", address: "300 Sample Ridge Rd, Fairbanks, AK 99712", phone: "907-555-0117", email: "marsh@example.com",
  contractAmount: "84500", startDate: ymd(-21), targetCompletion: ymd(35), permitNumbers: "DEMO-BP-0042", lender: "",
  rooms: ["Kitchen", "Mudroom", "Primary Bath"],
  photos: [
    { id: "m1", by: "greg@example.com", src: cutPhoto(), caption: "Mudroom framing", room: "Mudroom", stage: "during", ts: iso(-8) },
    { id: "m2", by: "greg@example.com", src: roomPhoto("#f1ede4", "#b48b5e", false), caption: "Kitchen drywall hung", room: "Kitchen", stage: "during", ts: iso(-3) },
  ],
  receipts: [
    { id: "mr1", by: "greg@example.com", createdAt: iso(-10), vendor: "Demo Lumber Yard", date: ymd(-10), amount: "1342.18", subtotal: "1342.18", tax: "0",
      category: "materials", paidWith: "account", cardLast4: "", receiptNo: "L-88120", notes: "Mudroom framing package",
      photo: receiptImg("DEMO LUMBER YARD", [["2x6x10 KD (40)", "512.00"], ["7/16 OSB (24)", "540.48"], ["LVL 1.75x11.875", "289.70"]], "1342.18"), extraPages: [],
      items: [{ id: "a", desc: "2x6x10 KD", qty: "40", unit: "ea", price: "12.80", sku: "" }, { id: "b", desc: "7/16 OSB", qty: "24", unit: "sh", price: "22.52", sku: "" }, { id: "c", desc: "LVL 1.75x11.875 x 14'", qty: "1", unit: "ea", price: "289.70", sku: "" }],
      ai: { at: iso(-10), model: "demo", confidence: 0.94 } },
    { id: "mr2", by: "greg@example.com", createdAt: iso(-3), vendor: "Demo Paint Co.", date: ymd(-3), amount: "214.60", subtotal: "214.60", tax: "0",
      category: "materials", paidWith: "account", cardLast4: "", receiptNo: "P-1093", notes: "Primer + mud",
      photo: receiptImg("DEMO PAINT CO.", [["PVA PRIMER 5G", "139.99"], ["JOINT COMPOUND", "74.61"]], "214.60"), extraPages: [], items: [], ai: { at: iso(-3), model: "demo", confidence: 0.92 } },
  ],
reconEstimates: [{ id: "est1", by: "branden@example.com", createdAt: iso(-35), kind: "estimate", invoiceNo: "RC-MAR-0826", invoiceDate: ymd(-35), dueDate: "", terms: "",
    lossSummary: "Kitchen refresh and new mudroom off the garage entry.", billingModel: "contract", contractAmount: "84500", opMode: "pct", opAuto: false, overheadPct: "10", profitPct: "10",
    overheadAmount: "", profitAmount: "", deductible: "", previousPayments: "", taxRate: "", notes: "Alaska winter conditions: heated enclosure allowance included.", attachments: [], scopeInterview: null,
    items: [
      { id: "e1", room: "Mudroom", desc: "Frame 8x10 mudroom addition, 2x6 @ 16\" o.c.", qty: "1", unit: "LS", price: "9800" },
      { id: "e2", room: "Mudroom", desc: "Insulate R-21 walls / R-49 ceiling, vapor barrier", qty: "420", unit: "SF", price: "4.85" },
      { id: "e3", room: "Kitchen", desc: "Remove and replace drywall, Level 4 finish", qty: "380", unit: "SF", price: "6.40" },
      { id: "e4", room: "Kitchen", desc: "Cabinet install (owner-supplied boxes)", qty: "18", unit: "LF", price: "145" },
      { id: "e5", room: "Primary Bath", desc: "Tile shower surround, waterproof membrane", qty: "96", unit: "SF", price: "38" },
    ] }],
  scopeOfWork: null, preConChecklist: null, selections: null, subSchedule: null, punchList: null, drawSchedule: null, certCompletion: null,
  moistureMaps: [], dryingLogs: [], workAuth: null, constructionLogs: [], contents: [], boxes: [], changeOrders: [], invoices: [], inspections: [],
  certDrying: null, laborLog: null, portalShare: null,
};

const birch = {
  id: "demo-job-birch", createdAt: iso(-60), updatedAt: iso(-1), createdBy: "branden@example.com",
  jobType: "construction", constructionType: "new_construction", workOrderNo: "RC-DEMO-2002",
  customer: "Birchwood Duplex (demo)", address: "400 Placeholder Ave, North Pole, AK 99705", phone: "907-555-0160", email: "owner@example.com",
  contractAmount: "212000", startDate: ymd(-55), targetCompletion: ymd(60), rooms: [], photos: [], receipts: [],
  moistureMaps: [], dryingLogs: [], workAuth: null, constructionLogs: [], contents: [], boxes: [], changeOrders: [], invoices: [], reconEstimates: [], inspections: [],
  certDrying: null, laborLog: null, portalShare: null,
};

export const JOBS = [whitaker, kessler, marsh, birch];
export const fieldRows = () => JOBS.map((d) => ({ id: d.id, data: d, deleted: false, updated_at: d.updatedAt }));

/* ---------- board / leads (coordination_jobs rows) ---------- */
export const LEADS = [
  { id: "demo-lead-1", data: { title: "Basement water, sump failed", customer: "Riley Chen", phone: "907-555-0101", address: "500 Demo Loop, Fairbanks, AK",
      message: "Sump pump quit overnight, about an inch of water in the finished basement. Can someone come today?", channel: "phone", source: "phone", priority: "emergency",
      stage: "lead", createdAt: iso(-0.05), estValue: 6500, leadLog: [] } },
  { id: "demo-lead-2", data: { title: "Deck rebuild quote", customer: "Morgan Ellis", phone: "907-555-0102", address: "600 Sample Way, North Pole, AK",
      message: "Looking for a quote to replace a 12x20 deck next spring.", channel: "web", source: "web", stage: "lead", createdAt: iso(-1.2),
      firstTouchAt: iso(-1.1), estValue: 18000, siteVisit: { at: iso(2), by: "cj@example.com", status: "booked" }, leadLog: [{ kind: "contacted", at: iso(-1.1) }] } },
  { id: "demo-lead-3", data: { title: "Bathroom remodel", customer: "Avery Brooks", phone: "907-555-0103", address: "700 Example St, Fairbanks, AK",
      message: "Full gut of an upstairs bath. Tile shower, new vanity.", channel: "referral", source: "referral", stage: "lead", createdAt: iso(-4),
      firstTouchAt: iso(-3.9), nextAction: "Send ROM estimate", nextActionAt: iso(-1), estValue: 32000, leadLog: [] } },
];

/* ---------- crew (crew_members rows) ---------- */
export const CREW = [
  { id: "crew-cj", data: { id: "crew-cj", name: "CJ", color: "#f26a21", role: "PM / crew lead", phone: "907-555-0201", email: "cj@example.com", active: true, hourlyRate: 0 } },
  { id: "crew-greg", data: { id: "crew-greg", name: "Greg", color: "#2f7de1", role: "Lead carpenter", phone: "907-555-0202", email: "greg@example.com", active: true, hourlyRate: 0 } },
  { id: "crew-alex", data: { id: "crew-alex", name: "Alex", color: "#16a34a", role: "Crew", phone: "907-555-0203", email: "alex@example.com", active: true, hourlyRate: 0 } },
  { id: "crew-sam", data: { id: "crew-sam", name: "Sam", color: "#9333ea", role: "Crew", phone: "907-555-0204", email: "sam@example.com", active: true, hourlyRate: 0 } },
  { id: "crew-jesse", data: { id: "crew-jesse", name: "Jesse", color: "#0d9488", role: "Crew", phone: "907-555-0205", email: "jesse@example.com", active: true, hourlyRate: 0 } },
  { id: "crew-taylor", data: { id: "crew-taylor", name: "Taylor", color: "#ca8a04", role: "Crew", phone: "907-555-0206", email: "taylor@example.com", active: true, hourlyRate: 0 } },
].map((r) => ({ ...r, deleted: false, updated_at: iso(-30) }));

/* ---------- board jobs (coordination_jobs rows) ---------- */
const bj = (id, d) => ({ id, deleted: false, updated_at: iso(-1), data: { id, scheduleMode: "manual", priority: "normal", materials: "ordered", ...d } });
export const BOARD_JOBS = [
  bj("demo-board-whitaker", { title: "Whitaker water loss", customer: "Dana Whitaker", phone: "907-555-0142", address: "100 Demo Spruce Ln, North Pole", type: "water", stage: "in_progress",
    startDate: ymd(-6), pinnedStart: ymd(-6), targetDate: ymd(2), estimatedHours: 40, contractValue: 7800, crewIds: ["crew-cj"], fieldJobId: "demo-job-whitaker" }),
  bj("demo-board-kessler", { title: "Kessler Unit B frozen pipe", customer: "Kessler Rentals", phone: "907-555-0188", address: "200 Example Birch Ct, Fairbanks", type: "water", stage: "in_progress",
    startDate: ymd(-2), pinnedStart: ymd(-2), targetDate: ymd(4), estimatedHours: 24, contractValue: 5200, crewIds: ["crew-sam"], fieldJobId: "demo-job-kessler", priority: "high" }),
  bj("demo-board-marsh", { title: "Marsh kitchen + mudroom", customer: "Jordan & Casey Marsh", phone: "907-555-0117", address: "300 Sample Ridge Rd, Fairbanks", type: "remodel", stage: "in_progress",
    startDate: ymd(-21), pinnedStart: ymd(-21), targetDate: ymd(35), estimatedHours: 520, contractValue: 84500, billedToDate: 33800, crewIds: ["crew-greg", "crew-alex"], fieldJobId: "demo-job-marsh",
    subtasks: [{ id: "p1", name: "Demo + framing", durationDays: 8, estimatedHours: 120 }, { id: "p2", name: "Rough-in", durationDays: 6, estimatedHours: 90 }, { id: "p3", name: "Insulation + drywall", durationDays: 9, estimatedHours: 140 }, { id: "p4", name: "Finishes", durationDays: 12, estimatedHours: 170 }] }),
  bj("demo-board-birch", { title: "Birchwood Duplex", customer: "Birchwood Duplex (demo)", address: "400 Placeholder Ave, North Pole", type: "new_build", stage: "scheduled",
    startDate: ymd(9), pinnedStart: ymd(9), targetDate: ymd(80), estimatedHours: 1400, contractValue: 212000, crewIds: [], fieldJobId: "demo-job-birch" }),
  bj("demo-board-hold", { title: "Garage slab (waiting on permit)", customer: "T. Nguyen", address: "800 Demo Rd, Fairbanks", type: "remodel", stage: "on_hold",
    startDate: ymd(14), pinnedStart: ymd(14), targetDate: ymd(20), estimatedHours: 60, contractValue: 14800, crewIds: [] }),
  bj("demo-board-punch", { title: "Basement finish punch list", customer: "R. Alvarez", address: "900 Example Ct, North Pole", type: "remodel", stage: "final",
    startDate: ymd(-40), pinnedStart: ymd(-40), targetDate: ymd(1), estimatedHours: 300, contractValue: 46000, billedToDate: 41400, crewIds: ["crew-jesse"] }),
  ...LEADS.map((l) => bj(l.id, { ...l.data, type: l.data.channel === "phone" ? "water" : "remodel", scheduleMode: "auto" })),
  { id: "00000000-0000-0000-0000-000000000001", deleted: false, updated_at: iso(-30), data: { workDays: [1, 2, 3, 4, 5], hoursPerDay: 10, holidays: [], archived: true } },
];

export const TIME = [
  ...["crew-cj"].flatMap((c) => [-5, -4, -3, -2, -1, 0].map((d) => ({ crewId: c, jobId: "demo-board-whitaker", date: ymd(d), hours: 6 }))),
  ...["crew-greg", "crew-alex"].flatMap((c) => [-6, -5, -4, -3, 0].map((d) => ({ crewId: c, jobId: "demo-board-marsh", date: ymd(d), hours: 9, start: "07:30", finish: "16:30" }))),
].map((d, i) => ({ id: "t" + i, deleted: false, updated_at: iso(-1), data: { id: "t" + i, ...d } }));

/* ---------- office feeds ---------- */
export const PENDING_ACTIONS = [
  { id: "pa1", code: "12", kind: "emailSend", label: "Overdue invoice reminder", params: { to: "pm@example.com", subject: "Invoice RC-DEMO-1002 — friendly reminder",
      body: "Hi Lee,\n\nA quick reminder that invoice RC-DEMO-1002 for the Unit B water mitigation ($5,200.00) is now 15 days past due. The drying logs and certificate are attached to the original invoice.\n\nThanks,\nRoybal Construction" },
    job_id: "demo-job-kessler", proposed_by: "morning-brief", status: "pending", result: null, created_at: iso(-0.2), expires_at: iso(1.5), executed_at: null },
  { id: "pa2", code: "13", kind: "boardEdit", label: "Add phase from QuickBooks Time", params: { phase: { name: "Trim carpentry", estimatedHours: 32 }, rowId: "demo-board-marsh" },
    job_id: null, proposed_by: "qb-time", status: "pending", result: null, created_at: iso(-0.1), expires_at: iso(1.5), executed_at: null },
  { id: "pa3", code: "9", kind: "sendText", label: "On-our-way text", params: { to: "907-555-0142", message: "Hi Dana, CJ is on the way for today's moisture readings. About 20 minutes out." },
    job_id: "demo-job-whitaker", proposed_by: "sms-assist", status: "executed", result: { ok: true }, created_at: iso(-1), expires_at: iso(1), executed_at: iso(-0.9) },
];
export const SMS = [
  { created_at: iso(-0.05), direction: "inbound", from_number: "+19075550142", to_number: "+18885550100", body: "Thanks! Back door is unlocked.", kind: "reply", status: "received", sent_by: "" },
  { created_at: iso(-0.07), direction: "outbound", to_number: "+19075550142", from_number: "+18885550100", body: "Hi Dana, CJ is on the way for today's readings.", kind: "onmyway", status: "delivered", sent_by: "cj@example.com" },
  { created_at: iso(-1.2), direction: "outbound", to_number: "+19075550117", from_number: "+18885550100", body: "Drywall is done in the kitchen. Paint starts Monday.", kind: "update", status: "delivered", sent_by: "branden@example.com" },
];
export const EMAILS = [
  { id: "e1", thread_id: "t1", from_addr: "lee.park@example.com", from_name: "Lee Park (adjuster)", subject: "RE: DEMO-CLM-50977 drying logs", body_text: "Received the logs, thanks. Can you send the moisture map for Bedroom 1?", job_id: "demo-job-kessler", matched_by: "claim", received_at: iso(-0.3) },
];
export const VENDORS = [
  { vendor_key: "demo hardware", display_name: "Demo Hardware", return_days: 90, notes: "" },
  { vendor_key: "demo lumber yard", display_name: "Demo Lumber Yard", return_days: 30, notes: "Restocking fee on special orders" },
  { vendor_key: "demo paint co.", display_name: "Demo Paint Co.", return_days: 30, notes: "" },
];
export const CONTACTS = [
  { id: "c1", name: "Dana Whitaker", role: "customer", phone: "907-555-0142", email: "dana.whitaker@example.com", company: "", marketing_opt_in: true },
  { id: "c2", name: "Lee Park", role: "adjuster", phone: "907-555-0301", email: "lee.park@example.com", company: "Aurora Casualty (demo)", marketing_opt_in: false },
  { id: "c3", name: "Jordan Marsh", role: "customer", phone: "907-555-0117", email: "marsh@example.com", company: "", marketing_opt_in: true },
  { id: "c4", name: "Kessler Rentals", role: "property_manager", phone: "907-555-0188", email: "pm@example.com", company: "Kessler Rentals", marketing_opt_in: false },
  { id: "c5", name: "Riley Chen", role: "customer", phone: "907-555-0101", email: "", company: "", marketing_opt_in: false },
];

/* ---------- customer portal (roybal-portal "view") ---------- */
export const PORTAL_TOKEN = "a1b2c3d4e5f60718293a";
const H = (n) => n.toString(16).padStart(64, "0");
export const PORTAL_MEDIA = { [H(1)]: marsh.photos[0].src, [H(2)]: marsh.photos[1].src, [H(3)]: roomPhoto("#efe9dc", "#b48b5e", false) };
export const PORTAL_VIEW = {
  claim: null,
  job: { customerName: "Jordan & Casey Marsh", address: "300 Sample Ridge Rd, Fairbanks, AK", status: "drywall",
    milestones: [["contract", "Contract", "done"], ["permits", "Permits", "done"], ["scheduled", "Scheduled", "done"], ["rough", "Framing & rough-in", "done"],
      ["drywall", "Insulation & drywall", "current"], ["finishes", "Finishes", "upcoming"], ["walkthrough", "Final walkthrough", "upcoming"], ["complete", "Job complete", "upcoming"]]
      .map(([key, label, state]) => ({ key, label, state })) },
  crew: [{ name: "Greg", role: "Lead carpenter", photoUrl: "", years: 18, certs: "", blurb: "Runs the framing and finish work on your project." }],
  drying: null, closeout: null,
  approvals: [{ id: "ap1", kind: "changeOrder", hasDoc: true, viewedAt: null, title: "Change Order #2 — mudroom bench + hooks", description: "Built-in bench with boot storage and coat hooks in the mudroom.",
    amountDelta: 1850, status: "pending", respondedAt: null, signedName: "" }],
  billing: { invoiced: 33800, paid: 25350, balance: 8450, payUrl: "https://example.com/pay", asOf: iso(-1) },
  unread: 1,
  photos: [{ hash: H(1), caption: "Mudroom framing", stage: "during" }, { hash: H(2), caption: "Kitchen drywall hung", stage: "during" }, { hash: H(3), caption: "Primer on", stage: "during" }],
  documents: [],
};
export const PORTAL_MESSAGES = [
  { id: "pm1", from: "office", body: "Drywall is finished in the kitchen. Paint starts Monday, and Greg will be on site at 7:30.", at: iso(-1.2), channel: "portal" },
  { id: "pm2", from: "you", body: "Great, thank you! Will the cabinets still arrive next week?", at: iso(-1), channel: "portal" },
  { id: "pm3", from: "office", body: "Yes, the supplier confirmed delivery Wednesday morning.", at: iso(-0.8), channel: "portal" },
];
export const PORTAL_SELECTIONS = { selections: [
  { id: "s1", title: "Kitchen backsplash", label: "Kitchen backsplash", scope: "room", room: "Kitchen", rooms: ["Kitchen"], what: "3x6 white subway tile", qty: 32, unit: "SF", alsoIncludes: [], choice: "match", note: "", respondedAt: iso(-2) },
  { id: "s2", title: "Mudroom flooring", label: "Mudroom flooring", scope: "room", room: "Mudroom", rooms: ["Mudroom"], what: "Luxury vinyl plank, matched to hall", qty: 64, unit: "SF", alsoIncludes: [], choice: null, note: "", respondedAt: null },
  { id: "s3", title: "Bath vanity light", label: "Bath vanity light", scope: "room", room: "Primary Bath", rooms: ["Primary Bath"], what: "3-light bar, brushed nickel", qty: 1, unit: "EA", alsoIncludes: [], choice: null, note: "", respondedAt: null },
], total: 3, answered: 1, remaining: 2, wantsChange: 0, complete: false, submittedAt: null };
