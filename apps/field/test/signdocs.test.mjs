/* Documents the customer signs in the portal. Branden, 2026-09-23: "Any
   document that we're asking the customer to sign we need to show them the
   document." These pin which forms count, what goes up with them, and how a
   portal signature comes back into the form. Run:
   node apps/field/test/signdocs.test.mjs */
import assert from "node:assert";
import { SIGNABLE, signableDocs, approvalEntry, signRequestMessages, applyPortalSignatures, signState, resendable } from "../js/signdocs.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const sum = (items) => items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
const H = (c) => c.repeat(64);

console.log("Documents to sign");

const project = {
  customer: "Test Customer",
  workAuth: { ownerSig: "", ownerName: "Test Customer" },
  certDrying: { mode: "upload", pages: ["x"] },
  changeOrders: [
    { id: "co-a", coNo: "CO-001", description: "Add a closet", items: [{ qty: 2, price: 150 }] },
    { id: "co-blank", coNo: "", description: "", items: [] },
    { id: "co-b", coNo: "", description: "", items: [{ qty: 1, price: -40 }], sigOwner: "data:image/png;base64,AAA" },
  ],
  punchList: { items: [] },
  certCompletion: {},
  contents: [{ name: "Lamp" }],
};

const docs = signableDocs(project, sum);
const ids = docs.map((d) => d.id);
ok("every form with an owner signature block is covered", ["workAuth", "changeOrders", "certDrying", "punchList", "certCompletion", "packBack"]
  .every((k) => SIGNABLE.some((d) => d.key === k)));
ok("filled forms are listed, in form order", ids.join() === "workAuth,co-a,co-b,punchList,certCompletion,packBack");
ok("a form replaced by a signed upload isn't offered", !ids.includes("certDrying"));
ok("an empty change order isn't offered", !ids.includes("co-blank"));
ok("change orders keep the id they were published under", docs[1].id === "co-a" && docs[1].title === "Change Order CO-001");
ok("an unnumbered change order is titled by position", docs[2].title === "Change Order 3");
ok("a change order carries its amount, other forms don't", docs[1].amountDelta === 300 && docs[0].amountDelta === null);
ok("already signed on the device shows as signed", docs[2].signed === true && docs[0].signed === false);
ok("no contents, no pack-back receipt", !signableDocs({ ...project, contents: [] }, sum).some((d) => d.id === "packBack"));

const ref = { html: H("a"), media: [H("b")] };
const first = approvalEntry(docs[1], ref, null, "2026-09-23T04:00:00Z");
ok("a change order goes up as a change order with its money and the document",
  first.kind === "changeOrder" && first.amountDelta === 300 && first.doc.html === H("a") && first.doc.media[0] === H("b"));
ok("it starts pending", first.status === "pending" && first.publishedAt === "2026-09-23T04:00:00Z");
const wa = approvalEntry(docs[0], ref, null, "2026-09-23T04:00:00Z");
ok("any other form goes up as a document, no money", wa.kind === "document" && wa.amountDelta === 0 && wa.description === "");
const again = approvalEntry(docs[1], { html: H("c") }, { ...first, viewedAt: "2026-09-23T05:00:00Z" }, "2026-09-24T00:00:00Z");
ok("a new version keeps its first publish date", again.publishedAt === "2026-09-23T04:00:00Z" && again.updatedAt === "2026-09-24T00:00:00Z");
ok("a new version must be read again", !("viewedAt" in again) && again.doc.html === H("c"));

const m1 = signRequestMessages(docs[1], { money: (n) => "$" + n });
ok("the request names the document and its amount", m1.thread.includes("Change Order CO-001 ($300)") && /read/i.test(m1.thread));
ok("the text asks them to read and sign", /read it and sign/i.test(m1.ping));
ok("an update says the full document is there", /full Work Authorization/.test(signRequestMessages(docs[0], { update: true }).thread));

ok("state: not sent", signState(docs[0], null) === "unsent");
ok("state: signed on site", signState(docs[2], null) === "signed-onsite");
ok("state: published before documents rode along", signState(docs[1], { status: "pending", description: "x" }) === "no-document");
ok("state: waiting on the customer", signState(docs[1], first) === "waiting");
ok("state: signed in the portal", signState(docs[1], { ...first, status: "approved" }) === "signed-portal");
ok("state: declined", signState(docs[1], { ...first, status: "declined" }) === "declined");

/* the portal signature comes back into the form */
const p2 = JSON.parse(JSON.stringify(project));
const approvals = [
  { id: "co-a", status: "approved", signedName: "Test Customer", signature: "data:image/png;base64,SIG", respondedAt: "2026-09-23T06:30:00Z" },
  { id: "workAuth", status: "pending" },
  { id: "co-b", status: "approved", signedName: "Someone Else", signature: "data:image/png;base64,NEW", respondedAt: "2026-09-23T06:30:00Z" },
];
ok("one form changed", applyPortalSignatures(p2, approvals, sum) === 1);
const co = p2.changeOrders[0];
ok("signature, name and date land in the owner block",
  co.sigOwner === "data:image/png;base64,SIG" && co.sigOwnerName === "Test Customer" && co.sigOwnerDate === "2026-09-23");
ok("a signature already on the form is never overwritten", p2.changeOrders[2].sigOwner === "data:image/png;base64,AAA");
ok("a pending approval changes nothing", !p2.workAuth.ownerSig);
co.sigOwner = ""; co.sigOwnerName = "";
ok("applied once: clearing it on purpose doesn't bring it back", applyPortalSignatures(p2, approvals, sum) === 0 && !co.sigOwner);

/* the estimate is the contract on a construction job (Branden, 2026-10-01):
   he sends the portal link and the customer signs the estimate there */
const usd = (n) => "$" + n;
const tot = (inv) => inv.items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) * 1.2;
const build = {
  ...project,
  jobType: "construction",
  reconEstimates: [
    { id: "est-blank", kind: "estimate", invoiceNo: "", items: [{ desc: "", qty: "", price: "" }] },
    { id: "est-a", kind: "estimate", invoiceNo: "RC-TST-1001", items: [{ desc: "Frame the addition", qty: 100, price: 200 }] },
    { id: "est-b", kind: "estimate", invoiceNo: "", items: [{ desc: "Paint", qty: 1, price: 500 }] },
  ],
};
const bdocs = signableDocs(build, sum, tot);
const est = bdocs.find((d) => d.id === "est-a");
ok("a construction estimate is offered, ahead of everything else", bdocs[0].id === "est-a" && !!est);
ok("an estimate with no scope written isn't offered", !bdocs.some((d) => d.id === "est-blank"));
ok("an estimate is titled by its number, or by position", est.title === "Estimate RC-TST-1001" && bdocs[1].title === "Estimate 3");
ok("an estimate carries its total, not a change-order amount", est.total === 24000 && est.amountDelta === null);
ok("restoration estimates go to the carrier and are never offered",
  !signableDocs({ ...build, jobType: "restoration" }, sum, tot).some((d) => d.key === "reconEstimates"));
const ea = approvalEntry(est, ref, null, "2026-10-01T03:00:00Z", { money: usd });
ok("an estimate goes up as a document showing its total, no change-order money",
  ea.kind === "document" && ea.formKey === "reconEstimates" && ea.description === "Total: $24000" && ea.amountDelta === 0 && ea.doc.html === H("a"));
const em = signRequestMessages(est, { money: usd });
ok("the request names the estimate and its total", em.thread.includes("Estimate RC-TST-1001 ($24000)"));
ok("the text says the estimate is ready to sign", /estimate is ready to sign/i.test(em.ping) && /sign here/i.test(em.ping));

ok("resend: nothing up yet, or still pending", resendable(est, null) && resendable(est, { status: "pending" }));
ok("resend: a signed estimate is never replaced", !resendable(est, { status: "approved" }));
ok("resend: a declined estimate can go up again, revised", resendable(est, { status: "declined" }));
ok("resend: a declined change order stays declined", !resendable(docs[1], { status: "declined" }));

const b2 = JSON.parse(JSON.stringify(build));
ok("a portal signature lands on the estimate",
  applyPortalSignatures(b2, [{ id: "est-a", status: "approved", signedName: "Test Customer", signature: "data:image/png;base64,EST", respondedAt: "2026-10-01T04:00:00Z" }], sum) === 1);
const se = b2.reconEstimates[1];
ok("in its acceptance block", se.sigOwner === "data:image/png;base64,EST" && se.sigOwnerName === "Test Customer" && se.sigOwnerDate === "2026-10-01");

console.log(`\n${pass} signing checks passed.`);
