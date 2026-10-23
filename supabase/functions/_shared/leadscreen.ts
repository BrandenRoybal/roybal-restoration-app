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

   Policy, decided in roybal-lead, not here:
     - screened  → the lead is still saved and still emailed (subject marked
                   "[Likely spam]"), but NO text, NO CRM contact, title gets
                   a 🚩 so the board shows it. Nothing is ever dropped.
     - emergency → always texted, screened or not, with the flag in front.
                   A missed flooded basement costs more than a 2-second look.

   Tuning bias: false negatives are cheap (a scam still texts you, like
   today); false positives are expensive (a real customer doesn't). So a
   lead needs 4+ points AND at least one tell that isn't wording (the
   number, the address, the email) — scam phrasing alone never screens a
   local number at a local address. Measured on the Aug–Oct 2026 leads:
   every junk lead but one scored 5+, every real customer 2 or less.

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
   address or message counts as "named a local place". */
const LOCAL_PLACES = /\b(fairbanks|north pole|salcha|ester|fox|two rivers|chena|badger|eielson|moose creek|harding lake|delta( junction)?|healy|nenana|goldstream|farmers loop|college|hill ?top|alaska|ak|997\d\d)\b/i;

/** Which out-of-state state the address names, or "" if none / Alaska / unclear.
    Only the LAST segment of the address counts (", CA", ", Texas 75001",
    or the whole thing when it's just "texas"), so "Washington Dr" or
    "Virginia Ave" in a Fairbanks street address never trips it. */
export function outOfState(address: unknown): string {
  let a = String(address ?? "").toLowerCase().replace(/\b(united states( of america)?|usa|u\.s\.a?\.?)\b/g, "").trim();
  a = a.replace(/[\s,.]+$/, "");
  if (!a) return "";
  // trailing ZIP decides on its own when present
  const zip = a.match(/\b(\d{5})(-\d{4})?$/);
  if (zip) {
    const z = Number(zip[1].slice(0, 3));
    if (z >= 995 && z <= 999) return "";
    a = a.slice(0, zip.index).replace(/[\s,.]+$/, "");
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
  if (segs.length > 1 && m && STATES[m[1].toUpperCase()]) return m[1].toUpperCase();
  for (const n of STATE_NAMES) if (segs.length > 1 && last.endsWith(" " + n)) return title(n);
  return "";
}
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

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
  [/\bpreliminary (designs?|sketches|plans|drawings)\b|\bstructural sketches\b|\bdesign concepts\b/i, 2, "\"preliminary designs/sketches ready\" template"],
  [/\bon behalf of (one of )?(our|my) compan(y|ies)\b/i, 2, "\"on behalf of one of our companies\" template"],
  [/\bif you are in this field\b/i, 2, "\"if you are in this field\" template"],
  [/\bnewly acquired property\b/i, 2, "\"newly acquired property\" template"],
  [/\bi am writing to inquire about\b/i, 2, "\"I am writing to inquire about…\" template"],
  [/\bappropriate team\b/i, 1, "asks for \"the appropriate team\""],
  [/\bcontact me by e-?mail\b|\breach me (is )?(through|via|by|at) (my )?(e-?mail|gmail)\b|\bsend me a dm\b|\be-?mail only\b/i, 2, "asks for email-only contact"],
  [/\bkindly\b/i, 1, "\"kindly\" (common in scam scripts)"],
  [/\bat your earliest convenience\b/i, 1, "\"at your earliest convenience\""],
  [/\bi hope (you('|’)re|you are|this (message|email) finds you) (doing )?well\b/i, 1, "generic \"hope you're doing well\" opener"],
  [/\b(certified|cashier'?s) check\b|\bwire (the )?(funds|money|transfer)\b|\bzelle\b|\bpay(ing)? (my|the|a) (sub|supplier|designer|architect|mover)s?\b/i, 3, "payment-routing language (check / wire / pay a third party)"],
];
const SCAM_PHRASE_CAP = 4;

const PITCH_PHRASES: Rule[] = [
  [/\blines? of credit\b|\bsba\b|\bbusiness (loan|funding|financing)\b|\bmerchant cash\b|\bworking capital\b/i, 2, "business-loan pitch"],
  [/\bgoogle ads\b|\bseo\b|\bad spend\b|\bmanagement fee\b|\brank(ing)? (higher |#?1 )?on google\b|\bmore (leads|customers|jobs) for your business\b/i, 2, "marketing / ads pitch"],
  [/\bare you (currently )?taking on (extra|more|new)\b|\broom on your calendar\b|\bhigh[- ]ticket\b|\bpure profit\b/i, 2, "lead-gen sales script"],
  [/\b(ran across|came across|found) (roybal|your (business|company))\b|\blooking at businesses in your area\b/i, 2, "\"came across your business\" cold-outreach opener"],
  [/\bwebsite (design|redesign|development)\b|\bweb ?design services\b|\bsocial media management\b/i, 2, "website / social media pitch"],
];
const PITCH_PHRASE_CAP = 6;

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/* ---------- the scorer ---------- */

export function screenLead(input: ScreenInput, threshold: number = DEFAULT_THRESHOLD): ScreenResult {
  const found: [number, string][] = [];   // [points, reason], sorted strongest-first at the end
  let score = 0;
  let pitch = 0;
  let nonPhrase = 0;                    // scam points that aren't wording
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

  const st = outOfState(address);
  if (st) addTell(3, `address is out of state (${st})`);
  else {
    const z = outsideInterior(address);
    if (z) addTell(1, `Alaska address outside the Interior (ZIP ${z})`);
  }

  if (OWN_ADDRESSES.test(address)) addPitch(2, "used Roybal's own address as theirs");

  // --- soft tells ---
  const nonLocalPhone = !!phone10 && area !== "907";
  if (nonLocalPhone) {
    if (TOLL_FREE.has(area)) addPitch(1, `toll-free number (${area})`);
    else addTell(1, `non-Alaska phone number (${area})`);
  }
  // A numbered free email only means something next to an outside number:
  // plenty of real Fairbanks customers are bob1975@gmail.com.
  if (nonLocalPhone && FREEMAIL.test(email) && /\d{2,}/.test(email.split("@")[0])) {
    addTell(1, "numbered free email with an out-of-area phone");
  }

  // A different email in the message than the one on the form: "reply to my
  // other address" or signing as a business while sending from Gmail.
  const inText = (message.match(EMAIL_IN_TEXT) ?? []).map((s) => s.toLowerCase()).filter((s) => s !== email);
  if (email && inText.length) {
    const other = inText[0];
    const sameDomain = other.split("@")[1] === email.split("@")[1];
    addTell(2, sameDomain
      ? `message asks for replies at a different address (${other}) than the form email`
      : FREEMAIL.test(email)
        ? `signs as a business (${other.split("@")[1]}) but sent from a personal email`
        : `message gives a different email (${other}) than the form`);
  }

  if (!LOCAL_PLACES.test(text)) addTell(1, "no Fairbanks-area place named in the address or message");

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
  const pitchHit = pitch >= threshold;
  const kind: ScreenResult["kind"] =
    pitchHit && (pitch >= score || !scamHit) ? "solicitation"
    : scamHit ? "scam"
    : "ok";
  const reasons = found.map((f, i) => [f[0], i, f[1]] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((f) => f[2]);
  return { score, pitchScore: pitch, screened: kind !== "ok", kind, reasons };
}

/** One line for the text alert / card: "Likely spam — fake phone number; address is out of state (CA)". */
export function screenSummary(r: ScreenResult, max = 3): string {
  if (!r.screened) return "";
  const label = r.kind === "solicitation" ? "Sales pitch" : "Likely spam";
  return `${label} — ${r.reasons.slice(0, max).join("; ")}${r.reasons.length > max ? "; …" : ""}`;
}
