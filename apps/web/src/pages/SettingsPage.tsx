/**
 * Settings page — manage users, roles, and company info.
 */

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "../store/auth";
import type { Profile } from "@roybal/shared";
import { Users, Building2, ShieldCheck, UserPlus, Check, X, Clock, RefreshCw, Unlink, ExternalLink } from "lucide-react";

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

// QB Time OAuth scope and authorization URL builder
const QB_SCOPE = "com.intuit.quickbooks.time";
const QB_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";

function buildQBAuthUrl(clientId: string, redirectUri: string) {
  const state = crypto.randomUUID();
  // Use localStorage instead of sessionStorage — Safari ITP clears sessionStorage
  // after cross-origin redirects (e.g. navigating to accounts.intuit.com and back).
  localStorage.setItem("qb_oauth_state", state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: QB_SCOPE,
    state,
  });
  return `${QB_AUTH_BASE}?${params}`;
}

export default function SettingsPage() {
  const { profile: myProfile } = useAuthStore();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);

  // QB Time state
  const [qbStatus, setQbStatus] = useState<{ connected: boolean; realmId?: string; updatedAt?: string } | null>(null);
  const [qbLoading, setQbLoading] = useState(true);
  const [qbSyncing, setQbSyncing] = useState(false);
  const [qbDisconnecting, setQbDisconnecting] = useState(false);
  const [qbError, setQbError] = useState("");

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

  // Load QB Time connection status
  useEffect(() => {
    supabase.functions.invoke("qb-time-proxy", { body: { action: "getStatus" } }).then(({ data }) => {
      if (data?.ok) setQbStatus(data.data);
      setQbLoading(false);
    }).catch(() => setQbLoading(false));
  }, []);

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const [qbCopied, setQbCopied] = useState(false);

  const connectQBTime = async () => {
    const clientId = import.meta.env.VITE_QB_TIME_CLIENT_ID as string;
    const redirectUri = `${window.location.origin}/qb-callback`;
    if (!clientId) {
      setQbError("VITE_QB_TIME_CLIENT_ID is not set in .env");
      return;
    }
    const authUrl = buildQBAuthUrl(clientId, redirectUri);
    if (isSafari) {
      // Safari blocks Intuit's OAuth login due to ITP/cookie restrictions.
      // Copy the auth URL to clipboard so the user can paste it into Chrome.
      try {
        await navigator.clipboard.writeText(authUrl);
        setQbCopied(true);
        setTimeout(() => setQbCopied(false), 5000);
      } catch {
        setQbError("Could not copy link. Please open this page in Chrome to connect.");
      }
    } else {
      window.location.href = authUrl;
    }
  };

  const syncQBJobcodes = async () => {
    setQbSyncing(true);
    setQbError("");
    const { data } = await supabase.functions.invoke("qb-time-proxy", { body: { action: "syncJobcodes" } });
    if (!data?.ok) setQbError(data?.error ?? "Sync failed");
    setQbSyncing(false);
  };

  const disconnectQBTime = async () => {
    if (!confirm("Disconnect QuickBooks Time? Time data will no longer sync.")) return;
    setQbDisconnecting(true);
    setQbError("");
    const { data } = await supabase.functions.invoke("qb-time-proxy", { body: { action: "disconnect" } });
    if (data?.ok) setQbStatus({ connected: false });
    else setQbError(data?.error ?? "Disconnect failed");
    setQbDisconnecting(false);
  };

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
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>

      {/* Company Info */}
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={18} className="text-[#F97316]" />
          <h2 className="text-base font-bold text-white">Company</h2>
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
          <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <UserPlus size={18} className="text-[#F97316]" />
              <h2 className="text-base font-bold text-white">Invite User</h2>
            </div>

            <form onSubmit={handleInvite} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wide">Full Name</label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="John Smith"
                    className="w-full bg-[#211B17] border border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[#F97316] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wide">Email *</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="tech@roybalconstruction.com"
                    required
                    className="w-full bg-[#211B17] border border-[#1E293B] rounded-xl px-4 h-10 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[#F97316] transition-colors"
                  />
                </div>
              </div>

              {/* Role selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2 tracking-wide">Access Level</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setInviteRole(r)}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        inviteRole === r
                          ? "border-[#F97316] bg-[#F97316]/10"
                          : "border-[#1E293B] bg-[#211B17] hover:border-[#4A4440]"
                      }`}
                    >
                      <p className="text-sm font-bold" style={{ color: ROLE_COLORS[r] }}>{ROLE_LABELS[r]}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{ROLE_DESCRIPTIONS[r]}</p>
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
          <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Users size={18} className="text-[#F97316]" />
              <h2 className="text-base font-bold text-white">Users</h2>
              <span className="ml-auto text-xs text-slate-500">{users.length} total</span>
            </div>
            {loading ? (
              <p className="text-slate-500 text-sm">Loading…</p>
            ) : users.length === 0 ? (
              <p className="text-slate-500 text-sm">No users yet.</p>
            ) : (
              <div className="space-y-2">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 bg-[#211B17] rounded-xl p-3 border border-[#1E293B]">
                    <div className="w-9 h-9 rounded-full bg-[#F97316] flex items-center justify-center flex-shrink-0">
                      <span className="text-[#0F172A] font-bold text-sm">{(u.full_name[0] ?? "?").toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-200">{u.full_name}</p>
                      {u.phone && <p className="text-xs text-slate-500">{u.phone}</p>}
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
                          className="ml-1 text-slate-500 hover:text-slate-300"
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

      {/* QuickBooks Time Integration */}
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Clock size={18} className="text-[#F97316]" />
          <h2 className="text-base font-bold text-white">QuickBooks Time</h2>
          {qbStatus?.connected && (
            <span className="ml-auto text-xs font-bold px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">
              Connected
            </span>
          )}
        </div>

        {qbLoading ? (
          <p className="text-slate-500 text-sm">Loading…</p>
        ) : qbStatus?.connected ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <InfoPair label="Company ID" value={qbStatus.realmId ?? "—"} />
              <InfoPair label="Last Synced" value={qbStatus.updatedAt ? new Date(qbStatus.updatedAt).toLocaleDateString() : "—"} />
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Job codes are synced from QuickBooks Time. Open any job → <strong className="text-slate-400">Time</strong> tab to link a job code and view employee hours.
            </p>
            {qbError && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                <X size={14} /> {qbError}
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={syncQBJobcodes}
                disabled={qbSyncing}
                className="flex items-center gap-2 bg-[#0F172A] border border-[#1E293B] hover:border-[#F97316] text-slate-300 hover:text-white px-4 h-9 rounded-xl text-sm font-semibold transition-colors disabled:opacity-60"
              >
                <RefreshCw size={14} className={qbSyncing ? "animate-spin" : ""} />
                {qbSyncing ? "Syncing…" : "Sync Job Codes"}
              </button>
              <a
                href="https://tsheets.intuit.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 bg-[#0F172A] border border-[#1E293B] hover:border-[#334155] text-slate-400 hover:text-white px-4 h-9 rounded-xl text-sm font-semibold transition-colors"
              >
                <ExternalLink size={14} /> Open QB Time
              </a>
              <button
                onClick={disconnectQBTime}
                disabled={qbDisconnecting}
                className="flex items-center gap-2 text-red-400 hover:text-red-300 px-4 h-9 rounded-xl text-sm font-semibold transition-colors ml-auto disabled:opacity-60"
              >
                <Unlink size={14} />
                {qbDisconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-400 leading-relaxed">
              Connect your QuickBooks Time account to track employee hours by job, see who's currently clocked in, and pull labor totals into your job reports.
            </p>
            {qbError && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                <X size={14} /> {qbError}
              </div>
            )}
            {qbCopied && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
                <Check size={14} />
                Link copied! Open Chrome, paste it in the address bar, and complete the login there.
              </div>
            )}
            <button
              onClick={connectQBTime}
              className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-5 h-10 rounded-xl transition-colors text-sm"
            >
              <Clock size={15} />
              {isSafari ? "Copy QuickBooks Link (paste in Chrome)" : "Connect QuickBooks Time"}
            </button>
            <p className="text-xs text-slate-600">
              {isSafari
                ? "Safari is not compatible with Intuit's login. Click to copy the link, then paste it into Chrome to connect."
                : "You'll be redirected to Intuit to authorize access. A paid QuickBooks Time subscription is required."}
            </p>
          </div>
        )}
      </div>

      {/* Security */}
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
      <p className="text-xs font-semibold text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm text-slate-300 font-medium">{value}</p>
    </div>
  );
}
