/**
 * Settings page — manage users and company info.
 */

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "../store/auth";
import type { Profile } from "@roybal/shared";
import { Users, Building2, ShieldCheck } from "lucide-react";

const ROLE_LABELS = { admin: "Administrator", tech: "Field Technician", viewer: "Viewer" };
const ROLE_COLORS = { admin: "#F97316", tech: "#3B82F6", viewer: "#64748B" };

export default function SettingsPage() {
  const { profile: myProfile } = useAuthStore();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (myProfile?.role !== "admin") { setLoading(false); return; }
    supabase.from("profiles").select("*").order("full_name").then(({ data }) => {
      if (data) setUsers(data as Profile[]);
      setLoading(false);
    });
  }, [myProfile]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>

      {/* Company Info */}
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={18} className="text-[#F97316]" />
          <h2 className="text-base font-bold text-white">Company</h2>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <InfoPair label="Company" value="Roybal Construction, LLC" />
          <InfoPair label="DBA" value="Roybal Restoration" />
          <InfoPair label="Location" value="Fairbanks / North Pole, AK" />
          <InfoPair label="Services" value="Water, Fire, Mold, Smoke" />
        </div>
      </div>

      {/* Users */}
      {myProfile?.role === "admin" && (
        <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Users size={18} className="text-[#F97316]" />
            <h2 className="text-base font-bold text-white">Users</h2>
          </div>
          {loading ? (
            <p className="text-slate-500 text-sm">Loading…</p>
          ) : (
            <div className="space-y-3">
              {users.map((u) => (
                <div key={u.id} className="flex items-center gap-3 bg-[#0F172A] rounded-xl p-3 border border-[#1E293B]">
                  <div className="w-9 h-9 rounded-full bg-[#F97316] flex items-center justify-center flex-shrink-0">
                    <span className="text-white font-bold text-sm">{(u.full_name[0] ?? "?").toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-200">{u.full_name}</p>
                    {u.phone && <p className="text-xs text-slate-500">{u.phone}</p>}
                  </div>
                  <span
                    className="px-2.5 py-1 rounded-full text-xs font-bold"
                    style={{
                      backgroundColor: (ROLE_COLORS[u.role] ?? "#64748B") + "22",
                      color: ROLE_COLORS[u.role] ?? "#64748B",
                    }}
                  >
                    {ROLE_LABELS[u.role]}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-600 mt-4">
            To add or remove users, use the Supabase Auth dashboard or invite via your admin email.
          </p>
        </div>
      )}

      {/* RLS Note */}
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={18} className="text-[#22C55E]" />
          <h2 className="text-base font-bold text-white">Security</h2>
        </div>
        <p className="text-sm text-slate-400 leading-relaxed">
          Row Level Security is enforced on all tables. Field technicians can only view and edit
          jobs they are assigned to. Admins have full access. Service role keys are never exposed
          to the frontend.
        </p>
      </div>
    </div>
  );
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-600 mb-0.5">{label}</p>
      <p className="text-sm text-slate-300 font-medium">{value}</p>
    </div>
  );
}
