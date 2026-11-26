// The pin board: migration, moving, threads, groups, keyboard, zoom, export,
// sharing and the board picker. One flow, because each step builds on the last.
import fs from "node:fs";
import { test, expect, openGrid, openBoard, cardPos, touch, settled } from "./fixtures.js";

test("board: build, edit, export and share a board", async ({ page, freshPage }, info) => {
    const wait = (ms) => page.waitForTimeout(ms);
    const knots = () => page.locator(".pb-knot").count();

    await test.step("legacy pins migrate into a board", async () => {
        await openGrid(page);
        await page.evaluate(() => {
            const pick = state.photos.slice(0, 5).map((p, i) => ({ photo: p, note: i === 0 ? "first note" : "", query: "", at: Date.now(), x: (i % 3) / 2, y: Math.floor(i / 3) * 1.1, r: 1 }));
            localStorage.clear();
            localStorage.setItem("aperture:pins", JSON.stringify(pick));
            localStorage.setItem("aperture:threads", JSON.stringify([{ a: pick[0].photo.id, b: pick[1].photo.id }]));
        });
        await page.reload();
        await page.waitForFunction(() => window.pins && state.photos.length > 5 && !state.loading, null, { timeout: 30000 });
        const mig = await page.evaluate(() => {
            const idx = JSON.parse(localStorage.getItem("aperture:boards"));
            const b = JSON.parse(localStorage.getItem("aperture:board:" + idx.active));
            return { boards: idx.list.length, pins: b.pins.length, threads: b.threads.length, legacy: localStorage.getItem("aperture:pins"), note: b.pins[0].note };
        });
        expect(mig).toEqual({ boards: 1, pins: 5, threads: 1, legacy: null, note: "first note" });
    });

    await test.step("board renders cards, thread and knot", async () => {
        await wait(1500);
        await openBoard(page);
        await expect(page.locator(".pb-card")).toHaveCount(5);
        await expect(page.locator(".pb-knot")).toHaveCount(1);
        await expect(page.locator(".pb-thread")).toHaveCount(1);
        await expect(page.locator("#pb-name")).toHaveValue("My board");
    });

    await test.step("dragging a card moves it, Ctrl+Z puts it back", async () => {
        const box = await page.locator(".pb-card").nth(2).locator("img").boundingBox();
        const before = await cardPos(page, 2);
        await page.mouse.move(box.x + 40, box.y + 40);
        await page.mouse.down();
        await page.mouse.move(box.x + 140, box.y + 90, { steps: 8 });
        await page.mouse.up();
        await settled(page);
        expect((await cardPos(page, 2))[0]).not.toBe(before[0]);
        await page.locator("#pb-area").focus();
        await page.keyboard.press("Control+z");
        await wait(200);
        expect(await cardPos(page, 2)).toEqual(before);
    });

    await test.step("threads: tie, label, cut", async () => {
        const pin = await page.locator(".pb-card").nth(3).locator(".pb-pin").boundingBox();
        const target = await page.locator(".pb-card").nth(4).locator("img").boundingBox();
        await page.mouse.move(pin.x + 8, pin.y + 8);
        await page.mouse.down();
        await page.mouse.move(target.x + 60, target.y + 60, { steps: 12 });
        await page.mouse.up();
        await expect(page.locator(".pb-knot")).toHaveCount(2);

        await page.locator(".pb-knot").first().click();
        await expect(page.locator("#pb-pop")).toBeVisible();
        await page.keyboard.type("same light");
        await page.keyboard.press("Enter");
        await expect(page.locator(".pb-knot.has-label").first()).toHaveText("same light");

        await page.locator(".pb-knot").nth(1).click();
        await page.locator("#pb-pop-cut").click();
        await expect(page.locator(".pb-knot")).toHaveCount(1);
    });

    await test.step("groups: create, and moving a group moves its photos", async () => {
        await page.locator("#pb-fit").click();
        await wait(700);
        await page.locator("#pb-frame").click();
        await wait(400);
        await page.keyboard.type("Warm tones");
        await expect(page.locator(".pb-frame")).toHaveCount(1);
        await expect(page.locator(".pb-frame-title")).toHaveValue("Warm tones");

        const frame = await page.locator(".pb-frame").boundingBox();
        const card = await page.locator(".pb-card").nth(1).locator("img").boundingBox();
        await page.mouse.move(card.x + 20, card.y + 20);
        await page.mouse.down();
        await page.mouse.move(frame.x + frame.width / 2 - card.width / 2 + 20, frame.y + frame.height / 2 - card.height / 2 + 20, { steps: 10 });
        await page.mouse.up();
        await settled(page);
        const inside = await cardPos(page, 1);
        const grip = await page.locator(".pb-frame-grip").boundingBox();
        await page.mouse.move(grip.x + 5, grip.y + 5);
        await page.mouse.down();
        await page.mouse.move(grip.x + 105, grip.y + 55, { steps: 8 });
        await page.mouse.up();
        await settled(page);
        const moved = await cardPos(page, 1);
        expect(moved[0]).toBeGreaterThan(inside[0]);
        expect(moved[1]).toBeGreaterThan(inside[1]);
    });

    await test.step("keyboard: arrows move, T … T ties, Delete + undo", async () => {
        await page.locator(".pb-card").nth(0).focus();
        const k0 = await cardPos(page, 0);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        expect(await cardPos(page, 0)).toEqual([k0[0] + 12, k0[1] + 12]);

        const before = await knots();
        await page.keyboard.press("t");
        await page.locator(".pb-card").nth(2).focus();
        await page.keyboard.press("t");
        await expect(page.locator(".pb-knot")).toHaveCount(before + 1);

        await page.locator(".pb-card").nth(4).focus();
        await page.keyboard.press("Delete");
        await expect(page.locator(".pb-card")).toHaveCount(4);
        await page.keyboard.press("Control+z");
        await expect(page.locator(".pb-card")).toHaveCount(5);
    });

    await test.step("zoom: buttons, Ctrl+wheel, pinch", async () => {
        await page.locator("#pb-zoom-lvl").click();
        await wait(700);
        await page.locator("#pb-zoom-out").click();
        await expect(page.locator("#pb-zoom-lvl")).toHaveText("80%");
        const area = await page.locator("#pb-area").boundingBox();
        await page.mouse.move(area.x + 300, area.y + 300);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await expect(page.locator("#pb-zoom-lvl")).not.toHaveText("80%");

        const t = await touch(page);
        const [cx, cy] = [area.x + area.width / 2, area.y + area.height / 2];
        const z0 = parseInt(await page.locator("#pb-zoom-lvl").textContent());
        await t("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
        for (let i = 1; i <= 8; i++) await t("touchMove", [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]);
        await t("touchEnd", []);
        await wait(200);
        expect(parseInt(await page.locator("#pb-zoom-lvl").textContent())).toBeGreaterThan(z0);
    });

    await test.step("export: PNG and board file", async () => {
        const [png] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.locator("#pb-export-btn").click().then(() => page.locator("#pb-image").click())]);
        const pngPath = info.outputPath("board.png");
        await png.saveAs(pngPath);
        const bytes = fs.readFileSync(pngPath);
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        expect(bytes.length).toBeGreaterThan(20000);

        const [js] = await Promise.all([page.waitForEvent("download"), page.locator("#pb-export-btn").click().then(() => page.locator("#pb-export").click())]);
        const jsPath = info.outputPath("board.json");
        await js.saveAs(jsPath);
        const file = JSON.parse(fs.readFileSync(jsPath, "utf8"));
        expect(file.version).toBe(4);
        expect(file.pins).toHaveLength(5);
        expect(file.threads.some((t) => t.label === "same light")).toBe(true);
        expect(file.frames).toHaveLength(1);
    });

    let shareUrl;
    await test.step("Share copies a #board= link", async () => {
        await page.locator("#pb-share").click();
        await wait(600);
        shareUrl = await page.evaluate(() => navigator.clipboard.readText());
        expect(shareUrl).toContain("#board=z");
    });

    await test.step("board picker: new boards, thumbnails, keyboard", async () => {
        await page.locator("#pb-picker-btn").click();
        await page.locator("#pb-new").click();
        await wait(300);
        await expect(page.locator(".pb-card")).toHaveCount(0);
        await expect(page.locator("#cv-board-n")).toHaveText("0");
        await page.locator("#pb-name").fill("Film refs");
        await page.keyboard.press("Enter");
        await page.locator("#pb-picker-btn").click();
        await page.locator("#pb-new").click();
        await page.locator("#pb-name").fill("Kitchen moodboard");
        await page.keyboard.press("Enter");
        await page.locator("#pb-picker-btn").click();
        await wait(600);
        await expect(page.locator(".pb-opt-name")).toHaveCount(3);
        await expect(page.locator('.pb-opt[aria-selected="true"] .pb-opt-name')).toHaveText("Kitchen moodboard");
        await expect(page.locator(".pb-opt").first().locator("img")).toHaveCount(3);
        await expect(page.locator("#pb-picker-btn")).toHaveAttribute("aria-expanded", "true");

        await page.keyboard.press("Escape");
        await expect(page.locator("#pb-picker-pop")).toBeHidden();
        await expect(page.locator("#pb")).toBeVisible();

        await page.locator("#pb-picker-btn").click();
        await wait(300);
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await expect(page.locator("#pb-picker-name")).toHaveText("My board");
        await expect(page.locator(".pb-card")).toHaveCount(5);
        await expect(page.locator("#pb-picker-pop")).toBeHidden();
        await expect(page.locator("#pb-picker-btn")).toBeFocused();

        await page.locator("#pb-picker-btn").click();
        await page.keyboard.press("f");
        await page.keyboard.press("Enter");
        await expect(page.locator("#pb-picker-name")).toHaveText("Film refs");
    });

    await test.step("a share link opens read-only, and Save a copy keeps it", async () => {
        const p2 = freshPage;
        await p2.goto(shareUrl);
        await p2.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
        await p2.waitForTimeout(1200);
        await expect(p2.locator(".pb-card")).toHaveCount(5);
        await expect(p2.locator(".pb-frame")).toHaveCount(1);
        await expect(p2.locator(".pb-knot.has-label").first()).toHaveText("same light");
        expect(await p2.evaluate(() => location.hash)).toBe("");
        await expect(p2.locator("#pb-tidy")).toBeHidden();
        await p2.locator("#pb-keep").click();
        await expect(p2.locator("#pb")).not.toHaveClass(/is-readonly/);
        expect(await p2.evaluate(() => JSON.parse(localStorage.getItem("aperture:boards")).list.length)).toBe(2);
    });
});
