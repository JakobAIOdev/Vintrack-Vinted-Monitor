import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    OWN_PROXY_LIMIT_SETTING_KEY,
    parseOwnProxyLimit,
    resolveOwnProxyLimit,
} from "../../src/lib/own-proxy-limit";
import {
    DEFAULT_MONITOR_MAINTENANCE,
    MONITOR_MAINTENANCE_SETTING_KEY,
} from "../../src/lib/monitor-maintenance";
import {
    DEFAULT_GITHUB_REWARDS_POLICY,
    GITHUB_REWARDS_SETTING_KEY,
} from "../../src/lib/github-rewards";

const db = new PrismaClient();
const userId = "e2e-own-proxy-user";
const groups: number[] = [];
const keys = [
    OWN_PROXY_LIMIT_SETTING_KEY,
    MONITOR_MAINTENANCE_SETTING_KEY,
    GITHUB_REWARDS_SETTING_KEY,
];
let previousSettings: { key: string; value: string }[] = [];

async function setting(key: string, value: string) {
    await db.app_settings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
    });
}
async function monitors(count: number, source = "group", status = "active") {
    const result = [];
    for (let i = 0; i < count; i += 1) {
        result.push(
            await db.monitors.create({
                data: {
                    userId,
                    name: `Own quota ${source} ${i + 1}`,
                    query: "nike",
                    region: "de",
                    status,
                    proxy_source: source,
                    proxy_group_id:
                        source === "group" ? groups[i % groups.length] : null,
                    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
                    notifications_enabled: false,
                },
            }),
        );
    }
    return result;
}
async function activeCount() {
    return db.monitors.count({
        where: { userId, status: "active", proxy_source: "group" },
    });
}
async function openAndCreate(page: Page, name: string) {
    await page.goto("/monitors/new");
    await page.locator('input[name="name"]').fill(name);
    await page.locator('input[name="query"]').fill("nike");
    await page
        .locator('select[name="proxy_group_id"]')
        .selectOption(String(groups[0]));
    await page
        .getByRole("button", { name: "Create Monitor", exact: true })
        .click();
    await expect
        .poll(() => db.monitors.count({ where: { userId, name } }))
        .toBe(1);
}

test("own proxy policy defaults and exemptions", () => {
    for (const raw of [undefined, null, "", "-1", "1.2", "invalid", "Infinity"])
        expect(parseOwnProxyLimit(raw)).toBe(10);
    expect(parseOwnProxyLimit("0")).toBe(0);
    expect(parseOwnProxyLimit("15")).toBe(15);
    expect(resolveOwnProxyLimit("free", false, 10)).toBe(10);
    expect(resolveOwnProxyLimit("free", true, 0)).toBeNull();
    expect(resolveOwnProxyLimit("premium", false, 0)).toBeNull();
    expect(resolveOwnProxyLimit("admin", false, 0)).toBeNull();
});

test.describe("own proxy quota integration", () => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true" ||
            process.env.E2E_TEST_USER_ID !== userId,
        "Run test:e2e:own-proxy against an isolated migrated test database",
    );
    test.describe.configure({ mode: "serial" });
    test.setTimeout(90_000);

    test.beforeAll(async () => {
        previousSettings = await db.app_settings.findMany({
            where: { key: { in: keys } },
            select: { key: true, value: true },
        });
        await db.user.upsert({
            where: { id: userId },
            create: {
                id: userId,
                name: "Own Proxy Test Member",
                email: "own-proxy@vintrack.test",
                role: "free",
            },
            update: { role: "free" },
        });
        await db.monitors.deleteMany({ where: { userId } });
        await db.proxy_groups.deleteMany({ where: { userId } });
        for (const name of ["Own test A", "Own test B"]) {
            const group = await db.proxy_groups.create({
                data: { userId, name, proxies: "http://127.0.0.1:1" },
            });
            groups.push(group.id);
        }
    });
    test.beforeEach(async () => {
        await db.monitors.deleteMany({ where: { userId } });
        await db.user.update({
            where: { id: userId },
            data: { role: "free", monitor_onboarding_status: "completed" },
        });
        await db.github_sponsorships.deleteMany({
            where: { assigned_user_id: userId },
        });
        await db.audit_events.deleteMany({
            where: {
                target_id: userId,
                action: "member.own_proxy_limit_reconciled",
            },
        });
        await setting(OWN_PROXY_LIMIT_SETTING_KEY, "10");
        await setting(
            MONITOR_MAINTENANCE_SETTING_KEY,
            JSON.stringify(DEFAULT_MONITOR_MAINTENANCE),
        );
        await setting(
            GITHUB_REWARDS_SETTING_KEY,
            JSON.stringify({
                ...DEFAULT_GITHUB_REWARDS_POLICY,
                enforcementEnabled: false,
            }),
        );
        await db.$executeRaw`INSERT INTO monitor_limits (scope, active_limit, free_proxy_active_limit, updated_at) VALUES (${"user:" + userId}, NULL, 2, NOW()) ON CONFLICT(scope) DO UPDATE SET active_limit = NULL, free_proxy_active_limit = 2`;
    });
    test.afterAll(async () => {
        await db.monitors.deleteMany({ where: { userId } });
        await db.proxy_groups.deleteMany({ where: { userId } });
        await db.github_reward_accounts.deleteMany({
            where: { github_id: BigInt(998877661) },
        });
        await db.$executeRaw`DELETE FROM monitor_limits WHERE scope = ${"user:" + userId}`;
        await db.app_settings.deleteMany({ where: { key: { in: keys } } });
        for (const row of previousSettings) await setting(row.key, row.value);
        await db.account.deleteMany({ where: { userId, provider: "github" } });
        await db.$disconnect();
    });

    test("counts across groups, excludes paused and free monitors, and honors exemptions", async ({
        request,
    }) => {
        await monitors(10);
        await monitors(3, "group", "paused");
        await monitors(2, "free");
        const usage = async () =>
            await (await request.get("/api/proxy-groups")).json();
        expect((await usage()).ownProxyUsage).toEqual({
            activeCount: 10,
            activeLimit: 10,
        });
        expect((await usage()).freeProxy.usage).toMatchObject({
            activeCount: 2,
            activeLimit: 2,
        });
        for (const role of ["premium", "admin"]) {
            await db.user.update({ where: { id: userId }, data: { role } });
            expect((await usage()).ownProxyUsage.activeLimit).toBeNull();
        }
        await db.user.update({ where: { id: userId }, data: { role: "free" } });
        await db.github_reward_accounts.upsert({
            where: { github_id: BigInt(998877661) },
            create: {
                github_id: BigInt(998877661),
                login: "own-proxy-test",
                star_status: "starred",
            },
            update: {},
        });
        const now = new Date();
        await db.github_sponsorships.create({
            data: {
                id: "own-proxy-test-donation",
                sponsor_github_id: BigInt(998877661),
                assigned_user_id: userId,
                sponsorable_login: "test",
                is_one_time: true,
                is_active: false,
                source: "test",
                sponsored_at: now,
                last_seen_at: now,
                last_verified_at: now,
            },
        });
        expect((await usage()).ownProxyUsage.activeLimit).toBeNull();
        await db.github_sponsorships.update({
            where: { id: "own-proxy-test-donation" },
            data: { reward_revoked_at: now },
        });
        expect((await usage()).ownProxyUsage.activeLimit).toBe(10);
    });

    test("creates the tenth active, saves the eleventh paused, and explains the limit", async ({
        page,
    }) => {
        await monitors(9);
        await openAndCreate(page, "Own tenth");
        expect(await activeCount()).toBe(10);
        await openAndCreate(page, "Own eleventh");
        expect(await activeCount()).toBe(10);
        expect(
            (
                await db.monitors.findFirstOrThrow({
                    where: { userId, name: "Own eleventh" },
                })
            ).status,
        ).toBe("paused");
        await page.goto("/monitors");
        await expect(page.getByText("Own proxies:")).toBeVisible();
        await expect(
            page.getByText(/Limit reached. New own proxy monitors/),
        ).toBeVisible();
        await page.screenshot({
            path: "test-results/own-proxy-member.png",
            fullPage: false,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator("aside")).not.toBeInViewport();
        await expect(page.getByText("Own proxies:")).toBeVisible();
        await page.screenshot({
            path: "test-results/own-proxy-member-mobile.png",
        });
    });

    test("concurrent starts and Start All cannot exceed the quota", async ({
        context,
        page,
    }) => {
        await monitors(9);
        const paused = await monitors(3, "group", "paused");
        const pages = await Promise.all(paused.map(() => context.newPage()));
        await Promise.all(
            pages.map((tab, index) =>
                tab.goto(`/monitors/${paused[index].id}`),
            ),
        );
        await Promise.all(
            pages.map((tab) =>
                tab
                    .getByRole("button", { name: "Resume", exact: true })
                    .click(),
            ),
        );
        await expect.poll(activeCount).toBe(10);
        await page.goto("/monitors");
        await page
            .getByRole("button", { name: "Start All", exact: true })
            .click();
        await expect(
            page.getByText(/Own proxy monitor limit reached \(10\/10\)/),
        ).toBeVisible();
        expect(await activeCount()).toBe(10);
        for (const tab of pages) await tab.close();
        await db.monitors.updateMany({
            where: { userId },
            data: { status: "paused" },
        });
        await page.reload();
        await page
            .getByRole("button", { name: "Start All", exact: true })
            .click();
        await expect.poll(activeCount).toBe(10);
        await expect(
            page.getByText(/2 skipped because of monitor limits/),
        ).toBeVisible();
    });

    test("source switches pause at capacity but group-to-group edits stay active", async ({
        page,
    }) => {
        const own = await monitors(10);
        const [free] = await monitors(1, "free");
        await page.goto(`/monitors/${free.id}/edit`);
        await page
            .locator('select[name="proxy_group_id"]')
            .selectOption(String(groups[0]));
        await page
            .getByRole("button", { name: "Save Changes", exact: true })
            .click();
        await expect
            .poll(
                async () =>
                    (
                        await db.monitors.findUniqueOrThrow({
                            where: { id: free.id },
                        })
                    ).status,
            )
            .toBe("paused");
        expect(await activeCount()).toBe(10);
        await page.goto(`/monitors/${own[0].id}/edit`);
        await page
            .locator('select[name="proxy_group_id"]')
            .selectOption(String(groups[1]));
        await page
            .getByRole("button", { name: "Save Changes", exact: true })
            .click();
        await expect
            .poll(
                async () =>
                    (
                        await db.monitors.findUniqueOrThrow({
                            where: { id: own[0].id },
                        })
                    ).proxy_group_id,
            )
            .toBe(groups[1]);
        expect(
            (await db.monitors.findUniqueOrThrow({ where: { id: own[0].id } }))
                .status,
        ).toBe("active");
    });

    test("admin applies the cap, preserves oldest monitors, retries safely and supports zero", async ({
        page,
    }) => {
        const created = await monitors(13);
        await page.goto("/admin/roles-limits");
        const card = page.locator("section").filter({
            has: page.getByRole("heading", {
                name: "Running Own Proxy Monitor Limit",
            }),
        });
        await card.getByRole("button", { name: "Save and apply" }).click();
        await expect(card.getByRole("status")).toContainText(
            "3 monitor(s) paused",
        );
        expect(
            (
                await db.monitors.findMany({
                    where: { userId, status: "active" },
                    orderBy: { id: "asc" },
                })
            ).map((monitor) => monitor.id),
        ).toEqual(created.slice(0, 10).map((monitor) => monitor.id));
        await card.getByRole("button", { name: "Save and apply" }).click();
        await expect(card.getByRole("status")).toContainText(
            "0 monitor(s) paused",
        );
        expect(
            await db.audit_events.count({
                where: {
                    action: "member.own_proxy_limit_reconciled",
                    target_id: userId,
                },
            }),
        ).toBe(1);
        await card.screenshot({ path: "test-results/own-proxy-admin.png" });
        await page.goto("/monitors");
        await expect(
            page
                .getByRole("status")
                .filter({ hasText: "Paused because the own proxy" }),
        ).toContainText("Own quota group 13");
        await page.goto("/admin/roles-limits");
        await card.getByLabel("Active own proxy monitors per member").fill("0");
        await card.getByRole("button", { name: "Save and apply" }).click();
        await expect.poll(activeCount).toBe(0);
        await card
            .getByLabel("Active own proxy monitors per member")
            .fill("15");
        await card.getByRole("button", { name: "Save and apply" }).click();
        await expect(card.getByRole("status")).toContainText(
            "0 monitor(s) paused",
        );
        expect(await activeCount()).toBe(0);
    });

    test("maintenance resume enforces both independent quotas", async ({
        page,
    }) => {
        await monitors(12, "group", "maintenance_paused");
        await monitors(3, "free", "maintenance_paused");
        await setting(
            MONITOR_MAINTENANCE_SETTING_KEY,
            JSON.stringify({
                ...DEFAULT_MONITOR_MAINTENANCE,
                enabled: true,
                revision: "own-proxy-test-maintenance",
                enabledAt: new Date().toISOString(),
                enabledBy: userId,
            }),
        );
        await page.goto("/admin/monitors");
        await page
            .getByRole("button", { name: "End maintenance", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "End monitor maintenance?" })
            .getByRole("button", {
                name: /Resume \d+ monitors? & end maintenance/,
            })
            .click();
        await expect.poll(activeCount).toBe(10);
        expect(
            await db.monitors.count({
                where: { userId, status: "active", proxy_source: "free" },
            }),
        ).toBe(2);
    });
    test("removing Premium reconciles existing monitors and reports the paused count", async ({
        page,
    }) => {
        // The admin UI intentionally disallows changing your own role.
        const premiumId = "e2e-own-proxy-premium";
        await db.user.upsert({
            where: { id: premiumId },
            create: {
                id: premiumId,
                name: "Own Proxy Premium Member",
                role: "premium",
            },
            update: { role: "premium" },
        });
        await db.monitors.deleteMany({ where: { userId: premiumId } });
        await db.proxy_groups.deleteMany({ where: { userId: premiumId } });
        const group = await db.proxy_groups.create({
            data: {
                userId: premiumId,
                name: "Premium test proxies",
                proxies: "http://127.0.0.1:1",
            },
        });
        await db.monitors.createMany({
            data: Array.from({ length: 13 }, (_, index) => ({
                userId: premiumId,
                name: `Premium own quota ${index}`,
                query: "nike",
                status: "active",
                proxy_source: "group",
                proxy_group_id: group.id,
                notifications_enabled: false,
            })),
        });
        const premiumActiveCount = () =>
            db.monitors.count({
                where: { userId: premiumId, status: "active" },
            });
        await page.goto("/admin/roles-limits");
        const card = page.locator("section").filter({
            has: page.getByRole("heading", {
                name: "Running Own Proxy Monitor Limit",
            }),
        });
        await card.getByRole("button", { name: "Save and apply" }).click();
        await expect(card.getByRole("status")).toContainText(
            "0 monitor(s) paused",
        );
        expect(await premiumActiveCount()).toBe(13);
        await page.goto("/admin/members");
        await page
            .getByPlaceholder("Search by name, email or role...")
            .filter({ visible: true })
            .fill("Own Proxy Premium Member");
        await page
            .getByRole("row", { name: /Own Proxy Premium Member/ })
            .click();
        await page
            .getByRole("dialog", { name: "User Details" })
            .getByRole("button", { name: "Change Role" })
            .click();
        const roleDialog = page.getByRole("dialog", { name: "Change Role" });
        await roleDialog
            .getByRole("button", { name: /Free Standard access/ })
            .click();
        await roleDialog
            .getByRole("button", { name: "Save", exact: true })
            .click();
        await expect.poll(premiumActiveCount).toBe(10);
        await expect(page.getByText(/is now free · 3 paused/)).toBeVisible();
        await db.monitors.deleteMany({ where: { userId: premiumId } });
        await db.proxy_groups.deleteMany({ where: { userId: premiumId } });
    });

    test("a verified GitHub star is limited; revoking a donation reconciles even with rewards disabled", async ({
        page,
        request,
    }) => {
        await db.github_reward_accounts.upsert({
            where: { github_id: BigInt(998877661) },
            create: {
                github_id: BigInt(998877661),
                login: "own-proxy-test",
                claimed_user_id: userId,
                star_status: "starred",
            },
            update: { claimed_user_id: userId, star_status: "starred" },
        });
        await db.account.upsert({
            where: {
                provider_providerAccountId: {
                    provider: "github",
                    providerAccountId: "998877661",
                },
            },
            create: {
                userId,
                provider: "github",
                providerAccountId: "998877661",
                type: "oauth",
            },
            update: { userId },
        });
        const usage = async () =>
            (await (await request.get("/api/proxy-groups")).json())
                .ownProxyUsage;
        await setting(
            GITHUB_REWARDS_SETTING_KEY,
            JSON.stringify({
                ...DEFAULT_GITHUB_REWARDS_POLICY,
                enforcementEnabled: true,
            }),
        );
        expect((await usage()).activeLimit).toBe(10);
        const now = new Date();
        await db.github_sponsorships.create({
            data: {
                id: "own-proxy-test-donation",
                sponsor_github_id: BigInt(998877661),
                assigned_user_id: userId,
                sponsorable_login: "test",
                is_one_time: true,
                is_active: false,
                source: "test",
                sponsored_at: now,
                last_seen_at: now,
                last_verified_at: now,
            },
        });
        await setting(
            GITHUB_REWARDS_SETTING_KEY,
            JSON.stringify({
                ...DEFAULT_GITHUB_REWARDS_POLICY,
                enforcementEnabled: false,
            }),
        );
        expect((await usage()).activeLimit).toBeNull();
        await monitors(13);
        await page.goto("/admin/rewards");
        const donation = page.locator("details:visible").filter({
            has: page.locator("summary").filter({ hasText: "@own-proxy-test" }),
        });
        await donation.locator("summary").click();
        await donation
            .getByPlaceholder("Required revoke reason")
            .fill("Quota regression test");
        await donation
            .getByRole("button", { name: "Revoke", exact: true })
            .click();
        await expect.poll(activeCount).toBe(10);
        expect((await usage()).activeLimit).toBe(10);
    });

    test("overall active limits still constrain exempt and normal own proxy users", async ({
        page,
    }) => {
        await monitors(4);
        await monitors(1, "free");
        await db.$executeRaw`UPDATE monitor_limits SET active_limit = 5 WHERE scope = ${"user:" + userId}`;
        await openAndCreate(page, "Overall capped member");
        expect(await activeCount()).toBe(4);
        await db.user.update({
            where: { id: userId },
            data: { role: "premium" },
        });
        await openAndCreate(page, "Overall capped premium");
        expect(await activeCount()).toBe(4);
    });
});
