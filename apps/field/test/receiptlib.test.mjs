/* receiptlib.js — the office Receipts page's pure logic (plan phase 2):
   the text index, all-words + money search, filters, returns as credit
   elements (derived returned state, caps, the credit's money strings),
   vendor return windows (prefix cover) and the window-closing flag.
   Run: node --test test/receiptlib.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex, matchQuery, matchedLines, filterEntries, summarize, windowFor, vendorGroups,
  returnFlags, leadDays, returnSources, remainingQty, refundLeft, prefillRefund, checkReturn,
  buildReturnCredit, slipCandidates, nextStamp, negMoney, money2, receiptDay, daysBetween,
  addDaysISO, validISO, returnStatus, overReturned, needsTotal, isReturn, vendorMatches,
  returnTargets, refundCap, successorId, returnLineage, deletePlan,
} from "../js/receiptlib.js";
import { amountNum, receiptTotals } from "../js/receiptcalc.js";
import { loggedCosts } from "../js/fincalc.js";
import { mergeProjects, tombstoneItems } from "../js/merge.js";

const PLY = { id: "i1", desc: '3/4" CDX plywood 4x8', qty: "10", unit: "ea", price: "52.98", sku: "166073" };
const KILZ = { id: "i2", desc: "KILZ 2 all-purpose primer 1 gal", qty: "2", unit: "ea", price: "24.98", sku: "" };
const DISC = { id: "i3", desc: "Pro Xtra discount", qty: "1", unit: "", price: "-10.00", sku: "" };
const bemis = () => ({
  id: "job-bemis", customer: "Pollen", address: "1192 Bemis Ct", claimNo: "CLM-9",
  receipts: [
    { id: "R1", vendor: "THE HOME DEPOT #1234", date: "2026-07-17", amount: "569.76", subtotal: "569.76", tax: "", category: "materials",
      receiptNo: "0612-00412", cardLast4: "4558", paidWith: "card", items: [PLY, KILZ, DISC], photo: "data:image/jpeg;base64,AAAA" },
    { id: "R2", vendor: "Home Depot", date: "2026-07-20", amount: "120.00", category: "materials",
      items: [{ id: "j1", desc: "2x4x8 stud", qty: "20", unit: "ea", price: "6.00", sku: "" }] },
    { id: "R3", vendor: "Alaska Rent-All", date: "2026-07-20", amount: "300", category: "equipment", items: [] },
    { id: "R4", vendor: "Home Depot", date: "2026-07-21", amount: "", category: "materials", photo: "data:image/jpeg;base64,BB",
      items: [{ id: "s1", desc: "2x4x8 stud", qty: "1", price: "-6.00" }], notes: "a return slip" },
  ],
});
const chena = () => ({ id: "job-chena", customer: "Smith", address: "1885 Chena Landings",
  receipts: [{ id: "S1", vendor: "Spenard Builders Supply", date: "2026-08-02", amount: "88.10", category: "materials", items: [] }] });

test("index: one text entry per receipt, job attached, tombstoned and null skipped, no photo strings", () => {
  const p = bemis(); p.receipts.push(null, { id: "DEAD", vendor: "x", amount: 1 }); p.deletedIds = { DEAD: "2026-07-22T00:00:00Z" };
  const idx = buildIndex([p, chena(), { id: "nor" }, null]);
  assert.equal(idx.length, 5);
  const r1 = idx.find((e) => e.id === "R1");
  assert.equal(r1.vkey, "home depot");
  assert.equal(r1.job.address, "1192 Bemis Ct");
  assert.equal(r1.amount, 569.76);
  assert.equal(r1.pages, 1);
  assert.ok(!JSON.stringify(idx).includes("data:image"), "the index never holds an image");
});

test("search: every word, inch marks and case ignored; money matches a total or a line", () => {
  const idx = buildIndex([bemis(), chena()]);
  const ids = (q) => idx.filter((e) => matchQuery(e, q)).map((e) => e.id);
  assert.deepEqual(ids("3/4 plywood"), ["R1"], "the plan's own example");
  assert.deepEqual(ids("kilz primer"), ["R1"]);
  assert.deepEqual(ids('CDX 3/4"'), ["R1"]);
  assert.deepEqual(ids("bemis stud"), ["R2", "R4"], "job address + item");
  assert.deepEqual(ids("166073"), ["R1"], "sku");
  assert.deepEqual(ids("4558"), ["R1"], "card last 4");
  assert.deepEqual(ids("$569.76"), ["R1"], "a total");
  assert.deepEqual(ids("52.98"), ["R1"], "a unit price");
  assert.deepEqual(ids("120"), ["R2"], "a whole-dollar total");
  assert.deepEqual(ids("plywood spenard"), [], "words must all land on one receipt");
  assert.equal(matchedLines(idx[0], "3/4 plywood")[0].id, "i1");
});

test("filters: vendor prefix, job, date preset, show; hidden count explains an empty page", () => {
  const idx = buildIndex([bemis(), chena()]);
  const run = (f) => filterEntries(idx, { today: "2026-08-10", ...f });
  assert.deepEqual(run({ vendor: "home depot" }).rows.map((e) => e.id), ["R4", "R2", "R1"], "newest first");
  assert.ok(vendorMatches("home depot pro", "home depot") && !vendorMatches("home depotter", "home depot"));
  assert.deepEqual(run({ job: "job-chena" }).rows.map((e) => e.id), ["S1"]);
  assert.deepEqual(run({ preset: "30", today: "2026-08-25" }).rows.map((e) => e.id), ["S1"], "last 30 days");
  assert.deepEqual(run({ show: "needs" }).rows.map((e) => e.id), ["R4"]);
  const r = run({ q: "plywood", job: "job-chena" });
  assert.equal(r.rows.length, 0);
  assert.equal(r.hidden, 1, "one match outside these filters");
});

test("money strings: what a credit writes parses the same in every reader", () => {
  for (const n of [45.97, 0.01, 1234.5, 2000, "45.97", "-45.97", "$1,234.50"]) {
    const s = negMoney(n);
    assert.match(s, /^-?\d*\.?\d+$/, "the 0015 SQL regex (after stripping $ , space)");
    assert.equal(amountNum(s), Number(s), "receiptcalc amountNum = fincalc/digest Number()");
    assert.ok(Number(s) < 0);
  }
  assert.equal(negMoney(45.974), "-45.97");
  assert.equal(money2("-45.97"), "45.97");
  assert.equal(negMoney(0), "0.00");
});

test("a return: credit element, derived state, nets everywhere, survives a stale crew copy", () => {
  const p = bemis();
  const idx = buildIndex([p]);
  const sources = returnSources(idx, p.id, "R1");
  assert.deepEqual(sources.map((e) => e.id), ["R1", "R2"], "same job, same store; the $0 slip is not a source");
  const picks = [{ receiptId: "R1", itemId: "i1", qty: 3 }, { receiptId: "R2", itemId: "j1", qty: 5 }];
  const byId = new Map(sources.map((e) => [e.id, e]));
  assert.equal(prefillRefund(picks, byId), 188.94);
  assert.equal(checkReturn({ entries: idx, jobId: p.id, returnOf: "R1", picks, refund: 188.94 }), null);
  const c = buildReturnCredit({ id: "C1", start: sources[0], sources, picks, refund: 188.94, date: "2026-08-01",
    slipNo: "RS-77", note: "leftovers", photo: "data:image/jpeg;base64,SLIP", by: "branden@roybalconstruction.com", nowISO: "2026-08-01T20:00:00.000Z" });
  assert.equal(c.kind, "return");
  assert.equal(c.returnOf, "R1");
  assert.equal(c.amount, "-188.94");
  assert.equal(c.category, "materials");
  assert.deepEqual(c.items.map((l) => [l.of, l.ofReceipt, l.qty, l.price]), [["i1", "R1", "3", "-52.98"], ["j1", "R2", "5", "-6.00"]]);
  assert.match(c.notes, /^↩ Return of THE HOME DEPOT #1234 2026-07-17 receipt #0612-00412 \(\+1 more receipt\) — leftovers$/);
  p.receipts.push(c);

  // every money reader nets it
  assert.equal(receiptTotals(p).total, 800.82);
  assert.ok(Math.abs(loggedCosts(p) - 800.82) < 0.005, "fincalc nets it too");

  // derived state: split by line value, qty per item
  const after = buildIndex([p]);
  const r1 = after.find((e) => e.id === "R1"), r2 = after.find((e) => e.id === "R2");
  assert.equal(r1.returnedQty.i1, 3);
  assert.equal(r2.returnedQty.j1, 5);
  assert.equal(Math.round((r1.returned + r2.returned) * 100) / 100, 188.94);
  assert.equal(returnStatus(r1), "part");
  assert.equal(remainingQty(r1, r1.items[0]), 7);
  assert.ok(isReturn(after.find((e) => e.id === "C1")));

  // the office's credit can't be undone by a crew copy that is newer but never saw it
  const crew = bemis(); crew.updatedAt = "2026-08-02T00:00:00.000Z"; crew.receipts[0].notes = "crew edit";
  const office = { ...p, updatedAt: nextStamp("2026-07-30T00:00:00.000Z") };
  const { merged } = mergeProjects(office, crew);
  const rs = (merged.receipts || []).map((r) => r.id);
  assert.ok(rs.includes("C1"), "the credit unions in");
  assert.equal(merged.receipts.find((r) => r.id === "R1").notes, "crew edit", "the crew's newer edit to R1 wins");
});

test("returns: an AI re-read that minted new item ids keeps the link by sku or description", () => {
  const p = bemis();
  p.receipts.push({ id: "C1", kind: "return", returnOf: "R1", amount: "-105.96",
    items: [{ id: "C1-1", of: "i1", ofReceipt: "R1", desc: PLY.desc, qty: "2", price: "-52.98", sku: "166073" }] });
  p.receipts[0].items = [{ ...PLY, id: "ri-new1" }, { ...KILZ, id: "ri-new2" }];
  const r1 = buildIndex([p]).find((e) => e.id === "R1");
  assert.equal(r1.returnedQty["ri-new1"], 2);
  p.receipts[0].items = [{ ...PLY, id: "ri-new3", sku: "" }];
  assert.equal(buildIndex([p]).find((e) => e.id === "R1").returnedQty["ri-new3"], 2, "by description when the sku is gone");
});

test("returns: caps, bounds and orphans", () => {
  const p = bemis();
  let idx = buildIndex([p]);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R4", picks: [], refund: 5 }), /no total/);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "NOPE", picks: [], refund: 5 }), /no longer on the job/);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R1", picks: [], refund: 0 }), /Enter the refund/);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R1", picks: [{ receiptId: "R1", itemId: "i2", qty: 3 }], refund: 10 }), /Only 2 of/);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R2", picks: [], refund: 4597 }), /more than what's left/, "a typo can't book −$4,597");
  assert.equal(checkReturn({ entries: idx, jobId: p.id, returnOf: "R2", picks: [], refund: 4597, over: true }), null, "store credit / exchange override");
  p.receipts.push({ id: "C9", kind: "return", returnOf: "R2", amount: "-100", items: [] });
  idx = buildIndex([p]);
  assert.equal(refundLeft(idx.find((e) => e.id === "R2")), 20);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R2", picks: [], refund: 30 }), /\$20\.00/);
  p.receipts.push({ id: "C10", kind: "return", returnOf: "R2", amount: "-50", items: [] });
  assert.ok(overReturned(buildIndex([p]).find((e) => e.id === "R2")));
  p.receipts = p.receipts.filter((r) => r.id !== "R2");
  const orphan = buildIndex([p]).find((e) => e.id === "C9");
  assert.ok(orphan.orphan, "a return whose receipt is gone is an orphan");
  assert.equal(receiptTotals(p).credits, -150, "an orphan still nets: the refund was real");
});

test("slips the crew snapped: a $0 receipt with a photo on the same job", () => {
  const idx = buildIndex([bemis(), chena()]);
  assert.deepEqual(slipCandidates(idx, "job-bemis").map((e) => e.id), ["R4"]);
  assert.ok(needsTotal(idx.find((e) => e.id === "R4")));
});

test("vendor windows: whole-word prefix cover, longest key wins; groups list what nothing covers", () => {
  const W = [{ vendor_key: "home depot", return_days: 90, display_name: "Home Depot" },
    { vendor_key: "home depot rental", return_days: 0 }, { vendor_key: "spenard builders supply", return_days: 30 }];
  assert.equal(windowFor(W, "home depot").return_days, 90);
  assert.equal(windowFor(W, "home depot pro").return_days, 90);
  assert.equal(windowFor(W, "home depot rental").return_days, 0, "a longer key overrides");
  assert.equal(windowFor(W, "home depotter"), null, "whole words only");
  assert.equal(windowFor(W, "lowes"), null);
  const g = vendorGroups(buildIndex([bemis(), chena()]), W);
  assert.deepEqual(g.map((x) => x.key), ["home depot", "alaska rent all", "spenard builders supply"]);
  assert.equal(g[0].label, "Home Depot");
  assert.equal(g[0].count, 3);
  assert.ok(g[0].own && !g[0].covering);
});

test("dates: calendar days, local day for a blank date, impossible dates rejected", () => {
  assert.equal(daysBetween("2027-03-10", "2027-03-20"), 10, "across the DST change");
  assert.equal(addDaysISO("2026-07-17", 90), "2026-10-15");
  assert.ok(!validISO("2026-02-30") && validISO("2028-02-29"));
  process.env.TZ = "America/Anchorage";
  assert.equal(receiptDay({ date: "", createdAt: "2026-10-06T02:30:00.000Z" }), "2026-10-05", "5:30 PM in Fairbanks is still the 5th");
  assert.equal(receiptDay({ date: "2026-02-30", createdAt: "2026-03-01T20:00:00.000Z" }), "2026-03-01");
});

test("flag: materials ≥ $50 inside the lead, grouped by job + store; a return or 'nothing left over' clears it", () => {
  const W = [{ vendor_key: "home depot", return_days: 90, display_name: "Home Depot" }, { vendor_key: "spenard builders supply", return_days: 7 }];
  const p = bemis(); const c = chena();
  c.receipts[0].date = "2026-10-02";                          // Spenard, 7-day window: closes 10-09, lead 3
  const idx = buildIndex([p, c]);
  assert.equal(leadDays(90), 14); assert.equal(leadDays(7), 3); assert.equal(leadDays(28), 14);
  // R1 closes 2026-10-15, R2 2026-10-18; on 2026-10-05: R1 in 10 days, R2 13; Spenard 4 (outside its lead)
  let f = returnFlags(idx, W, [], "2026-10-05");
  assert.equal(f.length, 1);
  assert.equal(f[0].vendor, "Home Depot");
  assert.equal(f[0].job.address, "1192 Bemis Ct");
  assert.deepEqual(f[0].receipts.map((r) => r.id), ["R1", "R2"]);
  assert.equal(f[0].left, 10);
  assert.equal(f[0].total, 689.76);
  f = returnFlags(idx, W, [], "2026-10-06");
  assert.equal(f.length, 2, "Spenard enters its 3-day lead");
  assert.equal(returnFlags(idx, W, [], "2026-10-16")[0].receipts.length, 1, "a closed window drops out");
  assert.equal(returnFlags(idx, W, [{ job_id: "job-bemis", receipt_id: "R1", status: "nothing_to_return" }], "2026-10-05")[0].receipts.length, 1);
  p.receipts.push({ id: "C1", kind: "return", returnOf: "R2", amount: "-12", items: [] });
  assert.deepEqual(returnFlags(buildIndex([p]), W, [], "2026-10-05")[0].receipts.map((r) => r.id), ["R1"], "any return clears its receipt");
  assert.equal(returnFlags(idx, [], [], "2026-10-05").length, 0, "no windows, no flags");
  const small = bemis(); small.receipts[1].amount = "49.99";
  assert.deepEqual(returnFlags(buildIndex([small]), W, [], "2026-10-05")[0].receipts.map((r) => r.id), ["R1"], "under $50 is not worth the trip");
});

test("append-only stamp: one millisecond past the copy it was made from", () => {
  assert.equal(nextStamp("2026-10-05T20:00:00.000Z"), "2026-10-05T20:00:00.001Z");
  assert.equal(nextStamp(undefined), "1970-01-01T00:00:00.001Z");
});

test("summary line: net spend and returns apart", () => {
  const p = bemis(); p.receipts.push({ id: "C1", kind: "return", returnOf: "R1", amount: "-69.76", items: [] });
  const s = summarize(buildIndex([p]));
  assert.deepEqual(s, { spent: 920, returned: 69.76, purchases: 4, returns: 1 });
});

test("the cap is the room on the receipts the items came from, and the credit is booked there", () => {
  const p = bemis();
  const idx = buildIndex([p]);
  // started from R1 (hundreds of dollars of room), only R2's studs picked: R2's $120 is the cap
  const picks = [{ receiptId: "R2", itemId: "j1", qty: 1 }];
  assert.deepEqual(returnTargets("R1", picks), ["R2"]);
  assert.deepEqual(returnTargets("R1", []), ["R1"], "a refund with nothing picked books against the starting receipt");
  assert.equal(refundCap(idx, p.id, ["R2"]), 120);
  assert.match(checkReturn({ entries: idx, jobId: p.id, returnOf: "R1", picks, refund: 130 }), /left on the receipt \(\$120\.00\)/);
  assert.equal(checkReturn({ entries: idx, jobId: p.id, returnOf: "R1", picks, refund: 6 }), null);
  const sources = returnSources(idx, p.id, "R1");
  const c = buildReturnCredit({ id: "C2", start: sources[0], sources, picks, refund: 6, date: "2026-08-01", nowISO: "2026-08-01T20:00:00.000Z" });
  assert.equal(c.returnOf, "R2", "booked against the receipt its items came from");
  assert.equal(c.notes, "↩ Return of Home Depot 2026-07-20 receipt");
  p.receipts.push(c);
  const after = buildIndex([p]);
  assert.equal(after.find((e) => e.id === "R2").returned, 6);
  assert.equal(after.find((e) => e.id === "R1").returned, 0);
  // a change keeps every receipt it already draws from, even one whose store was retyped
  p.receipts[1].vendor = "HD Supply";
  assert.deepEqual(returnSources(buildIndex([p]), p.id, "R1").map((e) => e.id), ["R1"]);
  assert.deepEqual(returnSources(buildIndex([p]), p.id, "R1", ["R2"]).map((e) => e.id), ["R1", "R2"]);
});

test("a return across receipts splits by what each one charged: a discount, tax; misread lines at face value", () => {
  const door = (id, price) => ({ id, desc: "slab door", qty: "1", price });
  const p = { id: "j", receipts: [
    { id: "R5", vendor: "Home Depot", amount: "50", category: "materials", items: [door("a", "100")] },     // half off
    { id: "R6", vendor: "Home Depot", amount: "100", category: "materials", items: [door("b", "100")] },
    { id: "C", kind: "return", returnOf: "R5", amount: "-150", items: [
      { id: "C-1", of: "a", ofReceipt: "R5", desc: "slab door", qty: "1", price: "-100" },
      { id: "C-2", of: "b", ofReceipt: "R6", desc: "slab door", qty: "1", price: "-100" }] },
  ] };
  let idx = buildIndex([p]);
  const r5 = idx.find((e) => e.id === "R5"), r6 = idx.find((e) => e.id === "R6");
  assert.equal(r5.returned, 50);
  assert.equal(r6.returned, 100);
  assert.equal(returnStatus(r5), "all");
  assert.ok(!overReturned(r5), "no false 'more than the receipt'");
  assert.equal(refundLeft(r6), 0, "no phantom room left on R6");
  // lines adding to far less than the total were misread: they count at face value
  p.receipts[0] = { ...p.receipts[0], amount: "400" };
  idx = buildIndex([p]);
  assert.equal(idx.find((e) => e.id === "R5").returned, 75);
});

test("a return's id across changes: two devices changing it keep one; a delete beats a change in flight", () => {
  assert.equal(successorId("c7k2"), "c7k2~1");
  assert.equal(successorId("c7k2~1"), "c7k2~2");
  assert.equal(successorId("a~b~9"), "a~b~10");
  assert.deepEqual(returnLineage("c7k2~1"), ["c7k2~1", "c7k2~2", "c7k2~3", "c7k2~4"]);
  const base = bemis();
  base.updatedAt = "2026-08-01T00:00:00.000Z";
  base.receipts.push({ id: "C", kind: "return", returnOf: "R2", amount: "-12.00", items: [] });
  const change = (amount, at) => {
    const d = JSON.parse(JSON.stringify(base));
    const old = d.receipts.find((r) => r.id === "C");
    d.receipts = d.receipts.filter((r) => r.id !== "C");
    d.receipts.push({ ...old, id: successorId("C"), amount });
    tombstoneItems(d, ["C"]);
    d.updatedAt = at;
    return d;
  };
  const a = change("-18.00", "2026-08-02T00:00:00.000Z"), b = change("-24.00", "2026-08-03T00:00:00.000Z");
  const credits = (p) => p.receipts.filter((r) => r && r.kind === "return");
  const both = mergeProjects(a, b).merged;
  assert.deepEqual(credits(both).map((r) => [r.id, r.amount]), [["C~1", "-24.00"]], "one return, the later change");
  const del = JSON.parse(JSON.stringify(base));
  del.receipts = del.receipts.filter((r) => r.id !== "C");
  tombstoneItems(del, returnLineage("C"));
  del.updatedAt = "2026-08-01T12:00:00.000Z";
  assert.equal(credits(mergeProjects(a, del).merged).length, 0, "the delete wins over a change made before it was heard of");
  assert.equal(credits(mergeProjects(del, a).merged).length, 0);
});

test("the phone's 🗑 on a receipt: its own returns go with it; a return also covering another receipt stops it", () => {
  const p = bemis();
  p.receipts.push({ id: "C1", kind: "return", returnOf: "R2", amount: "-12", items: [{ id: "C1-1", of: "j1", ofReceipt: "R2", desc: "2x4x8 stud", qty: "2", price: "-6" }] });
  assert.deepEqual(deletePlan(p, "R2"), { kill: ["R2", "C1", "C1~1", "C1~2", "C1~3"], returns: 1 });
  assert.deepEqual(deletePlan(p, "R3"), { kill: ["R3"], returns: 0 });
  p.receipts.push({ id: "C2", kind: "return", returnOf: "R1", amount: "-58.98", items: [
    { id: "C2-1", of: "i1", ofReceipt: "R1", desc: PLY.desc, qty: "1", price: "-52.98" },
    { id: "C2-2", of: "j1", ofReceipt: "R2", desc: "2x4x8 stud", qty: "1", price: "-6" }] });
  assert.match(deletePlan(p, "R2").refuse, /also covers another receipt/);
  assert.match(deletePlan(p, "R1").refuse, /also covers another receipt/);
});
