/* SMS adapter — delivers an outbox `sms` row through the roybal-notify edge
   function (action sendSms) under the service role key. Going through
   roybal-notify rather than Twilio directly keeps ONE copy of the rules every
   text already obeys: the monthly cap and the reserve floor, the sms_messages
   log row, and the Twilio status callback that later settles that row. The
   worker adds only the outbox lease around it.

   Quiet hours exist twice and must agree: the database schedules sms rows
   into the role_permissions window (op_quiet_hours_release), and
   roybal-notify refuses outside its SMS_QUIET_START/END secrets. A refusal
   is transient here (the row is rescheduled into the database's window), so
   if the two windows ever drift apart a row burns an attempt per claim —
   keep them the same.

   Exactly-once: the sms_messages row roybal-notify writes carries
   `sent_by = outbox:<outbox id>` (its captured_by). A retry looks that tag up
   FIRST and adopts the earlier send instead of texting the customer twice —
   but only a row Twilio accepted (twilio_sid set). roybal-notify inserts the
   row as `pending` BEFORE calling Twilio and settles it after, so a pending
   row with no sid proves nothing: the function may have died before the
   call. That row is not adopted; the text is sent. Losing an approved text
   silently is the worse failure; the duplicate window (Twilio accepted, the
   settle PATCH failed, the function died in between) is far narrower.

   Verdicts: roybal-notify answers HTTP 400 for EVERY error it throws, its own
   transient database failures included, so the status code carries no
   information. Permanent is only what the explicit list below names; all
   else gets the backoff and dies after max_attempts with the error on the row. */

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

/* roybal-notify's refusals, as its error strings begin or contain. Permanent
   means the row can never succeed as written. */
const PERMANENT = [
  /^Provide `to`/,                 // not a US number
  /^Provide `body`/,               // empty text
  /^Unknown action/,               // the worker is speaking the wrong protocol
  /is not a valid phone number/i,  // Twilio 21211 and friends
  /not a mobile number/i,          // Twilio 21614
  /unsubscribed|blacklist|opted out|STOP/,   // Twilio 21610
  /Permission to send an SMS has not been enabled/i,
  /^campaign_duplicate/,
];
/* Named here only so a reader sees them; anything not PERMANENT is transient. */
export const TRANSIENT = [
  /^quiet_hours/, /^sms_cap_reached/, /^sms_reserve_reached/, /^texting_not_configured/, /^send_failed/,
  /^send-count read failed/, /^log insert failed/, /^Missing Authorization/,
];

export function classifySmsError(message, status = null) {
  const m = String(message ?? "").trim() || `roybal-notify refused (${status ?? "no status"})`;
  const permanent = PERMANENT.some((re) => re.test(m));
  return new DeliveryError(m, { permanent, status });
}

export function smsAdapter(ctx) {
  const { cfg, supa } = ctx;
  const doFetch = (...a) => (ctx.fetch ?? globalThis.fetch)(...a);
  return {
    channel: "sms",
    connection: "twilio",

    /** The earlier attempt's provider record, if Twilio accepted that send. */
    async findPrior(row) {
      const rows = await supa.select(
        "sms_messages",
        `select=id,twilio_sid,status&direction=eq.outbound&status=neq.failed&twilio_sid=not.is.null` +
        `&sent_by=eq.${encodeURIComponent(tagFor(row))}&order=created_at.desc&limit=1`,
      );
      if (!rows.length) return null;
      return { providerId: rows[0].twilio_sid, providerStatus: rows[0].status || "sent" };
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
