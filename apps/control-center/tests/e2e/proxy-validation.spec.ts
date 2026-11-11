import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
const prefix = "E2E Proxy Validation ";

async function openCreate(page: Page, name: string, proxies: string) {
    await page.goto("/proxies");
    await page.getByRole("button", { name: "New Group", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Group Name", { exact: true }).fill(name);
    await dialog.getByLabel("Proxies", { exact: true }).fill(proxies);
    await dialog
        .getByRole("button", { name: "Create Group", exact: true })
        .click();
}

test.describe("Proxy group validation", () => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true",
        "Requires a seeded isolated test database",
    );
    test.describe.configure({ mode: "serial" });

    test.afterEach(async () => {
        await db.proxy_groups.deleteMany({
            where: { userId, name: { startsWith: prefix } },
        });
    });
    test.afterAll(async () => {
        await db.$disconnect();
    });

    test("filters group health and regions, recovers empty results and expands with the keyboard", async ({
        page,
    }) => {
        for (const [name, region, status, working] of [
            ["Residential DE", "de", "completed", 2],
            ["Backup France", "fr", "completed", 0],
            ["New group", null, "idle", 0],
        ] as const) {
            await db.proxy_groups.create({
                data: {
                    userId,
                    name: `${prefix}${name}`,
                    proxies: "http://alice:password@proxy.example.com:8080",
                    proxy_check_region: region,
                    proxy_check_status: status,
                    proxy_check_total: 2,
                    proxy_check_checked: status === "completed" ? 2 : 0,
                    proxy_check_working: working,
                },
            });
        }
        await page.goto("/proxies");
        const search = page.getByRole("searchbox", {
            name: "Search proxy groups",
        });
        await search.fill("France");
        await expect(page.getByTestId("proxy-group-card")).toHaveCount(1);
        await expect(page.getByTestId("proxy-group-card")).toContainText(
            "Backup France",
        );
        await search.fill("Germany");
        await expect(page.getByTestId("proxy-group-card")).toHaveCount(1);
        await expect(page.getByTestId("proxy-group-card")).toContainText(
            "Residential DE",
        );
        const filters = page.getByRole("group", {
            name: "Filter proxy groups by health",
        });
        await filters
            .getByRole("button", { name: "Attention", exact: true })
            .click();
        await expect(
            page.getByText("No matching proxy groups", { exact: true }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Clear search and filters" })
            .click();
        await filters
            .getByRole("button", { name: "Unchecked", exact: true })
            .click();
        await expect(page.getByTestId("proxy-group-card")).toHaveCount(1);
        const expand = page.getByRole("button", {
            name: `Expand ${prefix}New group`,
            exact: true,
        });
        await expand.focus();
        await page.keyboard.press("Enter");
        const collapse = page.getByRole("button", {
            name: `Collapse ${prefix}New group`,
            exact: true,
        });
        await expect(collapse).toHaveAttribute("aria-expanded", "true");
        const card = page.getByTestId("proxy-group-card");
        await expect(card.locator("pre")).toContainText("alice:****@");
        await expect(card.locator("pre")).not.toContainText("password");
        await expect(
            card.getByLabel(`Check region for ${prefix}New group`),
        ).toBeVisible();
        await card.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(card.getByLabel("Name", { exact: true })).toHaveValue(
            `${prefix}New group`,
        );
        await card.getByRole("button", { name: "Cancel", exact: true }).click();
        await collapse.focus();
        await page.keyboard.press("Space");
        await expect(expand).toHaveAttribute("aria-expanded", "false");
    });

    test("confirms proxy deletion and restores focus when cancelled", async ({
        page,
    }) => {
        const group = await db.proxy_groups.create({
            data: {
                userId,
                name: `${prefix}Delete fixture`,
                proxies: "http://proxy.example.com:8080",
            },
        });
        await page.goto("/proxies");
        const trigger = page.getByRole("button", {
            name: `Delete ${group.name}`,
            exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole("dialog", {
            name: "Delete proxy group?",
        });
        await expect(dialog).toContainText("No monitors use this group.");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        expect(
            await db.proxy_groups.findUnique({ where: { id: group.id } }),
        ).not.toBeNull();
        await trigger.click();
        await dialog
            .getByRole("button", { name: "Delete group", exact: true })
            .click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toHaveCount(0);
        expect(
            await db.proxy_groups.findUnique({ where: { id: group.id } }),
        ).toBeNull();
    });

    test("keeps proxy groups usable with enlarged text in both themes", async ({
        page,
    }) => {
        const name = `${prefix}Residential-group-with-a-long-name-for-narrow-screens`;
        await db.proxy_groups.create({
            data: { userId, name, proxies: "http://proxy.example.com:8080" },
        });
        await page.setViewportSize({ width: 320, height: 844 });
        await page.goto("/proxies");
        await page
            .getByRole("button", { name: `Expand ${name}`, exact: true })
            .click();
        for (const dark of [false, true]) {
            await page.evaluate((dark) => {
                document.documentElement.style.fontSize = "200%";
                document.documentElement.classList.toggle("dark", dark);
            }, dark);
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <= innerWidth,
                    ),
                )
                .toBe(true);
        }
    });

    test("rejects invalid hosts, ports and mapped internal addresses without saving", async ({
        page,
    }, testInfo) => {
        const name = `${prefix}Invalid ${testInfo.project.name}`;
        await openCreate(
            page,
            name,
            [
                "999.999.999.999:8080",
                "proxy.example.com:0",
                "proxy.example.com:65536",
                "http://[::ffff:127.0.0.1]:8080",
                "socks5://[::ffff:169.254.169.254]:1080",
                "localhost.:8080",
            ].join("\n"),
        );
        // Production intentionally masks thrown Server Action error messages.
        await expect(
            page.locator('[data-sonner-toast][data-type="error"]').last(),
        ).toBeVisible();
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(await db.proxy_groups.count({ where: { userId, name } })).toBe(
            0,
        );
    });

    test("saves only valid entries and preserves credentials, explicit ports and public IPv6", async ({
        page,
    }, testInfo) => {
        const name = `${prefix}Mixed ${testInfo.project.name}`;
        await openCreate(
            page,
            name,
            [
                "proxy.example.com:80:alice:part:two#%",
                "http://[::ffff:127.0.0.1]:8080",
                "https://[2001:4860:4860::8888]:443",
                "proxy.example.com:99999",
            ].join("\n"),
        );
        await expect(page.getByText(name, { exact: true })).toBeVisible();
        const group = await db.proxy_groups.findFirstOrThrow({
            where: { userId, name },
        });
        expect(group.proxies).toBe(
            [
                "http://alice:part%3Atwo%23%25@proxy.example.com:80",
                "https://[2001:4860:4860::8888]:443",
            ].join("\n"),
        );
        await page.getByText(name, { exact: true }).click();
        const card = page
            .locator('[data-slot="card"]')
            .filter({ has: page.getByText(name, { exact: true }) });
        await expect(card.locator("pre")).toContainText("alice:****@");
        await expect(card.locator("pre")).not.toContainText("part");
    });

    test("validates edits and displays the normalized saved proxies", async ({
        page,
    }, testInfo) => {
        const name = `${prefix}Edit ${testInfo.project.name}`;
        await openCreate(page, name, "proxy.example.com:8080");
        await expect(page.getByText(name, { exact: true })).toBeVisible();
        const group = await db.proxy_groups.findFirstOrThrow({
            where: { userId, name },
        });
        await page.getByText(name, { exact: true }).click();
        const card = page
            .locator('[data-slot="card"]')
            .filter({ has: page.getByText(name, { exact: true }) });
        await card.getByRole("button", { name: "Edit", exact: true }).click();
        await card.locator("textarea").fill("http://[::ffff:10.0.0.1]:8080");
        await card.getByRole("button", { name: "Save", exact: true }).click();
        // Production intentionally masks thrown Server Action error messages.
        await expect(
            page.locator('[data-sonner-toast][data-type="error"]').last(),
        ).toBeVisible();
        expect(
            (
                await db.proxy_groups.findUniqueOrThrow({
                    where: { id: group.id },
                })
            ).proxies,
        ).toBe(group.proxies);
        await card
            .locator("textarea")
            .fill(
                "proxy.example.com:8080:alice:part:two#%\nproxy.example.com:0",
            );
        await card.getByRole("button", { name: "Save", exact: true }).click();
        await expect(card.locator("textarea")).toHaveCount(0);
        await expect(card.locator("pre")).toContainText("alice:****@");
        await expect(card.locator("pre")).not.toContainText("part");
        const saved = await db.proxy_groups.findUniqueOrThrow({
            where: { id: group.id },
        });
        expect(saved.proxies).toBe(
            "http://alice:part%3Atwo%23%25@proxy.example.com:8080",
        );
        await card.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(card.locator("textarea")).toHaveValue(saved.proxies);
    });
});
