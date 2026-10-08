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
// main checkout) with the secret piped in and stand-ins on PATH, so nothing
// touches the network: a `fly` that records every call (its arguments, its
// directory, what an import got on stdin) and can fail one or be stopped
// during one; a `git` that is the real one except for fetch, which is
// recorded and can fail or find a newer main; a `curl` that answers
// roybal-notify's /version with whatever the test says. The checkout is a
// throwaway git repo holding the files the script reads, committed, with
// origin/main at that commit, so the test does not depend on this
// checkout's branch. The script must refuse a checkout the deploy must not
// build from and a roybal-notify that cannot answer a spine YES with fly
// never called; stage exactly the pair through stdin (never on a command
// line) and deploy right after; take the pair back out (unset --stage) when
// the deploy fails or the run is stopped once fly has it; never print the
// secret; and refuse every value the worker would refuse at boot: a value
// it let through and loadConfig refused would stop the worker and the text
// lane.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIELD_CONFIG = fs.readFileSync(path.join(REPO, "apps/field/js/config.js"), "utf8");
const FIELD_CLIENT_ID = /export const GMAIL_CLIENT_ID = "([^"]+)"/.exec(FIELD_CONFIG)?.[1];
const FIELD_SUPABASE_URL = /export const SUPABASE_URL = "([^"]+)"/.exec(FIELD_CONFIG)?.[1];
// The field modules the worker image copies (services/worker/Dockerfile).
const COPIED_FIELD = ["reconcile.js", "dryingcalc.js", "model.js", "core.js", "scans.js"].map((f) => `apps/field/js/${f}`);
const CHECKOUT_FILES = ["apps/field/js/config.js", "services/worker/set-gmail-secret.sh",
  "services/worker/adapters/email.mjs", "services/worker/fly.toml", "services/worker/Dockerfile", ".dockerignore",
  ...COPIED_FIELD];
// A GIT_DIR from a hook running these tests must not point git elsewhere.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const which = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { env: ENV, encoding: "utf8" }).stdout?.trim() ?? "";
const REAL_GIT = which("git");
const HAS_GIT = REAL_GIT !== "" && spawnSync(REAL_GIT, ["--version"], { env: ENV }).status === 0;
// macOS runs /bin/sh as bash in POSIX mode; sh here is usually dash.
const SHELLS = [["sh"], ...(which("bash") ? [["bash", "--posix"]] : [])];
const SKIP = process.platform === "win32" || !HAS_GIT;
// What roybal-notify's GET /version answers on the step-5 build
// (VERSION_ANSWER in supabase/functions/roybal-notify/approve.ts).
const SPINE_ANSWER = '{"ok":true,"function":"roybal-notify","answers":["text","spine"]}';
const FAKE_FLY = `#!/bin/sh
n=1
while [ -e "$FAKE_DIR/$n.args" ]; do n=$((n + 1)); done
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/$n.args"
pwd -P > "$FAKE_DIR/$n.cwd"
if [ "$1" = secrets ] && [ "$3" = --help ]; then
  case " \${FAKE_FLY_NO_STAGE:-} " in
    *" $2 "*) ;;
    *) printf '%s\\n' '      --stage           Set secrets but skip deployment for machine apps' ;;
  esac
  exit 0
fi
# Stopped during this call, the way Ctrl-C stops it: the script's shell
# gets SIGINT, and fly gives up.
case " \${FAKE_FLY_STOP:-} " in *" $1 "*|*" $1-$2 "*) kill -INT "$PPID"; exit 1 ;; esac
[ "$1" = auth ] && exit 0
[ "$1 $2" = "secrets import" ] && cat > "$FAKE_DIR/$n.stdin"
case " \${FAKE_FLY_FAIL:-} " in *" $1 "*|*" $1-$2 "*) exit 1 ;; esac
exit 0
`;
const FAKE_GIT = `#!/bin/sh
# The real git, except that a fetch never leaves the machine: it is
# recorded, FAKE_GIT_FETCH_FAIL fails it, and FAKE_GIT_FETCH_TO moves
# origin/main there, as a fetch that finds a newer main on GitHub does.
if [ "$1" = fetch ]; then
  printf '%s\\n' "$*" >> "$FAKE_DIR/git-fetch"
  if [ -n "\${FAKE_GIT_FETCH_FAIL:-}" ]; then
    echo "fatal: unable to access 'https://github.com/': Could not resolve host: github.com" >&2
    exit 128
  fi
  [ -z "\${FAKE_GIT_FETCH_TO:-}" ] || exec "$FAKE_GIT_REAL" update-ref refs/remotes/origin/main "$FAKE_GIT_FETCH_TO"
  exit 0
fi
exec "$FAKE_GIT_REAL" "$@"
`;
const FAKE_CURL = `#!/bin/sh
# Answers with FAKE_CURL_BODY, then the -w format with FAKE_CURL_STATUS as
# its http_code; FAKE_CURL_DOWN is a curl that never got an answer.
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/curl.args"
if [ -n "\${FAKE_CURL_DOWN:-}" ]; then
  echo "curl: (28) Connection timed out after 10002 milliseconds" >&2
  exit 28
fi
w=
while [ $# -gt 0 ]; do
  if [ "$1" = -w ]; then w=$2; shift; fi
  shift
done
printf '%s' "$FAKE_CURL_BODY"
printf '%s' "$w" | sed "s/%{http_code}/$FAKE_CURL_STATUS/g"
`;
const IMPORT_ARGS = ["secrets", "import", "--stage", "-a", "roybal-worker"];
const DEPLOY_ARGS = ["deploy", "-a", "roybal-worker", "--config", "services/worker/fly.toml",
  "--dockerfile", "services/worker/Dockerfile", "--ha=false", "."];
const UNSET_ARGS = ["secrets", "unset", "--stage", "-a", "roybal-worker", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"];
const UPDATE = "cd ~/roybal-restoration-app && git checkout main && git pull";
const RERUN = "cd ~/roybal-restoration-app && sh services/worker/set-gmail-secret.sh";
const NOT_STEP5 = `roybal-notify isn't on the step-5 build yet. Say "deploy roybal-notify" in the project first, then run this again.`;

function runSetGmailSecret(input, { branch = "main", git = true, behind = false, adapter, config, edit, from = "",
  shell = ["sh"], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-gmail-secret-"));
  const fakeDir = path.join(dir, "calls");
  fs.mkdirSync(fakeDir);
  fs.mkdirSync(path.join(dir, "bin"));
  for (const [name, body] of [["fly", FAKE_FLY], ["git", FAKE_GIT], ["curl", FAKE_CURL]]) {
    fs.writeFileSync(path.join(dir, "bin", name), body, { mode: 0o755 });
  }
  const root = path.join(dir, "repo");
  for (const f of CHECKOUT_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  if (adapter !== undefined) fs.writeFileSync(path.join(root, "services/worker/adapters/email.mjs"), adapter);
  if (config !== undefined) fs.writeFileSync(path.join(root, "apps/field/js/config.js"), config);
  const fakeEnv = {};
  if (git) {
    const g = (...args) => {
      const r = spawnSync(REAL_GIT, ["-c", "user.name=test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "-C", root, ...args], { env: ENV, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g("-c", "init.defaultBranch=main", "init", "-q");
    g("add", "-A");
    g("commit", "-q", "--no-verify", "-m", "main");
    // GitHub's main as of the last pull.
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    if (branch !== "main") {
      g("update-ref", `refs/heads/${branch}`, "HEAD");
      g("symbolic-ref", "HEAD", `refs/heads/${branch}`);
    }
    // A worker fix merged since: the script's own fetch is what finds it.
    if (behind) fakeEnv.FAKE_GIT_FETCH_TO = g("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "a later worker fix");
  }
  edit?.(root);
  try {
    const cwd = path.join(root, from);
    const r = spawnSync(shell[0], [...shell.slice(1), path.relative(cwd, path.join(root, "services/worker/set-gmail-secret.sh"))], {
      cwd, input, encoding: "utf8", timeout: 20000,
      env: { ...ENV, PATH: `${path.join(dir, "bin")}:${ENV.PATH}`, FAKE_DIR: fakeDir, FAKE_GIT_REAL: REAL_GIT,
        FAKE_CURL_BODY: SPINE_ANSWER, FAKE_CURL_STATUS: "200", ...fakeEnv, ...env },
    });
    const read = (name) => fs.existsSync(path.join(fakeDir, name)) ? fs.readFileSync(path.join(fakeDir, name), "utf8") : null;
    const calls = [];
    for (let n = 1; read(`${n}.args`) !== null; n++) {
      calls.push({ args: read(`${n}.args`).split("\n").filter(Boolean), cwd: read(`${n}.cwd`).trim(), stdin: read(`${n}.stdin`) });
    }
    // What changes Fly: everything but the login check and the --stage probes.
    const changes = calls.filter((c) => c.args[0] !== "auth" && !c.args.includes("--help"));
    return { status: r.status, signal: r.signal, output: `${r.stdout}${r.stderr}`, calls, changes,
      fetches: (read("git-fetch") ?? "").split("\n").filter(Boolean), curl: read("curl.args")?.split("\n").filter(Boolean) ?? null,
      root: fs.realpathSync(root) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The secret is on no command line (fly's, curl's) and never printed.
function assertSecretKept(r, secret, why = "") {
  for (const c of r.calls) {
    assert.ok(!c.args.some((a) => a.includes(secret)), `the secret is never on a command line: fly ${c.args.join(" ")} ${why}`);
  }
  assert.ok(!(r.curl ?? []).some((a) => a.includes(secret)), `nor on curl's ${why}`);
  assert.ok(!r.output.includes(secret), `the secret is never printed ${why}`);
}

test("set-gmail-secret.sh stages exactly the pair on stdin, deploys after, never shows the secret, and refuses what the worker would refuse", { skip: SKIP }, () => {
  assert.match(FIELD_CLIENT_ID ?? "", /\.apps\.googleusercontent\.com$/);
  const secret = "GOCSPX-t3st_Secret-value9";
  for (const shell of SHELLS) {
    const ok = runSetGmailSecret(`${secret}\n`, { shell });
    const on = shell.join(" ");
    assert.equal(ok.status, 0, `${on}: ${ok.output}`);
    assert.deepEqual(ok.changes.map((c) => c.args), [IMPORT_ARGS, DEPLOY_ARGS], on);
    assert.equal(ok.changes[0].stdin, `GMAIL_CLIENT_ID=${FIELD_CLIENT_ID}\nGMAIL_CLIENT_SECRET=${secret}\n`, on);
    assert.equal(ok.changes[1].cwd, ok.root, "deploys from the repo root");
    assertSecretKept(ok, "t3st_Secret", on);
    assert.deepEqual(ok.fetches, ["fetch -q origin main"], `${on}: compares with GitHub's main as of now`);
    // roybal-notify asked with no key, at the production project.
    assert.deepEqual(ok.curl, ["-sS", "--max-time", "10", "-w", "%{http_code}",
      `${FIELD_SUPABASE_URL}/functions/v1/roybal-notify/version`], on);
    assert.match(ok.output, /last step of turning email on: migration 0019 applied, roybal-notify deployed/);
    assert.match(ok.output, /worker\.start line with "email":true/);
    assert.match(ok.output, /"channels":\["sms","email"\]/);
    assert.match(ok.output, /email\.disabled/);
    assert.doesNotMatch(ok.output, /no deploy/i);
  }
  // What it staged, the worker boots with.
  const cfg = loadConfig({ SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k",
    GMAIL_CLIENT_ID: FIELD_CLIENT_ID, GMAIL_CLIENT_SECRET: secret });
  assert.equal(cfg.emailEnabled, true);
  // A local change outside what the image is built from does not matter.
  const other = runSetGmailSecret(`${secret}\n`, { edit: (r) => fs.writeFileSync(path.join(r, "notes.txt"), "x\n") });
  assert.equal(other.status, 0, other.output);
  // config.js edited on this Mac (another project, another client id): the
  // check and the pair still come from the commit, which is GitHub's main.
  const localConfig = runSetGmailSecret(`${secret}\n`, { edit: (r) => {
    const f = path.join(r, "apps/field/js/config.js");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8")
      .replace(FIELD_SUPABASE_URL, "https://stagingrefabcdef.supabase.co")
      .replace(FIELD_CLIENT_ID, "999999999999-localedit.apps.googleusercontent.com"));
  } });
  assert.equal(localConfig.status, 0, localConfig.output);
  assert.equal(localConfig.curl.at(-1), `${FIELD_SUPABASE_URL}/functions/v1/roybal-notify/version`);
  assert.equal(localConfig.changes[0].stdin, `GMAIL_CLIENT_ID=${FIELD_CLIENT_ID}\nGMAIL_CLIENT_SECRET=${secret}\n`);

  // A fly that cannot stage, or cannot take a staged pair back out: refused
  // before the secret is asked for.
  for (const cmd of ["import", "unset"]) {
    const old = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_NO_STAGE: cmd } });
    assert.notEqual(old.status, 0, cmd);
    assert.deepEqual(old.changes, [], cmd);
    assert.match(old.output, new RegExp(`fly secrets ${cmd} has no --stage`));
    assert.match(old.output, /brew upgrade flyctl/);
    assert.doesNotMatch(old.output, /Paste the client secret/);
  }

  // fly refuses the import: no deploy, and it may have landed anyway (a lost
  // answer, a config file fly could not write), so out it goes.
  const noImport = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_FAIL: "secrets-import" } });
  assert.equal(noImport.status, 1, noImport.output);
  assert.deepEqual(noImport.changes.map((c) => c.args), [IMPORT_ARGS, UNSET_ARGS]);
  assert.match(noImport.output, /fly may not have taken the pair/);
  assert.match(noImport.output, /took the staged pair back out of roybal-worker/);
  assert.doesNotMatch(noImport.output, /Deploying the worker/);
  // ...and the unset fails too (logged out, say): it may still be staged, not "STILL STAGED".
  const noImportStuck = runSetGmailSecret(`${secret}\n`, { env: { FAKE_FLY_FAIL: "secrets-import secrets-unset" } });
  assert.equal(noImportStuck.status, 1, noImportStuck.output);
  assert.deepEqual(noImportStuck.changes.map((c) => c.args), [IMPORT_ARGS, UNSET_ARGS]);
  assert.match(noImportStuck.output, /the pair may still be staged on roybal-worker/);
  assert.doesNotMatch(noImportStuck.output, /STILL STAGED/);

  for (const bad of ["", "GOCSPX-has space", "GOCSPX-\"quoted\"", "GOCSPX-'quoted'", "<its client secret>",
    "GOCSPX-<x>", "GOCSPX-abc…", "GOCSPX-PASTE_HERE", "GOCSPX-nb sp", "GOCSPX-cr\r"]) {
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

test("set-gmail-secret.sh refuses, with fly never called, a checkout that is not GitHub's latest main as it stands", { skip: SKIP }, () => {
  const secret = "GOCSPX-t3st_Secret-value9";
  const worker = (f) => (r) => path.join(r, "services/worker", f);
  for (const [why, opts] of [
    ["not a git checkout", { git: false }],
    ["another branch", { branch: "claude/some-branch" }],
    ["a main older than the 48-hour limit", { adapter: "export function emailAdapter() {}\n" }],
    ["below the repo root", { from: "services" }],
    ["behind GitHub's main", { behind: true }],
    ["GitHub not reachable", { env: { FAKE_GIT_FETCH_FAIL: "1" } }],
    ["an edited worker file", { edit: (r) => fs.appendFileSync(worker("fly.toml")(r), "\n# local edit\n") }],
    ["a new file in the worker", { edit: (r) => fs.writeFileSync(worker("scratch.mjs")(r), "export {};\n") }],
    ["an edited .dockerignore", { edit: (r) => fs.appendFileSync(path.join(r, ".dockerignore"), "services/worker/adapters\n") }],
    ["an edited field module the image copies", { edit: (r) => fs.appendFileSync(path.join(r, "apps/field/js/dryingcalc.js"), "\n// local edit\n") }],
    ["a copied field module deleted", { edit: (r) => fs.rmSync(path.join(r, "apps/field/js/reconcile.js")) }],
  ]) {
    const r = runSetGmailSecret(`${secret}\n`, opts);
    assert.equal(r.status, 1, `refused: ${why}\n${r.output}`);
    assert.deepEqual(r.calls, [], `fly not called: ${why}`);
    assert.ok(r.output.includes(UPDATE), `says to update main first: ${why}\n${r.output}`);
    assert.match(r.output, /Nothing was changed/);
    assert.doesNotMatch(r.output, /Paste the client secret/);
  }
  const behind = runSetGmailSecret(`${secret}\n`, { behind: true });
  assert.deepEqual(behind.fetches, ["fetch -q origin main"]);
  assert.match(behind.output, /not GitHub's latest main/);
  assert.match(runSetGmailSecret(`${secret}\n`, { env: { FAKE_GIT_FETCH_FAIL: "1" } }).output, /could not fetch main/);
  assert.match(runSetGmailSecret(`${secret}\n`, { edit: (r) => fs.writeFileSync(worker("x.mjs")(r), "") }).output,
    /local changes in services\/worker/);
  assert.match(runSetGmailSecret(`${secret}\n`, { edit: (r) => fs.appendFileSync(path.join(r, COPIED_FIELD[1]), "\n") }).output,
    /field modules its image copies .*git status services\/worker apps\/field\/js\/reconcile\.js/);
});

test("set-gmail-secret.sh checks every path the worker's Dockerfile copies, so no local edit rides into the deploy", () => {
  const script = fs.readFileSync(path.join(REPO, "services/worker/set-gmail-secret.sh"), "utf8");
  const listed = /^IMAGE_PATHS='([^']*)'$/m.exec(script)?.[1].split(/\s+/) ?? [];
  assert.ok(listed.includes(".dockerignore"), "the build context's filter is checked too");
  const dockerfile = fs.readFileSync(path.join(REPO, "services/worker/Dockerfile"), "utf8");
  const sources = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(.+?)\s+\S+\s*$/gm)].flatMap((m) => m[1].split(/\s+/));
  assert.deepEqual(sources, ["apps/field/js/reconcile.js", "apps/field/js/dryingcalc.js", "apps/field/js/model.js",
    "apps/field/js/core.js", "apps/field/js/scans.js", "services/worker"]);
  for (const src of sources) {
    assert.ok(listed.some((p) => src === p || src.startsWith(`${p}/`)), `IMAGE_PATHS covers ${src}`);
  }
});

test("set-gmail-secret.sh refuses, with fly never called, until roybal-notify answers a spine YES", { skip: SKIP }, () => {
  const secret = "GOCSPX-t3st_Secret-value9";
  for (const [why, status, body] of [
    ["the build before step 5", "405", '{"ok":false,"error":"Use POST"}'],
    ["answers the text lane only", "200", '{"ok":true,"function":"roybal-notify","answers":["text"]}'],
    ["answers is not a list", "200", '{"ok":true,"answers":"spine"}'],
    ["a name that only starts with spine", "200", '{"ok":true,"answers":["text","spinex"]}'],
    ["the step-5 body on an error status", "404", SPINE_ANSWER],
    ["a page that is not the function", "200", "<html>spine</html>"],
    ["an empty answer", "200", ""],
  ]) {
    const r = runSetGmailSecret(`${secret}\n`, { env: { FAKE_CURL_STATUS: status, FAKE_CURL_BODY: body } });
    assert.equal(r.status, 1, `refused: ${why}\n${r.output}`);
    assert.deepEqual(r.calls, [], `fly not called: ${why}`);
    assert.ok(r.output.includes(NOT_STEP5), `${why}\n${r.output}`);
    assert.match(r.output, /Nothing was changed/);
  }
  // No answer at all is not "an old build": it says so.
  const down = runSetGmailSecret(`${secret}\n`, { env: { FAKE_CURL_DOWN: "1" } });
  assert.equal(down.status, 1);
  assert.deepEqual(down.calls, []);
  assert.match(down.output, /could not reach https:\/\/\S+\/functions\/v1\/roybal-notify\/version/);
  assert.ok(!down.output.includes(NOT_STEP5));
  // The address must be a Supabase project's; curl is not even asked.
  const local = runSetGmailSecret(`${secret}\n`, { config: FIELD_CONFIG.replace(FIELD_SUPABASE_URL, "http://127.0.0.1:54321") });
  assert.equal(local.status, 1);
  assert.deepEqual(local.calls, []);
  assert.equal(local.curl, null);
  assert.match(local.output, /SUPABASE_URL in apps\/field\/js\/config\.js is not an https:\/\//);
  // The same answer spaced out, or in another order, is still the spine.
  for (const body of ['{\n  "ok": true,\n  "function": "roybal-notify",\n  "answers": [ "text", "spine" ]\n}\n',
    '{"answers":["spine","text"],"ok":true}']) {
    const r = runSetGmailSecret(`${secret}\n`, { env: { FAKE_CURL_BODY: body } });
    assert.equal(r.status, 0, `${JSON.stringify(body)}\n${r.output}`);
  }
});

test("set-gmail-secret.sh takes the staged pair back out when the deploy fails or the run is stopped", { skip: SKIP }, () => {
  const secret = "GOCSPX-t3st_Secret-value9";
  for (const shell of SHELLS) {
    const on = shell.join(" ");
    // The deploy fails: unset --stage, so no restart puts email on in the old image.
    const failed = runSetGmailSecret(`${secret}\n`, { shell, env: { FAKE_FLY_FAIL: "deploy" } });
    assert.equal(failed.status, 1, `${on}: ${failed.output}`);
    assert.deepEqual(failed.changes.map((c) => c.args), [IMPORT_ARGS, DEPLOY_ARGS, UNSET_ARGS], on);
    assert.match(failed.output, /the deploy did not finish/);
    assert.match(failed.output, /took the staged pair back out of roybal-worker, so no restart can turn email on in an older image/);
    // never "nothing is live": a pair from an earlier run, or a deploy that got far, can still be up
    assert.match(failed.output, /it stays on until the worker's next restart, then goes off/);
    assert.doesNotMatch(failed.output, /nothing is live/);
    assert.ok(failed.output.includes(`Run this again: ${RERUN}`), `${on}: ${failed.output}`);
    assert.doesNotMatch(failed.output, /Done\./);
    assertSecretKept(failed, "t3st_Secret", on);

    // ...and the unset fails too: it says plainly the pair is still staged and what turns it on.
    const stuck = runSetGmailSecret(`${secret}\n`, { shell, env: { FAKE_FLY_FAIL: "deploy secrets-unset" } });
    assert.equal(stuck.status, 1, `${on}: ${stuck.output}`);
    assert.deepEqual(stuck.changes.map((c) => c.args), [IMPORT_ARGS, DEPLOY_ARGS, UNSET_ARGS], on);
    assert.match(stuck.output, /STILL STAGED on roybal-worker/);
    assert.match(stuck.output, /any fly secrets set or restart of roybal-worker turns email on in the image already on Fly/);
    assert.ok(stuck.output.includes(`Run this again: ${RERUN}`), `${on}: ${stuck.output}`);
    assert.doesNotMatch(stuck.output, /took the staged pair back out/);

    // Ctrl-C during the deploy (or a closed window): the same unset, exit 130.
    const stopped = runSetGmailSecret(`${secret}\n`, { shell, env: { FAKE_FLY_STOP: "deploy" } });
    assert.equal(stopped.status, 130, `${on}: ${stopped.output}`);
    assert.deepEqual(stopped.changes.map((c) => c.args), [IMPORT_ARGS, DEPLOY_ARGS, UNSET_ARGS], on);
    assert.match(stopped.output, /stopped\./);
    assert.match(stopped.output, /took the staged pair back out of roybal-worker, so no restart can turn email on in an older image/);
    assert.ok(stopped.output.includes(RERUN), on);
    assert.doesNotMatch(stopped.output, /Done\./);
    assertSecretKept(stopped, "t3st_Secret", on);

    // Stopped while fly is taking the pair: it may have landed, so out it goes.
    const midImport = runSetGmailSecret(`${secret}\n`, { shell, env: { FAKE_FLY_STOP: "secrets-import" } });
    assert.equal(midImport.status, 130, `${on}: ${midImport.output}`);
    assert.deepEqual(midImport.changes.map((c) => c.args), [IMPORT_ARGS, UNSET_ARGS], on);
    assert.match(midImport.output, /took the staged pair back out of roybal-worker, so no restart can turn email on in an older image/);

    // Stopped before anything was staged: nothing to take out, and it says so.
    const early = runSetGmailSecret(`${secret}\n`, { shell, env: { FAKE_FLY_STOP: "auth" } });
    assert.equal(early.status, 130, `${on}: ${early.output}`);
    assert.deepEqual(early.changes, [], on);
    assert.match(early.output, /stopped\. Nothing was changed/);
  }
});
