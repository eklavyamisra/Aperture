// Tied pins: the copy of a pin's head drawn above the threads must sit exactly
// on the real pin, and never show as a second pin while a card is lifted.
// Also: the board keeps a solid backdrop after the window is resized.
import { test, expect, openGrid, openBoard, settled } from "./fixtures.js";

const heads = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll(".pb-pinhead")].map((c) => {
            const card = document.querySelector(`.pb-card[data-id="${CSS.escape(c.dataset.id)}"]`);
            const a = c.getBoundingClientRect();
            const b = card.querySelector(".pb-pin").getBoundingClientRect();
            return { id: c.dataset.id, dx: a.x + a.width / 2 - (b.x + b.width / 2), dy: a.y + a.height / 2 - (b.y + b.height / 2), opacity: +getComputedStyle(c).opacity };
        })
    );

test("threads: one pin per card, even while a card is lifted", async ({ page }) => {
    await openGrid(page);
    await page.evaluate(() => {
        const pick = state.photos.slice(0, 4).map((p, i) => ({ photo: p, note: "", query: "", at: Date.now(), x: (i % 2) / 1.5, y: Math.floor(i / 2) * 1.2, r: [3, -4, 6, -2][i] }));
        localStorage.clear();
        localStorage.setItem("aperture:tour", "done");
        localStorage.setItem("aperture:pins", JSON.stringify(pick));
        localStorage.setItem("aperture:threads", JSON.stringify([{ a: pick[0].photo.id, b: pick[1].photo.id }, { a: pick[2].photo.id, b: pick[3].photo.id }]));
    });
    await page.reload();
    await page.waitForFunction(() => window.pins && state.photos.length > 5 && !state.loading, null, { timeout: 30000 });
    await openBoard(page);

    // worst gap between a copy and its pin, once any card animation has finished
    const aligned = () =>
        expect
            .poll(async () => {
                const hs = await heads(page);
                return hs.length === 4 ? Math.max(...hs.map((h) => Math.max(Math.abs(h.dx), Math.abs(h.dy)))) : Infinity;
            }, { message: "every copy sits on its pin", timeout: 5000 })
            .toBeLessThan(0.6);
    await aligned();

    const card = page.locator(".pb-card").nth(1);
    const id = await card.getAttribute("data-id");
    const box = await card.locator("img").boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 60, { steps: 8 });
    // lifted: the card grows and tilts, so its copy steps aside
    await expect.poll(async () => (await heads(page)).find((h) => h.id === id).opacity).toBe(0);
    await page.mouse.up();
    await settled(page);
    await expect.poll(async () => (await heads(page)).find((h) => h.id === id).opacity).toBe(1);
    await aligned();
});

test("board: the wall behind stays solid after a resize", async ({ page }) => {
    await openGrid(page, "?q=forest");
    await openBoard(page);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#cv")).backgroundColor)).toBe("rgb(13, 12, 10)");
});
