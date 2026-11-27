// Unit tests for the serverless functions (run with `node --test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../backend/api/unsplash.js";
import { POST } from "../backend/api/log.js";
import { GET as config } from "../backend/api/config.js";
import { GET as boardPage, respond as boardRespond, unlock as boardUnlock } from "../backend/api/board.js";

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

/* ---------- api/board.js (short share links) ---------- */

const photoPin = (n) => ({ kind: "unsplash", photo: { id: `p${n}`, urls: { raw: `https://images.unsplash.com/photo-${n}?ixid=abc` }, user: { name: "Ada" } } });
const sample = { name: "Trip <moodboard> & \"more\"", data: { name: "x", pins: [photoPin(1), photoPin(2), { kind: "note", id: "n-1", note: "</script><script>alert(1)</script>" }, { kind: "link", id: "l-1" }] } };

const tag = (html, attr) => html.match(new RegExp(`<meta ${attr} content="([^"]*)"`))?.[1];
const embedded = (html) => JSON.parse(html.match(/<script type="application\/json" id="shared-board">([^]*?)<\/script>/)[1]);

test("board page: fills the preview tags and embeds the board", async () => {
    const asked = [];
    const res = await boardRespond(new Request("https://aperture.example/api/board?code=AbCdEf1234"), async (code) => (asked.push(code), sample));
    assert.deepEqual(asked, ["AbCdEf1234"]);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.match(res.headers.get("cdn-cache-control"), /s-maxage=15/);
    const html = await res.text();
    assert.match(html, /<base href="\/">/);
    assert.match(html, /<title>Trip &lt;moodboard&gt; &amp; &quot;more&quot; — Aperture<\/title>/);
    assert.equal(tag(html, 'property="og:title"'), "Trip &lt;moodboard&gt; &amp; &quot;more&quot;");
    assert.equal(tag(html, 'property="og:description"'), "2 photos, 1 note and 1 link on a board in Aperture.");
    assert.equal(tag(html, 'property="og:url"'), "https://aperture.example/b/AbCdEf1234");
    const img = new URL(tag(html, 'property="og:image"').replace(/&amp;/g, "&"));
    assert.equal(img.origin + img.pathname, "https://images.unsplash.com/photo-1");
    assert.equal(img.searchParams.get("w"), "1200");
    assert.equal(img.searchParams.get("h"), "630");
    assert.equal(img.searchParams.get("ixid"), "abc");
    assert.equal(tag(html, 'name="twitter:image"'), tag(html, 'property="og:image"'));
    // nothing in the board can break out of the embedded JSON
    assert.equal((html.match(/<\/script>/g) || []).length, (html.match(/<script/g) || []).length);
    const board = embedded(html);
    assert.equal(board.code, "AbCdEf1234");
    assert.equal(board.name, sample.name);
    assert.equal(board.data.pins.length, 4);
    assert.equal(board.data.pins[2].note, sample.data.pins[2].note);
});

test("board page: a board without Unsplash photos uses the site image", async () => {
    const res = await boardRespond(new Request("https://aperture.example/api/board?code=AbCdEf1234"), async () => ({ name: "Notes", data: { pins: [{ kind: "note", id: "n-1" }] } }));
    const html = await res.text();
    assert.equal(tag(html, 'property="og:image"'), "https://aperture.example/img/og.jpg");
    assert.equal(tag(html, 'property="og:description"'), "1 note on a board in Aperture.");
});

test("board page: unknown, malformed and unreachable boards", async () => {
    const missing = await boardRespond(new Request("https://aperture.example/api/board?code=AbCdEf1234"), async () => null);
    assert.equal(missing.status, 404);
    const mhtml = await missing.text();
    assert.deepEqual(embedded(mhtml), { code: "AbCdEf1234", missing: true });
    assert.equal(tag(mhtml, 'property="og:title"'), "Board not found");

    let calls = 0;
    for (const code of ["short", "has-dash123", "../../etc/passwd", "a".repeat(40), ""]) {
        const r = await boardRespond(new Request(`https://aperture.example/api/board?code=${encodeURIComponent(code)}`), async () => (calls++, sample));
        assert.equal(r.status, 404, code);
    }
    assert.equal(calls, 0);

    const real = console.error;
    console.error = () => {};
    try {
        const down = await boardRespond(new Request("https://aperture.example/api/board?code=AbCdEf1234"), async () => {
            throw new Error("offline");
        });
        assert.equal(down.status, 502);
        assert.equal(down.headers.get("cache-control"), "no-store");
        assert.deepEqual(embedded(await down.text()), { code: "AbCdEf1234", error: true });
    } finally {
        console.error = real;
    }
});

test("board page: looks the code up through Supabase's shared_board() with the anon key", async () => {
    const keep = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY, fetch: globalThis.fetch };
    process.env.SUPABASE_URL = "https://abcd1234.supabase.co";
    process.env.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.public-anon";
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify([sample]), { status: 200 });
    };
    try {
        const res = await boardPage(new Request("https://aperture.example/api/board?code=AbCdEf1234"));
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, "https://abcd1234.supabase.co/rest/v1/rpc/shared_board");
        assert.equal(seen[0].init.method, "POST");
        assert.equal(seen[0].init.headers.apikey, process.env.SUPABASE_ANON_KEY);
        assert.deepEqual(JSON.parse(seen[0].init.body), { share_code: "AbCdEf1234" });
    } finally {
        globalThis.fetch = keep.fetch;
        for (const [k, v] of [["SUPABASE_URL", keep.url], ["SUPABASE_ANON_KEY", keep.key]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

/* ---------- passwords (#19) ---------- */

const PASS = "fern-gully";
// a stand-in for shared_board(code, password) with one protected board
const guarded = (state = { fails: 0 }) => async (code, password) => {
    if (code !== "AbCdEf1234") return null;
    if (password === undefined || password === null) return { status: "locked", name: null, data: null };
    if (state.fails >= 10) return { status: "slow", name: null, data: null };
    if (password !== PASS) return state.fails++, { status: "wrong", name: null, data: null };
    return { status: "ok", ...sample };
};

const post = (body) => new Request("https://aperture.example/api/board", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("board page: a password-protected board's page holds no board and a generic preview", async () => {
    const res = await boardRespond(new Request("https://aperture.example/api/board?code=AbCdEf1234"), guarded());
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.deepEqual(embedded(html), { code: "AbCdEf1234", locked: true });
    assert.equal(tag(html, 'property="og:title"'), "Password-protected board");
    assert.equal(tag(html, 'property="og:image"'), "https://aperture.example/img/og.jpg");
    assert.ok(!html.includes("Trip"), "board name leaked");
    assert.ok(!html.includes("images.unsplash.com/photo-1"), "cover leaked");
});

test("board unlock: right password gives the board, wrong ones don't", async () => {
    const state = { fails: 0 };
    const find = guarded(state);
    const ok = await boardUnlock(post({ code: "AbCdEf1234", password: PASS }), find);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const board = await ok.json();
    assert.equal(board.name, sample.name);
    assert.equal(board.data.pins.length, 4);

    const wrong = await boardUnlock(post({ code: "AbCdEf1234", password: "nope" }), find);
    assert.equal(wrong.status, 403);
    assert.deepEqual(await wrong.json(), { error: "wrong" });

    state.fails = 10;
    const slow = await boardUnlock(post({ code: "AbCdEf1234", password: PASS }), find);
    assert.equal(slow.status, 429);

    const gone = await boardUnlock(post({ code: "ZzZzZz9999", password: PASS }), find);
    assert.equal(gone.status, 404);
});

test("board unlock: rejects malformed requests without a lookup", async () => {
    let calls = 0;
    const find = async () => (calls++, null);
    for (const body of ["", "not json", "x".repeat(3000), { code: "AbCdEf1234" }, { code: "AbCdEf1234", password: "" }, { code: "bad", password: PASS }, { code: "AbCdEf1234", password: 5 }, { code: "AbCdEf1234", password: "p".repeat(201) }]) {
        const r = await boardUnlock(post(body), find);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal(calls, 0);
});

test("board unlock: sends the password to shared_board() in the body", async () => {
    const keep = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY, fetch: globalThis.fetch };
    process.env.SUPABASE_URL = "https://abcd1234.supabase.co";
    process.env.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.public-anon";
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify([{ status: "ok", ...sample }]), { status: 200 });
    };
    try {
        const { POST } = await import("../backend/api/board.js");
        const res = await POST(post({ code: "AbCdEf1234", password: PASS }));
        assert.equal(res.status, 200);
        assert.equal(seen[0].url, "https://abcd1234.supabase.co/rest/v1/rpc/shared_board");
        assert.deepEqual(JSON.parse(seen[0].init.body), { share_code: "AbCdEf1234", password: PASS });
    } finally {
        globalThis.fetch = keep.fetch;
        for (const [k, v] of [["SUPABASE_URL", keep.url], ["SUPABASE_ANON_KEY", keep.key]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});
