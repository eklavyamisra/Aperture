// Client error reports -> Vercel function logs (Project → Logs, filter "[client-error]").
//
//   POST /api/log  { kind, message, stack, path, view, build }
//
// Fields are allow-listed and truncated; nothing else from the request is
// logged (no IP, no user agent, no cookies).

const LIMITS = { kind: 20, message: 300, stack: 1500, path: 100, view: 10, build: 40 };

export async function POST(request) {
    const text = await request.text().catch(() => "");
    if (!text || text.length > 6000) return new Response(null, { status: 413 });

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return new Response(null, { status: 400 });
    }
    if (!data || typeof data !== "object" || typeof data.message !== "string") return new Response(null, { status: 400 });

    const clean = {};
    for (const [k, n] of Object.entries(LIMITS)) {
        if (typeof data[k] === "string") clean[k] = data[k].replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, n);
    }
    console.error("[client-error]", JSON.stringify(clean));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
