// Accounts and cloud sync, against an in-memory stand-in for Supabase that
// lives in the test process. Two browser profiles play two devices signed in
// to the same account. Ownership is enforced like Supabase's row-level
// security: each call only sees the signed-in user's rows and files.
import fs from "node:fs";
import { test, expect, openGrid, openBoard, boardItems, png } from "./fixtures.js";
import { respond as boardPage, unlock as boardUnlock } from "../backend/api/board.js";

class FakeCloud {
    constructor() {
        this.users = new Map(); // email -> id
        this.sessions = new Map(); // browser context -> user
        this.rows = new Map(); // `${owner}|${id}` -> row
        this.blobs = new Map(); // path -> data URL
        this.shares = new Map(); // code -> { owner, boardId, pass, fails }
        this.comments = []; // { id, owner, boardId, author, author_name, item_id, body, created_at }
        this.editors = new Set(); // `${owner}|${boardId}|${member}` (#21)
        this.subs = new Map(); // channel id -> { page, room, user, me }: a stand-in for Realtime
        this.saves = 0;
        this.n = 0;
    }
    // #21: the shares trigger in schema.sql removes a board's editors
    dropEditors(owner, boardId) {
        for (const k of [...this.editors]) if (k.startsWith(`${owner}|${boardId}|`)) this.editors.delete(k);
    }
    // live_room(): the board behind a room, for its owner and editors only
    liveRoom(me, room) {
        if (!me) return null;
        const s = [...this.shares.values()].find((x) => x.room === room);
        const r = s && this.rows.get(`${s.owner}|${s.boardId}`);
        if (!s || !s.editable || !r || r.deleted) return null;
        if (s.owner !== me.id && !this.editors.has(`${s.owner}|${s.boardId}|${me.id}`)) return null;
        return s;
    }
    deliver(id, ...args) {
        const sub = this.subs.get(id);
        sub?.page.evaluate(([i, a]) => window.__liveIn?.(i, ...a), [id, args]).catch(() => this.subs.delete(id));
    }
    presence(room) {
        const list = [...this.subs.values()].filter((x) => x.room === room).map((x) => x.me);
        this.subs.forEach((x, id) => x.room === room && this.deliver(id, "presence", list));
    }
    // share_check(): { status, owner, boardId } or null; the owner needs no password
    shareCheck(code, password, me) {
        const s = this.shares.get(code);
        const r = s && this.rows.get(`${s.owner}|${s.boardId}`);
        if (!r || r.deleted || !r.data) return null;
        if (s.pass && s.owner !== me?.id) {
            if (password == null) return { status: "locked" };
            if (s.fails >= 10) return { status: "slow" };
            if (password !== s.pass) return s.fails++, { status: "wrong" };
        }
        return { status: "ok", owner: s.owner, boardId: s.boardId };
    }
    commentRows(owner, boardId, me) {
        return this.comments
            .filter((c) => c.owner === owner && c.boardId === boardId)
            .map((c) => ({ id: c.id, author_name: c.author_name, item_id: c.item_id, body: c.body, created_at: c.created_at, mine: c.author === me?.id, can_delete: !!me && (c.author === me.id || c.owner === me.id) }));
    }
    insertComment(me, owner, boardId, c) {
        if (!me) throw new Error("sign in to comment");
        const name = String(c.name || "").trim();
        const body = String(c.body || "").trim();
        if (!name || name.length > 40 || !body || body.length > 1000) throw new Error("bad comment");
        this.comments.push({ id: `c${++this.n}`, owner, boardId, author: me.id, author_name: name, item_id: c.itemId ?? null, body, created_at: new Date().toISOString() });
    }
    // what Supabase's public shared_board(code, password) returns (schema.sql)
    sharedBoard(code, password = null) {
        const s = this.shares.get(code);
        const r = s && this.rows.get(`${s.owner}|${s.boardId}`);
        if (!r || r.deleted || !r.data) return null;
        const none = (status) => ({ status, name: null, data: null, updated: null });
        if (s.pass) {
            if (password == null) return none("locked");
            if (s.fails >= 10) return none("slow");
            if (password !== s.pass) return s.fails++, none("wrong");
        }
        const data = JSON.parse(JSON.stringify(r.data));
        data.pins = data.pins.filter((x) => x.kind !== "upload");
        return { status: "ok", name: r.name, data, updated: r.updated, editable: !!s.editable };
    }
    shareOf(boardOwner, boardId) {
        return [...this.shares].find(([, s]) => s.owner === boardOwner && s.boardId === boardId) || null;
    }
    userFor(email) {
        if (!this.users.has(email)) this.users.set(email, `user-${this.users.size + 1}`);
        return { id: this.users.get(email), email };
    }
    boards(email, { live = true } = {}) {
        const id = this.users.get(email);
        return [...this.rows.values()].filter((r) => r.owner === id && (!live || !r.deleted));
    }
    call(ctx, method, arg, page) {
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
            case "findShare": {
                mine();
                const hit = this.shareOf(me.id, arg);
                return hit ? { code: hit[0], protected: !!hit[1].pass, can_edit: !!hit[1].editable, room: hit[1].room } : null;
            }
            case "renameShare": {
                mine();
                const hit = this.shareOf(me.id, arg.boardId);
                if (!hit || !/^[A-Za-z0-9]{10,16}$/.test(arg.code)) throw new Error("can't rename");
                this.shares.delete(hit[0]);
                this.shares.set(arg.code, hit[1]);
                this.dropEditors(me.id, arg.boardId);
                return null;
            }
            case "setSharePassword": {
                mine();
                const hit = this.shareOf(me.id, arg.boardId);
                if (!hit) throw new Error("board is not shared");
                if (arg.password != null && (arg.password.length < 4 || arg.password.length > 72)) throw new Error("password must be 4 to 72 characters");
                Object.assign(hit[1], { pass: arg.password ?? null, fails: 0 });
                this.dropEditors(me.id, arg.boardId);
                return null;
            }
            case "deleteShare": {
                mine();
                const hit = this.shareOf(me.id, arg);
                if (hit) this.shares.delete(hit[0]);
                this.dropEditors(me.id, arg);
                return null;
            }
            case "createShare": {
                mine();
                if (!/^[A-Za-z0-9]{10,16}$/.test(arg.code)) throw new Error("bad code");
                if (!this.rows.has(`${me.id}|${arg.boardId}`)) throw new Error("board isn't in the account");
                if (this.shares.has(arg.code) || [...this.shares.values()].some((s) => s.owner === me.id && s.boardId === arg.boardId)) throw new Error("duplicate");
                this.shares.set(arg.code, { owner: me.id, boardId: arg.boardId, pass: null, fails: 0, editable: false, room: `room${++this.n}x${Math.random().toString(36).slice(2)}` });
                return null;
            }
            case "setShareEditable": {
                mine();
                const hit = this.shareOf(me.id, arg.boardId);
                if (!hit) throw new Error("board is not shared");
                if (hit[1].editable && !arg.on) this.dropEditors(me.id, arg.boardId);
                hit[1].editable = !!arg.on;
                return null;
            }
            case "joinBoard": {
                if (!me) throw new Error("sign in to edit");
                const ok = this.shareCheck(arg.code, arg.password, me);
                if (!ok) return null;
                if (ok.status !== "ok") return { status: ok.status };
                const s = this.shares.get(arg.code);
                if (!s.editable) return { status: "view" };
                if (s.owner !== me.id) this.editors.add(`${s.owner}|${s.boardId}|${me.id}`);
                const b = this.sharedBoard(arg.code, arg.password);
                return { status: "ok", room: s.room, name: b.name, data: b.data, updated: b.updated };
            }
            case "liveBoard": {
                const s = this.liveRoom(me, arg);
                if (!s) return null;
                const r = this.rows.get(`${s.owner}|${s.boardId}`);
                const data = JSON.parse(JSON.stringify(r.data));
                data.pins = data.pins.filter((x) => x.kind !== "upload");
                return { name: r.name, data, updated: r.updated };
            }
            case "saveLive": {
                // save_live_board(): keeps the owner's uploads and the threads tied to them
                if (!me) throw new Error("sign in to edit");
                const s = this.liveRoom(me, arg.room);
                if (!s) throw new Error("not allowed");
                const key = `${s.owner}|${s.boardId}`;
                const r = this.rows.get(key);
                const ups = r.data.pins.filter((x) => x.kind === "upload");
                const upIds = new Set(ups.map((x) => x.id));
                const data = JSON.parse(JSON.stringify(arg.data));
                data.pins = data.pins.filter((x) => x.kind !== "upload").concat(ups);
                data.threads = data.threads.concat(r.data.threads.filter((t) => upIds.has(t.a) || upIds.has(t.b)));
                data.name = String(data.name || "").trim().slice(0, 60) || r.name;
                const updated = Math.max(arg.edited, r.updated + 1);
                this.rows.set(key, { ...r, name: data.name, data, updated });
                this.saves++;
                return updated;
            }
            case "liveSubscribe": {
                if (!this.liveRoom(me, arg.room)) return false;
                this.subs.set(arg.id, { page, room: arg.room, user: me, me: arg.me });
                setTimeout(() => this.presence(arg.room), 10);
                return true;
            }
            case "liveSend": {
                const sub = this.subs.get(arg.id);
                if (!sub || !this.liveRoom(sub.user, sub.room)) return false;
                this.subs.forEach((x, id) => id !== arg.id && x.room === sub.room && this.deliver(id, "message", arg.event, arg.payload));
                return true;
            }
            case "liveLeave": {
                const sub = this.subs.get(arg);
                this.subs.delete(arg);
                if (sub) this.presence(sub.room);
                return null;
            }
            case "shareComments": {
                const ok = this.shareCheck(arg.code, arg.password, me);
                if (!ok) return [];
                if (ok.status !== "ok") return [{ status: ok.status, id: null }];
                return this.commentRows(ok.owner, ok.boardId, me).map((r) => ({ status: "ok", ...r }));
            }
            case "boardComments":
                mine();
                return this.commentRows(me.id, arg, me);
            case "addComment": {
                if (!me) throw new Error("sign in to comment");
                if (arg.where.code) {
                    const ok = this.shareCheck(arg.where.code, arg.where.password, me);
                    if (!ok) throw new Error("board is not shared");
                    if (ok.status !== "ok") throw new Error("wrong password");
                    this.insertComment(me, ok.owner, ok.boardId, arg.c);
                } else {
                    if (!this.rows.has(`${me.id}|${arg.where.boardId}`)) throw new Error("not your board");
                    this.insertComment(me, me.id, arg.where.boardId, arg.c);
                }
                return null;
            }
            case "deleteComment": {
                const i = this.comments.findIndex((c) => c.id === arg && me && (c.author === me.id || c.owner === me.id));
                if (i < 0) throw new Error("not allowed");
                this.comments.splice(i, 1);
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
    await context.exposeBinding("__cloud", ({ context: ctx, page }, method, arg) => cloud.call(ctx, method, arg, page));
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
            renameShare: (boardId, code) => call("renameShare", { boardId, code }),
            setSharePassword: (boardId, password) => call("setSharePassword", { boardId, password }),
            deleteShare: (boardId) => call("deleteShare", boardId),
            shareComments: (code, password) => call("shareComments", { code, password: password ?? null }),
            boardComments: (boardId) => call("boardComments", boardId),
            addComment: (where, c) => call("addComment", { where, c }),
            deleteComment: (id) => call("deleteComment", id),
            setShareEditable: (boardId, on) => call("setShareEditable", { boardId, on }),
            joinBoard: (code, password) => call("joinBoard", { code, password: password ?? null }),
            liveBoard: (room) => call("liveBoard", room),
            saveLive: (room, data, edited) => call("saveLive", { room, data, edited }),
            // Realtime stand-in: the test process passes messages between pages (window.__liveIn)
            channel(room, me, h) {
                const id = `ch${Math.random().toString(36).slice(2)}`;
                (window.__liveSubs ||= {})[id] = h;
                window.__liveIn ||= (i, kind, a, b) => {
                    const sub = window.__liveSubs[i];
                    if (!sub) return;
                    if (kind === "presence") sub.presence(a);
                    else sub.message(a, b);
                };
                call("liveSubscribe", { id, room, me }).then((ok) => (ok ? h.ready() : h.error("denied")));
                return {
                    send: (event, payload) => call("liveSend", { id, event, payload }),
                    leave() {
                        delete window.__liveSubs[id];
                        call("liveLeave", id);
                    },
                };
            },
            wipe: () => call("wipe"),
        };
    });
}

// /b/<code> pages and password checks come from the real page function, reading boards from the fake
async function serveSharePages(context, cloud) {
    const find = async (code, password) => cloud.sharedBoard(code, password);
    const pass = async (route, res) => route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    await context.route("**/b/*", async (route) => pass(route, await boardPage(new Request(route.request().url()), find)));
    await context.route("**/api/board", async (route) => {
        const r = route.request();
        await pass(route, await boardUnlock(new Request(r.url(), { method: "POST", body: r.postData() || "" }), find));
    });
}

// open the Share panel on the signed-in board
async function openSharePanel(page) {
    await page.locator("#pb-share").click();
    await expect(page.locator("#share")).toBeVisible();
    await expect(page.locator("#share-status")).not.toHaveText(/Checking/, { timeout: 15000 });
}

async function closeSharePanel(page) {
    await page.keyboard.press("Escape");
    await expect(page.locator("#share")).toBeHidden();
}

// a board with three photos and an upload, signed in
async function sharedSetup(page, cloud, email, info) {
    await installCloud(page.context(), cloud);
    page.on("dialog", (d) => d.accept());
    await openGrid(page);
    await page.evaluate(() => state.photos.slice(0, 3).forEach((p) => window.pins.toggle(p)));
    await openBoard(page);
    const file = info.outputPath("upload.png");
    fs.writeFileSync(file, png("#c8553d", 320, 240));
    await page.setInputFiles("#pb-file", file);
    await page.waitForSelector(".pb-card.is-upload img[src^='blob:']", { timeout: 15000 });
    await signIn(page, email);
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
    await serveSharePages(B.context(), cloud);
    const email = "lin@example.com";
    await sharedSetup(A, cloud, email, info);
    let link;

    await test.step("Share opens the panel; Create link makes a /b/ link and Copy copies it", async () => {
        await openSharePanel(A);
        await expect(A.locator("#share-status")).toContainText("Only you can see this board");
        await expect(A.locator("#share-note")).toContainText("1 uploaded image isn't shown");
        await A.locator("#share-create").click();
        await expect(A.locator("#share-url")).toHaveValue(/\/b\/[A-Za-z0-9]{10}$/, { timeout: 15000 });
        await expect(A.locator("#share-anyone")).toBeChecked();
        await A.locator("#share-copy").click();
        await expect(A.locator("#share-copy")).toHaveText("Copied ✓");
        link = await A.evaluate(() => navigator.clipboard.readText());
        expect(link).toMatch(/^http:\/\/localhost:\d+\/b\/[A-Za-z0-9]{10}$/);
        expect(link).toBe(await A.locator("#share-url").inputValue());
        expect(cloud.shares.size).toBe(1);
        await closeSharePanel(A);
        await expect(A.locator("#pb-share")).toBeFocused();
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
        await expect(A.locator(".pb-card.is-note .pb-note")).toBeFocused();
        await A.keyboard.type("Call sheet");
        await A.keyboard.press("Escape");
        await expect.poll(() => cloud.boards(email)[0].data.pins.some((x) => x.note === "Call sheet"), { timeout: 15000 }).toBe(true);
        await openSharePanel(A);
        await expect(A.locator("#share-url")).toHaveValue(link);
        await closeSharePanel(A);
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

test("cloud: password-protected links, new links and stop sharing", async ({ page, freshPage }, info) => {
    const cloud = new FakeCloud();
    const A = page;
    const B = freshPage;
    await serveSharePages(B.context(), cloud);
    await sharedSetup(A, cloud, "kit@example.com", info);
    let link;

    await test.step("the owner sets a password", async () => {
        await openSharePanel(A);
        await A.locator("#share-create").click();
        await expect(A.locator("#share-url")).toHaveValue(/\/b\//, { timeout: 15000 });
        link = await A.locator("#share-url").inputValue();
        await A.locator("#share-withpass").check();
        await expect(A.locator("#share-pass")).toBeFocused();
        await A.locator("#share-pass").fill("abc");
        await A.locator("#share-pass-save").click();
        await expect(A.locator("#share-error")).toHaveText("Use a password of 4 to 72 characters.");
        await A.locator("#share-pass").fill("north light");
        await A.locator("#share-pass-save").click();
        await expect(A.locator("#share-status")).toContainText("the link and the password", { timeout: 15000 });
        await expect(A.locator("#share-pass-save")).toHaveText("Change");
        await expect(A.locator("#share-pass")).toHaveValue("");
        expect([...cloud.shares.values()][0].pass).toBe("north light");
        await closeSharePanel(A);
    });

    await test.step("a visitor needs the password; the page itself holds no board", async () => {
        await B.goto(link);
        expect(await B.title()).toBe("Password-protected board — Aperture");
        const html = await B.evaluate((u) => fetch(u).then((r) => r.text()), link);
        expect(html).toContain('"locked":true');
        expect(html).not.toContain("images.unsplash.com/photo-mock"); // no cover, no board
        expect(html).not.toContain('"pins"');
        await expect(B.locator("#share [data-view=unlock]")).toBeVisible({ timeout: 30000 });
        await expect(B.locator("#share-unlock-pass")).toBeFocused();
        await B.locator("#share-unlock-pass").fill("south light");
        await B.keyboard.press("Enter");
        await expect(B.locator("#share-error")).toHaveText("That password isn't right.");
        await B.locator("#share-unlock-pass").fill("north light");
        await B.keyboard.press("Enter");
        await expect(B.locator("#share")).toBeHidden();
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await expect(B.locator(".pb-card")).toHaveCount(3);
    });

    await test.step("too many wrong tries are refused", async () => {
        [...cloud.shares.values()][0].fails = 10;
        await B.goto(link);
        await expect(B.locator("#share [data-view=unlock]")).toBeVisible({ timeout: 30000 });
        await B.locator("#share-unlock-pass").fill("north light");
        await B.keyboard.press("Enter");
        await expect(B.locator("#share-error")).toContainText("Too many wrong tries");
        await B.keyboard.press("Escape");
        await expect(B.locator("#share")).toBeHidden();
        await expect(B.locator("#pb.is-readonly")).toHaveCount(0);
        expect(await B.evaluate(() => location.pathname)).toBe("/");
    });

    await test.step("back to anyone with the link removes the password", async () => {
        await openSharePanel(A);
        await expect(A.locator("#share-withpass")).toBeChecked();
        await A.locator("#share-anyone").check();
        await expect(A.locator("#share-status")).toContainText("Anyone with the link", { timeout: 15000 });
        expect([...cloud.shares.values()][0].pass).toBe(null);
        await B.goto(link);
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
    });

    await test.step("New link retires the old one", async () => {
        await A.locator("#share-renew").click(); // confirm() accepted
        await expect(A.locator("#share-url")).not.toHaveValue(link, { timeout: 15000 });
        const fresh = await A.locator("#share-url").inputValue();
        expect(fresh).toMatch(/\/b\/[A-Za-z0-9]{10}$/);
        await B.goto(link);
        await expect(B.locator("#toast")).toContainText("doesn't exist any more", { timeout: 30000 });
        await B.goto(fresh);
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        link = fresh;
    });

    await test.step("Stop sharing turns the link off", async () => {
        await A.locator("#share-stop").click(); // confirm() accepted
        await expect(A.locator("#share-create")).toBeVisible({ timeout: 15000 });
        await expect(A.locator("#share-status")).toContainText("Only you can see this board");
        expect(cloud.shares.size).toBe(0);
        await B.goto(link);
        await expect(B.locator("#toast")).toContainText("doesn't exist any more", { timeout: 30000 });
    });
});

test("cloud: comments on a shared board", async ({ page, freshPage }, info) => {
    const cloud = new FakeCloud();
    const A = page;
    const B = freshPage;
    await installCloud(B.context(), cloud);
    await serveSharePages(B.context(), cloud);
    B.on("dialog", (d) => d.accept());
    await sharedSetup(A, cloud, "owner@example.com", info);
    let link;
    const comments = (p) => p.locator("#pbc-list .pbc-item");

    await test.step("the owner shares the board; there are no comments yet", async () => {
        await openSharePanel(A);
        await A.locator("#share-create").click();
        await expect(A.locator("#share-url")).toHaveValue(/\/b\//, { timeout: 15000 });
        link = await A.locator("#share-url").inputValue();
        await closeSharePanel(A);
        await expect(A.locator("#pb-comments-btn")).toBeVisible();
        await A.locator("#pb-comments-btn").click();
        await expect(A.locator("#pbc-list")).toContainText("No comments yet");
        await A.locator("#pb-comments .pbc-close").click();
        await expect(A.locator("#pb-comments")).toBeHidden();
    });

    await test.step("a signed-out visitor can read but is asked to sign in to comment", async () => {
        await B.goto(link);
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await B.locator("#pb-comments-btn").click();
        await expect(B.locator("#pbc-signin")).toBeVisible();
        await expect(B.locator("#pbc-form")).toBeHidden();
        await expect(B.locator("#pbc-signin-btn")).toBeFocused();
    });

    await test.step("after signing in, the visitor comments on a card and on the board", async () => {
        await B.locator("#pbc-signin-btn").click();
        await expect(B.locator("#acct")).toBeVisible();
        await B.locator("#acct-email").fill("vi@example.com");
        await B.locator("#acct-form button[type=submit]").click();
        await expect(B.locator("#acct-who")).toHaveText("vi@example.com");
        await B.keyboard.press("Escape");
        await expect(B.locator("#acct")).toBeHidden();
        await expect(B.locator("#pbc-form")).toBeVisible();
        await expect(B.locator("#pbc-name")).toHaveValue("vi");
        await B.locator("#pbc-name").fill("Vi");

        // right-click a card: the read-only menu offers a comment on it
        await B.locator(".pb-card").first().click({ button: "right" });
        await B.locator("#pb-ctx button", { hasText: "Comment on this card" }).click();
        await expect(B.locator("#pbc-on")).toBeVisible();
        await expect(B.locator("#pbc-body")).toBeFocused();
        await B.keyboard.type("Love the light here");
        await B.keyboard.press("Control+Enter");
        await expect(comments(B)).toHaveCount(1, { timeout: 15000 });
        await expect(comments(B).first().locator(".pbc-chip")).toBeVisible();
        await expect(B.locator(".pb-card .pb-cbadge:not([hidden])")).toHaveCount(1);
        await expect(B.locator(".pb-card .pb-cbadge:not([hidden])")).toHaveText("1");
        await expect(B.locator("#pbc-on")).toBeHidden();

        await B.locator("#pbc-body").fill("Whole board feels warm.");
        await B.locator("#pbc-post").click();
        await expect(comments(B)).toHaveCount(2, { timeout: 15000 });
        await expect(B.locator("#pb-ccount")).toHaveText("2");
        expect(cloud.comments.map((c) => [c.author_name, !!c.item_id])).toEqual([["Vi", true], ["Vi", false]]);
    });

    await test.step("the owner sees them on their own board, deletes one and replies", async () => {
        await A.evaluate(() => window.comments.reload());
        await expect(A.locator("#pb-ccount")).toHaveText("2", { timeout: 15000 });
        await expect(A.locator(".pb-card .pb-cbadge:not([hidden])")).toHaveCount(1);
        // the badge opens the comments
        await A.locator(".pb-card .pb-cbadge:not([hidden])").click();
        await expect(A.locator("#pb-comments")).toBeVisible();
        await expect(A.locator("#pbc-on")).toBeVisible();
        await expect(comments(A)).toHaveCount(2);
        await expect(comments(A).first()).toHaveClass(/is-focus/);
        await comments(A).nth(1).locator(".pbc-del").click(); // confirm() accepted
        await expect(comments(A)).toHaveCount(1, { timeout: 15000 });
        await A.locator("#pbc-on-clear").click();
        await A.locator("#pbc-name").fill("Owner");
        await A.locator("#pbc-body").fill("Thanks, glad it works!");
        await A.locator("#pbc-post").click();
        await expect(comments(A)).toHaveCount(2, { timeout: 15000 });
    });

    await test.step("the visitor sees the reply and can delete only their own", async () => {
        await B.evaluate(() => window.comments.reload());
        await expect(comments(B)).toHaveCount(2, { timeout: 15000 });
        await expect(comments(B).nth(0).locator(".pbc-del")).toHaveCount(1);
        await expect(comments(B).nth(1).locator(".pbc-del")).toHaveCount(0);
        await expect(comments(B).nth(1)).toContainText("Owner");
        // the chip flies to the card
        await comments(B).nth(0).locator(".pbc-chip").click();
        await expect(B.locator(".pb-card.is-hit")).toHaveCount(1);
    });

    await test.step("on a password-protected board, comments need the password too", async () => {
        await openSharePanel(A);
        await A.locator("#share-withpass").check();
        await A.locator("#share-pass").fill("north light");
        await A.locator("#share-pass-save").click();
        await expect(A.locator("#share-status")).toContainText("the link and the password", { timeout: 15000 });
        await closeSharePanel(A);

        await B.reload();
        await expect(B.locator("#share [data-view=unlock]")).toBeVisible({ timeout: 30000 });
        await B.locator("#share-unlock-pass").fill("north light");
        await B.keyboard.press("Enter");
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await expect(B.locator("#pb-ccount")).toHaveText("2", { timeout: 15000 });
        await B.locator("#pb-comments-btn").click();
        await B.locator("#pbc-body").fill("Still here");
        await B.locator("#pbc-post").click();
        await expect(comments(B)).toHaveCount(3, { timeout: 15000 });
    });

    await test.step("a saved copy is the visitor's own board; signing out hides comments", async () => {
        await B.locator("#pb-keep").click(); // a local copy: not shared, so no comments here
        await expect(B.locator("#pb-comments-btn")).toBeVisible(); // signed in: own board
        await B.locator("#pb-account").click();
        await B.locator("#acct-signout").click();
        await expect(B.locator("#pb-comments-btn")).toBeHidden();
    });
});

test("cloud: editing a shared board together, live (#21)", async ({ page, freshPage }, info) => {
    const cloud = new FakeCloud();
    const A = page; // the owner
    const B = freshPage; // someone with the link
    const owner = "ada@example.com";
    await installCloud(B.context(), cloud);
    await serveSharePages(B.context(), cloud);
    B.on("dialog", (d) => d.accept());
    await sharedSetup(A, cloud, owner, info);
    const row = () => cloud.boards(owner)[0];
    let link;

    await test.step("the owner makes an edit link", async () => {
        await openSharePanel(A);
        await A.locator("#share-create").click();
        await expect(A.locator("#share-url")).toHaveValue(/\/b\/[A-Za-z0-9]{10}$/, { timeout: 15000 });
        await expect(A.locator("#share-view")).toBeChecked();
        await A.locator("#share-edit").check();
        await expect(A.locator("#share-status")).toContainText("they can edit it with you", { timeout: 15000 });
        await expect(A.locator("#share-note")).toContainText("editors can't add their own");
        link = await A.locator("#share-url").inputValue();
        expect([...cloud.shares.values()][0].editable).toBe(true);
        await closeSharePanel(A);
        await expect.poll(() => A.evaluate(() => window.live.status()), { timeout: 15000 }).toMatchObject({ kind: "owner", ready: true });
    });

    await test.step("signed out, the link is view-only and offers to sign in", async () => {
        await B.goto(link);
        await B.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await expect(B.locator("#pb-shared-mode")).toHaveText("view only until you sign in");
        await expect(B.locator("#pb-shared-signin")).toBeVisible();
        expect(cloud.editors.size).toBe(0);
    });

    await test.step("after signing in, they edit the board (no uploads) and see who's there", async () => {
        await B.locator("#pb-shared-signin").click();
        await expect(B.locator("#acct")).toBeVisible();
        await B.locator("#acct-email").fill("bo@example.com");
        await B.locator("#acct-form button[type=submit]").click();
        await expect(B.locator("#acct-who")).toHaveText("bo@example.com");
        await B.keyboard.press("Escape");
        await expect(B.locator("#pb")).toHaveClass(/is-guest/, { timeout: 15000 });
        await expect(B.locator("#pb")).not.toHaveClass(/is-readonly/);
        await expect(B.locator("#pb-shared-mode")).toHaveText("editing together");
        await expect(B.locator("#pb-shared-signin")).toBeHidden();
        await expect(B.locator(".pb-card")).toHaveCount(3);
        await expect(B.locator("#pb-share")).toBeHidden();
        await expect(B.locator("#pb-picker-btn")).toBeHidden();
        expect(cloud.editors.size).toBe(1);
        await expect(A.locator("#pb-people .pb-person")).toHaveCount(1, { timeout: 15000 });
        await expect(A.locator("#pb-people .pb-person")).toHaveAttribute("title", "Guest");
        await expect(B.locator("#pb-people .pb-person")).toHaveAttribute("title", /\(owner\)$/);
    });

    await test.step("on a phone, the editing board fits the screen", async () => {
        const size = B.viewportSize();
        await B.setViewportSize({ width: 390, height: 844 });
        await B.waitForTimeout(400);
        expect(await B.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(B.locator("#pb-people")).toBeInViewport();
        await expect(B.locator("#pb-shared-mode")).toBeInViewport();
        await B.screenshot({ path: info.outputPath("guest-phone.png") });
        await B.setViewportSize(size);
    });

    await test.step("an editor's note appears on the owner's screen and saves into the owner's board", async () => {
        await B.locator("#pb-area").focus();
        await B.keyboard.press("n");
        await expect(B.locator(".pb-card.is-note .pb-note")).toBeFocused();
        await B.keyboard.type("from Bo");
        await B.keyboard.press("Escape");
        await expect(A.locator(".pb-card.is-note .pb-note")).toHaveValue("from Bo", { timeout: 10000 });
        await expect.poll(() => row().data.pins.some((x) => x.note === "from Bo"), { timeout: 15000 }).toBe(true);
        // the owner's upload, which the editor never saw, is still in the saved board
        expect(row().data.pins.filter((x) => x.kind === "upload")).toHaveLength(1);
        await expect(A.locator(".pb-card")).toHaveCount(5);
    });

    await test.step("editors can't add images from their device", async () => {
        const file = info.outputPath("theirs.png");
        fs.writeFileSync(file, png("#224466", 200, 200));
        await B.setInputFiles("#pb-file", file);
        await expect(B.locator("#toast")).toContainText("can't go on someone else's board");
        await expect(B.locator(".pb-card")).toHaveCount(4);
    });

    await test.step("the owner's changes reach the editor; uploads stay private", async () => {
        await A.locator(".pb-card.is-unsplash").first().focus();
        await A.keyboard.press("Delete");
        await expect(A.locator(".pb-card")).toHaveCount(4);
        await expect(B.locator(".pb-card")).toHaveCount(3, { timeout: 10000 });
        await expect(B.locator(".pb-card.is-upload")).toHaveCount(0);
    });

    await test.step("a card dragged by the editor lands in the same place for the owner", async () => {
        const note = B.locator(".pb-card.is-note");
        const box = await note.boundingBox();
        await B.mouse.move(box.x + box.width / 2, box.y + 12);
        await B.mouse.down();
        for (let i = 1; i <= 8; i++) await B.mouse.move(box.x + box.width / 2 + i * 15, box.y + 12 + i * 10);
        await B.mouse.up();
        await expect(B.locator(".pb-card.is-note.is-held")).toHaveCount(0, { timeout: 5000 });
        const left = await note.evaluate((el) => el.style.left);
        await expect(A.locator(".pb-card.is-note")).toHaveCSS("left", left, { timeout: 10000 });
    });

    await test.step("the editor's cursor shows on the owner's board", async () => {
        const area = await B.locator("#pb-area").boundingBox();
        await B.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        await B.mouse.move(area.x + area.width / 2 + 20, area.y + area.height / 2 + 20);
        await expect(A.locator(".pb-cursor")).toHaveCount(1, { timeout: 10000 });
        await expect(A.locator(".pb-cursor span")).toHaveText("Guest");
    });

    await test.step("the owner's undo takes back only the owner's own step", async () => {
        await A.locator("#pb-area").focus();
        await A.keyboard.press("Control+z");
        await expect(A.locator(".pb-card")).toHaveCount(5);
        await expect(A.locator(".pb-card.is-note .pb-note")).toHaveValue("from Bo");
        await expect(B.locator(".pb-card")).toHaveCount(4, { timeout: 10000 });
    });

    await test.step("turning editing off sends the editor back to view-only", async () => {
        await openSharePanel(A);
        await A.locator("#share-view").check();
        await expect(A.locator("#share-status")).toContainText("but not change it", { timeout: 15000 });
        await closeSharePanel(A);
        await expect(B.locator("#toast")).toContainText("turned off editing", { timeout: 10000 });
        await expect(B.locator("#pb")).toHaveClass(/is-readonly/);
        await expect(B.locator("#pb")).not.toHaveClass(/is-guest/);
        await expect(B.locator("#pb-shared-mode")).toHaveText("view only");
        await expect(A.locator("#pb-people")).toBeHidden({ timeout: 10000 });
        expect(cloud.editors.size).toBe(0);
        // what was on screen is still there to look at
        await expect(B.locator(".pb-card")).toHaveCount(4);
    });

    await test.step("a password-protected edit link: the password opens it for editing", async () => {
        await openSharePanel(A);
        await A.locator("#share-edit").check();
        await expect(A.locator("#share-status")).toContainText("they can edit it with you", { timeout: 15000 });
        await A.locator("#share-withpass").check();
        await A.locator("#share-pass").fill("tangerine");
        await A.locator("#share-pass-save").click();
        await expect(A.locator("#share-status")).toContainText("link and the password", { timeout: 15000 });
        await closeSharePanel(A);
        await B.goto(link);
        await expect(B.locator("#share-unlock-pass")).toBeVisible({ timeout: 30000 });
        await B.locator("#share-unlock-pass").fill("tangerine");
        await B.locator("#share-unlock-form button").click();
        await expect(B.locator("#pb")).toHaveClass(/is-guest/, { timeout: 20000 });
        await expect(B.locator(".pb-card")).toHaveCount(4);
    });

    await test.step("a new link sends the editor back to view-only", async () => {
        await openSharePanel(A);
        await A.locator("#share-renew").click(); // confirm() accepted
        await expect(A.locator("#share-url")).not.toHaveValue(link, { timeout: 15000 });
        await closeSharePanel(A);
        await expect(B.locator("#toast")).toContainText("changed this board's link or password", { timeout: 10000 });
        await expect(B.locator("#pb")).toHaveClass(/is-readonly/);
        expect(cloud.editors.size).toBe(0);
    });
});
