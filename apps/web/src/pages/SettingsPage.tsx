/**
 * Settings page — manage users, roles, and company info.
 */

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "../store/auth";
import type { Profile } from "@roybal/shared";
import { Users, Building2, ShieldCheck, UserPlus, Check, X } from "lucide-react";

type Role = "admin" | "tech" | "viewer";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  tech: "Field Technician",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<Role, string> = {
  admin: "#F97316",
  tech: "#3B82F6",
  viewer: "#64748B",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access — manage jobs, users, and settings",
  tech: "Field access — view and update assigned jobs",
  viewer: "Read-only — view jobs and reports",
};


export default function SettingsPage() {
  const { profile: myProfile } = useAuthStore();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("tech");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (myProfile?.role !== "admin") { setLoading(false); return; }
    supabase.from("profiles").select("*").order("full_name").then(({ data }) => {
      if (data) setUsers(data as Profile[]);
      setLoading(false);
    });
  }, [myProfile]);

  const updateRole = async (userId: string, newRole: Role) => {
    setSavingRole(userId);
    const { data } = await supabase
      .from("profiles")
      .update({ role: newRole })
      .eq("id", userId)
      .select()
      .single();
    if (data) {
      setUsers((prev) => prev.map((u) => (u.id === userId ? (data as Profile) : u)));
    }
    setEditingRole(null);
    setSavingRole(null);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteLoading(true);
    setInviteResult(null);

    // Use Supabase Auth to invite by email
    const { error } = await supabase.auth.signInWithOtp({
      email: inviteEmail.trim(),
      options: {
        shouldCreateUser: true,
        data: { full_name: inviteName.trim(), role: inviteRole },
      },
    });

    if (error) {
      setInviteResult({ ok: false, msg: error.message });
    } else {
      setInviteResult({ ok: true, msg: `Magic link sent to ${inviteEmail.trim()}. They can sign in to get started.` });
      setInviteEmail("");
      setInviteName("");
      setInviteRole("tech");
    }
    setInviteLoading(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-6">Settings</h1>

      {/* Company Info */}
      <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={18} className="text-[#F97316]" />
          <h2 className="text-base font-bold text-slate-900 dark:text-white">Company</h2>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <InfoPair label="Company" value="Roybal Construction, LLC" />
          <InfoPair label="Location" value="Fairbanks / North Pole, AK" />
          <InfoPair label="Services" value="Water, Fire, Mold, Smoke" />
        </div>
      </div>

      {/* Users — admin only */}
      {myProfile?.role === "admin" && (
        <>
          {/* Invite new user */}
          <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <UserPlus size={18} className="text-[#F97316]" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">Invite User</h2>
            </div>

            <form onSubmit={handleInvite} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 tracking-wide">Full Name</label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="John Smith"
                    className="w-full bg-slate-50 dark:bg-[#211B17] border border-slate-200 dark:border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-[#F97316] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 tracking-wide">Email *</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="tech@roybalconstruction.com"
                    required
                    className="w-full bg-slate-50 dark:bg-[#211B17] border border-slate-200 dark:border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-[#F97316] transition-colors"
                  />
                </div>
              </div>

              {/* Role selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2 tracking-wide">Access Level</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setInviteRole(r)}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        inviteRole === r
                          ? "border-[#F97316] bg-[#F97316]/10"
                          : "border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#211B17] hover:border-slate-300 dark:hover:border-[#4A4440]"
                      }`}
                    >
                      <p className="text-sm font-bold" style={{ color: ROLE_COLORS[r] }}>{ROLE_LABELS[r]}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{ROLE_DESCRIPTIONS[r]}</p>
                    </button>
                  ))}
                </div>
              </div>

              {inviteResult && (
                <div className={`flex items-center gap-2 p-3 rounded-xl text-sm ${
                  inviteResult.ok
                    ? "bg-green-500/10 border border-green-500/30 text-green-400"
                    : "bg-red-500/10 border border-red-500/30 text-red-400"
                }`}>
                  {inviteResult.ok ? <Check size={15} /> : <X size={15} />}
                  {inviteResult.msg}
                </div>
              )}

              <button
                type="submit"
                disabled={inviteLoading}
                className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] disabled:opacity-60 text-[#0F172A] font-bold px-5 h-10 rounded-xl transition-colors"
              >
                {inviteLoading ? (
                  <div className="w-4 h-4 border-2 border-[#0F172A]/30 border-t-[#0F172A] rounded-full animate-spin" />
                ) : (
                  <UserPlus size={15} />
                )}
                Send Magic Link
              </button>
            </form>
          </div>

          {/* Existing users */}
          <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Users size={18} className="text-[#F97316]" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">Users</h2>
              <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">{users.length} total</span>
            </div>
            {loading ? (
              <p className="text-slate-400 dark:text-slate-500 text-sm">Loading…</p>
            ) : users.length === 0 ? (
              <p className="text-slate-400 dark:text-slate-500 text-sm">No users yet.</p>
            ) : (
              <div className="space-y-2">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 bg-slate-50 dark:bg-[#211B17] rounded-xl p-3 border border-slate-200 dark:border-[#1E293B]">
                    <div className="w-9 h-9 rounded-full bg-[#F97316] flex items-center justify-center flex-shrink-0">
                      <span className="text-[#0F172A] font-bold text-sm">{(u.full_name[0] ?? "?").toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{u.full_name}</p>
                      {u.phone && <p className="text-xs text-slate-400 dark:text-slate-500">{u.phone}</p>}
                    </div>

                    {/* Role — editable */}
                    {editingRole === u.id ? (
                      <div className="flex items-center gap-1">
                        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                          <button
                            key={r}
                            onClick={() => updateRole(u.id, r)}
                            disabled={savingRole === u.id}
                            className="px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors disabled:opacity-60"
                            style={{
                              backgroundColor: ROLE_COLORS[r] + "22",
                              borderColor: ROLE_COLORS[r] + "55",
                              color: ROLE_COLORS[r],
                            }}
                          >
                            {ROLE_LABELS[r]}
                          </button>
                        ))}
                        <button
                          onClick={() => setEditingRole(null)}
                          className="ml-1 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingRole(u.id)}
                        className="px-2.5 py-1 rounded-full text-xs font-bold cursor-pointer hover:opacity-80 transition-opacity"
                        style={{
                          backgroundColor: (ROLE_COLORS[u.role as Role] ?? "#64748B") + "22",
                          color: ROLE_COLORS[u.role as Role] ?? "#64748B",
                        }}
                        title="Click to change role"
                      >
                        {ROLE_LABELS[u.role as Role] ?? u.role}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Security */}
      <div className="bg-white dark:bg-[#0A1628] border border-slate-200 dark:border-[#1E293B] rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={18} className="text-[#22C55E]" />
          <h2 className="text-base font-bold text-slate-900 dark:text-white">Security</h2>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
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
      <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm text-slate-700 dark:text-slate-300 font-medium">{value}</p>
    </div>
  );
}
