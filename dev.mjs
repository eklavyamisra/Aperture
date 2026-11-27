// Local dev server: serves frontend/ and runs the functions in backend/api/ like Vercel does.
//   node dev.mjs            -> http://localhost:5173
// Reads UNSPLASH_ACCESS_KEY from .env.local. Caches API responses in memory
// so reloading while you work doesn't eat the rate limit.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { GET } from "./backend/api/unsplash.js";
import { POST as logPOST } from "./backend/api/log.js";
import { GET as configGET } from "./backend/api/config.js";

const root = new URL("./frontend/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
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

// the same exact-path rewrites and redirects Vercel applies (vercel.json)
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8"));
const rewrites = new Map((vercel.rewrites || []).map((r) => [r.source, r.destination]));
const redirects = new Map((vercel.redirects || []).map((r) => [r.source, r.destination]));

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/api/log" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const r = await logPOST(new Request(url, { method: "POST", body: Buffer.concat(chunks) }));
        res.writeHead(r.status);
        return res.end();
    }

    if (url.pathname === "/api/config") {
        const r = await configGET(new Request(url));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        return res.end(await r.text());
    }

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

    if (redirects.has(url.pathname)) {
        res.writeHead(308, { location: redirects.get(url.pathname) });
        return res.end();
    }
    const pathname = rewrites.get(url.pathname) || url.pathname;
    let p = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
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
