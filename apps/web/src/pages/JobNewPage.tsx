/**
 * Create new job page — full FNOL intake form.
 */

import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "../store/auth";
import type { LossType, LossCategory } from "@roybal/shared";
import { ChevronLeft, Save, Flame } from "lucide-react";

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

const LEAD_SOURCES = [
  "Insurance Referral",
  "Property Manager",
  "Direct Call",
  "Repeat Customer",
  "Other",
];

export default function JobNewPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const today = new Date().toISOString().split("T")[0] ?? "";

  const [form, setForm] = useState({
    // Section 1: Job Basics
    property_address: "",
    date_of_loss: today,
    date_received: today,
    cause_of_loss: "",
    is_emergency: false,
    lead_source: "",
    // Section 2: Owner
    owner_name: "",
    owner_phone: "",
    owner_email: "",
    // Section 3: Loss type
    loss_type: "" as LossType | "",
    loss_category: "" as LossCategory | "",
    // Section 4: Property Manager
    property_manager_name: "",
    property_manager_phone: "",
    property_manager_email: "",
    // Section 5: Insurance
    insurance_carrier: "",
    claim_number: "",
    policy_number: "",
    adjuster_name: "",
    adjuster_phone: "",
    adjuster_email: "",
    deductible_amount: "",
    billing_party: "",
    xactimate_file_number: "",
    // Section 6: Notes
    notes: "",
  });

  const set = (field: keyof typeof form, value: string | boolean) =>
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
        date_of_loss: form.date_of_loss || null,
        date_received: form.date_received || null,
        cause_of_loss: form.cause_of_loss || null,
        is_emergency: form.is_emergency,
        lead_source: form.lead_source || null,
        owner_name: form.owner_name || null,
        owner_phone: form.owner_phone || null,
        owner_email: form.owner_email || null,
        loss_type: form.loss_type || null,
        loss_category: form.loss_category || null,
        property_manager_name: form.property_manager_name || null,
        property_manager_phone: form.property_manager_phone || null,
        property_manager_email: form.property_manager_email || null,
        insurance_carrier: form.insurance_carrier || null,
        claim_number: form.claim_number || null,
        policy_number: form.policy_number || null,
        adjuster_name: form.adjuster_name || null,
        adjuster_phone: form.adjuster_phone || null,
        adjuster_email: form.adjuster_email || null,
        deductible_amount: form.deductible_amount ? Math.round(parseFloat(form.deductible_amount) * 100) : 0,
        billing_party: form.billing_party || null,
        xactimate_file_number: form.xactimate_file_number || null,
        notes: form.notes || null,
        created_by: user?.id,
        assigned_tech_ids: user?.id ? [user.id] : [],
        status: "lead",
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
        <button onClick={() => navigate(-1)} className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">
          <ChevronLeft size={22} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">New Job — FNOL Intake</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm">First Notice of Loss — create a new restoration job</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Section 1: Job Basics */}
        <FormSection title="Job Basics">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label>Property Address *</Label>
              <Input placeholder="123 Fairbanks Rd, North Pole, AK" value={form.property_address} onChange={(v) => set("property_address", v)} required />
            </div>
            <div>
              <Label>Date of Loss</Label>
              <Input type="date" value={form.date_of_loss} onChange={(v) => set("date_of_loss", v)} />
            </div>
            <div>
              <Label>Date Received</Label>
              <Input type="date" value={form.date_received} onChange={(v) => set("date_received", v)} />
            </div>
            <div className="md:col-span-2">
              <Label>Cause of Loss</Label>
              <Input placeholder="e.g. Burst pipe under kitchen sink, frozen supply line…" value={form.cause_of_loss} onChange={(v) => set("cause_of_loss", v)} />
            </div>
            <div>
              <Label>Lead Source</Label>
              <select
                value={form.lead_source}
                onChange={(e) => set("lead_source", e.target.value)}
                className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#F97316] transition-colors"
              >
                <option value="">Select source…</option>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3 pt-5">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <div
                  onClick={() => set("is_emergency", !form.is_emergency)}
                  className={`w-11 h-6 rounded-full transition-colors flex items-center ${form.is_emergency ? "bg-red-500" : "bg-slate-300 dark:bg-slate-600"}`}
                >
                  <div className={`w-4.5 h-4.5 rounded-full bg-white shadow transition-transform mx-0.5 ${form.is_emergency ? "translate-x-5" : "translate-x-0"}`} style={{ width: "18px", height: "18px" }} />
                </div>
                <Flame size={15} className={form.is_emergency ? "text-red-500" : "text-slate-400 dark:text-slate-500"} />
                <span className={`text-sm font-semibold ${form.is_emergency ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}>
                  Emergency Job
                </span>
              </label>
            </div>
          </div>
        </FormSection>

        {/* Section 2: Insured / Owner */}
        <FormSection title="Insured / Property Owner">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Owner Name</Label>
              <Input placeholder="John Smith" value={form.owner_name} onChange={(v) => set("owner_name", v)} />
            </div>
            <div>
              <Label>Owner Phone</Label>
              <Input placeholder="(907) 555-0100" value={form.owner_phone} onChange={(v) => set("owner_phone", v)} />
            </div>
            <div className="md:col-span-2">
              <Label>Owner Email</Label>
              <Input type="email" placeholder="owner@email.com" value={form.owner_email} onChange={(v) => set("owner_email", v)} />
            </div>
          </div>
        </FormSection>

        {/* Section 3: Loss Type & Category */}
        <FormSection title="Loss Type &amp; Category">
          <div className="flex gap-2 flex-wrap">
            {LOSS_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => set("loss_type", t.value)}
                className={`px-4 py-2 rounded-xl text-sm font-bold border transition-colors ${
                  form.loss_type === t.value
                    ? "bg-[#F97316]/15 border-[#F97316] text-[#F97316]"
                    : "bg-slate-50 dark:bg-[#0F172A] border-slate-200 dark:border-[#1E293B] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
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
                    : "bg-slate-50 dark:bg-[#0F172A] border-slate-200 dark:border-[#1E293B] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {c.label} — {c.desc}
              </button>
            ))}
          </div>
        </FormSection>

        {/* Section 4: Property Manager */}
        <FormSection title="Property Manager (if applicable)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>PM Name</Label>
              <Input placeholder="Jane Manager" value={form.property_manager_name} onChange={(v) => set("property_manager_name", v)} />
            </div>
            <div>
              <Label>PM Phone</Label>
              <Input placeholder="(907) 555-0300" value={form.property_manager_phone} onChange={(v) => set("property_manager_phone", v)} />
            </div>
            <div className="md:col-span-2">
              <Label>PM Email</Label>
              <Input type="email" placeholder="pm@management.com" value={form.property_manager_email} onChange={(v) => set("property_manager_email", v)} />
            </div>
          </div>
        </FormSection>

        {/* Section 5: Insurance */}
        <FormSection title="Insurance">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Insurance Carrier</Label>
              <Input placeholder="State Farm" value={form.insurance_carrier} onChange={(v) => set("insurance_carrier", v)} />
            </div>
            <div>
              <Label>Claim Number</Label>
              <Input placeholder="CLM-12345678" value={form.claim_number} onChange={(v) => set("claim_number", v)} />
            </div>
            <div>
              <Label>Policy Number</Label>
              <Input placeholder="POL-987654" value={form.policy_number} onChange={(v) => set("policy_number", v)} />
            </div>
            <div>
              <Label>Adjuster Name</Label>
              <Input placeholder="Jane Doe" value={form.adjuster_name} onChange={(v) => set("adjuster_name", v)} />
            </div>
            <div>
              <Label>Adjuster Phone</Label>
              <Input placeholder="(907) 555-0200" value={form.adjuster_phone} onChange={(v) => set("adjuster_phone", v)} />
            </div>
            <div>
              <Label>Adjuster Email</Label>
              <Input type="email" placeholder="adjuster@insurer.com" value={form.adjuster_email} onChange={(v) => set("adjuster_email", v)} />
            </div>
            <div>
              <Label>Deductible Amount ($)</Label>
              <Input type="number" min="0" step="0.01" placeholder="0.00" value={form.deductible_amount} onChange={(v) => set("deductible_amount", v)} />
            </div>
            <div>
              <Label>Billing Party</Label>
              <Input placeholder="Who receives the invoice (e.g. Carrier, Owner)" value={form.billing_party} onChange={(v) => set("billing_party", v)} />
            </div>
            <div className="md:col-span-2">
              <Label>Xactimate File Number (optional)</Label>
              <Input placeholder="XM-2024-XXXXX" value={form.xactimate_file_number} onChange={(v) => set("xactimate_file_number", v)} />
            </div>
          </div>
        </FormSection>

        {/* Section 6: Notes */}
        <FormSection title="Initial Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Initial observations, scope notes, emergency contacts, special access instructions…"
            rows={4}
            className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors resize-none"
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
    <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-6">
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4 pb-3 border-b border-slate-200 dark:border-[#1E293B]"
        dangerouslySetInnerHTML={{ __html: title }}
      />
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-slate-400 dark:text-slate-500 mb-1.5 tracking-wide">{children}</label>;
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  required,
  min,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  min?: string;
  step?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      min={min}
      step={step}
      className="w-full bg-white dark:bg-[#0F172A] border border-slate-300 dark:border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-[#F97316] transition-colors"
    />
  );
}
