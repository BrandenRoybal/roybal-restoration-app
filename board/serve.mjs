#!/usr/bin/env node
/* Local dev server that composes the deployed layout:
   the field app at "/" and the Job Board at "/board",
   so the board's ../../js/* imports resolve to the field app.
   Usage: node serve.mjs [port]   (default 4290) */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD_ROOT = fileURLToPath(new URL(".", import.meta.url));
const FIELD_ROOT = fileURLToPath(new URL("../field/", import.meta.url));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 4290;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let root = FIELD_ROOT;
    if (path === "/board" || path.startsWith("/board/")) {
      root = BOARD_ROOT;
      path = path.slice("/board".length) || "/";
    }
    if (path === "/" || path === "") path = "/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end("Forbidden"); return; }
    let target = file;
    try { if ((await stat(target)).isDirectory()) target = join(target, "index.html"); } catch { target = join(root, "index.html"); }
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); }
});
server.listen(PORT, () => console.log(`\n  Job Board:  http://localhost:${PORT}/board\n  Field app:  http://localhost:${PORT}/\n`));
