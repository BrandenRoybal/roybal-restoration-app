/* ============================================================
   Roybal Restoration — AI narrative / scope generator
   Vercel serverless function. Holds the Anthropic API key
   server-side and only answers signed-in crew (verified via
   Supabase). Called by the office admin.
   ============================================================ */
import Anthropic from "@anthropic-ai/sdk";

const ALLOW_ORIGINS = [
  "https://brandenroybal.github.io",
  "http://localhost:4190",
  "http://localhost:4173",
];

function cors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
}

/* Only allow signed-in crew: verify the Supabase access token. */
async function verifyUser(req) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) return true;                 // verification disabled if unset
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: auth } });
    return r.ok;
  } catch { return false; }
}

const SYSTEMS = {
  narrative:
    "You are an IICRC-certified water-damage restoration estimator at Roybal Construction, LLC, writing the mitigation/loss narrative for an insurance carrier's claim file. " +
    "Use only the facts provided — never invent measurements, dates, or equipment. Write in clear, professional, third-person prose (no markdown headers, no bullet lists unless natural). " +
    "Cover: cause/category/class of loss, affected areas and materials, the mitigation performed (extraction, antimicrobial, controlled demolition as warranted), drying equipment deployed and the psychrometric/monitoring approach per IICRC S500, and the dry-standard verification. " +
    "Keep it factual and concise (3–6 short paragraphs). If a detail is missing, omit it rather than guessing.",
  scope:
    "You are an IICRC S500 restoration estimator at Roybal Construction, LLC producing a clear, itemized scope of work for the water mitigation portion of a loss. " +
    "Use only the facts provided. Output a numbered scope-of-work list grouped by phase (Emergency/Extraction, Demolition/Removal, Antimicrobial, Drying/Equipment, Monitoring, Final/Cleaning). " +
    "Each line: a concise action and the affected area/material. Do not include prices. Keep it practical and tied to what the job data supports.",
};

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    if (!(await verifyUser(req))) return res.status(401).json({ error: "Sign in required" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const kind = body.kind === "scope" ? "scope" : "narrative";
    const summary = String(body.summary || "").slice(0, 12000);
    if (!summary.trim()) return res.status(400).json({ error: "No job details provided" });

    const client = new Anthropic();   // reads ANTHROPIC_API_KEY from env
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system: SYSTEMS[kind],
      messages: [{
        role: "user",
        content: `Job details:\n\n${summary}\n\nWrite the ${kind === "scope" ? "scope of work" : "mitigation narrative"} now.`,
      }],
    });
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
