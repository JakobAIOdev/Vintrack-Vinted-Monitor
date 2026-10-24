import { spawnSync } from "node:child_process";

const testFiles = [
    "dashboard.spec.ts",
    "proxy-validation.spec.ts",
    "account-updates.spec.ts",
    "account-automations.spec.ts",
    "extension-companion.spec.ts",
    "feed.spec.ts",
    "admin.spec.ts",
    "announcement.spec.ts",
    "maintenance.spec.ts",
    "inactive-member-policy.spec.ts",
    "github-rewards.spec.ts",
].map((file) => `tests/e2e/${file}`);

const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    E2E_TEST_MODE: "true",
    E2E_SEED_DB: "true",
    PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? "3101",
};
delete env.FORCE_COLOR;

// Both projects mutate the same monitor fixtures. Reseed before each browser.
for (const project of ["chromium", "mobile-chrome"]) {
    const result = spawnSync(
        process.execPath,
        [
            "node_modules/@playwright/test/cli.js",
            "test",
            ...testFiles,
            `--project=${project}`,
            "--workers=1",
            ...process.argv.slice(2),
        ],
        { stdio: "inherit", env },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
