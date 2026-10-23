// node --test --experimental-strip-types supabase/functions/_shared/leadscreen.test.mjs
//
// Cases are modeled on the real web-form submissions Aug–Oct 2026. Names,
// phones and emails are swapped for look-alikes; what each rule keys on
// (area code, 555 exchange, digits in a Gmail, the template wording, the
// address shape) is kept exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { screenLead, outOfState, nanp10, screenSummary, screenLabel, alertPlan, flagNote } from "./leadscreen.ts";

const scam = (r) => { assert.equal(r.screened, true, JSON.stringify(r)); assert.equal(r.kind, "scam", JSON.stringify(r)); };
const pitch = (r) => { assert.equal(r.screened, true, JSON.stringify(r)); assert.equal(r.kind, "solicitation", JSON.stringify(r)); };
const ok = (r) => assert.equal(r.screened, false, JSON.stringify(r));

/* ---------------- junk that must be screened ---------------- */

test("Oct 22 — 555 number, San Francisco, 'preliminary designs', signs as a business from Gmail", () => {
  scam(screenLead({
    name: "Vince Eaton", phone: "+1 (415)555-0142", email: "vinceeaton738@gmail.com",
    address: "180 Mission Street, San Francisco, CA", service: "Residential Remodeling",
    message: "Hello,\n\nI would like to arrange a consultation regarding an upcoming construction project. I have the preliminary designs and structural sketches ready for review.\n\nPlease have the appropriate team contact me by email at their earliest convenience to discuss the project and next steps.\n\nThank you.\n\nVince Eaton\nOwner | Metro Builders\noffice@metrobuildersx.com",
  }));
});

test("Oct 20 — address is just 'texas', reply-to-my-other-gmail, 'if you are in this field'", () => {
  scam(screenLead({
    name: "Paul Carry", phone: "14754078600", email: "paulcarry610@gmail.com", address: "texas",
    message: "I need someone who is a professional in interior painting for my home . if you are in this field or you have a recommendation.\n The best way to reach me is through my gmail which is paulycarry610@gmail.com. Kindly send me a DM in my inbox.",
  }));
});

test("Oct 16 — 'on behalf of one of our companies', Florida number, no city", () => {
  scam(screenLead({
    name: "Glenn Stevens", phone: "13522333100", email: "sglenn0087@gmail.com", address: "13837 Hemlock Dr, apt a3",
    message: "Hello,\nI'm reaching out on behalf of one of our companies because we are in urgent need of professional home restoration and drywall repair services. Could you please let us know your earliest availability, estimated pricing, and the next steps?",
  }));
});

test("Sep 19 — Anchorage + Florida number kitchen template only scores 3: still texts (duplicate guard catches its double submit)", () => {
  ok(screenLead({
    name: "Ed Weis", phone: "5618152100", email: "ed.weis1@outlook.com", address: "6327 Blackberry St, Anchorage, AK 99502",
    message: "Hello,\n\nI hope you're doing well.\n\nI'm planning to remodel my kitchen and am interested in learning more about your kitchen remodeling and cabinet services. Could you please let me know if you offer on-site consultations and estimates? I also have some pictures showing how I would like the kitchen to look.\n\nPlease let me know your availability and the next steps.",
  }));
});

test("Aug 23 — 'I am writing to inquire about', Tampa number, no address", () => {
  scam(screenLead({
    name: "Kingsley Wells", phone: "6562010500", email: "kingsleywells023@gmail.com", address: "",
    message: "I am writing to inquire about building a new home and would appreciate the opportunity to discuss your services and the process involved. Please contact me at your earliest convenience.",
  }));
});

test("Sep 12 — business line-of-credit pitch from a toll-free number", () => {
  pitch(screenLead({
    name: "Gemma R", phone: "800-877-5100", email: "gemma@crunchcapitalx.com", address: "160 S Old Springs Rd",
    message: "Hi, this is Gemma from Crunch Capital. I ran across Roybal Construction while looking at businesses in your area and wanted to say hello. We specialize in business lines of credit and SBA Express loans.",
  }));
});

test("Sep 6 — Google Ads pitch using Roybal's own address", () => {
  pitch(screenLead({
    name: "Arb W", phone: "7045611200", email: "contact@luminarlinkx.com", address: "3850 Royal Rd, Fairbanks, AK 99701, United States",
    message: "Are you currently taking on extra roof replacement and repair jobs in Fairbanks Ak right now? I build and manage targeted Google Ads campaigns. Closing one job covers your ad spend and my flat monthly management fee. Everything after that is pure profit.",
  }));
});

/* ---------------- real customers that must NOT be screened ---------------- */

test("real: local realtor, 907, Richardson Hwy, names Fairbanks and Salcha", () => {
  ok(screenLead({
    name: "Mel B", phone: "9076997000", email: "melakproperties@gmail.com", address: "11205 Richardson Hwy",
    message: "Hello, I am a real estate licensee here in Fairbanks and am working on selling the old lounge out in Salcha. The building has some water damage from a roof leak. Wanted to get a rough estimate for my seller.",
  }));
});

test("real: Century 21 agent, 907, numbered Gmail, street with no city", () => {
  ok(screenLead({
    name: "Matt W", phone: "9079780100", email: "matwadec21@gmail.com", address: "3170 Brookview Ln",
    message: "Agent with Century21 Gold Rush, representing seller. Inspection found standing water in the crawlspace and corroded steel. Need an estimate for buyer information. If you cannot help, could you recommend others?",
  }));
});

test("real: Arizona cell (snowbird owner), Yahoo, short message, street with no city", () => {
  ok(screenLead({
    name: "Doug D", phone: "15208913500", email: "doug_d_d@yahoo.com", address: "319 Charles Street",
    message: "Had some leaks over the winter.  Thought we had someone to fix it, but it fell through.",
  }));
});

test("real: local with a numbered Gmail and a full Fairbanks address", () => {
  ok(screenLead({
    name: "Bob K", phone: "907-451-0000", email: "bobk1975@gmail.com", address: "1234 Farmers Loop Rd, Fairbanks, AK 99709",
    message: "Pipe burst in the crawlspace this morning, water everywhere. Kindly call me asap.",
  }));
});

test("real: out-of-state owner of a Fairbanks rental", () => {
  ok(screenLead({
    name: "Tara L", phone: "206-382-4410", email: "tara.l@outlook.com",
    address: "512 Lacey St, Fairbanks, AK 99701",
    message: "I own this rental and live in Seattle. My tenant says the bathroom ceiling is dripping. Can you take a look? Tenant can let you in.",
  }));
});

test("owner testing his own form is never screened", () => {
  ok(screenLead({ name: "Branden", phone: "907-371-9868", address: "180 Mission St, San Francisco, CA", message: "test" }));
});

test("wording alone never screens a local number at a local address", () => {
  ok(screenLead({
    name: "Dale R", phone: "9075484300", email: "daler55@gmail.com", address: "431 Birch Hill Rd, Fairbanks, AK 99712",
    message: "We are seeking an experienced design professional to collaborate on the comprehensive renovation of a newly acquired property. We have developed preliminary sketches and design concepts.",
  }));
});

test("snowbird owner stays clear even with stock phrasing", () => {
  ok(screenLead({
    name: "Doug D", phone: "15208913500", email: "doug_d_d@yahoo.com", address: "319 Charles Street",
    message: "I hope you're doing well. Had some leaks over the winter, please call me at your earliest convenience.",
  }));
});

/* ------- real customers a review of this scorer found it screening (invented) -------
   Each one tripped a rule that was too broad; each must keep texting. */

const REAL = {
  "formal writer, 907, street with no town": { phone: "907-479-6612", email: "hjensen@acsalaska.net", address: "1234 Gold Mine Trail",
    message: "I am writing to inquire about having our upstairs bathroom remodeled. Please call me at your earliest convenience. Thank you." },
  "works nights, wants email, 907, street only": { phone: "907-457-3390", address: "2711 Ballaine Rd",
    message: "Need a quote for a new deck. I work nights, so please contact me by email. Kindly include your availability." },
  "emergency typed in, button left on No": { phone: "907-479-6630", address: "2290 Bridgewater Dr",
    message: "I am writing to inquire about emergency water extraction: our basement is flooding right now from a broken line. Please call me at your earliest convenience." },
  "PCSing family, 910 cell, numbered Gmail, Fort Wainwright": { phone: "910-489-3321", email: "mdorsey1990@gmail.com", address: "4421 Neely Rd, Fort Wainwright",
    message: "Hi, I hope you are doing well. We are PCSing in March and need the interior of our house painted before we list it." },
  "snowbird, birth-year Yahoo, street only, stock phrases": { phone: "520-891-3500", email: "dougdahl1952@yahoo.com", address: "319 Charles Street",
    message: "I hope you're doing well. Had some leaks over the winter, please call me at your earliest convenience." },
  "airman, 757 cell, wants email": { phone: "757-418-2290", email: "ray.hollis88@yahoo.com", address: "3301 Moose Creek Rd",
    message: "Stationed at Eielson. Our place in Moose Creek has a leaking roof. Please contact me by email, I'm on shift a lot." },
  "found your company, taking on new projects": { phone: "907-347-1022", email: "amystrand@gmail.com", address: "2290 Hanson Rd, Fairbanks, AK 99709",
    message: "Hi! I found your company on Google. Are you taking on new projects this winter? We want to redo our kitchen cabinets and counters." },
  "flood victim with an SBA disaster loan": { phone: "907-488-1145", address: "3210 Repp Rd, North Pole, AK 99705",
    message: "Are you taking on new jobs? Our basement flooded in the August flood. We were approved for an SBA disaster loan and found your company through a neighbor." },
  "home equity line of credit": { phone: "907-479-7712", address: "3311 Chena Ridge Rd, Fairbanks, AK 99709",
    message: "We're financing the addition with a home equity line of credit. Are you taking on new projects for next summer?" },
  "sign-off surname Seo": { phone: "907-452-3381", email: "hanaseo@gmail.com", address: "1450 Gillam Way, Fairbanks, AK 99701",
    message: "Hello, are you taking on new kitchen projects this spring? We'd like new cabinets. Thank you, Hana Seo" },
  "property manager on a toll-free office line": { phone: "800-421-6600", address: "1101 Noble St, Fairbanks, AK 99701",
    message: "I manage several properties in Fairbanks and came across your company. Are you taking on new clients? We need a vendor for water damage calls." },
  "PO Box only": { phone: "907-488-2201", address: "PO Box 71542", message: "Kindly send someone to look at a roof leak." },
  "mistyped ZIP after AK": { phone: "907-452-1100", address: "1622 Gillam Way, Fairbanks AK 99071", message: "Kindly call about a bathroom remodel." },
  "a court, not Connecticut": { phone: "907-322-4410", address: "Lot 23, Moose Ct", message: "Kindly call about a leaking skylight." },
  "contents pack-out: insurance pays the movers": { phone: "907-374-2210", address: "1421 Stacia St",
    message: "Hello, I am writing to inquire about a contents pack-out after our flood. The adjuster said insurance will pay the movers." },
  "snowbird pays by cashier's check": { phone: "928-301-4471", email: "earlpoole47@aol.com", address: "2210 Hilltop Rd",
    message: "I hope you are doing well. I'm in Arizona for the winter and can mail a cashier's check for the deposit." },
  "owner from away typed their own address": { phone: "208-344-1290", address: "4410 W Hill Rd, Boise, ID 83703",
    message: "My rental at 512 Lacey St in Fairbanks has frozen pipes. Tenant can let you in." },
  "borough employee gives her work email": { phone: "907-459-1000", email: "bethkline@gmail.com", address: "1880 Bridgewater Dr",
    message: "I hope you're doing well. You can also reach me at bkline@fnsb.gov during the day." },
  "soldier from away gives an army.mil address": { phone: "915-203-1150", email: "lortega1985@gmail.com", address: "1188 Wolverine Ln",
    message: "I hope you're doing well. My work email is luis.ortega@army.mil if that's easier." },
  // a second look
  "landlord from away names the street, not the town": { phone: "512-334-8812", email: "mgarza@austinrealty.com", address: "2201 Barton Springs Rd, Austin, TX 78704",
    message: "Tenant at my rental on Lemeta St says water is dripping from the bathroom ceiling. They can let you in. Please call me." },
  "heir from away, a stock phrase": { phone: "206-731-4418", email: "tlindqvist1961@gmail.com", address: "1415 Elm Ave, Seattle, WA 98101",
    message: "I hope you are doing well. My late mother's house needs the carpet and drywall replaced before we sell it." },
  "ZIP typo with no AK": { phone: "907-456-8823", address: "1622 Gillam Way, Fairbanks 99071", message: "Need the house exterior painted next summer. Please call me at your earliest convenience." },
  "AK typed as AL": { phone: "907-479-6612", address: "1234 Farmers Loop Rd, Fairbanks, AL", message: "Interior painting quote please. Kindly call after 5." },
  "POB box number": { phone: "907-488-3302", address: "POB 71542", message: "Cabin roof leak, kindly call." },
  "store facilities manager from Outside": { phone: "614-221-7800", email: "facilities@northlandretailco.com", address: "560 Merhar Ave, Fairbanks, AK 99701",
    message: "On behalf of our company, we are requesting a bid to repair water-damaged drywall in the stockroom of our Fairbanks store. Please respond at your earliest convenience." },
  "property manager on a toll-free line who ran across Roybal": { phone: "800-421-6600", email: "vendors@northstarpm.com", address: "1101 Noble St, Fairbanks, AK 99701",
    message: "I manage several properties in Fairbanks and ran across your company online. Are you taking on new clients? We need a vendor for water damage calls." },
};
for (const [label, input] of Object.entries(REAL)) test(`real (review): ${label}`, () => ok(screenLead(input)));

/* ---------------- the parts ---------------- */

test("outOfState reads only the last segment", () => {
  assert.equal(outOfState("180 Mission Street, San Francisco, CA"), "CA");
  assert.equal(outOfState("texas"), "Texas");
  assert.equal(outOfState("12 Main St, Dallas, Texas 75001"), "Texas");
  assert.equal(outOfState("12 Main St, Reno NV 89501"), "NV");
  assert.equal(outOfState("12 Main St 30301"), "ZIP 30301");
  assert.equal(outOfState("1234 Washington Dr, Fairbanks, AK 99709"), "");
  assert.equal(outOfState("88 Virginia Ave"), "");
  assert.equal(outOfState("3850 Royal Rd, Fairbanks, AK 99701, United States"), "");
  assert.equal(outOfState("6327 Blackberry St, Anchorage, AK 99502"), "");
  assert.equal(outOfState(""), "");
  // a box number is not a ZIP, AK before a mistyped ZIP is Alaska, a court / lane / way is a street
  assert.equal(outOfState("PO Box 71542"), "");
  assert.equal(outOfState("P.O. Box 56489"), "");
  assert.equal(outOfState("PO Box 1234, Tucson, AZ 85712"), "AZ");
  assert.equal(outOfState("POB 71542"), "");
  assert.equal(outOfState("1622 Gillam Way, Fairbanks AK 99071"), "");
  assert.equal(outOfState("Lot 23, Moose Ct"), "");
  assert.equal(outOfState("Lot 5, Aspen La"), "");
  assert.equal(outOfState("12 Elm, Hartford, CT"), "CT");
});

test("nanp10 normalizes", () => {
  assert.equal(nanp10("+1 (415)555-0142"), "4155550142");
  assert.equal(nanp10("907-371-9868"), "9073719868");
  assert.equal(nanp10("12345"), "");
});

test("a pitch needs Roybal's own address or a toll-free number, not wording alone", () => {
  const words = "Are you currently taking on extra jobs? I build Google Ads campaigns. I ran across your business online.";
  ok(screenLead({ phone: "907-455-1122", address: "905 Cushman St, Fairbanks, AK 99701", message: words }));
  pitch(screenLead({ phone: "888-410-0100", address: "905 Cushman St, Fairbanks, AK 99701", message: words }));
});

test("the text decision", () => {
  const base = { emergency: false, message: "leak", screened: false, repeat: false, emailCanGo: true };
  assert.deepEqual(alertPlan(base), { text: true, why: "lead" });
  assert.deepEqual(alertPlan({ ...base, screened: true }), { text: false, why: "screened" });
  assert.deepEqual(alertPlan({ ...base, repeat: true }), { text: false, why: "repeat" });
  // an emergency, by the button or in their words, always texts
  assert.deepEqual(alertPlan({ ...base, screened: true, repeat: true, emergency: true }), { text: true, why: "emergency" });
  for (const m of ["Pipe burst upstairs", "basement is flooding", "water is pouring through the light", "sewage backing up into the tub",
    "Tenant says water is dripping from the bathroom ceiling", "We have a flood in the basement", "Frozen pipe split and is spraying water",
    "Toilet overflowed upstairs", "Our basement has standing water from the storm"])
    assert.deepEqual(alertPlan({ ...base, screened: true, message: m }), { text: true, why: "damage" }, m);
  // a screened lead whose email can't go texts, unless that's the hourly cap (a flood)
  assert.deepEqual(alertPlan({ ...base, screened: true, message: "Quote for new flooring" }), { text: false, why: "screened" });
  assert.deepEqual(alertPlan({ ...base, screened: true, emailCanGo: false }), { text: true, why: "no-email" });
  assert.deepEqual(alertPlan({ ...base, screened: true, emailCanGo: false, emailCapped: true }), { text: false, why: "screened" });
  // a repeat's earlier lead already texted, so no email is no reason to text again
  assert.deepEqual(alertPlan({ ...base, repeat: true, emailCanGo: false }), { text: false, why: "repeat" });
});

test("the flag note says what really happened", () => {
  const r = screenLead({ phone: "415-555-0142", address: "1 Main St, Austin, TX", message: "hi" });
  const held = flagNote(r, false, alertPlan({ emergency: false, message: "hi", screened: true, repeat: false, emailCanGo: true }));
  assert.match(held, /^🚩 Likely spam — fake phone number/);
  assert.match(held, /\n\(Auto-screened, no text was sent\. If this is a real customer, work it normally\.\)$/);
  assert.match(flagNote(r, false, alertPlan({ emergency: true, screened: true, repeat: false, emailCanGo: true })), /Auto-screened, texted anyway: the customer marked it an emergency\./);
  assert.match(flagNote(r, false, alertPlan({ emergency: false, screened: true, repeat: false, emailCanGo: false })), /texted anyway: the email alert might not go out/);
  assert.equal(flagNote(null, true, { text: false, why: "repeat" }), "Repeat: this phone or email already came in through the form, and texted you, in the last 24 hours.");
  assert.match(flagNote(null, true, { text: true, why: "damage" }), /This one texted too: the message describes damage happening now\.$/);
  assert.equal(flagNote(null, false, { text: true, why: "lead" }), "");
  assert.equal(screenLabel(r), "Likely spam");
});

test("summary line", () => {
  const r = screenLead({ phone: "415-555-0142", address: "1 Main St, Austin, TX", message: "hi" });
  assert.equal(r.screened, true);
  assert.match(screenSummary(r), /^Likely spam — fake phone number/);
  assert.equal(screenSummary(screenLead({ phone: "907-451-0000", address: "Fairbanks", message: "leak" })), "");
});
