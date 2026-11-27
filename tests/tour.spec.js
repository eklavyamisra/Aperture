// The first-run walkthrough on the board.
import { test, expect, openGrid, openBoard } from "./fixtures.js";

test("tour: shows once on first open, steps through, ? replays it", async ({ page }) => {
    await openGrid(page);
    // fixtures mark the tour as seen; act like a first visit (no reload, so it stays cleared)
    await page.evaluate(() => {
        localStorage.removeItem("aperture:tour");
        state.photos.slice(0, 3).forEach((p) => window.pins.toggle(p));
    });
    await openBoard(page);

    const tour = page.locator(".tour");
    await expect(tour).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#tour-step")).toHaveText("1 / 5");
    await expect(page.locator(".tour-next")).toBeFocused();
    await expect(page.locator(".tour-ring")).toBeVisible();

    // the ring sits on a real pin
    const pins = await page.locator(".pb-card .pb-pin").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })));
    await page.waitForTimeout(600); // ring glides into place
    const ringNow = await page.locator(".tour-ring").boundingBox();
    expect(pins.some((p) => p.x > ringNow.x && p.x < ringNow.x + ringNow.width && p.y > ringNow.y && p.y < ringNow.y + ringNow.height)).toBe(true);

    await page.locator(".tour-next").click();
    await expect(page.locator("#tour-title")).toHaveText("Bring anything in");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#tour-step")).toHaveText("3 / 5");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#tour-step")).toHaveText("2 / 5");
    for (let i = 0; i < 3; i++) await page.locator(".tour-next").click();
    await expect(page.locator(".tour-next")).toHaveText("Done");
    await page.locator(".tour-next").click();
    await expect(tour).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("aperture:tour"))).toBe("done");

    // reopening the board doesn't show it again
    await page.locator("#pb-close").click();
    await page.waitForSelector("#pb", { state: "hidden" });
    await openBoard(page);
    await page.waitForTimeout(1600);
    await expect(tour).toBeHidden();

    // ? replays it; Escape ends the tour but leaves the board open
    await page.locator("#pb-area").focus();
    await page.keyboard.press("?");
    await expect(tour).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tour).toBeHidden();
    await expect(page.locator("#pb")).toBeVisible();
});

test("tour: never shows on a shared, view-only board", async ({ page, freshPage }) => {
    await openGrid(page);
    await page.evaluate(() => state.photos.slice(0, 2).forEach((p) => window.pins.toggle(p)));
    await openBoard(page);
    await page.locator("#pb-share").click();
    await page.waitForTimeout(500);
    const url = await page.evaluate(() => navigator.clipboard.readText());

    // a first-time visitor: runs after the fixture's "seen" flag
    await freshPage.context().addInitScript(() => localStorage.removeItem("aperture:tour"));
    await freshPage.goto(url);
    await freshPage.waitForSelector("#pb.is-readonly:not([hidden])", { timeout: 30000 });
    await freshPage.waitForTimeout(1600);
    await expect(freshPage.locator(".tour")).toHaveCount(0);
});
