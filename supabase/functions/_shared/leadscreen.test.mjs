// node --test --experimental-strip-types supabase/functions/_shared/leadscreen.test.mjs
//
// Cases are modeled on the real web-form submissions Aug–Oct 2026. Names,
// phones and emails are swapped for look-alikes; what each rule keys on
// (area code, 555 exchange, digits in a Gmail, the template wording, the
// address shape) is kept exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { screenLead, outOfState, nanp10, screenSummary } from "./leadscreen.ts";

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
});

test("nanp10 normalizes", () => {
  assert.equal(nanp10("+1 (415)555-0142"), "4155550142");
  assert.equal(nanp10("907-371-9868"), "9073719868");
  assert.equal(nanp10("12345"), "");
});

test("summary line", () => {
  const r = screenLead({ phone: "415-555-0142", address: "1 Main St, Austin, TX", message: "hi" });
  assert.equal(r.screened, true);
  assert.match(screenSummary(r), /^Likely spam — fake phone number/);
  assert.equal(screenSummary(screenLead({ phone: "907-451-0000", address: "Fairbanks", message: "leak" })), "");
});
