/**
 * Job Detail page — full tabbed view with all modules.
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Job, Room, MoistureReading, EquipmentLog, LineItem, FloorPlan, Photo } from "@roybal/shared";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_ORDER,
  formatAlaskaDate,
  formatAlaskaDateTime,
  centsToDisplay,
  getMoistureStatus,
  EQUIPMENT_TYPE_LABELS,
} from "@roybal/shared";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import clsx from "clsx";

type Tab = "overview" | "photos" | "moisture" | "equipment" | "scope" | "floorplan" | "report";

const STATUS_COLORS: Record<string, string> = {
  new: "#64748B", active: "#F97316", drying: "#3B82F6",
  final_inspection: "#EAB308", invoicing: "#A855F7", closed: "#22C55E",
};

const MOISTURE_COLORS = { dry: "#22C55E", monitoring: "#EAB308", wet: "#EF4444" };

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [moisture, setMoisture] = useState<MoistureReading[]>([]);
  const [equipment, setEquipment] = useState<EquipmentLog[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

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
    ]).then(([j, r, m, e, l, p, fp]) => {
      if (!j.error && j.data) setJob(j.data as Job);
      if (!r.error) setRooms((r.data ?? []) as Room[]);
      if (!m.error) setMoisture((m.data ?? []) as MoistureReading[]);
      if (!e.error) setEquipment((e.data ?? []) as EquipmentLog[]);
      if (!l.error) setLineItems((l.data ?? []) as LineItem[]);
      if (!p.error) setPhotos((p.data ?? []) as Photo[]);
      if (!fp.error) setFloorPlans((fp.data ?? []) as FloorPlan[]);
      setLoading(false);
    });
  }, [id]);

  const advanceStatus = async () => {
    if (!job) return;
    const idx = JOB_STATUS_ORDER.indexOf(job.status);
    const next = JOB_STATUS_ORDER[idx + 1];
    if (!next) return;
    const { data } = await supabase.from("jobs").update({ status: next }).eq("id", job.id).select().single();
    if (data) setJob(data as Job);
  };

  const totalCents = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "photos", label: `Photos (${photos.length})` },
    { key: "moisture", label: `Moisture (${moisture.length})` },
    { key: "equipment", label: `Equipment (${equipment.length})` },
    { key: "scope", label: `Scope (${centsToDisplay(totalCents)})` },
    { key: "floorplan", label: "Floor Plan" },
    { key: "report", label: "Reports" },
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
      <div className="bg-[#0A1628] border-b border-[#1E293B] px-6 py-4">
        <div className="flex items-start gap-4 flex-wrap">
          <button onClick={() => navigate("/jobs")} className="text-slate-400 hover:text-slate-200 mt-0.5">
            <ChevronLeft size={22} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-mono text-slate-500">{job.job_number}</span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold"
                style={{ backgroundColor: (STATUS_COLORS[job.status] ?? "#64748B") + "22", color: STATUS_COLORS[job.status] ?? "#64748B" }}>
                {JOB_STATUS_LABELS[job.status]}
              </span>
              {job.status !== "closed" && (
                <button
                  onClick={advanceStatus}
                  className="flex items-center gap-1 text-xs font-bold text-[#F97316] hover:underline"
                >
                  Advance <ChevronRight size={12} />
                </button>
              )}
            </div>
            <h1 className="text-xl font-bold text-white mt-1 truncate">{job.property_address}</h1>
            <p className="text-sm text-slate-400">
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
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]"
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
              {rooms.length === 0 ? (
                <p className="text-slate-600 text-sm">No rooms added yet.</p>
              ) : (
                <div className="space-y-1">
                  {rooms.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-sm">
                      <span className={clsx("w-2 h-2 rounded-full", r.affected ? "bg-[#EF4444]" : "bg-[#22C55E]")} />
                      <span className="text-slate-200">{r.name}</span>
                      <span className="text-slate-500 text-xs ml-auto">{r.floor_level}</span>
                    </div>
                  ))}
                </div>
              )}
            </InfoCard>
            <InfoCard title="Meta">
              <InfoPair label="Created" value={formatAlaskaDateTime(job.created_at)} />
              <InfoPair label="Updated" value={formatAlaskaDateTime(job.updated_at)} />
              <InfoPair label="Job #" value={job.job_number} />
            </InfoCard>
          </div>
        )}

        {activeTab === "moisture" && (
          <div className="max-w-5xl">
            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Date", "Room", "Location", "Material", "Reading", "Status"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moisture.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-600">No moisture readings yet.</td></tr>
                    ) : moisture.map((m) => {
                      const status = getMoistureStatus(m.moisture_pct, m.material_type);
                      return (
                        <tr key={m.id} className="border-b border-[#1E293B]/50">
                          <td className="px-4 py-3 text-slate-400 text-xs">{formatAlaskaDate(m.reading_date)}</td>
                          <td className="px-4 py-3 text-slate-300">{roomMap[m.room_id] ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-300">{m.location_description}</td>
                          <td className="px-4 py-3 text-slate-400">{m.material_type}</td>
                          <td className="px-4 py-3 font-mono font-bold" style={{ color: MOISTURE_COLORS[status] }}>{m.moisture_pct}%</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: MOISTURE_COLORS[status] + "22", color: MOISTURE_COLORS[status] }}>
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </span>
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
            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Equipment", "Asset #", "Room", "Placed", "Removed", "Days"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {equipment.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-600">No equipment logged.</td></tr>
                    ) : equipment.map((e) => (
                      <tr key={e.id} className="border-b border-[#1E293B]/50">
                        <td className="px-4 py-3">
                          <p className="text-slate-200 font-semibold">{e.equipment_name}</p>
                          <p className="text-slate-500 text-xs">{EQUIPMENT_TYPE_LABELS[e.equipment_type]}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-400 font-mono text-xs">{e.asset_number ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-400">{e.room_id ? (roomMap[e.room_id] ?? "—") : "—"}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{formatAlaskaDate(e.date_placed)}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{e.date_removed ? formatAlaskaDate(e.date_removed) : <span className="text-[#F97316]">Active</span>}</td>
                        <td className="px-4 py-3 font-bold text-slate-200">{e.days_on_site}</td>
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
            <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1E293B]">
                      {["Category", "Description", "Room", "Qty", "Unit", "Unit Price", "Total"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-600">No line items.</td></tr>
                    ) : lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-[#1E293B]/50">
                        <td className="px-4 py-3 text-xs text-slate-500 uppercase">{li.category}</td>
                        <td className="px-4 py-3 text-slate-200">{li.description}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{li.room_id ? (roomMap[li.room_id] ?? "—") : "All"}</td>
                        <td className="px-4 py-3 text-slate-300">{li.quantity}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">{li.unit}</td>
                        <td className="px-4 py-3 text-slate-300 font-mono">{centsToDisplay(li.unit_price)}</td>
                        <td className="px-4 py-3 font-bold text-slate-200 font-mono">{centsToDisplay(li.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {lineItems.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-[#1E293B] bg-[#0F172A]">
                        <td colSpan={6} className="px-4 py-3 text-right font-bold text-slate-300">Grand Total</td>
                        <td className="px-4 py-3 font-black text-white font-mono text-base">{centsToDisplay(totalCents)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "floorplan" && (
          <div className="max-w-4xl">
            {floorPlans.length === 0 ? (
              <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-12 text-center">
                <p className="text-slate-500 mb-2">No floor plans synced yet.</p>
                <p className="text-slate-600 text-sm">Create a project in Magicplan and link it to this job to see floor plans here.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {floorPlans.map((fp) => (
                  <div key={fp.id} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4 flex items-center gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-200">Version {fp.version}</p>
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
            {photos.length === 0 ? (
              <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-12 text-center">
                <p className="text-slate-500">No photos uploaded yet. Use the mobile app to capture photos on-site.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {photos.map((p) => (
                  <div key={p.id} className="relative bg-[#0A1628] border border-[#1E293B] rounded-xl overflow-hidden aspect-square">
                    <div className="w-full h-full bg-[#1E293B] flex items-center justify-center text-slate-600 text-xs">{p.category}</div>
                    {p.caption && (
                      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1">
                        <p className="text-white text-xs truncate">{p.caption}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "report" && (
          <div className="max-w-2xl">
            <p className="text-slate-400 text-sm mb-6">Generate and download PDF reports for this job.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { title: "Photo Report", desc: "Photos organized by room and category" },
                { title: "Moisture / Drying Report", desc: "Daily readings + equipment summary" },
                { title: "Equipment Log", desc: "Placement dates, locations, days on site" },
                { title: "Scope of Work / Invoice", desc: "Line items, totals, signature block" },
              ].map((r) => (
                <div key={r.title} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
                  <p className="font-bold text-slate-200 mb-1">{r.title}</p>
                  <p className="text-xs text-slate-500 mb-4">{r.desc}</p>
                  <button className="w-full bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] font-bold text-sm h-9 rounded-xl hover:bg-[#F97316]/20 transition-colors">
                    Generate PDF
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-[#1E293B]">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-slate-600">{label}</span>
      <span className="text-sm text-slate-200 font-medium break-words">{value}</span>
    </div>
  );
}
