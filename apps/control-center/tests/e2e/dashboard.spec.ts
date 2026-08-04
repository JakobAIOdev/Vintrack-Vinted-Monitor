import { expect, test } from "@playwright/test";

test.describe("dashboard overview", () => {
    test("renders seeded monitor summary and monitor card", async ({
        page,
    }) => {
        await page.goto("/dashboard");

        await expect(page).toHaveTitle(/Vintrack/i);
        await expect(
            page.getByRole("heading", { name: /Welcome back, E2E User/i }),
        ).toBeVisible();
        await expect(
            page.getByText("Total Monitors", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Active", { exact: true })).toBeVisible();
        await expect(
            page.getByText("Items Found", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Sponsor Vintrack" }),
        ).toHaveAttribute("href", "https://github.com/sponsors/JakobAIOdev");

        const monitorCard = page
            .getByTestId("monitor-card")
            .filter({ hasText: "E2E Mock Feed" })
            .first();

        await expect(monitorCard).toBeVisible();
        await expect(monitorCard.getByText("Running")).toBeVisible();
        await expect(monitorCard.getByText("Server Proxies")).toBeVisible();
        await expect(monitorCard.getByText(/items found/i)).toBeVisible();
        await expect(
            monitorCard.getByText("Alerts on", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByText("Discord", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByRole("link", { name: /View/i }),
        ).toHaveAttribute("href", "/monitors/990001");
    });

    test("feed APIs return seeded monitor and item metadata", async ({
        request,
    }) => {
        const summaryResponse = await request.get("/api/monitors/summary");
        expect(summaryResponse.ok()).toBe(true);
        await expect(summaryResponse.json()).resolves.toEqual({
            activeMonitors: 1,
            totalMonitors: 1,
        });

        const feedResponse = await request.get("/api/feed");
        expect(feedResponse.ok()).toBe(true);

        const feed = (await feedResponse.json()) as Array<{
            title: string | null;
            brand: string | null;
            price: string | null;
            total_price: string | null;
            size: string | null;
            location: string | null;
            rating: string | null;
            monitor_name: string | null;
            image_url: string | null;
        }>;
        const item = feed.find(
            (entry) => entry.title === "E2E Nike Dunk Low Retro",
        );

        expect(item).toMatchObject({
            brand: "Nike",
            price: "19.00 EUR",
            total_price: "24.49 EUR",
            size: "42",
            location: "🇩🇪 DE",
            rating: "⭐ 4.9 (58)",
            monitor_name: "E2E Mock Feed",
            image_url: "/mock-images/vinted-1.svg",
        });
    });

    test("persists independent Telegram and Discord message styles", async ({
        page,
    }, testInfo) => {
        test.skip(
            testInfo.project.name !== "chromium",
            "Global notification preference mutation is covered once.",
        );
        await page.goto("/dashboard");
        await page.getByRole("button", { name: "Dashboard settings" }).click();

        const settings = page.getByRole("dialog", {
            name: "Dashboard settings",
        });
        await settings.getByLabel("Telegram").selectOption("compact");
        await settings.getByLabel("Discord").selectOption("compact");
        await expect(settings.getByLabel("Telegram")).toHaveValue("compact");
        await expect(settings.getByLabel("Discord")).toHaveValue("compact");
        await expect(settings.getByLabel("Telegram")).toBeEnabled();
        await expect(settings.getByLabel("Discord")).toBeEnabled();

        await settings
            .getByRole("button", { name: "Close", exact: true })
            .last()
            .click();
        await page.reload();
        await page.getByRole("button", { name: "Dashboard settings" }).click();

        const reloadedSettings = page.getByRole("dialog", {
            name: "Dashboard settings",
        });
        await expect(reloadedSettings.getByLabel("Telegram")).toHaveValue(
            "compact",
        );
        await expect(reloadedSettings.getByLabel("Discord")).toHaveValue(
            "compact",
        );

        await reloadedSettings.getByLabel("Telegram").selectOption("rich");
        await reloadedSettings.getByLabel("Discord").selectOption("rich");
        await expect(reloadedSettings.getByLabel("Telegram")).toBeEnabled();
        await expect(reloadedSettings.getByLabel("Discord")).toBeEnabled();
    });

    test("bulk edits query delay and quiet hours", async ({ page }) => {
        await page.goto("/dashboard");

        const monitorCard = page
            .getByTestId("monitor-card")
            .filter({ hasText: "E2E Mock Feed" })
            .first();
        await monitorCard
            .getByRole("checkbox", { name: "Select E2E Mock Feed" })
            .check();
        await page.getByRole("button", { name: "Edit selected" }).click();

        const dialog = page.getByRole("dialog", {
            name: "Bulk edit 1 monitor",
        });
        await expect(dialog).toBeVisible();

        await dialog.getByLabel("Apply query delay").click();
        await dialog.getByLabel("Delay in milliseconds").fill("2500");

        await dialog.getByLabel("Apply quiet hours").click();
        await dialog.getByLabel("Enable quiet hours").click();
        await dialog.getByLabel("Start").fill("01:00");
        await dialog.getByLabel("End").fill("05:00");

        await dialog
            .getByRole("button", { name: "Apply to 1 monitor" })
            .click();
        await expect(dialog).toBeHidden();
        await expect(
            monitorCard.getByText("2.5s", { exact: true }),
        ).toBeVisible();

        await monitorCard.getByRole("link", { name: /View monitor/i }).click();
        await expect(
            page.getByText("Paused 01:00–05:00", { exact: true }),
        ).toBeVisible();
    });

    test("mutes alerts directly and preserves channels through bulk edit", async ({
        page,
    }, testInfo) => {
        test.skip(
            testInfo.project.name !== "chromium",
            "Notification mutation is covered once against the shared E2E database.",
        );
        await page.goto("/dashboard");

        const monitorCard = page
            .getByTestId("monitor-card")
            .filter({ hasText: "E2E Mock Feed" })
            .first();
        const notificationSwitch = monitorCard.getByRole("switch", {
            name: "Notifications for E2E Mock Feed",
        });

        await expect(notificationSwitch).toBeChecked();
        await notificationSwitch.click();
        await expect(
            monitorCard.getByText("Alerts muted", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByText("Discord", { exact: true }),
        ).toBeVisible();

        await page.reload();
        await expect(
            monitorCard.getByText("Alerts muted", { exact: true }),
        ).toBeVisible();

        await monitorCard
            .getByRole("checkbox", { name: "Select E2E Mock Feed" })
            .check();
        await page.getByRole("button", { name: "Edit selected" }).click();

        const bulkDialog = page.getByRole("dialog", {
            name: "Bulk edit 1 monitor",
        });
        await bulkDialog.getByLabel("Alert status").selectOption("enable");
        await bulkDialog
            .getByRole("button", { name: "Apply to 1 monitor" })
            .click();

        await expect(
            monitorCard.getByText("Alerts on", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByText("Discord", { exact: true }),
        ).toBeVisible();

        await monitorCard
            .getByRole("button", {
                name: "Configure notifications for E2E Mock Feed",
            })
            .click();
        const notificationsDialog = page.getByRole("dialog", {
            name: "Notifications",
        });
        await notificationsDialog
            .getByRole("switch", { name: "Enable Discord" })
            .click();
        await notificationsDialog
            .getByRole("button", { name: "Close", exact: true })
            .last()
            .click();

        await expect(
            monitorCard.getByText("Set up alerts", { exact: true }),
        ).toBeVisible();

        await monitorCard
            .getByRole("checkbox", { name: "Select E2E Mock Feed" })
            .check();
        await page.getByRole("button", { name: "Edit selected" }).click();
        const restoreDialog = page.getByRole("dialog", {
            name: "Bulk edit 1 monitor",
        });
        await restoreDialog.getByLabel("Discord").selectOption("enable");
        await restoreDialog
            .getByRole("button", { name: "Apply to 1 monitor" })
            .click();
        await expect(
            monitorCard.getByText("Alerts on", { exact: true }),
        ).toBeVisible();
    });
});
