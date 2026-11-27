// The page behind a short share link (roadmap #18).
//
//   GET /b/<code>   (vercel.json rewrites it to /api/board?code=<code>)
//
// Link previews (WhatsApp, iMessage, Slack, X) don't run JavaScript, so this
// serves the app's own index.html with the board's name, a short description
// and a cover photo filled into the title and og: tags. The board itself is
// embedded as JSON (#shared-board), and pins.js opens it read-only from there.
//
// The board is read through Supabase's public shared_board() function, which
// only answers for a known code and leaves uploaded images out
// (backend/supabase/schema.sql).
import { readFile } from "node:fs/promises";
import { supabaseEnv } from "./config.js";

const CODE = /^[A-Za-z0-9]{10,16}$/;
const IMG = /^https:\/\/images\.unsplash\.com\//;

let fetched = null; // index.html fetched over HTTP, kept for the life of the instance

async function template(origin) {
    try {
        return await readFile(new URL("../../frontend/index.html", import.meta.url), "utf8");
    } catch (e) {}
    if (fetched) return fetched;
    const r = await fetch(`${origin}/`);
    if (!r.ok) throw new Error(`index.html: ${r.status}`);
    return (fetched = await r.text());
}

async function lookup(code) {
    const sb = supabaseEnv();
    if (!sb) return null;
    const r = await fetch(`${sb.url}/rest/v1/rpc/shared_board`, {
        method: "POST",
        headers: { apikey: sb.anonKey, authorization: `Bearer ${sb.anonKey}`, "content-type": "application/json" },
        body: JSON.stringify({ share_code: code }),
    });
    if (!r.ok) throw new Error(`shared_board: ${r.status}`);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return row || null;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const clean = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "12 photos, 3 notes and 2 links on a board in Aperture."
export function describe(pins) {
    const count = (k) => pins.filter((x) => x?.kind === k).length;
    const parts = [
        [count("unsplash"), "photo"],
        [count("note"), "note"],
        [count("link"), "link"],
    ]
        .filter(([n]) => n)
        .map(([n, w]) => plural(n, w));
    if (!parts.length) return "An empty board on Aperture.";
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `${list} on a board in Aperture.`;
}

// the first Unsplash photo on the board, cropped to the 1200×630 preview shape
export function cover(pins) {
    const raw = pins.find((x) => x?.kind === "unsplash" && typeof x.photo?.urls?.raw === "string" && IMG.test(x.photo.urls.raw))?.photo.urls.raw;
    if (!raw) return null;
    try {
        const u = new URL(raw);
        for (const [k, v] of Object.entries({ w: "1200", h: "630", fit: "crop", crop: "entropy", fm: "jpg", q: "80" })) u.searchParams.set(k, v);
        return u.href;
    } catch (e) {
        return null;
    }
}

function meta(html, attr, value) {
    return html.replace(new RegExp(`(<meta ${attr} content=")[^"]*(")`), (_, a, b) => a + esc(value) + b);
}

// index.html with the board's preview tags and the embedded board (or why there isn't one)
export function fill(html, { origin, code, board, failed = false }) {
    const url = `${origin}/b/${code}`;
    const payload = board ? { code, name: board.name, data: board.data } : failed ? { code, error: true } : { code, missing: true };
    const name = board ? board.name : failed ? "Shared board" : "Board not found";
    const desc = board ? describe(board.data.pins) : failed ? "A board shared from Aperture." : "This shared board doesn't exist any more.";
    const image = (board && cover(board.data.pins)) || `${origin}/img/og.jpg`;
    // the page lives at /b/<code>, so relative asset URLs need the site root as their base
    html = html.replace(/<meta charset="UTF-8">/i, (m) => `${m}\n    <base href="/">`);
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(name)} — Aperture</title>`);
    html = meta(html, 'name="description"', desc);
    html = meta(html, 'property="og:url"', url);
    html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, (_, a, b) => a + esc(url) + b);
    html = meta(html, 'property="og:title"', name);
    html = meta(html, 'property="og:description"', desc);
    html = meta(html, 'property="og:image"', image);
    html = meta(html, 'name="twitter:image"', image);
    // "<" escaped so a board can never close the script tag early
    const json = JSON.stringify(payload).replace(/</g, "\\u003c");
    return html.replace("</head>", `    <script type="application/json" id="shared-board">${json}</script>\n</head>`);
}

export const GET = (request) => respond(request);

// `find(code)` gives { name, data } or null; the browser tests pass a stand-in
export async function respond(request, find = lookup) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") || url.pathname.match(/^\/b\/([^/]+)$/)?.[1] || "";
    const valid = CODE.test(code);
    let board = null;
    let failed = false;
    if (valid) {
        try {
            const row = await find(code);
            if (row?.data && typeof row.data === "object") {
                const pins = Array.isArray(row.data.pins) ? row.data.pins : [];
                board = { name: clean(row.name || row.data.name, 60) || "Shared board", data: { ...row.data, pins } };
            }
        } catch (err) {
            console.error("[share] lookup failed:", String(err?.message || err).slice(0, 200));
            failed = true;
        }
    }
    let html;
    try {
        html = fill(await template(url.origin), { origin: url.origin, code: valid ? code : "", board, failed });
    } catch (err) {
        console.error("[share] page failed:", String(err?.message || err).slice(0, 200));
        return new Response("Aperture couldn't load this page. Try again in a moment.", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
    }
    const headers = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "public, max-age=0, must-revalidate" };
    // edits reach the link within a minute; a missing board is re-checked sooner; failures aren't kept
    if (board) headers["cdn-cache-control"] = "s-maxage=60, stale-while-revalidate=600";
    else if (failed) headers["cache-control"] = "no-store";
    else headers["cdn-cache-control"] = "s-maxage=10";
    return new Response(html, { status: board ? 200 : failed ? 502 : 404, headers });
}
