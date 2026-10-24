/* Reference-priced lines in the estimate editor (jsdom).
   The AI office can price a piecework claim line from the owner's own past
   Xactimate estimates when the Fairbanks list has no row ("reference", owner
   and office drafts only). The office must SEE which lines those are — a
   slate-blue tag in the draft and audit panels, a badge on the line with the
   refNote as its tooltip — and the customer must NEVER see it: not on the
   printed sheet, not in the shared packet snapshot.
   Synthetic codes and prices only: this repo is public.
   Run: node apps/field/test/refprice.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "HTMLElement", "Node", "Event", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
// jsdom has no 2d canvas, and a construction estimate carries the owner's signature pad
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";
globalThis.confirm = () => true;
window.confirm = () => true;
window.localStorage.setItem("roybal-offline", "1");
// signed in, so aiAvailable() lets the buttons run (supa.js reads this at import)
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "test-token", email: "test@example.com" }));

const REF_NOTE = "Xactimate reference from your past estimates: 3 line(s) on 2 estimate(s), TESTLIST_JAN26, range $1.00–$2.00 — review";
const DRAFT = {
  lossSummary: "Rebuild the test room. Trim priced from our past Xactimate estimates.",
  items: [
    { room: "Kitchen", desc: "Test wall finish", qty: 40, unit: "SF", price: 1.5, priced: "catalog", code: "TST1", basis: "walk 02:10" },
    { room: "Kitchen", desc: "Test trim piece", qty: 22, unit: "LF", price: 1.75, priced: "reference", code: "ZZZ", refNote: REF_NOTE, basis: "Magicplan p.2" },
    { room: "Kitchen", desc: "Test fixture", qty: 1, unit: "EA", price: 90, priced: "estimate", basis: "photo 4" },
  ],
};
// a construction draft: no reference-priced line, so its prose is never scrubbed
const PLAIN = "Walls hung to a laser reference line. Carry a reference price of $450 for the vanity. Checked against Xactimate history.";
const PLAIN_DRAFT = {
  lossSummary: PLAIN,
  items: [{ room: "Framing", desc: "Test partition", qty: 10, unit: "HR", price: 100, priced: "estimate", by: "Roybal" }],
};
let draftReply = DRAFT;
const SUGGESTION = { room: "Kitchen", desc: "Test shoe mold", qty: 22, unit: "LF", price: 1.25, priced: "reference", code: "ZZZ2", refNote: REF_NOTE, reason: "walk 03:40" };
const calls = [];
const bodies = {};   // the last request body per action
globalThis.fetch = async (url, opts = {}) => {
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (String(url).endsWith("/functions/v1/roybal-ai-office")) {
    const body = JSON.parse(opts.body || "{}");
    calls.push(body.action);
    bodies[body.action] = body;
    if (body.action === "invoiceDraft") return resp(200, { ok: true, draft: draftReply });
    if (body.action === "invoiceAudit") return resp(200, { ok: true, suggestions: [SUGGESTION] });
  }
  return resp(404, {});
};

const { invoice } = await import("../js/forms.js");
const { snapshotSheets } = await import("../js/photoshare.js");

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
const until = async (cond, ms = 3000) => { for (const t = Date.now(); Date.now() - t < ms && !cond();) await new Promise((r) => setTimeout(r, 10)); };
console.log("Reference-priced lines (DOM)");

const inv = { id: "e1", kind: "estimate", items: [] };
const project = { id: "p1", jobType: "restoration", customer: "Test Customer", address: "1 Test St", reconEstimates: [inv] };
const el = invoice(project, inv);
document.body.append(el);
const button = (label) => [...el.querySelectorAll("button")].find((b) => b.textContent.includes(label));

await test("the draft panel counts reference lines on their own and tags each one, refNote as the tooltip", async () => {
  button("Draft rebuild estimate").click();
  await until(() => el.textContent.includes("Draft basis"));
  assert.ok(calls.includes("invoiceDraft"));
  // the job's kind rides the facts: the office function keeps the claim-only
  // reference tier off construction jobs and off facts without a jobType
  assert.equal(bodies.invoiceDraft.facts.job.jobType, "restoration");
  assert.ok(el.textContent.includes("1 of 3 lines priced from the Fairbanks list, 1 from your past Xactimate estimates (review), 1 estimate — verify those."));
  const tag = [...el.querySelectorAll("span")].find((s) => s.textContent.includes("Xactimate ref $1.75"));
  assert.ok(tag, "reference tag rendered");
  assert.equal(tag.getAttribute("title"), REF_NOTE);
  assert.match(tag.getAttribute("style"), /var\(--navy-3\)/);
  assert.ok(tag.closest(".app-only"), "the draft panel is app-only");
  const cat = [...el.querySelectorAll("span")].find((s) => s.textContent.includes("Fairbanks TST1"));
  assert.equal(cat.getAttribute("title"), null);   // no empty tooltip on non-reference tags
  assert.equal(inv.items[1].refNote, REF_NOTE);
  assert.equal(inv.items[1].priced, "reference");
  assert.equal("refNote" in inv.items[0], false);
  // the draft used the reference, so its loss summary loses the sentence naming it
  assert.equal(inv.lossSummary, "Rebuild the test room.");
});

await test("the line itself keeps an app-only 'Xactimate ref' badge with the refNote tooltip", async () => {
  await until(() => el.querySelector("td.invdesc div.app-only"));
  const badges = [...el.querySelectorAll("td.invdesc div.app-only")];
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, "Xactimate ref price · review");
  assert.equal(badges[0].getAttribute("title"), REF_NOTE);
});

await test("the audit panel tags a reference suggestion, and + Add keeps its priced and refNote", async () => {
  button("Find missed items").click();
  await until(() => el.textContent.includes("potentially missed"));
  assert.equal(bodies.invoiceAudit.facts.job.jobType, "restoration");
  const tag = [...el.querySelectorAll("span")].find((s) => s.textContent.includes("Xactimate ref $1.25"));
  assert.ok(tag && tag.getAttribute("title") === REF_NOTE);
  const add = [...el.querySelectorAll("button")].find((b) => b.textContent === "+ Add");
  add.click();
  const added = inv.items[inv.items.length - 1];
  assert.equal(added.desc, "Test shoe mold");
  assert.equal(added.priced, "reference");
  assert.equal(added.refNote, REF_NOTE);
  assert.equal(added.code, "ZZZ2");
});

await test("the printed / shared sheet carries neither the badge nor the refNote", async () => {
  const snap = snapshotSheets([el]);   // what the packet share sends: app-only removed
  const html = snap.innerHTML;
  assert.ok(html.includes("Test trim piece"), "the line itself is on the sheet");
  assert.doesNotMatch(html, /TESTLIST|Xactimate ref|refNote|past Xactimate/);
  // on paper the app-only elements are hidden by print.css; the only
  // reference text in the editor lives inside them
  const printable = [...el.querySelectorAll("*")].filter((n) => !n.closest(".app-only") && n.children.length === 0).map((n) => n.textContent + " " + (n.getAttribute("title") || "")).join(" ");
  assert.doesNotMatch(printable, /TESTLIST|Xactimate ref/);
});

await test("typing over a reference price clears the badge and the refNote; other lines keep theirs", async () => {
  const rowOf = (desc) => [...el.querySelectorAll("tbody tr")].find((tr) => { const t = tr.querySelector("textarea"); return t && t.value === desc; });
  const badgeIn = (tr) => tr.querySelector("td.invdesc div.app-only");
  const trim = inv.items.find((it) => it.desc === "Test trim piece");
  const shoe = inv.items.find((it) => it.desc === "Test shoe mold");
  const tr = rowOf("Test trim piece");
  assert.ok(badgeIn(tr), "the badge is there before the edit");
  const price = tr.querySelectorAll("input[type=number]")[1];   // qty, then unit price
  assert.equal(price.value, "1.75");
  // qty is not the price: editing it leaves the reference as it was
  const qty = tr.querySelectorAll("input[type=number]")[0];
  qty.value = "24"; qty.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(trim.priced, "reference");
  assert.ok(badgeIn(tr));
  price.value = "2.10"; price.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(trim.price, "2.10");
  assert.equal(trim.priced, "manual");
  assert.equal("refNote" in trim, false);
  assert.equal(badgeIn(tr), null, "the badge left the row at once");
  assert.ok(tr.isConnected && price.isConnected, "removed in place: the row being typed in is not rebuilt");
  // a repaint (a new line) doesn't bring it back; the untouched reference line keeps its badge
  const addLine = [...el.querySelectorAll("button")].find((b) => b.textContent === "+ line");
  addLine.click();
  assert.equal(badgeIn(rowOf("Test trim piece")), null);
  assert.equal(shoe.priced, "reference");
  assert.equal(shoe.refNote, REF_NOTE);
  assert.equal(badgeIn(rowOf("Test shoe mold")).textContent, "Xactimate ref price · review");
});

await test("a draft with no reference line keeps its loss summary exactly as written", async () => {
  draftReply = PLAIN_DRAFT;
  const inv2 = { id: "e2", kind: "estimate", items: [] };
  const project2 = { id: "p2", jobType: "construction", customer: "Test Customer", address: "2 Test St", reconEstimates: [inv2] };
  const el2 = invoice(project2, inv2);
  document.body.append(el2);
  [...el2.querySelectorAll("button")].find((b) => b.textContent.includes("Draft rebuild estimate")).click();
  await until(() => el2.textContent.includes("Draft basis"));
  assert.equal(inv2.items[0].desc, "Test partition");
  assert.equal(inv2.lossSummary, PLAIN);
  el2.remove();
});

console.log(`\n${pass} reference-price DOM tests passed`);
process.exit(0);
