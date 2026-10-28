/* ============================================================
   Roybal — Gmail client (the email lane)
   ------------------------------------------------------------
   Thin wrapper over the `gmail-proxy` Edge Function plus direct
   reads of email_messages (job-matched mail only — the privacy
   contract lives server-side in gmail-proxy/emailmatch.ts).
   The office connects Gmail once from the admin; every send is a
   human-confirmed chip. No secrets here.
   ============================================================ */
import { callFunction, isSignedIn, rest } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";

async function proxy(action, payload = {}) {
  if (!SYNC_ENABLED) throw new Error("Offline — email needs a connection");
  if (!isSignedIn()) throw new Error("Sign in first");
  const res = await callFunction("gmail-proxy", { action, ...payload });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `Email ${action} failed (${res.status})`);
  return body.data;
}

/* ---------- connection (admin panel) ---------- */
export function gmailStatus() { return proxy("getStatus"); }
export function gmailDisconnect() { return proxy("disconnect"); }
export function gmailExchangeCode(code, connectedBy) { return proxy("exchangeCode", { code, connectedBy }); }

/** Scan the inbox now (the cron also does this every 15 minutes). */
export function gmailPullInbox() { return proxy("pullInbox"); }

/**
 * Send an email from the connected account. ALWAYS reached through a
 * confirmed chip — never fire-and-forget. threadId/inReplyTo keep replies
 * in the original Gmail thread.
 */
export function gmailSend({ to, subject, body, jobId, threadId, inReplyTo }) {
  return proxy("sendEmail", { to, subject, body, jobId, threadId, inReplyTo });
}

/* ---------- job-matched mail (email_messages reads) ---------- */

/** Newest-first messages filed under one job. */
export async function fetchJobEmails(jobId, limit = 20) {
  if (!jobId) return [];
  const res = await rest(`email_messages?job_id=eq.${encodeURIComponent(jobId)}&order=received_at.desc&limit=${limit}` +
    `&select=id,gmail_id,thread_id,direction,from_addr,from_name,to_addr,subject,body_text,message_id_header,matched_by,received_at,read_by_office`, { method: "GET" });
  if (!res.ok) throw new Error("email read failed (" + res.status + ")");
  return res.json();
}

/** Every unread inbound message, newest first (for the dashboard + context). */
export async function fetchUnreadEmails(limit = 50) {
  const res = await rest(`email_messages?direction=eq.in&read_by_office=eq.false&order=received_at.desc&limit=${limit}` +
    `&select=id,thread_id,from_addr,from_name,subject,body_text,job_id,matched_by,received_at`, { method: "GET" });
  if (!res.ok) throw new Error("email read failed (" + res.status + ")");
  return res.json();
}

/** Mark one message handled. */
export async function markEmailRead(id) {
  const res = await rest(`email_messages?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ read_by_office: true }),
  });
  return res.ok;
}
