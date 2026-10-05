/* SMS adapter — delivers an outbox `sms` row through the roybal-notify edge
   function (action sendSms) under the service role key. Going through
   roybal-notify rather than Twilio directly keeps ONE copy of the rules every
   text already obeys: quiet hours by kind, the monthly cap and the reserve
   floor, the sms_messages log row, and the Twilio status callback that later
   settles that row. The worker adds only the outbox lease around it.

   Exactly-once: the sms_messages row roybal-notify writes carries
   `sent_by = outbox:<outbox id>` (its captured_by). A retry after a lost
   lease looks that tag up FIRST and adopts the earlier send instead of
   texting the customer twice. */

import { errText } from "../log.mjs";

export const tagFor = (row) => `outbox:${row.id}`;

export class DeliveryError extends Error {
  constructor(message, { permanent = false, status = null } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.permanent = permanent;
    this.status = status;
  }
}

/* roybal-notify's refusals, as its error strings begin. Permanent means the
   row can never succeed as written; everything else gets the backoff. */
const PERMANENT = [
  /^Provide `to`/,                 // not a US number
  /^Provide `body`/,               // empty text
  /is not a valid phone number/i,  // Twilio 21211 and friends
  /not a mobile number/i,          // Twilio 21614
  /unsubscribed|blacklist|opted out|STOP/,   // Twilio 21610
  /Permission to send an SMS has not been enabled/i,
  /^campaign_duplicate/,
];
const TRANSIENT_HINT = [/^quiet_hours/, /^sms_cap_reached/, /^sms_reserve_reached/, /^texting_not_configured/, /^send_failed/];

export function classifySmsError(message, status = null) {
  const m = String(message ?? "").trim() || `roybal-notify refused (${status ?? "no status"})`;
  if (PERMANENT.some((re) => re.test(m))) return new DeliveryError(m, { permanent: true, status });
  if (TRANSIENT_HINT.some((re) => re.test(m))) return new DeliveryError(m, { permanent: false, status });
  // 4xx other than the known refusals: the request itself is wrong → permanent;
  // 5xx or unknown: try again later.
  const permanent = status != null && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
  return new DeliveryError(m, { permanent, status });
}

export function smsAdapter(ctx) {
  const { cfg, supa } = ctx;
  const doFetch = (...a) => (ctx.fetch ?? globalThis.fetch)(...a);
  return {
    channel: "sms",
    connection: "twilio",

    /** The earlier attempt's provider record, if the dead attempt got that far. */
    async findPrior(row) {
      const rows = await supa.select(
        "sms_messages",
        `select=id,twilio_sid,status&direction=eq.outbound&status=neq.failed` +
        `&sent_by=eq.${encodeURIComponent(tagFor(row))}&order=created_at.desc&limit=1`,
      );
      if (!rows.length) return null;
      return { providerId: rows[0].twilio_sid || "", providerStatus: rows[0].status || "sent" };
    },

    async send(row) {
      const p = row.payload ?? {};
      const to = String(p.to ?? "").trim();
      const body = String(p.body ?? "").trim();
      if (!to) throw new DeliveryError("sms row has no `to`", { permanent: true });
      if (!body) throw new DeliveryError("sms row has no `body`", { permanent: true });
      let res;
      try {
        res = await doFetch(cfg.notifyUrl, {
          method: "POST",
          headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sendSms",
            to,
            body: body.slice(0, 1600),
            kind: String(p.kind ?? "text").slice(0, 40),
            unified_job_id: row.job_id ?? null,
            captured_by: tagFor(row),
          }),
        });
      } catch (e) {
        throw new DeliveryError(`roybal-notify unreachable: ${errText(e, 200)}`, { permanent: false });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) throw classifySmsError(data?.error, res.status);
      return { providerId: String(data.sid ?? ""), providerStatus: String(data.status ?? "sent") };
    },
  };
}
