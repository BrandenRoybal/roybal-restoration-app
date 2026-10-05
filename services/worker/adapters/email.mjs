/* Email adapter — delivers an outbox `email` row through the Gmail API as the
   connected office account (gmail_tokens, newest row), the same way the
   gmail-proxy edge function's sendEmail does. gmail-proxy itself cannot be
   called here: it takes a signed-in office user or an owner-approved text
   action, and the worker is neither. So the worker holds the OAuth client
   (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET as Fly secrets) and refreshes the
   stored token itself, writing the refreshed access token back so the proxy
   and the worker share one connection.

   Exactly-once: the email_messages row written after a send carries
   `sent_by = outbox:<outbox id>`; a retry after a lost lease looks it up
   first and adopts the earlier send. The window between Gmail accepting and
   that row landing is the one place a crash could still double-send; the
   row is written before outbox_sent so the window is as small as it can be. */

import { buildRfc822, validAddresses, addressList } from "../rfc822.mjs";
import { DeliveryError, tagFor } from "./sms.mjs";
import { errText } from "../log.mjs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export function classifyGmailError(status, text) {
  const t = String(text ?? "").slice(0, 400);
  if (status === 400 && /invalid (to|cc|bcc) header|recipient address required|invalid.*address/i.test(t)) {
    return new DeliveryError(`Gmail refused the address: ${t}`, { permanent: true, status });
  }
  // 401/403: token or scope — the next refresh may fix it; 429/5xx: later.
  return new DeliveryError(`Gmail API ${status}: ${t}`, { permanent: false, status });
}

export function emailAdapter(ctx) {
  const { cfg, supa, log } = ctx;
  const doFetch = (...a) => (ctx.fetch ?? globalThis.fetch)(...a);

  /** The newest connected account's access token, refreshed when within 5 min of expiry. */
  async function getConnection() {
    const rows = await supa.select("gmail_tokens", "select=id,account,access_token,refresh_token,expires_at&order=created_at.desc&limit=1");
    const row = rows[0];
    if (!row) throw new DeliveryError("Gmail is not connected — connect it from the office admin first.", { permanent: false });
    if (new Date(row.expires_at).getTime() > Date.now() + 5 * 60 * 1000) {
      return { accessToken: row.access_token, account: row.account };
    }
    let res;
    try {
      res = await doFetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: row.refresh_token,
          client_id: cfg.gmailClientId, client_secret: cfg.gmailClientSecret,
        }).toString(),
      });
    } catch (e) {
      throw new DeliveryError(`Gmail token refresh unreachable: ${errText(e, 200)}`, { permanent: false });
    }
    if (!res.ok) throw new DeliveryError(`Gmail token refresh failed: ${(await res.text().catch(() => "")).slice(0, 300)}`, { permanent: false, status: res.status });
    const t = await res.json();
    await supa.patch("gmail_tokens", `id=eq.${encodeURIComponent(row.id)}`, {
      access_token: t.access_token,
      expires_at: new Date(Date.now() + Number(t.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).catch((e) => log("email.token_writeback_failed", { error: errText(e) }));
    return { accessToken: t.access_token, account: row.account };
  }

  async function contactIdFor(addr) {
    try {
      const rows = await supa.select("contacts", `select=id&email_norm=eq.${encodeURIComponent(addr)}&merged_into=is.null&limit=2`);
      return rows.length === 1 ? rows[0].id : null;
    } catch { return null; }
  }

  return {
    channel: "email",
    connection: "gmail",

    async findPrior(row) {
      const rows = await supa.select(
        "email_messages",
        `select=id,gmail_id,thread_id&direction=eq.out&sent_by=eq.${encodeURIComponent(tagFor(row))}&limit=1`,
      );
      if (!rows.length) return null;
      return { providerId: rows[0].gmail_id || "", providerStatus: "sent" };
    },

    async send(row) {
      const p = row.payload ?? {};
      const to = addressList(p.to);
      const body = String(p.body ?? "").trim();
      const subject = String(p.subject ?? "").trim();
      const threadId = String(p.thread_id ?? p.threadId ?? "").trim() || undefined;
      const inReplyTo = String(p.in_reply_to ?? p.inReplyTo ?? "").trim() || undefined;
      if (!validAddresses(p.to)) throw new DeliveryError("email row has no valid `to` address", { permanent: true });
      if (p.cc && !validAddresses(p.cc)) throw new DeliveryError("email row has an invalid `cc` address", { permanent: true });
      if (!body) throw new DeliveryError("email row has an empty body", { permanent: true });
      if (!subject && !inReplyTo) throw new DeliveryError("email row has no subject", { permanent: true });

      const { accessToken, account } = await getConnection();
      const { base64url } = buildRfc822({ to, cc: p.cc, from: account, subject: subject || "Re:", body, inReplyTo });

      let res;
      try {
        res = await doFetch(GMAIL_SEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: base64url, ...(threadId ? { threadId } : {}) }),
        });
      } catch (e) {
        throw new DeliveryError(`Gmail unreachable: ${errText(e, 200)}`, { permanent: false });
      }
      if (!res.ok) throw classifyGmailError(res.status, await res.text().catch(() => ""));
      const sent = await res.json().catch(() => ({}));

      // The adopt record. Written before outbox_sent so a crash between the
      // two still leaves the retry something to find.
      const firstTo = to.split(",")[0].trim().toLowerCase();
      try {
        await supa.insert("email_messages", [{
          gmail_id: String(sent.id ?? ""),
          thread_id: String(sent.threadId ?? threadId ?? ""),
          direction: "out",
          from_addr: account,
          from_name: account,
          to_addr: to.toLowerCase().slice(0, 500),
          subject: (subject || "Re:").slice(0, 500),
          body_text: body,
          message_id_header: "",
          job_id: null,
          matched_by: "sent",
          contact_id: await contactIdFor(firstTo),
          received_at: new Date().toISOString(),
          read_by_office: true,
          sent_by: tagFor(row),
        }]);
      } catch (e) {
        log("email.record_failed", { outbox_id: row.id, error: errText(e) });
      }
      return { providerId: String(sent.id ?? ""), providerStatus: "sent" };
    },
  };
}
