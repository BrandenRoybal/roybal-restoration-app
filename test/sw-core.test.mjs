/* Every module in the app's startup graph is in the service worker's CORE
   list. The page loads js/app.js as an ES module; if any file it imports,
   directly or through another module, isn't precached, the whole graph
   fails to load with no signal after a cache bump — the app is a blank
   screen in a loss house. Until v211 four such files (photoshare.js,
   signdocs.js, thumbs.js, calibration.js) were missing and cached only on a
   first online load. Lazy import()s are not checked: a page that loads one
   on demand precaches it by hand (receiptlib.js, scanner.js).
   Run: node --test test/sw-core.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FIELD = new URL("../", import.meta.url);
const ORIGIN = "https://field.example/";

/* the served path ("js/app.js", "board/js/schedule.js") → the file in the repo */
const fileOf = (path) => (path.startsWith("board/") ? new URL("../board/" + path.slice("board/".length), FIELD) : new URL(path, FIELD));

function staticImports(src) {
  const out = [];
  const re = /^(?:import\s+(?:[^;"'`]*?\s+from\s+)?|export\s+(?:\*|\{[^;"'`]*\})\s+from\s+)["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function startupGraph(entry) {
  const seen = new Set();
  const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const spec of staticImports(readFileSync(fileOf(path), "utf8"))) {
      walk(new URL(spec, ORIGIN + path).pathname.slice(1));
    }
  };
  walk(entry);
  return seen;
}

function coreList() {
  const sw = readFileSync(new URL("sw.js", FIELD), "utf8");
  const m = /const CORE = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(m, "sw.js has a CORE list");
  return new Set([...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

test("index.html loads js/app.js, the root of the startup graph", () => {
  assert.match(readFileSync(new URL("index.html", FIELD), "utf8"), /<script type="module" src="js\/app\.js"><\/script>/);
});

test("every module app.js reaches by static import is precached", () => {
  const graph = startupGraph("js/app.js");
  const core = coreList();
  assert.ok(graph.size > 40, `walked ${graph.size} modules — the import scan has stopped matching`);
  for (const must of ["js/meterui.js", "js/meterphotos.js", "js/forms.js", "board/js/schedule.js"]) {
    assert.ok(graph.has(must), `${must} should be in the startup graph`);
  }
  const missing = [...graph].filter((p) => !core.has(p)).sort();
  assert.deepEqual(missing, [], `add to sw.js CORE (and bump BUILD/CACHE): ${missing.join(", ")}`);
});

test("the import scan reads multi-line, side-effect and re-export forms", () => {
  assert.deepEqual(staticImports([
    `import { a,\n  b } from "./one.js";`,
    `import "./two.js";`,
    `export { c } from "./three.js";`,
    `export * from "./four.js";`,
    `  const x = await import("./lazy.js");`,
    `// import { d } from "./comment.js";`,
  ].join("\n")), ["./one.js", "./two.js", "./three.js", "./four.js"]);
});
