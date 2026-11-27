// The real Supabase wrapper in cloud.js (supabaseBackend), against a stand-in
// for the supabase-js library that keeps its one awkward rule: while the
// client starts up it holds an auth lock, tells listeners about the stored
// session *inside* that lock and waits for them, and every query needs the
// lock too. A listener that waits on a query there never finishes, and sync
// hangs on "Syncing…" for good.
import { test, expect, openGrid, openBoard } from "./fixtures.js";

const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";

// runs in the page as the "library"
const fakeLibrary = `
window.supabase = {
    createClient() {
        let lock = Promise.resolve();
        const withLock = (fn) => {
            const p = lock.then(fn);
            lock = p.catch(() => {});
            return p;
        };
        const listeners = [];
        const session = { user: { id: "user-lock", email: "lock@example.com" }, access_token: "t" };
        window.__sbCalls = 0;
        // start-up, like GoTrueClient._initialize -> _recoverAndRefresh -> _notifyAllSubscribers
        withLock(async () => {
            await new Promise((r) => setTimeout(r, 50));
            await Promise.all(listeners.map((cb) => cb("SIGNED_IN", session)));
        });
        const query = (rows) => {
            const q = {
                select: () => q, in: () => q, eq: () => q, limit: () => q,
                upsert: () => withLock(async () => (window.__sbCalls++, { data: null, error: null })),
                then: (ok, bad) => withLock(async () => (window.__sbCalls++, { data: rows, error: null })).then(ok, bad),
            };
            return q;
        };
        return {
            auth: {
                getSession: () => withLock(async () => ({ data: { session }, error: null })),
                onAuthStateChange(cb) {
                    listeners.push(cb);
                    return { data: { subscription: { unsubscribe() {} } } };
                },
                signOut: async () => ({ error: null }),
            },
            from: () => query([]),
            storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: "none" }), list: async () => ({ data: [], error: null }) }) },
            rpc: async () => ({ data: null, error: null }),
        };
    },
};
`;

// a stand-in that's signed out until localStorage.__signedIn is set (the "email link" was opened),
// and records where sign-in asked to come back to
const signInLibrary = `
window.supabase = {
    createClient() {
        const listeners = [];
        const session = localStorage.getItem("__signedIn") ? { user: { id: "user-back", email: "back@example.com" }, access_token: "t" } : null;
        if (session) setTimeout(() => listeners.forEach((cb) => cb("SIGNED_IN", session)), 50);
        const query = () => {
            const q = { select: () => q, in: () => q, eq: () => q, limit: () => q, upsert: async () => ({ data: null, error: null }), then: (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad) };
            return q;
        };
        return {
            auth: {
                getSession: async () => ({ data: { session }, error: null }),
                onAuthStateChange(cb) {
                    listeners.push(cb);
                    return { data: { subscription: { unsubscribe() {} } } };
                },
                signInWithOtp: async (o) => ((window.__otp = o), { error: null }),
                signOut: async () => ({ error: null }),
            },
            from: () => query(),
            storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: "none" }), list: async () => ({ data: [], error: null }) }) },
            rpc: async () => ({ data: null, error: null }),
        };
    },
};
`;

test("cloud: signing in comes back to the same search, wall and open board", async ({ page }) => {
    await page.route("**/api/config", (route) => route.fulfill({ status: 200, json: { supabase: { url: "https://abcd1234.supabase.co", anonKey: "x".repeat(40) } } }));
    await page.route(SDK, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: signInLibrary }));
    await openGrid(page, "?q=forest");
    await openBoard(page);

    // ask for an email link with the board open
    await page.locator("#pb-account").click();
    await page.locator("#acct-email").fill("back@example.com");
    await page.locator("#acct-form button[type=submit]").click();
    await expect.poll(() => page.evaluate(() => window.__otp?.options?.emailRedirectTo)).toBe(`${new URL(page.url()).origin}/?q=forest&view=canvas`);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aperture:return")).board)).toBe(true);

    // the link brings them back signed in: same search, and the board opens by itself
    await page.evaluate(() => localStorage.setItem("__signedIn", "1"));
    await page.goto("/?q=forest&view=canvas");
    await expect(page.locator("#pb")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#pb-account")).toHaveAttribute("data-state", "synced", { timeout: 15000 });
    expect(await page.evaluate(() => state.query)).toBe("forest");
    expect(await page.evaluate(() => localStorage.getItem("aperture:return"))).toBeNull();

    // an ordinary visit later doesn't open the board on its own
    await page.goto("/");
    await page.waitForFunction(() => window.pins && state.photos.length > 5 && !state.loading, null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    await expect(page.locator("#pb")).toBeHidden();
});

test("cloud: signing in from a stored session doesn't deadlock the Supabase client", async ({ page }) => {
    // routes added after the fixtures' take precedence
    await page.route("**/api/config", (route) => route.fulfill({ status: 200, json: { supabase: { url: "https://abcd1234.supabase.co", anonKey: "x".repeat(40) } } }));
    await page.route(SDK, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: fakeLibrary }));
    await openGrid(page);
    await openBoard(page);
    await expect(page.locator("#pb-account")).toHaveAttribute("data-state", "synced", { timeout: 15000 });
    expect(await page.evaluate(() => window.__sbCalls)).toBeGreaterThan(0);
});
