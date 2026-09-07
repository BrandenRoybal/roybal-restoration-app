/* ============================================================
   Twilio delivery-status reconciliation — the pure mapping.

   F-034 (docs/architecture/findings.json, High): nothing ever told
   this system what Twilio did with a text. sendSms() stored the
   status from the IMMEDIATE Twilio API response — which is always
   'queued'/'accepted', the answer to "did you take it?", never "did
   it arrive?" — and supabase/config.toml claimed the function
   received status callbacks that no route existed to receive. The
   live table showed it: 174 of 175 outbound rows frozen at 'queued'.
   The table is claim documentation (migration 106), so "we texted
   them" has to mean the carrier delivered it, not that Twilio
   accepted the API call.

   This file is the decision half of the /status route: which column
   value a Twilio MessageStatus becomes, and which stored values a
   given callback may NOT overwrite. Pure — no Deno, no network — so
   node can test it (the campaign.mjs / crewtoday.mjs pattern).

   ORDERING IS THE WHOLE POINT. Twilio callbacks are not ordered:
   'queued' can arrive after 'delivered' (a retry of an earlier POST,
   or plain out-of-order delivery). Each stored value carries a rank,
   and a callback may only write over strictly lower ranks — so a
   re-delivered 'queued' can never un-deliver a delivered message,
   and applying the same callback twice is a no-op.

   allowed values in sms_messages.status (the column is unconstrained
   text — migration 106 line 21 — and adding the CHECK is Task B's
   migration to own, so the contract is documented here):
     pending      row written before the Twilio call (sendSms)
     queued       Twilio has it; not handed to a carrier yet
     sent         handed to the carrier
     delivered    carrier confirmed delivery            (terminal)
     undelivered  carrier rejected it                   (terminal)
     failed       Twilio/network failure, or canceled   (terminal)
     received     inbound row (/inbound) — never an outbound state
   ============================================================ */

/* Rank of a STORED value. Higher wins; equal or lower is refused.
   'received' sits at terminal so a stray callback can never rewrite
   an inbound row (the route also filters direction=outbound).
   'accepted'/'sending' are never written by this file but ARE in the
   live table from sendSms storing Twilio's verbatim reply, so they
   have to rank too. A value NOT listed here is legacy junk and stays
   overwritable — the route's filter is "not in {rank >= incoming}",
   which lets an unknown value through to be corrected. */
export const STATUS_RANK = {
  pending: 0,
  accepted: 1,
  queued: 1,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
  canceled: 3,
  received: 3,
};

/* Twilio MessageStatus -> { status, rank }, or null for a status we
   don't recognize (log it and ACK; never guess a delivery claim).
   'sending' collapses into 'queued': both mean in flight, and the
   column keeps the five states the business reads.
   'canceled' (a scheduled message killed before send) is a failure
   for our purposes — it did not reach anyone. */
export function mapTwilioStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const status =
    s === "accepted" || s === "scheduled" || s === "queued" || s === "sending" ? "queued"
    : s === "sent" ? "sent"
    : s === "delivered" || s === "read" ? "delivered"
    : s === "undelivered" ? "undelivered"
    : s === "failed" || s === "canceled" || s === "cancelled" ? "failed"
    : "";
  if (!status) return null;
  return { status, rank: STATUS_RANK[status] };
}

/* The stored values this callback may NOT overwrite: everything
   ranked at or above it. Used as PostgREST `status=not.in.(…)` so the
   guard rides IN the UPDATE — two callbacks racing can't read-then-
   write over each other. Sorted for a stable filter string. */
export function blockedStatuses(rank) {
  return Object.keys(STATUS_RANK).filter((k) => STATUS_RANK[k] >= rank).sort();
}
