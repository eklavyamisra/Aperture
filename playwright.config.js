// Browser tests. Unsplash is mocked (tests/mock.js), so no API key is needed.
//   npm run test:e2e
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
// CI runners have no GPU: let Chromium fall back to software WebGL for the canvas wall
const SOFTWARE_GL = !!process.env.CI || !!process.env.SOFTWARE_GL;

export default defineConfig({
    testDir: "tests",
    testMatch: "*.spec.js",
    timeout: 240_000,
    expect: { timeout: 8_000 },
    fullyParallel: true,
    // each test drives a WebGL wall; more than two at once starves the GPU-less CI runner
    workers: 2,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1440, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        launchOptions: SOFTWARE_GL ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {},
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
    webServer: {
        command: "node dev.mjs",
        env: { PORT: String(PORT) },
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
