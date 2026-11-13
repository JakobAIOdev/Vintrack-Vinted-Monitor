import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const db = new PrismaClient();
const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";

test.afterAll(async () => {
    await db.$disconnect();
});

test("remembers a webhook after its monitor is deleted and keeps destinations private", async ({
    page,
}, testInfo) => {
    const suffix = `${testInfo.project.name}_${Date.now()}`;
    const name = `Saved webhook ${suffix}`;
    const url = `https://discord.com/api/webhooks/123456789012345678/synthetic_${suffix}`;
    const otherUrl = `https://discord.com/api/webhooks/987654321098765432/other_${suffix}`;
    const otherUserId = `webhook-other-${suffix}`;
    const otherName = `Other member ${suffix}`;
    const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");

    await db.user.create({ data: { id: otherUserId } });
    await db.discord_webhooks.create({
        data: {
            userId: otherUserId,
            name: otherName,
            url: otherUrl,
            url_hash: hash(otherUrl),
        },
    });

    const openNotifications = async () => {
        await page
            .locator("summary")
            .filter({
                has: page.getByText("Notifications", { exact: true }),
            })
            .click();
    };

    try {
        await page.goto("/monitors/new");
        await page.getByLabel("Monitor Name").fill(name);
        await openNotifications();
        // Loading saved destinations must never choose one implicitly.
        await expect(page.locator("#discord_webhook")).toHaveValue("");
        await page.locator("#discord_webhook").fill(url);
        await page.getByRole("button", { name: "Create Monitor" }).click();
        await expect(page).toHaveURL(/\/monitors\/\d+$/);

        const firstId = Number(page.url().match(/\/monitors\/(\d+)$/)?.[1]);
        const destination = await db.discord_webhooks.findUniqueOrThrow({
            where: { userId_url_hash: { userId, url_hash: hash(url) } },
        });
        expect(destination.name).toBe(name);
        await db.monitors.delete({ where: { id: firstId, userId } });

        await page.goto("/monitors/new");
        await openNotifications();
        const saved = page.getByLabel("Saved Discord webhooks", {
            exact: true,
        });
        await expect(saved).toBeEnabled();
        await expect(
            saved.locator("option", { hasText: otherName }),
        ).toHaveCount(0);
        await expect(saved.locator("option", { hasText: name })).toContainText(
            "123456789012345678",
        );
        await expect(saved).not.toContainText(`synthetic_${suffix}`);
        await saved.selectOption(String(destination.id));
        await expect(page.locator("#discord_webhook")).toHaveValue(url);
        await saved.selectOption("");
        await expect(page.locator("#discord_webhook")).toHaveValue("");
        await saved.selectOption(String(destination.id));
        await page.getByLabel("Monitor Name").fill(`${name} reused`);
        await page.getByRole("button", { name: "Create Monitor" }).click();
        await expect(page).toHaveURL(/\/monitors\/\d+$/);
        const secondId = Number(page.url().match(/\/monitors\/(\d+)$/)?.[1]);
        await expect(
            db.monitors.findUniqueOrThrow({
                where: { id: secondId },
                select: { discord_webhook: true },
            }),
        ).resolves.toEqual({ discord_webhook: url });
        expect(
            await db.discord_webhooks.count({
                where: { userId, url_hash: hash(url) },
            }),
        ).toBe(1);

        await page.goto(`/monitors/${secondId}/edit`);
        await openNotifications();
        await expect(
            page.getByLabel("Saved Discord webhooks", { exact: true }),
        ).toHaveValue(String(destination.id));
        await expect(page.locator("#discord_webhook")).toHaveValue(url);
    } finally {
        await db.monitors.deleteMany({
            where: { userId, name: { startsWith: name } },
        });
        await db.discord_webhooks.deleteMany({
            where: { userId, url_hash: hash(url) },
        });
        await db.user.delete({ where: { id: otherUserId } });
    }
});
