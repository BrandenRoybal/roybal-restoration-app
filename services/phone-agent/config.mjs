/* ============================================================
   Roybal phone agent — configuration (all via env / Fly secrets)
   ------------------------------------------------------------
   No secrets in the repo, ever. The machine user's credentials
   exist ONLY as Fly secrets; everything the agent touches in
   Supabase is RLS-scoped under that user's JWT (JWT-as-truth:
   the whitelist below keys off MACHINE_EMAIL, never a client
   claim), with restrictive deny policies on top (migration 204).
   ============================================================ */
const env = (k, dflt = "") => process.env[k] ?? dflt;
const num = (k, dflt) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : dflt;
};

export const SUPABASE_URL = env("SUPABASE_URL");
export const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
export const MACHINE_EMAIL = env("MACHINE_EMAIL", "phone-agent@roybalconstruction.com");
export const MACHINE_PASSWORD = env("MACHINE_PASSWORD");
export const LLM_API_KEY = env("LLM_API_KEY");
export const PHONE_MODEL = env("PHONE_MODEL", "claude-sonnet-4-6");
export const RELAY_TOKEN = env("PHONE_RELAY_TOKEN");
export const OWNER_CELL = env("OWNER_CELL");
export const OWNER_NAME = env("OWNER_NAME", "Branden");
export const PORT = num("PORT", 8080);

/* Who receives the receptionist's owner texts (kind `phoneOwner`).
   OWNER_CELL stays a SINGLE number on purpose — elsewhere in the system it
   means "the owner" with authority attached: roybal-voice DIALS it, and
   roybal-notify gates approve-by-text on it. ALERT_CELLS is an optional
   comma-separated list of extra people (a project manager who should see new
   leads); it is read ONLY here, so being on it grants visibility and nothing
   else. Malformed entries are dropped rather than silently blanking the lane,
   and the owner is always first. */
const last10Digits = (p) => String(p || "").replace(/[^\d]/g, "").slice(-10);
export const ALERT_CELLS = (() => {
  const seen = new Set();
  return [OWNER_CELL, ...env("ALERT_CELLS").split(",")]
    .map((s) => s.trim())
    .filter((s) => {
      const d = last10Digits(s);
      if (d.length !== 10 || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
})();

/* Cost governance — the phone lane rides the SAME monthly AI cap as every
   other AI feature, plus its own minutes cap. */
export const SPEND_CAP_USD = num("SPEND_CAP_USD", 50);
export const VOICE_MINUTES_CAP = num("VOICE_MINUTES_CAP", 300);
export const VOICE_PRICE_PER_MIN = num("VOICE_PRICE_PER_MIN", 0.12); // Twilio voice+relay all-in estimate

/* $/1M tokens — same table as roybal-ai-office. */
const LLM_PRICES = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};
export const priceFor = (model) => LLM_PRICES[model] ?? { in: 3.0, out: 15.0 };
