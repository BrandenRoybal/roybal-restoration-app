/* ============================================================
   Roybal Field Forms — documents the customer signs in the portal

   Branden's rule (2026-09-23): nobody is asked to sign something they
   can't read. Every form with a customer signature block can be sent to
   the portal, and it goes up as the FULL document — a snapshot of the
   form exactly as it prints (photoshare.js's packet snapshot), stored in
   the media bucket and referenced from the approval on portal_jobs. The
   customer reads it (and can save it as a PDF) before the signature pad
   is offered, and the gateway refuses a signature on a document that
   isn't there or that they never opened.

   When they sign, the typed name, drawn signature and date come back into
   the form's own owner signature block, so the printed form and the job
   packet carry it.

   The estimate on a construction job is the contract (Branden, 2026-10-01:
   the portal's first step is "Contract" — he sends the customer the portal
   link and they sign the estimate there). Restoration estimates go to the
   carrier, not the customer, so they are never offered.

   Pure: no DOM, no network — the office UI in forms.js does the rendering
   and publishing.
   ============================================================ */

import { jobType } from "./model.js";

/* every form a customer signs, and which fields its owner block uses */
export const SIGNABLE = [
  { key: "reconEstimates", label: "Estimate", sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate", multi: true, construction: true },
  { key: "workAuth", label: "Work Authorization", sig: "ownerSig", name: "ownerName", date: "ownerDate" },
  { key: "changeOrders", label: "Change Order", sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate", multi: true },
  { key: "certDrying", label: "Certificate of Drying", sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate" },
  { key: "punchList", label: "Punch List", sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate" },
  { key: "certCompletion", label: "Certificate of Completion", sig: "sigOwner", name: "sigOwnerName", date: "sigOwnerDate" },
  { key: "packBack", label: "Contents Pack-Back Receipt", sig: "packbackSig", name: "packbackName", date: "packbackDate", onProject: true },
];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/* The signable documents on a job, in form order. `subtotal(items)` prices a
   change order (fincalc's lineSubtotal) and `total(estimate)` an estimate
   (bid.js estimateTotal); ids match what change orders were published
   under before, so an existing approval still lines up. */
export function signableDocs(project, subtotal = () => 0, total = () => null) {
  const p = project || {};
  const out = [];
  for (const def of SIGNABLE) {
    if (def.construction && jobType(p) !== "construction") continue;
    if (def.onProject) {
      if (Array.isArray(p.contents) && p.contents.length)
        out.push({ id: def.key, def, key: def.key, title: def.label, inst: p, amountDelta: null, signed: !!p[def.sig] });
      continue;
    }
    const v = p[def.key];
    const list = def.multi ? (Array.isArray(v) ? v : []) : (isObj(v) ? [v] : []);
    list.forEach((inst, i) => {
      if (!isObj(inst)) return;
      if (inst.mode === "upload") return;   // a signed scan already stands in for the form
      if (def.key === "changeOrders" && !(inst.description || (inst.items || []).length)) return;
      // an estimate with no scope written yet has nothing to sign
      if (def.key === "reconEstimates" && !(inst.items || []).some((it) => it && String(it.desc || "").trim())) return;
      const co = def.key === "changeOrders";
      const est = def.key === "reconEstimates";
      const t = est ? Number(total(inst)) : NaN;
      out.push({
        id: def.multi ? String(inst.id || `${def.key}-${i}`) : def.key,
        def, key: def.key, inst,
        title: co ? `Change Order ${inst.coNo || i + 1}` : est ? `Estimate ${String(inst.invoiceNo || "").trim() || i + 1}` : def.label,
        amountDelta: co ? subtotal(inst.items || []) : null,
        total: est && Number.isFinite(t) ? t : null,
        signed: !!inst[def.sig],
      });
    });
  }
  return out;
}

/* The approval entry for a document going up (or going up again). A new
   version resets viewedAt: they read what they sign, not an older copy. A
   signed approval is never overwritten (see resendable). */
export function approvalEntry(doc, docRef, prev, nowIso, { money = (n) => String(n) } = {}) {
  const co = doc.key === "changeOrders";
  return {
    id: doc.id,
    kind: co ? "changeOrder" : "document",
    formKey: doc.key,
    title: doc.title,
    description: co ? String(doc.inst.description || "").slice(0, 1200)
      : doc.total ? `Total: ${money(doc.total)}` : "",
    amountDelta: co ? Number(doc.amountDelta) || 0 : 0,
    status: "pending",
    publishedAt: (prev && prev.publishedAt) || nowIso,
    updatedAt: nowIso,
    doc: { html: docRef.html, media: docRef.media || [] },
  };
}

/* The request posted on the thread, and the text that goes to their phone. */
export function signRequestMessages(doc, { update = false, money = (n) => String(n) } = {}) {
  const amt = doc.key === "changeOrders" && doc.amountDelta ? ` (${money(doc.amountDelta)})`
    : doc.total ? ` (${money(doc.total)})` : "";
  return update
    ? { thread: `The full ${doc.title}${amt} is on your project page. Please read it there, and sign when you're ready.`,
        ping: `please read the full ${doc.title} before you sign it:` }
    : { thread: `Please review and sign: ${doc.title}${amt}. The whole document is on your project page to read first.`,
        ping: doc.key === "reconEstimates" ? `your estimate is ready to sign. Read it and sign here:`
          : `a document needs your signature. Read it and sign here:` };
}

/* Whether the office may put this document up again. A signature is never
   replaced. A declined estimate can go up again once it's revised: estimates
   get worked out with the customer, and a new number would split the bid. */
export function resendable(doc, approval) {
  if (!approval || !approval.status || approval.status === "pending") return true;
  return approval.status === "declined" && doc.key === "reconEstimates";
}

/* Copy portal signatures back into the forms. For each approved approval
   whose form has no owner signature yet: the drawn signature (when they
   drew one), the typed name and the date. Returns how many forms changed. */
export function applyPortalSignatures(project, approvals, subtotal = () => 0) {
  const byId = new Map(signableDocs(project, subtotal).map((d) => [d.id, d]));
  let changed = 0;
  for (const a of approvals || []) {
    if (!a || a.status !== "approved") continue;
    const d = byId.get(String(a.id));
    if (!d || d.inst[d.def.sig] || d.inst.portalSignedAt) continue;
    if (a.signature) d.inst[d.def.sig] = a.signature;
    if (a.signedName) d.inst[d.def.name] = a.signedName;
    const day = String(a.respondedAt || "").slice(0, 10);
    if (day) d.inst[d.def.date] = day;
    d.inst.portalSignedAt = a.respondedAt || new Date().toISOString();
    changed++;
  }
  return changed;
}

/* The office's one-line state for a document row. */
export function signState(doc, approval) {
  if (approval && approval.status === "approved") return "signed-portal";
  if (approval && approval.status === "declined") return "declined";
  if (approval && approval.status === "pending") return approval.doc && approval.doc.html ? "waiting" : "no-document";
  return doc.signed ? "signed-onsite" : "unsent";
}
