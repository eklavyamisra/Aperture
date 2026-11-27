// Unit tests for the two serverless functions (run with `node --test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../backend/api/unsplash.js";
import { POST } from "../backend/api/log.js";
import { GET as config } from "../backend/api/config.js";

/* ---------- api/unsplash.js ---------- */

async function proxy(qs, { key = "test-key", upstream } = {}) {
    const seen = [];
    const realFetch = globalThis.fetch;
    const realKey = process.env.UNSPLASH_ACCESS_KEY;
    if (key) process.env.UNSPLASH_ACCESS_KEY = key;
    else delete process.env.UNSPLASH_ACCESS_KEY;
    globalThis.fetch = async (url, init) => {
        seen.push({ url: new URL(url), init });
        return upstream ? upstream() : new Response("[]", { status: 200 });
    };
    try {
        const res = await GET(new Request(`http://localhost/api/unsplash?${qs}`));
        return { res, seen };
    } finally {
        globalThis.fetch = realFetch;
        if (realKey === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
        else process.env.UNSPLASH_ACCESS_KEY = realKey;
    }
}

test("proxy: forwards allowed params with the key, drops the rest", async () => {
    const { res, seen } = await proxy("path=/search/photos&query=tokyo&page=2&client_id=stolen&secret=x");
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    const { url, init } = seen[0];
    assert.equal(url.origin + url.pathname, "https://api.unsplash.com/search/photos");
    assert.deepEqual(Object.fromEntries(url.searchParams), { query: "tokyo", page: "2" });
    assert.equal(init.headers.Authorization, "Client-ID test-key");
    assert.match(res.headers.get("cdn-cache-control"), /s-maxage=3600/);
});

test("proxy: rejects paths outside the allow-list", async () => {
    for (const path of ["/me", "/photos/../me", "/photos/abc/statistics", "https://evil.example/photos", ""]) {
        const { res, seen } = await proxy(`path=${encodeURIComponent(path)}`);
        assert.equal(res.status, 400, path);
        assert.equal(seen.length, 0, path);
    }
});

test("proxy: download tracking is never cached", async () => {
    const { res, seen } = await proxy("path=/photos/abc123/download&ixid=xyz");
    assert.equal(seen[0].url.searchParams.get("ixid"), "xyz");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("cdn-cache-control"), null);
});

test("proxy: upstream errors pass through uncached; no key and no network are handled", async () => {
    const limited = await proxy("path=/photos", { upstream: () => new Response("Rate Limit Exceeded", { status: 403 }) });
    assert.equal(limited.res.status, 403);
    assert.equal(limited.res.headers.get("cache-control"), "no-store");

    const down = await proxy("path=/photos", { upstream: () => Promise.reject(new Error("offline")) });
    assert.equal(down.res.status, 502);

    const nokey = await proxy("path=/photos", { key: "" });
    assert.equal(nokey.res.status, 500);
    assert.equal(nokey.seen.length, 0);
});

test("proxy: long values are truncated", async () => {
    const { seen } = await proxy(`path=/search/photos&query=${"a".repeat(500)}`);
    assert.equal(seen[0].url.searchParams.get("query").length, 200);
});

/* ---------- api/log.js ---------- */

async function log(body) {
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
        const res = await POST(new Request("http://localhost/api/log", { method: "POST", body }));
        return { status: res.status, lines };
    } finally {
        console.error = real;
    }
}

test("log: writes allow-listed, trimmed fields only", async () => {
    const { status, lines } = await log(JSON.stringify({ kind: "error", message: "boom\u0007", stack: "s".repeat(3000), path: "/", view: "canvas", ip: "1.2.3.4", email: "a@b.c" }));
    assert.equal(status, 204);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[client-error] "));
    const logged = JSON.parse(lines[0].slice("[client-error] ".length));
    assert.deepEqual(Object.keys(logged).sort(), ["kind", "message", "path", "stack", "view"]);
    assert.equal(logged.message, "boom");
    assert.equal(logged.stack.length, 1500);
});

test("log: rejects bad bodies without logging", async () => {
    for (const [body, code] of [["", 413], ["x".repeat(7000), 413], ["not json", 400], ["null", 400], ['{"message":5}', 400]]) {
        const { status, lines } = await log(body);
        assert.equal(status, code, body.slice(0, 20));
        assert.equal(lines.length, 0);
    }
});

/* ---------- api/config.js ---------- */

async function cfg(env) {
    const keep = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        const r = await config(new Request("http://localhost/api/config"));
        return r.json();
    } finally {
        if (keep.url === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = keep.url;
        if (keep.key === undefined) delete process.env.SUPABASE_ANON_KEY;
        else process.env.SUPABASE_ANON_KEY = keep.key;
    }
}

test("config: empty until Supabase is set, then only the public settings", async () => {
    assert.deepEqual(await cfg({ SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined }), {});
    const anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.public-anon";
    assert.deepEqual(await cfg({ SUPABASE_URL: "https://abcd1234.supabase.co/", SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: "secret" }), {
        supabase: { url: "https://abcd1234.supabase.co", anonKey: anon },
    });
    // anything that isn't a Supabase project URL is ignored
    assert.deepEqual(await cfg({ SUPABASE_URL: "https://evil.example.com", SUPABASE_ANON_KEY: anon }), {});
    assert.deepEqual(await cfg({ SUPABASE_URL: "http://abcd1234.supabase.co", SUPABASE_ANON_KEY: anon }), {});
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});
