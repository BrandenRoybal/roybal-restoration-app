/* The work authorization's printed words, for the carrier packet.

   The packet draws the signed Work Authorization & Service Agreement from
   its fields (model.mjs), and the words the owner signed under have to be
   the words the field app showed him: these are copied from
   apps/field/js/forms.js workAuth(), which builds them inline. They are
   copied, not imported, because forms.js builds DOM when it loads and the
   worker has no DOM. test/packet-model.test.mjs reads forms.js as text and
   fails if any string here is no longer found there verbatim, so an edit
   to the form's terms cannot drift away from what the packet prints. */

/* "Terms & Conditions": [heading, paragraph] in the order the form prints them */
export const TERMS = [
  ["Authorization", "By signing, property owner (“Owner”) authorizes Roybal Construction, LLC (“Contractor”) to perform the mitigation and restoration services described above."],
  ["Payment", "Payment is due upon completion or receipt of insurance proceeds. Owner remains responsible for any balance not covered by insurance, including deductibles and depreciation holdbacks."],
  ["Insurance", "Owner agrees to cooperate fully with the claims process, including providing adjuster access and signing any supplemental carrier authorization required."],
  ["Access", "Owner grants Contractor and crew reasonable access during business hours and emergency access as required to prevent further damage."],
  ["Exclusions", "This Work Order covers mitigation only. Reconstruction requires a separate written estimate and authorization. Contractor is not responsible for pre-existing damage unrelated to this loss."],
  ["Right to Stop", "Contractor may stop work if site conditions pose a safety risk, access is denied, or payment cannot be confirmed."],
];

/* "Text Message Consent (Optional)": the checkbox's label, then the links line under it */
export const SMS_CONSENT = "I agree to receive text messages from Roybal Construction, LLC about my job — including technician arrival notices, appointment and walkthrough reminders, equipment-pickup notices, and job-status updates — at the phone number listed above. Message frequency varies. Message and data rates may apply. Consent is not a condition of service. Reply STOP to cancel or HELP for help at any time.";
export const SMS_LINKS = "Terms of Service: app.roybalconstruction.com/terms.html · Privacy Policy: app.roybalconstruction.com/privacy.html";

/* the line above the signature blocks */
export const SIGN_LEAD = "By signing below, the Property Owner confirms they have read and agree to the Terms & Conditions above, and authorize Roybal Construction, LLC to commence the described scope of work.";

/* the signature blocks' titles */
export const OWNER_SIG_LABEL = "Property Owner — sign above";
export const REP_SIG_LABEL = "Contractor Representative (Roybal Construction, LLC)";

/* The consent line as it reads on paper: the form prints a checkbox beside
   the label, ticked or not. Helvetica has no ballot box, so the tick is
   written in brackets, and the owner's answer is said in words before it so
   nobody has to read the box: an unticked box is a "no", never a blank. */
export function smsConsentLine(consent) {
  return consent === true
    ? `Owner opted in: Yes. [X] ${SMS_CONSENT}`
    : `Owner opted in: No. [ ] ${SMS_CONSENT}`;
}
