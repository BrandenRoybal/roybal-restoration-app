/* The carrier packet's document model (docs/Carrier_Packet_Design.md §4-6,
   §10 budget, §13 words). Pure: it reads nothing but its arguments, never
   the clock, and never changes the job it is given.

   packetGate decides whether a job gets a packet now, and if not, why
   (the lane withdraws an open card or records a hold from the reason).
   buildModel turns the job blob into what the PDF prints: a cover, then
   sections of parts of blocks, the whole contract with the renderer, which
   decides geometry only. Images are referenced by key; model.media says
   where each one lives (an object in field-media, or inline in the blob).

   A new version of a sent packet is decided by modelHash, a hash of what
   prints, never by the job's updatedAt or rev: the nightly payment pull,
   autosaves and drying-log opens bump those without changing a page. So
   everything that may change without the document changing stays out of
   the hash: payments and balances sit under keys starting with "_" (the
   hash drops them), a photo's media key is its full-resolution hash
   whether or not it was archived, and the build time is the lane's.

   The rest are the fixed words around the packet: the email (subject,
   body, file name), the card's Why, the "ready" and hold texts, and the
   media plan that picks full or compact photos before anything is
   downloaded.

   Field modules it imports are copied into the worker image at the paths
   these imports use (services/worker/Dockerfile): model.js, core.js,
   scans.js, meterphotos.js (+ merge.js, thumbs.js, media.js), fincalc.js,
   completeness.js and dryingcalc.js. None touches the DOM when it loads. */

import { createHash } from "node:crypto";
import { jobType, lossTypesOf, COMPANY, SCOPE_ITEMS } from "../../../apps/field/js/model.js";
import { applyScans, scanRecord, wallTime, rowRoom } from "../../../apps/field/js/scans.js";
import { uncheckedFills, unreadOnEmpty, finalReadingPhotos, mapPhotoEntries, photoAt } from "../../../apps/field/js/meterphotos.js";
import { goalFor, gpp } from "../../../apps/field/js/core.js";
import { invoiceTotals, hasSubcontractorDocs } from "../../../apps/field/js/fincalc.js";
import { evaluateProject } from "../../../apps/field/js/completeness.js";
import { MARKER_RE } from "../../../apps/field/js/media.js";
import { thumbKey } from "../../../apps/field/js/thumbs.js";
import { deployedCounts } from "../../../apps/field/js/dryingcalc.js";
import { TERMS, SIGN_LEAD, SMS_LINKS, OWNER_SIG_LABEL, REP_SIG_LABEL, smsConsentLine } from "./workauth.mjs";

/* model format; bump on any layout-visible change (every section's hash moves with it) */
export const MODEL_V = 1;

/* print order, and each section's band title */
export const SECTION_ORDER = ["cert", "workAuth", "floorPlan", "maps", "logs", "photos", "docs", "invoices"];
export const SECTION_TITLES = {
  cover: "Job and claim details",
  cert: "Certificate of Drying",
  workAuth: "Work Authorization",
  floorPlan: "Floor Plan",
  maps: "Moisture Maps",
  logs: "Drying Logs",
  photos: "Job Photos",
  docs: "Supporting Documents",
  invoices: "Invoices",
};
/* the field app's "Include in this packet" keys (app.js packetGroups);
   a supporting document is "supportDocs:<id>" */
const EXCLUDE_KEY = {
  cert: "certDrying", workAuth: "workAuth", floorPlan: "floorPlan", maps: "moistureMaps",
  logs: "dryingLogs", photos: "photos", invoices: "invoices",
};

/* What a "no" from the gate makes the lane do (§4): withdraw an open card
   for these, and also record a hold (with one text) for HOLD_REASONS. A
   Set that also answers includes(), so either idiom reads it. */
const reasonSet = (list) => Object.assign(new Set(list), { includes(r) { return this.has(r); } });
export const HOLD_REASONS = reasonSet(["no_invoice", "unchecked_fills", "unread_meter_photos"]);
export const WITHDRAW_REASONS = reasonSet(["deleted", "archived", "not_water", "excluded", "not_certified",
  "no_invoice", "unchecked_fills", "unread_meter_photos"]);

/* ---------- small helpers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/* one printed line: control bytes (a claim # pasted from a PDF carries
   them) and line breaks become spaces, runs of space collapse */
const line = (v) => str(v).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
/* free text that keeps its line breaks (a paragraph) */
const prose = (v) => str(v).replace(/\r\n?/g, "\n").split("\n")
  .map((l) => l.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim())
  .join("\n").replace(/\n{3,}/g, "\n\n").trim();
const filled = (v) => line(v) !== "";
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const sha = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
const pad3 = (n) => String(n).padStart(3, "0");

/* $1,234.50 / -$20.00, the same on every machine (no locale) */
export function money(n) {
  const v = Math.round(num(n) * 100) / 100;
  const [whole, cents] = Math.abs(v).toFixed(2).split(".");
  return (v < 0 ? "-$" : "$") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + cents;
}
const thousands = (n) => String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/* a typed percentage ("10", "10%", "7.5") as printed */
const pctText = (v) => { const s = line(v).replace(/%$/, ""); return s ? `${s}%` : "0%"; };
/* a moisture reading with its unit, unless one was typed */
const mc = (v) => { const s = line(v); return s && /^-?\d+(\.\d+)?$/.test(s) ? `${s}%` : s; };
/* a value that may hold an email address (a login stamped as `by`, a typed
   tech): the login part only, never the address, on the adjuster's copy */
const noEmail = (v) => line(v).replace(/([^\s@<>()]+)@[^\s@<>()]+/g, "$1");
/* a login stamped as `by` ("crew1@example.com", "Pat <pat@example.com>") → its name part */
const loginOf = (v) => { const m = /([^\s@<>()"']+)@/.exec(str(v)); return m ? m[1] : noEmail(v); };

/* ---------- dates: Alaska wall time, never the container's clock ---------- */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const ZONED_RE = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** "2026-10-06" (or the date part of a wall time) → "10/06/2026"; free text prints as typed. */
export function mdy(v) {
  const s = line(v);
  const m = DATE_RE.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}
/* "2026-10-06" → "10/06" */
const md = (v) => { const m = DATE_RE.exec(line(v)); return m ? `${m[2]}/${m[3]}` : line(v); };
/* a valid "YYYY-MM-DD" at the start of v, else "" */
function isoDay(v) {
  const m = DATE_RE.exec(line(v));
  if (!m) return "";
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(d + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? d : "";
}
const dayNo = (d) => Math.round(Date.parse(d + "T00:00:00Z") / 86400000);
/* a UTC stamp → its Alaska date "YYYY-MM-DD" ("" when it isn't a zoned stamp) */
const akDay = (iso) => (iso instanceof Date ? wallTime(iso.toISOString()) : wallTime(iso)).slice(0, 10);
/* a drying-log time: datetime-local values are already Alaska wall time;
   a stamp with a zone is converted first */
const wallOf = (v) => { const s = line(v); return ZONED_RE.test(s) ? wallTime(s) : s; };
/* → "MM/DD HH:MM" (or "MM/DD" for a bare date) */
function shortWall(v) {
  const w = wallOf(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(w);
  if (!m) return w;
  return m[4] ? `${m[2]}/${m[3]} ${m[4]}` : `${m[2]}/${m[3]}`;
}
const latest = (days) => days.filter(Boolean).sort().pop() || "";
const earliest = (days) => days.filter(Boolean).sort()[0] || "";

/* ---------- shared rules (mirrored from the field app) ---------- */
/* formkit.js uploadedDocPages: the legacy single uploadedDoc → a page list */
function uploadedDocPages(obj) {
  if (obj && Array.isArray(obj.uploadedPages) && obj.uploadedPages.length) return obj.uploadedPages;
  if (obj && obj.uploadedDoc) return [obj.uploadedDoc];
  return [];
}

/* Certified, the way the form is used: an uploaded signed copy in upload
   mode, the technician's signature otherwise. Pages left over from an
   earlier upload do not certify a form switched back to signing. */
const certified = (c) => isObj(c) && (c.mode === "upload" ? uploadedDocPages(c).length > 0 : !!c.sigTech);

/* The number printed on an invoice. A qboInvoiceId alone is QuickBooks'
   internal id, not a number anyone can quote. */
const printedNo = (inv) => String((inv && (inv.invoiceNo || inv.qboDocNumber)) || "").trim();

/** A ready invoice (§4): not void, not a held billing-check draft (app.js
    packetGroups), not a rebuild invoice made from an approved estimate,
    and carrying a printed number. */
export function isReadyInvoice(inv) {
  if (!isObj(inv) || inv.status === "void") return false;
  if (inv.reviewGaps && !String(inv.invoiceNo || "").trim() && !inv.qboInvoiceId) return false;
  if (filled(inv.estimateId)) return false;
  return printedNo(inv) !== "";
}
const readyInvoices = (p) => arr(p.invoices).filter(isReadyInvoice);

/* The invoice as the editor computes it: with opAuto set in % mode, O&P
   follows the GC rule (forms.js invoice, fincalc.js hasSubcontractorDocs)
   whatever percentages were last stored; legacy invoices (opAuto unset)
   keep theirs. Totals "as billed": payments are never netted here. */
function billedInvoice(p, inv) {
  const copy = { ...inv };
  if (copy.opAuto === true && copy.opMode === "pct") {
    const pct = hasSubcontractorDocs(p) ? "10" : "0";
    copy.overheadPct = pct;
    copy.profitPct = pct;
  }
  return { inv: copy, totals: invoiceTotals({ ...copy, previousPayments: 0 }) };
}

/* the drying logs with the scans written into them, on a copy (as
   reconcile.js does): the blob may hold rows a newer copy of a log dropped */
function scannedLogs(p) {
  const copy = { ...p, dryingLogs: structuredClone(arr(p.dryingLogs)) };
  try { applyScans(copy); } catch { return arr(p.dryingLogs); }
  return copy.dryingLogs;
}

/* ============================================================
   The gate (§4)
   ============================================================ */

/* The anchor: the latest Alaska date the job shows real activity on. The
   certificate's sigTechDate and issueDate are prefilled when the form is
   opened, so they never make a job recent on their own: they count only
   once the dated work itself is inside the window. */
function anchorOf(p, ready, todayNo, lookbackDays) {
  const c = isObj(p.certDrying) ? p.certDrying : {};
  const logs = scannedLogs(p).filter(isObj);
  const hard = [isoDay(c.dryComplete), akDay(c.portalSignedAt)];
  for (const log of logs) {
    hard.push(isoDay(log.dryoutFinish));
    for (const row of arr(log.equipment)) if (isObj(row)) hard.push(isoDay(wallOf(row.removed)));
  }
  for (const m of arr(p.moistureMaps)) {
    for (const r of arr(isObj(m) ? m.readings : null)) {
      if (isObj(r) && arr(r.values).some(filled)) hard.push(isoDay(r.date));
    }
  }
  for (const inv of ready) hard.push(isoDay(inv.invoiceDate));
  const top = latest(hard);
  const soft = latest([isoDay(c.sigTechDate), isoDay(c.issueDate)]);
  const recent = !!top && Number.isFinite(todayNo) && todayNo - dayNo(top) <= lookbackDays;
  return { anchor: recent && soft > top ? soft : top || soft, top, recent };
}

const finiteOr = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** packetGate(project, {today, now, lookbackDays, settleMin, updatedAt,
    deleted, hasRow, certSignPending}) → {ok: true, anchor} or
    {ok: false, reason, detail}. The first failing check is the reason;
    `detail` is one short line for the hold and the logs. */
export function packetGate(project, opts = {}) {
  const p = isObj(project) ? project : {};
  const no = (reason, detail) => ({ ok: false, reason, detail });
  if (opts.deleted === true || p.deleted === true) return no("deleted", "the job was deleted");
  if (filled(p.archivedAt)) return no("archived", `archived ${mdy(akDay(p.archivedAt) || p.archivedAt)}`);
  if (jobType(p) !== "restoration") return no("not_water", "a construction job");
  const losses = lossTypesOf(p);
  if (!losses.includes("water")) return no("not_water", `loss types: ${losses.join(", ")}`);
  const ex = new Set(arr(p.packetExclude).map(str));
  if (ex.has("certDrying")) return no("excluded", "the Certificate of Drying is unticked on the job's packet page");
  if (ex.has("invoices")) return no("excluded", "the invoices are unticked on the job's packet page");
  const c = p.certDrying;
  if (!certified(c)) {
    return no("not_certified", !isObj(c) ? "no Certificate of Drying"
      : c.mode === "upload" ? "no signed copy of the Certificate of Drying uploaded"
        : "the Certificate of Drying has no technician signature");
  }
  const ready = readyInvoices(p);
  if (!ready.length) {
    const n = arr(p.invoices).filter(isObj).length;
    return no("no_invoice", n ? `${plural(n, "invoice")} on the job, none numbered and ready` : "no invoice on the job");
  }
  const fills = uncheckedFills(p).length;
  if (fills) return no("unchecked_fills", `${plural(fills, "meter reading")} to check`);
  const unread = unreadOnEmpty(p).length;
  if (unread) return no("unread_meter_photos", `${plural(unread, "meter photo")} on an empty reading not read yet`);

  const today = isoDay(opts.today);
  const lookbackDays = finiteOr(opts.lookbackDays, 14);
  const { anchor, top, recent } = anchorOf(p, ready, today ? dayNo(today) : NaN, lookbackDays);
  if (!opts.hasRow && !recent) return no("lookback", top ? `last activity ${mdy(top)}` : "no drying, reading or invoice date on the job");

  const settleMin = finiteOr(opts.settleMin, 120);
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.parse(str(opts.now));
  const editedMs = Date.parse(str(opts.updatedAt));
  if (Number.isFinite(nowMs) && Number.isFinite(editedMs) && nowMs - editedMs < settleMin * 60000) {
    return no("settle", `edited ${Math.max(0, Math.floor((nowMs - editedMs) / 60000))} min ago`);
  }
  if (opts.certSignPending === true) return no("cert_sign_pending", "the customer's portal signature on the Certificate of Drying is pending");
  return { ok: true, anchor };
}

/* ============================================================
   Media (§5 MediaRef)
   ============================================================ */
const IMAGE_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
const HEX64 = /^[0-9a-f]{64}$/;

/* A stored image value → Source: {hash} names an object in field-media
   (the hash of its data-URL text; "thumb_<hash>" for a thumbnail), {inline}
   is a data URL still in the blob. null: nothing there. undefined: a value
   that is no image this can fetch. */
function sourceOf(v) {
  const s = str(v).trim();
  if (!s) return null;
  const m = MARKER_RE.exec(s);
  if (m) return { hash: m[1] };
  if (IMAGE_URL.test(s)) return { inline: s };
  return undefined;
}
const keyOf = (src) => (src.hash ? src.hash : "inline:" + sha(src.inline));

class MediaSet {
  constructor() { this.refs = {}; this.missing = 0; }
  #put(key, ref) {
    const was = this.refs[key];
    if (!was) { this.refs[key] = ref; if (!ref.full) this.missing++; }
    else if (!was.small && ref.small) was.small = ref.small;   // a job photo's small copy, wherever it shows first
    return key;
  }
  /* an image the block must show: a value with no source is still a key
     (the renderer prints "Image not available", the card counts it) */
  need(kind, value, ctx) {
    const src = sourceOf(value);
    if (src) return this.#put(keyOf(src), { kind, full: src, small: null });
    return this.#put(`missing:${sha(`${kind}|${ctx}|${str(value)}`)}`, { kind, full: null, small: null });
  }
  /* an image that may simply not be there (a sketch, a signature): null when empty */
  opt(kind, value, ctx) {
    return sourceOf(value) === null ? null : this.need(kind, value, ctx);
  }
  /* A job photo. Its key is the full-resolution copy's hash either way, so
     archiving it (archivePhotos: `cloud` = the full hash, `src` = a 480 px
     copy) never changes the model. The small copy for compact mode is the
     archived 480 px copy when there is one, else the bucket's thumbnail of
     the full copy (thumbs.js). */
  photo(ph) {
    const cloud = line(ph.cloud).toLowerCase();
    const src = sourceOf(ph.src);
    if (HEX64.test(cloud)) return this.#put(cloud, { kind: "photo", full: { hash: cloud }, small: src || null });
    if (src && src.hash) return this.#put(src.hash, { kind: "photo", full: src, small: { hash: thumbKey(src.hash) } });
    if (src) return this.#put(keyOf(src), { kind: "photo", full: src, small: null });
    return this.need("photo", ph.src || ph.cloud, `photo:${str(ph.id)}`);
  }
}

/* one full page per uploaded page */
const pagesBlock = (media, pages, caption, ctx) => ({
  t: "pages",
  items: pages.map((src, i) => ({
    media: media.need("page", src, `${ctx}:${i}`),
    caption: pages.length > 1 ? `${caption} — page ${i + 1} of ${pages.length}` : caption,
  })),
});

/* A signature block. A date prints only beside a signature (the dates are
   prefilled when the form opens); a signature made in the customer portal
   prints as electronic, dated on the Alaska clock. */
function sigItem(media, label, o, keys, ctx, { portal = false, fallbackName = "" } = {}) {
  const name = line(o[keys.name]);
  if (portal && filled(o.portalSignedAt)) {
    return { label, name: name || line(fallbackName), date: mdy(akDay(o.portalSignedAt) || o[keys.date]), media: null, electronic: true };
  }
  const key = media.opt("sig", o[keys.sig], `${ctx}:${keys.sig}`);
  return { label, name, date: key ? mdy(o[keys.date]) : "", media: key, electronic: false };
}

/* ============================================================
   Sections (§5)
   ============================================================ */
const jobFields = (p) => [
  ["Customer", line(p.customer)], ["Job address", line(p.address)],
  ["Phone", line(p.phone)], ["Email", line(p.email)],
  ["Carrier", line(p.carrier)], ["Claim #", line(p.claimNo)],
  ["Adjuster", line(p.adjuster)], ["Date of loss", mdy(p.dateOfLoss)],
];
const classLine = (p) => [filled(p.waterCategory) ? `Category ${line(p.waterCategory)}` : "", filled(p.waterClass) ? `Class ${line(p.waterClass)}` : ""]
  .filter(Boolean).join(" / ");

/* forms.js certDrying, verbatim (test/packet-model.test.mjs holds it to the form) */
export const CERT_STATEMENT = "The undersigned, an IICRC-certified water restoration technician, hereby certifies that the water damage mitigation and structural drying services described herein were performed at the above property in accordance with the IICRC S500 Standard for Professional Water Damage Restoration. Final moisture-meter readings confirm that affected materials have achieved the documented dry standard by comparison to unaffected reference materials and/or manufacturer specifications. The structure is considered dry per IICRC S500 criteria as of the Drying Completion Date stated above.";
const CERT_SIGS = {
  tech: ["IICRC Certified Technician — Roybal Construction, LLC", { sig: "sigTech", name: "sigTechName", date: "sigTechDate" }],
  owner: ["Property Owner / Insured", { sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate" }],
  adjuster: ["Adjuster / Carrier (if witness required)", { sig: "sigAdjuster", name: "sigAdjusterName", date: "sigAdjusterDate" }],
};

function certParts(b) {
  const { p, media } = b;
  const c = p.certDrying;
  if (!isObj(c)) return [];
  if (c.mode === "upload") {
    const pages = uploadedDocPages(c);
    return pages.length ? [{ title: null, newPage: false, blocks: [pagesBlock(media, pages, "Certificate of Drying (signed copy)", "cert")] }] : [];
  }
  const blocks = [
    { t: "fields", cols: 3, pairs: [
      ["Certificate #", line(c.certNo)], ["Issue date", mdy(c.issueDate)], ["Project / job ID", line(p.workOrderNo)],
      ["Drying duration (days)", line(c.dryingDays)], ["Drying start", mdy(c.dryStart)], ["Drying completion", mdy(c.dryComplete)],
    ] },
    { t: "subhead", text: "Property / insured & claim", right: "" },
    { t: "fields", cols: 3, pairs: [...jobFields(p), ["Water category / class", classLine(p)]] },
  ];
  if (filled(c.affectedAreas)) blocks.push({ t: "subhead", text: "Affected areas & materials", right: "" }, { t: "para", text: prose(c.affectedAreas), size: 9, font: "reg", color: "black" });
  const rows = arr(c.verification).filter((r) => isObj(r) && (["material", "meter", "goal", "final", "reference"].some((k) => filled(r[k])) || r.dry === true))
    .map((r) => [line(r.material), line(r.meter), line(r.goal), line(r.final), line(r.reference), r.dry === true ? "Yes" : "No"]);
  blocks.push(
    { t: "subhead", text: "Dry standard verification", right: "All readings MC%" },
    { t: "table", columns: [
      { head: "Material / location", w: 0.28 }, { head: "Meter / setting", w: 0.22 }, { head: "Goal %", w: 0.12, align: "center" },
      { head: "Final %", w: 0.12, align: "center" }, { head: "Ref %", w: 0.12, align: "center" }, { head: "Dry", w: 0.14, align: "center" },
    ], rows, size: 8.5, zebra: true },
    { t: "subhead", text: "Equipment deployment summary", right: "" },
    { t: "fields", cols: 2, pairs: [
      ["Dehumidifiers (# × days)", line(c.dehuDays)], ["Air movers (# × days)", line(c.amDays)],
      ["Air scrubbers (# × days)", line(c.scrubDays)], ["Heaters / other (# × days)", line(c.heaterDays)],
    ] },
    { t: "para", text: CERT_STATEMENT, size: 8.5, font: "ital", color: "black" },
    { t: "subhead", text: "Signatures", right: "" },
    { t: "signatures", items: [
      sigItem(media, CERT_SIGS.tech[0], c, CERT_SIGS.tech[1], "cert"),
      sigItem(media, CERT_SIGS.owner[0], c, CERT_SIGS.owner[1], "cert", { portal: true, fallbackName: p.customer }),
      sigItem(media, CERT_SIGS.adjuster[0], c, CERT_SIGS.adjuster[1], "cert"),
    ] },
  );
  const fin = finalReadingPhotos(p);
  if (fin.length) {
    blocks.push(
      { t: "subhead", text: "Final readings with meter photos", right: "" },
      { t: "para", text: "Each location's last reading on the Moisture Map, with the photo of the meter screen taken for it.", size: 8.5, font: "reg", color: "sub" },
      { t: "grid", perRow: 4, boxH: 120, items: fin.map((f) => ({
        media: media.need("meter", f.ph.src, `meter:${str(f.ph.id)}`),
        caption: [line(f.map.label) || "Moisture Map", `Loc ${f.loc + 1}`, md(f.date), mc(f.value)].filter(Boolean).join(" · "),
      })) },
    );
  }
  return [{ title: null, newPage: false, blocks }];
}

function workAuthParts(b) {
  const { p, media } = b;
  const wa = p.workAuth;
  if (!isObj(wa)) return [];
  if (wa.mode === "upload") {
    const pages = uploadedDocPages(wa);
    return pages.length ? [{ title: null, newPage: false, blocks: [pagesBlock(media, pages, "Work Authorization (signed copy)", "workAuth")] }] : [];
  }
  // the form prints in the packet once it is signed (an unsigned one is a completeness gap, not a document)
  if (!filled(wa.ownerSig) && !filled(wa.repSig) && !filled(wa.portalSignedAt)) return [];
  const scope = isObj(wa.scope) ? wa.scope : {};
  // only the checked items, as bullets: a number beside a bullet read as a gap where an item was left unchecked
  const items = SCOPE_ITEMS.filter((t, i) => scope[i] === true || scope[String(i)] === true);
  const blocks = [
    { t: "fields", cols: 3, pairs: [["Date", mdy(wa.date)], ["Work order #", line(p.workOrderNo)], ["Claim #", line(p.claimNo)]] },
    { t: "fields", cols: 2, pairs: [
      ["Property address", line(p.address)], ["Owner name", line(p.customer) || line(wa.ownerName)],
      ["Phone", line(p.phone)], ["Email", line(p.email)], ["Ins. carrier", line(p.carrier)], ["Loss cause", line(p.lossCause)],
    ] },
    { t: "subhead", text: "Scope of authorized work", right: "" },
    items.length ? { t: "bullets", items } : { t: "note", text: "No scope items were checked on this authorization." },
    { t: "subhead", text: "Terms & conditions", right: "" },
    ...TERMS.map(([k, v]) => ({ t: "para", text: `${k}: ${v}`, size: 8.5, font: "reg", color: "black" })),
    { t: "subhead", text: "Text message consent (optional)", right: "" },
    { t: "para", text: smsConsentLine(wa.smsConsent), size: 8.5, font: "reg", color: "black" },
    { t: "para", text: SMS_LINKS, size: 7.5, font: "reg", color: "sub" },
    { t: "subhead", text: "Authorization & signatures", right: "" },
    { t: "para", text: SIGN_LEAD, size: 8.5, font: "reg", color: "sub" },
    { t: "signatures", items: [
      sigItem(media, OWNER_SIG_LABEL, wa, { sig: "ownerSig", name: "ownerName", date: "ownerDate" }, "workAuth", { portal: true, fallbackName: p.customer }),
      sigItem(media, REP_SIG_LABEL, wa, { sig: "repSig", name: "repName", date: "repDate" }, "workAuth"),
    ] },
  ];
  return [{ title: null, newPage: false, blocks }];
}

function floorPlanParts(b) {
  const pages = isObj(b.p.floorPlan) ? uploadedDocPages(b.p.floorPlan) : [];
  return pages.length ? [{ title: null, newPage: false, blocks: [pagesBlock(b.media, pages, "Floor plan", "floorPlan")] }] : [];
}

/* the map's dry goal, by the form's rule (forms.js moistureMap goalNum):
   the typed Dry Goal's number, else the material's IICRC standard */
function goalOf(m) {
  const typed = parseFloat(str(m.dryGoal).replace(/[^0-9.]/g, ""));
  if (!Number.isNaN(typed)) return typed;
  const g = goalFor(m.material);
  return g != null ? g : null;
}
const LOC_BLOCK = 13;

function mapParts(b) {
  const { p, media, counts } = b;
  const parts = [];
  arr(p.moistureMaps).forEach((m, mi) => {
    if (!isObj(m)) return;
    const label = line(m.label);
    const goal = goalOf(m);
    const goalText = filled(m.dryGoal) ? line(m.dryGoal) : goal != null ? `≤ ${goal}%` : "";
    const blocks = [{ t: "fields", cols: 3, pairs: [
      ["Room / area", label], ["Material", line(m.material)], ["Dry goal (MC%)", goalText],
      ["Meter / setting", line(m.meter)], ["Technician", line(m.technician)],
      ["Ambient temp / RH", [line(m.ambientTemp), line(m.ambientRH)].filter(Boolean).join(" / ")],
      ["Equipment on site", line(m.equipmentOnSite)],
    ] }];
    const sketch = media.opt("sketch", m.sketch || m.floorPlan, `map:${str(m.id)}:sketch`);
    if (sketch) blocks.push({ t: "image", media: sketch, maxH: 300, caption: label ? `${label} — affected area and reading locations` : "Affected area and reading locations" });
    const areaPhotos = arr(m.photos).map((src, i) => media.opt("sketch", src, `map:${str(m.id)}:photo:${i}`)).filter(Boolean);
    if (areaPhotos.length) blocks.push({ t: "grid", perRow: 3, boxH: 150, items: areaPhotos.map((k, i) => ({ media: k, caption: `Area photo ${i + 1}` })) });

    // the reading grid: dated rows with anything on them, in blocks of 13 locations
    const entries = mapPhotoEntries(p, m);
    const photoLocs = new Set(entries.filter((e) => e.row).map((e) => e.loc));
    const rows = arr(m.readings).filter((r) => isObj(r) && (arr(r.values).some(filled) || filled(r.notes) || entries.some((e) => e.row === r)));
    let width = 0;
    for (const r of rows) arr(r.values).forEach((v, i) => { if (filled(v)) width = Math.max(width, i + 1); });
    for (const loc of photoLocs) width = Math.max(width, loc + 1);
    const nBlocks = Math.max(1, Math.ceil(width / LOC_BLOCK));
    let marked = false;
    blocks.push({ t: "subhead", text: "Moisture readings (MC%)", right: goalText ? `Dry goal ${goalText}` : "" });
    for (let k = 0; k < nBlocks; k++) {
      const start = k * LOC_BLOCK;
      const columns = [{ head: "Date", w: 0.13 }];
      for (let n = start + 1; n <= start + LOC_BLOCK; n++) columns.push({ head: String(n), w: 0.87 / LOC_BLOCK, align: "center" });
      blocks.push({ t: "table", columns, size: 8, zebra: false, rows: rows.map((r) => {
        const cells = [mdy(r.date)];
        for (let loc = start; loc < start + LOC_BLOCK; loc++) {
          const v = line(arr(r.values)[loc]);
          const cell = { text: v, align: "center" };
          const n = parseFloat(v);
          if (goal != null && v !== "" && !Number.isNaN(n)) cell.fill = n <= goal ? "dry" : "wet";
          if (photoAt(p, m, r, loc)) { cell.mark = "P"; marked = true; }
          if (v !== "") counts.readings++;
          cells.push(cell.fill || cell.mark ? cell : v);
        }
        return cells;
      }) });
    }
    blocks.push({ t: "para", size: 7.5, font: "reg", color: "sub", text: [
      goal != null ? `Green = at or below the dry goal (${goal}%); red = above it.` : "",
      marked ? "P = this reading has a photo of the meter screen, below." : "",
    ].filter(Boolean).join(" ") || "No dry goal set for this map." });
    const notes = rows.filter((r) => filled(r.notes)).map((r) => `${mdy(r.date)}: ${line(r.notes)}`);
    if (notes.length) blocks.push({ t: "subhead", text: "Notes", right: "" }, { t: "bullets", items: notes });
    const plan = media.opt("sketch", m.equipmentPlanImg, `map:${str(m.id)}:equipment`);
    if (plan) blocks.push({ t: "subhead", text: "Equipment placement", right: "" }, { t: "image", media: plan, maxH: 300, caption: label ? `${label} — equipment` : "Equipment placement" });
    if (entries.length) {
      blocks.push(
        { t: "subhead", text: "Meter photos", right: plural(entries.length, "photo") },
        { t: "grid", perRow: 4, boxH: 120, items: entries.map((e) => ({
          media: media.need("meter", e.ph.src, `meter:${str(e.ph.id)}`),
          caption: [`Loc ${e.loc + 1}`, md(e.date), mc(e.value), e.orphan ? "reading date removed" : ""].filter(Boolean).join(" · "),
        })) },
      );
      counts.meterPhotos += entries.length;
    }
    counts.maps++;
    parts.push({ title: `Moisture Map — ${label || mi + 1}`, newPage: parts.length > 0, blocks });
  });
  return parts;
}

/* forms.js scanTime: a time a scan recorded (the printed S) */
function scanTime(row, key) {
  if (row.scanId) return key === "placed" || (key === "removed" && !!(row.scan && row.scan.removeId));
  const f = row.scanFill;
  return key === "removed" && !!(f && f.removeId) && str(row.removed) === str(f.removed);
}
const EQ_KEYS = ["asset", "type", "location", "placed", "removed", "hours", "notes"];
const PSY_KEYS = ["outT", "outRH", "outGPP", "refT", "refRH", "refGPP", "affT", "affRH", "affGPP", "gd", "dehu", "am", "scrub", "tech", "notes"];
const SCAN_ACT = { place: "Placed", move: "Moved", remove: "Removed" };
const SCAN_HOW = { camera: "Camera", photo: "Label photo", typed: "Typed tag" };
/* forms.js dryingLog paintScanPrint, verbatim */
export const SCAN_LEGEND = "= recorded by scanning the unit's QR label on site";
export const SCAN_FOOT = "Times come from the scanning device's clock at the moment the label was read. Each scan is also logged on Roybal's server when the device syncs, and that log can't be edited.";

function sizingBlocks(log) {
  const c = log.equipCalc;
  if (!isObj(c) || !isObj(c.airMovers)) return [];
  const dev = isObj(log.calcDeviation) ? log.calcDeviation : {};
  const dep = deployedCounts(log.equipment);
  const inp = isObj(c.inputs) ? c.inputs : {};
  const am = c.airMovers, dh = isObj(c.dehu) ? c.dehu : {}, sc = isObj(c.scrubbers) ? c.scrubbers : {}, ht = isObj(c.heat) ? c.heat : {};
  const have = (n, short) => ({ text: `${n}${short ? " (short)" : ""}`, align: "center", ...(short ? { font: "bold" } : {}) });
  const amRec = am.low === am.high ? String(am.low) : `${am.low}–${am.high}`;
  const dhRec = dh.na ? "N/A" : dh.type === "desiccant" ? `${dh.units} (${dh.cfm} CFM)` : `${dh.units} (${dh.pintsPerDay} PPD)`;
  const dhLabel = dh.type === "desiccant" ? "Desiccant dehumidifiers" : dh.type === "conv" ? "Conventional dehumidifiers" : `LGR dehumidifiers (${dh.ahamPints || 70}-pint)`;
  const sized = akDay(c.at) || isoDay(c.at);
  const rows = [
    ["Air movers", { text: amRec, align: "center" }, have(dep.airMovers, num(dep.airMovers) < num(am.low)), line(am.basis), line(dev.am)],
    [dhLabel, { text: dhRec, align: "center" }, have(dep.dehus, !dh.na && num(dep.dehus) < num(dh.units)), line(dh.basis), line(dev.dehu)],
    ["Air scrubbers / AFDs", { text: sc.count ? String(sc.count) : "None", align: "center" }, have(dep.scrubbers, num(sc.count) > 0 && num(dep.scrubbers) < num(sc.count)), line(sc.basis), line(dev.scrub)],
    ["Auxiliary heat", { text: ht.needed ? "Yes" : ht.known ? "No" : "?", align: "center" }, have(dep.heaters || "—", !!ht.needed && !dep.heaters), line(ht.basis), line(dev.heat)],
  ];
  const deviations = ["am", "dehu", "scrub", "heat"].filter((k) => filled(dev[k])).length;
  return [
    { t: "subhead", text: "Equipment sizing (IICRC WRT worksheets)", right: deviations ? plural(deviations, "deviation note") : "" },
    { t: "para", size: 8, font: "reg", color: "sub", text:
      `Sized ${mdy(sized)} — Class ${line(inp.waterClass) || "?"} / Cat ${line(inp.waterCategory) || "?"}, ` +
      `${thousands(inp.sf)} SF wet floor across ${num(inp.rooms)} room(s), ${thousands(inp.volume)} cu ft` +
      (num(inp.measuredVolumeRooms) ? ` (${plural(num(inp.measuredVolumeRooms), "room volume")} measured by Magicplan)` : "") },
    { t: "table", size: 7.5, zebra: true, columns: [
      { head: "Equipment", w: 0.18 }, { head: "Recommended", w: 0.12, align: "center" }, { head: "Deployed", w: 0.1, align: "center" },
      { head: "Basis (IICRC WRT worksheets)", w: 0.36 }, { head: "Deviation from worksheet", w: 0.24 },
    ], rows },
  ];
}

function logParts(b) {
  const { p, media, counts, unitsOut } = b;
  const logs = arr(p.dryingLogs).filter(isObj);
  const parts = [];
  logs.forEach((log, li) => {
    const start = isoDay(log.dryoutStart), finish = isoDay(log.dryoutFinish);
    const days = start && finish && finish >= start ? dayNo(finish) - dayNo(start) + 1 : null;
    const blocks = [{ t: "fields", cols: 3, pairs: [
      ["Dry-out start", mdy(log.dryoutStart)], ["Dry-out finish", mdy(log.dryoutFinish)],
      ["Drying days", days != null ? String(days) : ""], ["Tech supervisor", line(log.techSupervisor)],
      ["Drying system", line(p.dryingSystem)], ["Water category / class", classLine(p)],
    ] }];
    if (filled(log.dryGoal)) blocks[0].pairs.push(["Dry goal (MC%)", line(log.dryGoal)]);
    blocks.push(...sizingBlocks(log));

    // equipment: the rows as applyScans left them; a typed row prints its stored hours
    const eq = arr(log.equipment).filter((r) => isObj(r) && (r.scanId || EQ_KEYS.some((k) => filled(r[k]))));
    let anyS = false;
    const rows = eq.map((r) => {
      // out, by scans.js rowOutAt's rule: a Set time, no Removed, not ended by a scan, not a run typed in Hours
      const ended = !!r.scanId && isObj(r.scan) && (!!r.scan.removeId || !!r.scan.endedTyped);
      const out = filled(r.placed) && !filled(r.removed) && !ended && !(r._manualHrs === true && num(r.hours) > 0);
      if (out) unitsOut.push(`${line(r.asset) || line(r.type) || "Unit"}${(rowRoom(r) || line(r.location)) ? ` (${rowRoom(r) || line(r.location)})` : ""}`);
      const t = (key) => {
        const s = shortWall(r[key]);
        if (s && scanTime(r, key)) { anyS = true; return { text: s, mark: "S" }; }
        return s;
      };
      return [line(r.asset), line(r.type), line(r.location), t("placed"),
        out ? { text: "still out", font: "ital" } : t("removed"),
        out ? "" : { text: line(r.hours), align: "right" },
        str(r.notes).split("\n").map(line).filter(Boolean).join("; ")];
    });
    counts.equipment += eq.length;
    blocks.push(
      { t: "subhead", text: "Equipment deployment & runtime", right: plural(eq.length, "unit") },
      { t: "table", size: 7.5, zebra: true, columns: [
        { head: "Tag / asset", w: 0.1 }, { head: "Type", w: 0.17 }, { head: "Location", w: 0.13 },
        { head: "Set", w: 0.12 }, { head: "Pulled", w: 0.12 }, { head: "Hours", w: 0.07, align: "right" }, { head: "Notes", w: 0.29 },
      ], rows },
    );
    if (anyS || eq.some((r) => r.scanId)) blocks.push({ t: "para", size: 7.5, font: "reg", color: "sub", text: `S ${SCAN_LEGEND}.` });

    // psychrometric readings; a GPP left blank is the form's own figure (core.js gpp)
    const ps = arr(log.readings).filter((r) => isObj(r) && PSY_KEYS.some((k) => filled(r[k])));
    const gppOf = (r, k, t, rh) => (filled(r[k]) ? line(r[k]) : str(gpp(r[t], r[rh]) ?? ""));
    blocks.push(
      { t: "subhead", text: "Daily psychrometric readings", right: "°F · %RH · grains per pound" },
      { t: "table", size: 6.5, zebra: true, columns: [
        { head: "Date", w: 0.075 }, { head: "Time", w: 0.05 },
        { head: "Out °F", w: 0.045, align: "center" }, { head: "Out RH", w: 0.045, align: "center" }, { head: "Out GPP", w: 0.05, align: "center" },
        { head: "Ref °F", w: 0.045, align: "center" }, { head: "Ref RH", w: 0.045, align: "center" }, { head: "Ref GPP", w: 0.05, align: "center" },
        { head: "Aff °F", w: 0.045, align: "center" }, { head: "Aff RH", w: 0.045, align: "center" }, { head: "Aff GPP", w: 0.05, align: "center" },
        { head: "GD", w: 0.04, align: "center" }, { head: "Dehu", w: 0.04, align: "center" }, { head: "AM", w: 0.035, align: "center" },
        { head: "Scrb", w: 0.04, align: "center" }, { head: "Tech", w: 0.08 }, { head: "Notes", w: 0.18 },
      ], rows: ps.map((r) => {
        const og = gppOf(r, "outGPP", "outT", "outRH"), rg = gppOf(r, "refGPP", "refT", "refRH"), ag = gppOf(r, "affGPP", "affT", "affRH");
        const gd = filled(r.gd) ? line(r.gd) : rg !== "" && ag !== "" ? String(Number(rg) - Number(ag)) : "";
        return [mdy(r.date), line(r.time ?? r.timeIn), line(r.outT), line(r.outRH), og, line(r.refT), line(r.refRH), rg,
          line(r.affT), line(r.affRH), ag, gd, line(r.dehu), line(r.am), line(r.scrub), noEmail(r.tech), line(r.notes)];
      }) },
    );

    // this log's scan record: its scanned rows' placements and its typed rows' scans
    const rec = scanRecord(p, eq.filter((r) => r.scanId).map((r) => r.scanId), log.id);
    if (rec.length) {
      counts.scans += rec.length;
      blocks.push(
        { t: "subhead", text: "Equipment scan record", right: plural(rec.length, "scan") },
        { t: "table", size: 7.5, zebra: true, columns: [
          { head: "Time", w: 0.13 }, { head: "Tag", w: 0.1 }, { head: "Type", w: 0.17 }, { head: "Action", w: 0.1 },
          { head: "Room", w: 0.18 }, { head: "Read by", w: 0.13 }, { head: "Tech", w: 0.19 },
        ], rows: rec.map((r) => [shortWall(r.at), noEmail(r.tag), noEmail(r.type), SCAN_ACT[r.act] || line(r.act), noEmail(r.room),
          noEmail(SCAN_HOW[r.how] || r.how), noEmail(r.tech) || loginOf(r.by)]) },
        { t: "para", size: 7.5, font: "reg", color: "sub", text: SCAN_FOOT },
      );
    }
    counts.logs++;
    const span = start ? ` — ${mdy(start)}${finish ? ` to ${mdy(finish)}` : ""}` : "";
    parts.push({ title: `Drying Log${logs.length > 1 ? ` ${li + 1}` : ""}${span}`, newPage: parts.length > 0, blocks });
  });
  return parts;
}

/* Photo numbers (§5): v1 numbers each photo by its place among the photos
   with src or cloud (the photo log, ZIP and portal numbering). Later builds
   keep every number they were given, give new photos the next numbers in
   photo-log order, and never hand a deleted photo's number to another:
   the numbering carries every number ever given.

   Each photo's number is kept under its own key: its id, or for a second
   photo with the same id (a merge that kept both copies) and for a photo
   with no id, "m:" and its image's hash (":2", ":3" on a repeat). One key
   per photo is what keeps a number where it was build after build. */
function photoKeys(photos) {
  const taken = new Set();
  return photos.map((ph) => {
    const id = str(ph.id);
    if (id && !taken.has(id)) { taken.add(id); return id; }
    const cloud = line(ph.cloud).toLowerCase();
    const src = sourceOf(ph.src);
    // an inline image and the object it is uploaded as share this hash (media.js)
    const base = "m:" + (HEX64.test(cloud) ? cloud : src ? src.hash || sha(src.inline) : sha(str(ph.src || ph.cloud)));
    let k = base;
    for (let n = 2; taken.has(k); n++) k = `${base}:${n}`;
    taken.add(k);
    return k;
  });
}
function numberPhotos(photos, prev) {
  const given = {};
  const used = new Set();
  let max = 0;
  if (isObj(prev)) {
    for (const [id, n] of Object.entries(prev)) {
      if (!Number.isSafeInteger(n) || n < 1) continue;
      given[id] = n;
      max = Math.max(max, n);
    }
  }
  const fresh = !Object.keys(given).length;
  const keys = photoKeys(photos);
  const nums = new Map();
  photos.forEach((ph, i) => {
    if (fresh) { nums.set(ph, i + 1); return; }
    const k = keys[i];
    if (has(given, k) && !used.has(given[k])) { nums.set(ph, given[k]); used.add(given[k]); }
  });
  // a new photo, or one whose stored number another photo holds (a numbering with a duplicate)
  photos.forEach((ph, i) => {
    if (nums.has(ph)) return;
    const n = ++max;
    nums.set(ph, n);
    given[keys[i]] = n;
  });
  if (fresh) photos.forEach((ph, i) => { given[keys[i]] = nums.get(ph); });
  return { nums, photoNums: given };
}
const STAGE_RANK = { before: 0, during: 1, after: 2 };
const stageOf = (s) => (s === "before" || s === "after" ? s : "during");

function photoParts(b, photos, nums) {
  const { media, counts } = b;
  const list = photos.map((ph) => ({ ph, n: nums.get(ph), stage: stageOf(ph.stage) }))
    .sort((x, y) => STAGE_RANK[x.stage] - STAGE_RANK[y.stage] || x.n - y.n);
  if (!list.length) return [];
  counts.photos = list.length;
  return [{ title: null, newPage: false, blocks: [{ t: "photos", items: list.map(({ ph, n, stage }) => ({
    media: media.photo(ph),
    caption: [`#${pad3(n)}`, " · " + [stage.toUpperCase(), line(ph.room), line(ph.caption)].filter(Boolean).join(" · ")],
  })) }] }];
}

function docParts(b, excluded) {
  const { p, media } = b;
  const parts = [];
  for (const d of arr(p.supportDocs)) {
    if (!isObj(d) || excluded.has("supportDocs:" + str(d.id))) continue;
    const pages = uploadedDocPages(d);
    if (!pages.length) continue;
    const title = line(d.title) || line(d.docType) || "Supporting document";
    parts.push({ title: `Supporting Document — ${title}`, newPage: parts.length > 0, blocks: [pagesBlock(media, pages, title, `doc:${str(d.id)}`)] });
  }
  b.counts.docs = parts.length;
  return parts;
}

function invoiceParts(b) {
  const { p, media, counts, opts } = b;
  const asOf = mdy(opts.now instanceof Date ? akDay(opts.now) : isoDay(opts.today));
  const parts = [];
  readyInvoices(p).forEach((src, ii) => {
    const { inv, totals: t } = billedInvoice(p, src);
    const no = printedNo(inv);
    const blocks = [
      { t: "fields", cols: 2, pairs: [["Invoice #", no], ["Invoice date", mdy(inv.invoiceDate)], ["Due date", mdy(inv.dueDate)], ["Payment terms", line(inv.terms)]] },
      { t: "subhead", text: "Bill to / insured & claim", right: "" },
      { t: "fields", cols: 2, pairs: jobFields(p) },
    ];
    if (filled(inv.lossSummary)) blocks.push({ t: "subhead", text: "Loss description / scope summary", right: "" }, { t: "para", text: prose(inv.lossSummary), size: 9, font: "reg", color: "black" });

    // the lines grouped by room, in first-appearance order (forms.js invoiceCharges), numbered straight through
    const items = arr(inv.items).filter((it) => isObj(it) && (filled(it.desc) || filled(it.qty) || filled(it.price)));
    const order = [], by = new Map();
    for (const it of items) {
      const k = line(it.room);
      if (!by.has(k)) { by.set(k, []); order.push(k); }
      by.get(k).push(it);
    }
    const rows = [];
    let n = 0;
    for (const k of order) {
      if (k || order.length > 1) {
        const band = (text) => ({ text, fill: "band", font: "bold" });
        rows.push([band(""), band(k || "General"), band(""), band(""), band(""), band("")]);
      }
      for (const it of by.get(k)) {
        const ext = num(it.qty) * num(it.price);
        rows.push([`${++n}.`, prose(it.desc).replace(/\n/g, " "), { text: line(it.qty), align: "right" }, line(it.unit),
          { text: filled(it.price) ? money(it.price) : "", align: "right" }, { text: money(ext), align: "right" }]);
      }
    }
    blocks.push(
      { t: "subhead", text: "Charges", right: inv.billingModel === "contract" ? "Contract (set amount)" : "Time & materials" },
      { t: "table", size: 8, zebra: true, columns: [
        { head: "#", w: 0.05 }, { head: "Description", w: 0.51 }, { head: "Qty", w: 0.08, align: "right" },
        { head: "Unit", w: 0.08 }, { head: "Unit price", w: 0.13, align: "right" }, { head: "Total", w: 0.15, align: "right" },
      ], rows },
    );

    // the totals ladder as billed; payments are as of this build and sit under _rows (outside the hash)
    const contract = inv.billingModel === "contract", amt = inv.opMode === "amount";
    const ladder = [];
    const row = (label, v, bold = false) => ladder.push(bold
      ? [{ text: label, font: "bold" }, { text: money(v), font: "bold", align: "right" }]
      : [label, { text: money(v), align: "right" }]);
    if (!contract || t.subtotal) row(contract ? "Scope line items" : "Line item total", t.subtotal);
    if (contract) row("Contract amount", t.base);
    else {
      if (t.overhead) row(amt ? "Overhead" : `Overhead (${pctText(inv.overheadPct)})`, t.overhead);
      if (t.profit) row(amt ? "Profit" : `Profit (${pctText(inv.profitPct)})`, t.profit);
    }
    row(contract ? "Contract total" : "Replacement cost value", t.rcv);
    if (num(inv.deductible)) row("Less: deductible / non-recoverable", -num(inv.deductible));
    if (t.tax) row(`Sales tax (${pctText(inv.taxRate)})`, t.tax);
    row("Invoice total", t.total, true);
    const paid = num(inv.previousPayments) > 0 ? num(inv.previousPayments)
      : arr(inv.payments).reduce((s, x) => s + (isObj(x) ? num(x.amount) : 0), 0);
    const qbo = inv.qboBalance != null && inv.qboBalance !== "" && Number.isFinite(Number(inv.qboBalance)) ? Number(inv.qboBalance) : null;
    const balance = qbo != null ? qbo : t.total - paid;
    const totalsBlock = { t: "table", size: 8.5, zebra: false, columns: [{ head: "Totals as billed", w: 0.72 }, { head: "Amount", w: 0.28, align: "right" }], rows: ladder };
    if (paid > 0.005 || (qbo != null && Math.abs(qbo - t.total) > 0.005)) {
      totalsBlock._rows = [
        [`Payments received${asOf ? ` (as of ${asOf})` : ""}`, { text: money(-paid), align: "right" }],
        [{ text: "Balance due", font: "bold" }, { text: money(balance), font: "bold", align: "right" }],
      ];
    }
    blocks.push(totalsBlock);
    if (filled(inv.notes)) blocks.push({ t: "subhead", text: "Notes / supporting documentation", right: "" }, { t: "para", text: prose(inv.notes), size: 8.5, font: "reg", color: "black" });
    blocks.push({ t: "note", text: `Remit to: ${COMPANY.name} · ${COMPANY.address} · Phone: ${COMPANY.phone} · ${COMPANY.email} · Methods: Check, ACH, or credit card on request` });
    arr(inv.attachments).forEach((att, ai) => {
      const pages = isObj(att) ? arr(att.pages) : [];
      if (pages.length) blocks.push(pagesBlock(media, pages, `Invoice ${no} attachment — ${line(att.label) || `Attachment ${ai + 1}`}`, `inv:${str(inv.id)}:${ai}`));
    });
    counts.invoices++;
    counts.invoiceTotal = Math.round((counts.invoiceTotal + t.total) * 100) / 100;
    b.invoiceList.push({ number: no, date: isoDay(inv.invoiceDate), total: Math.round(t.total * 100) / 100 });
    parts.push({ title: `Invoice ${no}`, newPage: ii > 0, blocks });
  });
  return parts;
}

/* the cover's facts an adjuster checks first */
function coverOf(p) {
  const c = isObj(p.certDrying) ? p.certDrying : {};
  const logs = arr(p.dryingLogs).filter(isObj);
  const eq = logs.flatMap((l) => arr(l.equipment)).filter(isObj);
  const start = isoDay(c.dryStart) || earliest(logs.map((l) => isoDay(l.dryoutStart))) || earliest(eq.map((r) => isoDay(wallOf(r.placed))));
  const finish = isoDay(c.dryComplete) || latest(logs.map((l) => isoDay(l.dryoutFinish))) || latest(eq.map((r) => isoDay(wallOf(r.removed))));
  const days = filled(c.dryingDays) ? line(c.dryingDays) : start && finish && finish >= start ? String(dayNo(finish) - dayNo(start) + 1) : "";
  const facts = [["Mitigation start", mdy(start)], ["Mitigation finish", mdy(finish)], ["Drying days", days]];
  if (c.mode !== "upload" && filled(c.issueDate)) facts.push(["Certificate dated", mdy(c.issueDate)]);
  if (filled(p.dryingSystem)) facts.push(["Drying system", line(p.dryingSystem)]);
  for (const [label, key] of [["Dehumidifier days", "dehuDays"], ["Air mover days", "amDays"], ["Air scrubber days", "scrubDays"], ["Heater days", "heaterDays"]]) {
    if (filled(c[key])) facts.push([label, line(c[key])]);
  }
  return {
    customer: line(p.customer), address: line(p.address), claimNo: line(p.claimNo), carrier: line(p.carrier),
    adjuster: line(p.adjuster), dateOfLoss: mdy(p.dateOfLoss), lossCause: line(p.lossCause),
    workOrderNo: line(p.workOrderNo), waterCategory: line(p.waterCategory), waterClass: line(p.waterClass),
    facts: facts.filter(([, v]) => v !== ""),
  };
}

/** buildModel(project, {today, now, prevPhotoNums}) → the document model (§5).
    Works on a copy with the scans written into the drying logs; the job
    passed in is never changed. */
export function buildModel(project, opts = {}) {
  const p = structuredClone(isObj(project) ? project : {});
  try { applyScans(p); } catch { /* the rows as stored */ }
  const excluded = new Set(arr(p.packetExclude).map(str));
  const on = (key) => !excluded.has(EXCLUDE_KEY[key]);
  const counts = { maps: 0, readings: 0, meterPhotos: 0, logs: 0, equipment: 0, scans: 0, photos: 0, docs: 0, invoices: 0, invoiceTotal: 0 };
  const b = { p, opts: isObj(opts) ? opts : {}, media: new MediaSet(), counts, unitsOut: [], invoiceList: [] };
  const photos = arr(p.photos).filter((ph) => isObj(ph) && (filled(ph.src) || filled(ph.cloud)));
  const { nums, photoNums } = numberPhotos(photos, b.opts.prevPhotoNums);

  const sections = [];
  const add = (key, parts) => { if (parts.length) sections.push({ key, title: SECTION_TITLES[key], parts }); };
  if (on("cert")) add("cert", certParts(b));
  if (on("workAuth")) add("workAuth", workAuthParts(b));
  if (on("floorPlan")) add("floorPlan", floorPlanParts(b));
  if (on("maps")) add("maps", mapParts(b));
  if (on("logs")) add("logs", logParts(b));
  if (on("photos")) add("photos", photoParts(b, photos, nums));
  add("docs", docParts(b, excluded));
  if (on("invoices")) add("invoices", invoiceParts(b));

  let hardGaps = [];
  try { hardGaps = evaluateProject(p).hardGaps.map((g) => g.label); } catch { /* no gaps to report */ }
  return {
    v: MODEL_V,
    jobId: line(p.id),
    cover: coverOf(p),
    sections,
    media: b.media.refs,
    photoNums,
    counts,
    unitsOut: b.unitsOut,
    hardGaps,
    missing: b.media.missing,
    invoiceList: b.invoiceList,
  };
}

/* ============================================================
   Hash and versions (§6)
   ============================================================ */
/* JSON with every object's keys sorted and every key starting with "_"
   dropped (as-of-build values: payments, balances) */
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x === undefined ? null : x)).join(",") + "]";
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => !k.startsWith("_") && v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  if (typeof v === "number" && !Number.isFinite(v)) return "null";
  return JSON.stringify(v === undefined ? null : v);
}

/** sha256 hex of what prints: { v, cover, sections }, media by key only. */
export function modelHash(model) {
  return sha(canon({ v: model.v, cover: model.cover, sections: model.sections }));
}

/** The same per section key, plus `cover`. */
export function sectionHashes(model) {
  const out = { cover: sha(canon({ v: model.v, cover: model.cover })) };
  for (const s of arr(model.sections)) out[s.key] = sha(canon({ v: model.v, section: s }));
  return out;
}

/** The titles of what changed since the version a hash set came from, in
    print order: a section whose hash differs, one added ("… (added)") and
    one taken out ("… (removed)"). No earlier hashes: nothing to compare. */
export function changedSections(prevHashes, curHashes, model) {
  if (!isObj(prevHashes) || !Object.keys(prevHashes).length) return [];
  const cur = isObj(curHashes) ? curHashes : sectionHashes(model);
  const titleOf = (k) => (arr(model && model.sections).find((s) => s.key === k) || {}).title || SECTION_TITLES[k] || k;
  const keys = ["cover", ...SECTION_ORDER];
  for (const k of [...Object.keys(prevHashes), ...Object.keys(cur)]) if (!keys.includes(k)) keys.push(k);
  const out = [];
  for (const k of keys) {
    const a = has(prevHashes, k), b = has(cur, k);
    if (a && b && prevHashes[k] !== cur[k]) out.push(titleOf(k));
    else if (!a && b) out.push(`${titleOf(k)} (added)`);
    else if (a && !b) out.push(`${titleOf(k)} (removed)`);
  }
  return out;
}

/* ============================================================
   Media budget (§10)
   ============================================================ */
/** Every field-media object name whose size the lane looks up: each full
    copy's hash and each small candidate (an archived copy's hash, or
    "thumb_<full hash>"). */
export function mediaNames(model) {
  const out = new Set();
  for (const ref of Object.values((model && model.media) || {})) {
    if (ref.full && ref.full.hash) out.add(ref.full.hash);
    if (ref.small && ref.small.hash) out.add(ref.small.hash);
  }
  return [...out];
}

const DATA_PREFIX = "data:image/jpeg;base64,".length;

/** planMedia(model, sizes, {fullKb, overheadKb}) → {mode, estimateBytes, load}.
    `sizes`: Map(object name → stored text bytes) from storage.objects. A
    stored object is a data URL's text, so its bytes are about
    (text − prefix) × 3/4; an inline image is sized from its own text. An
    object the sizes do not list counts as nothing (it will be missing).
    Full when everything fits fullKb; else compact: each job photo's small
    copy when one is sized, else its full copy. `load` names, for every
    image, the one Source to fetch in that mode. */
export function planMedia(model, sizes, { fullKb = 9500, overheadKb = 60 } = {}) {
  const sz = sizes instanceof Map ? sizes : new Map(Object.entries(isObj(sizes) ? sizes : {}));
  const bytesOf = (src) => {
    if (!src) return null;
    if (src.inline) {
      const s = String(src.inline);
      return Math.floor((s.length - (s.indexOf(",") + 1)) * 3 / 4);
    }
    if (!sz.has(src.hash)) return null;
    return Math.max(0, Math.floor((num(sz.get(src.hash)) - DATA_PREFIX) * 3 / 4));
  };
  let fixed = num(overheadKb) * 1024, photosFull = 0, photosCompact = 0;
  const plan = [];
  for (const [key, ref] of Object.entries((model && model.media) || {})) {
    if (!ref || !ref.full) continue;
    const full = bytesOf(ref.full) ?? 0;
    if (ref.kind !== "photo") { fixed += full; plan.push({ key, full: ref.full, compact: ref.full }); continue; }
    const small = ref.small ? bytesOf(ref.small) : null;
    photosFull += full;
    photosCompact += small != null ? small : full;
    plan.push({ key, full: ref.full, compact: small != null ? ref.small : ref.full });
  }
  const full = fixed + photosFull <= num(fullKb) * 1024;
  return {
    mode: full ? "full" : "compact",
    estimateBytes: Math.round(fixed + (full ? photosFull : photosCompact)),
    load: plan.map((x) => ({ key: x.key, source: full ? x.full : x.compact })),
  };
}

/* ============================================================
   Words (§13): fixed templates, no AI
   ============================================================ */
const labelOf = (label) => {
  const l = isObj(label) ? label : {};
  return {
    number: line(l.number), version: Number.isSafeInteger(l.version) && l.version > 0 ? l.version : 1,
    replaces: isObj(l.replaces) ? l.replaces : null, changed: arr(l.changed).map(line).filter(Boolean),
    mode: l.mode === "compact" ? "compact" : "full",
  };
};
/* the job as a text names it: "Jane Sample (claim DEMO-12345)". `model` is a
   model or, for a hold the gate made before any model, the job blob */
function jobName(model) {
  const cv = isObj(model && model.cover) ? model.cover : isObj(model) ? model : {};
  const who = clip(line(cv.customer) || line(cv.address) || "this job", 60);
  const claim = clip(line(cv.claimNo), 40);
  return claim ? `${who} (claim ${claim})` : who;
}
const sentDay = (iso) => mdy(akDay(iso) || isoDay(iso));
const findSection = (model, key) => arr(model && model.sections).find((s) => s.key === key) || null;
const pagesIn = (sec) => arr(sec && sec.parts).flatMap((pt) => arr(pt.blocks)).filter((bl) => bl.t === "pages")
  .reduce((n, bl) => n + arr(bl.items).length, 0);
/* the owner's signature is on the form (drawn, or made in the portal): only
   ours on it is a form still out for signing, never "signed" */
const ownerSigned = (sec) => arr(sec && sec.parts).flatMap((pt) => arr(pt.blocks)).filter((bl) => bl.t === "signatures")
  .some((bl) => arr(bl.items).some((it) => it.label === OWNER_SIG_LABEL && (it.media != null || it.electronic === true)));

/* the packet's contents, one line each, for the email */
function contentsLines(model) {
  const c = model.counts || {};
  const facts = new Map(arr(model.cover && model.cover.facts));
  const out = [];
  for (const s of arr(model.sections)) {
    if (s.key === "cert") {
      const pages = pagesIn(s);
      out.push(pages ? `Certificate of Drying (signed copy, ${plural(pages, "page")})`
        : `Certificate of Drying${facts.get("Certificate dated") ? `, dated ${facts.get("Certificate dated")}` : ""}`);
    } else if (s.key === "workAuth") {
      out.push(pagesIn(s) ? "Work authorization (signed copy)" : ownerSigned(s) ? "Work authorization, signed" : "Work authorization");
    } else if (s.key === "floorPlan") {
      out.push(`Floor plan (${plural(pagesIn(s), "page")})`);
    } else if (s.key === "maps") {
      out.push(`Moisture maps: ${plural(num(c.maps), "map")}, ${plural(num(c.readings), "reading")}, ${plural(num(c.meterPhotos), "meter photo")}`);
    } else if (s.key === "logs") {
      out.push(`Drying logs: ${plural(num(c.logs), "log")}, ${plural(num(c.equipment), "piece")} of equipment` +
        (num(c.scans) ? `, ${plural(num(c.scans), "equipment scan")}` : ""));
    } else if (s.key === "photos") {
      out.push(`Photos: ${num(c.photos)}`);
    } else if (s.key === "docs") {
      out.push(`Supporting documents: ${s.parts.length}`);
    } else if (s.key === "invoices") {
      for (const inv of arr(model.invoiceList)) out.push(`Invoice ${inv.number}: ${money(inv.total)}`);
    }
  }
  return out;
}

/** emailText(model, label) → {subject, body, filename}. */
export function emailText(model, label) {
  const L = labelOf(label);
  const cv = model.cover || {};
  const claim = line(cv.claimNo), name = line(cv.customer) || line(cv.address);
  const tag = `${L.number} v${L.version}`;
  const subject = clip([claim ? `Claim ${claim}` : "", name, `water mitigation documentation (${tag})`].filter(Boolean).join(" - "), 300);

  const facts = [["Insured", cv.customer], ["Property", cv.address], ["Claim", cv.claimNo], ["Carrier", cv.carrier], ["Date of loss", cv.dateOfLoss]]
    .filter(([, v]) => filled(v)).map(([k, v]) => `${k}: ${line(v)}`);
  const parts = [
    "Hello,",
    `Attached is the water mitigation documentation for this claim from ${COMPANY.name}, as one PDF: carrier packet ${L.number}, version ${L.version}.`,
    facts.join("\n"),
    ["The packet contains:", ...contentsLines(model).map((l) => `- ${l}`)].join("\n"),
  ];
  if (L.version > 1 && L.replaces) {
    const was = Number.isSafeInteger(L.replaces.version) ? L.replaces.version : L.version - 1;
    const when = sentDay(L.replaces.sentAt || L.replaces.sent_at);
    parts.push(`This version replaces version ${was}${when ? ` sent ${when}` : ""}.` + (L.changed.length ? ` What changed: ${L.changed.join(", ")}.` : ""));
  }
  if (L.mode === "compact") parts.push("Photos are reduced in size to keep this email under carrier size limits; full-size photos are available on request.");
  parts.push("Please reply to confirm you received it.");
  parts.push(["Thank you,", "", COMPANY.signatory, COMPANY.signatoryTitle, COMPANY.name, COMPANY.phone, COMPANY.email, COMPANY.licenses.join(" · ")].join("\n"));
  const body = parts.filter(Boolean).join("\n\n") + "\n";

  const last = (line(cv.customer).split(" ").pop() || "");
  const filename = clip([tag, claim ? `Claim ${claim}` : "", last].filter(Boolean).join(" - ")
    .replace(/[^A-Za-z0-9 #._-]/g, "").replace(/\s+/g, " ").trim(), 196) + ".pdf";
  return { subject, body, filename };
}

const mb = (bytes) => `${(num(bytes) / 1048576).toFixed(1)} MB`;

/** suggestedFrom(source, label) → the phrase beside the card's To. */
export function suggestedFrom(source, label) {
  const L = labelOf(label);
  const was = L.replaces && Number.isSafeInteger(L.replaces.version) ? L.replaces.version : null;
  const s = {
    last_sent: was ? `where version ${was} of this packet was sent` : "where the last version of this packet was sent",
    claim: "the newest email filed to this job on its claim number",
    email: "the newest email filed to this job",
    adjuster: "the job's Adjuster field",
  }[source] || "nothing on file: type the adjuster's address";
  return clip(s, 200);
}

/** rationaleText(model, label, facts) → the card's Why, one fact a line.
    facts = {recipient: {to, source}, bytes, pages, mode, missing, changed}. */
export function rationaleText(model, label, facts = {}) {
  const L = labelOf(label);
  const f = isObj(facts) ? facts : {};
  const cv = model.cover || {};
  const lines = [`Carrier packet ${L.number} v${L.version} for ${jobName(model)}${filled(cv.address) && filled(cv.customer) ? `, ${line(cv.address)}` : ""}.`];
  const r = isObj(f.recipient) ? f.recipient : {};
  lines.push(filled(r.to) ? `Suggested To: ${line(r.to)}, from ${suggestedFrom(r.source, L)}.` : "No adjuster address on file: type it in the To field.");
  const big = num(f.bytes) > 10 * 1048576;
  if (num(f.pages) || num(f.bytes)) {
    lines.push(`${num(f.pages) ? plural(num(f.pages), "page") : ""}${num(f.pages) && num(f.bytes) ? ", " : ""}${num(f.bytes) ? mb(f.bytes) : ""}.` +
      (big ? " Warning: over 10 MB, which some carrier mailboxes refuse." : ""));
  }
  if ((f.mode || L.mode) === "compact") lines.push("Compact mode: photos are reduced in size to keep the email under carrier size limits.");
  if (arr(model.unitsOut).length) lines.push(`Still out on the drying log (no pull time): ${model.unitsOut.join(", ")}.`);
  if (arr(model.hardGaps).length) lines.push(`Completeness gaps: ${model.hardGaps.join("; ")}.`);
  const missing = f.missing != null ? num(f.missing) : num(model.missing);
  if (missing) lines.push(`${plural(missing, "image")} could not be found and ${missing === 1 ? "prints" : "print"} as "Image not available".`);
  const changed = arr(f.changed).length ? arr(f.changed).map(line) : L.changed;
  if (L.version > 1) {
    const was = L.replaces && Number.isSafeInteger(L.replaces.version) ? L.replaces.version : L.version - 1;
    const when = L.replaces ? sentDay(L.replaces.sentAt || L.replaces.sent_at) : "";
    lines.push(`Replaces version ${was}${when ? ` sent ${when}` : ""}.${changed.length ? ` What changed: ${changed.join(", ")}.` : ""}`);
  }
  return lines.join("\n");
}

/** The text when a card is filed or re-offered (never with a YES code). */
export function readyText(model, label) {
  const L = labelOf(label);
  return `Carrier packet ${L.number} v${L.version} for ${jobName(model)} is ready. Review and send it from Approvals in the office app. No reply needed.`;
}

/** The heads-up text for a hold, once per job and reason. `model` may be
    the job blob (a gate hold has no model); null is the lane-wide
    storage_full hold. `permanent`: a failed build stopped short of 3 tries
    (the job's data stops it), so the text does not say "after 3 tries". */
export function holdText(reason, model, detail, { permanent = false } = {}) {
  const d = line(detail);
  if (!model || reason === "storage_full") {
    return `Carrier packets are on hold: packet storage is full${d ? ` (${d})` : ""}. No new packet is built until there is room again; old sent copies are cleared on their own after 90 days, or raise PACKET_STORAGE_MB. No reply needed.`;
  }
  const who = jobName(model);
  const n = Number(/^\d+/.exec(d)?.[0]);
  const count = (one, many) => (Number.isFinite(n) && n > 0 ? plural(n, one, many) : many);
  switch (reason) {
    case "no_invoice":
      return `Carrier packet for ${who} is waiting on a numbered invoice. It is built on its own once the invoice has a number. No reply needed.`;
    case "unchecked_fills":
      return `Carrier packet for ${who} is waiting: ${count("meter reading", "meter readings")} to check on the Moisture Map (tap each amber ?). No reply needed.`;
    case "unread_meter_photos":
      return `Carrier packet for ${who} is waiting: ${count("meter photo", "meter photos")} on an empty reading not read yet. Type the reading on the Moisture Map, or let the phone that took it sync. No reply needed.`;
    case "failed":
    case "failed_cap":
    case "build_failed":
      return permanent
        ? `Carrier packet for ${who} couldn't be built: something in the job stops it. It is not tried again until the job changes. No reply needed.`
        : `Carrier packet for ${who} couldn't be built after 3 tries. It is not tried again until the job changes. No reply needed.`;
    case "too_large":
      return `Carrier packet for ${who} is too large to email even with smaller photos. Untick photos or a large document on the job's packet page and it is built again. No reply needed.`;
    default:
      return `Carrier packet for ${who} is on hold${d ? `: ${d}` : ""}. No reply needed.`;
  }
}
