/* The carrier packet's document model (packet/model.mjs, design §4-6, §10,
   §13): the gate, what each section prints, the hash that decides a new
   version, photo numbering, Alaska times, the media budget and the fixed
   words. Pure functions over the made-up demo job in
   packet-demo.fixture.mjs; nothing here touches the network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  packetGate, HOLD_REASONS, WITHDRAW_REASONS, isReadyInvoice, buildModel, modelHash, sectionHashes,
  changedSections, mediaNames, planMedia, emailText, rationaleText, readyText, holdText, suggestedFrom,
  CERT_STATEMENT, SCAN_FOOT, SCAN_LEGEND, SECTION_TITLES,
} from "../packet/model.mjs";
import { SCOPE_ITEMS } from "../../../apps/field/js/model.js";
import { TERMS, SMS_CONSENT, SMS_LINKS, SIGN_LEAD, OWNER_SIG_LABEL, REP_SIG_LABEL } from "../packet/workauth.mjs";
import {
  demoProject, demoProjectUpload, demoMediaStore, demoMediaSizes, demoImages, markerOf, hashOf, signaturePng,
  DEMO_TODAY, DEMO_NOW, DEMO_UPDATED_AT, LOST_MARKER, EXCLUDED_DOC_ID,
} from "./packet-demo.fixture.mjs";

const FORMS = readFileSync(new URL("../../../apps/field/js/forms.js", import.meta.url), "utf8");
const OPTS = { today: DEMO_TODAY, now: DEMO_NOW, updatedAt: DEMO_UPDATED_AT };
const gate = (p, o = {}) => packetGate(p, { ...OPTS, ...o });
const build = (p = demoProject(), o = {}) => buildModel(p, { today: DEMO_TODAY, now: DEMO_NOW, ...o });
const sec = (model, key) => model.sections.find((s) => s.key === key) || null;
const blocksOf = (model, key) => (sec(model, key) ? sec(model, key).parts.flatMap((p) => p.blocks) : []);
const txt = (c) => (typeof c === "string" ? c : c && c.text);
const tableWith = (model, key, head) => blocksOf(model, key).find((b) => b.t === "table" && b.columns.some((c) => c.head === head));
const LABEL = { number: "PKT-2026-0007", version: 1, replaces: null, changed: [], built: DEMO_NOW, mode: "full" };

/* ============================== the gate ============================== */

test("gate: the demo job passes, anchored on its latest real activity", () => {
  assert.deepEqual(gate(demoProject()), { ok: true, anchor: "2026-10-08" });
  assert.deepEqual(gate(demoProjectUpload()).ok, true);
});

test("gate: every reason, in order", () => {
  const cases = [
    ["deleted", (p) => p, { deleted: true }],
    ["archived", (p) => { p.archivedAt = "2026-10-09T18:00:00Z"; }],
    ["not_water", (p) => { p.jobType = "construction"; }],
    ["not_water", (p) => { p.lossTypes = ["fire"]; p.waterCategory = ""; p.waterClass = ""; p.dryingSystem = ""; }],
    ["excluded", (p) => { p.packetExclude.push("certDrying"); }],
    ["excluded", (p) => { p.packetExclude.push("invoices"); }],
    ["not_certified", (p) => { p.certDrying = null; }],
    ["not_certified", (p) => { p.certDrying.sigTech = ""; }],
    ["no_invoice", (p) => { p.invoices = p.invoices.filter((i) => i.id !== "inv-ready"); }],
    ["unchecked_fills", (p) => { const ph = p.meterPhotos[0]; delete ph.ok; ph.filled = "14"; }],
    ["unread_meter_photos", (p) => {
      p.meterPhotos.push({ id: "mp-5", mapId: "map-a", rowKey: "rk-a4", date: "2026-10-06", loc: 6, src: markerOf(demoImages().meter[0]), ts: "2026-10-06T19:40:00Z", dev: "demo-ipad" });
    }],
    ["lookback", (p) => p, { today: "2026-11-30" }],
    ["settle", (p) => p, { updatedAt: "2026-10-10T19:00:00Z" }],
    ["cert_sign_pending", (p) => p, { certSignPending: true }],
  ];
  for (const [reason, change, o] of cases) {
    const p = demoProject();
    change(p);
    const r = gate(p, o || {});
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason, `${reason}: got ${r.reason} (${r.detail})`);
    assert.equal(typeof r.detail, "string");
    assert.ok(r.detail.length > 0 && r.detail.length < 200);
  }
});

test("gate: the first failing check is the reason", () => {
  const p = demoProject();
  p.archivedAt = "2026-10-09T18:00:00Z";
  p.certDrying = null;
  p.invoices = [];
  assert.equal(gate(p, { deleted: true }).reason, "deleted");
  assert.equal(gate(p).reason, "archived");
  p.archivedAt = "";
  assert.equal(gate(p).reason, "not_certified");
});

test("gate: hold and withdraw reason sets", () => {
  for (const r of ["no_invoice", "unchecked_fills", "unread_meter_photos"]) {
    assert.ok(HOLD_REASONS.has(r) && HOLD_REASONS.includes(r));
    assert.ok(WITHDRAW_REASONS.has(r));
  }
  for (const r of ["deleted", "archived", "not_water", "excluded", "not_certified"]) {
    assert.ok(WITHDRAW_REASONS.includes(r) && !HOLD_REASONS.has(r));
  }
  for (const r of ["lookback", "settle", "cert_sign_pending"]) assert.ok(!WITHDRAW_REASONS.has(r) && !HOLD_REASONS.includes(r));
  assert.equal(HOLD_REASONS.size, 3);
  assert.equal(WITHDRAW_REASONS.size, 8);
});

test("gate: certified is mode-aware", () => {
  const p = demoProject();
  // sign mode with pages left from an earlier upload and no technician signature: not certified
  p.certDrying.uploadedPages = demoProjectUpload().certDrying.uploadedPages;
  p.certDrying.sigTech = "";
  assert.equal(gate(p).reason, "not_certified");
  // the same pages in upload mode certify it, with no signature at all
  p.certDrying.mode = "upload";
  assert.equal(gate(p).ok, true);
  // a legacy single uploadedDoc counts as one page
  p.certDrying.uploadedPages = [];
  p.certDrying.uploadedDoc = markerOf(demoImages().certUpload[0]);
  assert.equal(gate(p).ok, true);
  p.certDrying.uploadedDoc = "";
  assert.equal(gate(p).reason, "not_certified");
});

test("gate: ready invoice rules", () => {
  const base = { invoiceNo: "INV-1", invoiceDate: "2026-10-08" };
  assert.ok(isReadyInvoice(base));
  assert.ok(!isReadyInvoice({ ...base, status: "void" }));
  assert.ok(!isReadyInvoice({ ...base, estimateId: "est-1" }));
  assert.ok(!isReadyInvoice({ invoiceNo: "  " }));
  assert.ok(!isReadyInvoice({ qboInvoiceId: "177" }), "QuickBooks' internal id is not a printed number");
  assert.ok(isReadyInvoice({ qboDocNumber: "1042" }));
  assert.ok(!isReadyInvoice({ reviewGaps: ["x"], invoiceNo: "", qboInvoiceId: "" }), "held billing-check draft");
  assert.ok(isReadyInvoice({ reviewGaps: ["x"], invoiceNo: "INV-9" }), "a numbered invoice is not a held draft");
  assert.ok(isReadyInvoice({ reviewGaps: ["x"], qboInvoiceId: "177", qboDocNumber: "1043" }));
  assert.ok(!isReadyInvoice(null));

  const p = demoProject();
  p.invoices = p.invoices.filter((i) => i.id !== "inv-ready");
  assert.equal(gate(p).reason, "no_invoice");
  assert.match(gate(p).detail, /3 invoices/);
  p.invoices.push({ id: "x", qboInvoiceId: "177", invoiceDate: "2026-10-08" });
  assert.equal(gate(p).reason, "no_invoice");
  p.invoices.at(-1).qboDocNumber = "1077";
  assert.equal(gate(p).ok, true);
});

test("gate: a prefilled certificate date never makes an old job recent; a recent invoice date does", () => {
  const p = demoProject();
  const late = { today: "2026-11-30" };
  p.certDrying.sigTechDate = "2026-11-29";
  p.certDrying.issueDate = "2026-11-29";
  const r = gate(p, late);
  assert.equal(r.reason, "lookback");
  assert.equal(r.detail, "last activity 10/08/2026");
  p.invoices[0].invoiceDate = "2026-11-25";
  assert.deepEqual(gate(p, late), { ok: true, anchor: "2026-11-29" });
});

test("gate: the lookback window, the latest removal, and hasRow", () => {
  const p = demoProject();
  assert.equal(gate(p, { today: "2026-10-22" }).ok, true);          // 14 days after 10/08
  assert.equal(gate(p, { today: "2026-10-23" }).reason, "lookback");
  assert.equal(gate(p, { today: "2026-10-23", lookbackDays: 30 }).ok, true);
  assert.deepEqual(gate(p, { today: "2027-03-01", hasRow: true }), { ok: true, anchor: "2026-10-08" });
  // with no invoice date, the latest Removed (a scan's, on the Alaska clock) still anchors it
  p.invoices[0].invoiceDate = "";
  p.certDrying.dryComplete = "";
  p.certDrying.portalSignedAt = "";
  p.dryingLogs[0].dryoutFinish = "";
  assert.equal(gate(p).anchor, "2026-10-06");
});

test("gate: settle window and an unreadable updatedAt", () => {
  const p = demoProject();
  assert.equal(gate(p, { updatedAt: "2026-10-10T18:30:00Z" }).reason, "settle");
  assert.equal(gate(p, { updatedAt: "2026-10-10T18:30:00Z", settleMin: 60 }).ok, true);
  assert.equal(gate(p, { updatedAt: "2026-10-10T17:59:00Z" }).ok, true);
  assert.equal(gate(p, { updatedAt: "not a time" }).ok, true);
  assert.equal(gate(p, { updatedAt: undefined }).ok, true);
});

test("gate: the portal signature counts on its Alaska date", () => {
  const p = {
    id: "dst-job", jobType: "restoration", waterCategory: "2", customer: "Jane Sample",
    certDrying: { mode: "sign", sigTech: signaturePng(1), portalSignedAt: "2026-11-02T08:30:00Z", dryComplete: "" },
    invoices: [{ id: "i", invoiceNo: "INV-1", invoiceDate: "2026-10-01" }],
  };
  // 08:30 UTC on 11/02 is 23:30 on 11/01 in Alaska (standard time from that morning)
  assert.deepEqual(gate(p, { today: "2026-11-15" }), { ok: true, anchor: "2026-11-01" });
  const r = gate(p, { today: "2026-11-16" });
  assert.equal(r.reason, "lookback");
  assert.equal(r.detail, "last activity 11/01/2026");
});

test("gate and buildModel never change the job they are given", () => {
  for (const p of [demoProject(), demoProjectUpload()]) {
    const before = structuredClone(p);
    gate(p);
    build(p);
    build(p, { prevPhotoNums: { "ph-01": 4 } });
    assert.deepStrictEqual(p, before);
  }
});

/* ============================== the model ============================== */

test("model: sections in print order, excluded ones left out", () => {
  const m = build();
  assert.deepEqual(m.sections.map((s) => s.key), ["cert", "workAuth", "floorPlan", "maps", "logs", "photos", "docs", "invoices"]);
  for (const s of m.sections) assert.equal(s.title, SECTION_TITLES[s.key]);
  assert.equal(m.v, 1);
  assert.equal(m.jobId, demoProject().id);
  // the unticked supporting document is not in the packet, nor is its image
  assert.deepEqual(sec(m, "docs").parts.map((p) => p.title), ["Supporting Document — Plumber's leak report"]);
  assert.ok(!(hashOf(demoImages().excludedDoc) in m.media));

  const p = demoProject();
  p.packetExclude = ["photos", "moistureMaps", "dryingLogs", "workAuth", "floorPlan", "supportDocs:doc-plumber", `supportDocs:${EXCLUDED_DOC_ID}`];
  const x = build(p);
  assert.deepEqual(x.sections.map((s) => s.key), ["cert", "invoices"]);
  assert.equal(Object.values(x.media).filter((r) => r.kind === "photo").length, 0);
});

test("model: the cover", () => {
  const { cover } = build();
  assert.deepEqual(cover, {
    customer: "Jane Sample", address: "123 Example St, Fairbanks, AK 99701", claimNo: "DEMO-12345", carrier: "Sample Mutual",
    adjuster: "Alex Adjuster (adjuster@example.com)", dateOfLoss: "09/30/2026", lossCause: "Supply line failure under the kitchen sink",
    workOrderNo: "WO-2026-118", waterCategory: "2", waterClass: "2",
    facts: [["Mitigation start", "10/01/2026"], ["Mitigation finish", "10/06/2026"], ["Drying days", "6"], ["Certificate dated", "10/06/2026"],
      ["Drying system", "Closed"], ["Dehumidifier days", "1 × 5"], ["Air mover days", "4 × 5"], ["Air scrubber days", "1 × 4"]],
  });
  // a claim number pasted with control characters prints clean
  const p = demoProject();
  p.claimNo = "DEMO-\u000b12345\u0000";
  assert.equal(build(p).cover.claimNo, "DEMO- 12345");
});

test("model: certificate signed in the app", () => {
  const m = build();
  const bl = blocksOf(m, "cert");
  assert.ok(bl.some((b) => b.t === "para" && b.text === CERT_STATEMENT));
  const ver = tableWith(m, "cert", "Material / location");
  assert.deepEqual(ver.rows, [["Subfloor — kitchen", "Pin meter / wood scale", "16", "13", "11", "Yes"], ["Slab — basement", "Pin meter / concrete scale", "4", "3.5", "3", "Yes"]]);
  const sigs = bl.find((b) => b.t === "signatures").items;
  assert.equal(sigs.length, 3);
  assert.equal(sigs[0].name, "Pat Sample");
  assert.equal(sigs[0].date, "10/06/2026");
  assert.equal(m.media[sigs[0].media].kind, "sig");
  assert.deepEqual(m.media[sigs[0].media].full, { inline: demoImages().sigTech });
  // the owner signed in the portal: printed as electronic, on the Alaska date of 01:15 UTC 10/07
  assert.deepEqual(sigs[1], { label: "Property Owner / Insured", name: "Jane Sample", date: "10/06/2026", media: null, electronic: true });
  // no adjuster signature: no date either (the dates are prefilled)
  assert.deepEqual(sigs[2], { label: "Adjuster / Carrier (if witness required)", name: "", date: "", media: null, electronic: false });
  for (const s of sigs) assert.ok(FORMS.includes(`"${s.label}"`), s.label);
  // final readings with their meter photos
  const grid = bl.find((b) => b.t === "grid");
  assert.deepEqual(grid.items.map((i) => i.caption), ["Kitchen · Loc 1 · 10/06 · 14%", "Kitchen · Loc 2 · 10/06 · 13%"]);
  assert.equal(grid.items[0].media, hashOf(demoImages().meter[0]));
});

test("model: a signature's date prints only beside a signature", () => {
  const p = demoProject();
  p.certDrying.mode = "upload";        // the gate is not the model's business: build anyway
  p.certDrying.uploadedPages = [];
  assert.equal(sec(build(p), "cert"), null, "upload mode with no pages prints nothing");
  const q = demoProject();
  q.certDrying.portalSignedAt = "";
  q.certDrying.sigOwner = "";
  const sigs = blocksOf(build(q), "cert").find((b) => b.t === "signatures").items;
  assert.deepEqual(sigs[1], { label: "Property Owner / Insured", name: "Jane Sample", date: "", media: null, electronic: false });
});

test("model: certificate as an uploaded signed copy", () => {
  const m = build(demoProjectUpload());
  const s = sec(m, "cert");
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].title, null);
  assert.equal(s.parts[0].blocks.length, 1);
  const pages = s.parts[0].blocks[0];
  assert.equal(pages.t, "pages");
  assert.deepEqual(pages.items.map((i) => i.media), demoImages().certUpload.map(hashOf));
  assert.deepEqual(pages.items.map((i) => i.caption), ["Certificate of Drying (signed copy) — page 1 of 2", "Certificate of Drying (signed copy) — page 2 of 2"]);
  assert.ok(!m.cover.facts.some(([k]) => k === "Certificate dated"));
});

test("model: work authorization words are the form's, verbatim", () => {
  for (const [k, v] of TERMS) assert.ok(FORMS.includes(`termRow("${k}", "${v}")`), `term ${k} drifted from forms.js`);
  for (const s of [SMS_CONSENT, SMS_LINKS, SIGN_LEAD, OWNER_SIG_LABEL, REP_SIG_LABEL, CERT_STATEMENT, SCAN_FOOT]) {
    assert.ok(FORMS.includes(`"${s}"`), `not in forms.js: ${s.slice(0, 50)}`);
  }
  assert.ok(FORMS.includes(SCAN_LEGEND));

  const m = build();
  const bl = blocksOf(m, "workAuth");
  const paras = bl.filter((b) => b.t === "para").map((b) => b.text);
  for (const [k, v] of TERMS) assert.ok(paras.includes(`${k}: ${v}`));
  assert.ok(paras.includes(`Owner opted in: Yes. [X] ${SMS_CONSENT}`));
  const scope = bl.find((b) => b.t === "bullets").items;
  assert.equal(scope.length, 6);
  assert.deepEqual(scope, SCOPE_ITEMS.filter((t, i) => i !== 4), "only the checked items, unnumbered; the unchecked fifth is left out");
  assert.ok(scope[0].startsWith("Emergency water extraction"));
  const sigs = bl.find((b) => b.t === "signatures").items;
  assert.deepEqual(sigs.map((s) => [s.label, s.name, s.date, s.electronic]), [
    [OWNER_SIG_LABEL, "Jane Sample", "10/01/2026", false], [REP_SIG_LABEL, "Pat Sample", "10/01/2026", false]]);
  assert.deepEqual(m.media[sigs[0].media].full, { inline: demoImages().waOwner });

  const p = demoProject();
  p.workAuth.smsConsent = false;
  assert.ok(blocksOf(build(p), "workAuth").some((b) => b.t === "para" && b.text === `Owner opted in: No. [ ] ${SMS_CONSENT}`));
  p.workAuth.ownerSig = "";
  p.workAuth.repSig = "";
  assert.equal(sec(build(p), "workAuth"), null, "an unsigned work authorization is not printed");
});

test("model: floor plan and supporting documents print full pages", () => {
  const m = build();
  assert.deepEqual(blocksOf(m, "floorPlan"), [{ t: "pages", items: [{ media: hashOf(demoImages().floorPlanPage), caption: "Floor plan" }] }]);
  assert.deepEqual(blocksOf(m, "docs"), [{ t: "pages", items: [{ media: hashOf(demoImages().supportDoc), caption: "Plumber's leak report" }] }]);
  assert.equal(m.media[hashOf(demoImages().supportDoc)].kind, "page");
});

test("model: moisture maps — goals, fills, photo marks, blocks of 13", () => {
  const m = build();
  const s = sec(m, "maps");
  assert.deepEqual(s.parts.map((p) => [p.title, p.newPage]), [["Moisture Map — Kitchen", false], ["Moisture Map — Basement", true]]);

  const a = s.parts[0].blocks;
  const tA = a.filter((b) => b.t === "table");
  assert.equal(tA.length, 1);
  assert.deepEqual(tA[0].rows.map((r) => r[0]), ["10/01/2026", "10/02/2026", "10/04/2026", "10/06/2026"], "the blank 10/07 row is left out");
  const r3 = tA[0].rows[2];                         // 10/04: 18 17 19 16 15 15 against ≤ 16
  assert.deepEqual(r3.slice(1, 7).map((c) => c.fill), ["wet", "wet", "wet", "dry", "dry", "dry"]);
  assert.equal(r3[3].mark, "P", "Loc 3 on 10/04 has a meter photo");
  assert.equal(tA[0].rows[3][1].mark, "P");
  assert.equal(tA[0].rows[3][4].mark, undefined);
  assert.equal(r3[7], "", "an empty cell is a plain string");
  assert.equal(a.find((b) => b.t === "fields").pairs.find(([k]) => k === "Dry goal (MC%)")[1], "≤ 16%");
  assert.ok(a.some((b) => b.t === "para" && b.text.includes("P = this reading has a photo")));
  assert.deepEqual(a.find((b) => b.t === "bullets").items, ["10/01/2026: Initial readings after extraction.", "10/04/2026: Subfloor still above goal at Loc 3.", "10/06/2026: All locations at goal."]);
  const meterGrid = a.filter((b) => b.t === "grid").at(-1);
  assert.deepEqual(meterGrid.items.map((i) => i.caption), ["Loc 3 · 10/04 · 19%", "Loc 1 · 10/06 · 14%", "Loc 2 · 10/06 · 13%", "Loc 4 · 09/29 · reading date removed"]);
  assert.deepEqual(m.media[meterGrid.items[3].media], { kind: "meter", full: { inline: demoImages().meterInline }, small: null });
  assert.equal(a.find((b) => b.t === "image").media, hashOf(demoImages().sketchA));

  // Basement: no typed goal → the material's (Concrete / Slab, 4%); 14 locations → two blocks
  const b = s.parts[1].blocks;
  assert.equal(b.find((x) => x.t === "fields").pairs.find(([k]) => k === "Dry goal (MC%)")[1], "≤ 4%");
  const tB = b.filter((x) => x.t === "table");
  assert.equal(tB.length, 2);
  assert.deepEqual(tB[1].columns.map((c) => c.head).slice(0, 2), ["Date", "14"]);
  assert.deepEqual(tB[1].rows.map((r) => [r[0], txt(r[1]), r[1].fill]), [["10/02/2026", "6", "wet"], ["10/05/2026", "4.5", "wet"]]);
  assert.equal(tB[0].rows[1][1].fill, "dry", "4 is at the goal");
  assert.equal(b.find((x) => x.t === "image").media, hashOf(demoImages().floorPlanB), "no sketch: the floor plan background");
  assert.ok(b.some((x) => x.t === "image" && x.media === hashOf(demoImages().equipmentPlanB)));
  assert.ok(!b.some((x) => x.t === "grid"), "no meter photos on the Basement map");
  for (const t of [...tA, ...tB]) assert.ok(Math.abs(t.columns.reduce((n, c) => n + c.w, 0) - 1) < 1e-9);
});

test("model: drying log — typed and scanned rows, still out, sizing, psychrometrics", () => {
  const m = build();
  const s = sec(m, "logs");
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].title, "Drying Log — 10/01/2026 to 10/06/2026");
  const eq = tableWith(m, "logs", "Tag / asset");
  const row = (tag) => eq.rows.find((r) => r[0] === tag);
  assert.equal(eq.rows.length, 7, "the blank seed row is left out; the undone AM-099 placement never became a row");
  assert.ok(!row("AM-099"));
  // typed rows print their stored hours, not a recomputed figure
  assert.equal(txt(row("AM-021")[5]), "98");
  assert.equal(row("AM-021")[4], "10/05 15:00");
  assert.equal(row("AM-021")[6], "Set under the sink base; Checked daily");
  // a run typed in Hours with no pull time is not out
  assert.equal(txt(row("AM-020")[5]), "96");
  assert.equal(row("AM-020")[4], "");
  // a typed row a scan closed: Removed from the scan, marked S, the row's own Placed unmarked
  assert.equal(row("HT-001")[3], "10/02 09:00");
  assert.deepEqual(row("HT-001")[4], { text: "10/04 09:00", mark: "S" });
  // scanned rows: Alaska wall time, S on both ends, hours computed by scans.js
  assert.deepEqual(row("AM-015")[3], { text: "10/01 10:02", mark: "S" });
  assert.deepEqual(row("AM-015")[4], { text: "10/06 11:00", mark: "S" });
  assert.equal(txt(row("AM-015")[5]), "121");
  assert.equal(row("AM-015")[6], "moved to Hallway 10/03 09:30");
  // still out: no pull time, no hours, and listed for the card
  assert.deepEqual(row("AM-014")[4], { text: "still out", font: "ital" });
  assert.equal(row("AM-014")[5], "");
  assert.deepEqual(m.unitsOut, ["AM-014 (Kitchen)"]);
  assert.ok(blocksOf(m, "logs").some((b) => b.t === "para" && b.text === `S ${SCAN_LEGEND}.`));

  const sizing = tableWith(m, "logs", "Deviation from worksheet");
  assert.deepEqual(sizing.rows[0].slice(0, 3).map(txt), ["Air movers", "6–7", "4 (short)"]);
  assert.equal(sizing.rows[0][4], "Limited circuits in the kitchen — staged deployment");
  assert.equal(sizing.rows[1][0], "LGR dehumidifiers (70-pint)");
  assert.ok(blocksOf(m, "logs").some((b) => b.t === "para" && b.text.startsWith("Sized 10/01/2026 — Class 2 / Cat 2, 240 SF wet floor across 2 room(s), 1,920 cu ft")));

  const psy = tableWith(m, "logs", "Aff GPP");
  assert.equal(psy.columns.length, 17);
  assert.equal(psy.rows.length, 3, "a reading row with only its prefilled date is left out");
  assert.equal(psy.rows[0][4], "35", "a blank GPP is the form's own figure");
  assert.equal(psy.rows[0][11], "2", "GD = unaffected GPP − affected GPP");
  assert.equal(psy.rows[2][11], "15", "a typed GD prints as typed");
  assert.equal(psy.rows[0][15], "pat", "a login typed as the tech prints without its domain");
});

test("model: scan record — Alaska times, actions, no email addresses", () => {
  const m = build();
  const rec = tableWith(m, "logs", "Read by");
  assert.deepEqual(rec.columns.map((c) => c.head), ["Time", "Tag", "Type", "Action", "Room", "Read by", "Tech"]);
  assert.deepEqual(rec.rows[0], ["10/01 10:00", "AM-014", "Air mover", "Placed", "Kitchen", "Camera", "Pat Sample"]);
  assert.ok(rec.rows.some((r) => r[1] === "AM-015" && r[3] === "Moved" && r[4] === "Hallway" && r[0] === "10/03 09:30"));
  assert.ok(rec.rows.some((r) => r[1] === "AF-001" && r[3] === "Placed" && r[5] === "Typed tag"));
  // the typed row's scan belongs to this log; no tech typed → the login, never the address
  assert.deepEqual(rec.rows.find((r) => r[1] === "HT-001"), ["10/04 09:00", "HT-001", "Heater", "Removed", "", "Label photo", "crew2"]);
  assert.equal(rec.rows.length, 9);
  assert.equal(m.counts.scans, 9);
  assert.ok(blocksOf(m, "logs").some((b) => b.t === "para" && b.text === SCAN_FOOT));

  const p = demoProject();
  p.equipmentScans.find((e) => e.id === "scan-07").tech = "pat.sample@example.com";
  p.equipmentScans.find((e) => e.id === "scan-08").tech = "";
  p.equipmentScans.find((e) => e.id === "scan-08").by = "Pat <pat.sample@example.com>";
  p.equipmentScans.find((e) => e.id === "scan-06").room = "Basement (ask owner@example.com)";
  const rows = tableWith(build(p), "logs", "Read by").rows;
  for (const r of rows) for (const c of r) assert.ok(!String(txt(c)).includes("@"), `email printed: ${txt(c)}`);
  assert.equal(rows.find((r) => r[3] === "Moved")[6], "pat.sample", "a tech typed as an address prints its name part");
  assert.equal(rows.find((r) => r[1] === "AM-015" && r[3] === "Removed")[6], "pat.sample", "no tech: the login's name part");
  assert.ok(rows.some((r) => r[4] === "Basement (ask owner)"));
});

test("model: Alaska times across the 11/01/2026 change to standard time", () => {
  const ev = (id, act, at, extra = {}) => ({ id, tag: "AM-030", act, at, room: "Kitchen", type: "Air mover", model: "", logId: "log-d", voids: "", how: "camera", by: "crew1@example.com", tech: "Pat Sample", build: "demo", ...extra });
  const p = {
    id: "dst-job", jobType: "restoration", waterCategory: "2", customer: "Jane Sample", claimNo: "DEMO-12345",
    certDrying: { mode: "sign", sigTech: signaturePng(1), sigTechName: "Pat Sample", sigTechDate: "2026-11-01", sigOwnerName: "Jane Sample", portalSignedAt: "2026-11-02T08:30:00Z", dryComplete: "2026-11-01" },
    dryingLogs: [{ id: "log-d", dryoutStart: "2026-10-31", dryoutFinish: "2026-11-01", equipment: [
      { asset: "AM-031", type: "Air mover", location: "Hall", placed: "2026-10-31T12:00", removed: "2026-11-01T20:00:00Z", hours: "", notes: "" },
    ], readings: [] }],
    equipmentScans: [
      ev("d-1", "place", "2026-10-31T20:00:00Z"),           // 12:00 AKDT
      ev("d-2", "move", "2026-11-01T09:30:00Z", { room: "Hall" }),   // 01:30 AKDT
      ev("d-3", "move", "2026-11-01T10:30:00Z", { room: "Den" }),    // 01:30 AKST, an hour later
      ev("d-4", "remove", "2026-11-01T20:00:00Z", { room: "" }),     // 11:00 AKST
    ],
  };
  const m = build(p, { today: "2026-11-02", now: new Date("2026-11-02T20:00:00Z") });
  const rec = tableWith(m, "logs", "Read by").rows;
  assert.deepEqual(rec.map((r) => [r[0], r[3]]), [["10/31 12:00", "Placed"], ["11/01 01:30", "Moved"], ["11/01 01:30", "Moved"], ["11/01 11:00", "Removed"]]);
  const eq = tableWith(m, "logs", "Tag / asset").rows;
  // a zoned stamp typed into Removed is converted, not printed in UTC
  assert.equal(eq.find((r) => r[0] === "AM-031")[4], "11/01 11:00");
  assert.deepEqual(eq.find((r) => r[0] === "AM-030")[4], { text: "11/01 11:00", mark: "S" });
  const owner = blocksOf(m, "cert").find((b) => b.t === "signatures").items[1];
  assert.equal(owner.date, "11/01/2026", "08:30 UTC 11/02 is still 11/01 in Alaska");
  assert.equal(owner.electronic, true);
});

test("model: photos in stage order with fixed numbers and captions", () => {
  const m = build();
  const items = blocksOf(m, "photos")[0].items;
  assert.equal(items.length, 12, "the photo with neither src nor cloud is left out");
  assert.deepEqual(items.map((i) => i.caption[0]), ["#001", "#003", "#006", "#010", "#002", "#005", "#007", "#008", "#011", "#004", "#009", "#012"]);
  assert.deepEqual(items[0].caption, ["#001", " · BEFORE · Kitchen · Standing water at the sink base"]);
  assert.deepEqual(items.find((i) => i.caption[0] === "#007").caption, ["#007", " · DURING · Basement · Supply line under the kitchen"], "no stage counts as during");
  for (const i of items) assert.ok(!/\d{2}\/\d{2}/.test(i.caption[1]), "no dates on photo captions");
  assert.equal(m.counts.photos, 12);
  const p = demoProject();
  p.photos[0].room = "";
  p.photos[0].caption = "";
  assert.deepEqual(blocksOf(build(p), "photos")[0].items[0].caption, ["#001", " · BEFORE"]);
});

test("model: photo numbers stay put across a delete and an append", () => {
  const v1 = build();
  assert.deepEqual(v1.photoNums, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ph-${String(i + 1).padStart(2, "0")}`, i + 1])));
  const p = demoProject();
  p.photos = p.photos.filter((ph) => ph.id !== "ph-02");
  p.photos.push({ id: "ph-14", src: `media:${"e".repeat(64)}:1234`, caption: "Added later", room: "Kitchen", stage: "after" });
  const v2 = build(p, { prevPhotoNums: v1.photoNums });
  const num = (m, caption) => blocksOf(m, "photos")[0].items.find((i) => i.caption[1].endsWith(caption)).caption[0];
  assert.equal(v2.photoNums["ph-02"], 2, "a deleted photo's number stays reserved");
  assert.equal(v2.photoNums["ph-14"], 13);
  assert.equal(v2.photoNums["ph-03"], 3);
  assert.equal(num(v2, "Added later"), "#013");
  assert.equal(num(v2, "Standing water at the sink base"), "#001");
  assert.ok(!blocksOf(v2, "photos")[0].items.some((i) => i.caption[0] === "#002"));
  // the photo that had no image gets one: it is new, so it takes the next number
  p.photos.find((ph) => ph.id === "ph-13").src = `media:${"f".repeat(64)}:1234`;
  const v3 = build(p, { prevPhotoNums: v2.photoNums });
  assert.equal(v3.photoNums["ph-13"], 14);
  assert.equal(v3.photoNums["ph-14"], 13);
  // a numbering with a duplicate gives the second photo a fresh number
  const v4 = build(demoProject(), { prevPhotoNums: { "ph-01": 1, "ph-02": 1, "ph-03": 0, "ph-04": "4" } });
  assert.equal(v4.photoNums["ph-01"], 1);
  assert.equal(v4.photoNums["ph-02"], 2);
  assert.equal(new Set(Object.values(v4.photoNums)).size, Object.keys(v4.photoNums).length);
});

test("model: media references for photos, archived photos and lost objects", () => {
  const m = build();
  const img = demoImages();
  const full = (i) => hashOf(img.photos[i]);
  // a photo in the bucket: small is its thumbnail key
  assert.deepEqual(m.media[full(0)], { kind: "photo", full: { hash: full(0) }, small: { hash: "thumb_" + full(0) } });
  // archived: the key is still the full photo's hash; small is the 480 px copy
  assert.deepEqual(m.media[full(2)], { kind: "photo", full: { hash: full(2) }, small: { hash: hashOf(img.archivedSmall[0]) } });
  // archived with the small copy still inline in the blob
  assert.deepEqual(m.media[full(9)], { kind: "photo", full: { hash: full(9) }, small: { inline: img.archivedInline } });
  // a marker whose object never reached the bucket still has its key (the renderer finds it missing)
  const lost = LOST_MARKER.split(":")[1];
  assert.equal(m.media[lost].full.hash, lost);
  assert.equal(m.missing, 0);
  // a value that is no image at all is a missing ref, counted
  const p = demoProject();
  p.photos[4].src = "blob:https://app.example.com/1234";
  const x = build(p);
  const key = blocksOf(x, "photos")[0].items.find((i) => i.caption[0] === "#005").media;
  assert.match(key, /^missing:[0-9a-f]{64}$/);
  assert.deepEqual(x.media[key], { kind: "photo", full: null, small: null });
  assert.equal(x.missing, 1);
  // every key a block names is in media
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, y] of Object.entries(v)) { if (k === "media" && typeof y === "string") keys.add(y); else walk(y); } };
  walk(m.sections);
  for (const k of keys) assert.ok(k in m.media, k);
  assert.equal(keys.size, Object.keys(m.media).length);
});

test("model: invoices — only ready ones, lines by room, O&P rule, totals as billed", () => {
  const m = build();
  assert.deepEqual(sec(m, "invoices").parts.map((p) => p.title), ["Invoice INV-1042"]);
  const ch = tableWith(m, "invoices", "Description");
  assert.deepEqual(ch.rows.map((r) => [txt(r[0]), txt(r[1])]), [
    ["", "Kitchen"], ["1.", "Water extraction — carpet and pad"], ["2.", "Air mover — per day"], ["3.", "Dehumidifier (LGR) — per day"],
    ["", "Basement"], ["4.", "Air scrubber — per day"], ["", "General"], ["5.", "Mitigation labor — technician"]]);
  assert.equal(ch.rows[0][1].fill, "band");
  assert.equal(txt(ch.rows[1][5]), "$225.00");
  const tot = tableWith(m, "invoices", "Totals as billed");
  // opAuto with a subcontractor invoice on the job: 10 & 10 whatever was last stored
  assert.deepEqual(tot.rows.map((r) => [txt(r[0]), txt(r[1])]), [
    ["Line item total", "$2,676.00"], ["Overhead (10%)", "$267.60"], ["Profit (10%)", "$267.60"],
    ["Replacement cost value", "$3,211.20"], ["Invoice total", "$3,211.20"]]);
  assert.deepEqual(tot._rows.map((r) => [txt(r[0]), txt(r[1])]), [["Payments received (as of 10/10/2026)", "-$500.00"], ["Balance due", "$2,711.20"]]);
  assert.equal(m.counts.invoices, 1);
  assert.equal(m.counts.invoiceTotal, 3211.2);
  assert.ok(blocksOf(m, "invoices").some((b) => b.t === "note" && b.text.startsWith("Remit to: Roybal Construction, LLC · 3850 Royal Rd, Fairbanks, AK 99701")));
  const att = blocksOf(m, "invoices").find((b) => b.t === "pages");
  assert.deepEqual(att.items, [{ media: hashOf(demoImages().invoiceAttachment), caption: "Invoice INV-1042 attachment — Drywall subcontractor invoice" }]);

  // no subcontractor on the job: 0 & 0, so no O&P rows
  const p = demoProject();
  p.invoices[0].attachments = [];
  const t0 = tableWith(build(p), "invoices", "Totals as billed").rows.map((r) => txt(r[0]));
  assert.deepEqual(t0, ["Line item total", "Replacement cost value", "Invoice total"]);
  // a legacy invoice (opAuto unset) keeps its stored percentages
  const q = demoProject();
  q.invoices[0].attachments = [];
  q.invoices[0].opAuto = undefined;
  q.invoices[0].overheadPct = "5";
  q.invoices[0].profitPct = "5";
  assert.deepEqual(tableWith(build(q), "invoices", "Totals as billed").rows.map((r) => txt(r[1])).slice(1, 3), ["$133.80", "$133.80"]);
  // amount mode is never auto-set
  const r = demoProject();
  Object.assign(r.invoices[0], { opMode: "amount", overheadAmount: "100", profitAmount: "50" });
  assert.deepEqual(tableWith(build(r), "invoices", "Totals as billed").rows.map((x) => [txt(x[0]), txt(x[1])]).slice(1, 3), [["Overhead", "$100.00"], ["Profit", "$50.00"]]);
});

test("model: counts and completeness gaps", () => {
  const m = build();
  assert.deepEqual(m.counts, { maps: 2, readings: 52, meterPhotos: 4, logs: 1, equipment: 7, scans: 9, photos: 12, docs: 1, invoices: 1, invoiceTotal: 3211.2 });
  assert.ok(Array.isArray(m.hardGaps) && m.hardGaps.every((g) => typeof g === "string"));
  assert.deepEqual(m.invoiceList, [{ number: "INV-1042", date: "2026-10-08", total: 3211.2 }]);
});

/* ============================== hash and versions ============================== */

test("hash: what doesn't print never makes a new version", () => {
  const h0 = modelHash(build());
  assert.match(h0, /^[0-9a-f]{64}$/);
  const same = (label, change, o = {}) => {
    const p = demoProject();
    change(p);
    assert.equal(modelHash(build(p, o)), h0, label);
  };
  same("payments pulled", (p) => {
    const inv = p.invoices[0];
    inv.payments.push({ amount: 2711.2, date: "2026-10-20", method: "ACH" });
    Object.assign(inv, { previousPayments: "3211.20", qboBalance: 0, qboBalanceAt: "2026-10-21T11:00:00Z", status: "paid" });
  });
  same("rowIds and sync stamps", (p) => {
    p.rowId = "row-1"; p.updatedAt = "2026-10-11T00:00:00Z"; p.rev = 41;
    p.invoices[0].rowId = "r-2"; p.photos[0].rowId = "r-3"; p.moistureMaps[0].rowId = "r-4";
  });
  same("a photo archived (cloud set, src rewritten to the 480 px copy)", (p) => {
    p.photos[0].cloud = hashOf(demoImages().photos[0]);
    p.photos[0].src = markerOf(demoImages().archivedSmall[1]);
  });
  same("another clock", (p) => p, { now: new Date("2027-01-15T03:00:00Z"), today: "2027-01-14" });
  same("a voided invoice edited", (p) => { p.invoices[1].items[0].price = "999"; });
  same("the excluded document replaced", (p) => { p.supportDocs[1].uploadedPages = [markerOf(demoImages().supportDoc)]; });

  // the as-of payment lines did change, outside the hash
  const p = demoProject();
  Object.assign(p.invoices[0], { previousPayments: "3211.20", qboBalance: 0 });
  const rows = tableWith(build(p), "invoices", "Totals as billed")._rows;
  assert.equal(txt(rows[1][1]), "$0.00");
});

test("hash: what prints changes the hash, and the right section", () => {
  const m0 = build();
  const h0 = sectionHashes(m0);
  assert.deepEqual(Object.keys(h0).sort(), ["cert", "cover", "docs", "floorPlan", "invoices", "logs", "maps", "photos", "workAuth"]);
  const diff = (change) => {
    const p = demoProject();
    change(p);
    const m = build(p);
    assert.notEqual(modelHash(m), modelHash(m0));
    return changedSections(h0, sectionHashes(m), m);
  };
  assert.deepEqual(diff((p) => { p.photos[3].caption = "Cabinet base dry and sealed"; }), ["Job Photos"]);
  assert.deepEqual(diff((p) => { p.moistureMaps[0].readings[1].values[0] = "26"; }), ["Moisture Maps"]);
  assert.deepEqual(diff((p) => { p.dryingLogs[0].equipment[1].removed = "2026-10-05T16:00"; }), ["Drying Logs"]);
  assert.deepEqual(diff((p) => { p.equipmentScans.find((e) => e.id === "scan-09").at = "2026-10-06T19:45:00Z"; }), ["Drying Logs"]);
  assert.deepEqual(diff((p) => { p.invoices[0].items[0].qty = "200"; }), ["Invoices"]);
  // a final reading with a meter photo prints on the certificate too
  assert.deepEqual(diff((p) => { p.moistureMaps[0].readings[3].values[0] = "15"; }), ["Certificate of Drying", "Moisture Maps"]);
  assert.deepEqual(diff((p) => { p.claimNo = "DEMO-12346"; }), ["Job and claim details", "Certificate of Drying", "Work Authorization", "Invoices"]);
  // a section that comes and goes
  assert.deepEqual(diff((p) => { p.packetExclude.push("photos"); }), ["Job Photos (removed)"]);
  const p = demoProject();
  p.packetExclude.push("photos");
  const without = build(p);
  assert.deepEqual(changedSections(sectionHashes(without), sectionHashes(m0), m0), ["Job Photos (added)"]);
  // no earlier hashes: nothing to compare
  assert.deepEqual(changedSections(null, h0, m0), []);
  assert.deepEqual(changedSections({}, h0, m0), []);
  assert.deepEqual(changedSections(h0, h0, m0), []);
  // the same model hashes the same, built twice
  assert.equal(modelHash(build()), modelHash(m0));
  assert.deepEqual(sectionHashes(build()), h0);
});

/* ============================== media budget ============================== */

test("planMedia: full under budget, compact over it", () => {
  const m = build();
  const sizes = demoMediaSizes();
  const full = planMedia(m, sizes, {});
  assert.equal(full.mode, "full");
  assert.ok(full.estimateBytes > 300000 && full.estimateBytes < 9500 * 1024);
  const keys = Object.entries(m.media).filter(([, r]) => r.full).map(([k]) => k);
  assert.deepEqual(full.load.map((l) => l.key).sort(), keys.sort());
  for (const l of full.load) assert.deepEqual(l.source, m.media[l.key].full);

  const compact = planMedia(m, sizes, { fullKb: 300 });
  assert.equal(compact.mode, "compact");
  assert.ok(compact.estimateBytes < full.estimateBytes);
  const img = demoImages();
  const src = (k) => compact.load.find((l) => l.key === k).source;
  assert.deepEqual(src(hashOf(img.photos[0])), { hash: "thumb_" + hashOf(img.photos[0])});     // a thumbnail in the bucket
  assert.deepEqual(src(hashOf(img.photos[2])), { hash: hashOf(img.archivedSmall[0]) });        // the archived copy
  assert.deepEqual(src(hashOf(img.photos[9])), { inline: img.archivedInline });               // inline small copy
  assert.deepEqual(src(hashOf(img.photos[3])), { hash: hashOf(img.photos[3]) }, "no thumbnail sized: the full photo");
  assert.deepEqual(src(LOST_MARKER.split(":")[1]), { hash: LOST_MARKER.split(":")[1] });
  assert.deepEqual(src(hashOf(img.meter[0])), { hash: hashOf(img.meter[0]) }, "meter photos are never swapped");
});

test("planMedia: the arithmetic", () => {
  const model = { media: {
    a: { kind: "photo", full: { hash: "a" }, small: { hash: "thumb_a" } },
    b: { kind: "photo", full: { hash: "b" }, small: { hash: "thumb_b" } },
    s: { kind: "sig", full: { inline: "data:image/png;base64,AAAA" }, small: null },
    x: { kind: "photo", full: null, small: null },
  } };
  const P = "data:image/jpeg;base64,".length;
  const sizes = new Map([["a", P + 4000], ["thumb_a", P + 400], ["b", P + 800]]);   // b has no thumbnail sized
  const fixed = 1024 + 3;
  assert.deepEqual(planMedia(model, sizes, { fullKb: 4.7, overheadKb: 1 }), {
    mode: "full", estimateBytes: fixed + 3000 + 600,
    load: [{ key: "a", source: { hash: "a" } }, { key: "b", source: { hash: "b" } }, { key: "s", source: { inline: "data:image/png;base64,AAAA" } }],
  });
  const c = planMedia(model, sizes, { fullKb: 4, overheadKb: 1 });
  assert.equal(c.mode, "compact");
  assert.equal(c.estimateBytes, fixed + 300 + 600);
  assert.deepEqual(c.load.map((l) => l.source), [{ hash: "thumb_a" }, { hash: "b" }, { inline: "data:image/png;base64,AAAA" }]);
  // the default overhead is 60 KB; an object the sizes don't list counts as nothing
  assert.equal(planMedia(model, new Map(), {}).estimateBytes, 60 * 1024 + 3);
  // a plain object works as the sizes too
  assert.equal(planMedia(model, { a: P + 4000 }, { overheadKb: 0 }).estimateBytes, 3003);
});

test("mediaNames: every bucket object the plan may need, once", () => {
  const m = build();
  const names = mediaNames(m);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^(thumb_)?[0-9a-f]{64}$/);
  const img = demoImages();
  for (const n of [hashOf(img.photos[0]), "thumb_" + hashOf(img.photos[0]), hashOf(img.archivedSmall[0]), hashOf(img.meter[2]), hashOf(img.floorPlanPage)]) assert.ok(names.includes(n), n);
  // everything the bucket holds for this job is named, except the unticked document and the upload-mode pages
  const unused = new Set([hashOf(img.excludedDoc), ...img.certUpload.map(hashOf)]);
  for (const k of demoMediaStore().keys()) if (!unused.has(k)) assert.ok(names.includes(k), k);
  assert.ok(!names.includes(hashOf(img.excludedDoc)));
});

/* ============================== words ============================== */

test("emailText: subject, body and file name", () => {
  const m = build();
  const e = emailText(m, LABEL);
  assert.equal(e.subject, "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)");
  assert.equal(e.filename, "PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf");
  assert.ok(e.body.startsWith("Hello,\n\n"));
  for (const l of ["Insured: Jane Sample", "Property: 123 Example St, Fairbanks, AK 99701", "Claim: DEMO-12345", "Carrier: Sample Mutual", "Date of loss: 09/30/2026",
    "- Certificate of Drying, dated 10/06/2026", "- Moisture maps: 2 maps, 52 readings, 4 meter photos", "- Drying logs: 1 log, 7 pieces of equipment, 9 equipment scans",
    "- Photos: 12", "- Invoice INV-1042: $3,211.20", "Please reply to confirm you received it.", "Branden Roybal", "IICRC WRT #70233261"]) {
    assert.ok(e.body.includes(l), l);
  }
  assert.ok(!e.body.includes("replaces"));
  assert.ok(!e.body.includes("reduced in size"));
  assert.ok(!/\$500|2,711/.test(e.body), "no payment figures in the email");

  const v2 = emailText(m, { ...LABEL, version: 2, replaces: { version: 1, sentAt: "2026-10-13T02:00:00Z" }, changed: ["Invoices", "Job Photos"], mode: "compact" });
  assert.equal(v2.subject, "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v2)");
  assert.ok(v2.body.includes("This version replaces version 1 sent 10/12/2026. What changed: Invoices, Job Photos."));
  assert.ok(v2.body.includes("Photos are reduced in size to keep this email under carrier size limits; full-size photos are available on request."));
  assert.equal(v2.filename, "PKT-2026-0007 v2 - Claim DEMO-12345 - Sample.pdf");

  // no claim number, odd characters in the name
  const p = demoProject();
  p.claimNo = "";
  p.customer = "Jane O'Sample/Smith";
  const e3 = emailText(build(p), LABEL);
  assert.equal(e3.subject, "Jane O'Sample/Smith - water mitigation documentation (PKT-2026-0007 v1)");
  assert.equal(e3.filename, "PKT-2026-0007 v1 - OSampleSmith.pdf");
  assert.ok(e3.filename.length <= 200);
});

test("rationaleText: one fact a line", () => {
  const m = build();
  const r = rationaleText(m, LABEL, { recipient: { to: "adjuster@example.com", source: "claim" }, bytes: 3.3 * 1048576, pages: 41, mode: "full", missing: 0, changed: [] });
  assert.deepEqual(r.split("\n").slice(0, 4), [
    "Carrier packet PKT-2026-0007 v1 for Jane Sample (claim DEMO-12345), 123 Example St, Fairbanks, AK 99701.",
    "Suggested To: adjuster@example.com, from the newest email filed to this job on its claim number.",
    "41 pages, 3.3 MB.",
    "Still out on the drying log (no pull time): AM-014 (Kitchen).",
  ]);
  assert.ok(!r.includes("Compact"));
  const big = rationaleText(m, { ...LABEL, version: 2, replaces: { version: 1, sentAt: "2026-10-13T02:00:00Z" } },
    { recipient: { to: "", source: "" }, bytes: 11 * 1048576, pages: 60, mode: "compact", missing: 2, changed: ["Invoices"] });
  for (const l of ["No adjuster address on file: type it in the To field.", "60 pages, 11.0 MB. Warning: over 10 MB, which some carrier mailboxes refuse.",
    "Compact mode: photos are reduced in size to keep the email under carrier size limits.", '2 images could not be found and print as "Image not available".',
    "Replaces version 1 sent 10/12/2026. What changed: Invoices."]) {
    assert.ok(big.split("\n").includes(l), l);
  }
});

test("readyText, holdText and suggestedFrom", () => {
  const m = build();
  assert.equal(readyText(m, LABEL), "Carrier packet PKT-2026-0007 v1 for Jane Sample (claim DEMO-12345) is ready. Review and send it from Approvals in the office app. No reply needed.");
  const texts = {
    no_invoice: holdText("no_invoice", m, "no numbered invoice"),
    unchecked_fills: holdText("unchecked_fills", m, "3 meter readings to check"),
    unread_meter_photos: holdText("unread_meter_photos", demoProject(), "1 meter photo on an empty reading not read yet"),
    failed: holdText("failed", m, "renderer error"),
    permanent: holdText("failed_cap", m, "render: x", { permanent: true }),
    too_large: holdText("too_large", m, ""),
    storage_full: holdText("storage_full", null, ""),
    other: holdText("something_new", m, "a detail"),
  };
  assert.equal(texts.unchecked_fills, "Carrier packet for Jane Sample (claim DEMO-12345) is waiting: 3 meter readings to check on the Moisture Map (tap each amber ?). No reply needed.");
  assert.ok(texts.unread_meter_photos.includes("Jane Sample (claim DEMO-12345) is waiting: 1 meter photo on an empty reading"), "a job blob works in place of a model");
  assert.ok(texts.failed.includes("couldn't be built after 3 tries"));
  assert.equal(texts.permanent, "Carrier packet for Jane Sample (claim DEMO-12345) couldn't be built: something in the job stops it. It is not tried again until the job changes. No reply needed.");
  assert.ok(texts.storage_full.startsWith("Carrier packets are on hold: packet storage is full"));
  assert.equal(holdText("anything", null, ""), texts.storage_full);
  for (const t of Object.values(texts)) {
    assert.ok(t.endsWith("No reply needed."), t);
    assert.ok(!/\bYES\b/.test(t), t);
    assert.ok(t.length < 320, t);
  }
  assert.equal(suggestedFrom("last_sent", { version: 2, replaces: { version: 1 } }), "where version 1 of this packet was sent");
  assert.equal(suggestedFrom("claim", LABEL), "the newest email filed to this job on its claim number");
  assert.equal(suggestedFrom("email", LABEL), "the newest email filed to this job");
  assert.equal(suggestedFrom("adjuster", LABEL), "the job's Adjuster field");
  assert.equal(suggestedFrom("", LABEL), "nothing on file: type the adjuster's address");
  for (const s of ["last_sent", "claim", "email", "adjuster", "", "unknown"]) assert.ok(suggestedFrom(s, LABEL).length <= 200);
});
