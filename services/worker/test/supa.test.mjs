import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSupa, parseCount, SupaError } from "../supa.mjs";
import { fakeFetch } from "./helpers.mjs";
import { loadConfig } from "../config.mjs";

test("parseCount reads PostgREST's Content-Range", () => {
  assert.equal(parseCount("0-9/123"), 123);
  assert.equal(parseCount("*/0"), 0);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount("0-9/*"), null);
});

test("every verb carries the service key twice and surfaces PostgREST errors with their code", async () => {
  const fetch = fakeFetch([
    { match: (u) => u.endsWith("/rest/v1/rpc/finish_job"), reply: () => ({ status: 400, body: { code: "55000", message: "finish_job: job x is done (held by nobody), not leased by w", details: null } }) },
    { match: (u) => u.includes("/rest/v1/outbox?select=id&limit=1&status=eq.dead"), reply: () => ({ body: [], headers: { "Content-Range": "0-0/4" } }) },
    { match: (u) => u.includes("/rest/v1/app_settings?on_conflict=key"), reply: (_u, init) => ({ body: JSON.parse(init.body) }) },
    { match: (u) => u.includes("/rest/v1/gmail_tokens?id=eq.t1"), reply: () => ({ body: [{ id: "t1" }] }) },
    { match: (u) => u.endsWith("/rest/v1/rpc/sweep_leases"), reply: () => ({ body: 3 }) },
  ]);
  const supa = makeSupa({ supabaseUrl: "https://x.supabase.co", serviceKey: "sb_secret_k", fetchImpl: fetch });

  await assert.rejects(supa.rpc("finish_job", { p_job_id: "x" }), (e) => {
    assert.ok(e instanceof SupaError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "55000");
    assert.match(e.message, /not leased by w/);
    return true;
  });
  assert.equal(await supa.count("outbox", "status=eq.dead"), 4);
  assert.equal(await supa.rpc("sweep_leases"), 3);
  const up = await supa.upsert("app_settings", [{ key: "k", value: {} }], "key");
  assert.equal(up[0].key, "k");
  assert.equal((await supa.patch("gmail_tokens", "id=eq.t1", { access_token: "a" }))[0].id, "t1");

  for (const c of fetch.calls) {
    assert.equal(c.init.headers.apikey, "sb_secret_k");
    assert.equal(c.init.headers.Authorization, "Bearer sb_secret_k");
  }
  const upsertCall = fetch.calls.find((c) => c.url.includes("app_settings"));
  assert.match(upsertCall.init.headers.Prefer, /resolution=merge-duplicates/);
  const countCall = fetch.calls.find((c) => c.url.includes("/outbox?"));
  assert.equal(countCall.init.headers.Prefer, "count=exact");
});

test("loadConfig requires the url and key, clamps numbers, and turns email off without both Gmail secrets", () => {
  assert.throws(() => loadConfig({}), /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => loadConfig({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k" }), /SUPABASE_URL/);
  const base = { SUPABASE_URL: "https://ref.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" };
  const c = loadConfig({ ...base, WORKER_POLL_MS: "10", WORKER_HEARTBEAT_MS: "9999999", FLY_APP_NAME: "roybal-worker", FLY_MACHINE_ID: "abc" });
  assert.equal(c.supabaseUrl, "https://ref.supabase.co");
  assert.equal(c.pollMs, 250);
  assert.equal(c.heartbeatMs, 120_000);
  assert.equal(c.workerId, "roybal-worker-abc");
  assert.equal(c.emailEnabled, false);
  assert.deepEqual(c.channels, ["sms"]);
  assert.equal(c.notifyUrl, "https://ref.supabase.co/functions/v1/roybal-notify");
  assert.equal(c.outboxAgentId, "0a7ac824-5042-4bb5-ab0d-8569cea209b1");
  const e = loadConfig({ ...base, GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "s" });
  assert.equal(e.emailEnabled, true);
  assert.deepEqual(e.channels, ["sms", "email"]);
  const half = loadConfig({ ...base, GMAIL_CLIENT_ID: "id" });
  assert.equal(half.emailEnabled, false);
});

test("EMAIL_MAX_AGE_HOURS defaults to 48, is clamped to 1..720, and nonsense keeps the default instead of switching the limit off", () => {
  const base = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k" };
  const hours = (v) => loadConfig(v === undefined ? base : { ...base, EMAIL_MAX_AGE_HOURS: v }).emailMaxAgeHours;
  assert.equal(hours(undefined), 48);
  assert.equal(hours("24"), 24);
  assert.equal(hours(" 72 "), 72);
  assert.equal(hours("36.6"), 37);
  assert.equal(hours("0"), 1, "zero cannot mean 'no limit'");
  assert.equal(hours("-5"), 1);
  assert.equal(hours("100000"), 720);
  assert.equal(hours("abc"), 48);
  assert.equal(hours("48h"), 48);
  assert.equal(hours("Infinity"), 48);
  assert.equal(hours(""), 48, "blank is unset, not zero");
  assert.equal(hours("   "), 48);
  // The same blank-is-unset rule for the other knobs: a blank poll no longer clamps to the 250 ms floor.
  assert.equal(loadConfig({ ...base, WORKER_POLL_MS: "" }).pollMs, 5000);
});

test("loadConfig refuses the wrong Supabase key and pasted placeholders at boot, naming the variable but never the value", () => {
  const base = { SUPABASE_URL: "https://ref.supabase.co" };
  const refuses = (env, re) => {
    let err;
    try { loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k", ...env }); } catch (e) { err = e; }
    assert.ok(err, `expected a refusal for ${JSON.stringify(Object.keys(env))}`);
    assert.match(err.message, re);
    for (const v of Object.values(env)) if (v.length > 6) assert.ok(!err.message.includes(v), "the value must not be echoed");
    return err;
  };
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.x.y" }, /legacy JWT/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123def456" }, /publishable key/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "<sb_secret_… key>" }, /SUPABASE_SERVICE_ROLE_KEY looks like a placeholder/);
  refuses({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_PASTE_HERE" }, /SUPABASE_SERVICE_ROLE_KEY looks like a placeholder/);
  refuses({ GMAIL_CLIENT_ID: "<same as the gmail-proxy secret>" }, /GMAIL_CLIENT_ID looks like a placeholder/);
  refuses({ GMAIL_CLIENT_SECRET: "<its client secret>" }, /GMAIL_CLIENT_SECRET looks like a placeholder/);
  refuses({ OWNER_CELL: "<+19075550199>" }, /OWNER_CELL looks like a placeholder/);
  refuses({ OWNER_CELL: "907-555-019" }, /OWNER_CELL is not a US phone number/);
  refuses({ OWNER_CELL: "+44 20 7946 0958" }, /OWNER_CELL is not a US phone number/);

  // Real shapes pass; the cell is normalized the way roybal-notify's toE164 does it.
  const ok = (cell) => loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: " sb_secret_k\n", OWNER_CELL: cell });
  assert.equal(ok("9075550199").ownerCell, "+19075550199");
  assert.equal(ok("(907) 555-0199").ownerCell, "+19075550199");
  assert.equal(ok("+1 907 555 0199").ownerCell, "+19075550199");
  assert.equal(ok("").ownerCell, "");
  assert.equal(ok("9075550199").serviceKey, "sb_secret_k");
  const g = loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k",
    GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com", GMAIL_CLIENT_SECRET: "GOCSPX-abc_DEF-123" });
  assert.equal(g.emailEnabled, true);
});

// set-gmail-secret.sh, run the way the README says (from the repo root of a
// main checkout) with the secret piped in and a stand-in `fly` on PATH that
// records every call: its arguments, its directory, and what an import got
// on stdin. The checkout is a throwaway git repo holding the files the
// script reads, so the test does not depend on this checkout's branch. The
// script must stage exactly the pair through stdin (never on a command
// line), deploy right after, never print the secret, refuse a checkout the
// deploy must not build from, and refuse every value the worker would
// refuse at boot: a value it let through and loadConfig refused would stop
// the worker and the text lane.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIELD_CLIENT_ID = /export const GMAIL_CLIENT_ID = "([^"]+)"/.exec(
  fs.readFileSync(path.join(REPO, "apps/field/js/config.js"), "utf8"))?.[1];
const CHECKOUT_FILES = ["apps/field/js/config.js", "services/worker/set-gmail-secret.sh",
  "services/worker/adapters/email.mjs", "services/worker/fly.toml", "services/worker/Dockerfile"];
// A GIT_DIR from a hook running these tests must not point git elsewhere.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const HAS_GIT = spawnSync("git", ["--version"], { env: ENV }).status === 0;
const FAKE_FLY = `#!/bin/sh
n=1
while [ -e "$FAKE_FLY_DIR/$n.args" ]; do n=$((n + 1)); done
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_FLY_DIR/$n.args"
pwd -P > "$FAKE_FLY_DIR/$n.cwd"
[ "$1" = auth ] && exit 0
if [ "$1" = secrets ] && [ "$2" = import ]; then
  if [ "$3" = --help ]; then
    [ -n "\${FAKE_FLY_NO_STAGE:-}" ] || printf '%s\\n' '      --stage           Set secrets but skip deployment for machine apps'
    exit 0
  fi
  cat > "$FAKE_FLY_DIR/$n.stdin"
fi
[ "$1" = "\${FAKE_FLY_FAIL:-}" ] && exit 1
exit 0
`;
const DEPLOY_ARGS = ["deploy", "-a", "roybal-worker", "--config", "services/worker/fly.toml",
  "--dockerfile", "services/worker/Dockerfile", "--ha=false", "."];

function runSetGmailSecret(input, { branch = "main", git = true, adapter, from = "", env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-gmail-secret-"));
  const callDir = path.join(dir, "fly-calls");
  fs.mkdirSync(callDir);
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "fly"), FAKE_FLY, { mode: 0o755 });
  const root = path.join(dir, "repo");
  for (const f of CHECKOUT_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  if (adapter !== undefined) fs.writeFileSync(path.join(root, "services/worker/adapters/email.mjs"), adapter);
  if (git) {
    // HEAD names the branch with no commit behind it, which is all the script reads.
    spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: ENV });
    spawnSync("git", ["-C", root, "symbolic-ref", "HEAD", `refs/heads/${branch}`], { env: ENV });
  }
  try {
    const cwd = path.join(root, from);
    const r = spawnSync("sh", [path.relative(cwd, path.join(root, "services/worker/set-gmail-secret.sh"))], {
      cwd, input, encoding: "utf8",
      env: { ...ENV, PATH: `${path.join(dir, "bin")}:${ENV.PATH}`, FAKE_FLY_DIR: callDir, ...env },
    });
    const calls = [];
    for (let n = 1; fs.existsSync(path.join(callDir, `${n}.args`)); n++) {
      const read = (ext) => fs.existsSync(path.join(callDir, `${n}.${ext}`)) ? fs.readFileSync(path.join(callDir, `${n}.${ext}`), "utf8") : null;
      calls.push({ args: read("args").split("\n").filter(Boolean), cwd: read("cwd").trim(), stdin: read("stdin") });
    }
    // What changes Fly: everything but the login check and the --stage probe.
    const changes = calls.filter((c) => c.args[0] !== "auth" && !c.args.includes("--help"));
    return { status: r.status, output: `${r.stdout}${r.stderr}`, calls, changes, root: fs.realpathSync(root) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("set-gmail-secret.sh stages exactly the pair on stdin, deploys after, never shows the secret, and refuses what the worker would refuse", { skip: process.platform === "win32" || !HAS_GIT }, () => {
  assert.match(FIELD_CLIENT_ID ?? "", /\.apps\.googleusercontent\.com$/);
  const secret = "GOCSPX-t3st_Secret-value9";
  const ok = runSetGmailSecret(`${secret}\n`);
  assert.equal(ok.status, 0, ok.output);
  assert.deepEqual(ok.changes.map((c) => c.args), [["secrets", "import", "--stage", "-a", "roybal-worker"], DEPLOY_ARGS]);
  assert.equal(ok.changes[0].stdin, `GMAIL_CLIENT_ID=${FIELD_CLIENT_ID}\nGMAIL_CLIENT_SECRET=${secret}\n`);
  assert.equal(ok.changes[1].cwd, ok.root, "deploys from the repo root");
  for (const c of ok.calls) {
    assert.ok(!c.args.some((a) => a.includes("t3st_Secret")), `the secret is never on a command line: fly ${c.args.join(" ")}`);
  }
  assert.ok(!ok.output.includes(secret) && !ok.output.includes("t3st_Secret"), "the secret is never printed");
  assert.match(ok.output, /worker\.start line with "email":true/);
  assert.match(ok.output, /"channels":\["sms","email"\]/);
  assert.match(ok.output, /email\.disabled/);
  assert.doesNotMatch(ok.output, /no deploy/i);
  // What it staged, the worker boots with.
  const cfg = loadConfig({ SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k",
    GMAIL_CLIENT_ID: FIELD_CLIENT_ID, GMAIL_CLIENT_SECRET: secret });
  assert.equal(cfg.emailEnabled, true);

  // A checkout the deploy must not build from: fly is never called at all.
  const update = "cd ~/roybal-restoration-app && git checkout main && git pull";
  for (const [why, opts] of [
    ["not a git checkout", { git: false }],
    ["another branch", { branch: "claude/some-branch" }],
    ["a main older than the 48-hour limit", { adapter: "export function emailAdapter() {}\n" }],
    ["below the repo root", { from: "services" }],
  ]) {
    const r = runSetGmailSecret(`${secret}\n`, opts);
    assert.notEqual(r.status, 0, `refused: ${why}`);
    assert.deepEqual(r.calls, [], `fly not called: ${why}`);
    assert.ok(r.output.includes(update), `says to update main first: ${why}\n${r.output}`);
    assert.match(r.output, /Nothing was changed/);
  }

  // A fly that cannot stage: refused before the secret is asked for.
  const old = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_NO_STAGE: "1" } });
  assert.notEqual(old.status, 0);
  assert.deepEqual(old.changes, []);
  assert.match(old.output, /brew upgrade flyctl/);
  assert.doesNotMatch(old.output, /Paste the client secret/);

  // fly refuses the import: no deploy. The deploy fails: it says the pair is
  // staged, not live, and gives the deploy line to run again.
  const noImport = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_FAIL: "secrets" } });
  assert.notEqual(noImport.status, 0);
  assert.deepEqual(noImport.changes.map((c) => c.args[0]), ["secrets"]);
  const noDeploy = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_FAIL: "deploy" } });
  assert.notEqual(noDeploy.status, 0);
  assert.deepEqual(noDeploy.changes.map((c) => c.args), [["secrets", "import", "--stage", "-a", "roybal-worker"], DEPLOY_ARGS]);
  assert.match(noDeploy.output, /staged on roybal-worker, not live yet/);
  assert.ok(noDeploy.output.includes(`fly ${DEPLOY_ARGS.join(" ")}`), noDeploy.output);
  assert.doesNotMatch(noDeploy.output, /Done\./);

  for (const bad of ["", "GOCSPX-has space", "GOCSPX-\"quoted\"", "GOCSPX-'quoted'", "<its client secret>",
    "GOCSPX-<x>", "GOCSPX-abc…", "GOCSPX-PASTE_HERE", "GOCSPX-nb sp", "GOCSPX-cr\r"]) {
    const r = runSetGmailSecret(`${bad}\n`);
    assert.notEqual(r.status, 0, `refused: ${JSON.stringify(bad)}`);
    assert.deepEqual(r.changes, [], `nothing staged or deployed for ${JSON.stringify(bad)}`);
    assert.match(r.output, /Nothing was changed/);
  }

  // Not GOCSPX-: a warning, then only an explicit y goes ahead.
  const no = runSetGmailSecret("oldstyleSecret123\nn\n");
  assert.notEqual(no.status, 0);
  assert.deepEqual(no.changes, []);
  assert.match(no.output, /start with GOCSPX-/);
  assert.deepEqual(runSetGmailSecret("oldstyleSecret123\n").changes, [], "no answer is a no");
  const yes = runSetGmailSecret("oldstyleSecret123\ny\n");
  assert.equal(yes.status, 0, yes.output);
  assert.match(yes.changes[0].stdin, /\nGMAIL_CLIENT_SECRET=oldstyleSecret123\n$/);
  assert.equal(yes.changes[1].args[0], "deploy");
  assert.ok(!yes.output.includes("oldstyleSecret123"));
});
