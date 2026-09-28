#!/usr/bin/env node
// ============================================================================
// tools/xact-ref/load.mjs — load the owner's past-Xactimate reference file
// into xact_ref_prices / xact_ref_lines (migration 0011).
//
//   node tools/xact-ref/load.mjs <path-to-json> [--dry-run]
//
// The JSON file lives OUTSIDE this repository and never enters it: the repo
// is public, and the file holds real estimate lines and prices. This script
// reads it, checks it, and sends it to one owner-only RPC,
// xact_ref_reload(p_prices, p_lines), which replaces both tables whole.
//
//   --dry-run   check the file and print the counts; no login, nothing sent.
//
// Where it sends: SUPABASE_URL and the publishable key from
// apps/field/js/config.js (production). XACT_REF_URL and XACT_REF_KEY in the
// environment point it somewhere else — staging, say. The target host is
// printed, and you confirm, before anything is asked for or sent.
//
// Who can load: only the owner. It signs in with your email and a password
// typed at a hidden prompt (nothing echoed), calls the RPC under that login,
// then signs the session out. It never prints the password or the token.
//
// What is sent: only the columns the two tables have. Any other key in the
// file stays on this machine, and a row carrying a key that looks like a
// customer, address or claim field stops the load outright.
//
// Node 22, no dependencies.
// ============================================================================

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The activity vocabulary of the reference file; '' = not recorded.
export const ACTIVITIES = ["Replace", "Remove", "R&R", "D&R", "Reset", "Material only", "Labor only", ""];

// Column name → kind, exactly the columns of the two tables that the file
// supplies (id and loaded_at take their defaults). The payload is projected
// onto these lists, so nothing else in the file ever leaves the machine.
export const PRICE_FIELDS = {
  category: "key", code: "key", activity: "activity", unit: "unit",
  description: "text", n_lines: "int", n_estimates: "int",
  median: "money", min: "money", max: "money", latest_median: "money",
  latest_price_list: "text", price_lists: "textArray", job_types: "textArray",
  first_date: "date", last_date: "date",
};

export const LINE_FIELDS = {
  estimate_id: "id", job_type: "text", loss_type: "text", est_date: "date",
  room: "text", line_no: "int", category: "key", code: "key",
  description: "text", activity: "activity", unit: "unit",
  qty: "number", unit_cost: "money", remove_price: "money",
  replace_price: "money", line_total: "money", price_list: "text", note: "text",
};

// Keys that would put a person, a place or a claim into the tables. A row
// carrying one stops the load: the reference is prices and scope, never who.
export const FORBIDDEN_KEY = /customer|client|insured|homeowner|owner_name|policy|claim|address|street|city|zip|postal|phone|email|contact/i;

// numeric(12,2) holds at most 9999999999.99. Postgres rounds a value to two
// places (half away from zero) before it checks that, so 9999999999.995 comes
// in as 10000000000.00 and overflows: compare the value as Postgres will
// store it, not as sent.
const MONEY_MAX = 9999999999.99;
const moneyInRange = (v) => Math.round(Math.abs(v) * 100) / 100 <= MONEY_MAX;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const blank = (v) => v === null || v === undefined;

function isDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// One field's problem, or null. Messages name the field, never a forbidden
// key's value.
function checkField(kind, name, v) {
  switch (kind) {
    case "key":
      if (typeof v !== "string" || !v.trim()) return `missing ${name}`;
      return null;
    case "id":
      if (typeof v !== "string" || !v.trim()) return `missing ${name}`;
      return null;
    case "activity":
      if (blank(v)) return null;
      if (typeof v !== "string" || !ACTIVITIES.includes(v.trim())) {
        return `${name} ${JSON.stringify(v)} is not one of ${ACTIVITIES.map((a) => JSON.stringify(a)).join(", ")}`;
      }
      return null;
    case "unit":
    case "text":
      if (blank(v) || typeof v === "string") return null;
      return `${name} is not text`;
    case "int":
      if (blank(v) || Number.isInteger(v)) return null;
      return `${name} is not a whole number`;
    case "number":
      if (blank(v) || isNum(v)) return null;
      return `${name} is not a number`;
    case "money":
      if (blank(v)) return null;
      if (!isNum(v)) return `${name} is not a number`;
      if (!moneyInRange(v)) return `${name} is out of range`;
      return null;
    case "date":
      if (blank(v) || v === "") return null;
      if (typeof v !== "string" || !isDate(v)) return `${name} is not a YYYY-MM-DD date`;
      return null;
    case "textArray":
      if (blank(v)) return null;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return `${name} is not a list of text`;
      return null;
    default:
      return `${name}: unknown kind ${kind}`;
  }
}

function checkRows(rows, label, fields, errors, warnings) {
  const unknown = new Set();
  rows.forEach((row, i) => {
    const at = `${label}[${i}]`;
    if (!isObj(row)) {
      errors.push(`${at}: not an object`);
      return;
    }
    for (const k of Object.keys(row)) {
      if (FORBIDDEN_KEY.test(k)) {
        errors.push(`${at}: carries a "${k}" field — the reference holds no customer, address or claim data; strip it from the file`);
      } else if (!(k in fields)) {
        unknown.add(k);
      }
    }
    for (const [name, kind] of Object.entries(fields)) {
      const problem = checkField(kind, name, row[name]);
      if (problem) errors.push(`${at}: ${problem}`);
    }
  });
  if (unknown.size) {
    warnings.push(`${label}: ignoring field(s) the table does not have: ${[...unknown].sort().join(", ")}`);
  }
}

/**
 * Check a reference file before anything is sent. Pure.
 * @returns {{ok: boolean, errors: string[], warnings: string[],
 *            counts: {prices: number, lines: number, estimates: number, categories: number}}}
 */
export function validate(data) {
  const errors = [];
  const warnings = [];
  const counts = { prices: 0, lines: 0, estimates: 0, categories: 0 };

  if (!isObj(data)) {
    return { ok: false, errors: ["the file is not a JSON object"], warnings, counts };
  }
  const { prices, lines } = data;
  if (!Array.isArray(prices)) errors.push('"prices" is missing or not a list');
  if (!Array.isArray(lines)) errors.push('"lines" is missing or not a list');
  if (errors.length) return { ok: false, errors, warnings, counts };

  if (prices.length === 0) {
    errors.push('"prices" is empty — a reload replaces the table whole, so this would erase the reference (drop the table instead if that is the intent)');
  }
  if (lines.length === 0) warnings.push('"lines" is empty — the price rows will load with no lines behind them');

  checkRows(prices, "prices", PRICE_FIELDS, errors, warnings);
  checkRows(lines, "lines", LINE_FIELDS, errors, warnings);

  // The table's primary key, as the database will see it after toPayload().
  const seen = new Map();
  prices.forEach((row, i) => {
    // A row missing its category or code already has an error of its own.
    if (!isObj(row) || checkField("key", "category", row.category) || checkField("key", "code", row.code)) return;
    const k = [row.category, row.code, row.activity ?? "", row.unit ?? ""]
      .map((v) => (typeof v === "string" ? v.trim() : String(v))).join("\u0000");
    if (seen.has(k)) errors.push(`prices[${i}]: same category/code/activity/unit as prices[${seen.get(k)}]`);
    else seen.set(k, i);
  });

  counts.prices = prices.length;
  counts.lines = lines.length;
  counts.estimates = new Set(lines.filter(isObj).map((l) => l.estimate_id).filter((v) => typeof v === "string" && v)).size;
  counts.categories = new Set(prices.filter(isObj).map((p) => p.category).filter((v) => typeof v === "string" && v)).size;

  return { ok: errors.length === 0, errors, warnings, counts };
}

function project(row, fields, isPrice) {
  const out = {};
  for (const [name, kind] of Object.entries(fields)) {
    let v = row[name];
    if (v === undefined) v = null;
    if (kind === "date" && v === "") v = null;
    if ((kind === "key" || kind === "activity" || kind === "unit") && typeof v === "string") v = v.trim();
    // activity and unit are part of the prices primary key: never null there.
    if (isPrice && (kind === "activity" || kind === "unit") && v === null) v = "";
    out[name] = v;
  }
  return out;
}

/**
 * The RPC body: only the tables' columns, dates '' → null, prices'
 * activity/unit never null. Call validate() first. Pure.
 */
export function toPayload(data) {
  return {
    p_prices: data.prices.map((r) => project(r, PRICE_FIELDS, true)),
    p_lines: data.lines.map((r) => project(r, LINE_FIELDS, false)),
  };
}

/** argv (without node and the script) → {file, dryRun, help} or {error}. */
export function parseCliArgs(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
    });
    if (values.help) return { help: true };
    if (positionals.length !== 1) return { error: "give exactly one JSON file" };
    return { file: positionals[0], dryRun: values["dry-run"] };
  } catch (e) {
    return { error: e.message };
  }
}

/** A readable reason for a failed RPC, from PostgREST's status and body. */
export function rpcFailure(status, body) {
  const code = body && body.code;
  const msg = (body && (body.message || body.msg || body.error)) || "";
  if (status === 404 || code === "PGRST202" || code === "42883") {
    return "xact_ref_reload is not on this database — migration 0011 has not been applied there yet.";
  }
  if (code === "42501" || status === 403) {
    return "only the owner can load the Xactimate reference, and this login is not the owner.";
  }
  if (status === 401) return "the database refused the login token (401). Sign in again.";
  return `the load failed (HTTP ${status}${code ? `, ${code}` : ""})${msg ? `: ${msg}` : ""}. Nothing was changed: the reload is one transaction.`;
}

const USAGE = `usage: node tools/xact-ref/load.mjs <path-to-json> [--dry-run]

  Loads the owner's past-Xactimate reference file into xact_ref_prices and
  xact_ref_lines, replacing what is there. Owner login only.

  --dry-run   check the file and print the counts; no login, nothing sent.

  Targets SUPABASE_URL from apps/field/js/config.js unless XACT_REF_URL and
  XACT_REF_KEY are set.`;

async function readConfig(env) {
  if (env.XACT_REF_URL || env.XACT_REF_KEY) {
    if (!env.XACT_REF_URL || !env.XACT_REF_KEY) throw new Error("set both XACT_REF_URL and XACT_REF_KEY, or neither");
    return { url: env.XACT_REF_URL.replace(/\/+$/, ""), key: env.XACT_REF_KEY };
  }
  const cfg = await import(new URL("../../apps/field/js/config.js", import.meta.url).href);
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) throw new Error("apps/field/js/config.js has no SUPABASE_URL / SUPABASE_KEY");
  return { url: String(cfg.SUPABASE_URL).replace(/\/+$/, ""), key: cfg.SUPABASE_KEY };
}

async function jsonOf(res) {
  const text = await res.text().catch(() => "");
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/**
 * The whole run, with its edges injected so the test can drive it:
 *   io: {log, error, isTTY, ask(question) → string, askHidden(question) → string}
 *   fetchImpl: fetch; env: process.env-like; readText(path) → string
 * Returns the exit code.
 */
export async function run(argv, { io, fetchImpl = fetch, env = {}, readText = (p) => readFile(p, "utf8") }) {
  const args = parseCliArgs(argv);
  if (args.help) { io.log(USAGE); return 0; }
  if (args.error) { io.error(`${args.error}\n\n${USAGE}`); return 2; }

  let data;
  try {
    data = JSON.parse(await readText(args.file));
  } catch (e) {
    io.error(`cannot read ${args.file}: ${e.message}`);
    return 1;
  }

  const v = validate(data);
  io.log(`${v.counts.prices} price row(s) in ${v.counts.categories} categor${v.counts.categories === 1 ? "y" : "ies"}; ${v.counts.lines} line(s) from ${v.counts.estimates} estimate(s).`);
  for (const w of v.warnings) io.log(`warning: ${w}`);
  if (!v.ok) {
    const shown = v.errors.slice(0, 50);
    for (const e of shown) io.error(`error: ${e}`);
    if (v.errors.length > shown.length) io.error(`… and ${v.errors.length - shown.length} more`);
    io.error(`${v.errors.length} problem(s) in the file. Nothing was sent.`);
    return 1;
  }
  if (args.dryRun) {
    io.log("dry run: the file checks out. Nothing was sent.");
    return 0;
  }

  let target;
  try {
    target = await readConfig(env);
  } catch (e) {
    io.error(e.message);
    return 1;
  }
  const host = new URL(target.url).host;
  if (!io.isTTY) {
    io.error("run this from a terminal: it asks for your password at a hidden prompt.");
    return 1;
  }

  const answer = await io.ask(`Replace the Xactimate reference on ${host} with ${v.counts.prices} price row(s) and ${v.counts.lines} line(s)? [y/N] `);
  if (!/^y(es)?$/i.test(String(answer).trim())) {
    io.log("Nothing was sent.");
    return 1;
  }
  const email = String(await io.ask("Owner email: ")).trim();
  if (!email) { io.error("no email given. Nothing was sent."); return 1; }
  let password = await io.askHidden("Password (hidden): ");
  if (!password) { io.error("no password given. Nothing was sent."); return 1; }

  const timeout = () => AbortSignal.timeout(120_000);
  let token = null;
  try {
    const res = await fetchImpl(`${target.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: target.key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: timeout(),
    });
    password = null;
    const body = await jsonOf(res);
    if (!res.ok || !body.access_token) {
      io.error(`sign-in failed: ${body.error_description || body.msg || body.error || `HTTP ${res.status}`}. Nothing was sent.`);
      return 1;
    }
    token = body.access_token;
  } catch (e) {
    io.error(`sign-in failed: ${e.message}. Nothing was sent.`);
    return 1;
  } finally {
    password = null;
  }

  const auth = { apikey: target.key, Authorization: `Bearer ${token}` };
  try {
    const payload = toPayload(data);
    io.log(`Loading into ${host}…`);
    let res;
    try {
      res = await fetchImpl(`${target.url}/rest/v1/rpc/xact_ref_reload`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: timeout(),
      });
    } catch (e) {
      io.error(`the load did not reach the database: ${e.message}. If it did arrive it either landed whole or not at all.`);
      return 1;
    }
    const body = await jsonOf(res);
    if (!res.ok) {
      io.error(rpcFailure(res.status, body));
      return 1;
    }
    if (body.prices !== payload.p_prices.length || body.lines !== payload.p_lines.length) {
      io.error(`the database reports ${body.prices} price row(s) and ${body.lines} line(s); ${payload.p_prices.length} and ${payload.p_lines.length} were sent.`);
      return 1;
    }
    io.log(`Loaded ${body.prices} price row(s) and ${body.lines} line(s) into ${host}. The previous reference was replaced.`);
    return 0;
  } finally {
    // End the session this run opened; best effort, never fatal.
    try {
      await fetchImpl(`${target.url}/auth/v1/logout?scope=local`, { method: "POST", headers: auth, signal: timeout() });
    } catch { /* the access token expires on its own */ }
    token = null;
  }
}

// ---- terminal edges ---------------------------------------------------------

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Reads a line with the terminal in raw mode and echoes nothing.
function askHidden(question) {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { done(); resolve(buf); return; }
        if (ch === "\u0003") { done(); reject(new Error("cancelled")); return; }
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch >= " ") buf += ch;
      }
    };
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const io = {
    log: (s) => console.log(s),
    error: (s) => console.error(s),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask,
    askHidden,
  };
  try {
    process.exitCode = await run(process.argv.slice(2), { io, env: process.env });
  } catch (e) {
    console.error(e && e.message === "cancelled" ? "cancelled. Nothing was sent." : `failed: ${e && e.message}`);
    process.exitCode = e && e.message === "cancelled" ? 130 : 1;
  }
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
