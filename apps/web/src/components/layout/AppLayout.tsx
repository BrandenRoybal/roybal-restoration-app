/**
 * Main app shell — sidebar nav + content area.
 */

import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Briefcase,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAuthStore } from "../../store/auth";
import clsx from "clsx";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/jobs", label: "Jobs", icon: Briefcase },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const { profile, signOut } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="flex h-screen bg-[#0F172A] overflow-hidden">
      {/* Sidebar */}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-50 flex flex-col w-60 bg-[#0A1628] border-r border-[#1E293B] transition-transform duration-200",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          "lg:relative lg:translate-x-0"
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-[#1E293B]">
          <div className="w-8 h-8 rounded bg-[#F97316] flex items-center justify-center flex-shrink-0">
            <span className="text-white font-black text-sm">RR</span>
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">Roybal</p>
            <p className="text-[#F97316] text-xs font-semibold leading-tight tracking-widest">
              RESTORATION
            </p>
          </div>
          <button
            className="ml-auto lg:hidden text-slate-400"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors",
                  isActive
                    ? "bg-[#F97316]/15 text-[#F97316]"
                    : "text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]"
                )
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Profile + Sign out */}
        <div className="border-t border-[#1E293B] p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-[#F97316] flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-sm">
                {(profile?.full_name ?? "?")[0]?.toUpperCase() ?? "?"}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-200 truncate">
                {profile?.full_name ?? "Loading…"}
              </p>
              <p className="text-xs text-slate-500 capitalize">{profile?.role ?? ""}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 w-full text-sm text-slate-400 hover:text-red-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-red-500/10"
          >
            <LogOut size={16} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile topbar */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-[#0A1628] border-b border-[#1E293B]">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-slate-400 hover:text-slate-200"
          >
            <Menu size={22} />
          </button>
          <span className="text-white font-bold">Roybal Restoration</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
