// Everything a board can hold (uploads, notes, links, wall photos) and the
// tools around it: selection, snapping, find, minimap, palette, menus,
// export with download tracking, share links, storage warnings, error reports.
import fs from "node:fs";
import { test, expect, openGrid, openBoard, boardItems, beacons, png, settled } from "./fixtures.js";

test("items: add every kind of item and use the board tools", async ({ page, freshPage, unsplash }, info) => {
    const wait = (ms) => page.waitForTimeout(ms);
    const items = () => boardItems(page);
    const count = (sel) => page.locator(sel).count();
    const uploadPath = info.outputPath("upload.png");
    fs.writeFileSync(uploadPath, png("#1e6f5c", 300, 200));

    await test.step("uncaught errors are reported without the search query", async () => {
        await openGrid(page, "?q=secret-search-term");
        await wait(1500);
        await page.evaluate(() => setTimeout(() => Promise.reject(new Error("probe error from test"))));
        await expect.poll(async () => (await beacons(page)).find((b) => b.body.includes("probe error from test"))).toBeTruthy();
        const report = (await beacons(page)).find((b) => b.body.includes("probe error from test"));
        expect(report.url).toContain("/api/log");
        expect(report.body).not.toContain("secret-search-term");
        expect(JSON.parse(report.body)).toMatchObject({ kind: "rejection", view: "grid" });
    });

    await openBoard(page);

    await test.step("uploads are stored in IndexedDB", async () => {
        await page.setInputFiles("#pb-file", uploadPath);
        await page.waitForSelector(".pb-card.is-upload img[src^='blob:']", { timeout: 15000 });
        const up = (await items()).find((x) => x.kind === "upload");
        expect(up.id).toMatch(/^u-/);
        expect(await page.evaluate(async (id) => !!(await window.media.get(id)), up.id)).toBe(true);
    });

    await test.step("N adds a note", async () => {
        await page.locator("#pb-area").focus();
        await page.keyboard.press("n");
        await wait(300);
        await page.keyboard.type("Warm light, low sun");
        await page.keyboard.press("Escape");
        await wait(500);
        expect((await items()).find((x) => x.kind === "note")?.note).toBe("Warm light, low sun");
    });

    await test.step("links: image address and bookmark", async () => {
        const imageUrl = await page.evaluate(() => `${state.photos[3].urls.raw}&w=600&q=60`);
        for (const [n, value] of [[1, imageUrl], [2, "example.com/some/page"]]) {
            await page.locator("#pb-area").focus();
            await page.keyboard.press("l");
            await page.locator("#pb-link-q").fill(value);
            await page.keyboard.press("Enter");
            await expect(page.locator(".pb-card.is-link")).toHaveCount(n, { timeout: 15000 });
        }
        const links = (await items()).filter((x) => x.kind === "link");
        expect(links.some((x) => x.media.src?.startsWith("https://images.unsplash.com"))).toBe(true);
        expect(links.some((x) => !x.media.src && x.media.href === "https://example.com/some/page")).toBe(true);
        await expect(page.locator(".pb-bookmark-host").first()).toHaveText("example.com");
    });

    await test.step("paste text makes a note, dropping a link adds it", async () => {
        await page.locator("#pb-area").focus();
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData("text/plain", "pasted thought");
            document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
        });
        await expect.poll(async () => (await items()).some((x) => x.kind === "note" && x.note === "pasted thought")).toBe(true);
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData("text/uri-list", "https://example.org/");
            const area = document.querySelector("#pb-area");
            const r = area.getBoundingClientRect();
            area.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 300 }));
        });
        await expect.poll(async () => (await items()).some((x) => x.media?.href === "https://example.org/"), { timeout: 15000 }).toBe(true);
    });

    await test.step("wall tray adds photos by click and by drag", async () => {
        await page.locator("#pb-area").focus();
        await page.keyboard.press("w");
        await page.waitForSelector("#pb-tray:not([hidden]) .pb-tray-item");
        const before = (await items()).filter((x) => x.kind === "unsplash").length;
        await page.locator(".pb-tray-item").nth(0).click();
        await wait(300);
        const t2 = await page.locator(".pb-tray-item").nth(1).boundingBox();
        const area = await page.locator("#pb-area").boundingBox();
        await page.mouse.move(t2.x + 30, t2.y + 40);
        await page.mouse.down();
        await page.mouse.move(area.x + 700, area.y + 250, { steps: 12 });
        await page.mouse.up();
        await settled(page);
        expect((await items()).filter((x) => x.kind === "unsplash").length).toBe(before + 2);
        expect(await count(".pb-tray-item.is-pinned")).toBeGreaterThanOrEqual(2);
        await page.keyboard.press("Escape");
        await page.locator("#pb-fit").click();
        await wait(800);
    });

    await test.step("selection: box select, align, group, delete all + undo", async () => {
        const area = await page.locator("#pb-area").boundingBox();
        await page.keyboard.down("Shift");
        await page.mouse.move(area.x + 4, area.y + 4);
        await page.mouse.down();
        await page.mouse.move(area.x + area.width - 220, area.y + area.height - 10, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.up("Shift");
        expect(await count(".pb-card.is-selected")).toBeGreaterThanOrEqual(3);
        await expect(page.locator("#pb-selbar")).toBeVisible();

        await page.locator('[data-align="left"]').click();
        await wait(300);
        const lefts = await page.evaluate(() => [...document.querySelectorAll(".pb-card.is-selected")].map((c) => c.offsetLeft));
        expect(new Set(lefts).size).toBe(1);
        await page.keyboard.press("Control+z");
        await wait(300);

        const frames = await count(".pb-frame");
        await page.locator("#pb-sel-group").click();
        await expect(page.locator(".pb-frame")).toHaveCount(frames + 1);
        await page.keyboard.press("Escape");

        const total = (await items()).length;
        await page.locator("#pb-area").focus();
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        await expect.poll(async () => (await items()).length).toBe(0);
        await page.keyboard.press("Control+z");
        await expect.poll(async () => (await items()).length).toBe(total);
    });

    await test.step("snapping to another card's edge, with a guide", async () => {
        await page.locator("#pb-fit").click();
        await wait(800);
        const [aId, bId] = await page.evaluate(() => [...document.querySelectorAll(".pb-card.is-unsplash")].slice(0, 2).map((c) => c.dataset.id));
        const pos = (id) => page.evaluate((id) => { const c = document.querySelector(`.pb-card[data-id="${id}"]`); return { l: c.offsetLeft, t: c.offsetTop }; }, id);
        const a = await pos(aId);
        const b = await pos(bId);
        const z = await page.evaluate(() => parseFloat(document.querySelector("#pb-zoom-lvl").textContent) / 100);
        await page.evaluate((id) => (document.querySelector(`.pb-card[data-id="${id}"]`).style.zIndex = 99999), bId);
        const img = await page.locator(`.pb-card[data-id="${bId}"] img`).boundingBox();
        await page.mouse.move(img.x + 20, img.y + 20);
        await page.mouse.down();
        await page.mouse.move(img.x + 20 + (a.l + 3 - b.l) * z, img.y + 20 + 160 * z, { steps: 14 });
        const guide = await page.locator("#pb-guides").getAttribute("d");
        await page.mouse.up();
        await settled(page);
        expect(guide).toBeTruthy();
        expect(Math.abs((await pos(bId)).l - a.l)).toBeLessThan(0.5);
    });

    await test.step("find and minimap", async () => {
        await page.keyboard.press("Control+f");
        await page.locator("#pb-find-q").fill("warm light");
        await expect(page.locator(".pb-card.is-hit")).toHaveCount(1);
        await expect(page.locator("#pb-find-n")).toHaveText("1/1");
        await page.keyboard.press("Escape");
        await expect(page.locator("#pb-find")).toBeHidden();
        await expect(page.locator("#pb-minimap")).toBeVisible();
        const transform = () => page.evaluate(() => document.querySelector("#pb-world").style.transform);
        const v0 = await transform();
        const mm = await page.locator("#pb-minimap").boundingBox();
        await page.mouse.click(mm.x + 10, mm.y + 10);
        await expect.poll(transform).not.toBe(v0);
    });

    await test.step("palette pulls colours and copies a swatch", async () => {
        await page.locator("#pb-palette-btn").click();
        await page.waitForFunction(() => document.querySelectorAll(".pb-swatch").length >= 3, null, { timeout: 20000 });
        const first = await page.locator(".pb-swatch span").first().textContent();
        expect(first).toMatch(/^#[0-9a-f]{6}$/i);
        await page.locator(".pb-swatch").first().click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
        await page.keyboard.press("Escape");
    });

    await test.step("right-click menu, and long-press opens a bottom sheet", async () => {
        // the minimap click above moved the view: frame everything, then use a card nothing covers
        await page.locator("#pb-fit").click();
        await wait(900);
        const at = await page.evaluate(() => {
            for (const c of document.querySelectorAll(".pb-card")) {
                const im = c.querySelector("img");
                if (!im) continue;
                const r = im.getBoundingClientRect();
                const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
                if (document.elementFromPoint(x, y)?.closest(".pb-card") === c) return { x, y };
            }
            return null;
        });
        expect(at).not.toBeNull();
        await page.mouse.click(at.x, at.y, { button: "right" });
        await expect(page.locator("#pb-ctx")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#pb-ctx")).toBeHidden();
        await expect(page.locator("#pb")).toBeVisible();

        const cdp = await page.context().newCDPSession(page);
        // hold until the sheet is up (a busy machine can run the timer late), then lift:
        // lifting the finger must not tap whichever menu item appeared under it
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
        await expect(page.locator("#pb-ctx")).toBeVisible();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await wait(300);
        await expect(page.locator("#pb-ctx")).toBeVisible();
        await expect(page.locator("#pb-ctx")).toHaveClass(/is-sheet/);
        await page.keyboard.press("Escape");
    });

    await test.step("PNG export reports each Unsplash photo as a download", async () => {
        const n = (await items()).filter((x) => x.kind === "unsplash").length;
        unsplash.downloads.length = 0;
        const [file] = await Promise.all([page.waitForEvent("download", { timeout: 40000 }), page.locator("#pb-export-btn").click().then(() => page.locator("#pb-image").click())]);
        const out = info.outputPath("items.png");
        await file.saveAs(out);
        expect(fs.statSync(out).size).toBeGreaterThan(20000);
        await expect.poll(() => unsplash.downloads.length, { timeout: 10000 }).toBe(n);
    });

    const boardFile = info.outputPath("items.json");
    await test.step("board file includes the uploaded image", async () => {
        const [file] = await Promise.all([page.waitForEvent("download"), page.locator("#pb-export-btn").click().then(() => page.locator("#pb-export").click())]);
        await file.saveAs(boardFile);
        const data = JSON.parse(fs.readFileSync(boardFile, "utf8"));
        expect(data.version).toBe(4);
        expect(Object.values(data.media || {}).some((d) => d.startsWith("data:image/"))).toBe(true);
    });

    await test.step("share link: everything but uploads; import restores uploads", async () => {
        await page.locator("#pb-share").click();
        await expect(page.locator("#toast")).toContainText("uploaded image");
        const shareUrl = await page.evaluate(() => navigator.clipboard.readText());

        const p2 = freshPage;
        await p2.goto(shareUrl);
        await p2.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await p2.waitForTimeout(1200);
        const kinds = await p2.evaluate(() => [...document.querySelectorAll(".pb-card")].map((c) => [...c.classList].find((k) => k.startsWith("is-") && k !== "is-selected")));
        expect(kinds).toEqual(expect.arrayContaining(["is-note", "is-link", "is-unsplash"]));
        expect(kinds).not.toContain("is-upload");
        await expect(p2.locator("#pb-add")).toBeHidden();

        await p2.locator("#pb-keep").click();
        await p2.waitForTimeout(400);
        await p2.locator("#pb-export-btn").click();
        await p2.setInputFiles("#pb-import", boardFile);
        await p2.waitForSelector(".pb-card.is-upload img[src^='blob:']", { timeout: 15000 });
    });

    await test.step("a full browser storage shows a warning and is reported", async () => {
        await page.evaluate(() => {
            const real = Storage.prototype.setItem;
            Storage.prototype.setItem = function (k, v) {
                if (k.startsWith("aperture:board:")) throw new DOMException("full", "QuotaExceededError");
                return real.call(this, k, v);
            };
        });
        await page.locator("#pb-area").focus();
        await page.keyboard.press("n");
        await expect(page.locator("#toast")).toHaveAttribute("data-tone", "warn");
        await expect(page.locator("#toast")).toContainText("storage is full");
        await expect.poll(async () => (await beacons(page)).some((b) => b.body.includes("localStorage full"))).toBe(true);
    });
});
