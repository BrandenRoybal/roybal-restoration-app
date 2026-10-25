/* Work Authorization wording, by version (jsdom).
   Branden, 2026-10-24: water mitigation is paid by the owner, deposit first,
   not after insurance pays. New authorizations carry the October 2026 terms;
   one signed under the April 2026 wording keeps printing those words; an
   unsigned April one can be switched, a signed one never can.
   Run: node apps/field/test/workauth-terms.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
// jsdom has no canvas: the signature pads draw into a stub
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });

const M = await import("../js/model.js");
const { workAuth } = await import("../js/forms.js");
const { WA_VERSIONS, WA_TERMS_CURRENT, WA_TERMS_LEGACY, newWorkAuth, waTermsVersion, waWording, waIsSigned, upgradeWorkAuthTerms, SCOPE_ITEMS } = M;

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Work Authorization — versioned terms");

const legacyWa = () => ({ date: "2026-04-09", scope: { 0: true, 1: true, 2: true, 3: true, 4: false, 5: true, 6: true },
  mode: "sign", smsConsent: false, ownerSig: "", ownerName: "", ownerDate: "2026-04-09", repSig: "", repName: "", repDate: "2026-04-09", uploadedPages: [] });
const job = () => ({ id: "p1", customer: "Pat Owner", address: "1 Test St", jobType: "restoration", waterCategory: "" });
const text = (el) => el.textContent.replace(/\s+/g, " ");

await test("new authorizations carry the October 2026 wording, every scope item checked", () => {
  const wa = newWorkAuth();
  assert.equal(wa.termsVersion, WA_TERMS_CURRENT);
  assert.equal(waTermsVersion(wa), "2026-10");
  assert.equal(Object.keys(wa.scope).length, WA_VERSIONS["2026-10"].scope.length);
  assert.ok(Object.values(wa.scope).every((v) => v === true));
  for (const k of ["depositAmount", "roomsAffected", "mortgageCo", "paymentInitials"]) assert.equal(wa[k], "");
  assert.deepEqual(SCOPE_ITEMS, WA_VERSIONS[WA_TERMS_CURRENT].scope);
});

await test("no stamp, or an unknown one, reads as the April 2026 wording", () => {
  assert.equal(waTermsVersion(legacyWa()), WA_TERMS_LEGACY);
  assert.equal(waTermsVersion({ termsVersion: "1999-01" }), WA_TERMS_LEGACY);
  assert.equal(waTermsVersion(null), WA_TERMS_LEGACY);
  assert.ok(waWording(legacyWa()).terms.some(([k, v]) => k === "Payment" && v.startsWith("Payment is due upon completion or receipt of insurance proceeds")));
  assert.equal(waWording(legacyWa()).payment.length, 0);
});

await test("the October wording: deposit first, owner pays, no wait on insurance", () => {
  const W = WA_VERSIONS["2026-10"];
  const all = [...W.payment, ...W.terms].map(([k, v]) => `${k}: ${v}`).join("\n");
  assert.ok(!all.includes("receipt of insurance proceeds"));
  assert.ok(W.payment.find(([k]) => k === "Deposit")[1].includes("before drying equipment is set"));
  assert.ok(W.payment.find(([k]) => k === "Owner Pays")[1].includes("whether or not, when, or how much the insurance carrier pays"));
  assert.ok(W.ack.includes("does not depend on when or whether my insurance company pays"));
  assert.ok(W.signLead.includes("Payment Terms"));
});

await test("an unsigned April authorization switches; scope re-mapped by meaning", () => {
  const wa = legacyWa();
  assert.equal(upgradeWorkAuthTerms(wa), true);
  assert.equal(wa.termsVersion, WA_TERMS_CURRENT);
  // April 4 (antimicrobial, unchecked) is October 5; containment (new 4) starts checked
  assert.deepEqual(wa.scope, { 0: true, 1: true, 2: true, 3: true, 4: true, 5: false, 6: true, 7: true });
  const W = WA_VERSIONS["2026-10"].scope, A = WA_VERSIONS["2026-04"].scope;
  assert.ok(W[5].startsWith("Application of EPA-registered") && A[4].startsWith("Application of EPA-registered"));
  assert.ok(W[6].startsWith("Photo documentation") && A[5].startsWith("Photo documentation"));
  assert.ok(W[7].startsWith("Additional scope") && A[6].startsWith("Additional scope"));
  assert.equal(upgradeWorkAuthTerms(wa), false, "already current");
});

await test("a signed authorization never switches — in person, uploaded or in the portal", () => {
  for (const signed of [{ ownerSig: "data:image/png;base64,AAA" }, { uploadedPages: ["data:image/jpeg;base64,P"] }, { uploadedDoc: "data:x" }, { portalSignedAt: "2026-04-10T00:00:00Z" }]) {
    const wa = { ...legacyWa(), ...signed };
    assert.ok(waIsSigned(wa));
    assert.equal(upgradeWorkAuthTerms(wa), false);
    assert.equal(wa.termsVersion, undefined);
  }
});

await test("the form draws an October authorization with Payment Terms, deposit and initials", () => {
  const p = job(); const wa = newWorkAuth(); p.workAuth = wa;
  const el = workAuth(p, wa);
  const t = text(el);
  assert.ok(t.includes("Payment Terms"));
  assert.ok(t.includes("Mitigation Deposit (due at signing)"));
  for (const [k] of WA_VERSIONS["2026-10"].payment) assert.ok(t.includes(k + ":"), k);
  assert.ok(t.includes(WA_VERSIONS["2026-10"].ack));
  assert.ok(t.includes(WA_VERSIONS["2026-10"].signLead));
  assert.ok(t.includes("Rooms Affected") && t.includes("Mortgage Company"));
  assert.ok(!t.includes("receipt of insurance proceeds"));
  assert.equal(el.querySelectorAll('input[type="checkbox"]').length >= WA_VERSIONS["2026-10"].scope.length, true);
  assert.equal([...el.querySelectorAll("button")].some((b) => b.textContent.startsWith("Switch to")), false, "no switch on a current one");
  const initials = el.querySelector('input[placeholder="Initials"]');
  initials.value = "PO"; initials.dispatchEvent(new window.Event("input"));
  assert.equal(wa.paymentInitials, "PO");
});

await test("a signed April authorization draws its own words and offers no switch", () => {
  const p = job(); const wa = { ...legacyWa(), ownerSig: "data:image/png;base64,AAA" }; p.workAuth = wa;
  const t = text(workAuth(p, wa));
  assert.ok(t.includes("Payment is due upon completion or receipt of insurance proceeds"));
  assert.ok(!t.includes("Payment Terms"));
  assert.ok(!t.includes("Switch to"));
  assert.ok(t.includes(WA_VERSIONS["2026-04"].signLead));
});

await test("an unsigned April authorization offers the switch, and the button redraws it", () => {
  const p = job(); const wa = legacyWa(); p.workAuth = wa;
  const el = workAuth(p, wa);
  document.body.append(el);
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Switch to October 2026 terms");
  assert.ok(btn, "switch offered");
  btn.click();
  assert.equal(wa.termsVersion, WA_TERMS_CURRENT);
  const now = document.body.querySelector("section.sheet");
  assert.notEqual(now, el, "redrawn in place");
  assert.ok(text(now).includes("Payment Terms"));
  assert.ok(!text(now).includes("Switch to"));
  now.remove();
});

console.log(`\n${pass} work authorization checks passed`);
process.exit(0);
