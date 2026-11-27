// Phone layouts: the photo viewer keeps Close and its actions on screen
// without scrolling, and nothing on the home page sits over the search field.
import { test, expect, openGrid, openBoard } from "./fixtures.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const onScreen = (page, sel) =>
    page.locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
        // the element itself (or its child) is what a tap in its middle would hit
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (el === hit || el.contains(hit));
    });

const VIEWER = ["#lb-close", "#lb-download", "#lb-open", "#lb-pin"];

test("phone: viewer keeps Close and actions in reach", async ({ page }) => {
    await openGrid(page, "?q=forest");
    await page.evaluate(() => openLightbox(0));
    await page.waitForFunction(() => !lightbox.hidden && !lb.busy);

    for (const s of VIEWER) expect(await onScreen(page, s), `${s} visible upright`).toBe(true);
    // short labels on phones; the full ones stay for screen readers
    await expect(page.locator("#lb-pin")).toHaveAccessibleName(/Pin to /);
    await expect(page.locator("#lb-open")).toHaveAccessibleName(/View on Unsplash/);

    // scrolled to the end of the details, Close is still there
    await page.locator(".lb-panel").evaluate((el) => (el.scrollTop = el.scrollHeight));
    for (const s of VIEWER) expect(await onScreen(page, s), `${s} visible after scrolling`).toBe(true);

    for (const s of VIEWER) {
        const box = await page.locator(s).boundingBox();
        expect(box.height, `${s} touch target`).toBeGreaterThanOrEqual(44);
    }

    // turned on its side
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(400);
    for (const s of VIEWER) expect(await onScreen(page, s), `${s} visible sideways`).toBe(true);

    await page.locator("#lb-close").tap();
    await page.waitForFunction(() => lightbox.hidden);
});

test("phone: board toolbar fits on screen, Find works, the rest folds behind ⋯", async ({ page }) => {
    await openGrid(page, "?q=forest");
    await openBoard(page);
    const tools = page.locator("#pb-tools");
    // no sideways scrolling
    expect(await tools.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const s of ["#pb-add", "#pb-find-btn", "#pb-more", "#pb-close"]) expect(await onScreen(page, s), `${s} in the main row`).toBe(true);
    await expect(page.locator("#pb-tidy")).toBeHidden();

    await page.locator("#pb-find-btn").tap();
    await expect(page.locator("#pb-find")).toBeVisible();
    expect(await onScreen(page, "#pb-find-q")).toBe(true);
    await page.locator("#pb-find-close").tap();

    await page.locator("#pb-more").tap();
    await expect(page.locator("#pb-more")).toHaveAttribute("aria-expanded", "true");
    for (const s of ["#pb-fit", "#pb-frame", "#pb-tidy", "#pb-palette-btn", "#pb-share", "#pb-export-btn"]) expect(await onScreen(page, s), `${s} after ⋯`).toBe(true);
    expect(await tools.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // one-shot tools fold the row away again
    await page.locator("#pb-fit").tap();
    await expect(page.locator("#pb-more")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#pb-tidy")).toBeHidden();
    // and Escape folds it too, before it would close the board
    await page.locator("#pb-more").tap();
    await page.keyboard.press("Escape");
    await expect(page.locator("#pb-more")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#pb")).toBeVisible();
});

test("phone: hero photos stay clear of the search field", async ({ page }) => {
    await openGrid(page, "");
    const field = await page.locator(".search--hero .search-field").boundingBox();
    const floats = await page.locator(".hero-float .float").evaluateAll((els) =>
        els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getBoundingClientRect().toJSON())
    );
    for (const f of floats) {
        const overlap = f.left < field.x + field.width && f.right > field.x && f.top < field.y + field.height && f.bottom > field.y;
        expect(overlap, `float at ${Math.round(f.top)}px overlaps the search field`).toBe(false);
    }
});

test.describe("short laptop screen", () => {
    test.use({ viewport: { width: 1366, height: 768 }, hasTouch: false, isMobile: false });

    test("viewer: only the details scroll; Close and actions stay put", async ({ page }) => {
        await openGrid(page, "?q=forest");
        await page.evaluate(() => openLightbox(0));
        await page.waitForFunction(() => !lightbox.hidden && !lb.busy);

        // the details are taller than the panel here, so they must be the part that scrolls
        await page.locator(".lb-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.locator(".lb-panel").evaluate((el) => (el.scrollTop = el.scrollHeight));
        for (const s of VIEWER) expect(await onScreen(page, s), `${s} visible after scrolling`).toBe(true);

        // the two quieter actions share a row under Download
        const [dl, open, pin] = await Promise.all(["#lb-download", "#lb-open", "#lb-pin"].map((s) => page.locator(s).boundingBox()));
        expect(Math.round(open.y)).toBe(Math.round(pin.y));
        expect(open.y).toBeGreaterThan(dl.y);
        expect(open.height).toBeLessThan(60); // one line, not wrapped

        await page.locator("#lb-close").click();
        await page.waitForFunction(() => lightbox.hidden);
    });

    test("board toolbar: one grouped row, nothing folded away", async ({ page }) => {
        await openGrid(page, "?q=forest");
        await openBoard(page);
        await expect(page.locator("#pb-more")).toBeHidden();
        const tops = await page.locator("#pb-tools > button:visible").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        expect(new Set(tops).size, "all tools on one line").toBe(1);
        expect(await page.locator(".pb-sep:visible").count()).toBeGreaterThan(2);
    });
});
