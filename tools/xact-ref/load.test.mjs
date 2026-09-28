// Tests for tools/xact-ref/load.mjs — the owner's past-Xactimate reference
// loader. SYNTHETIC DATA ONLY: the repo is public, so every category, code,
// description and price here is invented (TST / ZZZ, TST1 / ZZZ9).
//
//   node --test tools/xact-ref/load.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validate, toPayload, parseCliArgs, rpcFailure, run,
  PRICE_FIELDS, LINE_FIELDS, FORBIDDEN_KEY, ACTIVITIES,
} from "./load.mjs";

const price = (over = {}) => ({
  category: "TST", code: "TST1", activity: "Replace", unit: "SF",
  description: "test item one", n_lines: 3, n_estimates: 2,
  median: 1.25, min: 1.0, max: 1.5, latest_median: 1.4,
  latest_price_list: "TESTLIST_JAN26", price_lists: ["TESTLIST_JAN26"], job_types: ["restoration"],
  first_date: "2026-01-02", last_date: "2026-02-03",
  ...over,
});

const line = (over = {}) => ({
  estimate_id: "T-1", job_type: "restoration", loss_type: "water", est_date: "2026-01-02",
  room: "Test Room", line_no: 1, category: "TST", code: "TST1", description: "test item one",
  activity: "Replace", unit: "SF", qty: 12.5, unit_cost: 1.25, remove_price: null,
  replace_price: null, line_total: 15.63, price_list: "TESTLIST_JAN26", note: null,
  ...over,
});

const file = (prices, lines) => ({ source: "synthetic", built: "2026-01-01", estimates: 1, prices, lines });

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

test("a clean synthetic file validates, with counts", () => {
  const v = validate(file(
    [price(), price({ category: "ZZZ", code: "ZZZ9", activity: "", unit: "EA", latest_price_list: null })],
    [line(), line({ line_no: 2 }), line({ estimate_id: "T-2", category: "ZZZ", code: "ZZZ9", activity: "", room: null })],
  ));
  assert.equal(v.ok, true, v.errors.join("\n"));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.counts, { prices: 2, lines: 3, estimates: 2, categories: 2 });
});

test("every activity in the vocabulary is accepted, and null means not recorded", () => {
  const prices = ACTIVITIES.map((a, i) => price({ code: `TST${i}`, activity: a }));
  prices.push(price({ code: "TSTN", activity: null }));
  assert.equal(validate(file(prices, [line()])).ok, true);
});

test("the file must be an object with prices and lines lists", () => {
  for (const bad of [null, [], "text", 7]) {
    const v = validate(bad);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /not a JSON object/);
  }
  const v = validate({ prices: {}, lines: "x" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /"prices" is missing or not a list/.test(e)));
  assert.ok(v.errors.some((e) => /"lines" is missing or not a list/.test(e)));
});

test("an empty prices list is refused (a reload would erase the reference)", () => {
  const v = validate(file([], [line()]));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /"prices" is empty/);
});

test("an empty lines list is allowed, with a warning", () => {
  const v = validate(file([price()], []));
  assert.equal(v.ok, true);
  assert.match(v.warnings.join("\n"), /"lines" is empty/);
});

test("rows missing category or code are rejected — prices and lines alike", () => {
  const v = validate(file(
    [price({ category: undefined }), price({ code: "" }), price({ code: "   " })],
    [line({ category: null }), line({ code: undefined })],
  ));
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, [
    "prices[0]: missing category",
    "prices[1]: missing code",
    "prices[2]: missing code",
    "lines[0]: missing category",
    "lines[1]: missing code",
  ]);
});

test("a line with no estimate_id is rejected", () => {
  const v = validate(file([price()], [line({ estimate_id: "" })]));
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, ["lines[0]: missing estimate_id"]);
});

test("non-numeric prices are rejected", () => {
  const v = validate(file(
    [price({ median: "1.25" }), price({ code: "TST2", min: Number.NaN }), price({ code: "TST3", latest_median: Infinity }), price({ code: "TST4", max: true })],
    [line({ unit_cost: "abc" }), line({ line_total: {} }), line({ remove_price: [] }), line({ qty: "2" })],
  ));
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, [
    "prices[0]: median is not a number",
    "prices[1]: min is not a number",
    "prices[2]: latest_median is not a number",
    "prices[3]: max is not a number",
    "lines[0]: unit_cost is not a number",
    "lines[1]: line_total is not a number",
    "lines[2]: remove_price is not a number",
    "lines[3]: qty is not a number",
  ]);
});

test("null prices are allowed; out-of-range prices are not", () => {
  assert.equal(validate(file([price({ median: null, min: null, max: null, latest_median: null })], [line({ unit_cost: null })])).ok, true);
  const v = validate(file([price({ median: 1e10 })], [line()]));
  assert.deepEqual(v.errors, ["prices[0]: median is out of range"]);
});

test("the money bound is numeric(12,2) after Postgres rounds to two places", () => {
  // these round to 10000000000.00 in Postgres and would overflow the column
  for (const v of [9999999999.996, 9999999999.995, -9999999999.996, -9999999999.995]) {
    const r = validate(file([price({ median: v })], [line({ line_total: v })]));
    assert.equal(r.ok, false, String(v));
    assert.deepEqual(r.errors, ["prices[0]: median is out of range", "lines[0]: line_total is out of range"], String(v));
  }
  // the largest storable values (and ones that round down to them) load
  for (const v of [9999999999.99, 9999999999.994, -9999999999.99, -9999999999.994, 0, 0.004]) {
    assert.equal(validate(file([price({ median: v })], [line({ line_total: v })])).ok, true, String(v));
  }
});

test("counts must be whole numbers", () => {
  const v = validate(file([price({ n_lines: 2.5 }), price({ code: "TST2", n_estimates: "3" })], [line({ line_no: 1.5 })]));
  assert.deepEqual(v.errors, [
    "prices[0]: n_lines is not a whole number",
    "prices[1]: n_estimates is not a whole number",
    "lines[0]: line_no is not a whole number",
  ]);
});

test("dates must be YYYY-MM-DD real days; '' and null mean none", () => {
  assert.equal(validate(file([price({ first_date: "", last_date: null })], [line({ est_date: "" })])).ok, true);
  const v = validate(file(
    [price({ first_date: "01/02/2026" }), price({ code: "TST2", last_date: "2026-02-30" })],
    [line({ est_date: 20260102 })],
  ));
  assert.deepEqual(v.errors, [
    "prices[0]: first_date is not a YYYY-MM-DD date",
    "prices[1]: last_date is not a YYYY-MM-DD date",
    "lines[0]: est_date is not a YYYY-MM-DD date",
  ]);
});

test("an activity outside the vocabulary is rejected", () => {
  const v = validate(file([price({ activity: "Install" })], [line({ activity: "replace" })]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /^prices\[0\]: activity "Install" is not one of/);
  assert.match(v.errors[1], /^lines\[0\]: activity "replace" is not one of/);
});

test("text and list fields must have the right type", () => {
  const v = validate(file([price({ description: 5, price_lists: "TESTLIST", job_types: [1] })], [line({ room: {} })]));
  assert.deepEqual(v.errors, [
    "prices[0]: description is not text",
    "prices[0]: price_lists is not a list of text",
    "prices[0]: job_types is not a list of text",
    "lines[0]: room is not text",
  ]);
});

test("a line carrying a customer, address or claim field stops the load", () => {
  for (const key of ["customer", "customer_name", "address", "insured_address", "claim", "claim_number", "Claim_No", "phone", "email", "policy_number", "homeowner", "client"]) {
    const v = validate(file([price()], [line({ [key]: "SECRET-VALUE" })]));
    assert.equal(v.ok, false, `${key} was accepted`);
    assert.equal(v.errors.length, 1);
    assert.match(v.errors[0], new RegExp(`^lines\\[0\\]: carries a "${key}" field`));
    assert.ok(!v.errors[0].includes("SECRET-VALUE"), "the error must not repeat the value");
  }
});

test("a price row carrying one is stopped too", () => {
  const v = validate(file([price({ customer: "x" })], [line()]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /^prices\[0\]: carries a "customer" field/);
});

test("no real column name trips the forbidden-key rule", () => {
  for (const k of [...Object.keys(PRICE_FIELDS), ...Object.keys(LINE_FIELDS)]) {
    assert.ok(!FORBIDDEN_KEY.test(k), `${k} matches FORBIDDEN_KEY`);
  }
});

test("unknown harmless keys are a warning, not an error", () => {
  const v = validate(file([price({ extra_stat: 1 })], [line({ page: 3 })]));
  assert.equal(v.ok, true);
  assert.match(v.warnings.join("\n"), /prices: ignoring field\(s\) the table does not have: extra_stat/);
  assert.match(v.warnings.join("\n"), /lines: ignoring field\(s\) the table does not have: page/);
});

test("duplicate price keys are rejected, counting null activity/unit as ''", () => {
  const v = validate(file(
    [price(), price({ median: 9 }), price({ code: "ZZZ9", activity: "", unit: "" }), price({ code: "ZZZ9", activity: null, unit: null })],
    [line()],
  ));
  assert.deepEqual(v.errors, [
    "prices[1]: same category/code/activity/unit as prices[0]",
    "prices[3]: same category/code/activity/unit as prices[2]",
  ]);
});

test("a non-object row is rejected", () => {
  const v = validate(file([price(), "TST1"], [null]));
  assert.deepEqual(v.errors, ["prices[1]: not an object", "lines[0]: not an object"]);
});

// ---------------------------------------------------------------------------
// toPayload()
// ---------------------------------------------------------------------------

test("the payload carries only the tables' columns, and normalizes blanks", () => {
  const data = file(
    [price({ activity: null, unit: undefined, first_date: "", extra_stat: 1, code: " TST1 " })],
    [line({ est_date: "", page: 3, activity: undefined })],
  );
  const p = toPayload(data);
  assert.deepEqual(Object.keys(p), ["p_prices", "p_lines"]);
  assert.deepEqual(Object.keys(p.p_prices[0]), Object.keys(PRICE_FIELDS));
  assert.deepEqual(Object.keys(p.p_lines[0]), Object.keys(LINE_FIELDS));
  assert.equal(p.p_prices[0].code, "TST1");
  assert.equal(p.p_prices[0].activity, "");
  assert.equal(p.p_prices[0].unit, "");
  assert.equal(p.p_prices[0].first_date, null);
  assert.equal(p.p_lines[0].est_date, null);
  assert.equal(p.p_lines[0].activity, null);
  assert.ok(!("extra_stat" in p.p_prices[0]));
  assert.ok(!("page" in p.p_lines[0]));
  // the top-level metadata never travels
  assert.ok(!JSON.stringify(p).includes("synthetic"));
});

// ---------------------------------------------------------------------------
// CLI pieces
// ---------------------------------------------------------------------------

test("argument parsing", () => {
  assert.deepEqual(parseCliArgs(["ref.json"]), { file: "ref.json", dryRun: false });
  assert.deepEqual(parseCliArgs(["ref.json", "--dry-run"]), { file: "ref.json", dryRun: true });
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.ok(parseCliArgs([]).error);
  assert.ok(parseCliArgs(["a.json", "b.json"]).error);
  assert.ok(parseCliArgs(["a.json", "--nope"]).error);
});

test("RPC failures read as plain reasons", () => {
  assert.match(rpcFailure(404, { code: "PGRST202" }), /migration 0011 has not been applied/);
  assert.match(rpcFailure(403, { code: "42501", message: "only the owner can load the Xactimate reference" }), /only the owner/);
  assert.match(rpcFailure(400, { code: "23502", message: "null value" }), /HTTP 400, 23502\): null value/);
});

// ---------------------------------------------------------------------------
// run(): the whole flow with fake edges
// ---------------------------------------------------------------------------

const PASSWORD = "synthetic-pass-9f3b";
const TOKEN = "synthetic-token-7c1d";

function harness({ tty = true, answers = ["y", "owner@example.invalid"], rpc = null } = {}) {
  const out = [];
  const calls = [];
  const queue = [...answers];
  const io = {
    log: (s) => out.push(s),
    error: (s) => out.push(s),
    isTTY: tty,
    ask: async () => queue.shift() ?? "",
    askHidden: async () => PASSWORD,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    if (url.includes("/auth/v1/token")) return reply(200, { access_token: TOKEN, refresh_token: "r", expires_in: 3600 });
    if (url.includes("/rest/v1/rpc/xact_ref_reload")) {
      if (rpc) return reply(rpc.status, rpc.body);
      const body = JSON.parse(init.body);
      return reply(200, { prices: body.p_prices.length, lines: body.p_lines.length });
    }
    if (url.includes("/auth/v1/logout")) return reply(204, {});
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = { XACT_REF_URL: "https://example.invalid/", XACT_REF_KEY: "sb_publishable_synthetic" };
  const text = JSON.stringify(file([price(), price({ code: "TST2", activity: "Remove" })], [line()]));
  return { out, calls, io, fetchImpl, env, readText: async () => text };
}

test("--dry-run prints counts and never logs in", async () => {
  const h = harness();
  const code = await run(["ref.json", "--dry-run"], h);
  assert.equal(code, 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.out.join("\n"), /2 price row\(s\) in 1 category; 1 line\(s\) from 1 estimate\(s\)/);
  assert.match(h.out.join("\n"), /dry run/);
});

test("a bad file sends nothing", async () => {
  const h = harness();
  h.readText = async () => JSON.stringify(file([price({ median: "x" })], [line()]));
  assert.equal(await run(["ref.json"], h), 1);
  assert.equal(h.calls.length, 0);
});

test("without a terminal it refuses rather than read a password from a pipe", async () => {
  const h = harness({ tty: false });
  assert.equal(await run(["ref.json"], h), 1);
  assert.equal(h.calls.length, 0);
});

test("declining the confirmation sends nothing", async () => {
  const h = harness({ answers: ["n"] });
  assert.equal(await run(["ref.json"], h), 1);
  assert.equal(h.calls.length, 0);
});

test("a full load: password grant, RPC under the user token, sign-out — and no secret printed", async () => {
  const h = harness();
  const code = await run(["ref.json"], h);
  assert.equal(code, 0, h.out.join("\n"));
  assert.deepEqual(h.calls.map((c) => new URL(c.url).pathname), ["/auth/v1/token", "/rest/v1/rpc/xact_ref_reload", "/auth/v1/logout"]);

  const [signIn, rpc] = h.calls;
  assert.equal(new URL(signIn.url).searchParams.get("grant_type"), "password");
  assert.deepEqual(JSON.parse(signIn.init.body), { email: "owner@example.invalid", password: PASSWORD });
  assert.equal(rpc.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(rpc.init.headers.apikey, "sb_publishable_synthetic");
  const body = JSON.parse(rpc.init.body);
  assert.deepEqual(Object.keys(body), ["p_prices", "p_lines"]);
  assert.equal(body.p_prices.length, 2);
  assert.equal(body.p_lines.length, 1);

  const printed = h.out.join("\n");
  assert.ok(!printed.includes(PASSWORD), "the password was printed");
  assert.ok(!printed.includes(TOKEN), "the token was printed");
  assert.match(printed, /Loaded 2 price row\(s\) and 1 line\(s\) into example\.invalid/);
});

test("a non-owner login gets the owner-only reason, still signs out, prints no secret", async () => {
  const h = harness({ rpc: { status: 403, body: { code: "42501", message: "only the owner can load the Xactimate reference" } } });
  assert.equal(await run(["ref.json"], h), 1);
  assert.match(h.out.join("\n"), /only the owner can load/);
  assert.equal(new URL(h.calls.at(-1).url).pathname, "/auth/v1/logout");
  assert.ok(!h.out.join("\n").includes(PASSWORD));
  assert.ok(!h.out.join("\n").includes(TOKEN));
});

test("a database without migration 0011 says so", async () => {
  const h = harness({ rpc: { status: 404, body: { code: "PGRST202", message: "Could not find the function" } } });
  assert.equal(await run(["ref.json"], h), 1);
  assert.match(h.out.join("\n"), /migration 0011 has not been applied/);
});
