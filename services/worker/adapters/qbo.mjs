/* QuickBooks adapter — delivers an outbox `qbo` row (receipts.qbo_link@1, one
   row per approved receipt, migration 0022) through the qbo-proxy edge
   function's completePurchase action under the service role key, the way
   adapters/sms.mjs goes through roybal-notify. qbo-proxy stays the only
   holder of the QuickBooks token (it refreshes and rotates it; a second
   refresher here would race it), and the only place that knows Intuit's
   rules: it tags every line of the expense to the job's project, attaches
   the receipt photo from field-media, or enters a store invoice first.

   Exactly-once without an adopt lookup: findPrior answers null, because
   completePurchase is idempotent by itself and a retry is the adopt. It
   re-reads the expense and adopts its own work: a tag already equal to the
   job's project counts as done, an attachment whose file name carries
   "[r:<receipt id>]" counts as attached (only missing pages are uploaded),
   and a store entry is looked up by its DocNumber (and Intuit's requestid,
   derived from the proposal and receipt) before one is created. So an
   attempt that died after QuickBooks took it is simply finished by the next.

   Verdicts: qbo-proxy answers HTTP 409 with permanent: true when retrying
   cannot help (the expense is tagged to another job, it changed in
   QuickBooks since the card was filed, the photo is gone, Intuit refused
   the write). Those rows go dead at once, and the receipt shows the reason
   (its error starts with the code: "tagged_other: …"). A photo QuickBooks
   refuses after the tag or the store entry went in comes back ok with
   attach_error: the row is sent, its provider status says
   attach_error=<code>. Everything else,
   QuickBooks being down or throttling, a stale SyncToken, the function
   unreachable, retries with the outbox backoff. */

import { errText } from "../log.mjs";
import { DeliveryError } from "./sms.mjs";

// completePurchase reads the expense, may upload four pages and may write
// twice; an edge function stops by itself before this. Without a limit a
// hung call would hold the outbox lane (one row at a time) forever, its
// lease renewed by every heartbeat.
const SEND_TIMEOUT_MS = 150_000;
const DIGITS = /^[0-9]{1,20}$/;

/** qbo-proxy's answer → the verdict the outbox lane records. */
export function classifyQboError(status, data) {
  const message = String(data?.error ?? "").trim() || `qbo-proxy answered ${status ?? "nothing"}`;
  const permanent = status === 409 || data?.permanent === true;
  return new DeliveryError(message.slice(0, 2000), { permanent, status });
}

export function qboAdapter(ctx) {
  const { cfg } = ctx;
  const doFetch = (...a) => (ctx.fetch ?? globalThis.fetch)(...a);
  return {
    channel: "qbo",
    connection: "qbo",

    /** Nothing to look up: completePurchase adopts its own earlier work (above). */
    async findPrior() {
      return null;
    },

    async send(row) {
      const p = row.payload;
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        throw new DeliveryError("qbo row has no payload", { permanent: true });
      }
      let res;
      try {
        res = await doFetch(cfg.qboProxyUrl, {
          method: "POST",
          headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...p, action: "completePurchase" }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (e) {
        throw new DeliveryError(`qbo-proxy unreachable: ${errText(e, 200)}`, { permanent: false });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) throw classifyQboError(res.status, data);
      // The receipt's link row learns the expense and its new SyncToken from
      // this id (the outbox_qbo_link_result trigger reads exactly this shape).
      const id = String(data.purchaseId ?? "");
      const token = String(data.syncToken ?? "");
      if (!DIGITS.test(id) || !DIGITS.test(token)) {
        throw new DeliveryError(`qbo-proxy answered ok without the expense id and SyncToken (${id || "no id"}:${token || "no token"})`,
          { permanent: false });
      }
      const status = [`tagged=${String(data.tagged ?? "")}`, `attached=${Number(data.attached) || 0}`];
      if (data.already_attached === true) status.push("already_attached=true");
      // QuickBooks refused the photo after the tag or the new expense was
      // written: the row is sent (the write is real, and its id is recorded),
      // and the receipt shows the photo as not attached, with the code
      const attachError = data.attach_error && typeof data.attach_error === "object"
        ? String(data.attach_error.code ?? "").replace(/[^a-z_]/g, "").slice(0, 40) || "unknown" : "";
      if (attachError) status.push(`attach_error=${attachError}`);
      return { providerId: `Purchase:${id}:${token}`, providerStatus: status.join(";"), costUsd: 0 };
    },
  };
}
