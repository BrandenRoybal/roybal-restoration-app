#!/usr/bin/env node
/* Local dev server for the customer portal.
   Mirrors the deployed routing: a share link is /j/<token>, which the host
   rewrites to index.html (see vercel.json) so the SPA can read the token off
   the path. Everything unknown falls back to index.html for the same reason.
   Usage: node serve.mjs [port]   (default 4180) */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 4180;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = normalize(join(ROOT, path === "/" ? "/index.html" : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("Forbidden"); return; }
    let target = file;
    try { if ((await stat(target)).isDirectory()) target = join(target, "index.html"); }
    catch {
      // mirror vercel.json: /photos/ → photos.html, /packet/ → packet.html, else index.html
      target = join(ROOT, path.startsWith("/photos/") ? "photos.html"
        : path.startsWith("/packet/") ? "packet.html" : "index.html");
    }
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); }
});
server.listen(PORT, () => console.log(`\n  Customer portal:  http://localhost:${PORT}/j/<share-token>\n`));
