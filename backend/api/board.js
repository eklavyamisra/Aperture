// The page behind a short share link (roadmap #18, passwords #19).
//
//   GET  /b/<code>     (vercel.json rewrites it to /api/board?code=<code>)
//   POST /api/board    { code, password } -> { name, data, editable } for a password-protected board
//
// Link previews (WhatsApp, iMessage, Slack, X) don't run JavaScript, so this
// serves the app's own index.html with the board's name, a short description
// and a cover photo filled into the title and og: tags. The board itself is
// embedded as JSON (#shared-board), and pins.js opens it read-only from there.
//
// A password-protected board's page carries no board and a generic preview;
// the app asks for the password and POSTs it here (never in a URL).
//
// The board is read through Supabase's public shared_board() function, which
// only answers for a known code, checks passwords, limits wrong tries and
// leaves uploaded images out (backend/supabase/schema.sql).
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

// { status: ok | locked | wrong | slow, name, data, editable } or null when there's no such board
async function lookup(code, password = null) {
    const sb = supabaseEnv();
    if (!sb) return null;
    const r = await fetch(`${sb.url}/rest/v1/rpc/shared_board`, {
        method: "POST",
        headers: { apikey: sb.anonKey, authorization: `Bearer ${sb.anonKey}`, "content-type": "application/json" },
        body: JSON.stringify(password == null ? { share_code: code } : { share_code: code, password }),
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
export function fill(html, { origin, code, board, locked = false, failed = false }) {
    const url = `${origin}/b/${code}`;
    let payload, name, desc;
    if (board) {
        payload = { code, name: board.name, data: board.data, editable: board.editable };
        name = board.name;
        desc = describe(board.data.pins);
    } else if (locked) {
        payload = { code, locked: true };
        name = "Password-protected board";
        desc = "A board shared from Aperture. It needs a password to open.";
    } else if (failed) {
        payload = { code, error: true };
        name = "Shared board";
        desc = "A board shared from Aperture.";
    } else {
        payload = { code, missing: true };
        name = "Board not found";
        desc = "This shared board doesn't exist any more.";
    }
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

const codeOf = (url) => url.searchParams.get("code") || url.pathname.match(/^\/b\/([^/]+)$/)?.[1] || "";

// the row as a board ready to embed, or null
function toBoard(row) {
    if (!row?.data || typeof row.data !== "object") return null;
    const pins = Array.isArray(row.data.pins) ? row.data.pins : [];
    // editable: signed-in people with the link can edit it together (#21)
    return { name: clean(row.name || row.data.name, 60) || "Shared board", data: { ...row.data, pins }, editable: row.editable === true };
}

const fail = (what, err) => console.error(`[share] ${what}:`, String(err?.message || err).slice(0, 200));

export const GET = (request) => respond(request);
export const POST = (request) => unlock(request);

// `find(code, password?)` gives { status, name, data, editable } or null; the browser tests pass a stand-in
export async function respond(request, find = lookup) {
    const url = new URL(request.url);
    const code = codeOf(url);
    const valid = CODE.test(code);
    let board = null;
    let locked = false;
    let failed = false;
    if (valid) {
        try {
            const row = await find(code);
            if (row && (row.status || "ok") !== "ok") locked = true;
            else board = toBoard(row);
        } catch (err) {
            fail("lookup failed", err);
            failed = true;
        }
    }
    let html;
    try {
        html = fill(await template(url.origin), { origin: url.origin, code: valid ? code : "", board, locked, failed });
    } catch (err) {
        fail("page failed", err);
        return new Response("Aperture couldn't load this page. Try again in a moment.", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
    }
    const headers = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "public, max-age=0, must-revalidate" };
    // a short edge cache: edits, a new password or "stop sharing" reach the link within 15 s
    if (board || locked) headers["cdn-cache-control"] = "s-maxage=15";
    else if (failed) headers["cache-control"] = "no-store";
    else headers["cdn-cache-control"] = "s-maxage=10";
    return new Response(html, { status: board || locked ? 200 : failed ? 502 : 404, headers });
}

const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// POST { code, password }: the board, or why not (403 wrong, 429 too many tries, 404 gone)
export async function unlock(request, find = lookup) {
    let body = null;
    try {
        const text = await request.text();
        if (text.length <= 2000) body = JSON.parse(text);
    } catch (e) {}
    const code = body?.code;
    const password = body?.password;
    if (typeof code !== "string" || !CODE.test(code) || typeof password !== "string" || !password || password.length > 200) {
        return reply(400, { error: "bad request" });
    }
    let row;
    try {
        row = await find(code, password);
    } catch (err) {
        fail("unlock failed", err);
        return reply(502, { error: "unavailable" });
    }
    if (!row) return reply(404, { error: "missing" });
    const status = row.status || "ok";
    if (status === "slow") return reply(429, { error: "slow" });
    if (status !== "ok") return reply(403, { error: "wrong" });
    const board = toBoard(row);
    return board ? reply(200, board) : reply(404, { error: "missing" });
}
