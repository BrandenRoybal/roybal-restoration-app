/* The worker image holds every file the worker can import.

   The image is built from the repo root (services/worker/Dockerfile), with
   the root .dockerignore picking the build context: apps/field is left out
   except for the modules the worker imports, each also named on its own
   COPY line. A module added to an import without both is a worker that
   boots on a laptop and dies on Fly (or, behind a lazy import, a queue kind
   that fails every run), so this walks the imports instead of trusting a
   list.

   The walk starts at server.mjs and at every lanes/*.mjs and packet/*.mjs,
   follows static imports, export … from and string-literal import(…), and
   checks each file it reaches against the Dockerfile's COPY lines (where
   the file lands in the image) and the .dockerignore rules (whether it is
   in the build context at all). Both parsers cover the syntax those two
   files use and refuse what they do not understand, rather than guess. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKER = "services/worker";
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const relOf = (abs) => path.relative(REPO, abs).split(path.sep).join("/");
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
const isDir = (abs) => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } };

/* ---------- import specifiers ---------- */

const KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
  "yield", "await", "instanceof"]);

/* The source as tokens: words, string literals (with their value),
   template literals (a value only when they hold no ${…}), regex
   literals, and single punctuation characters. Comments and whitespace
   are dropped, so a commented-out import is not followed, and an import
   written inside a string, a template or a regex is not mistaken for one.
   A "/" starts a regex after an operator, an opening bracket, a keyword or
   at the start, and is a division anywhere else. */
function tokenize(src) {
  const out = [];
  const exprs = [];          // brace depth inside each open ${ … } of a template
  const n = src.length;
  let i = 0;
  const last = () => out[out.length - 1];
  const regexOk = () => {
    const t = last();
    if (!t) return true;
    if (t.t === "punct") return /^[(,=:[!&|?{};+\-*%<>~^]$/.test(t.v);
    return t.t === "word" && KEYWORDS.has(t.v);
  };
  // a template from i (just past a backtick or the } closing an expression)
  const template = (head) => {
    let text = "";
    for (let j = i; j < n;) {
      if (src[j] === "\\") { text += src.slice(j, j + 2); j += 2; continue; }
      if (src[j] === "`") { out.push({ t: "tpl", v: head ? text : null }); i = j + 1; return; }
      if (src[j] === "$" && src[j + 1] === "{") { out.push({ t: "tpl", v: null }); exprs.push(0); i = j + 2; return; }
      text += src[j];
      j += 1;
    }
    out.push({ t: "tpl", v: null });
    i = n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") { v += src[j + 1] ?? ""; j += 2; continue; }
        v += src[j];
        j += 1;
      }
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (c === "`") { i += 1; template(true); continue; }
    if (c === "/" && regexOk()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (cls) { if (src[j] === "]") cls = false; } else if (src[j] === "[") cls = true; else if (src[j] === "/") break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(src[j])) j += 1;
      out.push({ t: "re" });
      i = j;
      continue;
    }
    if (exprs.length && c === "}" && exprs[exprs.length - 1] === 0) { exprs.pop(); i += 1; template(false); continue; }
    if (exprs.length && c === "{") exprs[exprs.length - 1] += 1;
    if (exprs.length && c === "}") exprs[exprs.length - 1] -= 1;
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      out.push({ t: "word", v: src.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ t: "punct", v: c });
    i += 1;
  }
  return out;
}

/** Every module specifier in a source: [{spec, dynamic}]. */
function importSpecifiers(src) {
  const toks = tokenize(src);
  const out = [];
  const is = (k, t, v) => toks[k] && toks[k].t === t && (v === undefined || toks[k].v === v);
  const literal = (k) => (is(k, "str") || (is(k, "tpl") && toks[k].v !== null) ? toks[k].v : null);
  // import … from "x" / export … from "x": skip the clause to its `from`
  const fromAfter = (k) => {
    for (; k < toks.length; k++) {
      if (is(k, "word", "from")) return literal(k + 1);
      if (!(is(k, "word") || is(k, "punct", "*") || is(k, "punct", "{") || is(k, "punct", "}") || is(k, "punct", ","))) return null;
    }
    return null;
  };
  for (let k = 0; k < toks.length; k++) {
    if (is(k - 1, "punct", ".")) continue;                    // x.import, not a keyword
    if (is(k, "word", "import")) {
      if (is(k + 1, "punct", "(")) {
        const spec = literal(k + 2);
        if (spec !== null && (is(k + 3, "punct", ")") || is(k + 3, "punct", ","))) out.push({ spec, dynamic: true });
      } else if (is(k + 1, "str")) {
        out.push({ spec: toks[k + 1].v, dynamic: false });
      } else if (!is(k + 1, "punct", ".")) {
        const spec = fromAfter(k + 1);
        if (spec !== null) out.push({ spec, dynamic: false });
      }
    } else if (is(k, "word", "export") && (is(k + 1, "punct", "*") || is(k + 1, "punct", "{"))) {
      const spec = fromAfter(k + 1);
      if (spec !== null) out.push({ spec, dynamic: false });
    }
  }
  return out;
}

const BUILTIN = new Set(builtinModules);

/** The files reached from `entries` (repo-relative paths). `dynamic: false`
    follows static edges only. Missing files are reported, never thrown. */
function walk(entries, { dynamic = true } = {}) {
  const reached = new Map();       // rel → the file that first imported it (null for an entry)
  const missing = [];
  const bare = [];
  const queue = [];
  for (const rel of entries) { reached.set(rel, null); queue.push(rel); }
  while (queue.length) {
    const from = queue.shift();
    let src;
    try { src = read(from); } catch { continue; }
    for (const { spec, dynamic: isDynamic } of importSpecifiers(src)) {
      if (isDynamic && !dynamic) continue;
      if (spec.startsWith("node:") || BUILTIN.has(spec)) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) { bare.push(`${spec} (imported by ${from})`); continue; }
      const abs = path.resolve(REPO, path.dirname(from), spec);
      const rel = relOf(abs);
      if (rel.startsWith("..")) { missing.push(`${spec}: outside the repo (imported by ${from})`); continue; }
      if (!isFile(abs)) { missing.push(`${rel} (imported by ${from})`); continue; }
      if (!reached.has(rel)) { reached.set(rel, from); queue.push(rel); }
    }
  }
  return { reached, missing, bare };
}

function workerEntries() {
  const list = (dir) => (isDir(path.join(REPO, WORKER, dir))
    ? fs.readdirSync(path.join(REPO, WORKER, dir)).filter((f) => f.endsWith(".mjs")).sort().map((f) => `${WORKER}/${dir}/${f}`)
    : []);
  return [`${WORKER}/server.mjs`, ...list("lanes"), ...list("packet")];
}

/* ---------- .dockerignore (moby's patternmatcher rules) ---------- */

/* A pattern → RegExp: * is any run within one path segment, ? one
   character, [...] a class, ** any number of segments (zero included). */
function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
        re += i + 1 >= pattern.length ? ".*" : "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) throw new Error(`.dockerignore: unclosed [ in ${pattern}`);
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith("!") || cls.startsWith("^")) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "\\") {
      i += 1;
      re += (pattern[i] ?? "").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`${re}$`);
}

function parseDockerignore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let neg = false;
    if (line.startsWith("!")) { neg = true; line = line.slice(1).trim(); }
    // filepath.Clean, and a leading "/" means the context root
    line = path.posix.normalize(line).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!line || line === ".") continue;
    rules.push({ neg, pattern: line, re: globToRegExp(line) });
  }
  return rules;
}

/** Whether the build context leaves `rel` out: the last rule that matches
    the path or one of its parent directories decides. */
function ignored(rules, rel) {
  const parts = rel.split("/");
  const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  let matched = false;
  for (const r of rules) {
    // an exclusion only matters once something matched, an inclusion only before
    if (r.neg !== matched) continue;
    if (r.re.test(rel) || parents.some((p) => r.re.test(p))) matched = !r.neg;
  }
  return matched;
}

/* ---------- Dockerfile ---------- */

/** The final stage's COPY/ADD lines from the build context, each with its
    destination made absolute against the WORKDIR in force, and the final
    WORKDIR and CMD. */
function parseDockerfile(text) {
  const lines = [];
  let cur = "";
  for (const raw of text.split(/\r?\n/)) {
    if (!cur && /^\s*#/.test(raw)) continue;
    const cont = /\\\s*$/.test(raw);
    cur += (cur ? " " : "") + raw.replace(/\\\s*$/, "").trim();
    if (cont) continue;
    if (cur.trim()) lines.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) lines.push(cur.trim());

  let workdir = "/";
  let copies = [];
  let cmd = null;
  for (const line of lines) {
    const m = /^(\w+)\s+([\s\S]*)$/.exec(line);
    if (!m) throw new Error(`Dockerfile: cannot read ${JSON.stringify(line)}`);
    const instr = m[1].toUpperCase();
    const rest = m[2].trim();
    if (instr === "FROM") { workdir = "/"; copies = []; cmd = null; continue; }
    if (instr === "WORKDIR") { workdir = path.posix.resolve(workdir, rest); continue; }
    if (instr === "CMD") { cmd = rest.startsWith("[") ? JSON.parse(rest) : rest.split(/\s+/); continue; }
    if (instr !== "COPY" && instr !== "ADD") continue;
    let args = rest.startsWith("[") ? JSON.parse(rest) : rest.split(/\s+/);
    const flags = [];
    while (args.length && args[0].startsWith("--")) flags.push(args.shift());
    if (flags.some((f) => f.startsWith("--from"))) continue;          // another stage, not the context
    if (args.length < 2) throw new Error(`Dockerfile: ${instr} needs a source and a destination: ${line}`);
    const dest = args.pop();
    const sources = args.map((s) => path.posix.normalize(s).replace(/^\.\//, "").replace(/\/+$/, "") || ".");
    for (const s of sources) {
      if (/[*?[]/.test(s)) throw new Error(`Dockerfile: this test does not expand wildcards (${s}); extend it first`);
      if (s.startsWith("..") || s.startsWith("/")) throw new Error(`Dockerfile: ${s} is outside the build context`);
    }
    copies.push({
      sources,
      dest: path.posix.resolve(workdir, dest),
      intoDir: dest.endsWith("/") || sources.length > 1,
    });
  }
  return { copies, workdir, cmd };
}

/** Where the image puts repo file `rel`, by the last COPY that carries it; null for nowhere. */
function landing(copies, rel) {
  let at = null;
  for (const c of copies) {
    for (const src of c.sources) {
      if (src === ".") at = path.posix.join(c.dest, rel);
      else if (src === rel) at = c.intoDir ? path.posix.join(c.dest, path.posix.basename(rel)) : c.dest;
      else if (rel.startsWith(`${src}/`) && isDir(path.join(REPO, src))) at = path.posix.join(c.dest, rel.slice(src.length + 1));
    }
  }
  return at;
}

/* ---------- the tests ---------- */

test("the parsers read the patterns these files use the way Docker does", () => {
  const rules = parseDockerignore([
    "# a comment", "", ".git", "**/node_modules", "apps/field", "!apps/field/js/model.js", "apps/admin", "/docs/",
  ].join("\n"));
  assert.equal(ignored(rules, ".git/HEAD"), true);
  assert.equal(ignored(rules, "node_modules/x/index.js"), true, "** matches zero directories");
  assert.equal(ignored(rules, "services/worker/node_modules/x.js"), true);
  assert.equal(ignored(rules, "apps/field/js/core.js"), true, "a directory pattern takes everything under it");
  assert.equal(ignored(rules, "apps/field/js/model.js"), false, "an exception after it lets one file back in");
  assert.equal(ignored(rules, "apps/fieldwork/x.js"), false, "a pattern is a whole path segment, not a prefix");
  assert.equal(ignored(rules, "docs/a.md"), true, "leading and trailing slashes are dropped");
  assert.equal(ignored(rules, "services/worker/server.mjs"), false);
  // the last matching rule wins: an exception before the exclusion is undone by it
  assert.equal(ignored(parseDockerignore("!apps/field/js/model.js\napps/field"), "apps/field/js/model.js"), true);
  assert.equal(ignored(parseDockerignore("apps/*/js/*.js"), "apps/field/js/x.js"), true);
  assert.equal(ignored(parseDockerignore("apps/*.js"), "apps/field/x.js"), false, "* stays within one segment");

  const df = parseDockerfile([
    "FROM node:22 AS build", "COPY nothing nothing",
    "FROM node:22-slim", "WORKDIR /app", "# a comment", "COPY a/b.js a/b.js", "COPY --chown=node:node \\", "  services/worker services/worker",
    "COPY --from=build /x /x", "COPY a/c.js a/d.js lib/", "WORKDIR services/worker", 'CMD ["node", "server.mjs"]',
  ].join("\n"));
  assert.deepEqual(df.copies.map((c) => [c.sources, c.dest, c.intoDir]), [
    [["a/b.js"], "/app/a/b.js", false],
    [["services/worker"], "/app/services/worker", false],
    [["a/c.js", "a/d.js"], "/app/lib", true],
  ]);
  assert.equal(df.workdir, "/app/services/worker");
  assert.deepEqual(df.cmd, ["node", "server.mjs"]);
  assert.equal(landing(df.copies, "a/b.js"), "/app/a/b.js");
  assert.equal(landing(df.copies, "a/d.js"), "/app/lib/d.js");
  assert.equal(landing(df.copies, "services/worker/lanes/queue.mjs"), "/app/services/worker/lanes/queue.mjs");
  assert.equal(landing(df.copies, "a/e.js"), null);
  assert.throws(() => parseDockerfile("FROM x\nCOPY apps/*.js apps/"), /wildcards/);
});

test("the import scan follows every kind of import and nothing in a comment, string or regex", () => {
  const src = [
    "/* import { x } from \"./in-a-block-comment.mjs\"; */",
    "// import y from './in-a-line-comment.mjs';",
    "import { a,",
    "  b } from \"./multi-line.mjs\";",
    "import * as ns from '../star.mjs';",
    "import \"./bare-effect.mjs\";",
    "export { c } from \"./re-export.mjs\";",
    "export * from \"./re-export-all.mjs\";",
    "const re = /['\"]import(\"x\")/g;",
    "const t = `import(\"./in-a-template.mjs\") ${fn({ k: 1 })} more`;",
    "const lazy = () => import(\"./lazy.mjs\");",
    "const computed = (n) => import(`./${n}.mjs`);",
    "const url = \"https://example.com/a\"; const half = 4 / 2; // import('./after-division.mjs')",
    "console.log(import.meta.url);",
  ].join("\n");
  assert.deepEqual(importSpecifiers(src).map((x) => [x.spec, x.dynamic]), [
    ["./multi-line.mjs", false],
    ["../star.mjs", false],
    ["./bare-effect.mjs", false],
    ["./re-export.mjs", false],
    ["./re-export-all.mjs", false],
    ["./lazy.mjs", true],
  ]);
});

test("every file the worker can import is in the image, at the path its importer expects", () => {
  const { copies, workdir, cmd } = parseDockerfile(read(`${WORKER}/Dockerfile`));
  const rules = parseDockerignore(read(".dockerignore"));
  const { reached, missing, bare } = walk(workerEntries());

  // the image root: where server.mjs lands, minus its own path
  const server = `${WORKER}/server.mjs`;
  const serverAt = landing(copies, server);
  assert.ok(serverAt && serverAt.endsWith(`/${server}`), `the Dockerfile puts ${server} at ${serverAt}`);
  const root = serverAt.slice(0, -server.length - 1);
  assert.equal(path.posix.resolve(workdir, cmd?.[cmd.length - 1] ?? ""), serverAt, "CMD runs server.mjs where it lands");

  const problems = [];
  for (const m of missing) problems.push(`imported but not in the repo: ${m}`);
  for (const b of bare) problems.push(`a package import, and the image installs none: ${b}`);
  for (const [rel, from] of reached) {
    const by = from ? ` (imported by ${from})` : "";
    if (ignored(rules, rel)) problems.push(`${rel}${by}: left out of the build context by .dockerignore`);
    const at = landing(copies, rel);
    if (at !== `${root}/${rel}`) problems.push(`${rel}${by}: no COPY line puts it at ${root}/${rel}${at ? ` (it lands at ${at})` : ""}`);
  }
  assert.deepEqual(problems, [], `the worker image would be missing files:\n  ${problems.join("\n  ")}`);

  // the walk does cross into apps/field (an empty walk would pass anything)
  assert.ok(reached.has("apps/field/js/reconcile.js"), "the billing check's detector is reached");
});

test("every COPY source is in the build context, so the build never stops on a file Docker was not sent", () => {
  const { copies } = parseDockerfile(read(`${WORKER}/Dockerfile`));
  const rules = parseDockerignore(read(".dockerignore"));
  const problems = [];
  for (const c of copies) {
    for (const src of c.sources) {
      const abs = path.join(REPO, src);
      if (!isFile(abs) && !isDir(abs)) problems.push(`${src}: not in the repo`);
      else if (src !== "." && ignored(rules, src)) problems.push(`${src}: left out by .dockerignore (it needs a "!${src}" exception after the rule that drops it)`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the packet modules are reached only through lazy imports, so a packaging miss cannot stop the worker booting", () => {
  const { reached } = walk([`${WORKER}/server.mjs`], { dynamic: false });
  const eager = [...reached.keys()].filter((f) => f.startsWith(`${WORKER}/packet/`) || f === `${WORKER}/lanes/packet.mjs`
    || f === `${WORKER}/storage.mjs`);
  assert.deepEqual(eager, [], "server.mjs loads these at boot");
  const all = walk([`${WORKER}/server.mjs`]).reached;
  assert.ok(all.has(`${WORKER}/lanes/packet.mjs`), "the queue's lazy import of the packet lane is followed");
  assert.ok(all.has(`${WORKER}/storage.mjs`), "and the lane's lazy imports with it");
});
