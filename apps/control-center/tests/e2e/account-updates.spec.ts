import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { ACCOUNT_UPDATES_VERSION } from "../../src/lib/account-updates";

const db = new PrismaClient();

test.afterAll(async () => db.$disconnect());

test("Account New badge disappears for the member after a visit, including another browser", async ({
    page,
    browser,
}) => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true",
        "Requires synthetic authentication",
    );
    const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
    const previous = await db.user.findUnique({ where: { id: userId } });
    await db.user.upsert({
        where: { id: userId },
        create: {
            id: userId,
            name: "E2E Account Badge",
            role: "admin",
            monitor_onboarding_status: "completed",
        },
        update: { account_updates_seen_version: 0 },
    });
    const otherContext = await browser.newContext();
    try {
        if (
            process.env.E2E_ACCOUNT_BADGE_SCREENSHOT === "true" &&
            test.info().project.name === "chromium"
        )
            await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("/guide");
        const accountLink = page.locator('aside a[href="/account"]');
        await expect(
            accountLink.getByText("New", { exact: true }),
        ).toBeAttached();
        if (
            process.env.E2E_ACCOUNT_BADGE_SCREENSHOT === "true" &&
            test.info().project.name === "chromium"
        ) {
            await page.screenshot({
                path: "../../docs/screenshots/account-checkout-new.png",
                animations: "disabled",
            });
        }
        // Prefetching or simply rendering the link must not mark the feature seen.
        expect(
            (await db.user.findUniqueOrThrow({ where: { id: userId } }))
                .account_updates_seen_version,
        ).toBe(0);
        await page.goto("/account");
        await expect
            .poll(
                async () =>
                    (await db.user.findUniqueOrThrow({ where: { id: userId } }))
                        .account_updates_seen_version,
            )
            .toBe(ACCOUNT_UPDATES_VERSION);
        const seen = await db.user.findUniqueOrThrow({ where: { id: userId } });
        expect(seen.checkout_enabled).toBe(previous?.checkout_enabled ?? false);
        expect(seen.checkout_risk_version).toBe(
            previous?.checkout_risk_version ?? 0,
        );
        await page.goto("/guide");
        await expect(accountLink.getByText("New", { exact: true })).toHaveCount(
            0,
        );
        const otherPage = await otherContext.newPage();
        await otherPage.goto(new URL("/guide", page.url()).href);
        await expect(
            otherPage
                .locator('aside a[href="/account"]')
                .getByText("New", { exact: true }),
        ).toHaveCount(0);
    } finally {
        await otherContext.close();
        if (previous)
            await db.user.update({
                where: { id: userId },
                data: {
                    account_updates_seen_version:
                        previous.account_updates_seen_version,
                },
            });
        else await db.user.delete({ where: { id: userId } });
    }
});
