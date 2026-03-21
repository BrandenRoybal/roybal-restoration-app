/**
 * QuickBooks Time OAuth Callback
 * Intuit redirects here after the user authorizes the app.
 * We exchange the authorization code for tokens via the edge function.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { CheckCircle, XCircle, Loader } from "lucide-react";

export default function QBCallbackPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Connecting to QuickBooks Time…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const realmId = params.get("realmId");
    const errorParam = params.get("error");

    if (errorParam) {
      setStatus("error");
      setMessage(`Authorization denied: ${errorParam}`);
      return;
    }

    if (!code || !realmId) {
      setStatus("error");
      setMessage("Missing authorization code or company ID in redirect URL.");
      return;
    }

    const exchange = async () => {
      try {
        // Get userId directly from the Supabase session — more reliable than the
        // auth store which may not have loaded yet (especially on Safari after a
        // cross-origin redirect clears in-memory state).
        const { data: { user } } = await supabase.auth.getUser();

        const { data, error } = await supabase.functions.invoke("qb-time-proxy", {
          body: {
            action: "exchangeCode",
            code,
            realmId,
            userId: user?.id ?? null,
          },
        });

        if (error) throw new Error(error.message);
        if (!data?.ok) throw new Error(data?.error ?? "Token exchange failed");

        // Clean up the state token now that the exchange succeeded
        localStorage.removeItem("qb_oauth_state");

        setStatus("success");
        setMessage("QuickBooks Time connected successfully!");

        // Auto-sync job codes after connecting
        await supabase.functions.invoke("qb-time-proxy", {
          body: { action: "syncJobcodes" },
        });

        setTimeout(() => navigate("/settings"), 2000);
      } catch (e) {
        setStatus("error");
        setMessage(e instanceof Error ? e.message : "Connection failed");
      }
    };

    exchange();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F172A]">
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-10 max-w-md w-full text-center shadow-2xl">
        {status === "loading" && (
          <>
            <Loader size={48} className="mx-auto mb-4 text-[#F97316] animate-spin" />
            <h2 className="text-xl font-bold text-white mb-2">Connecting…</h2>
            <p className="text-slate-400 text-sm">{message}</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle size={48} className="mx-auto mb-4 text-green-400" />
            <h2 className="text-xl font-bold text-white mb-2">Connected!</h2>
            <p className="text-slate-400 text-sm">{message}</p>
            <p className="text-slate-500 text-xs mt-3">Redirecting to Settings…</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle size={48} className="mx-auto mb-4 text-red-400" />
            <h2 className="text-xl font-bold text-white mb-2">Connection Failed</h2>
            <p className="text-slate-400 text-sm">{message}</p>
            <button
              onClick={() => navigate("/settings")}
              className="mt-5 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-6 h-10 rounded-xl transition-colors text-sm"
            >
              Back to Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
