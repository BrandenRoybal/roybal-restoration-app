/* decide() — the order one answer runs in, whichever channel it came from
   (approve.ts), with the I/O stubbed. No Deno, no network.
   Run: node --experimental-strip-types --test supabase/functions/roybal-notify/decide.test.mjs

   handleApproval (a YES/NO text) and decidePending (the Approvals tab) both
   hand decide() the same wiring (decideIO in index.ts). The order is what
   keeps a 9pm customer text pending instead of burning it, and what stops a
   tap and a text from both firing one row, so these tests pin it. A few read
   index.ts as text, the technique of qb-time-proxy/authgate.test.mjs. The
   last section drives index.ts itself: a resolve hook stands in for its one
   Deno URL import (serve hands the handler back instead of listening),
   Deno.env is a plain object, and fetch is one stubbed world, so nothing
   leaves the process. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { createHmac } from "node:crypto";
import { decide, TryAgain } from "./approve.ts";

/** One stubbed pending_actions row. Each PATCH honours its status guard the
    way the filter does: check-and-set with no await in between, so it is as
    atomic here as the UPDATE is in Postgres. */
function row({ held = false, expiresFirst, state = "pending", executes = async () => {}, fail = null, revert = null } = {}) {
  const w = { state, calls: [] };
  const move = (from, to) => { if (w.state !== from) return false; w.state = to; return true; };
  w.io = {
    held, expiresFirst,
    flip: async (to) => {
      await null;                         // the PATCH is a round trip
      w.calls.push("flip:" + to);
      return move("pending", to);
    },
    execute: async () => {
      w.calls.push("execute");
      const done = await executes(w);
      w.state = "executed";
      return done;
    },
    revert: revert ?? (async () => { w.calls.push("revert"); return move("approved", "pending"); }),
    fail: fail ?? (async (error) => { w.calls.push("fail:" + error); return move("approved", "failed"); }),
    reread: async () => { w.calls.push("reread"); return { status: w.state }; },
  };
  return w;
}

test("approve flips pending → approved first, then runs the executor", async () => {
  const w = row();
  assert.deepEqual(await decide("approve", w.io), { status: "executed" });
  assert.deepEqual(w.calls, ["flip:approved", "execute"]);
  assert.equal(w.state, "executed");
});

test("decline flips pending → declined and runs nothing", async () => {
  const w = row();
  assert.deepEqual(await decide("decline", w.io), { status: "declined" });
  assert.deepEqual(w.calls, ["flip:declined"]);
  assert.equal(w.state, "declined");
});

test("a held customer text is never flipped: it stays pending for the morning", async () => {
  const w = row({ held: true });
  assert.deepEqual(await decide("approve", w.io), { status: "quiet_hours" });
  assert.deepEqual(w.calls, [], "no PATCH at all, so the row is still live");
  assert.equal(w.state, "pending");
});

test("a held row that expires before the window opens says so, and still is never flipped", async () => {
  const w = row({ held: true, expiresFirst: true });
  assert.deepEqual(await decide("approve", w.io), { status: "quiet_hours", expiresFirst: true });
  assert.deepEqual(w.calls, []);
  assert.equal(w.state, "pending");
  // only a held row carries it
  assert.deepEqual(await decide("approve", row({ expiresFirst: true }).io), { status: "executed" });
});

test("a held row can still be declined at 9pm", async () => {
  const w = row({ held: true });
  assert.deepEqual(await decide("decline", w.io), { status: "declined" });
});

test("an answer that lost the race is not_open and executes nothing", async () => {
  for (const state of ["approved", "executed", "failed", "declined", "expired"]) {
    const yes = row({ state });
    assert.deepEqual(await decide("approve", yes.io), { status: "not_open" }, `approve on ${state}`);
    assert.deepEqual(yes.calls, ["flip:approved"]);
    const no = row({ state });
    assert.deepEqual(await decide("decline", no.io), { status: "not_open" }, `decline on ${state}`);
    assert.equal(no.state, state, "a late NO never un-does what already happened");
  }
});

test("a tap and a text racing for one row execute it exactly once", async () => {
  const w = row();
  const outs = await Promise.all([decide("approve", w.io), decide("approve", w.io)]);
  assert.deepEqual(outs.map((o) => o.status).sort(), ["executed", "not_open"]);
  assert.equal(w.calls.filter((c) => c === "execute").length, 1);

  // an Approve racing a Decline: whichever flip lands first is the answer
  const v = row();
  const [a, d] = await Promise.all([decide("approve", v.io), decide("decline", v.io)]);
  assert.deepEqual([a.status, d.status], ["executed", "not_open"]);
  assert.equal(v.state, "executed");
});

test("an executor throw stamps the row failed with its sentence", async () => {
  const w = row({ executes: async () => { throw new Error("that job is no longer on the board"); } });
  assert.deepEqual(await decide("approve", w.io), { status: "failed", error: "that job is no longer on the board" });
  assert.deepEqual(w.calls, ["flip:approved", "execute", "fail:that job is no longer on the board"]);
  assert.equal(w.state, "failed", "never left sitting at approved");
});

test("the error is clipped to 300, the length result.error has always stored", async () => {
  const long = "x".repeat(500);
  const w = row({ executes: async () => { throw new Error(long); } });
  const out = await decide("approve", w.io);
  assert.equal(out.error.length, 300);
  assert.equal(w.calls[2], "fail:" + long.slice(0, 300));
});

test("a failed stamp that fails too still reports the failure, never throws", async () => {
  const boom = async () => { throw new Error("twilio 400"); };
  const rejects = row({ executes: boom, fail: async () => { throw new Error("db down"); } });
  assert.deepEqual(await decide("approve", rejects.io), { status: "failed", error: "twilio 400" });
  const throwsSync = row({ executes: boom, fail: () => { throw new Error("db down"); } });
  assert.deepEqual(await decide("approve", throwsSync.io), { status: "failed", error: "twilio 400" });
});

test("a thrown non-Error still becomes a sentence", async () => {
  const w = row({ executes: async () => { throw "gmail-proxy hung up"; } });
  assert.deepEqual(await decide("approve", w.io), { status: "failed", error: "gmail-proxy hung up" });
});

test("a flip that never answered, or errored, is the caller's to report, and nothing executes", async () => {
  for (const why of [new TypeError("fetch failed"), new Error("pending_actions update failed (503)")]) {
    for (const decision of ["approve", "decline"]) {
      const w = row();
      w.io.flip = async () => { throw why; };
      await assert.rejects(decide(decision, w.io), (e) => e === why, `${decision}: ${why.message}`);
      assert.deepEqual(w.calls, []);
      assert.equal(w.state, "pending");
    }
  }
});

test("a skip rides out of decide(), so the answer can say nothing was added", async () => {
  const w = row({ executes: async () => ({ skipped: "phase already exists" }) });
  assert.deepEqual(await decide("approve", w.io), { status: "executed", skipped: "phase already exists" });
  assert.deepEqual(await decide("approve", row({ executes: async () => ({ rowId: "job-1" }) }).io), { status: "executed" });
});

test("TryAgain puts the row back at pending (guarded on approved) instead of burning it", async () => {
  let tries = 0;
  const w = row({ executes: async () => { if (!tries++) throw new TryAgain("couldn't reach the board just now. Nothing was added"); } });
  assert.deepEqual(await decide("approve", w.io),
    { status: "try_again", error: "couldn't reach the board just now. Nothing was added" });
  assert.deepEqual(w.calls, ["flip:approved", "execute", "revert"]);
  assert.equal(w.state, "pending", "answerable again");
  // and it is: the next answer runs it
  assert.deepEqual(await decide("approve", w.io), { status: "executed" });
  assert.equal(w.state, "executed");
});

test("a revert that doesn't land falls back to the failed stamp", async () => {
  const boom = async () => { throw new TryAgain("couldn't reach the board just now. Nothing was added"); };
  for (const revert of [async () => false, async () => { throw new Error("pending_actions update failed (503)"); }, () => { throw new Error("sync"); }]) {
    const w = row({ executes: boom, revert });
    assert.deepEqual(await decide("approve", w.io), { status: "failed", error: "couldn't reach the board just now. Nothing was added" });
    assert.equal(w.state, "failed");
  }
  // only TryAgain earns a revert; any other throw is stamped failed at once
  const w = row({ executes: async () => { throw new Error("that job is no longer on the board"); } });
  await decide("approve", w.io);
  assert.equal(w.calls.includes("revert"), false);
});

test("a failed stamp that matches nothing reports what the row shows: gmail-proxy's executed wins", async () => {
  // gmail-proxy sent and stamped executed, then its answer was lost
  const lost = row({ executes: async (w) => { w.state = "executed"; throw new TypeError("connection reset"); } });
  assert.deepEqual(await decide("approve", lost.io), { status: "executed" });
  assert.deepEqual(lost.calls, ["flip:approved", "execute", "fail:connection reset", "reread"]);
  assert.equal(lost.state, "executed", "never overwritten to failed");

  // a stamp that landed needs no re-read
  const w = row({ executes: async () => { throw new Error("twilio 400"); } });
  await decide("approve", w.io);
  assert.equal(w.calls.includes("reread"), false);

  // a re-read that fails, or shows anything but executed, is still the failure
  const r = row({ executes: async () => { throw new Error("twilio 400"); }, fail: async () => false });
  r.io.reread = async () => { throw new Error("pending_actions read failed (503)"); };
  assert.deepEqual(await decide("approve", r.io), { status: "failed", error: "twilio 400" });
  const s = row({ executes: async () => { throw new Error("twilio 400"); }, fail: async () => false });
  s.io.reread = async () => ({ status: "approved" });
  assert.deepEqual(await decide("approve", s.io), { status: "failed", error: "twilio 400" });
});

/* ---------- index.ts, read as text ---------- */

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");
const fnBody = (name) => {
  const at = src.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, `${name} is in index.ts`);
  return src.slice(at, src.indexOf("\n}\n", at));
};

test("both channels run decide() with the one shared wiring", () => {
  assert.match(fnBody("handleApproval"), /await decide\(decision, decideIO\(act, admin\)\)/);
  assert.match(fnBody("decidePending"), /const io = decideIO\(act, admin\);\s+const out = await decide\(ask\.decision, io\)/);
  // one executor: a single gmail-proxy call site, reached only through decideIO
  assert.equal(src.split("/functions/v1/gmail-proxy").length - 1, 1);
  assert.equal(src.split("executeApproved(act, admin, hour)").length - 1, 1);
});

test("one clock read per decision: the preflight's hour is the backstop's hour", () => {
  const io = src.slice(src.indexOf("function decideIO("), src.indexOf("\n}\n", src.indexOf("function decideIO(")));
  assert.equal(io.split("new Date(").length - 1, 1, "decideIO reads the clock once");
  assert.equal(io.split("anchorageHour(").length - 1, 1);
  assert.match(io, /const at = new Date\(\);\s+const hour = anchorageHour\(at\);/);
  assert.match(io, /quietHoursHold\([^)]*\bhour\b/);
  // "expires before the window opens" is judged from that same instant
  assert.match(io, /expiresBeforeWindow\(act\.expires_at, at, QUIET_START, QUIET_END\)/);
  assert.match(fnBody("executeApproved"), /assertSendWindow\("assist", hour\)/);
});

test("decidePending proves the owner under the caller's JWT before touching the service role", () => {
  const body = fnBody("decidePending");
  const gate = body.search(/db\("rpc\/role_is", jwt, \{[^}]*p_roles: \["owner"\]/);
  assert.ok(gate >= 0, "role_is('owner') under the caller's jwt");
  const verdict = body.indexOf("if (refused) return answer(refused);");
  assert.ok(gate < verdict, "ownerGate reads role_is's answer");
  assert.ok(verdict < body.indexOf("SERVICE_KEY"), "the owner check comes first");
  assert.ok(body.indexOf("parseDecideRequest(") < body.indexOf("SERVICE_KEY"), "and so does the request check");
  assert.doesNotMatch(body, /twilioPost\(|\bsay\(/, "no text goes back for an inbox decision");
});

test("the router names both actions", () => {
  assert.match(src, /action === "decidePending"\) return await decidePending\(/);
  assert.match(src, /"Unknown action\. Expected one of: sendSms, decidePending"/);
});

/* ---------- index.ts, driven ----------
   One pending_actions row (plus any `others` a test adds) behind a stubbed
   PostgREST that honours the id / status / code filters, eq. and neq., the
   way the UPDATE does, plus gmail-proxy, Twilio and the board.
   `over(method, path, init, w)` answers first (a Response, or an Error to
   throw); undefined falls through to the world. */

const SERVE = "data:text/javascript," + encodeURIComponent("export const serve = (h) => { globalThis.__roybalNotify = h; };");
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "https://deno.land/std@0.168.0/http/server.ts") return { url: ${JSON.stringify(SERVE)}, shortCircuit: true };
  return next(spec, ctx);
}`));

const SB = "https://stub.supabase.test";
const ENV = {
  SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-key",
  TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_FROM: "+19075550000",
  OWNER_CELL: "+19075551234", CRON_SECRET: "cron", SMS_ASSIST_ENABLED: "true",
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };
await import("./index.ts");
const handler = globalThis.__roybalNotify;

const ID = "3f2c9a8e-5b1d-4c7e-9f0a-1b2c3d4e5f60";
const JOB = "7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5";   // coordination_jobs.id is a uuid
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const KINDS = {
  emailSend: { label: "email the INV-4 reminder to Hebard",
    params: { to: "hebard@example.com", subject: "INV-4", body: "…", jobId: "j1", invoiceKey: "INV-4" } },
  sendText: { label: "text the Hebards that we're on our way",
    params: { to: "907-555-7777", message: "On our way", audience: "customer" } },
  boardEdit: { label: "add phase Punch list to Pollen",
    params: { op: "addPhase", rowId: JOB, phase: { id: "p-new", name: "Punch list" } } },
};

function world(kind, over = () => undefined) {
  const w = {
    row: { id: ID, code: 12, kind, status: "pending", result: null, expires_at: "2999-01-01T00:00:00Z", ...KINDS[kind] },
    job: { id: JOB, deleted: false, data: { rev: 3, subtasks: [{ id: "a", name: "Demo" }] } },
    others: [], calls: [], texts: [],
  };
  const rows = (path) => {
    const q = new URLSearchParams(path.split("?")[1] || "");
    const is = (col, v) => {
      const f = q.get(col);
      return !f || (f.startsWith("neq.") ? f !== `neq.${v}` : f === `eq.${v}`);
    };
    return [w.row, ...w.others].filter((r) => is("id", r.id) && is("status", r.status) && is("code", r.code));
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input), method = init.method || "GET";
    const path = url.startsWith(SB) ? url.slice(SB.length) : url;
    w.calls.push({ method, path, auth: (init.headers || {}).Authorization, body: init.body });
    const o = await over(method, path, init, w);
    if (o instanceof Error) throw o;
    if (o) return o;
    if (path === "/rest/v1/rpc/role_is") return J(init.headers.Authorization === "Bearer owner-jwt");
    if (path.startsWith("/rest/v1/pending_actions?")) {
      const hit = rows(path);
      if (method === "PATCH") hit.forEach((r) => Object.assign(r, JSON.parse(init.body)));
      return J(hit.map((r) => ({ ...r })));
    }
    if (path === "/functions/v1/gmail-proxy") {
      // it re-reads the row and stamps it executed itself, guarded on approved
      if (w.row.status !== "approved") return J({ ok: false, error: "no approved pending action to execute" }, 403);
      Object.assign(w.row, { status: "executed", result: { gmailId: "g1", threadId: "t1" } });
      return J({ ok: true, gmailId: "g1" });
    }
    if (url.startsWith("https://api.twilio.com/")) {
      const f = new URLSearchParams(String(init.body));
      w.texts.push({ to: f.get("To"), body: f.get("Body") });
      return J({ sid: "SM" + w.texts.length, status: "queued" }, 201);
    }
    if (path === "/rest/v1/sms_messages" && method === "POST") return J([], 201);
    if (/^\/rest\/v1\/(contacts|unified_jobs)\?/.test(path)) return J([]);
    if (path.startsWith("/rest/v1/coordination_jobs?")) {
      if (method === "GET") return J([w.job]);
      const rev = new URLSearchParams(path.split("?")[1]).get("data->>rev");
      if (method === "PATCH" && rev === `eq.${w.job.data.rev}`) { w.job.data = JSON.parse(init.body).data; return J([w.job]); }
      return J([]);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return w;
}

/** The handler logs each decision, and the stubbed failures log too: keep
    that off the test output while it runs, and only then. */
const hushed = async (req) => {
  const keep = [console.log, console.error];
  console.log = console.error = () => {};
  try { return await handler(req); } finally { [console.log, console.error] = keep; }
};

/** The Approvals tab's request, answered as { code, body }. */
const tap = async (decision, bearer = "owner-jwt") => {
  const r = await hushed(new Request(`${SB}/functions/v1/roybal-notify`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ action: "decidePending", id: ID, decision }),
  }));
  return { code: r.status, body: await r.json() };
};

/** The owner's text, signed the way Twilio signs /inbound. */
const text = async (body) => {
  const url = `${SB}/functions/v1/roybal-notify/inbound`;
  const params = new URLSearchParams({ From: "+19075551234", To: "+19075550000", Body: body, MessageSid: "SMin" });
  const payload = [...new Set(params.keys())].sort().map((k) => k + params.get(k)).join("");
  const sig = createHmac("sha1", ENV.TWILIO_AUTH_TOKEN).update(url + payload).digest("base64");
  const r = await hushed(new Request(url, {
    method: "POST", headers: { "X-Twilio-Signature": sig, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }));
  await r.text();
};

const replies = (w) => w.texts.filter((t) => t.to === ENV.OWNER_CELL).map((t) => t.body);
const reached = (w, bit) => w.calls.some((c) => c.path.includes(bit));
const flipPatch = (m, p) => m === "PATCH" && p.startsWith("/rest/v1/pending_actions?") && p.includes("status=eq.pending");

test("a flip whose PATCH errored is a server error, not 'already answered'; the row stays answerable", async () => {
  const w = world("emailSend", (m, p) => flipPatch(m, p) ? J({ code: "PGRST000", message: "upstream" }, 503) : undefined);
  const r = await tap("approve");
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "server_error");
  assert.match(r.body.message, /\(503\)/);
  assert.equal(w.row.status, "pending");
  assert.equal(reached(w, "gmail-proxy"), false);

  // a 2xx that matched nothing is still the lost race
  const v = world("emailSend", (m, p, _i, v) => { if (flipPatch(m, p)) v.row.status = "approved"; });
  assert.deepEqual(await tap("approve"),
    { code: 404, body: { ok: false, error: "not_open", message: "Already answered, or it expired." } });
  assert.equal(reached(v, "gmail-proxy"), false);
});

test("a YES or NO whose flip errored says to text it again, and never reaches the assistant", async () => {
  for (const [said, word] of [["YES 12", "YES"], ["no 12", "NO"]]) {
    const w = world("emailSend", (m, p) => flipPatch(m, p) ? J({ message: "upstream" }, 503) : undefined);
    await text(said);
    assert.deepEqual(replies(w), [`Couldn't record that just now — text ${word} 12 again in a minute.`], said);
    assert.equal(reached(w, "roybal-ai-office"), false, `${said} is an answer, never a question`);
    assert.equal(w.row.status, "pending");
  }
});

test("a NO that lost the race says nothing was cancelled", async () => {
  const w = world("emailSend", (m, p, _i, w) => { if (flipPatch(m, p)) w.row.status = "executed"; });
  await text("NO 12");
  assert.deepEqual(replies(w), ["That one was already answered — nothing was cancelled."]);
  assert.equal(w.row.status, "executed");
});

test("role_is: only a 200 true passes; a refused token is 401, an outage 503; nothing runs as the service role", async () => {
  const cases = [
    ["role_is 401", () => J({ code: "PGRST303", message: "JWT expired" }, 401), 401, "auth", "Your login expired. Sign in again."],
    ["role_is 503", () => J({ code: "PGRST002" }, 503), 503, "role_check_failed", "Couldn't check your login just now. Try again."],
    ["role_is 500", () => J({}, 500), 503, "role_check_failed", "Couldn't check your login just now. Try again."],
    ["role_is unreachable", () => new TypeError("fetch failed"), 503, "role_check_failed", "Couldn't check your login just now. Try again."],
    ["role_is 200 false", () => J(false), 403, "not_owner", "Approvals belong to the owner's login."],
    ["role_is 200 null", () => J(null), 403, "not_owner", "Approvals belong to the owner's login."],
    ["role_is 200 not json", () => new Response("<html>", { status: 200 }), 403, "not_owner", "Approvals belong to the owner's login."],
  ];
  for (const [label, role, code, error, message] of cases) {
    const w = world("emailSend", (_m, p) => p === "/rest/v1/rpc/role_is" ? role() : undefined);
    assert.deepEqual(await tap("approve"), { code, body: { ok: false, error, message } }, label);
    assert.equal(w.calls.some((c) => c.auth === "Bearer service-key"), false, `${label}: nothing ran as the service role`);
    assert.equal(w.row.status, "pending", label);
  }
  // a valid token that isn't the owner's
  const w = world("emailSend");
  assert.equal((await tap("approve", "crew-jwt")).code, 403);
  assert.equal(w.calls.some((c) => c.auth === "Bearer service-key"), false);
});

test("an answer straddling 8pm is judged on one clock read: it sends, it is never burned as failed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-07-01T03:59:59.950Z") });   // 7:59:59.95 pm AKDT
  try {
    // the flip's round trip carries the clock past 8pm
    const w = world("sendText", (m, p) => { if (flipPatch(m, p)) t.mock.timers.tick(100); });
    const r = await tap("approve");
    assert.equal(r.code, 200);
    assert.equal(r.body.status, "executed");
    assert.equal(w.row.status, "executed");
    assert.deepEqual(w.texts.map((x) => x.to), ["+19075557777"]);

    // the text channel reads the same one clock
    t.mock.timers.setTime(Date.parse("2026-07-01T03:59:59.950Z"));
    const v = world("sendText", (m, p) => { if (flipPatch(m, p)) t.mock.timers.tick(100); });
    await text("YES 12");
    assert.equal(v.row.status, "executed");
    assert.deepEqual(replies(v), ["✅ Done — text the Hebards that we're on our way."]);

    // an answer that starts at 8pm is still held before anything flips
    const h = world("sendText");
    assert.equal((await tap("approve")).code, 409);
    assert.equal(h.row.status, "pending");
    assert.equal(h.texts.length, 0);
  } finally { t.mock.timers.reset(); }
});

test("a board that couldn't be reached puts the row back: 409 try_again, and the next tap adds the phase", async () => {
  let down = true;
  const boardRead = (m, p) => m === "GET" && p.startsWith("/rest/v1/coordination_jobs?");
  const w = world("boardEdit", (m, p) => down && boardRead(m, p) ? J({ message: "upstream" }, 503) : undefined);
  assert.deepEqual(await tap("approve"), { code: 409, body: { ok: false, error: "try_again",
    message: "Couldn't reach the board just now. Nothing was added; try again in a minute." } });
  assert.equal(w.row.status, "pending", "back in the queue, answerable again");
  assert.equal(w.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/rest/v1/coordination_jobs")), false);
  down = false;
  const again = await tap("approve");
  assert.equal(again.body.status, "executed");
  assert.equal(w.job.data.subtasks.at(-1).name, "Punch list");

  // a read that never answered at all is the same: nothing was written
  const n = world("boardEdit", (m, p) => boardRead(m, p) ? new TypeError("fetch failed") : undefined);
  assert.equal((await tap("approve")).body.error, "try_again");
  assert.equal(n.row.status, "pending");

  // the text channel: nothing added, text YES 12 again
  const v = world("boardEdit", (m, p) => boardRead(m, p) ? J({}, 503) : undefined);
  await text("YES 12");
  assert.deepEqual(replies(v), ["⏳ Couldn't reach the board just now. Nothing was added — text YES 12 again in a minute."]);
  assert.equal(v.row.status, "pending");
});

test("a board revert that doesn't land falls back to the failed stamp, which promises no retry", async () => {
  const revert = (m, p, i) => m === "PATCH" && p.includes("status=eq.approved") && JSON.parse(i.body).status === "pending";
  const w = world("boardEdit", (m, p, i) =>
    m === "GET" && p.startsWith("/rest/v1/coordination_jobs?") ? J({}, 503) : revert(m, p, i) ? J({}, 503) : undefined);
  const r = await tap("approve");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "failed");
  assert.equal(w.row.status, "failed");
  assert.match(r.body.message, /couldn't reach the board just now\. Nothing was added/);
  assert.doesNotMatch(r.body.message, /text YES|try again/i, "the row is burned: no advice to answer it again");
  // and the same when the revert matched nothing
  const v = world("boardEdit", (m, p, i) =>
    m === "GET" && p.startsWith("/rest/v1/coordination_jobs?") ? J({}, 503) : revert(m, p, i) ? J([]) : undefined);
  assert.equal((await tap("approve")).body.status, "failed");
  assert.equal(v.row.status, "failed");
});

test("a failed stamp never overwrites the executed stamp gmail-proxy already wrote", async () => {
  // Gmail took the message and gmail-proxy stamped the row, then its answer was lost
  const lost = (_m, p, _i, w) => {
    if (p !== "/functions/v1/gmail-proxy" || w.row.status !== "approved") return undefined;
    Object.assign(w.row, { status: "executed", result: { gmailId: "g1", threadId: "t1" } });
    return new TypeError("connection reset");
  };
  const w = world("emailSend", lost);
  const r = await tap("approve");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "executed");
  assert.equal(r.body.action.status, "executed");
  assert.equal(w.row.status, "executed", "the brief's dedupe still sees it sent");

  const v = world("emailSend", lost);
  await text("YES 12");
  assert.equal(v.row.status, "executed");
  assert.deepEqual(replies(v), ["✅ Done — email the INV-4 reminder to Hebard."]);

  // a real failure is still stamped, and only over an approved row
  const f = world("emailSend", (_m, p) => p === "/functions/v1/gmail-proxy" ? J({ ok: false, error: "Invalid 'to' address" }, 400) : undefined);
  assert.equal((await tap("approve")).body.status, "failed");
  assert.equal(f.row.status, "failed");
  assert.deepEqual(f.row.result, { error: "Invalid 'to' address" });
  const stamp = f.calls.find((c) => c.method === "PATCH" && JSON.parse(c.body).status === "failed");
  assert.match(stamp.path, /&status=eq\.approved/);
});

test("a 200 carries the row as re-read after the decision", async () => {
  world("emailSend");
  assert.deepEqual(await tap("approve"), { code: 200, body: { ok: true, status: "executed",
    message: "Done — email the INV-4 reminder to Hebard.",
    action: { id: ID, code: 12, kind: "emailSend", label: "email the INV-4 reminder to Hebard",
      status: "executed", result: { gmailId: "g1", threadId: "t1" } } } });

  world("emailSend");
  const d = await tap("decline");
  assert.equal(d.body.status, "declined");
  assert.deepEqual([d.body.action.status, d.body.action.result], ["declined", null]);

  // someone added the phase by hand while it sat: the message says so
  const b = world("boardEdit");
  b.job.data.subtasks.push({ id: "b", name: "punch LIST" });
  const s = await tap("approve");
  assert.equal(s.code, 200);
  assert.equal(s.body.message, "Phase was already on the board — nothing was added.");
  assert.deepEqual([s.body.action.status, s.body.action.result], ["executed", { rowId: JOB, skipped: "phase already exists" }]);
  assert.equal(b.job.data.rev, 3, "nothing was written");

  // a re-read that fails still answers what was decided
  const reread = (m, p) => m === "GET" && p.startsWith(`/rest/v1/pending_actions?id=eq.${ID}&select=`);
  const n = world("boardEdit", (m, p) => reread(m, p) ? J({}, 503) : undefined);
  n.job.data.subtasks.push({ id: "b", name: "Punch list" });
  const t2 = await tap("approve");
  assert.equal(t2.code, 200);
  assert.equal(t2.body.message, "Phase was already on the board — nothing was added.");
  assert.deepEqual([t2.body.action.status, t2.body.action.result], ["executed", { skipped: "phase already exists" }]);
  // and the row's params never ride back
  assert.equal(JSON.stringify(t2.body).includes("p-new"), false);
});

/* ---------- the board read, the revert, and the window's next opening ---------- */

const boardRead = (m, p) => m === "GET" && p.startsWith("/rest/v1/coordination_jobs?");
const twinCheck = (m, p) => m === "GET" && p.startsWith("/rest/v1/pending_actions?code=eq.");
const revertPatch = (c) => c.method === "PATCH" && c.path.includes("status=eq.approved") && JSON.parse(c.body).status === "pending";
const TWIN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

test("a revert never leaves two live rows on one code: a twin minted meanwhile means the failed stamp", async () => {
  // the board doesn't answer, and while this row sits at approved the brief
  // mints a new proposal on code 12 (every allocator counts only pending rows)
  const minted = (m, p, _i, w) => {
    if (!boardRead(m, p)) return undefined;
    w.others.push({ ...KINDS.emailSend, id: TWIN, code: 12, kind: "emailSend", status: "pending", result: null,
      expires_at: "2999-01-01T00:00:00Z" });
    return J({ message: "upstream" }, 503);
  };
  const w = world("boardEdit", minted);
  const r = await tap("approve");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "failed");
  // closed, and why: the same YES would now run the twin
  assert.equal(r.body.message, "couldn't reach the board just now. Nothing was added; its YES number now belongs to a newer ask, so this one is closed");
  assert.equal(w.row.status, "failed", "never back at pending beside its twin");
  assert.equal(w.others[0].status, "pending", "the twin is untouched");
  assert.equal(w.calls.some(revertPatch), false, "no revert was sent");
  // the check asks for exactly a twin: this code, live, any row but this one
  const check = w.calls.find((c) => twinCheck(c.method, c.path));
  assert.equal(check.auth, "Bearer service-key");
  const q = new URLSearchParams(check.path.split("?")[1]);
  assert.deepEqual([q.get("code"), q.get("status"), q.get("id"), q.get("select"), q.get("limit")],
    ["eq.12", "eq.pending", `neq.${ID}`, "id", "1"]);
  assert.match(q.get("expires_at"), /^gt\.\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  // the text channel: the failure, never "text YES 12 again" (that YES would now be the twin's)
  const v = world("boardEdit", minted);
  await text("YES 12");
  assert.equal(v.row.status, "failed");
  assert.deepEqual(replies(v), ["⚠️ Couldn't do it: couldn't reach the board just now. Nothing was added; its YES number now belongs to a newer ask, so this one is closed. Nothing was sent."]);
});

test("a twin check that fails, never answers, or won't parse is no revert either", async () => {
  const answers = [
    ["503", () => J({ message: "upstream" }, 503)],
    ["unreachable", () => new TypeError("fetch failed")],
    ["not json", () => new Response("<html>", { status: 200 })],
  ];
  for (const [label, answer] of answers) {
    const w = world("boardEdit", (m, p) => boardRead(m, p) ? J({}, 503) : twinCheck(m, p) ? answer() : undefined);
    const r = await tap("approve");
    assert.equal(r.body.status, "failed", label);
    assert.equal(w.row.status, "failed", label);
    assert.equal(w.calls.some(revertPatch), false, label);
  }
  // no live row on this code (another code, or this code but settled): the revert goes ahead, after the check
  const w = world("boardEdit", (m, p) => boardRead(m, p) ? J({}, 503) : undefined);
  w.others.push({ id: TWIN, code: 13, kind: "emailSend", status: "pending" },
    { id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", code: 12, kind: "emailSend", status: "executed" });
  assert.equal((await tap("approve")).body.error, "try_again");
  assert.equal(w.row.status, "pending");
  const first = (f) => w.calls.findIndex(f);
  assert.ok(first((c) => twinCheck(c.method, c.path)) >= 0);
  assert.ok(first((c) => twinCheck(c.method, c.path)) < first(revertPatch));
});

test("a board read refused for good is a plain failure, not a row that bounces back to pending forever", async () => {
  for (const status of [400, 401, 403, 404]) {
    const w = world("boardEdit", (m, p) =>
      boardRead(m, p) ? J({ code: "22P02", message: "invalid input syntax for type uuid" }, status) : undefined);
    const r = await tap("approve");
    assert.equal(r.code, 200, String(status));
    assert.equal(r.body.status, "failed");
    assert.equal(r.body.message, `couldn't read that board job (status ${status})`);
    assert.equal(w.row.status, "failed");
    assert.equal(w.calls.some(revertPatch), false, "no revert");
    assert.equal(w.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/rest/v1/coordination_jobs")), false);
  }
  // an outage or a rate limit is still worth another try
  for (const status of [429, 500, 502, 504]) {
    const w = world("boardEdit", (m, p) => boardRead(m, p) ? J({}, status) : undefined);
    assert.equal((await tap("approve")).body.error, "try_again", String(status));
    assert.equal(w.row.status, "pending", String(status));
  }
  // the text channel says it failed, and doesn't ask for the same YES again
  const v = world("boardEdit", (m, p) => boardRead(m, p) ? J({}, 400) : undefined);
  await text("YES 12");
  assert.deepEqual(replies(v), ["⚠️ Couldn't do it: couldn't read that board job (status 400). Nothing was sent."]);
  assert.equal(v.row.status, "failed");
});

test("a board read that answers 200 with a body that won't parse is a read that didn't land: try again", async () => {
  const bodies = [
    ["a gateway page", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["not a list", () => J({ message: "odd" })],
  ];
  for (const [label, body] of bodies) {
    const w = world("boardEdit", (m, p) => boardRead(m, p) ? body() : undefined);
    const r = await tap("approve");
    assert.equal(r.body.error, "try_again", label);
    assert.equal(w.row.status, "pending", label);
    assert.doesNotMatch(r.body.message, /no longer on the board/, label);
  }
  // an empty list is still a real answer: the job is gone
  const v = world("boardEdit", (m, p) => boardRead(m, p) ? J([]) : undefined);
  assert.equal((await tap("approve")).body.message, "that job is no longer on the board");
  assert.equal(v.row.status, "failed");
});

test("a proposal whose board job isn't a uuid fails before the board is read", async () => {
  const w = world("boardEdit");
  w.row.params = { ...w.row.params, rowId: "job-1" };
  const r = await tap("approve");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "failed");
  assert.equal(r.body.message, "the proposal names no valid board job");
  assert.equal(w.row.status, "failed");
  assert.equal(reached(w, "coordination_jobs"), false);
});

test("a held customer text that expires before 7am says it won't go out; one that outlives the night still waits", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-07-02T05:30:00Z") });   // 9:30pm AKDT; opens 15:00Z
  try {
    const lapsing = (w) => { w.row.expires_at = "2026-07-02T10:00:00Z"; return w; };   // 2am
    const w = lapsing(world("sendText"));
    assert.deepEqual(await tap("approve"), { code: 409, body: { ok: false, error: "quiet_hours",
      message: "Customer texts only go out between 7am and 8pm Alaska time, and this one expires before then. Nothing was sent." } });
    assert.equal(w.row.status, "pending");
    assert.equal(w.texts.length, 0);

    const v = lapsing(world("sendText"));
    await text("YES 12");
    assert.deepEqual(replies(v),
      ["🌙 Customer texts go out between 7am and 8pm Alaska time, and this one expires before then, so it won't go out. Nothing was sent."]);
    assert.equal(v.row.status, "pending");

    // a 9am expiry is still answerable once the window opens: today's wording
    const lasting = (w) => { w.row.expires_at = "2026-07-02T17:00:00Z"; return w; };
    lasting(world("sendText"));
    const r = await tap("approve");
    assert.deepEqual([r.code, r.body.message],
      [409, "Customer texts go out between 7am and 8pm Alaska time. It's still waiting; approve it then."]);
    const u = lasting(world("sendText"));
    await text("YES 12");
    assert.deepEqual(replies(u),
      ["🌙 Customer texts go out between 7am and 8pm Alaska time — text YES 12 again then. Nothing was sent; it's still waiting."]);
  } finally { t.mock.timers.reset(); }
});
