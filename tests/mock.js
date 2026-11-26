// Stand-ins for Unsplash so the browser tests need no API key, never touch
// the rate limit and always see the same photos.
//
//   /api/unsplash?path=…          answered from generated photo records
//   https://images.unsplash.com/… answered with small generated PNGs
//
// Every call to the download endpoint is recorded in `calls.downloads`.
import { deflateSync } from "node:zlib";

const PALETTE = ["#1e6f5c", "#f2c14e", "#c8553d", "#2d3047", "#93b7be", "#e0a458", "#6b4e71", "#3a7d44"];
const NAMES = ["Ada Ruiz", "Bo Lindqvist", "Chen Wei", "Dara Okafor", "Elif Kaya", "Femi Adeyemi"];
const TAGS = ["coast", "forest", "night city", "portrait", "desert road", "window light"];

/* ---------- photos ---------- */

export function photo(n, { orientation, username } = {}) {
    const shape = orientation || ["landscape", "portrait", "squarish"][n % 3];
    const [width, height] = shape === "portrait" ? [4000, 6000] : shape === "squarish" ? [4000, 4000] : [6000, 4000];
    const user = username ? { name: username, username } : { name: NAMES[n % NAMES.length], username: NAMES[n % NAMES.length].split(" ")[0].toLowerCase() };
    const id = `mock${String(n).padStart(4, "0")}`;
    return {
        id,
        width,
        height,
        color: PALETTE[n % PALETTE.length],
        blur_hash: null,
        likes: 10 + n,
        created_at: "2026-01-01T00:00:00Z",
        description: null,
        alt_description: `${TAGS[n % TAGS.length]} study number ${n}`,
        tags: [{ title: TAGS[n % TAGS.length] }, { title: "film" }],
        urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=mock${n}` },
        links: {
            html: `https://unsplash.com/photos/${id}`,
            download: `https://unsplash.com/photos/${id}/download`,
            download_location: `https://api.unsplash.com/photos/${id}/download?ixid=mock${n}`,
        },
        user: { ...user, links: { html: `https://unsplash.com/@${user.username}` } },
    };
}

const page = (p, per, opts) => Array.from({ length: per }, (_, i) => photo((p - 1) * per + i, opts));

export function answer(url) {
    const path = url.searchParams.get("path") || "";
    const p = Math.max(1, +url.searchParams.get("page") || 1);
    const per = Math.min(30, +url.searchParams.get("per_page") || 24);
    const orientation = url.searchParams.get("orientation") || undefined;
    let m;
    if (path === "/photos") return page(p, per);
    if (path === "/search/photos") return { total: per * 3, total_pages: 3, results: p > 3 ? [] : page(p, per, { orientation }) };
    if ((m = path.match(/^\/users\/([\w-]+)\/photos$/))) return p > 1 ? [] : page(1, 12, { username: m[1] });
    if ((m = path.match(/^\/photos\/([\w-]+)\/download$/))) return { url: `https://images.unsplash.com/photo-${m[1]}?dl=1` };
    return null;
}

/* ---------- images ---------- */

const CRC = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});
const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
};
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

// a textured image in the photo's colour (texture keeps exported PNGs realistic in size)
export function png(hex, w = 240, h = 300) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let seed = r * 65536 + g * 256 + b;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        const row = y * (w * 3 + 1);
        const shade = 0.75 + (0.5 * y) / h;
        for (let x = 0; x < w; x++) {
            const n = 0.85 + rand() * 0.3;
            raw[row + 1 + x * 3] = Math.min(255, r * shade * n);
            raw[row + 2 + x * 3] = Math.min(255, g * shade * n);
            raw[row + 3 + x * 3] = Math.min(255, b * shade * n);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const images = new Map();
function imageFor(url) {
    const n = +(url.pathname.match(/mock(\d+)/)?.[1] ?? 0);
    const hex = PALETTE[n % PALETTE.length];
    if (!images.has(hex)) images.set(hex, png(hex));
    return images.get(hex);
}

/* ---------- wiring ---------- */

export async function mockUnsplash(target) {
    const calls = { downloads: [] };
    await target.route("**/api/unsplash?**", (route) => {
        const url = new URL(route.request().url());
        const body = answer(url);
        if (/\/download$/.test(url.searchParams.get("path") || "")) calls.downloads.push(url.searchParams.get("path"));
        if (body === null) return route.fulfill({ status: 400, json: { error: "unsupported path" } });
        return route.fulfill({ status: 200, json: body, headers: { "cache-control": "no-store" } });
    });
    await target.route("https://images.unsplash.com/**", (route) =>
        route.fulfill({
            status: 200,
            body: imageFor(new URL(route.request().url())),
            headers: { "content-type": "image/png", "access-control-allow-origin": "*", "cache-control": "max-age=3600" },
        })
    );
    return calls;
}
