import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const adminId = process.env.E2E_TEST_USER_ID ?? "e2e-user";

test.afterAll(async () => {
    await db.$disconnect();
});

test("admin bans stop a member's work and unbanning does not restart it", async ({
    page,
}, testInfo) => {
    const memberId = `ban-member-${testInfo.project.name}-${Date.now()}`;
    const name = `Ban test ${memberId}`;
    await db.user.upsert({
        where: { id: adminId },
        create: { id: adminId, name: "E2E Admin", role: "admin" },
        update: { role: "admin" },
    });
    await db.user.create({ data: { id: memberId, name } });
    const monitor = await db.monitors.create({
        data: {
            userId: memberId,
            name: "Ban fixture",
            query: "jacket",
            status: "active",
            region: "de",
        },
    });
    const target = await db.price_watch_targets.create({
        data: {
            region: "de",
            item_id: BigInt(Date.now()),
            canonical_url: "https://www.vinted.de/items/123-test",
        },
    });
    const schedule = await db.price_watch_schedules.create({
        data: {
            target_id: target.id,
            transport_key: "shared",
            transport_kind: "shared",
        },
    });
    await db.price_watches.create({
        data: {
            user_id: memberId,
            target_id: target.id,
            schedule_id: schedule.id,
        },
    });
    await db.monitor_account_automations.create({
        data: {
            monitor_id: monitor.id,
            kind: "offer",
            enabled: true,
            account_id: BigInt(42),
            domain: "www.vinted.de",
        },
    });
    await db.session.create({
        data: {
            userId: memberId,
            sessionToken: memberId,
            expires: new Date(Date.now() + 60000),
        },
    });
    await db.vinted_browser_links.create({
        data: { userId: memberId, token_hash: "b".repeat(64) },
    });
    const notification = await db.alert_notifications.create({
        data: {
            user_id: memberId,
            monitor_id: monitor.id,
            kind: "item_match",
            payload: {},
            idempotency_key: memberId,
            expires_at: new Date(Date.now() + 60000),
            deliveries: {
                create: ["pending", "processing", "retrying"].map(
                    (status, i) => ({
                        channel: `test-${i}`,
                        status,
                        destination_fingerprint: "a".repeat(64),
                        claim_token: "old-claim",
                    }),
                ),
            },
        },
    });
    try {
        await page.goto("/admin/members");
        await page
            .getByRole("searchbox", { name: "Search members" })
            .fill(memberId);
        await page.getByRole("row").filter({ hasText: name }).click();
        const details = page.getByRole("dialog", {
            name: "User Details",
            exact: true,
        });
        await expect(
            details.getByRole("button", { name: "Ban member", exact: true }),
        ).toBeEnabled();
        await details
            .getByRole("button", { name: "Ban member", exact: true })
            .click();
        const confirmation = page.getByRole("dialog", {
            name: "Ban member?",
            exact: true,
        });
        await expect(confirmation).toContainText("queued alerts cancelled");
        await confirmation
            .getByRole("button", { name: "Ban member", exact: true })
            .click();
        await expect(
            details.getByRole("button", { name: "Unban member", exact: true }),
        ).toBeVisible();
        expect(
            (await db.user.findUniqueOrThrow({ where: { id: memberId } }))
                .banned_at,
        ).not.toBeNull();
        expect(
            (await db.monitors.findUniqueOrThrow({ where: { id: monitor.id } }))
                .status,
        ).toBe("paused");
        expect(
            (
                await db.price_watches.findFirstOrThrow({
                    where: { user_id: memberId },
                })
            ).status,
        ).toBe("paused");
        expect(
            (
                await db.monitor_account_automations.findFirstOrThrow({
                    where: { monitor_id: monitor.id },
                })
            ).enabled,
        ).toBe(false);
        expect(await db.session.count({ where: { userId: memberId } })).toBe(0);
        expect(
            await db.vinted_browser_links.count({
                where: { userId: memberId },
            }),
        ).toBe(0);
        expect(
            await db.alert_deliveries.count({
                where: {
                    notification_id: notification.id,
                    status: "cancelled",
                },
            }),
        ).toBe(3);
        expect(
            await db.audit_events.count({
                where: { action: "admin.member_banned", target_id: memberId },
            }),
        ).toBe(1);

        await details
            .getByRole("button", { name: "Unban member", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "Unban member?", exact: true })
            .getByRole("button", { name: "Unban member", exact: true })
            .click();
        await expect(
            details.getByRole("button", { name: "Ban member", exact: true }),
        ).toBeVisible();
        expect(
            (await db.user.findUniqueOrThrow({ where: { id: memberId } }))
                .banned_at,
        ).toBeNull();
        expect(
            await db.monitors.count({
                where: { userId: memberId, status: "active" },
            }),
        ).toBe(0);
        expect(
            await db.price_watches.count({
                where: { user_id: memberId, status: "active" },
            }),
        ).toBe(0);
        expect(
            await db.monitor_account_automations.count({
                where: { monitor_id: monitor.id, enabled: true },
            }),
        ).toBe(0);
        expect(await db.session.count({ where: { userId: memberId } })).toBe(0);
    } finally {
        await db.alert_notifications.delete({ where: { id: notification.id } });
        await db.user.delete({ where: { id: memberId } });
        await db.price_watch_schedules.delete({ where: { id: schedule.id } });
        await db.price_watch_targets.delete({ where: { id: target.id } });
    }
});
