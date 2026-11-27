// The boot loader: a camera iris that opens with load progress (tick ring +
// f-stop readout), then opens fully to reveal the page.
import { test, expect } from "./fixtures.js";

test("loader: iris fills, stops down to f/1.4 and opens onto the page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#iris-ticks line")).toHaveCount(60);
    await expect(page.locator("#iris-blades")).toHaveAttribute("d", /Z.+Z$/);

    // finishes at full progress, then hides itself
    await expect(page.locator("#loader-fstop")).toHaveText("1.4", { timeout: 15000 });
    await expect(page.locator("#iris-ticks line.on")).toHaveCount(60);
    await expect(page.locator("#loader")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("body")).not.toHaveClass(/is-loading/);
    // the first fetched frame was shown developing inside the lens
    await expect(page.locator("#loader-frame")).toHaveAttribute("src", /images\.unsplash\.com|^data:|^blob:|\/img/);
});

test("loader: reduced motion skips straight to the page", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const { prepare } = await import("./fixtures.js");
    await prepare(context);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#loader")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#loader-fstop")).toHaveText("1.4");
    await context.close();
});
