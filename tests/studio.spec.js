// The creators' library (#33): Aperture's own photos next to Unsplash's, and the
// Studio where approved creators publish them. A stand-in for Supabase lives in
// the test process (creators, photos, files in the public "library" bucket, with
// the same rules as schema.sql), and /api/library is the real backend/api/library.js
// reading from it, so what the Studio publishes is what visitors get.
import { test, expect, openGrid, openBoard, boardItems, png } from "./fixtures.js";
import { respond as libraryPage } from "../backend/api/library.js";

const BASE = "https://mocklibrary000000000.supabase.co"; // 20-character project ref, like a real one
const FILES = `${BASE}/storage/v1/object/public/library/`;

class FakeLibrary {
    constructor() {
        this.users = new Map(); // email -> uuid
        this.sessions = new Map(); // context -> user
        this.creators = new Map(); // uuid -> row
        this.photos = new Map(); // id -> row
        this.files = new Map(); // path -> { type, body }
        this.n = 0;
    }
    userFor(email) {
        if (!this.users.has(email)) this.users.set(email, `00000000-0000-4000-8000-${String(this.users.size + 1).padStart(12, "0")}`);
        return { id: this.users.get(email), email, name: "" };
    }
    // a creator with published photos, made directly (as if through the Studio)
    seed(username, name, photos, { status = "approved", avatar = 0 } = {}) {
        const id = this.userFor(`${username}@example.com`).id;
        this.creators.set(id, { username, name, bio: "", location: "Lisbon", link: "https://example.com", avatar, status });
        photos.forEach((p, i) => {
            const pid = `ap-${username.slice(0, 4).padEnd(4, "x")}${String(++this.n).padStart(8, "0")}`;
            this.photos.set(pid, {
                id: pid,
                creator: id,
                title: p.title,
                alt: p.alt || "",
                tags: p.tags || [],
                width: p.width || 3000,
                height: p.height || 2000,
                color: p.color || "#3a7d44",
                tone: p.tone || "green",
                license: p.license || "free",
                published: p.published ?? true,
                hidden: false,
                created_at: new Date(Date.now() - i * 1000).toISOString(),
            });
        });
        return id;
    }
    // library_photos(): published, unhidden photos by approved creators
    search(a) {
        const words = (a.q_text || "").toLowerCase().split(/\s+/).filter(Boolean);
        let rows = [...this.photos.values()]
            .filter((p) => p.published && !p.hidden && this.creators.get(p.creator)?.status === "approved")
            .filter((p) => !words.length || words.every((w) => `${p.title} ${p.alt} ${p.tags.join(" ")}`.toLowerCase().includes(w.replace(/s$/, ""))))
            .filter((p) => !a.q_creator || this.creators.get(p.creator).username === a.q_creator)
            .filter((p) => !a.q_tone || p.tone === a.q_tone)
            .sort((x, y) => y.created_at.localeCompare(x.created_at));
        const total = rows.length;
        rows = rows.slice((a.q_page - 1) * a.q_per, a.q_page * a.q_per);
        return rows.map((p) => {
            const c = this.creators.get(p.creator);
            return { ...p, username: c.username, name: c.name, bio: c.bio, location: c.location, link: c.link, avatar: c.avatar, total };
        });
    }
    call(ctx, method, arg) {
        const me = this.sessions.get(ctx) || null;
        const need = () => {
            if (!me) throw new Error("not signed in");
            return me;
        };
        const approved = () => this.creators.get(need().id)?.status === "approved";
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
            case "creatorMe":
                return this.creators.get(need().id) || null;
            case "creatorApply": {
                need();
                if ([...this.creators.values()].some((c) => c.username === arg.username)) throw new Error('duplicate key value violates unique constraint "creators_username_key"');
                if (!/^[a-z0-9_-]{3,30}$/.test(arg.username)) throw new Error("bad username");
                this.creators.set(me.id, { avatar: 0, ...arg, status: "pending" });
                return null;
            }
            case "creatorUpdate": {
                const c = this.creators.get(need().id);
                if (!c || c.status === "blocked") return null;
                if ("status" in arg) throw new Error("permission denied for table creators");
                Object.assign(c, arg);
                return null;
            }
            case "myPhotos":
                return [...this.photos.values()].filter((p) => p.creator === need().id).sort((x, y) => y.created_at.localeCompare(x.created_at));
            case "addPhoto": {
                if (!approved()) throw new Error("new row violates row-level security policy");
                if (!/^ap-[a-z0-9]{12}$/.test(arg.id) || "hidden" in arg) throw new Error("bad photo");
                this.photos.set(arg.id, { ...arg, creator: me.id, hidden: false, created_at: new Date().toISOString() });
                return null;
            }
            case "updatePhoto": {
                const p = this.photos.get(arg.id);
                if (!p || p.creator !== need().id) return null;
                if (!approved()) throw new Error("new row violates row-level security policy");
                Object.assign(p, arg.fields);
                return null;
            }
            case "deletePhoto": {
                const p = this.photos.get(arg);
                if (p?.creator === need().id) {
                    this.photos.delete(arg);
                    ["s", "m", "l"].forEach((k) => this.files.delete(`${me.id}/${arg}/${k}.webp`));
                }
                return null;
            }
            case "putFile": {
                need();
                if (!arg.path.startsWith(`${me.id}/`) || !approved()) throw new Error("new row violates row-level security policy");
                this.files.set(arg.path, { type: arg.type, body: Buffer.from(arg.data.split(",")[1], "base64") });
                return null;
            }
            // what the board's sync asks for; this account has no boards
            case "list":
            case "get":
                return [];
            case "upsert":
                return null;
        }
        throw new Error(`unknown call ${method}`);
    }
}

async function install(context, lib) {
    await context.exposeBinding("__lib", ({ context: ctx }, method, arg) => lib.call(ctx, method, arg));
    await context.addInitScript((files) => {
        const listeners = [];
        const call = (m, a) => window.__lib(m, a);
        const toData = (blob) =>
            new Promise((res) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.readAsDataURL(blob);
            });
        window.__apertureBackend = {
            session: () => call("session"),
            onChange: (cb) => listeners.push(cb),
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
            putBlob: async () => {},
            getBlob: async () => null,
            creatorMe: () => call("creatorMe"),
            creatorApply: (row) => call("creatorApply", row),
            creatorUpdate: (fields) => call("creatorUpdate", fields),
            myPhotos: () => call("myPhotos"),
            addPhoto: (row) => call("addPhoto", row),
            updatePhoto: (id, fields) => call("updatePhoto", { id, fields }),
            deletePhoto: (id) => call("deletePhoto", id),
            async putLibraryFile(path, blob) {
                await call("putFile", { path, type: blob.type, data: await toData(blob) });
            },
            libraryBase: () => files,
        };
    }, FILES);
    // the public bucket and the real /api/library, both reading the fake
    await context.route(`${FILES}**`, async (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(new URL(FILES).pathname.length));
        const f = lib.files.get(path);
        if (f) return route.fulfill({ status: 200, body: f.body, headers: { "content-type": f.type, "access-control-allow-origin": "*" } });
        // seeded photos have no real files: a generated image in the photo's colour
        const id = path.split("/")[1];
        const p = lib.photos.get(id);
        if (!p && !path.endsWith("avatar.webp")) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ status: 200, body: png(p?.color || "#c8553d", 240, 160), headers: { "content-type": "image/png", "access-control-allow-origin": "*" } });
    });
    await context.route("**/api/library?**", async (route) => {
        const res = await libraryPage(new Request(route.request().url()), async (a) => ({ rows: lib.search(a), base: BASE }));
        route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    });
}

// SHOTS=1 saves screenshots of each step to test-results (for eyeballing layouts)
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: test.info().outputPath(`${name}.png`) }) : null);

const seedTwo = (lib) => {
    lib.seed("ada", "Ada Ruiz", [
        { title: "Harbour fog at dawn", tags: ["harbour", "fog"], color: "#93b7be", tone: "teal" },
        { title: "Night ferry", tags: ["night", "harbour"], license: "view", color: "#2d3047", tone: "blue", width: 2000, height: 3000 },
    ]);
    lib.seed("ghost", "Not Approved", [{ title: "Harbour ghost" }], { status: "pending" });
};

test("library: creators' photos come first, and the source switch narrows them", async ({ page }) => {
    const lib = new FakeLibrary();
    seedTwo(lib);
    await install(page.context(), lib);
    await openGrid(page);

    await test.step("the feed lists Aperture photos first, then Unsplash", async () => {
        const ids = await page.evaluate(() => state.photos.map((p) => p.id));
        expect(ids.slice(0, 2).every((id) => id.startsWith("ap-"))).toBe(true);
        expect(ids.slice(2).every((id) => id.startsWith("mock"))).toBe(true);
        expect(ids).not.toContain(expect.stringMatching(/ghos/));
        await expect(page.locator("#source")).toBeVisible();
        await expect(page.locator(".card.is-library")).toHaveCount(2);
        // the grid's images are the stored sizes in the public bucket
        const src = await page.locator(".card.is-library img.card-img").first().getAttribute("src");
        expect(src).toMatch(/\/library\/[0-9a-f-]{36}\/ap-[a-z0-9]{12}\/[sml]\.webp$/);
        await expect(page.locator("#results-total")).toHaveText("Aperture creators, then Unsplash editors");
        await page.locator("#results").scrollIntoViewIfNeeded();
        await page.waitForTimeout(1500);
        await shot(page, "grid-mixed");
    });

    await test.step("Aperture only, then Unsplash only", async () => {
        await page.locator('[data-source="aperture"]').click();
        await page.waitForFunction(() => !state.loading && state.photos.length === 2);
        await expect(page.locator(".card")).toHaveCount(2);
        await page.locator('[data-source="unsplash"]').click();
        await page.waitForFunction(() => !state.loading && state.photos.length > 5 && state.photos.every((p) => p.id.startsWith("mock")));
        // remembered for next time
        expect(await page.evaluate(() => localStorage.getItem("aperture:source"))).toBe("unsplash");
        await page.locator('[data-source="all"]').click();
        await page.waitForFunction(() => !state.loading && state.photos[0]?.id.startsWith("ap-"));
    });

    await test.step("search finds creators' photos too", async () => {
        await page.locator("#hero-q").fill("harbour");
        await page.locator("#hero-q").press("Enter");
        await page.waitForFunction(() => state.mode === "search" && !state.loading && state.photos.length > 2);
        const ids = await page.evaluate(() => state.photos.slice(0, 3).map((p) => p.id));
        expect(ids[0]).toMatch(/^ap-/);
        expect(ids[1]).toMatch(/^ap-/);
        expect(ids[2]).toMatch(/^mock/);
        // the Tone filter applies to both: no teal Unsplash mock, one teal library photo
        await page.locator('#filters [data-color="teal"]').click();
        await page.waitForFunction(() => state.color === "teal" && !state.loading && state.photos.length > 0 && state.photos.filter((p) => p.id.startsWith("ap-")).length === 1);
    });
});

test("library: the viewer credits the creator, respects the licence, and opens their page", async ({ page }) => {
    const lib = new FakeLibrary();
    seedTwo(lib);
    await install(page.context(), lib);
    await openGrid(page);

    await page.locator(".card.is-library .card-media").first().click();
    await expect(page.locator("#lightbox")).toBeVisible();
    await expect(page.locator("#lb-title")).toHaveText("Harbour fog at dawn");
    await expect(page.locator(".lb-credit")).toHaveText(/Photo by Ada Ruiz on Aperture/, { useInnerText: true });
    await expect(page.locator("#lb-src-unsplash")).toBeHidden();
    // free to use: download the large size; the site link is the creator's own
    await expect(page.locator("#lb-download")).toBeVisible();
    expect(await page.locator("#lb-download").getAttribute("href")).toMatch(/\/l\.webp\?download=harbour-fog-at-dawn-ada\.webp$/);
    await expect(page.locator("#lb-open")).toHaveAttribute("href", "https://example.com");
    await expect(page.locator("#lb-open")).toContainText("Creator’s site");
    await expect(page.locator("#lb-initial")).toHaveText("A");

    // view and pin only: no download button
    await page.waitForFunction(() => !lb.busy);
    await page.locator("#lb-next").click();
    await expect(page.locator("#lb-title")).toHaveText("Night ferry");
    await expect(page.locator("#lb-download")).toBeHidden();
    await expect(page.locator("#lb-license")).toBeVisible();
    await expect(page.locator("#lb-license")).toContainText("Ask Ada Ruiz");

    // the creator's name opens their page here, not on Unsplash
    await page.locator("#lb-author").click();
    await page.waitForFunction(() => state.mode === "user" && state.user.source === "aperture" && !state.loading && state.photos.length === 2);
    await expect(page.locator("#lightbox")).toBeHidden();
    await expect(page.locator("#results-title")).toContainText("Ada Ruiz");
    await expect(page.locator("#results-kicker")).toHaveText("(Aperture creator)");
    expect(new URL(page.url()).searchParams.get("creator")).toBe("ada");
    expect(await page.evaluate(() => state.photos.every((p) => p.id.startsWith("ap-")))).toBe(true);

    // and the address opens it again
    await page.goto("/?creator=ada");
    await page.waitForFunction(() => state.mode === "user" && !state.loading && state.photos.length === 2, null, { timeout: 30000 });
    await expect(page.locator("#results-title")).toContainText("Ada Ruiz");
});

test("library: a pinned creator's photo survives the board, a reload and a share link", async ({ page }) => {
    const lib = new FakeLibrary();
    seedTwo(lib);
    await install(page.context(), lib);
    await openGrid(page);
    await page.evaluate(() => window.pins.toggle(state.photos[0]));
    await openBoard(page);
    const card = page.locator(".pb-card").first();
    await expect(card.locator("img")).toHaveAttribute("src", /\/library\/.+\/[sml]\.webp$/);
    await expect(card.locator(".pb-meta a")).toHaveAttribute("href", "/?creator=ada");
    let items = await boardItems(page);
    expect(items[0].photo.urls.raw).toMatch(/^https:\/\/mocklibrary000000000\.supabase\.co\/storage\/v1\/object\/public\/library\//);

    // reload: read back through cleanItem
    await page.reload();
    await page.waitForFunction(() => window.pins && state.photos.length > 0);
    items = await boardItems(page);
    expect(items).toHaveLength(1);
    expect(items[0].id).toMatch(/^ap-/);

    // the #board= link packs the full address and unpacks it again
    const round = await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem("aperture:board:" + JSON.parse(localStorage.getItem("aperture:boards")).active)).pins[0].photo.urls.raw;
        return raw;
    });
    expect(round).toMatch(/ap-[a-z0-9]{12}\/$/);
});

test("studio: apply, get approved, upload, publish — and visitors see it", async ({ page, freshPage }, info) => {
    const lib = new FakeLibrary();
    await install(page.context(), lib);
    await install(freshPage.context(), lib);
    page.on("dialog", (d) => d.accept());

    await test.step("Studio opens from the nav and asks to sign in", async () => {
        await openGrid(page);
        await expect(page.locator("#nav-studio")).toBeVisible();
        await page.locator("#nav-studio").click();
        await expect(page.locator("#studio")).toBeVisible();
        await expect(page.locator('#studio [data-view="out"]')).toBeVisible();
        expect(new URL(page.url()).searchParams.get("studio")).toBe("1");
        await page.locator("#studio-email").fill("lena@example.com");
        await page.locator("#studio-signin button[type=submit]").click();
    });

    await test.step("apply: a taken username is refused, the rights box is required", async () => {
        lib.seed("taken", "Someone", []);
        await expect(page.locator("#studio-form")).toBeVisible();
        await page.locator("#studio-name").fill("Lena Park");
        await page.locator("#studio-username").fill("Taken");
        await expect(page.locator("#studio-username")).toHaveValue("taken");
        await page.locator("#studio-form-submit").click();
        // the browser holds the form back until the rights box is ticked
        expect(await page.evaluate(() => document.querySelector("#studio-rights").validity.valueMissing)).toBe(true);
        expect(lib.creators.size).toBe(1);
        await page.locator("#studio-rights").check();
        await page.locator("#studio-form-submit").click();
        await expect(page.locator("#studio-error")).toContainText("username is taken");
        await page.locator("#studio-username").fill("lena");
        await page.locator("#studio-bio").fill("Streets after rain.");
        await shot(page, "studio-apply");
        await page.locator("#studio-form-submit").click();
        await expect(page.locator('#studio [data-view="pending"]')).toBeVisible();
        await expect(page.locator('[data-view="pending"] .studio-me-url')).toContainText("?creator=lena");
        const me = [...lib.creators.values()].find((c) => c.username === "lena");
        expect(me.status).toBe("pending");
    });

    await test.step("approved: the desk opens; files go to the creator's folder in three sizes", async () => {
        [...lib.creators.values()].find((c) => c.username === "lena").status = "approved";
        await page.reload();
        await page.waitForSelector("#studio:not([hidden])");
        await expect(page.locator('#studio [data-view="studio"]')).toBeVisible({ timeout: 15000 });
        await expect(page.locator("#studio-empty")).toBeVisible();

        const big = info.outputPath("wet-street_at-night.png");
        const small = info.outputPath("tiny.png");
        const fs = await import("node:fs");
        fs.writeFileSync(big, png("#2f5fc7", 1600, 1200));
        fs.writeFileSync(small, png("#c8553d", 400, 300));
        await page.setInputFiles("#studio-file", [big, small]);
        await expect(page.locator(".studio-item")).toHaveCount(1, { timeout: 20000 });
        await expect(page.locator("#studio-error")).toContainText("tiny.png: At least 1200 px");
        await expect(page.locator(".studio-item .studio-title-in")).toHaveValue("Wet street at night");
        await expect(page.locator(".studio-item")).toHaveAttribute("data-state", "draft");

        const uid = lib.userFor("lena@example.com").id;
        const id = [...lib.photos.keys()][0];
        expect([...lib.files.keys()].sort()).toEqual(["l", "m", "s"].map((k) => `${uid}/${id}/${k}.webp`));
        // sizes are capped by the original: 1600 px wide here, so m and l are the same width
        const p = lib.photos.get(id);
        expect([p.width, p.height, p.published, p.license]).toEqual([1600, 1200, false, "free"]);
        expect(p.tone).toBe("blue");
        // a draft isn't public
        expect(lib.search({ q_page: 1, q_per: 24 })).toHaveLength(0);
    });

    await test.step("edit and publish", async () => {
        await page.locator(".studio-tags-in").fill("Rain, street, #night, rain");
        await page.locator(".studio-tags-in").press("Tab");
        await expect(page.locator(".studio-saved")).toHaveText("Saved");
        await expect(page.locator(".studio-tags-in")).toHaveValue("rain, street, night");
        await page.locator(".studio-license").selectOption("view");
        await page.locator(".studio-item button", { hasText: "Publish" }).click();
        await expect(page.locator(".studio-item")).toHaveAttribute("data-state", "live");
        await expect(page.locator("#studio-count")).toHaveText("1 published · 0 drafts");
        await shot(page, "studio-desk");
        await page.setViewportSize({ width: 390, height: 844 });
        await shot(page, "studio-desk-phone");
        expect(await page.evaluate(() => document.querySelector("#studio").scrollWidth)).toBeLessThanOrEqual(390);
        await page.setViewportSize({ width: 1440, height: 900 });
        const p = [...lib.photos.values()][0];
        expect(p).toMatchObject({ tags: ["rain", "street", "night"], license: "view", published: true });
    });

    await test.step("a visitor finds it by search, view-only", async () => {
        await freshPage.goto("/?q=rain");
        await freshPage.waitForFunction(() => state.mode === "search" && !state.loading && state.photos.length > 1, null, { timeout: 30000 });
        expect(await freshPage.evaluate(() => state.photos[0].user.username)).toBe("lena");
        await freshPage.locator(".card.is-library .card-media").first().click();
        await expect(freshPage.locator("#lb-title")).toHaveText("Wet street at night");
        await expect(freshPage.locator("#lb-download")).toBeHidden();
        await freshPage.waitForTimeout(1500);
        await shot(freshPage, "viewer-view-only");
    });

    await test.step("Escape closes the studio and the address drops ?studio", async () => {
        await page.keyboard.press("Escape");
        await expect(page.locator("#studio")).toBeHidden();
        expect(new URL(page.url()).searchParams.has("studio")).toBe(false);
    });

    await test.step("delete takes it out of the library", async () => {
        await page.locator("#nav-studio").click();
        await page.locator(".studio-delete").click();
        await expect(page.locator(".studio-item")).toHaveCount(0);
        expect(lib.photos.size).toBe(0);
        expect(lib.files.size).toBe(0);
    });
});

test("studio: hidden without accounts; phones get a full-screen sheet", async ({ page, browser }) => {
    await openGrid(page);
    await expect(page.locator("#nav-studio")).toBeHidden();
    await expect(page.locator("#source")).toBeHidden();

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const { prepare } = await import("./fixtures.js");
    await prepare(ctx);
    const lib = new FakeLibrary();
    lib.seed("ada", "Ada Ruiz", [{ title: "Harbour fog" }]);
    await install(ctx, lib);
    const phone = await ctx.newPage();
    await phone.goto("/?studio=1");
    await expect(phone.locator('#studio [data-view="out"]')).toBeVisible({ timeout: 30000 });
    const box = await phone.locator(".studio-sheet").boundingBox();
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const close = await phone.locator("#studio-close").boundingBox();
    expect(close.height).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: test.info().outputPath("studio-phone.png") });
    await ctx.close();
});
