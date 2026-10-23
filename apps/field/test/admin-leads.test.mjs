/* The office Leads tab (apps/admin/js/leads.js) and one lead on paper
   (apps/admin/js/leadsheet.js) — DOM render (jsdom), Supabase answered by a
   fake fetch. The card's received stamp in Alaska time, the contact line
   (the email they gave, or the contact record's marked on file; the phone
   number is the call button), a web form sent with no message, both kept
   through a triage repaint; the lead sheet at #/leads/<id> (letterhead, the
   submission word for word, office notes apart, print mode, the PDF's name,
   left alone by the sync repaint, put back on leaving); the notes split
   against the shapes the three lanes really write. Made-up data only.
   Run: node apps/field/test/admin-leads.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

// the office admin imports field modules as "../../js/x.js" (one origin, two
// folders on the server); on disk they live in apps/field/js
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL && ctx.parentURL.includes("/apps/admin/js/") && spec.startsWith("../../js/"))
    return next(new URL(spec.replace("../../js/", "../../field/js/"), ctx.parentURL).href, ctx);
  const r = await next(spec, ctx);
  return r.url.includes("/apps/admin/js/") ? { ...r, format: "module" } : r;   // no package.json there
}`));

const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Roybal Construction — Office</title></head><body><header class="abar"></header><main id="view"></main><div id="toast" hidden></div></body></html>`,
  { url: "http://localhost/admin/#/leads", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "KeyboardEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
let printed = 0;
window.print = () => { printed++; };
localStorage.setItem("roybal-session", JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, email: "office@example.com" }));

/* ---------- five leads, the way each lane writes them (made-up data) ---------- */
const WEB = "0b5e8c1e-6f0a-4d6e-9a43-2f1c7e5d9a10";
const WEB2 = "1c6f9d2f-7a1b-4e7f-8b54-3a2d8f6e0b21";
const PHONE = "2d7a0e3a-8b2c-4f8a-9c65-4b3e9a7f1c32";
const CHAT = "3e8b1f4b-9c3d-4a9b-8d76-5c4fab802d43";
const HAND = "4f9c2a5c-ad4e-4bac-9e87-6d5abc913e54";
const CONTACT_PHONE = "5a0d3b6d-be5f-4cbd-8f98-7e6bcd024f65";

// roybal-lead's notes, byte for byte (supabase/functions/roybal-lead/index.ts)
const webNotes = ({ service, email, emergency, message, flag }) =>
  `Website form submission.\n` +
  (service ? `Service requested: ${service}\n` : "") +
  (email ? `Email: ${email}\n` : "") +
  (emergency ? `⚠️ Marked as an ACTIVE EMERGENCY by the customer.\n` : "") +
  (message ? `\n${message}` : "") +
  (flag ? `\n\n${flag}` : "");
// roybal-web-agent's
const chatNotes = ({ path, urgent, summary, transcript }) =>
  `AI web receptionist (roybalconstruction.com${path}).\n` +
  (urgent ? "⚠️ ACTIVE EMERGENCY per the visitor.\n" : "") +
  `${summary}\n\n--- what they told the assistant ---\n${transcript}`;
// services/phone-agent createLead's
const phoneNotes = ({ from, summary, urgency }) =>
  `AI-booked from a phone call (${from || "unknown number"}).\n` +
  `${summary}${urgency ? `\nUrgency: ${urgency}` : ""}`;

const MSG = "Water heater let go overnight.\nCarpet in two bedrooms is soaked.";
const L = {
  [WEB]: { id: WEB, stage: "lead", title: "Jane Sample — Water Damage Restoration", customer: "Jane Sample",
    phone: "(907) 555-0142", email: "jane.sample@example.com", address: "123 Example St, North Pole, AK",
    priority: "normal", message: MSG, source: "web", channel: "web-form", webLead: true,
    notes: webNotes({ service: "Water Damage Restoration", email: "jane.sample@example.com", message: MSG }) + "\nLeft a voicemail 10/21.",
    rev: 1, createdAt: "2026-10-21T17:32:50.000Z" },
  [WEB2]: { id: WEB2, stage: "lead", title: "Sam Example — Mold Removal", customer: "Sam Example",
    phone: "907-555-0100", email: "", address: "", priority: "high", message: "", source: "web", channel: "web-form",
    notes: webNotes({ service: "Mold Removal", emergency: true }), rev: 1 },               // no createdAt: an older row
  [PHONE]: { id: PHONE, stage: "lead", title: "Pat Caller — water", customer: "Pat Caller", phone: "+19075550123",
    address: "9 Birch Ln, Fairbanks", priority: "high", message: "Frozen pipe burst in the crawlspace.", channel: "phone",
    contactId: CONTACT_PHONE, aiBooked: true,
    notes: phoneNotes({ from: "+19075550123", summary: "Frozen pipe burst in the crawlspace.", urgency: "emergency" }),
    rev: 1, createdAt: "2026-10-20T03:10:00.000Z" },
  [CHAT]: { id: CHAT, stage: "lead", title: "Lee Visitor — remodel", customer: "Lee Visitor", phone: "907-555-0177", email: "",
    address: "", priority: "normal", message: "Wants a bathroom remodel quote.", source: "web", channel: "ai-chat", aiBooked: true,
    notes: chatNotes({ path: "/remodeling", summary: "Wants a bathroom remodel quote.",
      transcript: "Assistant: Hi! How can I help?\nVisitor: Looking to redo a bathroom." }),
    rev: 1, createdAt: "2026-10-19T22:00:00.000Z" },
  [HAND]: { id: HAND, stage: "lead", title: "Neighbor deck", customer: "Chris Neighbor", phone: "", address: "77 Spruce Way",
    priority: "normal", notes: "Met at the hardware store; wants a deck before snow.", rev: 1, createdAt: "2026-10-18T19:00:00.000Z" },
};
const ROW_CREATED = { [WEB]: "2026-10-21T17:32:51.120Z", [WEB2]: "2026-10-15T16:05:00.000Z", [PHONE]: "2026-10-20T03:10:01.000Z",
  [CHAT]: "2026-10-19T22:00:01.000Z", [HAND]: "2026-10-18T19:00:02.000Z" };
const CONTACTS = { [CONTACT_PHONE]: { id: CONTACT_PHONE, email: "pat.caller@example.com" } };
const gone = new Set();

/* ---------- Supabase, faked ---------- */
const calls = [];
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url));
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, body });
  if (u.includes("/rest/v1/crew_members")) return json(200, [{ data: { name: "Gregory", email: "greg@example.com" } }]);
  if (u.includes("/rest/v1/rpc/coordination_job_patch")) {
    const cur = L[body.p_id];
    Object.assign(cur, body.p_patch, { rev: (cur.rev || 1) + 1 });
    return json(200, { ...cur });
  }
  let m;
  if ((m = /\/rest\/v1\/contacts\?id=in\.\(([^)]*)\)/.exec(u))) return json(200, m[1].split(",").map((id) => CONTACTS[id]).filter(Boolean));
  if ((m = /\/rest\/v1\/contacts\?id=eq\.([^&]+)/.exec(u))) return json(200, CONTACTS[m[1]] ? [CONTACTS[m[1]]] : []);
  if ((m = /\/rest\/v1\/coordination_jobs\?id=eq\.([^&]+)/.exec(u))) {
    const d = L[m[1]];
    return json(200, d ? [{ id: m[1], data: { ...d }, created_at: ROW_CREATED[m[1]], deleted: gone.has(m[1]) }] : []);
  }
  if (u.includes("/rest/v1/coordination_jobs?deleted=eq.false&data->>stage=eq.lead")) {
    const ids = Object.keys(L).filter((id) => !gone.has(id)).sort((a, b) => (ROW_CREATED[a] < ROW_CREATED[b] ? 1 : -1));
    return json(200, ids.map((id) => ({ id, data: { ...L[id] }, created_at: ROW_CREATED[id] })));
  }
  throw new Error("unexpected fetch " + u);
};

const S = await import("../../admin/js/leadsheet.js");
const M = await import("../../admin/js/leads.js");
const { COMPANY } = await import("../js/model.js");

const view = document.getElementById("view");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const go = async (hash) => { location.hash = hash; await settle(5); view.replaceChildren(M.leadsTab()); await settle(60); };
const card = (id) => [...view.querySelectorAll(".lrow")].find((r) => r.querySelector(`a.lname[href="#/leads/${id}"]`));
const btn = (root, text) => [...root.querySelectorAll("button, a")].find((b) => b.textContent.trim() === text);
// no word boundaries: a stray null lands glued to its neighbours ("Samplenull")
const noJunk = (el) => assert.ok(!/null|undefined|NaN|\[object|Invalid Date/.test(el.textContent),
  el.textContent.match(/.{0,40}(null|undefined|NaN|\[object|Invalid Date).{0,40}/));

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Office Leads tab and lead sheet (DOM)");

/* ---------- the pure half ---------- */
await test("Alaska times: the full stamp, the card's short one (year only when it isn't this year), the day", () => {
  assert.equal(S.akWhen("2026-10-21T17:32:50.000Z"), "Wed, Oct 21, 2026, 9:32 AM AKDT");
  assert.equal(S.akWhen("2026-12-02T03:05:00.000Z"), "Tue, Dec 1, 2026, 6:05 PM AKST");
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  assert.equal(S.akShort("2026-10-21T17:32:50.000Z", now), "Oct 21, 9:32 AM AKDT");
  assert.equal(S.akShort("2025-12-30T20:00:00.000Z", now), "Dec 30, 2025, 11:00 AM AKST");
  // 03:10 UTC on the 20th is still the evening of the 19th in Fairbanks
  assert.equal(S.akDate("2026-10-20T03:10:00.000Z"), "2026-10-19");
  for (const bad of ["", null, undefined, "soon"]) { assert.equal(S.akWhen(bad), ""); assert.equal(S.akShort(bad), ""); assert.equal(S.akDate(bad), ""); }
});

await test("received: the lane's own stamp, else the row's insert time", () => {
  assert.equal(S.receivedAt(L[WEB], ROW_CREATED[WEB]), "2026-10-21T17:32:50.000Z");
  assert.equal(S.receivedAt(L[WEB2], ROW_CREATED[WEB2]), ROW_CREATED[WEB2]);
  assert.equal(S.receivedAt({}, ""), "");
});

await test("the notes split: each lane's own words come back out, the office's additions stay apart", () => {
  const w = S.splitNotes(L[WEB]);
  assert.deepEqual(w.lane, { service: "Water Damage Restoration", email: "jane.sample@example.com", emergency: false });
  assert.equal(w.office, "Left a voicemail 10/21.");
  const w2 = S.splitNotes(L[WEB2]);
  assert.deepEqual(w2.lane, { service: "Mold Removal", email: "", emergency: true });
  assert.equal(w2.office, "");
  const p = S.splitNotes({ ...L[PHONE], notes: L[PHONE].notes + "\nCalled back, no answer." });
  assert.deepEqual(p.lane, { caller: "+19075550123", urgency: "emergency" });
  assert.equal(p.office, "Called back, no answer.");
  const c = S.splitNotes(L[CHAT]);
  assert.equal(c.lane.page, "roybalconstruction.com/remodeling");
  assert.equal(c.lane.transcript, "Assistant: Hi! How can I help?\nVisitor: Looking to redo a bathroom.");
  assert.equal(c.office, "");
  // hand-entered, or a web lead whose top the office rewrote: all of it is the office's
  assert.deepEqual(S.splitNotes(L[HAND]), { lane: null, office: "Met at the hardware store; wants a deck before snow." });
  assert.deepEqual(S.splitNotes({ ...L[WEB], notes: "Customer called, see message." }), { lane: null, office: "Customer called, see message." });
  assert.equal(S.splitNotes({ channel: "phone", notes: phoneNotes({ from: "", summary: "x" }), message: "x" }).lane.caller, "");
  // a screened or repeat web lead: roybal-lead's flag after the message lands with the office's notes,
  // and the form's lines and the customer's words still come back out
  const FLAG = "🚩 Likely spam — fake phone number (555-0199 is reserved for movies/TV); address is out of state (CA)\n" +
    "(Auto-screened, no text was sent. If this is a real customer, work it normally.)";
  const sw = S.splitNotes({ ...L[WEB], notes: webNotes({ service: "Water Damage Restoration", email: "jane.sample@example.com", message: MSG, flag: FLAG }) + "\nCalled, real customer." });
  assert.deepEqual(sw.lane, { service: "Water Damage Restoration", email: "jane.sample@example.com", emergency: false });
  assert.equal(sw.office, FLAG + "\nCalled, real customer.");
  const REPEAT = "Repeat: this phone or email already came in through the form, and texted you, in the last 24 hours.";
  const sr = S.splitNotes({ ...L[WEB2], notes: webNotes({ service: "Mold Removal", emergency: true, flag: REPEAT }) });
  assert.deepEqual(sr.lane, { service: "Mold Removal", email: "", emergency: true });
  assert.equal(sr.office, REPEAT);
  // sent with no message: the flag is never shown as the customer's words
  const nm = S.readLead({ ...L[WEB2], notes: webNotes({ service: "Mold Removal", flag: FLAG }) });
  assert.equal(nm.message, "");
});

await test("the split reads the shapes the lanes really write (their code still says it this way)", () => {
  const src = (p) => readFileSync(new URL("../../../" + p, import.meta.url), "utf8");
  const lead = src("supabase/functions/roybal-lead/index.ts");
  for (const s of ["`Website form submission.\\n`", "`Service requested: ${service}\\n`", "`Email: ${email}\\n`",
    "`⚠️ Marked as an ACTIVE EMERGENCY by the customer.\\n`", "(message ? `\\n${message}` : \"\")",
    "(flag ? `\\n\\n${flag}` : \"\")"]) assert.ok(lead.includes(s), "roybal-lead: " + s);
  assert.ok(lead.indexOf("`Website form submission.\\n`") < lead.indexOf("(flag ? `\\n\\n${flag}` : \"\")"), "the flag comes last");
  const chat = src("supabase/functions/roybal-web-agent/index.ts");
  for (const s of ["`AI web receptionist (roybalconstruction.com${path}).\\n`", "\"⚠️ ACTIVE EMERGENCY per the visitor.\\n\"",
    "\\n\\n--- what they told the assistant ---\\n${transcript}`"]) assert.ok(chat.includes(s), "web agent: " + s);
  const phone = src("services/phone-agent/tools.mjs");
  for (const s of ["`AI-booked from a phone call (${session.from || \"unknown number\"}).\\n`", "`\\nUrgency: ${input.urgency}`"])
    assert.ok(phone.includes(s), "phone agent: " + s);
});

await test("the PDF's name: the customer and the Alaska day, nothing a file name can't hold", () => {
  assert.equal(S.pdfName(L[WEB], ROW_CREATED[WEB]), "Lead — Jane Sample — 2026-10-21");
  assert.equal(S.pdfName({ customer: 'A/B "C" <D>?' }, "2026-10-20T03:10:00.000Z"), "Lead — A B C D — 2026-10-19");
  assert.equal(S.pdfName({}, ""), "Lead — Untitled");
});

/* ---------- the list ---------- */
await go("#/leads");

await test("each card leads with when it came in (Alaska time) and how to reach them; the phone number is the call button", () => {
  const c = card(WEB);
  assert.ok(c, "the web lead's card");
  const when = c.querySelector(".lwhen");
  assert.match(when.textContent, /^Oct 21(, 2026)?, 9:32 AM AKDT · /);
  assert.equal(when.getAttribute("title"), "Received Wed, Oct 21, 2026, 9:32 AM AKDT");
  const pills = [...c.querySelectorAll(".lcontact .lpill")];
  assert.equal(pills[0].getAttribute("href"), "tel:9075550142");
  assert.equal(pills[0].textContent, "📞 (907) 555-0142");
  assert.equal(pills[1].getAttribute("href"), "mailto:jane.sample@example.com");
  assert.equal(pills[1].textContent, "✉️ jane.sample@example.com");
  assert.equal(pills[2].textContent, "📍 123 Example St, North Pole, AK");
  // the contact line sits above the message, and the old 📞 Call button is gone
  assert.ok(c.querySelector(".lcontact").compareDocumentPosition(c.querySelector(".lmsg")) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(btn(c, "📞 Call"), undefined);
  assert.equal(c.querySelector(".lmsg").textContent, MSG);
  for (const r of view.querySelectorAll(".lrow")) noJunk(r);
});

await test("a lead that came in without an email shows the contact record's, marked on file, from one read for all", () => {
  const c = card(PHONE);
  const mail = [...c.querySelectorAll(".lpill")].find((p) => p.textContent.startsWith("✉️"));
  assert.equal(mail.textContent, "✉️ pat.caller@example.com (on file)");
  assert.equal(mail.getAttribute("href"), "mailto:pat.caller@example.com");
  assert.equal(btn(c, "Contact page").getAttribute("href"), "#/c/" + CONTACT_PHONE);
  assert.equal(calls.filter((x) => x.u.includes("/rest/v1/contacts?")).length, 1);
  // a lead with neither shows no email pill at all
  assert.ok(![...card(CHAT).querySelectorAll(".lpill")].some((p) => p.textContent.startsWith("✉️")));
});

await test("a web form sent with no message shows no message box, not the notes' copy of the details; a typed lead still shows its notes", () => {
  const c = card(WEB2);
  assert.equal(c.querySelector(".lmsg"), null);
  assert.ok(!c.textContent.includes("Website form submission"));
  // no createdAt on this older row: the row's insert time stands in
  assert.match(c.querySelector(".lwhen").textContent, /^Oct 15(, 2026)?, 8:05 AM AKDT/);
  assert.equal(card(HAND).querySelector(".lmsg").textContent, "Met at the hardware store; wants a deck before snow.");
});

await test("the name and 🖨 Print / PDF open the lead's page", () => {
  const c = card(WEB);
  assert.equal(c.querySelector("a.lname").textContent, "Jane Sample — Water Damage Restoration");
  assert.equal(btn(c, "🖨 Print / PDF").getAttribute("href"), "#/leads/" + WEB);
});

await test("a triage repaint keeps the stamp from the row and the on-file email", async () => {
  const before = calls.length;
  btn(card(PHONE), "✓ Mark contacted").click();
  await settle(60);
  assert.ok(calls.slice(before).some((x) => x.u.includes("rpc/coordination_job_patch")));
  const c = card(PHONE);
  assert.equal(btn(c, "✓ Mark contacted"), undefined, "repainted with the touch stamped");
  assert.ok([...c.querySelectorAll(".lpill")].some((p) => p.textContent === "✉️ pat.caller@example.com (on file)"));
  assert.match(c.querySelector(".lwhen").textContent, /^Oct 19(, 2026)?, 7:10 PM AKDT/);
  const c2 = card(WEB2);
  btn(c2, "✓ Mark contacted").click();
  await settle(60);
  assert.match(card(WEB2).querySelector(".lwhen").textContent, /^Oct 15(, 2026)?, 8:05 AM AKDT/);
  assert.equal(M.leadsBusy(), false);
});

/* ---------- one lead on paper ---------- */
await test("#/leads/<id>: the letterhead page with the submission word for word and the office's notes apart", async () => {
  printed = 0;
  await go("#/leads/" + WEB);
  const page = view.querySelector(".ls-page");
  assert.ok(page, "the sheet");
  assert.match(page.querySelector(".ls-head__name").textContent, /^ROYBAL CONSTRUCTION, LLC$/);
  assert.equal(page.querySelector(".ls-title h2").textContent, "Lead Record");
  const field = (label) => [...page.querySelectorAll(".ls-f")].find((f) => f.querySelector(".ls-l").textContent === label);
  assert.equal(field("Received").querySelector(".ls-v").textContent, "Wed, Oct 21, 2026, 9:32 AM AKDT");
  assert.equal(field("Email").querySelector(".ls-v").textContent, "jane.sample@example.com");
  assert.equal(field("Phone").querySelector(".ls-v").textContent, "(907) 555-0142");
  assert.equal(field("Came in by").querySelector(".ls-v").textContent, "Website form");
  assert.equal(field("Service requested").querySelector(".ls-v").textContent, "Water Damage Restoration");
  assert.equal(field("Their message").querySelector(".ls-box").textContent, MSG);
  const bars = [...page.querySelectorAll(".ls-bar")].map((b) => b.textContent);
  assert.deepEqual(bars, ["Customer", "What they sent", "Where it stands", "Office notes"]);
  assert.equal([...page.querySelectorAll(".ls-box")].pop().textContent, "Left a voicemail 10/21.");
  assert.ok(!page.textContent.includes("Website form submission"));
  const foot = page.querySelector(".ls-foot").textContent;
  for (const lic of COMPANY.licenses) assert.ok(foot.includes(lic), lic);
  assert.match(foot, /Lead record, printed \w{3}, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M AK[DS]T/);
  noJunk(page);
});

await test("print mode while the page is open: only the page prints, letter @page, the PDF named for the customer and day", async () => {
  assert.ok(document.body.classList.contains("ls-print"));
  assert.match(document.getElementById("ls-page-style").textContent, /@page \{ size: letter; margin: 0\.5in/);
  assert.equal(document.title, "Lead — Jane Sample — 2026-10-21");
  const print = btn(view, "🖨 Print / Save PDF");
  assert.ok(print && !print.disabled);
  print.click();
  assert.equal(printed, 1);
  assert.equal(btn(view, "← Leads").getAttribute("href"), "#/leads");
  // the sync repaint leaves it alone (admin.js skips route() while leadsBusy())
  assert.equal(M.leadsBusy(), true);
});

await test("leaving the page puts the title, the page box and the body back", async () => {
  location.hash = "#/leads";
  await settle(20);
  assert.ok(!document.body.classList.contains("ls-print"));
  assert.equal(document.getElementById("ls-page-style"), null);
  assert.equal(document.title, "Roybal Construction — Office");
  assert.equal(M.leadsBusy(), false);
  view.replaceChildren(M.leadsTab());
  await settle(60);
  assert.ok(card(WEB));
});

await test("a phone lead's page: caller ID, urgency, the on-file email, the visit and history", async () => {
  Object.assign(L[PHONE], {
    siteVisit: { at: "2026-10-23T10:00", by: "greg@example.com", status: "scheduled", confirmedAt: "2026-10-21T18:00:00.000Z" },
    leadLog: [{ id: "g1", at: "2026-10-21", kind: "no-answer", note: "Left a message" }],
    nextActionAt: "2026-10-24", nextAction: "Send estimate", estValue: 4200,
  });
  await go("#/leads/" + PHONE);
  const page = view.querySelector(".ls-page");
  const v = (label) => [...page.querySelectorAll(".ls-f")].find((f) => f.querySelector(".ls-l").textContent === label)?.querySelector(".ls-v, .ls-box")?.textContent;
  assert.equal(v("Email (on file)"), "pat.caller@example.com");
  assert.equal(v("Called from"), "+19075550123");
  assert.equal(v("Urgency"), "emergency");
  assert.equal(v("Came in by"), "Phone (AI receptionist)");
  assert.equal(v("Summary"), "Frozen pipe burst in the crawlspace.");
  assert.equal(v("Site visit"), "Fri 10/23 10:00 AM with Gregory (confirmed by text)");
  assert.equal(v("Next follow-up"), "2026-10-24 — Send estimate");
  assert.equal(v("Estimated value"), "$4,200");
  assert.match(v("First contact"), /AK[DS]T$/);                // stamped by the triage test above
  assert.ok(page.querySelector(".ls-alert"));
  const cells = [...page.querySelectorAll(".ls-table tbody td")].map((td) => td.textContent);
  assert.deepEqual(cells, ["2026-10-21", "No answer / left message", "Left a message"]);
  assert.equal(document.title, "Lead — Pat Caller — 2026-10-19");
  noJunk(page);
});

await test("a chat lead's page carries the whole conversation; a typed lead's notes are its words", async () => {
  await go("#/leads/" + CHAT);
  let page = view.querySelector(".ls-page");
  const label = (t) => [...page.querySelectorAll(".ls-f")].find((f) => f.querySelector(".ls-l").textContent === t);
  assert.equal(label("The conversation").querySelector(".ls-box").textContent, "Assistant: Hi! How can I help?\nVisitor: Looking to redo a bathroom.");
  assert.equal(label("Page").querySelector(".ls-v").textContent, "roybalconstruction.com/remodeling");
  assert.equal(label("Email").querySelector(".ls-v").textContent, "Not given");
  await go("#/leads/" + HAND);
  page = view.querySelector(".ls-page");
  assert.equal(label("Notes").querySelector(".ls-box").textContent, "Met at the hardware store; wants a deck before snow.");
  assert.equal(label("Came in by").querySelector(".ls-v").textContent, "Entered by the office");
  assert.ok(![...page.querySelectorAll(".ls-bar")].some((b) => b.textContent === "Office notes"), "not shown twice");
  noJunk(page);
});

await test("a deleted lead, or a wrong link, says so instead of a blank page", async () => {
  gone.add(WEB2);
  await go("#/leads/" + WEB2);
  assert.match(view.textContent, /This lead isn't here any more/);
  assert.equal(view.querySelector(".ls-page"), null);
  assert.ok(!document.body.classList.contains("ls-print"));
  await go("#/leads/99999999-9999-4999-8999-999999999999");
  assert.match(view.textContent, /This lead isn't here any more/);
  gone.delete(WEB2);
  location.hash = "#/leads";
  await settle(20);
});

await test("admin.css prints only the lead page while it is open", () => {
  const css = readFileSync(new URL("../../admin/css/admin.css", import.meta.url), "utf8");
  const print = css.slice(css.indexOf("body.ls-print { background"));
  assert.match(print, /body\.ls-print > \*:not\(#view\) \{ display: none !important; \}/);
  assert.match(print, /body\.ls-print \.ls-noprint \{ display: none !important; \}/);
  assert.match(css, /\.ls-foot \{[^}]*font-size: 7\.5pt/);
});

await test("Safari < 15.4: no Object.hasOwn, .at() or structuredClone in the tab's code", () => {
  for (const f of ["leads.js", "leadsheet.js"]) {
    const src = readFileSync(new URL("../../admin/js/" + f, import.meta.url), "utf8");
    assert.ok(!/Object\.hasOwn\(|\.at\(|structuredClone/.test(src), f);
  }
});

console.log(`admin-leads: ${pass} passed`);
