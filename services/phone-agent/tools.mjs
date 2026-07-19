/* ============================================================
   Roybal phone agent — tool executors (the narrow hands)
   ------------------------------------------------------------
   Definitions live in the shared registry (personas.ts); this
   file is what they DO. Everything runs under the machine JWT
   (RLS + restrictive deny policies), the caller's number is
   injected from the Twilio setup message (the model never picks
   whose record to read), and createLead / textOwner are rate-
   limited so a prompt-injecting caller is bounded to one junk
   lead and a couple of texts.
   ============================================================ */
import { rest, insertRow } from "./supa.mjs";
import { SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_CELL } from "./config.mjs";
import { accessToken } from "./supa.mjs";
// the board's scheduling engine is pure ESM (no DOM, no imports) and is
// SERVER-SHARED here — see the guard comment at the top of schedule.js
import { computeSchedule, crewDayLoad, addWorkDays, isWorkDay, DEFAULT_SETTINGS } from "../../apps/board/js/schedule.js";

/* per-caller daily limits (in-memory — one Fly machine, resets on deploy;
   the per-call caps below are the hard backstop) */
const callerDay = new Map(); // "<digits>|<YYYY-MM-DD>" -> { leads, texts }
function callerBudget(digits) {
  const key = `${digits}|${new Date().toISOString().slice(0, 10)}`;
  if (!callerDay.has(key)) callerDay.set(key, { leads: 0, texts: 0 });
  if (callerDay.size > 500) callerDay.delete(callerDay.keys().next().value);
  return callerDay.get(key);
}

const last10 = (p) => String(p || "").replace(/[^\d]/g, "").slice(-10);

/* board tables store the object in a {id, data, deleted} envelope */
async function boardRows(table, limit = 300) {
  const res = await rest(`${table}?select=id,data,deleted&limit=${limit}`, { method: "GET" });
  if (!res.ok) throw new Error(`${table} read failed (${res.status})`);
  return (await res.json())
    .filter((r) => r && !r.deleted && r.id !== "__settings__" && r.data)
    .map((r) => r.data);
}

async function boardSettings() {
  const res = await rest(`coordination_jobs?select=id,data&id=eq.__settings__`, { method: "GET" });
  if (!res.ok) return { ...DEFAULT_SETTINGS };
  const row = (await res.json())[0];
  return { ...DEFAULT_SETTINGS, ...((row && row.data) || {}) };
}

/* ---------- lookupCaller — caller-ID only, coarse result ---------- */
async function lookupCaller(session) {
  const digits = last10(session.from);
  if (digits.length !== 10) return { match: false };
  const res = await rest(`unified_jobs?select=id,owner_phone,status,loss_type&owner_phone=not.is.null&limit=500`, { method: "GET" });
  if (!res.ok) return { error: "lookup unavailable" };
  const hit = (await res.json()).find((j) => last10(j.owner_phone) === digits);
  if (!hit) return { match: false };
  const open = !["closed", "invoicing"].includes(String(hit.status || ""));
  return { match: true, coarse: `${open ? "open" : "past"} ${hit.loss_type || ""} job on file`.trim() };
}

/* ---------- availability — the real board load, kept coarse ---------- */
async function availability(input) {
  const days = Math.min(Math.max(Number(input.days) || 5, 1), 10);
  const [jobs, crew, settings] = await Promise.all([
    boardRows("coordination_jobs"), boardRows("crew_members", 100), boardSettings(),
  ]);
  const active = crew.filter((c) => c.active !== false);
  try { computeSchedule(jobs, settings); } catch { /* saved dates still work */ }
  const { load } = crewDayLoad(jobs, settings);
  const hpd = Math.max(1, Number(settings.hoursPerDay) || 10);
  const capacity = active.length * hpd;
  const out = [];
  let day = new Date().toISOString().slice(0, 10);
  for (let i = 0; out.length < days && i < days * 3; i++) {
    if (isWorkDay(day, settings)) {
      let booked = 0;
      for (const [, byDay] of load) booked += byDay.get(day) || 0;
      const pct = capacity ? Math.round((booked / capacity) * 100) : 0;
      out.push({ day, bookedPct: pct, feel: pct >= 90 ? "slammed" : pct >= 60 ? "busy" : "has room" });
    }
    day = addWorkDays(day, 1, settings);
  }
  return { crew: active.length, workdays: out, note: "load only — the owner confirms any actual slot" };
}

/* ---------- createLead — the AI-booked board lead ---------- */
async function createLead(input, session) {
  if (session.leadsCreated >= 1) return { error: "a lead for this call already exists" };
  const budget = callerBudget(last10(session.from));
  if (budget.leads >= 1) return { error: "a lead from this number was already taken today — the owner has it" };
  const name = String(input.name || "").slice(0, 80).trim();
  const phone = String(input.phone || session.from || "").slice(0, 25).trim();
  const address = String(input.address || "").slice(0, 160).trim();
  if (!name || !phone) return { error: "need at least a name and callback number" };
  const lossType = ["water", "fire", "mold", "remodel", "other"].includes(input.lossType) ? input.lossType : "other";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const lead = {
    id, stage: "lead", type: lossType === "remodel" ? "remodel" : "mitigation",
    title: `${name} — ${lossType}`, customer: name, phone, address,
    priority: input.urgency === "emergency" ? "high" : "normal",
    materials: "none", crewIds: [], deps: [], subtasks: [],
    scheduleMode: "auto", pinnedStart: "", durationDays: null,
    notes: `AI-booked from a phone call (${session.from || "unknown number"}).\n` +
      `${String(input.summary || "").slice(0, 500)}${input.urgency ? `\nUrgency: ${input.urgency}` : ""}`,
    aiBooked: true, rev: 1, createdAt: now, updatedAt: now,
  };
  await insertRow("coordination_jobs", { id, data: lead, deleted: false });
  session.leadsCreated++; budget.leads++;
  session.leadId = id;
  return { ok: true, leadId: id };
}

/* ---------- textOwner — company-number SMS, quiet-hours exempt ---------- */
async function textOwner(input, session) {
  if (!OWNER_CELL) return { error: "owner cell not configured" };
  if (session.textsSent >= 2) return { error: "already texted the owner twice this call" };
  const budget = callerBudget(last10(session.from));
  if (budget.texts >= 2) return { error: "owner already alerted about this number today" };
  const message = String(input.message || "").slice(0, 300).trim();
  if (!message) return { error: "empty message" };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "sendSms", to: OWNER_CELL, body: `📞 ${message}`,
      kind: "phoneOwner", captured_by: "phone-agent",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) return { error: String(data.error || `send failed (${res.status})`).slice(0, 140) };
  session.textsSent++; budget.texts++;
  return { ok: true };
}

/** Dispatcher. `session` carries {from, leadsCreated, textsSent, leadId,
    escalate} — server.mjs owns that state. escalate only marks the session;
    the WS layer ends the relay with the handoff after the turn finishes. */
export async function runPhoneTool(name, input, session) {
  try {
    switch (name) {
      case "lookupCaller": return await lookupCaller(session);
      case "availability": return await availability(input || {});
      case "createLead": return await createLead(input || {}, session);
      case "textOwner": return await textOwner(input || {}, session);
      case "escalate":
        session.escalate = String((input && input.reason) || "caller needs a human").slice(0, 140);
        return { ok: true, note: "transferring after you finish speaking" };
      default: return { error: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 140) };
  }
}
