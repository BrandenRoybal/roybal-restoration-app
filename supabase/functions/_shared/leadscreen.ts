/* Web lead screening: score a website form submission for the tells of a
   scam or a sales pitch, so roybal-lead can keep it OFF the owner's phone
   while still saving it.

   Why this exists: the honeypot and the IP / subnet / hourly limits stop
   bots. They do nothing about a person (or a person-driven script) typing
   a template into the form by hand, which is where the real junk comes
   from. Every rule below came from an actual submission between Aug and
   Oct 2026 (see leadscreen.test.mjs for the cases, scrubbed of contact
   details), and the real customers from the same window are tests that
   must stay unscreened.

   Policy (roybal-lead applies it; alertPlan() and flagNote() at the
   bottom are its pure parts, here so Node can test them):
     - screened  → the lead is still saved and still emailed (subject marked
                   "[Likely spam]"), but NO text, NO CRM contact, title gets
                   a 🚩 so the board shows it. Nothing is ever dropped. When
                   no email can go, it texts: the email is its only alert.
     - emergency → always texted, screened or not, with the flag in front.
                   Damage happening now in the message counts too (the
                   form's emergency button defaults to "No"). A missed
                   flooded basement costs more than a 2-second look.

   Tuning bias: false negatives are cheap (a scam still texts you, like
   today); false positives are expensive (a real customer doesn't). So a
   lead needs 4+ points AND at least one tell that isn't wording (the
   number, the address, the email): phrasing alone never screens anyone,
   and a sales pitch also needs Roybal's own address or a toll-free number.
   Measured: every Aug–Oct 2026 junk lead the tests screen scores 4 or
   more, every real customer 2 or less, and none of ~100 invented real
   customers (formal writers, email-only, military and snowbird cells, PO
   boxes, owners from away, SBA loans, pack-outs) is screened.

   Pure, so it runs in Node:
   node --test --experimental-strip-types supabase/functions/_shared/leadscreen.test.mjs */

export interface ScreenInput {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  service?: string;
  message?: string;
}

export interface ScreenResult {
  score: number;                       // scam-side score
  pitchScore: number;                  // sales-pitch-side score
  screened: boolean;
  kind: "ok" | "scam" | "solicitation";
  reasons: string[];                   // plain English, shown on the card and in the email
}

export const DEFAULT_THRESHOLD = 4;

/* ---------- helpers ---------- */

const digitsOf = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/** 10-digit NANP number, or "" if it isn't one. */
export function nanp10(phone: unknown): string {
  const d = digitsOf(phone);
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return "";
}

const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|zoho)\.[a-z.]+$/i;

const STATES: Record<string, string> = {
  AL: "alabama", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii",
  ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas",
  KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts",
  MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana",
  NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico",
  NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma",
  OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont",
  VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
  DC: "district of columbia",
};
const STATE_NAMES = new Set(Object.values(STATES));

/* Places in and around the service area. Seeing one anywhere in the
   address or message counts as "named a local place". AREA leaves out
   "Alaska" and "AK": an out-of-state address whose message names one of
   these is an owner from away, not a stranger. No surnames (Anderson): a
   sign-off must not make a stranger local. */
const AREA = "fairbanks|fbks|north ?pole|n\\.? ?pole|salcha|ester|fox|two rivers|chena|badger|eielson|moose creek|harding lake|" +
  "delta( junction)?|fort greely|healy|cantwell|nenana|goldstream|farmers loop|college|hill ?top|hamilton acres|" +
  "(fort|ft\\.?) ?wainwright|wainwright|chatanika|livengood|997\\d\\d";
const LOCAL_PLACES = new RegExp(`\\b(${AREA}|alaska|ak)\\b`, "i");
const AREA_PLACES = new RegExp(`\\b(${AREA})\\b`, "i");

/** Which out-of-state state the address names, or "" if none / Alaska / unclear.
    Only the LAST segment of the address counts (", CA", ", Texas 75001",
    or the whole thing when it's just "texas"), so "Washington Dr" or
    "Virginia Ave" in a Fairbanks street address never trips it. A PO Box
    number is not a ZIP, "AK" before a mistyped ZIP is still Alaska, and
    "Moose Ct" / "Aspen La" / "Gillam Wy" are streets, not states. */
export function outOfState(address: unknown): string {
  let a = String(address ?? "").toLowerCase().replace(/\b(united states( of america)?|usa|u\.s\.a?\.?)\b/g, "").trim();
  a = a.replace(/[\s,.]+$/, "");
  if (!a) return "";
  // trailing ZIP decides on its own when present
  const zip = a.match(/\b(\d{5})(-\d{4})?$/);
  if (zip && /\b(box|pob)\s*#?\s*$/.test(a.slice(0, zip.index))) {
    return lastSegmentState(a.slice(0, zip.index).replace(/[\s,.]*((p\.?\s*o\.?\s*)?box|pob)\s*#?\s*$/, ""));
  }
  if (zip) {
    const z = Number(zip[1].slice(0, 3));
    if (z >= 995 && z <= 999) return "";
    a = a.slice(0, zip.index).replace(/[\s,.]+$/, "");
    if (/\b(ak|alaska)$/.test(a)) return "";        // "Fairbanks AK 99071": a typo, not a state
    // ZIP outside Alaska with no state named: still out of state
    const st = lastSegmentState(a);
    return st || `ZIP ${zip[1]}`;
  }
  return lastSegmentState(a);
}

function lastSegmentState(a: string): string {
  const segs = a.split(",").map((s) => s.trim()).filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : "";
  if (!last) return "";
  if (last === "ak" || last === "alaska") return "";
  if (STATE_NAMES.has(last)) return title(last);
  const up = last.toUpperCase();
  if (segs.length > 1 && STATES[up]) return up;           // ", CA" — two letters only after a comma
  // "San Francisco CA" / "Dallas Texas" without a comma
  const m = last.match(/\s([a-z]{2})$/);
  if (segs.length > 1 && m && !STREET_SUFFIX.has(m[1]) && STATES[m[1].toUpperCase()]) return m[1].toUpperCase();
  for (const n of STATE_NAMES) if (segs.length > 1 && last.endsWith(" " + n)) return title(n);
  return "";
}
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const STREET_SUFFIX = new Set(["ct", "la", "wy"]);     // court, lane, way: also CT, LA, WY

/** Alaska ZIP outside the Interior (995xx/996xx/999xx — Anchorage, Mat-Su,
    Kenai, Southeast). Weak: Branden does travel for the right job. */
function outsideInterior(address: unknown): string {
  const m = String(address ?? "").match(/\b(99[5-9]\d\d)(-\d{4})?\s*(,?\s*(usa|united states))?\s*$/i);
  if (!m) return "";
  return m[1].startsWith("997") ? "" : m[1];
}

const OWN_ADDRESSES = /\b(3850\s+royal|2170\s+chateau|3335\s+trailer)\b/i;
const OWNER_PHONE = "9073719868";

/* ---------- phrase rules ----------
   [pattern, points, reason]. Scam-side and pitch-side are scored apart so
   a loan pitch doesn't get called a scam (it isn't one — it's just not a
   customer). Points for each list are capped so one wordy template can't
   run away with the score on phrasing alone. */

type Rule = [RegExp, number, string];

const SCAM_PHRASES: Rule[] = [
  [/\bpreliminary (designs?|sketches)\b|\bstructural sketches\b|\bdesign concepts\b/i, 2, "\"preliminary designs/sketches ready\" template"],
  [/\bon behalf of one of (our|my) companies\b/i, 2, "\"on behalf of one of our companies\" template"],
  // the everyday forms of those two: how real commercial customers write too
  [/\bon behalf of (our|my) company\b|\bpreliminary (plans|drawings)\b/i, 1, "formal business opener"],
  [/\bif you are in this field\b/i, 2, "\"if you are in this field\" template"],
  [/\bnewly acquired property\b/i, 2, "\"newly acquired property\" template"],
  [/\bi am writing to inquire about\b/i, 1, "\"I am writing to inquire about…\""],
  [/\bappropriate team\b/i, 1, "asks for \"the appropriate team\""],
  [/\bcontact me by e-?mail\b|\breach me (is )?(through|via|by|at) (my )?(e-?mail|gmail)\b|\bsend me a dm\b|\be-?mail only\b/i, 1, "asks for email-only contact"],
  [/\bkindly\b/i, 1, "\"kindly\" (common in scam scripts)"],
  [/\bat your earliest convenience\b/i, 1, "\"at your earliest convenience\""],
  [/\bi hope (you('|’)re|you are|this (message|email) finds you) (doing )?well\b/i, 1, "generic \"hope you're doing well\" opener"],
  // both halves of the overpayment scam: a check or wire AND paying someone
  // else out of it. Either alone is ordinary ("insurance pays the movers").
  [/^(?=[\s\S]*\b((certified|cashier'?s) check|wire (the )?(funds|money|transfer)))(?=[\s\S]*\bpay(ing)? (my|the|a) (sub|supplier|designer|architect|mover)s?\b)/i, 3, "payment-routing language (a check or wire, then pay a third party)"],
];
const SCAM_PHRASE_CAP = 4;

const PITCH_PHRASES: Rule[] = [
  [/\bbusiness (lines? of credit|loans?|funding|financing)\b|\bsba express\b|\bmerchant cash\b|\bworking capital\b/i, 2, "business-loan pitch"],
  [/\bgoogle ads\b|\bseo (services|campaigns?|packages?)\b|\bad spend\b|\bmanagement fee\b|\brank(ing)? (higher |#?1 )?on google\b|\bmore (leads|customers|jobs) for your business\b/i, 2, "marketing / ads pitch"],
  [/\bare you (currently )?taking on (extra|more|new)\b|\broom on your calendar\b|\bhigh[- ]ticket\b|\bpure profit\b/i, 2, "lead-gen sales script"],
  [/\bran across (roybal|your (business|company))\b|\blooking at businesses in your area\b/i, 2, "\"ran across your business\" cold-outreach opener"],
  [/\bwebsite (design|redesign|development)\b|\bweb ?design services\b|\bsocial media management\b/i, 2, "website / social media pitch"],
];
const PITCH_PHRASE_CAP = 6;
const OFFERS = new Set(["business-loan pitch", "marketing / ads pitch", "website / social media pitch"]);

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/* ---------- the scorer ---------- */

export function screenLead(input: ScreenInput, threshold: number = DEFAULT_THRESHOLD): ScreenResult {
  const found: [number, string][] = [];   // [points, reason], sorted strongest-first at the end
  let score = 0;
  let pitch = 0;
  let nonPhrase = 0;                    // scam points that aren't wording
  let pitchTell = 0;                    // pitch tells that aren't wording
  const add = (n: number, why: string) => { score += n; found.push([n, why]); };
  const addTell = (n: number, why: string) => { nonPhrase += n; add(n, why); };
  const addPitch = (n: number, why: string) => { pitch += n; found.push([n, why]); };

  const phone10 = nanp10(input.phone);
  const area = phone10.slice(0, 3);
  const email = String(input.email ?? "").trim().toLowerCase();
  const address = String(input.address ?? "");
  const message = String(input.message ?? "");
  const text = `${address}\n${message}`;

  // The owner testing his own form is never screened.
  if (phone10 === OWNER_PHONE) return { score: 0, pitchScore: 0, screened: false, kind: "ok", reasons: [] };

  // --- hard tells ---
  if (phone10 && phone10.slice(3, 6) === "555") addTell(3, `fake phone number (555-${phone10.slice(6)} is reserved for movies/TV)`);

  // An out-of-state address is one point: an owner, heir or adjuster from
  // away types where THEY live, and their Outside cell already says so. A
  // local town anywhere in the lead makes it wording-weight only.
  const st = outOfState(address);
  if (st && AREA_PLACES.test(text)) add(1, `address is out of state (${st}), but the lead names a local place`);
  else if (st) addTell(1, `address is out of state (${st})`);
  else {
    const z = outsideInterior(address);
    if (z) addTell(1, `Alaska address outside the Interior (ZIP ${z})`);
  }

  if (OWN_ADDRESSES.test(address)) { pitchTell++; addPitch(2, "used Roybal's own address as theirs"); }

  // --- soft tells ---
  const nonLocalPhone = !!phone10 && area !== "907";
  if (nonLocalPhone) {
    if (TOLL_FREE.has(area)) { pitchTell++; addPitch(1, `toll-free number (${area})`); }
    else if (!st) addTell(1, `non-Alaska phone number (${area})`);   // with an Outside address, the same fact
  }
  // A numbered free email only means something next to an outside number:
  // plenty of real Fairbanks customers are bob1975@gmail.com.
  if (nonLocalPhone && FREEMAIL.test(email) && /\d{2,}/.test(email.split("@")[0])) {
    addTell(1, "numbered free email with an out-of-area phone");
  }

  // A different email in the message than the free one on the form: "reply
  // to my other address" or signing as a business while sending from Gmail.
  // A work address at a .gov / .mil / .edu / .us is a real person's job, and
  // a manager or realtor cc'ing an owner is ordinary, so it's worth one point.
  const inText = (message.match(EMAIL_IN_TEXT) ?? []).map((s) => s.toLowerCase()).filter((s) => s !== email);
  if (email && inText.length && FREEMAIL.test(email) && !/\.(gov|mil|edu|us)$/.test(inText[0])) {
    const other = inText[0];
    const sameDomain = other.split("@")[1] === email.split("@")[1];
    addTell(1, sameDomain
      ? `message asks for replies at a different address (${other}) than the form email`
      : FREEMAIL.test(email)
        ? `signs as a business (${other.split("@")[1]}) but sent from a personal email`
        : `message gives a different email (${other}) than the form`);
  }

  // Only a blank address: the form's autofill gives a street line with no
  // town, which is normal. Wording, not a tell, so it can't screen alone.
  if (!address.trim() && !LOCAL_PLACES.test(text)) add(1, "no address and no Fairbanks-area place named");

  // --- phrasing ---
  // 1-point rules are stock phrasing real people use too: together they
  // are worth one point, never more.
  let phraseScam = 0;
  let stock = false;
  for (const [re, pts, why] of SCAM_PHRASES) {
    if (!re.test(message) || phraseScam >= SCAM_PHRASE_CAP) continue;
    if (pts === 1) { if (stock) continue; stock = true; }
    const take = Math.min(pts, SCAM_PHRASE_CAP - phraseScam);
    phraseScam += take; add(take, why);
  }
  let phrasePitch = 0;
  for (const [re, pts, why] of PITCH_PHRASES) {
    if (re.test(message) && phrasePitch < PITCH_PHRASE_CAP) {
      const take = Math.min(pts, PITCH_PHRASE_CAP - phrasePitch);
      phrasePitch += take; addPitch(take, why);
    }
  }

  const scamHit = score >= threshold && nonPhrase >= 1;
  // A pitch also needs a tell that isn't wording (Roybal's own address, a
  // toll-free number) and something actually on offer (a loan, ads, a
  // website), or Roybal's own address: plenty of real customers and
  // property managers "ran across your company" and ask "are you taking on
  // new clients".
  const offer = OWN_ADDRESSES.test(address) || PITCH_PHRASES.some(([re, , why]) => OFFERS.has(why) && re.test(message));
  const pitchHit = pitch >= threshold && pitchTell >= 1 && offer;
  const kind: ScreenResult["kind"] =
    pitchHit && (pitch >= score || !scamHit) ? "solicitation"
    : scamHit ? "scam"
    : "ok";
  const reasons = found.map((f, i) => [f[0], i, f[1]] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((f) => f[2]);
  return { score, pitchScore: pitch, screened: kind !== "ok", kind, reasons };
}

/** "Likely spam" / "Sales pitch", or "" when not screened. */
export function screenLabel(r: ScreenResult): string {
  if (!r.screened) return "";
  return r.kind === "solicitation" ? "Sales pitch" : "Likely spam";
}

/** One line for the card and the notes: "Likely spam — fake phone number; address is out of state (CA)". */
export function screenSummary(r: ScreenResult, max = 3): string {
  if (!r.screened) return "";
  return `${screenLabel(r)} — ${r.reasons.slice(0, max).join("; ")}${r.reasons.length > max ? "; …" : ""}`;
}

/* ---------- the text decision ---------- */

/* Damage happening now, in the customer's own words. */
const ACTIVE_DAMAGE = new RegExp("\\b(" + [
  "burst(ing)?", "flood(s|ing|ed)?", "sewage", "sewer backup", "backing up", "backed up", "on fire",
  "water (is )?(everywhere|pouring|coming (in|through|down))", "pouring (in|through|down)",
  "drip(s|ping)", "leaking", "overflow(s|ed|ing)?", "(pipe|line|main)s? (broke|split|cracked)",
  "broken (pipe|line|water)", "spraying", "running down", "caving in", "standing water",
  "coming through the (ceiling|wall|floor)",
].join("|") + ")\\b", "i");

export interface AlertInput {
  emergency: boolean;        // the form's emergency button
  message?: string;
  screened: boolean;
  repeat: boolean;           // an earlier submission from this phone or email texted in the last 24h
  emailCanGo: boolean;       // the lead email will be filed
  emailCapped?: boolean;     // ...and if it won't, because the hourly cap is hit (a flood)
}
export interface AlertPlan {
  text: boolean;
  why: "lead" | "emergency" | "damage" | "no-email" | "screened" | "repeat";
}

/** Whether roybal-lead texts the owner, and why. */
export function alertPlan(a: AlertInput): AlertPlan {
  if (a.emergency) return { text: true, why: "emergency" };
  if (ACTIVE_DAMAGE.test(a.message ?? "")) return { text: true, why: "damage" };
  if (a.repeat) return { text: false, why: "repeat" };
  if (!a.screened) return { text: true, why: "lead" };
  // A screened lead's email is its only alert. Without one it texts, except
  // past the hourly cap, which means a flood of them.
  if (!a.emailCanGo && !a.emailCapped) return { text: true, why: "no-email" };
  return { text: false, why: "screened" };
}

/** The flag roybal-lead adds to the end of a screened or repeat lead's
    notes (after the customer's message, so the office app still reads the
    form's lines), or "" for an ordinary lead. */
export function flagNote(screen: ScreenResult | null, repeat: boolean, plan: AlertPlan): string {
  const texted = plan.why === "emergency" ? "texted anyway: the customer marked it an emergency"
    : plan.why === "damage" ? "texted anyway: the message describes damage happening now"
    : plan.why === "no-email" ? "texted anyway: the email alert might not go out"
    : "";
  if (screen && screen.screened) {
    return `🚩 ${screenSummary(screen, 6)}\n(Auto-screened, ${texted || "no text was sent"}. If this is a real customer, work it normally.)`;
  }
  if (repeat) {
    return `Repeat: this phone or email already came in through the form, and texted you, in the last 24 hours.` +
      (plan.text && texted ? ` This one ${texted.replace(/^texted anyway/, "texted too")}.` : "");
  }
  return "";
}
