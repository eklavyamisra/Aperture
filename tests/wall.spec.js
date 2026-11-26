// Search, the canvas wall and the photo viewer.
import { test, expect, openCanvas, touch } from "./fixtures.js";

test("grid search shows results with credits", async ({ page }) => {
    await page.goto("/?q=coast");
    await page.waitForFunction(() => state.mode === "search" && state.photos.length > 0, null, { timeout: 30000 });
    expect(await page.evaluate(() => state.query)).toBe("coast");
    await expect(page.locator("figure").first()).toBeVisible();
});

test("canvas: tone row, tone filter and pinch zoom", async ({ page }) => {
    await openCanvas(page);
    await expect(page.locator("#cv-tones")).toBeHidden();
    await page.locator("#cv-q").fill("forest");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => state.mode === "search" && state.photos.length > 0, null, { timeout: 20000 });
    await expect(page.locator("#cv-tones")).toBeVisible();
    await page.locator('#cv-tones [data-color="green"]').click();
    await page.waitForFunction(() => state.color === "green" && state.photos.length > 0, null, { timeout: 20000 });

    const t = await touch(page);
    const z0 = parseInt(await page.locator("#cv-zoom-lvl").textContent());
    await t("touchStart", [[700, 450], [780, 450]]);
    for (let i = 1; i <= 8; i++) await t("touchMove", [[700 - i * 15, 450], [780 + i * 15, 450]]);
    await t("touchEnd", []);
    await page.waitForTimeout(200);
    expect(parseInt(await page.locator("#cv-zoom-lvl").textContent())).toBeGreaterThan(z0);
});

test("viewer: Like this, By photographer, and the shape filter", async ({ page }) => {
    await page.goto("/?q=forest");
    await page.waitForFunction(() => state.mode === "search" && !state.loading && state.photos.length > 0, null, { timeout: 30000 });

    await page.evaluate(() => openLightbox(0));
    await page.waitForFunction(() => !lb.busy, null, { timeout: 5000 });
    const hint = await page.locator("#lb-similar").getAttribute("title");
    await page.locator("#lb-similar").click();
    await page.waitForFunction(() => lightbox.hidden && state.query !== "forest" && !state.loading && state.photos.length > 0, null, { timeout: 20000 });
    expect(hint).toContain(await page.evaluate(() => state.query));

    await page.evaluate(() => openLightbox(0));
    await page.waitForFunction(() => !lb.busy, null, { timeout: 5000 });
    const username = await page.evaluate(() => state.photos[0].user.username);
    const token = await page.evaluate(() => state.token);
    await page.locator("#lb-by").click();
    await page.waitForFunction((t) => state.mode === "user" && state.token > t && !state.loading && state.photos.length > 0, token, { timeout: 20000 });
    const by = await page.evaluate(() => ({ u: state.user.username, all: state.photos.every((p) => p.user.username === state.user.username), url: location.search }));
    expect(by.u).toBe(username);
    expect(by.all).toBe(true);
    expect(by.url).toContain("by=");

    await page.evaluate(() => runSearch("city", { scroll: false }));
    await page.waitForFunction(() => state.mode === "search" && state.query === "city" && state.photos.length > 0, null, { timeout: 20000 });
    const token2 = await page.evaluate(() => state.token);
    await page.locator('[data-orient="portrait"]').click();
    await page.waitForFunction((t) => state.orientation === "portrait" && state.token > t && !state.loading && state.photos.length > 0, token2, { timeout: 20000 });
    expect(await page.evaluate(() => state.photos.every((p) => p.height > p.width))).toBe(true);
});

test("legal pages are served", async ({ request }) => {
    for (const path of ["/privacy", "/terms"]) {
        const r = await request.get(path);
        expect(r.status()).toBe(200);
        expect(await r.text()).toContain("<h1>");
    }
});
