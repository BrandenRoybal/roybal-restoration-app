/* The morning brief's reminder lane (spine step 5) — the pure rules in
   reminders.ts, then index.ts itself, driven. No Deno, no network.
   Run: node --test --experimental-strip-types supabase/functions/roybal-brief/reminders.test.mjs

   The rules decide which queue each overdue-invoice reminder lands in (the
   spine's proposals, or the old pending_actions row), what the 7-day check
   reads, and when the owner is offered a YES line. The second half drives
   index.ts the way roybal-notify/decide.test.mjs drives its own: a resolve
   hook stands in for the one Deno URL import (serve hands the handler back
   instead of listening), Deno.env is a plain object, and fetch is one
   stubbed world, so nothing leaves the process. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { register } from "node:module";
import {
  remindersLane, laneReady, agentKnown, invoiceKey, remindedKeys, reminderCandidates, reminderLabel, pendingReminderRow,
  spineReminder, filingOutcome, yesLine, codesInUseList, codeTaker, SPINE_ADDRESS,
} from "./reminders.ts";
import { reminderEmail } from "./digest.ts";

const PID = "9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0";      // a field_projects.id (uuid)
const PID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TODAY = "2026-10-06";
const inv = (o = {}) => ({ invoiceNo: "INV-4", status: "sent", dueDate: "2026-10-01", items: [{ qty: "1", price: "1200" }], ...o });
const job = (o = {}) => ({ id: PID, customer: "Jeff Hebard", address: "12 Elm St", email: "hebard@example.com", invoices: [inv()], ...o });

/* ---------- REMINDERS_LANE ---------- */

test("REMINDERS_LANE: unset or spine is the spine; text is the rollback; anything else is text, flagged", () => {
  for (const v of [undefined, null, "", "  ", "spine", " Spine ", "SPINE"]) {
    assert.deepEqual(remindersLane(v), { lane: "spine", unknown: false }, `"${v}"`);
  }
  for (const v of ["text", " TEXT "]) assert.deepEqual(remindersLane(v), { lane: "text", unknown: false }, `"${v}"`);
  for (const v of ["off", "false", "pending", "spine2", "sms"]) {
    assert.deepEqual(remindersLane(v), { lane: "text", unknown: true }, `a typo lands on the old lane: "${v}"`);
  }
});

test("the email lane is ready only on a 200 that answers literally true", () => {
  assert.equal(laneReady(200, true), true);
  assert.equal(laneReady(200, false), false);
  assert.equal(laneReady(200, "true"), false, "a string isn't the boolean");
  assert.equal(laneReady(200, [true]), false);
  assert.equal(laneReady(200, null), false);
  assert.equal(laneReady(404, { code: "PGRST202" }), false, "before 0019 the RPC doesn't exist");
  assert.equal(laneReady(500, true), false);
  assert.equal(laneReady(0, null), false);
});

/* ---------- the 7-day check, both queues ---------- */

test("an invoice already asked about in either queue is held, an ignored (expired) spine ask too; a failed read holds everything", () => {
  const pending = [
    { status: "pending", params: { invoiceKey: "a:1" } },
    { status: "approved", params: { invoiceKey: "a:2" } },
    { status: "executed", params: { invoiceKey: "a:3" } },
    { status: "declined", params: { invoiceKey: "a:4" } },
    { status: "failed", params: { invoiceKey: "a:5" } },
    { status: "pending", params: {} },
    null,
  ];
  const ref = (id) => [{ kind: "invoice", id, label: "Invoice" }];
  const spine = [
    { status: "proposed", evidence_refs: ref("b:1") },
    { status: "approved", evidence_refs: ref("b:2") },
    { status: "executing", evidence_refs: ref("b:3") },
    { status: "executed", evidence_refs: ref("b:4") },
    { status: "declined", evidence_refs: ref("b:5") },
    { status: "failed", evidence_refs: ref("b:6") },
    { status: "expired", evidence_refs: ref("b:7") },
    { status: "proposed", evidence_refs: [{ kind: "job", id: "b:8" }, "b:9", null, { kind: "invoice", id: "" }] },
    { status: "proposed", evidence_refs: { kind: "invoice", id: "b:10" } },
    { status: "proposed" },
  ];
  assert.deepEqual([...remindedKeys(pending, spine)].sort(), ["a:1", "a:2", "a:3", "b:1", "b:2", "b:3", "b:4", "b:7"],
    "expired is the old lane's unanswered row, held for the window");
  assert.deepEqual([...remindedKeys([], [])], [], "both queues empty: nothing held");
  assert.equal(remindedKeys(null, []), null, "the pending_actions read failed");
  assert.equal(remindedKeys([], null), null, "the proposals read failed");
  assert.equal(remindedKeys({ message: "boom" }, []), null, "an error body isn't a list");
});

test("the proposals read is trusted only while the login resolves to the brief's agent, or before 0019", () => {
  const AGENT_ID = "1af33481-7f1c-4485-87f5-7b0ec5e27554";
  assert.equal(agentKnown(200, AGENT_ID), true);
  assert.equal(agentKnown(200, AGENT_ID.toUpperCase()), true);
  assert.equal(agentKnown(404, { code: "PGRST202" }), true, "before 0019: no spine rows can exist");
  assert.equal(agentKnown(200, null), false, "agent:brief disabled or unlinked: RLS would hide its own rows");
  for (const body of ["", "agent:brief", [AGENT_ID], { id: AGENT_ID }, 7]) {
    assert.equal(agentKnown(200, body), false, JSON.stringify(body));
  }
  for (const s of [0, 401, 403, 500, 503]) assert.equal(agentKnown(s, AGENT_ID), false, String(s));
});

/* ---------- picking today's reminders ---------- */

test("candidates: chip-tracked, past due in Alaska terms, customer email on file, not held, oldest first, at most 2", () => {
  const projects = [
    job({ id: "p1", invoices: [
      inv({ invoiceNo: "A", dueDate: "2026-09-01" }),
      inv({ invoiceNo: "B", status: "paid", dueDate: "2026-08-01" }),
      inv({ invoiceNo: "C", status: "draft", dueDate: "2026-08-01" }),
      inv({ invoiceNo: "D", dueDate: TODAY }),
      inv({ invoiceNo: "E", dueDate: "" }),
      inv({ invoiceNo: "F", status: "partially_paid", dueDate: "2026-07-01" }),
    ] }),
    job({ id: "p2", email: "", invoices: [inv({ invoiceNo: "G", dueDate: "2026-01-01" })] }),
    job({ id: "p3", invoices: [inv({ invoiceNo: "H", status: "viewed", dueDate: "2026-08-15" })] }),
    job({ id: "p4", invoices: { not: "a list" } }),
  ];
  const picks = reminderCandidates(projects, TODAY, new Set());
  assert.deepEqual(picks.map((c) => c.key), ["p1:F", "p3:H"]);
  assert.equal(picks[0].days, 97);
  assert.equal(picks[0].balance, 1200);
  assert.deepEqual(reminderCandidates(projects, TODAY, new Set(["p1:F"])).map((c) => c.key), ["p3:H", "p1:A"]);
});

test("the two oldest are picked before the balance check, as the brief always counted them", () => {
  const projects = [job({ invoices: [
    inv({ invoiceNo: "PAID-OFF", dueDate: "2026-06-01", previousPayments: 1200 }),
    inv({ invoiceNo: "OWED", dueDate: "2026-07-01" }),
    inv({ invoiceNo: "THIRD", dueDate: "2026-08-01" }),
  ] })];
  assert.deepEqual(reminderCandidates(projects, TODAY, new Set()).map((c) => c.inv.invoiceNo), ["OWED"]);
});

test("the dedupe key and the label are the formulas the old lane always used", () => {
  assert.equal(invoiceKey({ id: "p" }, { invoiceNo: "INV-4", id: "i9" }), "p:INV-4");
  assert.equal(invoiceKey({ id: "p" }, { id: "i9" }), "p:i9");
  assert.equal(invoiceKey({ id: "p" }, {}), "p:");
  assert.equal(reminderLabel({ customer: "Hebard", address: "12 Elm" }, { invoiceNo: "INV-4" }), "email the INV-4 reminder to Hebard");
  assert.equal(reminderLabel({ address: "12 Elm" }, {}), "email the overdue invoice reminder to 12 Elm");
  assert.equal(reminderLabel({}, {}), "email the overdue invoice reminder to the customer");
});

/* ---------- the two shapes a reminder can be filed as ---------- */

const pickOne = (o = {}) => reminderCandidates([job(o)], TODAY, new Set())[0];

test("the old lane's row is byte-for-byte the row the brief has always inserted", () => {
  const c = pickOne({ email: "  hebard@example.com " });
  const mail = reminderEmail(c.p, c.inv, c.balance);
  assert.equal(JSON.stringify(pendingReminderRow(c, mail, 11)), JSON.stringify({
    code: 11, kind: "emailSend", label: "email the INV-4 reminder to Jeff Hebard", job_id: PID, proposed_by: "morning-brief",
    params: { to: "hebard@example.com", subject: mail.subject, body: mail.body, jobId: PID, invoiceKey: `${PID}:INV-4` },
  }));
});

test("the spine filing: email.send with only what the schema accepts, the label leading the rationale, the key in evidence", () => {
  const c = pickOne();
  const mail = reminderEmail(c.p, c.inv, c.balance);
  const s = spineReminder(c, mail);
  assert.equal(s.ok, true);
  assert.deepEqual(s.body, {
    p_operation: "email.send",
    p_input: { to: "hebard@example.com", subject: "Payment reminder — invoice INV-4 (Jeff Hebard)", body: mail.body },
    p_job_id: PID,
    p_rationale: "email the INV-4 reminder to Jeff Hebard (5 days past due, $1,200 open)",
    p_evidence_refs: [{ kind: "invoice", id: `${PID}:INV-4`, label: "Invoice INV-4 · $1,200 open · due 2026-10-01" }],
    p_proposed_via: "cron",
    p_expires_in: "24 hours",
  });
  assert.match(s.body.p_input.body, /outstanding balance of \$1,200/, "the reminder text is reminderEmail's, unchanged");
  const one = spineReminder(pickOne({ invoices: [inv({ invoiceNo: "", id: "i7", dueDate: "2026-10-05" })] }), mail);
  assert.equal(one.body.p_rationale, "email the overdue invoice reminder to Jeff Hebard (1 day past due, $1,200 open)");
  assert.deepEqual(one.body.p_evidence_refs[0], { kind: "invoice", id: `${PID}:i7`, label: "Invoice (no number) · $1,200 open · due 2026-10-05" });
});

test("an address the spine would refuse, or a job id that isn't a uuid, keeps the reminder on the old lane", () => {
  const mail = { subject: "s", body: "b" };
  for (const email of ["a@b.com, c@d.com", "Jeff <a@b.com>", "a@b", "a b@c.com", "@b.com"]) {
    const s = spineReminder(pickOne({ email }), mail);
    assert.equal(s.ok, false, email);
    assert.match(s.why, /one plain address/);
  }
  assert.equal(SPINE_ADDRESS.test("first.last+tag@sub.example.co"), true);
  for (const id of ["p-123", "", undefined, `${PID}x`]) {
    const s = spineReminder(pickOne({ id }), mail);
    assert.equal(s.ok, false, String(id));
    assert.match(s.why, /uuid/);
  }
  assert.equal(spineReminder(pickOne({ id: PID.toUpperCase() }), mail).ok, true, "a uuid in capitals is still one");
});

/* ---------- what op_propose's answer means ---------- */

test("op_propose: the row back is filed; a 4xx is a definite no; a 5xx or no answer may have landed", () => {
  const row = { id: "sp1", status: "proposed", sms_code: 4 };
  assert.deepEqual(filingOutcome(200, row), { kind: "filed", row });
  assert.deepEqual(filingOutcome(200, [row]), { kind: "filed", row }, "a one-element array is tolerated");
  assert.equal(filingOutcome(200, []).kind, "unsure");
  assert.equal(filingOutcome(200, [row, row]).kind, "unsure");
  assert.equal(filingOutcome(200, {}).kind, "unsure", "a 2xx without the row may still have filed it");
  assert.equal(filingOutcome(200, null).kind, "unsure");
  const no = filingOutcome(400, { code: "22023", message: "op spine: email.send@1 input is invalid" });
  assert.equal(no.kind, "refused");
  assert.match(no.why, /400: 22023 op spine: email\.send@1 input/);
  for (const s of [400, 401, 404, 409]) assert.equal(filingOutcome(s, { code: "x" }).kind, "refused", String(s));
  // not allowed: the spine identity is broken, which no other lane fixes
  const blocked = filingOutcome(403, { code: "42501", message: "op spine: agent 1af… may not propose email.send@1" });
  assert.equal(blocked.kind, "blocked");
  assert.match(blocked.why, /403: 42501 op spine: agent/);
  assert.equal(filingOutcome(403, null).kind, "blocked", "a 403 whatever the body");
  assert.equal(filingOutcome(401, { code: "42501", message: "permission denied" }).kind, "blocked", "42501 whatever the status");
  assert.equal(filingOutcome(400, [{ code: "42501" }]).kind, "blocked");
  for (const s of [500, 502, 503, 504]) assert.equal(filingOutcome(s, { code: "P0002" }).kind, "unsure", String(s));
  assert.equal(filingOutcome(301, null).kind, "unsure");
  const lost = filingOutcome(0, null);
  assert.equal(lost.kind, "unsure");
  assert.match(lost.why, /got no answer/);
});

test("the YES line uses the returned row's code, only while it is proposed and unexpired", () => {
  const now = Date.parse("2026-10-06T16:00:00Z");
  const live = { status: "proposed", sms_code: 4, expires_at: "2026-10-07T16:00:00Z" };
  const label = "email the INV-4 reminder to Hebard";
  assert.deepEqual(yesLine(live, label, now), { code: 4, label });
  assert.deepEqual(yesLine({ ...live, sms_code: "12" }, label, now), { code: 12, label });
  for (const status of ["approved", "executing", "executed", "declined", "expired", "failed", "superseded"]) {
    assert.equal(yesLine({ ...live, status }, label, now), null, `a repeated key handed back a ${status} row`);
  }
  assert.equal(yesLine({ ...live, expires_at: "2026-10-06T15:59:59Z" }, label, now), null, "stale but unswept");
  assert.equal(yesLine({ ...live, expires_at: null }, label, now), null);
  assert.equal(yesLine({ ...live, sms_code: null }, label, now), null);
  assert.equal(yesLine({ ...live, sms_code: 0 }, label, now), null);
  assert.equal(yesLine(null, label, now), null);
});

/* ---------- old-lane codes ---------- */

test("old-lane codes: sms_codes_in_use when it answers a list, lowest free from 11, and codes held mid-run", () => {
  assert.deepEqual(codesInUseList(200, [4, "12", 11]), [4, 12, 11]);
  assert.deepEqual(codesInUseList(200, []), []);
  assert.equal(codesInUseList(404, { code: "PGRST202" }), null, "before 0019");
  assert.equal(codesInUseList(500, [1]), null);
  assert.equal(codesInUseList(200, { codes: [1] }), null);
  const a = codeTaker([]);
  assert.deepEqual([a.take(), a.take()], [11, 12]);
  const b = codeTaker([11, "12", 14, null, "x"]);
  assert.deepEqual([b.take(), b.take()], [13, 15]);
  const c = codeTaker([12]);
  c.hold(11);
  c.hold(undefined);
  assert.deepEqual([c.take(), c.take()], [13, 14], "a spine code filed this run is skipped");
});

/* ---------- index.ts reads the switch ---------- */

const here = dirname(fileURLToPath(import.meta.url));
const briefSrc = readFileSync(join(here, "index.ts"), "utf8");

test("index.ts honours REMINDERS_LANE on every run, and keeps the proposals block from stopping the brief", () => {
  const handler = briefSrc.slice(briefSrc.indexOf("serve(async"));
  assert.match(handler, /remindersLane\(raw\)/);
  assert.match(handler, /const raw = Deno\.env\.get\("REMINDERS_LANE"\)/, "read per request, so flipping the secret takes effect at the next run");
  assert.doesNotMatch(briefSrc.slice(0, briefSrc.indexOf("serve(async")), /REMINDERS_LANE"\)/, "not frozen at module load");
  assert.match(handler, /console\.error\("proposals skipped:"/, "a reminder failure never stops the text");
  assert.equal(briefSrc.match(/post\(jwt, "rpc\/op_propose"/g)?.length, 1, "one spine filing site");
});

/* ---------- index.ts, driven ---------- */

const SERVE = "data:text/javascript," + encodeURIComponent("export const serve = (h) => { globalThis.__roybalBrief = h; };");
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "https://deno.land/std@0.168.0/http/server.ts") return { url: ${JSON.stringify(SERVE)}, shortCircuit: true };
  return next(spec, ctx);
}`));

const SB = "https://stub.supabase.test";
const ENV = {
  SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon-key", CRON_SECRET: "cron", OWNER_CELL: "+19075551234",
  BRIEF_MACHINE_PASSWORD: "pw",
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };
await import("./index.ts");
const brief = globalThis.__roybalBrief;

const NOW = Date.parse("2026-10-06T16:00:00Z");      // 8am AKDT, Alaska date 2026-10-06
const AGENT = "1af33481-7f1c-4485-87f5-7b0ec5e27554"; // agent:brief
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const pg = (code, message, status) => J({ code, message, details: null, hint: null }, status);

/** PostgREST's filters, as far as the brief's reads use them. */
const KEYWORDS = new Set(["select", "order", "limit", "offset"]);
const instant = (v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v);
const holds = (v, f) => {
  const [op, ...rest] = f.split(".");
  const want = rest.join(".");
  if (op === "eq") return String(v) === want;
  if (op === "neq") return String(v) !== want;
  if (v == null) return false;
  if (op === "gt") return instant(v) > instant(want);
  if (op === "gte") return instant(v) >= instant(want);
  throw new Error(`the stub can't filter ${f}`);
};
const pick = (list, path) => {
  const q = new URLSearchParams(path.split("?")[1] || "");
  const out = list.filter((r) => [...q].every(([col, f]) => KEYWORDS.has(col) || holds(r[col], f)));
  return q.get("limit") ? out.slice(0, Number(q.get("limit"))) : out;
};

/** The brief's whole world: the shop it reads, both queues, the RPCs it
    calls and roybal-notify. `w.lane` is outbox_channel_ready's answer,
    `w.agent` current_agent_id's,
    `w.seq` the next proposals_sms_code_seq value, `w.propose` op_propose
    (a repeated key hands back the existing row whatever its status, and a
    new code skips live proposal codes and, as 0019's trigger does, pending
    ones). `over(method, path, init, w)` answers first (a Response, or an
    Error to throw); undefined falls through to the world. */
function world({ projects = [job()], pending = [], spine = [], over = () => undefined } = {}) {
  const w = { pending, spine, lane: true, agent: AGENT, seq: 4, calls: [], texts: [], logs: [] };
  const createdAt = new Date(NOW - 3600000).toISOString();
  w.propose = (b) => {
    const key = ["email.send", b.p_input.to.toLowerCase(), b.p_input.subject, b.p_input.body, b.p_job_id ?? "", TODAY].join(":");
    const had = w.spine.find((r) => r.idempotency_key === key);
    if (had) return J({ ...had });
    const held = new Set([
      ...w.spine.filter((r) => r.status === "proposed").map((r) => r.sms_code),
      ...w.pending.filter((r) => r.status === "pending").map((r) => r.code),
    ]);
    while (held.has(w.seq)) w.seq++;
    const row = {
      id: `sp-${w.spine.length + 1}`, operation: "email.send@1", input: b.p_input, job_id: b.p_job_id,
      rationale: b.p_rationale, evidence_refs: b.p_evidence_refs, proposed_via: b.p_proposed_via,
      proposed_by_kind: "agent", proposed_by_id: AGENT, status: "proposed", sms_code: w.seq++,
      expires_at: new Date(NOW + 86400000).toISOString(), created_at: new Date(NOW).toISOString(), idempotency_key: key,
    };
    w.spine.push(row);
    return J({ ...row });
  };
  w.pending.forEach((r) => { r.created_at ??= createdAt; r.expires_at ??= new Date(NOW + 3600000).toISOString(); });
  w.spine.forEach((r) => { r.operation ??= "email.send@1"; r.created_at ??= createdAt; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input), method = init.method || "GET";
    const path = url.startsWith(SB) ? url.slice(SB.length) : url;
    w.calls.push({ method, path, auth: (init.headers || {}).Authorization, body: init.body });
    const o = await over(method, path, init, w);
    if (o instanceof Error) throw o;
    if (o) return o;
    if (path === "/auth/v1/token?grant_type=password") return J({ access_token: "brief-jwt" });
    if (path.startsWith("/rest/v1/field_projects?")) {
      return J(projects.map((data) => ({ id: data.id, data, updated_at: new Date(NOW).toISOString() })));
    }
    if (path.startsWith("/rest/v1/coordination_jobs?")) return J([]);
    if (path.startsWith("/rest/v1/portal_messages?")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" } });
    }
    if (path.startsWith("/rest/v1/email_messages?")) return J([]);
    if (path.startsWith("/rest/v1/pending_actions?") && method === "GET") return J(pick(w.pending, path));
    if (path === "/rest/v1/pending_actions" && method === "POST") {
      for (const r of JSON.parse(init.body)) w.pending.push({ ...r, status: "pending", created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 86400000).toISOString() });
      return new Response(null, { status: 201 });
    }
    // RLS (0019 proposals_read_own_agent): the brief reads only its own
    if (path.startsWith("/rest/v1/proposals?") && method === "GET") {
      return J(pick(w.spine.filter((r) => r.proposed_by_id === AGENT), path).map(({ status, evidence_refs }) => ({ status, evidence_refs })));
    }
    if (path === "/rest/v1/rpc/outbox_channel_ready") return J(w.lane);
    if (path === "/rest/v1/rpc/current_agent_id") return J(w.agent);
    if (path === "/rest/v1/rpc/sms_codes_in_use") {
      const codes = [...w.pending.filter((r) => r.status === "pending").map((r) => r.code),
        ...w.spine.filter((r) => r.status === "proposed" && r.sms_code != null).map((r) => r.sms_code)];
      return J([...new Set(codes)].sort((a, b) => a - b));
    }
    if (path === "/rest/v1/rpc/op_propose") return w.propose(JSON.parse(init.body));
    if (path === "/functions/v1/roybal-notify") {
      w.texts.push(JSON.parse(init.body));
      return J({ ok: true });
    }
    if (path === "/rest/v1/capture_events" && method === "POST") return new Response(null, { status: 201 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return w;
}

/** One morning: the cron's POST, with the handler's log lines caught. */
async function morning(t, w, lane) {
  if (lane === undefined) delete ENV.REMINDERS_LANE; else ENV.REMINDERS_LANE = lane;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const keep = [console.log, console.error];
  console.log = console.error = (...a) => { w.logs.push(a.join(" ")); };
  try {
    const r = await brief(new Request("https://brief.test/functions/v1/roybal-brief", {
      method: "POST", headers: { "x-cron-secret": "cron", "Content-Type": "application/json" }, body: "{}",
    }));
    const body = await r.json();
    assert.equal(body.ok, true, `the brief still goes out: ${JSON.stringify(body)} ${w.logs.join(" | ")}`);
  } finally {
    [console.log, console.error] = keep;
    t.mock.timers.reset();
  }
  assert.equal(w.texts.length, 1, "exactly one brief text");
  return w.texts[0].body;
}
const called = (w, path) => w.calls.filter((c) => c.path === path);
const inserted = (w) => called(w, "/rest/v1/pending_actions").map((c) => JSON.parse(c.body)).flat();
const KEY = `${PID}:INV-4`;
const OLD_ROW = (code) => JSON.stringify([{
  code, kind: "emailSend", label: "email the INV-4 reminder to Jeff Hebard", job_id: PID, proposed_by: "morning-brief",
  params: {
    to: "hebard@example.com", subject: "Payment reminder — invoice INV-4 (Jeff Hebard)",
    body: reminderEmail({ customer: "Jeff Hebard" }, inv(), 1200).body, jobId: PID, invoiceKey: KEY,
  },
}]);

test("the default lane, email live: one email.send proposal, its own YES number in the brief, no old row", async (t) => {
  const w = world();
  const text = await morning(t, w, undefined);
  const filed = called(w, "/rest/v1/rpc/op_propose");
  assert.equal(filed.length, 1);
  assert.equal(filed[0].auth, "Bearer brief-jwt", "filed as the machine login (agent:brief), never a service key");
  const body = JSON.parse(filed[0].body);
  assert.equal(body.p_operation, "email.send");
  assert.equal(body.p_rationale, "email the INV-4 reminder to Jeff Hebard (5 days past due, $1,200 open)");
  assert.deepEqual(body.p_evidence_refs, [{ kind: "invoice", id: KEY, label: "Invoice INV-4 · $1,200 open · due 2026-10-01" }]);
  assert.deepEqual(inserted(w), [], "nothing on the old lane");
  assert.match(text, /💬 Reply YES 4 — email the INV-4 reminder to Jeff Hebard$/m, "the YES line format is unchanged");
  assert.equal(called(w, "/rest/v1/rpc/outbox_channel_ready")[0].body, JSON.stringify({ p_channel: "email" }));
  // the next morning (same Alaska day, a rerun) the 7-day check sees the spine row
  const again = world({ spine: w.spine });
  const text2 = await morning(t, again, undefined);
  assert.deepEqual(called(again, "/rest/v1/rpc/op_propose"), []);
  assert.deepEqual(inserted(again), []);
  assert.doesNotMatch(text2, /Reply YES/);
});

test("REMINDERS_LANE=text: the old row exactly as before — and the 7-day check still reads both queues", async (t) => {
  const w = world({ pending: [{ code: 11, kind: "boardEdit", status: "pending", proposed_by: "qb-time", label: "add phase" }] });
  const text = await morning(t, w, "text");
  assert.deepEqual(called(w, "/rest/v1/rpc/outbox_channel_ready"), [], "the switch skips the spine entirely");
  assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), []);
  const post = called(w, "/rest/v1/pending_actions");
  assert.equal(post.length, 1);
  assert.equal(post[0].body, OLD_ROW(12), "byte-for-byte the old insert, clear of qb-time's 11");
  assert.match(text, /💬 Reply YES 12 — email the INV-4 reminder to Jeff Hebard/);
  assert.ok(w.calls.some((c) => c.path.startsWith("/rest/v1/proposals?operation=eq.email.send@1&created_at=gte.")), "the spine queue is read");

  // a reminder already waiting on the spine is not asked again by the old lane
  const v = world({ spine: [{ status: "proposed", proposed_by_id: AGENT, evidence_refs: [{ kind: "invoice", id: KEY }] }] });
  await morning(t, v, "text");
  assert.deepEqual(inserted(v), [], "one invoice, one queue");
});

test("an unknown REMINDERS_LANE value takes the old lane and says so in the log", async (t) => {
  const w = world();
  await morning(t, w, "Spine-ish");
  assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), []);
  assert.equal(called(w, "/rest/v1/pending_actions")[0].body, OLD_ROW(11));
  assert.ok(w.logs.some((l) => /REMINDERS_LANE="Spine-ish" isn't spine or text/.test(l)));
});

test("the email lane not live (false, or no RPC before 0019, or an error): the old row exactly as today", async (t) => {
  const answers = [
    (wo) => { wo.lane = false; },
    (wo) => { wo.lane = "true"; },
    () => pg("PGRST202", "Could not find the function public.outbox_channel_ready", 404),
    () => new Error("network down"),
  ];
  for (const answer of answers) {
    const w = world({ over: (m, p, _i, wo) => (p === "/rest/v1/rpc/outbox_channel_ready" ? answer(wo) : undefined) });
    const text = await morning(t, w, "spine");
    assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), []);
    assert.equal(called(w, "/rest/v1/pending_actions")[0].body, OLD_ROW(11));
    assert.match(text, /💬 Reply YES 11 — email the INV-4 reminder to Jeff Hebard/);
  }
});

test("op_propose refusing with a 4xx files the old row instead", async (t) => {
  for (const no of [
    () => pg("22023", "op spine: email.send@1 input is invalid: to does not match", 400),
    () => pg("PGRST116", "JSON object requested, multiple (or no) rows returned", 406),
    () => pg("PGRST202", "Could not find the function public.op_propose", 404),
  ]) {
    const w = world({ over: (m, p) => (p === "/rest/v1/rpc/op_propose" ? no() : undefined) });
    const text = await morning(t, w, undefined);
    assert.equal(called(w, "/rest/v1/pending_actions")[0].body, OLD_ROW(11));
    assert.match(text, /💬 Reply YES 11 — email the INV-4 reminder to Jeff Hebard/);
    assert.ok(w.logs.some((l) => /takes the old lane: op_propose answered 4\d\d/.test(l)));
  }
});

test("op_propose answering not allowed (42501): no more reminders that day, on either lane", async (t) => {
  const projects = [job(), job({ id: PID2, customer: "Swift", email: "swift@example.com",
    invoices: [inv({ invoiceNo: "INV-9", dueDate: "2026-10-03" })] })];
  for (const no of [
    () => pg("42501", "op spine: agent login 1af33481-7f1c-4485-87f5-7b0ec5e27554 is not linked to an enabled agents row", 403),
    () => pg("42501", "op spine: agent 1af33481-7f1c-4485-87f5-7b0ec5e27554 may not propose email.send@1", 403),
    () => new Response("forbidden", { status: 403 }),
  ]) {
    const w = world({ projects, over: (m, p) => (p === "/rest/v1/rpc/op_propose" ? no() : undefined) });
    const text = await morning(t, w, undefined);
    assert.equal(called(w, "/rest/v1/rpc/op_propose").length, 1, "the second reminder isn't tried either");
    assert.deepEqual(inserted(w), [], "no old-lane fallback for a broken identity");
    assert.doesNotMatch(text, /Reply YES/);
    assert.ok(w.logs.some((l) => /reminders stop for today at .*:INV-4: op_propose answered 403/.test(l)), w.logs.join(" | "));
  }

  // a reminder filed before the refusal keeps its line
  const u = world({ projects, over: (m, p, init) =>
    (p === "/rest/v1/rpc/op_propose" && JSON.parse(init.body).p_job_id === PID2 ? pg("42501", "not allowed", 403) : undefined) });
  const text = await morning(t, u, undefined);
  assert.equal(called(u, "/rest/v1/rpc/op_propose").length, 2);
  assert.deepEqual(inserted(u), []);
  assert.match(text, /💬 Reply YES 4 — email the INV-4 reminder to Jeff Hebard$/);
});

test("the login no longer resolving to agent:brief: no reminder at all that day, in every lane state", async (t) => {
  // the brief asked about this invoice on the spine yesterday; disabled or
  // unlinked, its proposals read answers [] instead of failing
  const spine = [{ status: "proposed", proposed_by_id: "someone-else", evidence_refs: [{ kind: "invoice", id: KEY }] }];
  const answers = [
    (wo) => { wo.agent = null; },
    () => pg("XX000", "boom", 500),
    () => new Error("connection reset"),
  ];
  for (const answer of answers) {
    for (const lane of [undefined, "text"]) {
      const w = world({ spine: [...spine], over: (m, p, _i, wo) => (p === "/rest/v1/rpc/current_agent_id" ? answer(wo) : undefined) });
      const text = await morning(t, w, lane);
      assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), [], String(lane));
      assert.deepEqual(inserted(w), [], String(lane));
      assert.doesNotMatch(text, /Reply YES/);
      assert.ok(w.logs.some((l) => /proposals skipped: the brief's login doesn't resolve to agent:brief/.test(l)), w.logs.join(" | "));
    }
  }

  // before 0019 there is no current_agent_id and no spine rows: carry on
  const v = world({ over: (m, p) => {
    if (p === "/rest/v1/rpc/current_agent_id") return pg("PGRST202", "Could not find the function public.current_agent_id", 404);
    if (p === "/rest/v1/rpc/outbox_channel_ready") return pg("PGRST202", "Could not find the function public.outbox_channel_ready", 404);
    return undefined;
  } });
  const text = await morning(t, v, undefined);
  assert.equal(called(v, "/rest/v1/rpc/current_agent_id")[0].auth, "Bearer brief-jwt");
  assert.equal(called(v, "/rest/v1/pending_actions")[0].body, OLD_ROW(11));
  assert.match(text, /💬 Reply YES 11 — email the INV-4 reminder to Jeff Hebard/);
});

test("op_propose failing with a 5xx or on the network: that reminder waits for tomorrow, in neither queue", async (t) => {
  for (const fail of [
    () => pg("XX000", "server closed the connection", 500),
    () => new Response("upstream timeout", { status: 504 }),
    () => new Error("connection reset"),
  ]) {
    const w = world({ over: (m, p) => (p === "/rest/v1/rpc/op_propose" ? fail() : undefined) });
    const text = await morning(t, w, undefined);
    assert.equal(called(w, "/rest/v1/rpc/op_propose").length, 1, "never retried");
    assert.deepEqual(inserted(w), [], "the old lane could make it two asks");
    assert.doesNotMatch(text, /Reply YES/);
    assert.ok(w.logs.some((l) => /waits for tomorrow/.test(l)));
  }
});

test("an address the spine would refuse, or a job id that isn't a uuid, goes on the old lane without asking the spine", async (t) => {
  const w = world({ projects: [job({ email: "hebard@example.com, office@example.com" })] });
  await morning(t, w, undefined);
  assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), []);
  assert.equal(inserted(w).length, 1);
  assert.equal(inserted(w)[0].params.to, "hebard@example.com, office@example.com", "the old lane is unchanged, list and all");

  const v = world({ projects: [job({ id: "legacy-17" })] });
  await morning(t, v, undefined);
  assert.deepEqual(called(v, "/rest/v1/rpc/op_propose"), []);
  assert.equal(inserted(v)[0].params.invoiceKey, "legacy-17:INV-4");
});

test("either 7-day read failing: no reminder at all that day, and the brief still goes out", async (t) => {
  for (const which of ["/rest/v1/pending_actions?kind=eq.emailSend", "/rest/v1/proposals?"]) {
    for (const lane of [undefined, "text"]) {
      const w = world({ over: (m, p) => (p.startsWith(which) ? pg("XX000", "boom", 500) : undefined) });
      const text = await morning(t, w, lane);
      assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), [], `${which} ${lane}`);
      assert.deepEqual(inserted(w), [], `${which} ${lane}`);
      assert.doesNotMatch(text, /Reply YES/);
      assert.ok(w.logs.some((l) => /proposals skipped: the 7-day check couldn't read both queues/.test(l)));
    }
  }
});

test("held in either queue this week: not asked again; declined or failed: asked again", async (t) => {
  const w = world({ pending: [{ code: 30, kind: "emailSend", status: "pending", params: { invoiceKey: KEY } }] });
  await morning(t, w, undefined);
  assert.deepEqual(called(w, "/rest/v1/rpc/op_propose"), [], "waiting on the old lane");
  assert.deepEqual(inserted(w), []);

  const v = world({ spine: [{ status: "executed", proposed_by_id: AGENT, evidence_refs: [{ kind: "invoice", id: KEY }] }] });
  await morning(t, v, undefined);
  assert.deepEqual(called(v, "/rest/v1/rpc/op_propose"), [], "sent from the spine this week");

  // ignored yesterday, swept to expired by today's first op_propose: held
  // for the week, as the old lane's unanswered row is
  const x = world({ spine: [{ status: "expired", proposed_by_id: AGENT, evidence_refs: [{ kind: "invoice", id: KEY }],
    created_at: new Date(NOW - 2 * 86400000).toISOString() }] });
  const textX = await morning(t, x, undefined);
  assert.deepEqual(called(x, "/rest/v1/rpc/op_propose"), [], "an ignored spine ask isn't asked again after two days");
  assert.deepEqual(inserted(x), []);
  assert.doesNotMatch(textX, /Reply YES/);

  const u = world({
    pending: [{ code: 30, kind: "emailSend", status: "declined", params: { invoiceKey: KEY } }],
    spine: [{ status: "failed", proposed_by_id: AGENT, evidence_refs: [{ kind: "invoice", id: KEY }] }],
  });
  await morning(t, u, undefined);
  assert.equal(called(u, "/rest/v1/rpc/op_propose").length, 1);
});

test("op_propose handing back a decided row for a repeated key: no YES line, and no old row either", async (t) => {
  const c = reminderCandidates([job()], TODAY, new Set())[0];
  const mail = reminderEmail(c.p, c.inv, c.balance);
  const key = ["email.send", "hebard@example.com", mail.subject, mail.body, PID, TODAY].join(":");
  const w = world({ spine: [{
    id: "sp-old", status: "declined", sms_code: 4, idempotency_key: key, proposed_by_id: AGENT,
    expires_at: new Date(NOW + 3600000).toISOString(), evidence_refs: [{ kind: "invoice", id: KEY }],
  }] });
  const text = await morning(t, w, undefined);
  assert.equal(called(w, "/rest/v1/rpc/op_propose").length, 1);
  assert.deepEqual(inserted(w), [], "the owner said no today; the old lane must not ask again");
  assert.doesNotMatch(text, /Reply YES 4/, "a decided row's code may belong to another ask now");
});

test("old-lane codes skip both queues' live codes, and a spine code this run filed", async (t) => {
  // sms_codes_in_use: pending 11, a live spine proposal (someone else's) at 12
  const pending = [{ code: 11, kind: "boardEdit", status: "pending", proposed_by: "qb-time" }];
  const others = [{ status: "proposed", sms_code: 12, proposed_by_id: "someone-else", evidence_refs: [] }];
  const w = world({ pending, spine: others });
  await morning(t, w, "text");
  assert.equal(inserted(w)[0].code, 13);
  assert.equal(called(w, "/rest/v1/rpc/sms_codes_in_use")[0].auth, "Bearer brief-jwt");

  // before 0019 (no RPC): the pending codes, as today
  const v = world({
    pending: [{ code: 11, kind: "boardEdit", status: "pending", proposed_by: "qb-time" }],
    over: (m, p) => (p === "/rest/v1/rpc/sms_codes_in_use" ? pg("PGRST202", "Could not find the function", 404) : undefined),
  });
  await morning(t, v, "text");
  assert.equal(inserted(v)[0].code, 12);
  assert.ok(v.calls.some((c) => c.path === "/rest/v1/pending_actions?status=eq.pending&select=code&limit=200"));

  // one reminder on the spine (code 11 from the sequence), the next on the old lane: it must not take 11
  const projects = [job(), job({ id: PID2, customer: "Swift", email: "swift@example.com, ap@example.com",
    invoices: [inv({ invoiceNo: "INV-9", dueDate: "2026-10-03" })] })];
  const u = world({ projects });
  u.seq = 11;
  const text = await morning(t, u, undefined);
  assert.equal(u.spine[0].sms_code, 11);
  assert.equal(inserted(u)[0].code, 12);
  assert.match(text, /💬 Reply YES 11 — email the INV-4 reminder to Jeff Hebard\n💬 Reply YES 12 — email the INV-9 reminder to Swift/);
});
