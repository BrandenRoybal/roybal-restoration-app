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
   row is written before outbox_sent so the window is as small as it can be.

   Late is worse than never for these: an overdue-invoice reminder approved
   while the email lane was off would otherwise go out whenever the lane
   came back, days later and maybe after the customer paid. A row older than
   EMAIL_MAX_AGE_HOURS when it is about to be sent is refused as permanent,
   so it goes dead with the reason on it and the dead-letter text counts it.
   The check sits inside send(), which the lane calls only after its adopt
   lookup found nothing, so an old row that an earlier attempt DID send is
   still adopted, never refused.

   Packet mode — emailAdapter(ctx, { packet: true }), the 'packet' channel
   (docs/Carrier_Packet_Design.md §9): the carrier packet email, one PDF
   attached, over the same Gmail connection. The PDF is fetched from the
   private carrier-packets bucket with the service key and must match the
   size and sha256 the executor copied onto the row from the packet the owner
   approved; anything else is refused for good rather than sent. The message
   goes to Gmail's upload endpoint as raw message/rfc822 bytes (a JSON `raw`
   would be a third larger and capped lower), under a fixed Message-ID,
   <outbox-<outbox id>@roybalconstruction.com>. That id is the second adopt
   key: a 17 MB upload that times out may still have been accepted, and then
   no email_messages row exists, so findPrior also searches the mailbox for
   the Message-ID before anything is sent again. Plain `email` rows never
   take this path; they are built and sent exactly as before. */

import { createHash } from "node:crypto";
import { buildRfc822, validAddresses, addressList } from "../rfc822.mjs";
import { DeliveryError, tagFor } from "./sms.mjs";
import { errText } from "../log.mjs";
import { EMAIL_MAX_AGE_HOURS_DEFAULT } from "../config.mjs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_UPLOAD_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const GMAIL_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export const PACKET_BUCKET = "carrier-packets";
// A 17 MB PDF from storage in the same region, and the same bytes plus a
// third (base64) up to Google: generous, but bounded, so a stalled transfer
// fails the attempt into a retry instead of holding the lease forever.
export const PACKET_DOWNLOAD_MS = 60_000;
export const PACKET_SEND_MS = 120_000;
export const PACKET_LOOKUP_MS = 30_000;

/** The packet email's Message-ID: fixed per outbox row, so every attempt
    sends the same one and a retry can find an earlier attempt by it. */
export const packetMessageId = (row) => `<outbox-${row.id}@roybalconstruction.com>`;

export function classifyGmailError(status, text) {
  const t = String(text ?? "").slice(0, 400);
  if (status === 400 && /invalid (to|cc|bcc) header|recipient address required|invalid.*address/i.test(t)) {
    return new DeliveryError(`Gmail refused the address: ${t}`, { permanent: true, status });
  }
  // 401/403: token or scope — the next refresh may fix it; 429/5xx: later.
  return new DeliveryError(`Gmail API ${status}: ${t}`, { permanent: false, status });
}

const TOO_LARGE = /too (large|big)|exceeds? the (maximum|max|size|limit)|size limit|maximum (message )?size/i;

/** Gmail's answer to a packet upload. Too large is permanent: the same PDF
    would be refused again, and the error says "too large" so the packet lane
    (carrier_packet_reserve) stops offering that build and rebuilds smaller.
    A rate limit or an outage that happens to mention a size stays transient. */
export function classifyPacketError(status, text) {
  const t = String(text ?? "").slice(0, 400);
  if (status === 413 || (status !== 429 && status < 500 && TOO_LARGE.test(t))) {
    return new DeliveryError(`Gmail refused the packet email as too large (${status}): ${t}`, { permanent: true, status });
  }
  return classifyGmailError(status, t);
}

/** Why this row is too old to send, or null when it may go. The text lands
    in outbox.error, which the Approvals inbox shows after "Couldn't send: ".
    A row with no readable created_at is refused too: the claim always
    returns it, so its absence means a shape this code does not know, and
    sending blind is the one thing the limit exists to stop. */
export function staleEmailReason(row, maxHours, now = Date.now()) {
  const queuedAt = Date.parse(String(row?.created_at ?? ""));
  if (!Number.isFinite(queuedAt)) return "this email has no queued time, so its age can't be checked; it was not sent";
  const ageH = Math.max(0, now - queuedAt) / 3_600_000;
  if (ageH <= maxHours) return null;
  const n = ageH < 72 ? Math.floor(ageH) : Math.floor(ageH / 24);
  const age = ageH < 72 ? `${n} hour${n === 1 ? "" : "s"}` : `${n} days`;
  return `this email waited ${age} in line, past the ${maxHours}-hour limit (EMAIL_MAX_AGE_HOURS), ` +
    `so it was not sent. Send a fresh one if it should still go.`;
}

const permanent = (m) => new DeliveryError(m, { permanent: true });
const transient = (m, status = null) => new DeliveryError(m, { permanent: false, status });
const timedOut = (e) => e?.name === "TimeoutError" || e?.name === "AbortError";

/** The packet row's one attachment, checked before anything is fetched: it
    must be a carrier-packets object with a size and a sha256 to hold the
    download to. Any other shape is not something this code can send. */
export function packetAttachment(payload, supabaseUrl) {
  const list = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (list.length !== 1) throw permanent(`a packet email carries exactly one attachment; this row has ${list.length}, so it was not sent`);
  const a = list[0] && typeof list[0] === "object" ? list[0] : {};
  if (a.bucket !== PACKET_BUCKET) {
    throw permanent(`the packet attachment must come from the ${PACKET_BUCKET} bucket, not "${String(a.bucket ?? "").slice(0, 60)}", so it was not sent`);
  }
  const path = String(a.path ?? "");
  const segs = path.split("/");
  if (!path || segs.some((s) => !s || s === "." || s === "..") || /[\x00-\x1f\\]/.test(path)) {
    throw permanent("the packet attachment has no usable storage path, so it was not sent");
  }
  const sha256 = String(a.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw permanent("the packet attachment has no sha256 to check the PDF against, so it was not sent");
  const size = Number(a.bytes);
  if (!Number.isSafeInteger(size) || size <= 0) throw permanent("the packet attachment has no size to check the PDF against, so it was not sent");
  return {
    url: `${supabaseUrl}/storage/v1/object/${PACKET_BUCKET}/${segs.map(encodeURIComponent).join("/")}`,
    sha256,
    size,
    filename: String(a.filename ?? "").trim() || segs.at(-1),
    contentType: String(a.content_type ?? "").trim() || "application/pdf",
  };
}

/** Storage's "no such object": a 404, or the 400 with statusCode "404" in the
    body that older storage-api versions answer instead. */
function storageNotFound(status, text) {
  if (status === 404) return true;
  if (status !== 400) return false;
  try {
    const b = JSON.parse(text);
    return String(b?.statusCode ?? "") === "404" || /not.?found/i.test(String(b?.error ?? ""));
  } catch { return false; }
}

/** A mailbox search Gmail will never answer, whatever the retry: the query
    itself refused (400), or a token without the read scope (403 naming
    insufficient permission or scope). A 403 rate limit is not this. */
function lookupUnusable(status, text) {
  return status === 400 || (status === 403 && /insufficient|scope/i.test(String(text ?? "")));
}

export function emailAdapter(ctx, { packet = false } = {}) {
  const { cfg, supa, log } = ctx;
  const doFetch = (...a) => (ctx.fetch ?? globalThis.fetch)(...a);
  const maxAgeHours = () => (Number.isFinite(cfg.emailMaxAgeHours) ? cfg.emailMaxAgeHours : EMAIL_MAX_AGE_HOURS_DEFAULT);

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

  async function findTagged(row) {
    const rows = await supa.select(
      "email_messages",
      `select=id,gmail_id,thread_id&direction=eq.out&sent_by=eq.${encodeURIComponent(tagFor(row))}&limit=1`,
    );
    if (!rows.length) return null;
    return { providerId: rows[0].gmail_id || "", providerStatus: "sent" };
  }

  /** The adopt record, and the line in the job's email history. Written
      before outbox_sent so a crash between the two still leaves the retry
      something to find; a failure here is logged, never thrown, because the
      message went. */
  async function recordSent(row, { gmailId, threadId, account, to, subject, body, messageIdHeader, jobId }) {
    const firstTo = to.split(",")[0].trim().toLowerCase();
    try {
      await supa.insert("email_messages", [{
        gmail_id: gmailId,
        thread_id: threadId,
        direction: "out",
        from_addr: account,
        from_name: account,
        to_addr: to.toLowerCase().slice(0, 500),
        subject: subject.slice(0, 500),
        body_text: body,
        message_id_header: messageIdHeader,
        // Files the send under its job, as gmail-proxy does, so it shows in
        // the job's email history. email_messages.job_id is text (a field
        // project or a coordination job id); outbox.job_id is the uuid the
        // proposal carried.
        job_id: jobId == null || jobId === "" ? null : String(jobId),
        matched_by: "sent",
        contact_id: await contactIdFor(firstTo),
        received_at: new Date().toISOString(),
        read_by_office: true,
        sent_by: tagFor(row),
      }]);
    } catch (e) {
      log("email.record_failed", { outbox_id: row.id, error: errText(e) });
    }
  }

  if (packet) return packetMode();

  return {
    channel: "email",
    connection: "gmail",

    findPrior: findTagged,

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
      // Before the token refresh and the send: a stale row touches nothing at Google.
      const stale = staleEmailReason(row, maxAgeHours());
      if (stale) throw new DeliveryError(stale, { permanent: true });

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

      await recordSent(row, {
        gmailId: String(sent.id ?? ""),
        threadId: String(sent.threadId ?? threadId ?? ""),
        account, to, subject: subject || "Re:", body,
        messageIdHeader: "",
        jobId: row.job_id,
      });
      return { providerId: String(sent.id ?? ""), providerStatus: "sent" };
    },
  };

  function packetMode() {
    /** The approved PDF, or a refusal. Missing, or not byte-for-byte the
        packet on the card, is permanent: a retry would fetch the same object. */
    async function download(att) {
      let res;
      try {
        res = await doFetch(att.url, {
          method: "GET",
          headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` },
          signal: AbortSignal.timeout(PACKET_DOWNLOAD_MS),
        });
      } catch (e) {
        throw transient(`the packet PDF could not be fetched from storage (${timedOut(e) ? "timed out" : errText(e, 200)})`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (storageNotFound(res.status, text)) {
          throw permanent("the packet PDF is missing from storage, so it was not sent");
        }
        throw transient(`storage answered ${res.status} for the packet PDF: ${text.slice(0, 200)}`, res.status);
      }
      let bytes;
      try {
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        throw transient(`the packet PDF download broke off (${timedOut(e) ? "timed out" : errText(e, 200)})`);
      }
      if (bytes.length !== att.size) {
        throw permanent(`the packet PDF in storage does not match the approved one (${bytes.length} bytes, expected ${att.size}), so it was not sent`);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== att.sha256) {
        throw permanent("the packet PDF in storage does not match the approved one (its sha256 differs), so it was not sent");
      }
      return bytes;
    }

    return {
      channel: "packet",
      connection: "gmail",

      /* The tag first (one indexed select, as for email), then the mailbox.
         The mailbox search is what makes an upload that timed out after
         Gmail accepted it safe to retry, so when Gmail cannot be asked (a
         network error, a timeout, a 401, a 429, a 5xx, a token that will not
         refresh) this attempt fails transiently and nothing is sent: an
         outage that stops the search would almost always stop the send too,
         and the outbox backoff (2, 4, 8 … minutes, dead after max_attempts)
         bounds the wait, after which the lane can offer the packet again.
         Sending blind instead would risk a second copy to the adjuster.
         Only a search Gmail will NEVER answer (lookupUnusable: the query
         refused, or a token without the read scope) is logged and skipped,
         so that a connection problem cannot strand every packet; the send
         then has the email lane's guarantee, the tag alone. A hit is also
         recorded in email_messages, so the job's email history shows it and
         a later retry adopts it from the tag. Gmail indexes a sent message
         within seconds; the first retry comes minutes later. */
      async findPrior(row) {
        const tagged = await findTagged(row);
        if (tagged) return tagged;
        const { accessToken, account } = await getConnection();
        const q = `rfc822msgid:${packetMessageId(row)}`;
        let res;
        try {
          // includeSpamTrash: a sent copy moved to the trash was still sent.
          res = await doFetch(`${GMAIL_LIST_URL}?q=${encodeURIComponent(q)}&includeSpamTrash=true`, {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(PACKET_LOOKUP_MS),
          });
        } catch (e) {
          throw transient(`Gmail could not be searched for an earlier send of this packet (${timedOut(e) ? "timed out" : errText(e, 200)}); ` +
            "not sent yet, so it cannot go twice");
        }
        if (!res.ok) {
          const text = (await res.text().catch(() => "")).slice(0, 300);
          if (lookupUnusable(res.status, text)) {
            log("packet.lookup_unusable", { outbox_id: row.id, status: res.status, error: text });
            return null;
          }
          throw transient(`Gmail search for an earlier send of this packet answered ${res.status}: ${text}; not sent yet, so it cannot go twice`, res.status);
        }
        const found = await res.json().catch(() => null);
        if (!found || typeof found !== "object") {
          throw transient("Gmail's search answer could not be read; not sent yet, so it cannot go twice");
        }
        const hit = Array.isArray(found.messages) ? found.messages.find((m) => m?.id) : null;
        if (!hit) return null;
        const p = row.payload ?? {};
        await recordSent(row, {
          gmailId: String(hit.id),
          threadId: String(hit.threadId ?? ""),
          account,
          to: addressList(p.to),
          subject: String(p.subject ?? "").trim(),
          body: String(p.body ?? "").trim(),
          messageIdHeader: packetMessageId(row),
          jobId: row.job_id ?? p.job_id,
        });
        return { providerId: String(hit.id), providerStatus: "sent" };
      },

      async send(row) {
        const p = row.payload ?? {};
        const to = addressList(p.to);
        const body = String(p.body ?? "").trim();
        const subject = String(p.subject ?? "").trim();
        if (!validAddresses(p.to)) throw permanent("packet row has no valid `to` address");
        if (p.cc && !validAddresses(p.cc)) throw permanent("packet row has an invalid `cc` address");
        if (!subject) throw permanent("packet row has no subject");
        if (!body) throw permanent("packet row has an empty body");
        const att = packetAttachment(p, cfg.supabaseUrl);
        // Before the download, the token refresh and the send, as for email.
        const stale = staleEmailReason(row, maxAgeHours());
        if (stale) throw permanent(stale);

        const pdf = await download(att);
        const { accessToken, account } = await getConnection();
        const messageId = packetMessageId(row);
        const { bytes } = buildRfc822({
          to, cc: p.cc, from: account, subject, body, messageId,
          attachments: [{ filename: att.filename, contentType: att.contentType, bytes: pdf }],
        });

        let res;
        try {
          res = await doFetch(GMAIL_UPLOAD_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822" },
            body: bytes,
            signal: AbortSignal.timeout(PACKET_SEND_MS),
          });
        } catch (e) {
          // Gmail may have taken it before the line dropped: the retry's
          // findPrior searches for the Message-ID before sending again.
          throw transient(`Gmail upload ${timedOut(e) ? "timed out" : `unreachable: ${errText(e, 200)}`}`);
        }
        if (!res.ok) throw classifyPacketError(res.status, await res.text().catch(() => ""));
        const sent = await res.json().catch(() => ({}));

        await recordSent(row, {
          gmailId: String(sent.id ?? ""),
          threadId: String(sent.threadId ?? ""),
          account, to, subject, body,
          messageIdHeader: messageId,
          jobId: row.job_id ?? p.job_id,
        });
        return { providerId: String(sent.id ?? ""), providerStatus: "sent" };
      },
    };
  }
}
