/**
 * Create new job page — web admin version.
 */

import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "../store/auth";
import type { LossType, LossCategory } from "@roybal/shared";
import { ChevronLeft, Save } from "lucide-react";

const LOSS_TYPES: { value: LossType; label: string }[] = [
  { value: "water", label: "Water" },
  { value: "fire", label: "Fire" },
  { value: "mold", label: "Mold" },
  { value: "smoke", label: "Smoke" },
  { value: "other", label: "Other" },
];

const LOSS_CATEGORIES: { value: LossCategory; label: string; desc: string }[] = [
  { value: "cat1", label: "Cat 1", desc: "Clean water" },
  { value: "cat2", label: "Cat 2", desc: "Grey water" },
  { value: "cat3", label: "Cat 3", desc: "Black water" },
];

export default function JobNewPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    property_address: "",
    owner_name: "",
    owner_phone: "",
    owner_email: "",
    date_of_loss: new Date().toISOString().split("T")[0] ?? "",
    loss_type: "" as LossType | "",
    loss_category: "" as LossCategory | "",
    insurance_carrier: "",
    claim_number: "",
    adjuster_name: "",
    adjuster_phone: "",
    adjuster_email: "",
    notes: "",
  });

  const set = (field: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [field]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.property_address.trim()) {
      setError("Property address is required.");
      return;
    }
    setLoading(true);
    setError("");

    const { data, error: dbError } = await supabase
      .from("jobs")
      .insert({
        property_address: form.property_address.trim(),
        owner_name: form.owner_name || null,
        owner_phone: form.owner_phone || null,
        owner_email: form.owner_email || null,
        date_of_loss: form.date_of_loss || null,
        loss_type: form.loss_type || null,
        loss_category: form.loss_category || null,
        insurance_carrier: form.insurance_carrier || null,
        claim_number: form.claim_number || null,
        adjuster_name: form.adjuster_name || null,
        adjuster_phone: form.adjuster_phone || null,
        adjuster_email: form.adjuster_email || null,
        notes: form.notes || null,
        created_by: user?.id,
        assigned_tech_ids: user?.id ? [user.id] : [],
        status: "new",
      })
      .select()
      .single();

    setLoading(false);
    if (dbError) { setError(dbError.message); return; }
    navigate(`/jobs/${data.id}`);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="text-slate-400 hover:text-slate-200 transition-colors">
          <ChevronLeft size={22} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">New Job</h1>
          <p className="text-slate-400 text-sm">Create a new restoration job</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Property Info */}
        <FormSection title="Property Information">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label>Property Address *</Label>
              <Input placeholder="123 Fairbanks Rd, North Pole, AK" value={form.property_address} onChange={(v) => set("property_address", v)} required />
            </div>
            <div>
              <Label>Owner Name</Label>
              <Input placeholder="John Smith" value={form.owner_name} onChange={(v) => set("owner_name", v)} />
            </div>
            <div>
              <Label>Date of Loss</Label>
              <Input type="date" value={form.date_of_loss} onChange={(v) => set("date_of_loss", v)} />
            </div>
            <div>
              <Label>Owner Phone</Label>
              <Input placeholder="(907) 555-0100" value={form.owner_phone} onChange={(v) => set("owner_phone", v)} />
            </div>
            <div>
              <Label>Owner Email</Label>
              <Input type="email" placeholder="owner@email.com" value={form.owner_email} onChange={(v) => set("owner_email", v)} />
            </div>
          </div>
        </FormSection>

        {/* Loss Type */}
        <FormSection title="Loss Type">
          <div className="flex gap-2 flex-wrap">
            {LOSS_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => set("loss_type", t.value)}
                className={`px-4 py-2 rounded-xl text-sm font-bold border transition-colors ${
                  form.loss_type === t.value
                    ? "bg-[#F97316]/15 border-[#F97316] text-[#F97316]"
                    : "bg-[#0F172A] border-[#1E293B] text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap mt-3">
            {LOSS_CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => set("loss_category", c.value)}
                className={`px-4 py-2 rounded-xl text-sm font-bold border transition-colors ${
                  form.loss_category === c.value
                    ? "bg-[#F97316]/15 border-[#F97316] text-[#F97316]"
                    : "bg-[#0F172A] border-[#1E293B] text-slate-400 hover:text-slate-200"
                }`}
              >
                {c.label} — {c.desc}
              </button>
            ))}
          </div>
        </FormSection>

        {/* Insurance */}
        <FormSection title="Insurance">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Carrier</Label>
              <Input placeholder="State Farm" value={form.insurance_carrier} onChange={(v) => set("insurance_carrier", v)} />
            </div>
            <div>
              <Label>Claim Number</Label>
              <Input placeholder="CLM-12345678" value={form.claim_number} onChange={(v) => set("claim_number", v)} />
            </div>
            <div>
              <Label>Adjuster Name</Label>
              <Input placeholder="Jane Doe" value={form.adjuster_name} onChange={(v) => set("adjuster_name", v)} />
            </div>
            <div>
              <Label>Adjuster Phone</Label>
              <Input placeholder="(907) 555-0200" value={form.adjuster_phone} onChange={(v) => set("adjuster_phone", v)} />
            </div>
            <div className="md:col-span-2">
              <Label>Adjuster Email</Label>
              <Input type="email" placeholder="adjuster@insurer.com" value={form.adjuster_email} onChange={(v) => set("adjuster_email", v)} />
            </div>
          </div>
        </FormSection>

        {/* Notes */}
        <FormSection title="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Initial observations, scope notes, emergency contacts…"
            rows={4}
            className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors resize-none"
          />
        </FormSection>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-60 text-[#0F172A] font-bold px-6 h-11 rounded-xl transition-colors"
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-[#0F172A]/30 border-t-[#0F172A] rounded-full animate-spin" />
            ) : (
              <Save size={16} />
            )}
            Create Job
          </button>
        </div>
      </form>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6">
      <h3 className="text-sm font-bold text-slate-300 mb-4 pb-3 border-b border-[#1E293B]">{title}</h3>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-slate-500 mb-1.5 tracking-wide">{children}</label>;
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors"
    />
  );
}
