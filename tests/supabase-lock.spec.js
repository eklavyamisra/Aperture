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

test("cloud: signing in from a stored session doesn't deadlock the Supabase client", async ({ page }) => {
    // routes added after the fixtures' take precedence
    await page.route("**/api/config", (route) => route.fulfill({ status: 200, json: { supabase: { url: "https://abcd1234.supabase.co", anonKey: "x".repeat(40) } } }));
    await page.route(SDK, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: fakeLibrary }));
    await openGrid(page);
    await openBoard(page);
    await expect(page.locator("#pb-account")).toHaveAttribute("data-state", "synced", { timeout: 15000 });
    expect(await page.evaluate(() => window.__sbCalls)).toBeGreaterThan(0);
});
