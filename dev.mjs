// Local dev server: serves public/ and runs api/unsplash.js like Vercel does.
//   node dev.mjs            -> http://localhost:5173
// Reads UNSPLASH_ACCESS_KEY from .env.local. Caches API responses in memory
// so reloading while you work doesn't eat the rate limit.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { GET } from "./api/unsplash.js";

const root = new URL("./public/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const PORT = +process.env.PORT || 5173;

if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
};

const cache = new Map();

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/api/unsplash") {
        const hit = cache.get(url.search);
        if (hit) {
            res.writeHead(200, hit.headers);
            return res.end(hit.body);
        }
        const r = await GET(new Request(url));
        const body = await r.text();
        const headers = Object.fromEntries(r.headers);
        if (r.ok && !url.search.includes("download")) cache.set(url.search, { headers, body });
        res.writeHead(r.status, headers);
        return res.end(body);
    }

    let p = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, "");
    if (!p || p.endsWith("/") || p.endsWith("\\")) p += "index.html";
    if (!extname(p)) p += ".html";
    const file = join(root, p);
    if (!file.startsWith(normalize(root))) {
        res.writeHead(403);
        return res.end();
    }
    try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
}).listen(PORT, () => console.log(`Aperture dev → http://localhost:${PORT}`));
