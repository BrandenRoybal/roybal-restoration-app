/**
 * HelpPage — In-app user guide for Roybal Construction LLC field operations app.
 */

import { useState } from "react";
import {
  BookOpen, Briefcase, Camera, Droplets, Wrench, DollarSign,
  Map, FileText, Users, ChevronDown, ChevronRight, CircleCheckBig,
  CircleAlert, Info,
} from "lucide-react";

interface Section {
  id: string;
  icon: React.ReactNode;
  title: string;
  color: string;
  content: React.ReactNode;
}

const Tip = ({ children }: { children: React.ReactNode }) => (
  <div className="flex gap-2.5 bg-[#F97316]/10 border border-[#F97316]/20 rounded-xl p-3 my-3">
    <Info size={15} className="text-[#F97316] flex-shrink-0 mt-0.5" />
    <p className="text-sm text-slate-700 dark:text-slate-300">{children}</p>
  </div>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <div className="flex gap-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 my-3">
    <CircleAlert size={15} className="text-blue-400 flex-shrink-0 mt-0.5" />
    <p className="text-sm text-slate-700 dark:text-slate-300">{children}</p>
  </div>
);

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div className="flex gap-3 mb-2">
    <span className="w-6 h-6 rounded-full bg-[#F97316] text-[#0F172A] text-xs font-black flex items-center justify-center flex-shrink-0 mt-0.5">{n}</span>
    <p className="text-sm text-slate-700 dark:text-slate-300">{children}</p>
  </div>
);

const Bullet = ({ children }: { children: React.ReactNode }) => (
  <div className="flex gap-2.5 mb-1.5">
    <CircleCheckBig size={14} className="text-[#F97316] flex-shrink-0 mt-0.5" />
    <p className="text-sm text-slate-700 dark:text-slate-300">{children}</p>
  </div>
);

const H3 = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-bold text-slate-900 dark:text-white mt-5 mb-2">{children}</h3>
);

const SECTIONS: Section[] = [
  {
    id: "jobs",
    icon: <Briefcase size={18} />,
    title: "Creating & Managing Jobs",
    color: "#F97316",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          A <strong className="text-slate-900 dark:text-white">Job</strong> is the central record for every loss event — it holds all photos, moisture readings, equipment, scope, and reports in one place.
        </p>

        <H3>Create a new job</H3>
        <Step n={1}>Click <strong className="text-slate-900 dark:text-white">New Job</strong> in the Jobs page (top-right button).</Step>
        <Step n={2}>Fill in the property address, loss type (water / fire / mold / storm), and loss category.</Step>
        <Step n={3}>Add owner contact info and insurance details if available — you can fill these in later.</Step>
        <Step n={4}>Click <strong className="text-slate-900 dark:text-white">Create Job</strong>. The job number is assigned automatically.</Step>

        <H3>Job statuses</H3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">Every job moves through 6 stages. Click any badge in the job header to jump to that status at any time.</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[
            { s: "New", c: "#64748B", d: "Job created, not yet active" },
            { s: "Active", c: "#F97316", d: "Work is in progress on site" },
            { s: "Drying", c: "#3B82F6", d: "Equipment placed, daily monitoring" },
            { s: "Final Inspection", c: "#EAB308", d: "Ready for final moisture check" },
            { s: "Invoicing", c: "#A855F7", d: "Scope complete, billing in progress" },
            { s: "Closed", c: "#22C55E", d: "Job complete and paid" },
          ].map(({ s, c, d }) => (
            <div key={s} className="flex items-start gap-2 bg-slate-50 dark:bg-[#0A1628] rounded-xl p-3">
              <span className="px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0 mt-0.5" style={{ backgroundColor: c + "22", color: c }}>{s}</span>
              <p className="text-xs text-slate-400 dark:text-slate-500">{d}</p>
            </div>
          ))}
        </div>

        <H3>Delete a job</H3>
        <Bullet>From the <strong className="text-slate-900 dark:text-white">Jobs list</strong>: hover a row → trash icon appears on the right.</Bullet>
        <Bullet>From the <strong className="text-slate-900 dark:text-white">Job detail</strong>: trash icon in the top-right of the header → confirm delete.</Bullet>
        <Note>Deleting a job permanently removes all associated records (photos, readings, equipment, scope). This cannot be undone.</Note>
      </div>
    ),
  },
  {
    id: "rooms",
    icon: <Map size={18} />,
    title: "Rooms",
    color: "#22C55E",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Rooms let you tag moisture readings, equipment, and scope line items to specific areas of the property. Add rooms first — everything else links to them.
        </p>

        <H3>Add a room</H3>
        <Step n={1}>Open a job and go to the <strong className="text-slate-900 dark:text-white">Overview</strong> tab.</Step>
        <Step n={2}>In the <strong className="text-slate-900 dark:text-white">Rooms</strong> card, click <strong className="text-slate-900 dark:text-white">+ Add Room</strong>.</Step>
        <Step n={3}>Enter the room name (e.g. "Master Bedroom", "Kitchen"), choose the floor level, and mark whether it's affected.</Step>
        <Step n={4}>Click <strong className="text-slate-900 dark:text-white">Add Room</strong>. It appears immediately in the list and in all room dropdowns.</Step>

        <Tip>Add all affected rooms before logging moisture or placing equipment — it makes the reports much cleaner.</Tip>

        <H3>Floor levels</H3>
        <Bullet>Basement, Main, Upper, Attic, Crawl Space, Garage</Bullet>

        <H3>Affected vs. non-affected</H3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Rooms marked <strong className="text-slate-900 dark:text-white">Affected</strong> show a red dot in the overview. Non-affected rooms (e.g. rooms used for equipment staging) show a green dot.
        </p>
      </div>
    ),
  },
  {
    id: "photos",
    icon: <Camera size={18} />,
    title: "Photos",
    color: "#A855F7",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Upload site photos directly from your phone or computer. Photos are organized by category and stored securely in the cloud.
        </p>

        <H3>Upload photos</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Photos</strong> tab.</Step>
        <Step n={2}>Select a <strong className="text-slate-900 dark:text-white">category</strong> from the dropdown (Before / During / After / Moisture Map / Equipment / General).</Step>
        <Step n={3}>Click <strong className="text-slate-900 dark:text-white">Upload Photos</strong> — select one or multiple files at once.</Step>
        <Step n={4}>Photos appear in the grid immediately, organized by category.</Step>

        <Tip>On iPhone, tap Upload Photos and choose "Photo Library" to pick existing photos, or "Take Photo" to snap a new one on the spot.</Tip>

        <H3>Photo categories</H3>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[
            { c: "Before", d: "Damage documentation on arrival" },
            { c: "During", d: "Work in progress" },
            { c: "After", d: "Completed work documentation" },
            { c: "Moisture Map", d: "Moisture meter readings on walls/floors" },
            { c: "Equipment", d: "Drying equipment placement" },
            { c: "General", d: "Any other site photos" },
          ].map(({ c, d }) => (
            <div key={c} className="bg-slate-50 dark:bg-[#0A1628] rounded-xl p-3">
              <p className="text-xs font-bold text-slate-900 dark:text-white mb-0.5">{c}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">{d}</p>
            </div>
          ))}
        </div>

        <H3>View & delete photos</H3>
        <Bullet>Tap any photo to open it full screen.</Bullet>
        <Bullet>Hover a photo thumbnail → red trash icon in top-right corner to delete.</Bullet>
        <Bullet>In the full-screen view → <strong className="text-slate-900 dark:text-white">Delete Photo</strong> button in the top-left corner.</Bullet>
        <Note>Deleted photos are permanently removed from storage and cannot be recovered.</Note>
      </div>
    ),
  },
  {
    id: "moisture",
    icon: <Droplets size={18} />,
    title: "Moisture Readings",
    color: "#3B82F6",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Log daily moisture meter readings to track the drying progress. The app automatically calculates dry/monitoring/wet status based on IICRC S500 standards.
        </p>

        <H3>Log a reading</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Moisture</strong> tab → <strong className="text-slate-900 dark:text-white">Add Reading</strong>.</Step>
        <Step n={2}>Select the <strong className="text-slate-900 dark:text-white">room</strong>, enter the <strong className="text-slate-900 dark:text-white">date</strong>, and describe the <strong className="text-slate-900 dark:text-white">location</strong> (e.g. "North wall, 12 inches up").</Step>
        <Step n={3}>Choose the <strong className="text-slate-900 dark:text-white">material type</strong> — this determines the dry standard.</Step>
        <Step n={4}>Enter the <strong className="text-slate-900 dark:text-white">moisture %</strong> from your meter and click <strong className="text-slate-900 dark:text-white">Save Reading</strong>.</Step>

        <Tip>Add rooms first (Overview tab) — moisture readings must be linked to a room for the drying report to work correctly.</Tip>

        <H3>Status colors</H3>
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-500/20 text-green-400">Dry</span>
            <p className="text-xs text-slate-500 dark:text-slate-400">At or below the IICRC dry standard for that material</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-500/20 text-yellow-400">Monitoring</span>
            <p className="text-xs text-slate-500 dark:text-slate-400">Elevated but trending down — continue drying</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400">Wet</span>
            <p className="text-xs text-slate-500 dark:text-slate-400">Still actively wet — equipment must remain</p>
          </div>
        </div>

        <H3>Delete a reading</H3>
        <Bullet>Hover any row → trash icon appears on the right side.</Bullet>
        <Note>Take readings every 24 hours while equipment is active. The Moisture/Drying Report shows all readings in chronological order for insurance documentation.</Note>
      </div>
    ),
  },
  {
    id: "equipment",
    icon: <Wrench size={18} />,
    title: "Equipment Logs",
    color: "#EAB308",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Track every piece of drying equipment placed on site — placement date, room, asset number, and removal date. This drives the equipment billing in your scope.
        </p>

        <H3>Log equipment placement</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Equipment</strong> tab → <strong className="text-slate-900 dark:text-white">Log Equipment</strong>.</Step>
        <Step n={2}>Select the <strong className="text-slate-900 dark:text-white">equipment type</strong> and enter the <strong className="text-slate-900 dark:text-white">name</strong> (e.g. "Dri-Eaz LGR 7000i").</Step>
        <Step n={3}>Add the <strong className="text-slate-900 dark:text-white">asset number</strong> from your inventory tag (optional but recommended for billing).</Step>
        <Step n={4}>Select the <strong className="text-slate-900 dark:text-white">room</strong> and confirm the <strong className="text-slate-900 dark:text-white">date placed</strong>.</Step>

        <H3>Equipment types</H3>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {["LGR Dehumidifier","Refrigerant Dehumidifier","Air Mover","HEPA Air Scrubber","HEPA Vacuum","Axial Fan","Other"].map((t) => (
            <p key={t} className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-[#0A1628] rounded-lg px-3 py-2">{t}</p>
          ))}
        </div>

        <H3>Remove equipment</H3>
        <Bullet><strong className="text-slate-900 dark:text-white">Remove</strong> button — stamps today's date as the removal date. Equipment stays in the log for billing. Days on site is calculated automatically.</Bullet>
        <Bullet><strong className="text-slate-900 dark:text-white">Trash icon</strong> (hover row) — completely deletes the log entry. Use only for mistakes.</Bullet>

        <Tip>Days on site is calculated automatically by the database. It appears in the Equipment Log PDF report for insurance claim documentation.</Tip>
      </div>
    ),
  },
  {
    id: "scope",
    icon: <DollarSign size={18} />,
    title: "Scope of Work",
    color: "#22C55E",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          The Scope tab is your line-item estimate and invoice builder. Add each billable item with quantity, unit, and unit price — totals are calculated automatically.
        </p>

        <H3>Add a line item</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Scope</strong> tab → <strong className="text-slate-900 dark:text-white">Add Line Item</strong>.</Step>
        <Step n={2}>Choose a <strong className="text-slate-900 dark:text-white">category</strong> (Demo / Dry / Equip / Labor / Material / Disposal / Other).</Step>
        <Step n={3}>Write a clear <strong className="text-slate-900 dark:text-white">description</strong> (e.g. "Remove and dispose of wet carpet — Living Room").</Step>
        <Step n={4}>Select the <strong className="text-slate-900 dark:text-white">room</strong> (optional), enter <strong className="text-slate-900 dark:text-white">quantity</strong>, <strong className="text-slate-900 dark:text-white">unit</strong>, and <strong className="text-slate-900 dark:text-white">unit price</strong>.</Step>
        <Step n={5}>The line total previews as you type. Click <strong className="text-slate-900 dark:text-white">Add Item</strong>.</Step>

        <H3>Units</H3>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { u: "EA", d: "Each (per piece)" },
            { u: "SF", d: "Square feet" },
            { u: "LF", d: "Linear feet" },
            { u: "HR", d: "Hours (labor)" },
            { u: "Day", d: "Day rate (equipment)" },
            { u: "LS", d: "Lump sum" },
            { u: "CY", d: "Cubic yards" },
            { u: "SY", d: "Square yards" },
            { u: "CF", d: "Cubic feet" },
          ].map(({ u, d }) => (
            <div key={u} className="bg-slate-50 dark:bg-[#0A1628] rounded-xl p-2">
              <p className="text-xs font-bold text-[#F97316]">{u}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">{d}</p>
            </div>
          ))}
        </div>

        <H3>Delete a line item</H3>
        <Bullet>Hover any row → trash icon appears on the right.</Bullet>

        <H3>Generate invoice</H3>
        <p className="text-sm text-slate-500 dark:text-slate-400">Go to the <strong className="text-slate-900 dark:text-white">Reports</strong> tab → <strong className="text-slate-900 dark:text-white">Scope of Work / Invoice</strong> → Generate PDF. The PDF includes overhead & profit markup, totals, and a signature block.</p>

        <Tip>The grand total shown in the Scope tab header and in the Reports tab is the raw subtotal before markup. The PDF report adds O&P on top.</Tip>
      </div>
    ),
  },
  {
    id: "reports",
    icon: <FileText size={18} />,
    title: "Reports",
    color: "#F97316",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Generate professional PDF reports ready to send to insurance adjusters, property owners, or keep for your records.
        </p>

        <H3>Available reports</H3>
        <div className="space-y-3 mb-4">
          {[
            {
              title: "Photo Report",
              desc: "All job photos organized by category (Before/During/After/Moisture Map/Equipment). Each photo shows caption and timestamp.",
              needs: "At least one uploaded photo.",
            },
            {
              title: "Moisture / Drying Report",
              desc: "Daily readings in chronological order with dry/wet/monitoring status, IICRC dry standard comparison, equipment summary, and a sign-off block for the property owner.",
              needs: "Moisture readings logged in the Moisture tab.",
            },
            {
              title: "Equipment Log",
              desc: "Full equipment placement log with asset numbers, room locations, placement/removal dates, days on site, and a summary by equipment type.",
              needs: "Equipment logged in the Equipment tab.",
            },
            {
              title: "Scope of Work / Invoice",
              desc: "Line items grouped by room with quantities, unit prices, subtotal, overhead & profit, and grand total. Includes assumptions, exclusions, and a signature authorization block.",
              needs: "Line items added in the Scope tab.",
            },
          ].map(({ title, desc, needs }) => (
            <div key={title} className="bg-slate-50 dark:bg-[#0A1628] rounded-2xl p-4">
              <p className="text-sm font-bold text-slate-900 dark:text-white mb-1">{title}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{desc}</p>
              <p className="text-xs text-[#F97316]">Requires: {needs}</p>
            </div>
          ))}
        </div>

        <H3>Generate a PDF</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Reports</strong> tab.</Step>
        <Step n={2}>Click <strong className="text-slate-900 dark:text-white">Generate PDF</strong> on the report you want.</Step>
        <Step n={3}>The PDF downloads automatically to your device.</Step>

        <Note>PDF generation runs in your browser — no data is sent to any third-party service. Large photo reports may take a few seconds to build.</Note>
      </div>
    ),
  },
  {
    id: "floorplan",
    icon: <Map size={18} />,
    title: "Floor Plans (Magicplan)",
    color: "#3B82F6",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          The app integrates with <strong className="text-slate-900 dark:text-white">Magicplan</strong> to link floor plans to jobs. Magicplan is a separate mobile app used to scan rooms and generate floor plan drawings.
        </p>

        <H3>Link an existing Magicplan project</H3>
        <Step n={1}>Open a job → <strong className="text-slate-900 dark:text-white">Floor Plan</strong> tab.</Step>
        <Step n={2}>Click the input field and paste your Magicplan project ID.</Step>
        <Step n={3}>Click <strong className="text-slate-900 dark:text-white">Save</strong>. The project is now linked.</Step>

        <H3>Create a new Magicplan project from this app</H3>
        <Step n={1}>Open the Floor Plan tab on a job with no linked project.</Step>
        <Step n={2}>Click <strong className="text-slate-900 dark:text-white">Create in Magicplan</strong>.</Step>
        <Step n={3}>A new project is created in your Magicplan account using the job address and details.</Step>

        <H3>Sync floor plans</H3>
        <Step n={1}>Once a project is linked, click <strong className="text-slate-900 dark:text-white">Sync Now</strong> to pull the latest exported floor plan.</Step>
        <Step n={2}>Floor plans also sync automatically when you export from the Magicplan app (via webhook).</Step>

        <Tip>You need a Magicplan API key configured in your app settings for this feature to work. Contact your administrator if the Create/Sync buttons show an error.</Tip>
      </div>
    ),
  },
  {
    id: "users",
    icon: <Users size={18} />,
    title: "User Management",
    color: "#A855F7",
    content: (
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Manage who has access to the app from the <strong className="text-slate-900 dark:text-white">Settings</strong> page. Only administrators can invite users or change roles.
        </p>

        <H3>Invite a new user</H3>
        <Step n={1}>Go to <strong className="text-slate-900 dark:text-white">Settings</strong> → <strong className="text-slate-900 dark:text-white">Invite User</strong>.</Step>
        <Step n={2}>Enter their name and email address.</Step>
        <Step n={3}>Select their role (see below).</Step>
        <Step n={4}>Click <strong className="text-slate-900 dark:text-white">Send Magic Link</strong>. They receive an email with a one-click login link — no password needed.</Step>

        <H3>Roles</H3>
        <div className="space-y-2 mb-4">
          {[
            { role: "Admin", c: "#F97316", d: "Full access — create/edit/delete jobs, manage users, access all settings. Typically for office staff and project managers." },
            { role: "Field Tech", c: "#3B82F6", d: "Can view and edit jobs, log moisture readings, place equipment, and upload photos. Cannot delete jobs or manage users." },
            { role: "Viewer", c: "#64748B", d: "Read-only access — can view jobs and reports but cannot make any changes. Good for insurance adjusters or supervisors." },
          ].map(({ role, c, d }) => (
            <div key={role} className="bg-slate-50 dark:bg-[#0A1628] rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: c + "22", color: c }}>{role}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{d}</p>
            </div>
          ))}
        </div>

        <H3>Change a user's role</H3>
        <Bullet>Go to <strong className="text-slate-900 dark:text-white">Settings</strong> → find the user → click their current role badge → select a new role.</Bullet>

        <H3>Access on iPhone</H3>
        <p className="text-sm text-slate-500 dark:text-slate-400">Open <strong className="text-slate-900 dark:text-white">Safari</strong> on your iPhone and navigate to the app URL. If you're on the same WiFi as the office computer, use the local network address. For permanent access from anywhere, the app can be deployed to a public URL — contact your administrator.</p>
      </div>
    ),
  },
];

export default function HelpPage() {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(["jobs"]));

  const toggle = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[#F97316]/15 border border-[#F97316]/30 flex items-center justify-center">
            <BookOpen size={20} className="text-[#F97316]" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white">Help & User Guide</h1>
            <p className="text-sm text-slate-400 dark:text-slate-500">Roybal Construction LLC — Field Operations App</p>
          </div>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-4 leading-relaxed">
          This guide covers every feature of the app. Click any section below to expand it.
          The app is designed to follow the full lifecycle of a restoration job — from first response through final invoice.
        </p>
      </div>

      {/* Quick reference */}
      <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-5 mb-6">
        <p className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Quick Reference — Job Workflow</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {[
            "1. Create Job",
            "2. Add Rooms",
            "3. Upload Before Photos",
            "4. Place Equipment",
            "5. Daily Moisture Readings",
            "6. Upload During/After Photos",
            "7. Remove Equipment",
            "8. Build Scope",
            "9. Generate Reports",
            "10. Close Job",
          ].map((step, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="bg-[#F97316]/15 text-[#F97316] px-2.5 py-1 rounded-lg font-medium">{step}</span>
              {i < 9 && <ChevronRight size={12} className="text-slate-300 dark:text-slate-700" />}
            </span>
          ))}
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-2">
        {SECTIONS.map((section) => {
          const isOpen = openSections.has(section.id);
          return (
            <div
              key={section.id}
              className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl overflow-hidden"
            >
              <button
                onClick={() => toggle(section.id)}
                className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-[#1E293B]/30 transition-colors"
              >
                <span
                  className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: section.color + "22", color: section.color }}
                >
                  {section.icon}
                </span>
                <span className="font-bold text-slate-900 dark:text-white flex-1">{section.title}</span>
                {isOpen
                  ? <ChevronDown size={18} className="text-slate-400 dark:text-slate-500" />
                  : <ChevronRight size={18} className="text-slate-400 dark:text-slate-500" />
                }
              </button>

              {isOpen && (
                <div className="px-5 pb-5 border-t border-slate-200 dark:border-[#1E293B]">
                  <div className="pt-4">{section.content}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-8 text-center">
        <p className="text-xs text-slate-400 dark:text-slate-600">Roybal Construction LLC — Field Operations App</p>
        <p className="text-xs text-slate-300 dark:text-slate-700 mt-1">For technical support, contact your administrator.</p>
      </div>
    </div>
  );
}
