/**
 * Gmail Proxy — Supabase Edge Function (THE EMAIL LANE)
 *
 * Connects the office assistant to the owner's Gmail
 * (branden@roybalconstruction.com) the same way qbo-proxy connects
 * QuickBooks: OAuth once from the admin, tokens in gmail_tokens
 * (service-role only), everything else flows through here.
 *
 * PRIVACY CONTRACT: only email that MATCHES A JOB (rules in
 * ./emailmatch.ts — customer email on file, claim #, customer name)
 * is ever stored in email_messages. Everything else in the mailbox is
 * skipped and never leaves Gmail.
 *
 * Actions:
 *   getStatus    — is a Gmail account connected?
 *   exchangeCode — swap the Google OAuth code for tokens (offline access)
 *   disconnect   — revoke + delete stored tokens
 *   pullInbox    — cron (x-cron-secret) or signed-in office user: scan new
 *                  inbox mail since the last pull, file job matches into
 *                  email_messages. Unmatched mail is not stored.
 *   sendEmail    — signed-in office user ONLY (machine users denied):
 *                  send via the Gmail API from the owner's real address.
 *                  Replies thread properly (In-Reply-To + threadId) and
 *                  land in the Gmail Sent folder like any other mail.
 *
 * Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 *          (a Google Cloud OAuth web client with the Gmail API enabled,
 *          scopes gmail.readonly + gmail.send; Internal consent screen)
 * pullInbox cron also needs: CRON_SECRET (already set)
 *
 * Deploy: supabase functions deploy gmail-proxy
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { matchEmailToJob, buildRfc822, extractText, headerOf, addressOf, type Blob } from "./emailmatch.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PULL = 40;                         // messages per pull — the cron runs every 15 min

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const ok = (data: unknown) => json({ ok: true, data });
const err = (message: string, status = 400) => json({ ok: false, error: message }, status);

function serviceDb() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function clientCreds() {
  const id = Deno.env.get("GMAIL_CLIENT_ID"), secret = Deno.env.get("GMAIL_CLIENT_SECRET");
  if (!id || !secret) throw new Error("GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured");
  return { id, secret };
}

/* ---------- who is calling? ----------
   sendEmail must be a real signed-in HUMAN (the shared office login) —
   never the anon key, never a fenced machine user like office-brief@. */
async function callerEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return (u && u.email) ? String(u.email).toLowerCase() : null;
}
const isMachine = (email: string) => email.startsWith("office-brief@");

/* ---------- token management (gmail_tokens, service role only) ---------- */
async function getConnection(supabase: ReturnType<typeof serviceDb>) {
  const { data: row, error } = await supabase
    .from("gmail_tokens").select("*").order("created_at", { ascending: false }).limit(1).single();
  if (error || !row) throw new Error("Gmail is not connected — connect it from the office admin first.");
  if (new Date(row.expires_at as string).getTime() > Date.now() + 5 * 60 * 1000) {
    return { accessToken: row.access_token as string, account: row.account as string, row };
  }
  const { id, secret } = clientCreds();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: row.refresh_token as string,
      client_id: id, client_secret: secret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${(await res.text()).slice(0, 300)}`);
  const t = (await res.json()) as { access_token: string; expires_in: number };
  await supabase.from("gmail_tokens").update({
    access_token: t.access_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return { accessToken: t.access_token, account: row.account as string, row };
}

async function gmailFetch(accessToken: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()) as Blob;
}

/* ============================================================
   Main handler
   ============================================================ */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = serviceDb();
  let body: Blob = {};
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const action = body.action as string;

  try {
    // ── getStatus ─────────────────────────────────────────────────────────
    if (action === "getStatus") {
      const { data } = await supabase
        .from("gmail_tokens").select("account, updated_at").order("created_at", { ascending: false }).limit(1).single();
      return ok({ connected: !!data, account: data?.account ?? null, updatedAt: data?.updated_at ?? null });
    }

    // ── exchangeCode ──────────────────────────────────────────────────────
    if (action === "exchangeCode") {
      const code = body.code as string;
      if (!code) return err("Missing code");
      const redirectUri = Deno.env.get("GMAIL_REDIRECT_URI");
      if (!redirectUri) return err("GMAIL_REDIRECT_URI not configured");
      const { id, secret } = clientCreds();
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code, redirect_uri: redirectUri,
          client_id: id, client_secret: secret,
        }).toString(),
      });
      if (!res.ok) return err(`Token exchange failed: ${(await res.text()).slice(0, 300)}`);
      const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
      if (!t.refresh_token) return err("Google returned no refresh token — disconnect the app at myaccount.google.com/permissions and connect again.");
      // whose mailbox is this?
      const profile = await gmailFetch(t.access_token, "/profile");
      const account = String(profile.emailAddress || "").toLowerCase();
      await supabase.from("gmail_tokens").upsert({
        account,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        connected_by: (body.connectedBy as string) ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "account" });
      return ok({ account, connected: true });
    }

    // ── disconnect ────────────────────────────────────────────────────────
    if (action === "disconnect") {
      try {
        const { accessToken } = await getConnection(supabase);
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, { method: "POST" }).catch(() => {});
      } catch { /* ok even if no valid token */ }
      await supabase.from("gmail_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return ok({ disconnected: true });
    }

    // ── pullInbox (cron or signed-in office user) ─────────────────────────
    if (action === "pullInbox") {
      const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
      const viaCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
      const caller = viaCron ? null : await callerEmail(req);
      if (!viaCron && !caller) return err("pullInbox needs the cron secret or a signed-in user", 401);

      const { accessToken, account, row } = await getConnection(supabase);

      // jobs to match against (service role — the matcher only needs headers)
      const { data: projRows } = await supabase
        .from("field_projects").select("id, data").eq("deleted", false).limit(500);
      const projects: Blob[] = (projRows ?? []).map((r: Blob) => r.data).filter(Boolean);

      // pull window: since the last pull (epoch seconds), first run = 3 days back
      const sinceEpoch = Number(row.last_pull_epoch) || Math.floor(Date.now() / 1000) - 3 * 86400;
      const q = `in:inbox -from:me after:${sinceEpoch}`;
      const list = await gmailFetch(accessToken, `/messages?q=${encodeURIComponent(q)}&maxResults=${MAX_PULL}`);
      const msgIds: string[] = ((list.messages as Blob[]) ?? []).map((m) => String(m.id));

      let filed = 0, skipped = 0;
      let newestEpoch = sinceEpoch;
      for (const id of msgIds) {
        // already filed? (pull windows overlap on purpose — never miss a boundary)
        const { data: dup } = await supabase.from("email_messages").select("id").eq("gmail_id", id).limit(1);
        if (dup && dup.length) continue;
        const msg = await gmailFetch(accessToken, `/messages/${id}?format=full`);
        const payload = msg.payload as Blob;
        const fromH = headerOf(payload, "From");
        const subject = headerOf(payload, "Subject");
        const text = extractText(payload);
        const receivedMs = Number(msg.internalDate) || Date.now();
        newestEpoch = Math.max(newestEpoch, Math.floor(receivedMs / 1000));
        const match = matchEmailToJob({ from: fromH, subject, text }, projects);
        if (!match) { skipped++; continue; }         // stays private, never stored
        const { error: insErr } = await supabase.from("email_messages").insert([{
          gmail_id: id,
          thread_id: String(msg.threadId || ""),
          direction: "in",
          from_addr: addressOf(fromH),
          from_name: fromH,
          to_addr: account,
          subject: subject.slice(0, 500),
          body_text: text,
          message_id_header: headerOf(payload, "Message-ID"),
          job_id: match.projectId,
          matched_by: match.matchedBy,
          received_at: new Date(receivedMs).toISOString(),
          read_by_office: false,
        }]);
        if (!insErr) filed++;
      }
      // advance the cursor with a 10-min overlap (dedup above absorbs it)
      await supabase.from("gmail_tokens").update({
        last_pull_epoch: Math.max(sinceEpoch, newestEpoch - 600),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);

      if (filed > 0 || msgIds.length > 0) {
        await supabase.from("capture_events").insert([{
          source_type: "email_pull", form_key: "emailPull", captured_by: viaCron ? "gmail-cron" : (caller || "office"),
          status: "extracted", processed_at: new Date().toISOString(),
          raw_payload: { scanned: msgIds.length, filed, skipped },
          result: {},
        }]).then(() => {}, () => {});
      }
      return ok({ scanned: msgIds.length, filed, skipped });
    }

    // ── sendEmail (signed-in office user, OR an owner-approved text action) ──
    if (action === "sendEmail") {
      // approve-by-text path: the roybal-notify webhook (which just verified
      // the owner's YES against a Twilio-signed inbound) calls with the cron
      // secret + the pending_actions row id. We RE-VERIFY that row is
      // approved-and-unexecuted before anything sends — two layers deep.
      const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
      const pendingId = String(body.pendingActionId || "");
      const viaApproval = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret && !!pendingId;
      let caller: string;
      if (viaApproval) {
        const { data: pa } = await supabase.from("pending_actions")
          .select("id, kind, status").eq("id", pendingId).single();
        if (!pa || pa.status !== "approved" || pa.kind !== "emailSend")
          return err("no approved pending action to execute", 403);
        caller = "approve-by-text";
      } else {
        const who = await callerEmail(req);
        if (!who) return err("Sign in to send email", 401);
        if (isMachine(who)) return err("machine users cannot send email", 403);
        caller = who;
      }

      const to = String(body.to || "").trim();
      const subject = String(body.subject || "").trim();
      const text = String(body.body || "").trim();
      const jobId = String(body.jobId || "") || null;
      const threadId = String(body.threadId || "") || undefined;
      const inReplyTo = String(body.inReplyTo || "") || undefined;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return err("Invalid 'to' address");
      if (!text) return err("Empty email body");
      if (!subject && !inReplyTo) return err("Subject required for a new email");

      const { accessToken, account } = await getConnection(supabase);
      const { base64url } = buildRfc822({ to, from: account, subject: subject || "Re:", body: text, inReplyTo });
      const sent = await gmailFetch(accessToken, "/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: base64url, ...(threadId ? { threadId } : {}) }),
      });

      await supabase.from("email_messages").insert([{
        gmail_id: String(sent.id || ""),
        thread_id: String(sent.threadId || threadId || ""),
        direction: "out",
        from_addr: account,
        from_name: account,
        to_addr: to.toLowerCase(),
        subject: (subject || "Re:").slice(0, 500),
        body_text: text,
        message_id_header: "",
        job_id: jobId,
        matched_by: "sent",
        received_at: new Date().toISOString(),
        read_by_office: true,
        sent_by: caller,
      }]).then(() => {}, () => {});
      await supabase.from("capture_events").insert([{
        source_type: "email_send", form_key: "emailSend", captured_by: caller,
        status: "extracted", processed_at: new Date().toISOString(),
        raw_payload: { to, subject: (subject || "Re:").slice(0, 200), jobId, chars: text.length },
        result: { gmailId: sent.id, threadId: sent.threadId },
      }]).then(() => {}, () => {});

      // consume the approval — a second YES for the same code can never re-send
      if (viaApproval) {
        await supabase.from("pending_actions").update({
          status: "executed", executed_at: new Date().toISOString(),
          result: { gmailId: sent.id, threadId: sent.threadId },
        }).eq("id", pendingId).eq("status", "approved");
      }

      return ok({ gmailId: sent.id, threadId: sent.threadId });
    }

    return err(`Unknown action: ${action}`, 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
