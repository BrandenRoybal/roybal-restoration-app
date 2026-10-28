/* SMS-link helpers — pure logic only (storage/navigator wrappers are browser-side).
   Run: node apps/field/test/sms.test.mjs   (from repo root) */
import assert from "node:assert";
import { normalizePhone, smsHref, fieldReportSms, onOurWaySms } from "../js/sms.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("SMS links");

ok("normalize strips punctuation", normalizePhone("907-371-9868") === "9073719868");
ok("normalize keeps a leading +", normalizePhone("+1 (907) 555-0101") === "+19075550101");
ok("normalize empties junk", normalizePhone(" - ") === "" && normalizePhone(null) === "");

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const AND = "Mozilla/5.0 (Linux; Android 14)";
ok("iOS uses the ?& body quirk", smsHref("907-371-9868", "hi", IOS) === "sms:9073719868?&body=hi");
ok("Android uses standard ?body", smsHref("907-371-9868", "hi", AND) === "sms:9073719868?body=hi");
ok("multiple recipients comma-join", smsHref(["907-371-9868", "+1 907 555 0101"], "x", AND).startsWith("sms:9073719868,+19075550101?"));
ok("no recipients -> empty href", smsHref([" "], "x", AND) === "");
ok("body is URL-encoded", smsHref("907", "a b\nc", AND).endsWith("body=a%20b%0Ac"));

const proj = { customer: "Jeff Hebard", address: "1192 Bemis Ct.", phone: "907-322-5450" };
const report = { date: "2026-07-11", notes: "Demo done in the hall", issues: "Hidden rot behind tub",
  materials: "2x4x8 (6), 6-mil poly", photos: [1, 2], completedBy: "Mike" };
const body = fieldReportSms(proj, report, "Tech");
ok("report text leads with the job header", body.startsWith("FIELD REPORT — Jeff Hebard — 2026-07-11"));
ok("report text carries all three sections", /Notes: Demo done/.test(body) && /ISSUES: Hidden rot/.test(body) && /Materials needed: 2x4x8/.test(body));
ok("photo count mentioned", /2 photos on the Field Report/.test(body));
ok("signed by the reporter", body.trim().endsWith("— Mike"));
const sparse = fieldReportSms(proj, { date: "2026-07-11", notes: "", issues: "leak", materials: "", photos: [] }, "");
ok("empty sections stay out", !/Notes:/.test(sparse) && /ISSUES: leak/.test(sparse) && !/photo/.test(sparse));

const oow = onOurWaySms(proj, "Mike Reyes");
ok("on-our-way greets by first name", oow.startsWith("Hi Jeff,"));
ok("on-our-way names the tech + company", /Mike Reyes with Roybal Construction, LLC/.test(oow));
ok("on-our-way includes the address", /1192 Bemis Ct\./.test(oow));

console.log(`\n${pass} sms checks passed.`);

/* ---------- message log (claim documentation) ---------- */
const { logSms } = await import("../js/sms.js");
const projLog = { customer: "Jeff" };
const entry = logSms(projLog, { kind: "onOurWay", to: "907-322-5450", body: "Hi Jeff, we're on our way…", by: "Mike" });
ok("log entry stamped with kind/to/by", entry.kind === "onOurWay" && entry.to.join() === "9073225450" && entry.by === "Mike");
ok("log entry carries an ISO timestamp + preview", /^\d{4}-\d{2}-\d{2}T/.test(entry.at) && entry.preview.startsWith("Hi Jeff"));
for (let i = 0; i < 210; i++) logSms(projLog, { kind: "text", to: "907", body: "x" + i });
ok("log capped at 200 entries", projLog.smsLog.length === 200);
ok("cap keeps the newest entries", projLog.smsLog[199].preview === "x209");

console.log(`(+ message log checks)`);
