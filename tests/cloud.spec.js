// Accounts and cloud sync, against an in-memory stand-in for Supabase that
// lives in the test process. Two browser profiles play two devices signed in
// to the same account. Ownership is enforced like Supabase's row-level
// security: each call only sees the signed-in user's rows and files.
import fs from "node:fs";
import { test, expect, openGrid, openBoard, boardItems, png } from "./fixtures.js";
import { respond as boardPage } from "../backend/api/board.js";

class FakeCloud {
    constructor() {
        this.users = new Map(); // email -> id
        this.sessions = new Map(); // browser context -> user
        this.rows = new Map(); // `${owner}|${id}` -> row
        this.blobs = new Map(); // path -> data URL
        this.shares = new Map(); // code -> { owner, boardId }
    }
    // what Supabase's public shared_board(code) returns (schema.sql)
    sharedBoard(code) {
        const s = this.shares.get(code);
        const r = s && this.rows.get(`${s.owner}|${s.boardId}`);
        if (!r || r.deleted || !r.data) return null;
        const data = JSON.parse(JSON.stringify(r.data));
        data.pins = data.pins.filter((x) => x.kind !== "upload");
        return { name: r.name, data, updated: r.updated };
    }
    userFor(email) {
        if (!this.users.has(email)) this.users.set(email, `user-${this.users.size + 1}`);
        return { id: this.users.get(email), email };
    }
    boards(email, { live = true } = {}) {
        const id = this.users.get(email);
        return [...this.rows.values()].filter((r) => r.owner === id && (!live || !r.deleted));
    }
    call(ctx, method, arg) {
        const me = this.sessions.get(ctx) || null;
        const mine = () => {
            if (!me) throw new Error("not signed in");
            return [...this.rows.values()].filter((r) => r.owner === me.id);
        };
        switch (method) {
            case "session":
                return me;
            case "signIn": {
                const u = this.userFor(arg);
                this.sessions.set(ctx, u);
                return u;
            }
            case "signOut":
                this.sessions.delete(ctx);
                return null;
            case "list":
                return mine().map(({ id, updated, deleted }) => ({ id, updated, deleted }));
            case "get":
                return mine()
                    .filter((r) => arg.includes(r.id))
                    .map(({ id, data, updated }) => ({ id, data: JSON.parse(JSON.stringify(data)), updated }));
            case "upsert":
                mine();
                arg.forEach((r) => this.rows.set(`${me.id}|${r.id}`, { ...JSON.parse(JSON.stringify(r)), owner: me.id }));
                return null;
            case "putBlob":
                mine();
                if (!arg.path.startsWith(`${me.id}/`)) throw new Error("not your folder");
                this.blobs.set(arg.path, arg.data);
                return null;
            case "getBlob":
                mine();
                return arg.startsWith(`${me.id}/`) ? this.blobs.get(arg) || null : null;
            case "findShare":
                mine();
                return [...this.shares].find(([, s]) => s.owner === me.id && s.boardId === arg)?.[0] || null;
            case "createShare": {
                mine();
                if (!/^[A-Za-z0-9]{10,16}$/.test(arg.code)) throw new Error("bad code");
                if (!this.rows.has(`${me.id}|${arg.boardId}`)) throw new Error("board isn't in the account");
                if (this.shares.has(arg.code) || [...this.shares.values()].some((s) => s.owner === me.id && s.boardId === arg.boardId)) throw new Error("duplicate");
                this.shares.set(arg.code, { owner: me.id, boardId: arg.boardId });
                return null;
            }
            case "wipe":
                [...this.shares].filter(([, s]) => s.owner === me.id).forEach(([c]) => this.shares.delete(c));
                mine().forEach((r) => this.rows.delete(`${me.id}|${r.id}`));
                [...this.blobs.keys()].filter((k) => k.startsWith(`${me.id}/`)).forEach((k) => this.blobs.delete(k));
                return null;
        }
        throw new Error(`unknown call ${method}`);
    }
}

async function installCloud(context, cloud) {
    await context.exposeBinding("__cloud", ({ context: ctx }, method, arg) => cloud.call(ctx, method, arg));
    await context.addInitScript(() => {
        const listeners = [];
        const call = (m, a) => window.__cloud(m, a);
        const toData = (blob) =>
            new Promise((res) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.readAsDataURL(blob);
            });
        window.__apertureBackend = {
            session: () => call("session"),
            onChange: (cb) => listeners.push(cb),
            // the fake skips the email: "clicking the link" happens straight away
            async signInEmail(email) {
                const u = await call("signIn", email);
                setTimeout(() => listeners.forEach((f) => f(u)), 50);
            },
            async signInGoogle() {
                throw new Error("not available in tests");
            },
            async signOut() {
                await call("signOut");
                listeners.forEach((f) => f(null));
            },
            list: () => call("list"),
            get: (ids) => call("get", ids),
            upsert: (rows) => call("upsert", rows),
            async putBlob(path, blob) {
                await call("putBlob", { path, data: await toData(blob) });
            },
            async getBlob(path) {
                const d = await call("getBlob", path);
                return d ? (await fetch(d)).blob() : null;
            },
            findShare: (boardId) => call("findShare", boardId),
            createShare: (code, boardId) => call("createShare", { code, boardId }),
            wipe: () => call("wipe"),
        };
    });
}

// /b/<code> pages come from the real page function, reading boards from the fake
async function serveSharePages(context, cloud) {
    await context.route("**/b/*", async (route) => {
        const res = await boardPage(new Request(route.request().url()), async (code) => cloud.sharedBoard(code));
        await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    });
}

async function signIn(page, email) {
    await page.locator("#pb-account").click();
    await expect(page.locator("#acct")).toBeVisible();
    await page.locator("#acct-email").fill(email);
    await page.locator("#acct-form button[type=submit]").click();
    await expect(page.locator("#acct-who")).toHaveText(email);
    await expect(page.locator("#pb-account")).toHaveAttribute("data-state", "synced", { timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#acct")).toBeHidden();
}

const boardCount = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aperture:boards")).list.length);
const syncNow = async (page) => {
    await page.evaluate(() => window.cloud.sync());
    await expect(page.locator("#pb-account")).toHaveAttribute("data-state", "synced", { timeout: 15000 });
};

test("cloud: hidden when accounts aren't set up", async ({ page }) => {
    await openGrid(page);
    await openBoard(page);
    await page.waitForTimeout(500);
    await expect(page.locator("#pb-account")).toBeHidden();
    expect(await page.evaluate(() => window.cloud.state())).toBe("off");
});

test("cloud: sign-in moves boards to the account and keeps two devices in step", async ({ page, freshPage }, info) => {
    const cloud = new FakeCloud();
    const A = page;
    const B = freshPage;
    await installCloud(A.context(), cloud);
    await installCloud(B.context(), cloud);
    A.on("dialog", (d) => d.accept());
    B.on("dialog", (d) => d.accept());
    const email = "ada@example.com";

    await test.step("device A builds a board before signing in", async () => {
        await openGrid(A);
        await A.evaluate(() => state.photos.slice(0, 3).forEach((p) => window.pins.toggle(p)));
        await openBoard(A);
        const file = info.outputPath("upload.png");
        fs.writeFileSync(file, png("#3a7d44", 320, 240));
        await A.setInputFiles("#pb-file", file);
        await A.waitForSelector(".pb-card.is-upload img[src^='blob:']", { timeout: 15000 });
        await A.locator("#pb-area").focus();
        await A.keyboard.press("n");
        await A.waitForTimeout(300);
        await A.keyboard.type("Shot list for Friday");
        await A.keyboard.press("Escape");
        await expect(A.locator("#pb-account")).toBeVisible();
        await expect(A.locator("#pb-account")).toHaveText(/Sign in/);
    });

    await test.step("signing in uploads the existing board and its image", async () => {
        await signIn(A, email);
        const rows = cloud.boards(email);
        expect(rows).toHaveLength(1);
        const kinds = rows[0].data.pins.map((x) => x.kind).sort();
        expect(kinds).toEqual(["note", "unsplash", "unsplash", "unsplash", "upload"]);
        const up = rows[0].data.pins.find((x) => x.kind === "upload");
        expect(cloud.blobs.get(`${cloud.users.get(email)}/${up.id}`)).toMatch(/^data:image\//);
    });

    await test.step("device B signs in and gets the board, image included", async () => {
        await openGrid(B);
        await openBoard(B);
        await signIn(B, email);
        await expect(B.locator(".pb-card")).toHaveCount(5);
        await expect(B.locator(".pb-card.is-upload img[src^='blob:']")).toHaveCount(1, { timeout: 15000 });
        expect(await boardCount(B)).toBe(1); // B's empty starter board was dropped
        await expect(B.locator(".pb-card.is-note .pb-note")).toHaveValue("Shot list for Friday");
    });

    await test.step("an edit on B reaches A", async () => {
        await B.locator("#pb-area").focus();
        await B.keyboard.press("n");
        await B.waitForTimeout(300);
        await B.keyboard.type("from B");
        await B.keyboard.press("Escape");
        await expect.poll(() => cloud.boards(email)[0].data.pins.some((x) => x.note === "from B"), { timeout: 15000 }).toBe(true);
        await syncNow(A);
        expect((await boardItems(A)).some((x) => x.note === "from B")).toBe(true);
        await expect(A.locator(".pb-card.is-note")).toHaveCount(2);
    });

    await test.step("new and deleted boards follow across devices", async () => {
        await A.locator("#pb-picker-btn").click();
        await A.locator("#pb-new").click();
        await A.locator("#pb-name").fill("Location scout");
        await A.keyboard.press("Enter");
        await expect.poll(() => cloud.boards(email).map((r) => r.name).sort(), { timeout: 15000 }).toEqual(["Location scout", "My board"]);
        await syncNow(B);
        expect(await boardCount(B)).toBe(2);

        await A.locator("#pb-delete").click(); // confirm() accepted
        await expect.poll(() => cloud.boards(email).length, { timeout: 15000 }).toBe(1);
        await syncNow(B);
        expect(await boardCount(B)).toBe(1);
        await expect(B.locator("#pb-picker-name")).toHaveText("My board");
    });

    await test.step("signing out clears this device; the account keeps everything", async () => {
        await B.locator("#pb-account").click();
        await B.locator("#acct-signout").click();
        await expect(B.locator("#acct")).toBeHidden();
        await expect(B.locator("#pb-account")).toHaveText(/Sign in/);
        await expect(B.locator(".pb-card")).toHaveCount(0);
        expect(cloud.boards(email)).toHaveLength(1);
        expect(cloud.boards(email)[0].data.pins).toHaveLength(6);
    });

    await test.step("Delete my cloud data empties the account", async () => {
        await A.locator("#pb-account").click();
        await A.locator("#acct-wipe").click(); // confirm() accepted
        await expect(A.locator("#acct")).toBeHidden();
        expect(cloud.boards(email, { live: false })).toHaveLength(0);
        expect([...cloud.blobs.keys()]).toHaveLength(0);
        await expect(A.locator(".pb-card")).toHaveCount(0);
    });
});

test("cloud: a different account on the same device doesn't inherit boards", async ({ page }) => {
    const cloud = new FakeCloud();
    await installCloud(page.context(), cloud);
    await openGrid(page);
    await page.evaluate(() => state.photos.slice(0, 2).forEach((p) => window.pins.toggle(p)));
    await openBoard(page);
    await signIn(page, "first@example.com");
    expect(cloud.boards("first@example.com")).toHaveLength(1);

    // the first session ends on its own (no sign-out), then someone else signs in
    await page.evaluate(() => localStorage.removeItem("aperture:auth"));
    cloud.sessions.clear();
    await page.reload();
    await page.waitForFunction(() => window.pins && state.photos.length > 5 && !state.loading, null, { timeout: 30000 });
    await openBoard(page);
    await signIn(page, "second@example.com");
    await expect(page.locator(".pb-card")).toHaveCount(0);
    expect(cloud.boards("second@example.com")).toHaveLength(0);
    expect(cloud.boards("first@example.com")).toHaveLength(1);
});

test("cloud: a signed-in board gets a short share link that stays current", async ({ page, freshPage }, info) => {
    const cloud = new FakeCloud();
    const A = page;
    const B = freshPage;
    await installCloud(A.context(), cloud);
    await serveSharePages(B.context(), cloud);
    const email = "lin@example.com";
    let link;

    await test.step("Share on a signed-in board copies a /b/ link", async () => {
        await openGrid(A);
        await A.evaluate(() => state.photos.slice(0, 3).forEach((p) => window.pins.toggle(p)));
        await openBoard(A);
        const file = info.outputPath("upload.png");
        fs.writeFileSync(file, png("#c8553d", 320, 240));
        await A.setInputFiles("#pb-file", file);
        await A.waitForSelector(".pb-card.is-upload img[src^='blob:']", { timeout: 15000 });
        await signIn(A, email);
        await A.locator("#pb-share").click();
        await expect(A.locator("#pb-share")).toContainText("Link copied", { timeout: 15000 });
        await expect(A.locator("#toast")).toContainText("as you keep editing");
        await expect(A.locator("#toast")).toContainText("1 uploaded image isn't included");
        link = await A.evaluate(() => navigator.clipboard.readText());
        expect(link).toMatch(/^http:\/\/localhost:\d+\/b\/[A-Za-z0-9]{10}$/);
        expect(cloud.shares.size).toBe(1);
    });

    await test.step("the link opens the board read-only, without uploads", async () => {
        await B.goto(link);
        expect(await B.title()).toBe("My board — Aperture");
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await expect(B.locator(".pb-card")).toHaveCount(3);
        await expect(B.locator("#pb-shared-name")).toHaveText("My board");
        expect(await B.evaluate(() => location.pathname)).toMatch(/^\/b\//);
    });

    await test.step("later edits reach the same link", async () => {
        await A.locator("#pb-area").focus();
        await A.keyboard.press("n");
        await A.waitForTimeout(300);
        await A.keyboard.type("Call sheet");
        await A.keyboard.press("Escape");
        await A.waitForTimeout(2200); // the Share label resets
        await A.locator("#pb-share").click();
        await expect(A.locator("#pb-share")).toContainText("Link copied", { timeout: 15000 });
        expect(await A.evaluate(() => navigator.clipboard.readText())).toBe(link);
        expect(cloud.shares.size).toBe(1);
        await B.reload();
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await expect(B.locator(".pb-card")).toHaveCount(4);
        await expect(B.locator(".pb-card.is-note .pb-note")).toHaveValue("Call sheet");
    });

    await test.step("Save a copy keeps it and returns to the app's address", async () => {
        await B.locator("#pb-keep").click();
        await expect(B.locator("#pb")).not.toHaveClass(/is-readonly/);
        expect(await B.evaluate(() => location.pathname)).toBe("/");
        expect(await boardCount(B)).toBe(2);
    });

    await test.step("a deleted board's link says so", async () => {
        // deleted on another device: the row becomes a tombstone
        const [{ owner, boardId }] = cloud.shares.values();
        cloud.rows.get(`${owner}|${boardId}`).deleted = true;
        await B.goto(link);
        await expect(B.locator("#toast")).toContainText("doesn't exist any more", { timeout: 30000 });
        expect(await B.evaluate(() => location.pathname)).toBe("/");
    });
});
