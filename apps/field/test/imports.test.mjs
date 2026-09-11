/* Every helper a module CALLS from a sibling module must be IMPORTED.
   The app has no bundler, linter or type-checker: a name that is never
   imported is not a build error, it is a ReferenceError the first time that
   line runs — and a branch nobody's fixture reaches ships green. PR #162
   (2026-08-28) added `likelyOffline()` gates to forms.js and voice.js without
   touching either import line; the suite stayed green because no test photo
   carried `cloud` and no test taps the mic. In production every cloud photo
   stuck at its 480px preview (864 exceptions on one packet page) and the
   Transcribe button died silently, for two weeks.

   Scope is deliberately narrow so a failure here is always real:
     • only names that some module in js/ exports (so the message can say
       exactly which import to add);
     • only names a module uses purely as a call, never in any other
       position — a parameter, a local, a destructured field or a value
       reference anywhere in the file counts as bound.
   Comments, string contents and regex literals are blanked before scanning,
   so prose can't produce a false alarm. Not a parser; good enough to catch
   the class of bug that actually shipped.
   Run: node test/imports.test.mjs */
import { readFileSync, readdirSync } from "node:fs";

const JS_DIR = new URL("../js/", import.meta.url);

/* Keep code, blank everything else. Template literals keep their ${ }
   expressions (those are code); regex literals are recognised by what
   precedes the slash, the usual divide-or-regex heuristic. */
export function codeOnly(s) {
  let out = "", i = 0, lastSig = "";
  const n = s.length;
  let tplDepth = 0;                                  // open ${ … } inside template literals
  const push = (ch) => { out += ch; if (!/\s/.test(ch)) lastSig = ch; };
  const regexOk = () => !lastSig || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || /\b(return|typeof|case|in|of|delete|void|throw|new)\s*$/.test(out);
  /* skip template TEXT from s[j] up to the closing backtick or the next ${ ;
     returns the index to resume from and whether we are now inside ${ } */
  const skipTplText = (j) => {
    while (j < n) {
      if (s[j] === "\\") { j += 2; continue; }
      if (s[j] === "`") { out += "`"; lastSig = "`"; return { j: j + 1, inExpr: false }; }
      if (s[j] === "$" && s[j + 1] === "{") { out += "${"; return { j: j + 2, inExpr: true }; }
      j++;
    }
    return { j, inExpr: false };
  };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out += " "; continue; }
    if (c === "/" && d === "/") { const e = s.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c && s[j] !== "\n") { if (s[j] === "\\") j++; j++; }
      out += c + " " + c; lastSig = c; i = j + 1; continue;
    }
    if (c === "`") {
      out += "`";
      const r = skipTplText(i + 1);
      if (r.inExpr) tplDepth++;
      i = r.j; continue;
    }
    if (c === "}" && tplDepth) {                     // end of a ${ } — back into template text
      tplDepth--; out += "}";
      const r = skipTplText(i + 1);
      if (r.inExpr) tplDepth++;
      i = r.j; continue;
    }
    if (c === "/" && regexOk()) {
      let j = i + 1, cls = false;
      while (j < n && s[j] !== "\n") {
        if (s[j] === "\\") { j += 2; continue; }
        if (cls) { if (s[j] === "]") cls = false; }
        else if (s[j] === "[") cls = true;
        else if (s[j] === "/") break;
        j++;
      }
      if (s[j] === "/") { j++; while (j < n && /[a-z]/.test(s[j])) j++; out += " "; lastSig = "/"; i = j; continue; }
    }
    push(c); i++;
  }
  return out;
}

const splitNames = (list, sep) => list.split(",").map((part) => {
  const p = part.trim().split(sep);
  return (p[1] || p[0] || "").trim();
}).filter(Boolean);

export function exportsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const nm of splitNames(m[1], /\s+as\s+/)) names.add(nm);
  for (const m of code.matchAll(/^export\s+(?:const|let|var)\s*\{([^}]*)\}/gm)) for (const nm of splitNames(m[1], /\s*:\s*/)) names.add(nm);
  return names;
}

export function importsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/import\s+([^;'"]*?)\s+from\s+["']/g)) {
    let clause = m[1];
    const star = clause.match(/\*\s*as\s+([\w$]+)/);
    if (star) { names.add(star[1]); clause = clause.replace(star[0], ""); }
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) { for (const nm of splitNames(braces[1], /\s+as\s+/)) names.add(nm); clause = clause.replace(braces[0], ""); }
    const def = clause.replace(/,/g, "").trim();
    if (def) names.add(def);
  }
  return names;
}

const KEYWORDS = new Set(("if for while switch catch function return typeof await new void delete in of yield async else do " +
  "try case throw import super this class extends static get set instanceof with export default let const var").split(" "));

/* names used as `name(` — not a property, not a declaration, not method shorthand */
export function callsOf(code) {
  const calls = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (/(?:^|[^\w$])function\*?\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (/^\([^()]*\)\s*\{/.test(code.slice(m.index + m[0].length - 1))) continue;
    calls.add(name);
  }
  return calls;
}

const boundLocally = (code, name) =>
  new RegExp(`(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(code) ||
  new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*\\()`).test(code);

export function unresolvedCalls(sources) {          // { file: raw source } -> [{ file, name, from }]
  const modules = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, codeOnly(s)]));
  const exportIndex = new Map();
  for (const [f, code] of Object.entries(modules))
    for (const nm of exportsOf(code)) exportIndex.set(nm, [...(exportIndex.get(nm) || []), f]);
  const out = [];
  for (const [f, code] of Object.entries(modules)) {
    const imported = importsOf(code);
    for (const name of callsOf(code)) {
      if (imported.has(name) || !exportIndex.has(name) || boundLocally(code, name)) continue;
      out.push({ file: f, name, from: exportIndex.get(name) });
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  let failures = 0;
  const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

  // the scanner itself: the shapes that fooled earlier drafts must stay quiet, the real thing must not
  const fixture = {
    "a.js": "export function gate() {}\nexport function money(v) { return v; }\nexport const $ = (q) => q;\n",
    "b.js": [
      'import { money } from "./a.js";',
      'const label = "Fixed $ (from estimate)";               // a call-shaped string',
      "const tpl = `${money(1)} and ${gate() ? 1 : 0}`;        // template: money imported, gate NOT",
      "const re = /\\$\\(/g;                                   // regex looks like $(",
      "/* prose: gate() is documented here */",
      "const o = { gate(x) { return x; } };                    // method shorthand is a definition",
    ].join("\n"),
  };
  const found = unresolvedCalls(fixture);
  ok(found.length === 1 && found[0].file === "b.js" && found[0].name === "gate",
    "scanner: flags the one real unimported call and nothing string-, regex-, comment- or method-shaped");

  // the app
  const files = readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort();
  const modules = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, JS_DIR), "utf8")]));
  const bad = unresolvedCalls(modules);
  for (const b of bad) ok(false, `${b.file} calls ${b.name}() but never imports it — add it to the import from ./${b.from[0]}`);
  ok(bad.length === 0, `${files.length} field modules: every cross-module call is imported`);

  console.log(failures ? `\nFAILED: ${failures}` : "\nIMPORTS RESOLVE");
  process.exit(failures ? 1 : 0);
}
