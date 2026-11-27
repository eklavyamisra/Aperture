// Shared Playwright fixtures: every context gets the Unsplash mocks and a
// stand-in for navigator.sendBeacon (Playwright can't see beacons), and every
// test fails if the page threw an uncaught error.
import { test as base, expect } from "@playwright/test";
import { mockUnsplash } from "./mock.js";
export { png } from "./mock.js";

function recordBeacons() {
    // the first-run walkthrough would sit over the board in every test (tour.spec.js turns it back on)
    try {
        localStorage.setItem("aperture:tour", "done");
    } catch (e) {}
    window.__beacons = [];
    navigator.sendBeacon = (url, data) => {
        Promise.resolve(data instanceof Blob ? data.text() : String(data)).then((t) => window.__beacons.push({ url: String(url), body: t }));
        return true;
    };
}

// Without a GPU (CI), Chromium paints every blur and backdrop blur in software
// on each frame, which makes the board crawl. They're decoration only.
function dropBlurs() {
    const css = "*,*::before,*::after{filter:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}";
    const add = () => document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
}

export async function prepare(context) {
    await context.addInitScript(recordBeacons);
    if (process.env.CI || process.env.SOFTWARE_GL) await context.addInitScript(dropBlurs);
    return mockUnsplash(context);
}

// errors a test raises on purpose to check reporting
const EXPECTED = /probe error from test/;

export function watchErrors(page, into) {
    page.on("pageerror", (e) => !EXPECTED.test(e.message) && into.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error" && !/net::|Failed to load resource/.test(m.text())) into.push(`console: ${m.text()}`);
    });
}

export const test = base.extend({
    unsplash: [
        async ({ context }, use) => {
            await use(await prepare(context));
        },
        { auto: true },
    ],
    pageErrors: [
        async ({ page }, use) => {
            const errors = [];
            watchErrors(page, errors);
            await use(errors);
            expect(errors, "uncaught errors on the page").toEqual([]);
        },
        { auto: true },
    ],
    // a second, clean browser profile (for opening share links), mocked the same way
    freshPage: async ({ browser }, use) => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await prepare(ctx);
        const p = await ctx.newPage();
        p.errors = [];
        watchErrors(p, p.errors);
        await use(p);
        await ctx.close();
        expect(p.errors, "uncaught errors on the second page").toEqual([]);
    },
});

export { expect };

/* ---------- helpers used across specs ---------- */

export const openCanvas = async (page, query = "") => {
    await page.goto(`/?view=canvas${query}`);
    await page.waitForFunction(() => window.canvasView?.isOpen && state.photos.length > 5, null, { timeout: 30000 });
};

export const openGrid = async (page, query = "") => {
    await page.goto(`/${query}`);
    await page.waitForFunction(() => window.pins && state.photos.length > 5 && !state.loading, null, { timeout: 30000 });
};

// the board lives on the canvas view: open that first if we're on the grid
export const openBoard = async (page) => {
    await page.evaluate(() => window.canvasView.isOpen || window.canvasView.open());
    await page.waitForFunction(() => window.canvasView.isOpen, null, { timeout: 30000 });
    await page.evaluate(() => window.pins.openBoard());
    await page.waitForSelector("#pb:not([hidden])", { timeout: 30000 });
    await page.waitForTimeout(1200);
};

export const boardItems = (page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem("aperture:board:" + JSON.parse(localStorage.getItem("aperture:boards")).active)).pins);

export const cardPos = (page, i) =>
    page.evaluate((i) => {
        const el = document.querySelectorAll(".pb-card")[i];
        return [el.offsetLeft, el.offsetTop];
    }, i);

// wait until dropped cards have glided to rest and been saved
export const settled = (page) => page.waitForFunction(() => !document.querySelector(".pb-card.is-held, .pb-card.is-carried, .pb-frame.is-held"), null, { timeout: 10000 });

export const beacons = (page) => page.evaluate(() => window.__beacons || []);

export async function touch(page) {
    const cdp = await page.context().newCDPSession(page);
    return (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
}
