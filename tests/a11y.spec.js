// Automated accessibility scan (axe-core, WCAG 2.1 A/AA rules). Fails on
// serious or critical problems; lists the rest in the report.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openGrid, openBoard } from "./fixtures.js";

async function scan(page, info, name, include) {
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    if (include) builder = builder.include(include);
    const { violations } = await builder.analyze();
    const summary = violations.map((v) => `${v.impact}  ${v.id}: ${v.help}\n${v.nodes.slice(0, 4).map((n) => `    ${n.target.join(" ")}`).join("\n")}`);
    await info.attach(`axe-${name}.txt`, { body: summary.join("\n\n") || "no violations", contentType: "text/plain" });
    const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`), `${name}: serious/critical axe violations`).toEqual([]);
}

test("a11y: search grid", async ({ page }, info) => {
    await openGrid(page, "?q=coast");
    await page.waitForTimeout(800);
    await scan(page, info, "grid");
});

test("a11y: photo viewer", async ({ page }, info) => {
    await openGrid(page, "?q=coast");
    await page.evaluate(() => openLightbox(0));
    await page.waitForFunction(() => !lb.busy, null, { timeout: 5000 });
    await scan(page, info, "viewer", "#lightbox");
});

test("a11y: board, menu and walkthrough", async ({ page }, info) => {
    await openGrid(page);
    await page.evaluate(() => state.photos.slice(0, 4).forEach((p) => window.pins.toggle(p)));
    await openBoard(page);
    await page.locator("#pb-area").focus();
    await page.keyboard.press("n");
    await page.keyboard.type("note");
    await page.keyboard.press("Escape");
    await scan(page, info, "board", "#pb");

    await page.locator("#pb-add").click();
    await expect(page.locator("#pb-add-menu")).toBeVisible();
    await scan(page, info, "add-menu", "#pb-add-menu");
    await page.keyboard.press("Escape");

    await page.locator("#pb-area").focus();
    await page.keyboard.press("?");
    await expect(page.locator(".tour")).toBeVisible();
    await scan(page, info, "tour", ".tour");
});

for (const path of ["/privacy", "/terms"]) {
    test(`a11y: ${path}`, async ({ page }, info) => {
        await page.goto(path);
        await scan(page, info, path.slice(1));
    });
}
