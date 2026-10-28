/* Company-number texting is the only lane (field v210): the per-device
   "Send texts from the company number" checkbox is gone, so every text
   button sends through roybal-notify on every phone, including one that
   never ticked the old box. What each sender does when that send can't
   go through: smartSend (on our way, Field Report → office) opens
   Messages pre-filled; assistSend (board / admin chips) does too, except
   for a quiet-hours refusal. A second tap on a text still sending is
   ignored, so a slow signal can't text a customer twice. Runs in jsdom
   against a faked roybal-notify; `location` is a plain object so the
   Messages fallback can be read back.
   Run: node --test test/sms-company.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/" });
const { window } = dom;
for (const k of ["document", "window", "navigator", "HTMLElement", "Node", "Event", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.location = { href: "" };
/* signed in BEFORE supa.js loads (it reads the session at import); no
   roybal-company-sms key, like every crew phone that never ticked the box */
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "a.b.c", refresh_token: "r", email: "crew@x.com", expires_at: Date.now() + 1e9 }));

/* ---- fake roybal-notify ---- */
const calls = [];
let notify = () => [200, { ok: true, sid: "SM1", status: "queued" }];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.pathname !== "/functions/v1/roybal-notify") throw new Error("unexpected request " + u.pathname);
  const body = JSON.parse(opts.body);
  calls.push(body);
  const out = await notify(body);
  if (out instanceof Error) throw out;
  const [status, json] = out;
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

const sms = await import("../js/sms.js");
const toastText = () => document.getElementById("toast").textContent;
const reset = () => { calls.length = 0; location.href = ""; notify = () => [200, { ok: true, sid: "SM1", status: "queued" }]; };

test("the checkbox's helpers are gone: nothing left to read or flip", () => {
  assert.equal(sms.companySendEnabled, undefined);
  assert.equal(sms.setCompanySend, undefined);
  assert.equal(window.localStorage.getItem("roybal-company-sms"), null, "this phone never ticked the old box");
});

test("on our way goes out from the company number, logged with its sid and status", async () => {
  reset();
  const project = { customer: "Jeff Hebard", phone: "907-322-5450" };
  let saves = 0;
  await sms.smartSend(project, { recipients: project.phone, body: "Hi Jeff, we're on our way", kind: "onOurWay", by: "Mike", onChange: () => saves++ });
  assert.deepEqual(calls, [{ action: "sendSms", to: "9073225450", body: "Hi Jeff, we're on our way", kind: "onOurWay", captured_by: "Mike", unified_job_id: null }]);
  const e = project.smsLog[0];
  assert.equal(e.via, "company");
  assert.equal(e.status, "queued");
  assert.equal(e.sid, "SM1");
  assert.equal(e.error, undefined);
  assert.equal(location.href, "", "Messages never opens when the company send works");
  assert.equal(toastText(), "Sent from your company number ✓");
  assert.ok(saves >= 2, "saved when logged and again when the send landed");
});

test("Field Report to two office numbers: one company text each", async () => {
  reset();
  let n = 0;
  notify = () => [200, { ok: true, sid: "SM" + (++n), status: "queued" }];
  const project = {};
  await sms.smartSend(project, { recipients: ["907-371-9868", "907-555-0102"], body: "FIELD REPORT — job", kind: "fieldReport", by: "Mike" });
  assert.deepEqual(calls.map((c) => [c.to, c.kind]), [["9073719868", "fieldReport"], ["9075550102", "fieldReport"]]);
  assert.equal(project.smsLog.length, 1, "one log entry for the one report");
  assert.equal(project.smsLog[0].sid, "SM1,SM2");
  assert.equal(location.href, "");
});

test("a refused company send opens Messages pre-filled instead", async () => {
  reset();
  notify = () => [500, { ok: false, error: "send_failed: twilio 21610" }];
  const project = {};
  await sms.smartSend(project, { recipients: "907-322-5450", body: "on our way", kind: "onOurWay", by: "Mike" });
  const e = project.smsLog[0];
  assert.equal(e.via, "device");
  assert.match(e.error, /send_failed/);
  assert.match(location.href, /^sms:9073225450\?.*body=on%20our%20way$/);
  assert.equal(toastText(), "Company send failed — opening Messages instead");
});

test("no signal: the send can't reach the server, so Messages opens instead", async () => {
  reset();
  notify = () => new TypeError("Failed to fetch");
  const project = {};
  await sms.smartSend(project, { recipients: "907-322-5450", body: "on our way", kind: "onOurWay", by: "Mike" });
  assert.equal(project.smsLog[0].via, "device");
  assert.match(location.href, /^sms:9073225450/);
});

test("a second tap while the text is still sending sends nothing more", async () => {
  reset();
  let release;
  const held = new Promise((r) => { release = r; });
  notify = async () => { await held; return [200, { ok: true, sid: "SM9", status: "queued" }]; };
  const project = {};
  const args = { recipients: "907-322-5450", body: "on our way", kind: "onOurWay", by: "Mike" };
  const first = sms.smartSend(project, args);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toastText(), "Sending from the company number…", "something shows right away");
  await sms.smartSend(project, args);                     // the impatient second tap
  assert.equal(toastText(), "Still sending that text…");
  assert.equal(project.smsLog.length, 1, "the second tap logged nothing");
  release();
  await first;
  assert.equal(calls.length, 1, "the customer got one text");
  assert.equal(toastText(), "Sent from your company number ✓");
  await sms.smartSend(project, args);                     // once it's done, the button works again
  assert.equal(calls.length, 2);
  assert.equal(project.smsLog.length, 2);
});

test("a different text isn't held up by one still sending", async () => {
  reset();
  let release;
  const held = new Promise((r) => { release = r; });
  notify = async (b) => { if (b.kind === "onOurWay") await held; return [200, { ok: true, sid: "SM", status: "queued" }]; };
  const project = {};
  const first = sms.smartSend(project, { recipients: "907-322-5450", body: "on our way", kind: "onOurWay", by: "Mike" });
  await sms.smartSend(project, { recipients: "907-371-9868", body: "FIELD REPORT", kind: "fieldReport", by: "Mike" });
  assert.equal(calls.length, 2);
  release();
  await first;
});

test("no phone number: nothing is logged or sent", async () => {
  reset();
  const project = {};
  await sms.smartSend(project, { recipients: " ", body: "x", kind: "onOurWay", by: "Mike" });
  assert.equal(calls.length, 0);
  assert.equal(project.smsLog, undefined);
  assert.equal(toastText(), "No phone number to text.");
});

test("board / admin chips (assistSend) send from the company number too", async () => {
  reset();
  const r = await sms.assistSend({ to: "907-322-5450", message: "Hi Jeff", audience: "customer", by: "office" });
  assert.deepEqual(r, { ok: true, detail: "sent from the company number" });
  assert.deepEqual(calls, [{ action: "sendSms", to: "9073225450", body: "Hi Jeff", kind: "assist", captured_by: "office", unified_job_id: null }]);
  assert.equal(location.href, "");
  reset();
  await sms.assistSend({ to: "907-371-9868", message: "Crew note", audience: "crew", by: "board" });
  assert.equal(calls[0].kind, "assistCrew");
});

test("assistSend: a quiet-hours refusal never falls back to Messages; other failures do", async () => {
  reset();
  notify = () => [400, { ok: false, error: "quiet_hours: customer texts send between 7am and 8pm Alaska time" }];
  const quiet = await sms.assistSend({ to: "907-322-5450", message: "Hi", audience: "customer", by: "office" });
  assert.equal(quiet.ok, false);
  assert.match(quiet.detail, /^quiet_hours/);
  assert.equal(location.href, "", "the server's guard is not sidestepped");
  reset();
  notify = () => [500, { ok: false, error: "send_failed: could not reach Twilio" }];
  const failed = await sms.assistSend({ to: "907-322-5450", message: "Hi", audience: "customer", by: "office" });
  assert.deepEqual(failed, { ok: true, detail: "company send failed — opened Messages instead (review and send)" });
  assert.match(location.href, /^sms:9073225450/);
});

test("assistSend still refuses a chip with no number or no message", () => {
  reset();
  assert.deepEqual(sms.assistSend({ to: "", message: "Hi" }), { ok: false, detail: "missing a phone number or message" });
  assert.deepEqual(sms.assistSend({ to: "907-322-5450", message: "  " }), { ok: false, detail: "missing a phone number or message" });
  assert.equal(calls.length, 0);
});
