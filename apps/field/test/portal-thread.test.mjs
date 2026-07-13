/* Portal message thread — office side. The office reads/writes portal_messages
   over the authenticated REST session (supa.js -> fetch); the customer reaches
   the same thread via the gateway. These checks stub global fetch and pin the
   exact REST calls the office helpers make, so an inbound customer message and
   an office reply always land on the same job's thread
   (portal_job_id === portalShare.id). Run:
   node apps/field/test/portal-thread.test.mjs */
import assert from "node:assert";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

/* record every REST call and return a canned body */
const calls = [];
let nextBody = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
  return {
    ok: true, status: 200,
    json: async () => nextBody,
    text: async () => "",
    headers: { get: () => null },
  };
};

const portal = await import("../js/portal.js");

console.log("Portal thread — office REST shape");

/* ---------- fetchPortalThread ---------- */
nextBody = [{ id: "m1", direction: "in", author: "customer", body: "Hi", read_by_office: false, created_at: "2026-07-12T10:00:00Z" }];
const msgs = await portal.fetchPortalThread("ps-1");
ok("fetchPortalThread returns rows", Array.isArray(msgs) && msgs.length === 1 && msgs[0].body === "Hi");
const g = calls.find((c) => c.method === "GET" && c.url.includes("portal_messages"));
ok("fetch queries portal_messages by portal_job_id", g && g.url.includes("portal_job_id=eq.ps-1"));
ok("fetch orders oldest-first", g && g.url.includes("order=created_at.asc"));
ok("empty job id short-circuits (no call)", (await portal.fetchPortalThread("")).length === 0);

/* ---------- sendOfficeReply ---------- */
calls.length = 0;
nextBody = [{ id: "m2", direction: "out", author: "office", body: "On our way", created_at: "2026-07-12T11:00:00Z" }];
const saved = await portal.sendOfficeReply("ps-1", "  On our way  ");
const p = calls.find((c) => c.method === "POST");
ok("office reply POSTs to portal_messages", p && p.url.includes("/rest/v1/portal_messages"));
ok("reply is outbound from office on this job",
  p && p.body[0].portal_job_id === "ps-1" && p.body[0].direction === "out" && p.body[0].author === "office");
ok("reply body trimmed", p && p.body[0].body === "On our way");
ok("reply marked read-by-office, unread-by-customer",
  p && p.body[0].read_by_office === true && p.body[0].read_by_customer === false);
ok("saved row returned", saved && saved.id === "m2");

/* an approved AI draft can be attributed to the ai author */
calls.length = 0;
await portal.sendOfficeReply("ps-1", "AI text", "ai");
ok("author override supported (ai draft)", calls.find((c) => c.method === "POST").body[0].author === "ai");

/* ---------- markThreadReadByOffice ---------- */
calls.length = 0;
await portal.markThreadReadByOffice("ps-1");
const patch = calls.find((c) => c.method === "PATCH");
ok("markRead PATCHes inbound-unread on this job",
  patch && patch.url.includes("portal_job_id=eq.ps-1") && patch.url.includes("direction=eq.in") && patch.url.includes("read_by_office=eq.false"));
ok("markRead sets read_by_office true", patch && patch.body.read_by_office === true);

/* ---------- guards ---------- */
await assert.rejects(portal.sendOfficeReply("", "hi"), /Nothing to send/);
await assert.rejects(portal.sendOfficeReply("ps-1", "   "), /Nothing to send/);
ok("empty job or body rejected", true);

console.log(`\n${pass} portal-thread checks passed.`);
