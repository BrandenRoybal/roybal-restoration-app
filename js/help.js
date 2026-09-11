/* ============================================================
   Roybal Field Forms — ❓ Help (#/help)
   ------------------------------------------------------------
   The whole app on one page, in crew words. The form list is
   generated from model.js's FORMS registry so it can never drift
   from what the job home actually shows; everything else is prose
   that must be kept honest when features ship (the board and the
   Office Admin each have their own help surface — this one only
   describes the field app).
   ============================================================ */
import { h } from "./core.js";
import { FORMS } from "./model.js";

const sec = (title, ...kids) => h("div", { class: "card", style: "margin-top:14px" },
  h("div", { style: "font-weight:700;margin-bottom:6px" }, title), ...kids);
const p = (...kids) => h("p", { class: "subtle", style: "margin:4px 0" }, ...kids);
const ul = (...items) => h("ul", { style: "margin:6px 0 2px;padding-left:20px" },
  ...items.map((kids) => h("li", { class: "subtle", style: "margin:4px 0" }, ...kids)));

const formList = (type) => ul(...FORMS.filter((f) => !f.types || f.types.includes(type))
  .map((f) => [h("strong", {}, `${f.icon} ${f.name}`), " — " + f.blurb]));

export function helpPage(root) {
  root.append(
    h("h1", {}, "How the app works"),
    p("This is the crew's job binder: every form, photo, reading, and signature for a job lives here, works with no signal, and turns into clean PDFs for the carrier. Sign in with your own crew email — that's what syncs your work across devices and powers My Week."),

    sec("The job list",
      ul(
        [h("strong", {}, "💧 Restoration / 🔨 Construction"), " — two lists, one toggle. Restoration is water/fire/mold mitigation; Construction is remodels, new builds, and rebuilds (each gets its own form set)."],
        [h("strong", {}, "Board columns"), " — jobs linked to the Job Board group under its live stage columns, so the list reads like the whiteboard. ⚠ chips repeat the board's schedule-truth warnings (no QuickBooks Time link, no hours since start, a phase that looks done but isn't marked)."],
        ["A finished job ", h("strong", {}, "archives"), " off the active list but stays below — nothing is deleted."])),

    sec("📅 My Week",
      p("Your next two weeks, sliced from the Job Board's live schedule — matched to the email you sign in with. It caches on the device, so it opens offline; a fresh pull replaces it when you're online. Everyone scheduled for the day also gets a morning ", h("strong", {}, "schedule text"), " listing their jobs (the office can switch that off per person).")),

    sec("Inside a job",
      ul(
        ["Enter the header once — customer, address, claim #, carrier, loss type (water, fire & smoke, mold, storm) — and it flows into every form and PDF."],
        [h("strong", {}, "Completeness"), " shows what the packet still needs before it can go out; ", h("strong", {}, "📝 Progress Update"), " drafts a where-things-stand note from the job's records."],
        ["Forms that keep a count (Drying Log, Moisture Map, Field Report…) take a new page per day or area — the tile shows how many you've saved."])),

    sec("💧 Restoration forms", formList("restoration")),
    sec("🔨 Construction forms", formList("construction")),

    sec("📷 Photos",
      ul(
        ["The gallery sorts itself — ", h("strong", {}, "before / during / after"), ", by room, or by date, with filter chips on top."],
        ["The AI captions each shot (an ", h("em", {}, "after"), " photo is described as finished work, not damage) and captions can be re-run as the engine improves. You can always edit them."],
        [h("strong", {}, "Deleting a photo deletes it everywhere"), " — the delete syncs to every device instead of creeping back."],
        [h("strong", {}, "Export ZIP"), " packs every photo full-res with an index sheet; ", h("strong", {}, "cloud offload"), " moves the big originals to storage and keeps thumbnails on the device when space runs low."])),

    sec("📄 The packet",
      ul(
        ["Every form has ", h("strong", {}, "Save as PDF"), " — each one saves under its own name, branded and letter-size."],
        [h("strong", {}, "Full job packet"), " stacks the completed forms into one carrier-ready document. Use the ", h("strong", {}, "packet picker"), " to leave any document out of this job's packet."],
        ["The cover narrative writes itself from the job's facts; if gaps remain you can ", h("strong", {}, "override"), " the lock and send anyway."],
        ["The adjuster email carries an ", h("strong", {}, "insurance link"), " to the whole packet, and the link also prints on the Photo Report and Contents Inventory — so the carrier can always reach the full-res originals."])),

    sec("🌐 The customer portal",
      p("The Client Portal form controls what this job's customer sees: status and curated photos, drying readings, shared documents, the “who's on the job today” line with crew bios (sent on the day's first clock-in), change orders to e-sign, material selections to choose from, and the balance with a pay-online link. Flip it on, then ", h("strong", {}, "Copy"), " or ", h("strong", {}, "Text"), " the link — the link is only live once published, so share it from here.")),

    sec("💬 Ask the office",
      p("The floating assistant rides over every job page — talk to it, type, or hand it a photo. It reads this job's records, answers like a colleague, and drafts the paperwork; anything that writes or sends lands behind a ", h("strong", {}, "confirm chip"), " first. Drag it anywhere, minimize it when it's in the way.")),

    sec("Offline & sync",
      ul(
        ["Everything saves to the device first and works with zero signal; changes sync when you're back online — watch the status line under your email."],
        ["Photos, readings, and forms merge across devices, so two people can work the same job."],
        ["If a job looks stale on this device, sign out and back in to re-pull the latest from the cloud."])));
}
