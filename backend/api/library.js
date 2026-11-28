// The Aperture library: photos published by approved creators (roadmap #33).
//
//   GET /api/library?q=&page=&per_page=&order_by=&color=&orientation=&creator=
//     -> { enabled: true, total, results: [photo] }
//     -> { enabled: false, total: 0, results: [] }   when accounts aren't set up
//
// Read through Supabase's public library_photos() function (backend/supabase/schema.sql),
// which only returns published, unhidden photos by approved creators. Each photo
// comes back in the same shape as an Unsplash photo, so the grid, wall, viewer
// and boards treat both alike. A photo's urls.raw is its folder in the public
// "library" bucket; the browser adds "s.webp", "m.webp" or "l.webp" (api.js, photoSrc).
import { supabaseEnv } from "./config.js";

const TONES = new Set(["black_and_white", "black", "white", "yellow", "orange", "red", "purple", "magenta", "green", "teal", "blue"]);
const SHAPES = new Set(["landscape", "portrait", "squarish"]);
const USER = /^[a-z0-9_-]{3,30}$/;
const ID = /^ap-[a-z0-9]{12}$/;
const UUID = /^[0-9a-f-]{36}$/;
const HEX = /^#[0-9a-f]{6}$/;

const json = (body, status, cache) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": cache ? "public, max-age=30" : "no-store",
            ...(cache ? { "cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=300" } : {}),
        },
    });

const text = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const int = (v, lo, hi, fb) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

// the query string, allow-listed, as library_photos() arguments
export function args(url) {
    const p = url.searchParams;
    const out = { q_page: int(p.get("page"), 1, 50, 1), q_per: int(p.get("per_page"), 1, 30, 24), q_sort: p.get("order_by") === "latest" ? "latest" : "relevant" };
    const q = text(p.get("q") || p.get("query"), 200);
    if (q) out.q_text = q;
    const creator = (p.get("creator") || "").toLowerCase();
    if (USER.test(creator)) out.q_creator = creator;
    if (TONES.has(p.get("color"))) out.q_tone = p.get("color");
    if (SHAPES.has(p.get("orientation"))) out.q_shape = p.get("orientation");
    return out;
}

// one library_photos() row -> an Unsplash-shaped photo record (or null if anything looks off)
export function shape(row, base) {
    if (!row || !ID.test(row.id) || !UUID.test(row.creator) || !USER.test(row.username)) return null;
    const width = int(row.width, 1, 20000, 0);
    const height = int(row.height, 1, 20000, 0);
    if (!width || !height) return null;
    const folder = `${base}/storage/v1/object/public/library/${row.creator}/`;
    const raw = `${folder}${row.id}/`;
    const avatar = row.avatar > 0 ? `${folder}avatar.webp?v=${int(row.avatar, 1, 1e9, 1)}` : null;
    const profile = `/?creator=${row.username}`;
    const title = text(row.title, 120) || "Untitled frame";
    const link = /^https:\/\/[^\s]+$/.test(row.link || "") ? text(row.link, 200) : null;
    const free = row.license === "free";
    return {
        id: row.id,
        source: "aperture",
        license: free ? "free" : "view",
        width,
        height,
        color: HEX.test(row.color) ? row.color : "#222222",
        likes: null,
        created_at: row.created_at,
        description: title,
        alt_description: text(row.alt, 300) || title,
        tags: (Array.isArray(row.tags) ? row.tags : []).slice(0, 12).map((t) => ({ title: text(t, 40) })).filter((t) => t.title),
        urls: { raw },
        links: { html: profile, download: free ? `${raw}l.webp` : null, download_location: null },
        user: {
            username: row.username,
            name: text(row.name, 60) || row.username,
            bio: text(row.bio, 300) || null,
            location: text(row.location, 60) || null,
            portfolio_url: link,
            links: { html: profile },
            profile_image: avatar ? { small: avatar, medium: avatar } : null,
        },
    };
}

async function query(params) {
    const sb = supabaseEnv();
    if (!sb) return null;
    const r = await fetch(`${sb.url}/rest/v1/rpc/library_photos`, {
        method: "POST",
        headers: { apikey: sb.anonKey, authorization: `Bearer ${sb.anonKey}`, "content-type": "application/json" },
        body: JSON.stringify(params),
    });
    if (!r.ok) throw new Error(`library_photos: ${r.status}`);
    const rows = await r.json();
    return { rows: Array.isArray(rows) ? rows : [], base: sb.url };
}

// `find(params)` -> { rows, base } or null when accounts aren't set up (tests pass their own)
export async function respond(request, find = query) {
    const url = new URL(request.url);
    let found;
    try {
        found = await find(args(url));
    } catch (err) {
        console.error("[library]", String(err?.message || err).slice(0, 200));
        return json({ error: "library unavailable" }, 502, false);
    }
    if (!found) return json({ enabled: false, total: 0, results: [] }, 200, true);
    const results = found.rows.map((r) => shape(r, found.base)).filter(Boolean);
    const total = Number(found.rows[0]?.total) || 0;
    return json({ enabled: true, total, results }, 200, true);
}

export const GET = (request) => respond(request);
