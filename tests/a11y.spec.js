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
    // the intro fades the hero text in from transparent: scan once it has landed,
    // or axe measures contrast mid-fade
    await page.waitForFunction(() => [...document.querySelectorAll(".hero-meta > *, .search--hero > *, #nav > *")].every((el) => getComputedStyle(el).opacity === "1"), null, { timeout: 15000 });
    await scan(page, info, "grid");
});

test("a11y: photo viewer", async ({ page }, info) => {
    await openGrid(page, "?q=coast");
    // check and open in one step: the grid can swap its cards between two separate calls
    await page.waitForFunction(() => state.cards?.[0]?.isConnected && state.photos[0] && (openLightbox(0), true), null, { timeout: 15000 });
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

test("a11y: account dialog", async ({ page }, info) => {
    // a backend that is configured but signed out, so the sign-in form shows
    await page.addInitScript(() => {
        window.__apertureBackend = { session: async () => null, onChange() {}, signOut: async () => {} };
    });
    await openGrid(page);
    await openBoard(page);
    await page.locator("#pb-account").click();
    await expect(page.locator("#acct-email")).toBeFocused();
    await scan(page, info, "account", "#acct");
});

test("a11y: share panel and password prompt", async ({ page }, info) => {
    // signed in, with a board that already has a password-protected link
    await page.addInitScript(() => {
        window.__apertureBackend = {
            session: async () => ({ id: "user-1", email: "a11y@example.com" }),
            onChange() {},
            signOut: async () => {},
            list: async () => [],
            get: async () => [],
            upsert: async () => {},
            putBlob: async () => {},
            getBlob: async () => null,
            findShare: async () => ({ code: "AbCdEf1234", protected: true }),
            createShare: async () => {},
        };
    });
    await openGrid(page);
    await page.evaluate(() => state.photos.slice(0, 2).forEach((p) => window.pins.toggle(p)));
    await openBoard(page);
    await page.locator("#pb-share").click();
    await expect(page.locator("#share-pass-form")).toBeVisible();
    await expect(page.locator("#share-copy")).toBeFocused();
    await scan(page, info, "share", "#share");
    await page.keyboard.press("Escape");
    await expect(page.locator("#share")).toBeHidden();

    await page.evaluate(() => void window.share.unlock("AbCdEf1234"));
    await expect(page.locator("#share-unlock-pass")).toBeFocused();
    await scan(page, info, "unlock", "#share");
});

for (const path of ["/privacy", "/terms"]) {
    test(`a11y: ${path}`, async ({ page }, info) => {
        await page.goto(path);
        await scan(page, info, path.slice(1));
    });
}
