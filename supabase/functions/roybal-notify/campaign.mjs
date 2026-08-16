/* ============================================================
   CF-5 campaign lane — the budget + consent gate (pure).

   The CRM design's promise (§8 CF-5): a campaign kind with its own
   monthly ceiling, refused BEFORE it touches the shared pool's
   reserve floor — a 200-send September campaign must never starve
   the owner-alert / brief / lead-alert lanes or trip the public
   lanes' cutoff. And consent is enforced HERE, at the send layer:
   an upstream segmentation bug cannot text a person who never
   opted in, because the send itself refuses.

   Pure decision function — no Deno, no network — imported by the
   edge function and the node test alike (the crewtoday.mjs
   pattern).

   contact: null when the number doesn't resolve to exactly one
   live contact, else { id, optIn }.
   Caps of 0 mean "no ceiling on this check" (mirrors
   SMS_MONTHLY_CAP's `> 0 &&` convention); consent is never
   waivable.
   ============================================================ */
export function campaignGate({ used, cap, reserve, campaignUsed, campaignCap, contact }) {
  if (!contact) {
    return { ok: false, error:
      "campaign_consent: this number doesn't match exactly one contact — campaign texts only go to known contacts." };
  }
  if (contact.optIn !== true) {
    return { ok: false, error:
      "campaign_consent: this contact has not opted into marketing texts (marketing_opt_in) — not sent." };
  }
  if (campaignCap > 0 && campaignUsed >= campaignCap) {
    return { ok: false, error:
      `campaign_cap_reached: ${campaignUsed} of ${campaignCap} campaign texts this month — ` +
      `raise SMS_CAMPAIGN_CAP if this campaign is intended.` };
  }
  if (cap > 0 && used >= cap - reserve) {
    return { ok: false, error:
      `campaign_reserve: ${used} of ${cap} shared texts used — campaigns stop at the reserve floor ` +
      `(${reserve} held for the phone/alert lanes) so outreach can never starve an owner alert.` };
  }
  return { ok: true };
}
