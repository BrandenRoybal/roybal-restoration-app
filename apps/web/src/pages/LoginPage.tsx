/**
 * Login page — email/password with Supabase Auth.
 */

import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const err = await signIn(email.trim(), password);
    setLoading(false);
    if (err) {
      setError(err);
    } else {
      navigate("/");
    }
  };

  return (
    <div className="min-h-screen bg-[#140D03] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-10">
          <img
            src="/logo.png"
            alt="Roybal Construction"
            className="h-24 w-auto object-contain mx-auto mb-4"
            onError={(e) => {
              const target = e.currentTarget;
              target.style.display = 'none';
              const fallback = document.getElementById('login-logo-fallback');
              if (fallback) fallback.style.display = 'flex';
            }}
          />
          <div id="login-logo-fallback" className="hidden flex-col items-center mb-4">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#C9A84C] mb-4">
              <span className="text-[#140D03] font-black text-2xl">RC</span>
            </div>
            <h1 className="text-3xl font-black text-white tracking-wider">ROYBAL</h1>
            <p className="text-[#C9A84C] text-xs font-bold tracking-[0.4em] mt-0.5">CONSTRUCTION LLC</p>
          </div>
          <div className="w-12 h-0.5 bg-[#C9A84C] mx-auto mt-3 rounded-full" />
          <p className="text-slate-400 text-sm mt-3">Admin Dashboard</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#2B1D09] rounded-2xl border border-[#4A3318] p-8 space-y-5"
        >
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-2 tracking-wide">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="branden@roybalconstruction.com"
              className="w-full bg-[#4A3318] border border-[#6B4A20] rounded-xl px-4 h-12 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#C9A84C] transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-2 tracking-wide">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full bg-[#4A3318] border border-[#6B4A20] rounded-xl px-4 h-12 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#C9A84C] transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#C9A84C] hover:bg-[#A8842A] disabled:opacity-60 text-[#140D03] font-bold h-12 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-[#140D03]/30 border-t-[#140D03] rounded-full animate-spin" />
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p className="text-center text-slate-600 text-xs mt-6">
          Contact your administrator to reset access.
        </p>
      </div>
    </div>
  );
}
