/* A made-up water job for the carrier packet tests, and the media bucket its
   markers point into. Nothing here is a real customer, claim or job.

   The job is built to reach every corner the packet prints: a certificate
   signed in the app (with an upload-mode twin), a signed work
   authorization, a floor plan, two moisture maps (one with a typed dry goal
   and meter photos, one falling back to the material's goal with a second
   block of locations), one drying log mixing hand-typed rows with rows the
   scan events write (a placement, a move, removals, an undone scan, a
   typed row closed by a scan, one unit still out), psychrometric rows, a
   sizing worksheet with a deviation note, photos across the stages with
   archived ones, supporting documents (one unticked), and invoices of
   every kind the gate has to tell apart (ready, void, a held billing-check
   draft, a rebuild invoice).

   Images are real JPEGs from the public site's image folder and small PNG
   signatures drawn here with node:zlib, so a renderer can decode every one.
   The media store is what the field-media bucket would hold: object name →
   the stored data-URL text, named by the sha256 hex of that text (thumbnails
   as "thumb_<hash>"), exactly as media.js and thumbs.js write them. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { equipmentCalc } from "../../../apps/field/js/dryingcalc.js";

export const DEMO_TODAY = "2026-10-10";
export const DEMO_NOW = new Date("2026-10-10T20:00:00Z");
/* the job's last edit, well outside the two-hour settle window */
export const DEMO_UPDATED_AT = "2026-10-10T12:00:00Z";
export const DEMO_JOB_ID = "0d3e5a7c-0000-4000-8000-00000000d001";
export const EXCLUDED_DOC_ID = "doc-excluded";
export const DEMO_ACCOUNT = "office@example.com";

/* the job's email_messages rows, newest last; the newest inbound one is a bounce */
export const DEMO_EMAILS = [
  { direction: "in", from_addr: "Jane Sample <jane.sample@example.com>", matched_by: "email", received_at: "2026-10-02T17:00:00Z" },
  { direction: "in", from_addr: "Alex Adjuster <ADJUSTER@example.com>", matched_by: "claim", received_at: "2026-10-03T18:00:00Z" },
  { direction: "out", from_addr: "office@example.com", matched_by: "claim", received_at: "2026-10-04T18:00:00Z" },
  { direction: "in", from_addr: "Mail Delivery <mailer-daemon@example.net>", matched_by: "email", received_at: "2026-10-05T18:00:00Z" },
];

/* ---------- media ---------- */
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const IMAGES = fileURLToPath(new URL("../../../apps/site/public/images/", import.meta.url));
const jpeg = (file) => "data:image/jpeg;base64," + readFileSync(IMAGES + file).toString("base64");
/** The marker media.js writes in the job row for a stored data URL. */
export const markerOf = (dataUrl) => `media:${sha(dataUrl)}:${dataUrl.length}`;
export const hashOf = (dataUrl) => sha(dataUrl);

/* ---- a tiny PNG encoder: RGBA 8-bit, filter 0 on every row ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A signature-like stroke on a transparent 160 × 48 canvas; `seed` changes the stroke. */
export function signaturePng(seed = 1) {
  const W = 160, H = 48;
  const px = Buffer.alloc(W * H * 4);
  const dot = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = Math.round(x) + dx, Y = Math.round(y) + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const i = (Y * W + X) * 4;
        px[i] = 20; px[i + 1] = 30; px[i + 2] = 60; px[i + 3] = 255;
      }
    }
  };
  for (let x = 8; x < W - 8; x += 0.25) {
    const y = H / 2 + (10 + seed) * Math.sin(x / (7 + seed)) * Math.cos(x / (23 + 2 * seed));
    dot(x, y);
  }
  for (let t = 0; t < 1; t += 0.01) dot(20 + seed * 9 + 30 * t, 38 - 4 * t);   // the underline flick
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + png.toString("base64");
}

/* Every image the job uses, read once. */
let MEDIA = null;
function media() {
  if (MEDIA) return MEDIA;
  const photo = (file) => jpeg(file);
  MEDIA = {
    photos: [
      "9c9b97ef-the-water-damage-restoration-process-explained1.jpg",
      "1ae79fc4-the-water-damage-restoration-process-explained4.jpg",
      "70167817-water-damage-50_50-1.jpg",
      "0b81fd1e-the-water-damage-restoration-process-explained2.jpg",
      "14748673-the-water-damage-restoration-process-explained3.jpg",
      "3ce69cdf-understanding-the-different-types-of-restoration-services3.jpg",
      "b661c2f1-understanding-the-different-types-of-restoration-services2.jpg",
      "cc252cd3-understanding-the-different-types-of-restoration-services1.jpg",
      "151c9901-understanding-the-different-types-of-restoration-services-bg.jpg",
      "19e0c593-mold-removal-hero.jpg",
      "594ea566-restoration-services-50_50-4.jpg",
    ].map(photo),   // the twelfth photo is LOST_MARKER: its object never reached the bucket
    archivedSmall: [photo("ce176e77-the-water-damage-restoration-process-explained4.jpg"), photo("371f633b-blog-2.jpg")],
    archivedInline: photo("42e55317-mold-removal-icon2.jpg"),
    thumbs: ["ffc98fc7-mold-removal-icon5.jpg", "07827a3e-mold-removal-icon6.jpg", "1a7f291b-mold-removal-icon4.jpg", "e09fd7f2-mold-removal-icon1.jpg"].map(photo),
    meter: ["90369908-the-strength-beneath.jpg", "2ae21081-pressure-treated-wood.jpg", "697ee997-exterior-painting.jpg"].map(photo),
    meterInline: photo("03f7ef1c-mold-removal-icon3.jpg"),
    sketchA: photo("1ae3050a-exterior-painting-image-icon.jpg"),
    areaPhotoA: photo("5713c9a1-exterior-paint-50-50.jpg"),
    floorPlanB: photo("d98533f6-exterior-painting-image-icon-282-29.jpg"),
    equipmentPlanB: photo("07835fe2-exterior-painting-image-icon-284-29.jpg"),
    floorPlanPage: photo("22d666d2-painting-services.jpg"),
    supportDoc: photo("52e702ef-flooring-services.jpg"),
    excludedDoc: photo("5cd72704-roofing-services.jpg"),
    invoiceAttachment: photo("dbbb43b9-commercial-remodeling.jpg"),
    certUpload: [photo("c25e4951-adobestock_492445295.jpeg"), photo("227d5e3a-snow-removal.jpg")],
    sigTech: signaturePng(1), sigOwner: signaturePng(2), waOwner: signaturePng(3), waRep: signaturePng(4),
  };
  return MEDIA;
}
/* the photo whose object never reached the bucket (a device lost before it synced) */
export const LOST_MARKER = `media:${sha("demo photo that never reached the bucket")}:48211`;
/* which photos have a thumbnail in the bucket (by photo index) */
const THUMBED = [0, 1, 4, 5];
/* archived photos: index → small copy */
const ARCHIVED = { 2: "archivedSmall:0", 7: "archivedSmall:1", 9: "archivedInline" };

/** field-media as the lane would read it: object name → stored data-URL text. */
export function demoMediaStore() {
  const m = media();
  const store = new Map();
  const put = (d) => store.set(sha(d), d);
  m.photos.forEach(put);
  m.archivedSmall.forEach(put);
  THUMBED.forEach((i, k) => store.set("thumb_" + sha(m.photos[i]), m.thumbs[k]));
  m.meter.forEach(put);
  for (const k of ["sketchA", "areaPhotoA", "floorPlanB", "equipmentPlanB", "floorPlanPage", "supportDoc", "excludedDoc", "invoiceAttachment"]) put(m[k]);
  m.certUpload.forEach(put);
  return store;
}
/** storage.objects sizes for the store: name → stored text bytes (the text is ASCII). */
export function demoMediaSizes(store = demoMediaStore()) {
  return new Map([...store].map(([k, v]) => [k, Buffer.byteLength(v)]));
}

/* ---------- the job ---------- */
const scan = (id, tag, act, at, room, extra = {}) => ({
  id, tag, act, at, room, type: "", model: "", logId: "log-1", voids: "",
  how: "camera", by: "crew1@example.com", tech: "Pat Sample", build: "demo", ...extra,
});

/** A fresh copy of the demo water job (its markers point into demoMediaStore()). */
export function demoProject() {
  const m = media();
  const mk = markerOf;
  const ph = m.photos.map(mk);
  const blank13 = () => Array(13).fill("");
  const row13 = (vals) => [...vals, ...Array(13 - vals.length).fill("")];

  const photo = (i, stage, room, caption) => {
    const p = { id: `ph-${String(i + 1).padStart(2, "0")}`, by: "crew1@example.com", src: ph[i], caption, room, stage, ts: `2026-10-0${1 + (i % 6)}T18:${String(10 + i).padStart(2, "0")}:00Z` };
    const arch = ARCHIVED[i];
    if (arch) {
      p.cloud = sha(m.photos[i]);
      p.src = arch === "archivedInline" ? m.archivedInline : mk(m.archivedSmall[Number(arch.split(":")[1])]);
    }
    return p;
  };
  const photos = [
    photo(0, "before", "Kitchen", "Standing water at the sink base"),
    photo(1, "during", "Kitchen", "Toe kick removed for drying"),
    photo(2, "before", "Kitchen", "Wet subfloor at the dishwasher"),
    photo(3, "after", "Kitchen", "Cabinet base dry"),
    photo(4, "during", "Hallway", "Air mover on the hall carpet"),
    photo(5, "before", "Basement", "Water stain on the slab"),
    photo(6, "", "Basement", "Supply line under the kitchen"),
    photo(7, "during", "Basement", "Dehumidifier running"),
    photo(8, "after", "Hallway", "Carpet re-stretched"),
    photo(9, "before", "Kitchen", "Failed supply line"),
    photo(10, "during", "Kitchen", "Moisture reading at the wall"),
    { id: "ph-12", by: "crew1@example.com", src: LOST_MARKER, caption: "Final walkthrough", room: "Kitchen", stage: "after", ts: "2026-10-06T21:00:00Z" },
    { id: "ph-13", by: "crew1@example.com", src: "", caption: "Upload never finished", room: "", stage: "during", ts: "2026-10-06T21:05:00Z" },
  ];

  const equipCalc = equipmentCalc({
    rooms: [{ name: "Kitchen", floorSF: 180, perimLF: 54 }, { name: "Hallway", floorSF: 60, perimLF: 32 }],
    waterClass: "2", waterCategory: "2", affT: 72,
  });
  equipCalc.at = "2026-10-01T19:00:00Z";

  return {
    id: DEMO_JOB_ID,
    createdBy: "crew1@example.com",
    createdAt: "2026-09-30T22:00:00Z",
    updatedAt: DEMO_UPDATED_AT,
    archivedAt: "",
    jobType: "restoration",
    lossTypes: ["water"],
    workOrderNo: "WO-2026-118",
    claimNo: "DEMO-12345",
    customer: "Jane Sample",
    address: "123 Example St, Fairbanks, AK 99701",
    phone: "907-555-0100",
    email: "jane.sample@example.com",
    carrier: "Sample Mutual",
    adjuster: "Alex Adjuster (adjuster@example.com)",
    lossCause: "Supply line failure under the kitchen sink",
    dateOfLoss: "2026-09-30",
    waterCategory: "2",
    waterClass: "2",
    dryingSystem: "Closed",
    rooms: ["Kitchen", "Hallway", "Basement"],
    packetExclude: [`supportDocs:${EXCLUDED_DOC_ID}`],
    portalShare: { id: "portal-demo-1", enabled: true },
    photos,

    workAuth: {
      date: "2026-10-01",
      scope: { 0: true, 1: true, 2: true, 3: true, 4: false, 5: true, 6: true },
      mode: "sign",
      smsConsent: true,
      ownerSig: m.waOwner, ownerName: "Jane Sample", ownerDate: "2026-10-01",
      repSig: m.waRep, repName: "Pat Sample", repDate: "2026-10-01",
      uploadedDoc: "", uploadedPages: [],
    },

    certDrying: {
      certNo: "COD-2026-031", issueDate: "2026-10-06", dryingDays: "6",
      dryStart: "2026-10-01", dryComplete: "2026-10-06",
      affectedAreas: "Kitchen subfloor and lower cabinets.\nBasement slab under the kitchen.",
      verification: [
        { material: "Subfloor — kitchen", meter: "Pin meter / wood scale", goal: "16", final: "13", reference: "11", dry: true },
        { material: "Slab — basement", meter: "Pin meter / concrete scale", goal: "4", final: "3.5", reference: "3", dry: true },
        { material: "", meter: "", goal: "", final: "", reference: "", dry: false },
      ],
      dehuDays: "1 × 5", amDays: "4 × 5", scrubDays: "1 × 4", heaterDays: "",
      mode: "sign",
      uploadedDoc: "", uploadedPages: [],
      sigTech: m.sigTech, sigTechName: "Pat Sample", sigTechDate: "2026-10-06",
      sigOwner: m.sigOwner, sigOwnerName: "Jane Sample", sigOwnerDate: "2026-10-06",
      portalSignedAt: "2026-10-07T01:15:00Z",
      sigAdjuster: "", sigAdjusterName: "", sigAdjusterDate: "",
    },

    floorPlan: { createdAt: "2026-10-01T20:00:00Z", mode: "upload", uploadedPages: [mk(m.floorPlanPage)] },

    moistureMaps: [
      {
        id: "map-a", by: "crew1@example.com", label: "Kitchen", material: "Framing / Wood / Subfloor", dryGoal: "≤ 16%",
        meter: "Pin meter / wood scale", ambientTemp: "70", ambientRH: "45", equipmentOnSite: "4 air movers, 1 LGR",
        technician: "Pat Sample", sketch: mk(m.sketchA), floorPlan: "", strokes: "", markerNext: 7,
        equipmentPlan: [], equipmentPlanImg: "", photos: [mk(m.areaPhotoA)],
        readings: [
          { rk: "rk-a1", date: "2026-10-01", values: row13(["32", "28", "30", "26", "24", "22"]), notes: "Initial readings after extraction." },
          { rk: "rk-a2", date: "2026-10-02", values: row13(["25", "22", "24", "21", "19", "18"]), notes: "" },
          { rk: "rk-a3", date: "2026-10-04", values: row13(["18", "17", "19", "16", "15", "15"]), notes: "Subfloor still above goal at Loc 3." },
          { rk: "rk-a4", date: "2026-10-06", values: row13(["14", "13", "15", "12", "12", "11"]), notes: "All locations at goal." },
          { rk: "rk-a5", date: "2026-10-07", values: blank13(), notes: "" },
        ],
      },
      {
        id: "map-b", by: "crew1@example.com", label: "Basement", material: "Concrete / Slab", dryGoal: "",
        meter: "Pin meter / concrete scale", ambientTemp: "", ambientRH: "", equipmentOnSite: "1 air scrubber",
        technician: "Pat Sample", sketch: "", floorPlan: mk(m.floorPlanB), strokes: "", markerNext: 15,
        equipmentPlan: [], equipmentPlanImg: mk(m.equipmentPlanB), photos: [], locCount: 26,
        readings: [
          { rk: "rk-b1", date: "2026-10-02", values: ["6", "5.5", "5", "4.5", "4", "6", "5", "5", "4.5", "4", "3.5", "4", "5", "6"], notes: "" },
          { rk: "rk-b2", date: "2026-10-05", values: ["4", "3.5", "3", "3", "3.5", "4", "3", "3.5", "3", "3", "3", "3.5", "4", "4.5"], notes: "Loc 14 by the floor drain still damp." },
        ],
      },
    ],
    meterPhotos: [
      { id: "mp-1", mapId: "map-a", rowKey: "rk-a4", date: "2026-10-06", loc: 0, src: mk(m.meter[0]), ts: "2026-10-06T19:20:00Z", dev: "demo-ipad", read: { value: "14", fill: false }, ok: "2026-10-06T19:30:00Z" },
      { id: "mp-2", mapId: "map-a", rowKey: "rk-a4", date: "2026-10-06", loc: 1, src: mk(m.meter[1]), ts: "2026-10-06T19:21:00Z", dev: "demo-ipad", read: { value: "13", fill: false }, ok: "2026-10-06T19:30:00Z" },
      { id: "mp-3", mapId: "map-a", rowKey: "rk-a3", date: "2026-10-04", loc: 2, src: mk(m.meter[2]), ts: "2026-10-04T18:40:00Z", dev: "demo-ipad", read: { value: "19", fill: false }, ok: "2026-10-04T18:45:00Z" },
      // its reading row was merged away on another device: printed by the date it was taken
      { id: "mp-4", mapId: "map-a", rowKey: "rk-gone", date: "2026-09-29", loc: 3, src: m.meterInline, ts: "2026-09-29T23:00:00Z", dev: "demo-phone", read: { value: "27", fill: false }, ok: "2026-09-29T23:05:00Z" },
    ],

    dryingLogs: [
      {
        id: "log-1", by: "crew1@example.com", createdAt: "2026-10-01T18:00:00Z",
        dryoutStart: "2026-10-01", dryoutFinish: "2026-10-06", techSupervisor: "Pat Sample",
        equipCalc,
        calcDeviation: { am: "Limited circuits in the kitchen — staged deployment", dehu: "", scrub: "", heat: "" },
        equipment: [
          { asset: "AM-020", type: "Air mover", location: "Hallway", placed: "2026-10-01T10:30", removed: "", hours: "96", _manualHrs: true, notes: "Hours typed from the unit's run meter" },
          { asset: "AM-021", type: "Air mover", location: "Kitchen", placed: "2026-10-01T11:00", removed: "2026-10-05T15:00", hours: "98", notes: "Set under the sink base\nChecked daily" },
          { asset: "HT-001", type: "Heater", location: "Basement", placed: "2026-10-02T09:00", removed: "", hours: "", notes: "" },
          { asset: "", type: "", location: "", placed: "", removed: "", hours: "", notes: "" },
        ],
        readings: [
          { date: "2026-10-01", time: "10:30", outT: "48", outRH: "70", outGPP: "", refT: "70", refRH: "45", refGPP: "", affT: "72", affRH: "40", affGPP: "", gd: "", dehu: "1", am: "4", scrub: "1", tech: "pat@example.com", notes: "Start of drying." },
          { date: "2026-10-03", time: "09:15", outT: "45", outRH: "75", outGPP: "", refT: "70", refRH: "44", refGPP: "", affT: "76", affRH: "30", affGPP: "", gd: "", dehu: "1", am: "4", scrub: "1", tech: "Pat Sample", notes: "" },
          { date: "2026-10-06", time: "11:00", outT: "40", outRH: "72", outGPP: "", refT: "70", refRH: "44", refGPP: "", affT: "74", affRH: "28", affGPP: "", gd: "15", dehu: "1", am: "2", scrub: "0", tech: "Pat Sample", notes: "Dry standard met." },
          { date: "2026-10-07", time: "", outT: "", outRH: "", outGPP: "", refT: "", refRH: "", refGPP: "", affT: "", affRH: "", affGPP: "", gd: "", dehu: "", am: "", scrub: "", tech: "", notes: "" },
        ],
      },
    ],
    equipmentScans: [
      scan("scan-01", "AM-014", "place", "2026-10-01T18:00:00Z", "Kitchen", { type: "Air mover" }),
      scan("scan-02", "AM-015", "place", "2026-10-01T18:02:00Z", "Kitchen", { type: "Air mover" }),
      scan("scan-03", "DH-002", "place", "2026-10-01T18:05:00Z", "Kitchen", { type: "LGR dehumidifier" }),
      scan("scan-04", "AM-099", "place", "2026-10-01T18:10:00Z", "Kitchen", { type: "Air mover" }),
      scan("scan-05", "", "void", "2026-10-01T18:11:00Z", "", { voids: "scan-04" }),
      scan("scan-06", "AF-001", "place", "2026-10-01T18:20:00Z", "Basement", { type: "Air scrubber", how: "typed" }),
      scan("scan-07", "AM-015", "move", "2026-10-03T17:30:00Z", "Hallway"),
      scan("scan-08", "AM-015", "remove", "2026-10-06T19:00:00Z", ""),
      scan("scan-09", "DH-002", "remove", "2026-10-06T19:05:00Z", ""),
      scan("scan-10", "AF-001", "remove", "2026-10-05T20:00:00Z", "", { how: "photo" }),
      // a hand-typed row's unit scanned out: fills that row's Removed, the row stays typed
      scan("scan-11", "HT-001", "remove", "2026-10-04T17:00:00Z", "", { how: "photo", by: "crew2@example.com", tech: "", onRow: { placed: "2026-10-02T09:00" } }),
    ],

    supportDocs: [
      { id: "doc-plumber", by: "crew1@example.com", title: "Plumber's leak report", docType: "Plumber report", mode: "upload", uploadedPages: [mk(m.supportDoc)], aiDigest: "" },
      { id: EXCLUDED_DOC_ID, by: "crew1@example.com", title: "Old roof estimate", docType: "Estimate", mode: "upload", uploadedPages: [mk(m.excludedDoc)], aiDigest: "" },
      { id: "doc-empty", by: "crew1@example.com", title: "Report still to come", docType: "", mode: "upload", uploadedPages: [], aiDigest: "" },
    ],

    invoices: [
      {
        id: "inv-ready", invoiceNo: "INV-1042", qboDocNumber: "1042", qboInvoiceId: "qbo-demo-77",
        invoiceDate: "2026-10-08", dueDate: "2026-11-07", terms: "Net 30",
        lossSummary: "Category 2 water loss from a failed kitchen supply line. Extraction, structural drying of the kitchen subfloor and basement slab.",
        billingModel: "tm", opMode: "pct", opAuto: true, overheadPct: "0", profitPct: "0",
        overheadAmount: "", profitAmount: "", deductible: "", taxRate: "",
        items: [
          { id: "li-1", room: "Kitchen", desc: "Water extraction — carpet and pad", qty: "180", unit: "SF", price: "1.25" },
          { id: "li-2", room: "Kitchen", desc: "Air mover — per day", qty: "20", unit: "EA", price: "35" },
          { id: "li-3", room: "Kitchen", desc: "Dehumidifier (LGR) — per day", qty: "5", unit: "EA", price: "95" },
          { id: "li-4", room: "Basement", desc: "Air scrubber — per day", qty: "4", unit: "EA", price: "85" },
          { id: "li-5", room: "", desc: "Mitigation labor — technician", qty: "12", unit: "HR", price: "78" },
          { id: "li-6", room: "", desc: "", qty: "", unit: "", price: "" },
        ],
        notes: "Moisture maps, drying logs and photos attached in this packet.",
        attachments: [{ label: "Drywall subcontractor invoice", pages: [mk(m.invoiceAttachment)], ai: { docType: "Subcontractor invoice" } }],
        // the nightly QuickBooks pull (qbo-proxy payments.ts)
        status: "partially_paid", previousPayments: "500",
        payments: [{ amount: 500, date: "2026-10-09", method: "Check" }],
        qboBalance: 2711.2, qboBalanceAt: "2026-10-10T11:00:00Z",
      },
      { id: "inv-void", invoiceNo: "INV-1039", invoiceDate: "2026-10-02", status: "void", billingModel: "tm", opMode: "pct", overheadPct: "0", profitPct: "0",
        items: [{ id: "li-v", room: "", desc: "Emergency call-out", qty: "1", unit: "EA", price: "250" }], attachments: [] },
      { id: "inv-draft", invoiceNo: "", qboInvoiceId: "", invoiceDate: "2026-10-09", reviewGaps: ["Equipment days differ from the drying log"], billingModel: "tm", opMode: "pct", overheadPct: "0", profitPct: "0",
        items: [{ id: "li-d", room: "", desc: "Draft line", qty: "1", unit: "EA", price: "10" }], attachments: [] },
      { id: "inv-rebuild", invoiceNo: "INV-1050", estimateId: "est-demo-1", invoiceDate: "2026-10-09", billingModel: "contract", contractAmount: "8400", opMode: "pct", overheadPct: "0", profitPct: "0",
        items: [], attachments: [] },
    ],
    reconEstimates: [],
    changeOrders: [],
  };
}

/** The same job with the certificate as an uploaded signed copy. */
export function demoProjectUpload() {
  const p = demoProject();
  const m = media();
  p.certDrying = {
    ...p.certDrying,
    mode: "upload",
    uploadedPages: m.certUpload.map(markerOf),
    sigTech: "", sigOwner: "", portalSignedAt: "",
  };
  return p;
}

/** Image data URLs the tests check sources against. */
export function demoImages() {
  return media();
}
