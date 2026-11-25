// Unsplash proxy — keeps the access key on the server and lets Vercel's CDN
// cache responses, so a traffic spike reuses cached pages instead of burning
// the hourly rate limit.
//
//   GET /api/unsplash?path=/search/photos&query=tokyo&page=1
//   GET /api/unsplash?path=/photos&page=2
//   GET /api/unsplash?path=/photos/<id>/download   (download tracking)

const API = "https://api.unsplash.com";

// only these endpoints (and only these params) are forwarded
const ROUTES = [
    { re: /^\/photos$/, params: ["page", "per_page", "order_by"], ttl: 3600 },
    { re: /^\/search\/photos$/, params: ["query", "page", "per_page", "order_by", "color", "orientation"], ttl: 3600 },
    { re: /^\/photos\/[A-Za-z0-9_-]{1,40}\/download$/, params: ["ixid"], ttl: 0 },
];

const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });

export async function GET(request) {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return json(500, { error: "UNSPLASH_ACCESS_KEY is not set" });

    const incoming = new URL(request.url);
    const path = incoming.searchParams.get("path") || "";
    const route = ROUTES.find((r) => r.re.test(path));
    if (!route) return json(400, { error: "unsupported path" });

    const target = new URL(API + path);
    for (const name of route.params) {
        const v = incoming.searchParams.get(name);
        if (v != null && v !== "") target.searchParams.set(name, v.slice(0, 200));
    }

    let upstream;
    try {
        upstream = await fetch(target, {
            headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
        });
    } catch (e) {
        return json(502, { error: "upstream unreachable" });
    }

    // rate-limit headers are deliberately not forwarded: with CDN caching
    // they'd be stale, and visitors don't need to see them
    const headers = { "content-type": "application/json; charset=utf-8" };

    if (upstream.ok && route.ttl) {
        // browser keeps it 5 min; Vercel's edge keeps it an hour and serves
        // stale for a day while it refreshes in the background
        headers["cache-control"] = "public, max-age=300";
        headers["cdn-cache-control"] = `public, s-maxage=${route.ttl}, stale-while-revalidate=86400`;
    } else {
        headers["cache-control"] = "no-store";
    }

    return new Response(await upstream.text(), { status: upstream.status, headers });
}
