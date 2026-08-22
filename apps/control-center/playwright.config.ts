import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const browserChannel =
    process.env.PLAYWRIGHT_CHANNEL === "bundled" ? undefined : "chrome";
const useProductionBuild =
    process.env.PLAYWRIGHT_USE_PRODUCTION_BUILD === "true";
const webServerCommand = useProductionBuild
    ? "node ci-runtime/server.js"
    : `env -u FORCE_COLOR ./node_modules/.bin/next dev --hostname 127.0.0.1 --port ${port}`;

if (process.env.E2E_SEED_DB === "true") {
    execFileSync("node", ["scripts/seed-e2e.mjs"], {
        stdio: "inherit",
        env: process.env,
    });
}

export default defineConfig({
    testDir: "./tests/e2e",
    timeout: 30_000,
    expect: {
        timeout: 10_000,
    },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [["github"], ["html"]] : "list",
    use: {
        baseURL,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    webServer: process.env.PLAYWRIGHT_BASE_URL
        ? undefined
        : {
              command: webServerCommand,
              url: `${baseURL}/robots.txt`,
              env: {
                  ...process.env,
                  ...(useProductionBuild
                      ? {
                            HOSTNAME: "127.0.0.1",
                            PORT: String(port),
                        }
                      : { NEXT_DIST_DIR: `.next-e2e-${port}` }),
                  E2E_TEST_MODE: process.env.E2E_TEST_MODE ?? "",
                  E2E_TEST_USER_ID: process.env.E2E_TEST_USER_ID ?? "e2e-user",
                  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL ?? baseURL,
                  SEO_INDEXING_ENABLED:
                      process.env.SEO_INDEXING_ENABLED ?? "true",
              },
              reuseExistingServer:
                  !useProductionBuild &&
                  !process.env.CI &&
                  process.env.E2E_TEST_MODE !== "true",
              timeout: 120_000,
          },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"], channel: browserChannel },
        },
        {
            name: "mobile-chrome",
            use: { ...devices["Pixel 5"], channel: browserChannel },
        },
    ],
});
