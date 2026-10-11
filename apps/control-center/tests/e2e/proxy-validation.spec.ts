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
