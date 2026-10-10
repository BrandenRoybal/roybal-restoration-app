/* Who the carrier packet is suggested to go to (design §12). Pure.

   The card's To field is filled from records and he can change it; the To
   is never filed with the card, so this only decides what he sees first:

   1. the address the last SENT version of this packet went to (an adjuster
      who has version 1 gets version 2);
   2. otherwise the field app's adjuster-email rules (adjustersend.js
      prefillTo): the newest inbound email filed to the job matched on the
      claim number, else the newest inbound email that is not the
      customer's own, else the first address typed into the job's Adjuster
      field. Both email rules also skip bounce and no-reply senders and the
      connected mailbox itself (a copy of our own email filed to the job),
      which the narrative page has never had to;
   3. otherwise nothing: he types it on the card.

   addressIn, bareAddress and SPINE_TO are copied from adjustersend.js
   rather than imported: that module loads supa.js and config.js, which the
   worker image does not carry. test/packet-recipient.test.mjs imports the
   field module and checks the two give the same answer. */

/* email.send@1's `to` (0014) and packet.send@1's: ONE bare address */
export const SPINE_TO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_TO = 320;

const str = (v) => (v == null ? "" : String(v)).trim();
const lc = (v) => str(v).toLowerCase();
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const ms = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : NaN; };

/* ---------- addresses (adjustersend.js, verbatim rules) ---------- */
const TOKEN = /[^\s<>()[\]@,;:"]+@[^\s<>()[\]{}@,;:"'`]+/g;
const SEPARATOR = /[\s<>()[\],;:"]/;
const unwrap = (a) => a.replace(/^['`‘’“”]+/, "").replace(/['`‘’“”.!?]+$/, "");

/** The first address in free text, quotes and trailing sentence punctuation
    dropped; "" when none passes SPINE_TO. */
export function addressIn(text) {
  for (const m of String(text ?? "").matchAll(TOKEN)) {
    const a = unwrap(m[0]);
    if (SPINE_TO.test(a) && a.length <= MAX_TO) return a;
  }
  return "";
}

/** "Jane <JANE@x.com>" or "jane@x.com" → "jane@x.com"; "" when none. */
export function bareAddress(v) {
  const s = str(v);
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (m && SPINE_TO.test(m[1])) return lc(m[1]);
  const whole = unwrap(s);
  if (!SEPARATOR.test(s) && SPINE_TO.test(whole) && whole.length <= MAX_TO) return lc(whole);
  return lc(addressIn(s));
}

/* Senders that never answer: a bounce, a postmaster, an automated notice.
   Matched on the local part, words joined or split by "-", "_" or ".",
   so "no-reply.claims@…", "do_not_reply@…" and "bounces+x@…" count and
   "noreen@…" does not. */
const JUNK = /^(?:mailer[-_.]?daemon|postmaster|bounces?|no[-_.]?reply|do[-_.]?not[-_.]?reply)(?![a-z0-9])/i;
export const isJunkSender = (address) => JUNK.test(str(address).split("@")[0]);

/* the connected mailbox, given as an address or as {email} / {address} */
const accountAddress = (account) =>
  bareAddress(typeof account === "string" ? account : obj(account).email || obj(account).address || "");

/** → { to, source: "last_sent" | "claim" | "email" | "adjuster" | "" }.
    `emails` are the job's email_messages rows ({direction, from_addr,
    matched_by, received_at}); `lastSentTo` the address the last sent
    version went to. */
export function pickRecipient({ project, emails, account, lastSentTo } = {}) {
  const last = bareAddress(lastSentTo);
  if (last && SPINE_TO.test(last) && last.length <= MAX_TO) return { to: last, source: "last_sent" };

  const p = obj(project);
  const customer = bareAddress(p.email);
  const own = accountAddress(account);
  const usable = (a) => !!a && SPINE_TO.test(a) && a.length <= MAX_TO && a !== customer;
  const newest = (r) => { const t = ms(r.received_at); return Number.isFinite(t) ? t : -Infinity; };
  const rows = arr(emails).map(obj).filter((r) => !r.direction || r.direction === "in")
    .sort((a, b) => newest(b) - newest(a));
  const sender = (r) => {
    const a = bareAddress(r.from_addr);
    return usable(a) && !isJunkSender(a) && a !== own ? a : "";
  };
  const hit = rows.find((r) => r.matched_by === "claim" && sender(r)) || rows.find((r) => sender(r));
  if (hit) return { to: sender(hit), source: hit.matched_by === "claim" ? "claim" : "email" };

  const typed = addressIn(p.adjuster);
  if (typed && usable(lc(typed))) return { to: typed, source: "adjuster" };
  return { to: "", source: "" };
}
