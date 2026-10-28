import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test.describe.configure({ mode: "serial" });

const db = new PrismaClient();
const fixtureIds = [990701, 990702, 990703];

test.beforeAll(async () => {
    for (const monitor of [
        {
            id: 990701,
            name: "Carhartt workwear",
            query: "carhartt detroit",
            status: "active",
            region: "de",
        },
        {
            id: 990702,
            name: "Vintage outerwear",
            query: "wool overshirt",
            status: "paused",
            region: "fr",
        },
        {
            id: 990703,
            name: "Everyday sneakers",
            query: "new balance",
            status: "paused",
            region: "uk",
        },
    ]) {
        const data = {
            ...monitor,
            userId: process.env.E2E_TEST_USER_ID ?? "e2e-user",
            query_delay_ms: 1500,
            price_max: 80,
        };
        await db.monitors.upsert({
            where: { id: monitor.id },
            create: data,
            update: data,
        });
    }
});

test.afterAll(async () => {
    await db.monitors.deleteMany({ where: { id: { in: fixtureIds } } });
    await db.$disconnect();
});

async function openMonitors(page: Page) {
    // No fixture can contact a real linked account or Vinted.
    await page.route("**/api/account", (route) =>
        route.fulfill({ json: { linked: false } }),
    );
    await page.goto("/dashboard");
    await expect(
        page.getByRole("heading", { name: "Monitors", exact: true }),
    ).toBeVisible();
}

test("searches monitor names, queries and regions without losing empty-state recovery", async ({
    page,
}) => {
    await openMonitors(page);
    const search = page.getByRole("searchbox", { name: "Search monitors" });
    await search.fill("FR wool");
    await expect(page.getByTestId("monitor-card")).toHaveCount(1);
    await expect(page.getByTestId("monitor-card")).toContainText(
        "Vintage outerwear",
    );
    await page
        .getByRole("group", { name: "Filter monitors by status" })
        .getByRole("button", { name: /Active/ })
        .click();
    await expect(
        page.getByRole("heading", { name: "No matching monitors" }),
    ).toBeVisible();
    await expect(
        page.getByText("No monitors yet", { exact: true }),
    ).toHaveCount(0);
    await page
        .getByRole("button", { name: "Clear search and filters" })
        .click();
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("monitor-card")).toHaveCount(4);
    await expect(page.getByTestId("monitor-result-count")).toHaveText(
        "Showing 4 of 4 monitors",
    );
});

test("selects only visible monitors and makes hidden selections explicit", async ({
    page,
}) => {
    await openMonitors(page);
    await page
        .getByRole("searchbox", { name: "Search monitors" })
        .fill("workwear");
    await page
        .getByRole("checkbox", { name: "Select visible monitors" })
        .check();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear monitor search" }).click();
    await page
        .getByRole("group", { name: "Filter monitors by status" })
        .getByRole("button", { name: /Paused/ })
        .click();
    await expect(page.getByTestId("monitor-card")).toHaveCount(2);
    await expect(
        page.getByText("1 selected outside this view", { exact: true }),
    ).toBeVisible();
    await page
        .getByRole("checkbox", { name: "Select visible monitors" })
        .check();
    await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
    await page
        .getByRole("checkbox", { name: "Select visible monitors" })
        .uncheck();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Bulk edit", exact: true }),
    ).toBeDisabled();
});

test("keeps mobile navigation out of the tab order until opened and restores focus", async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMonitors(page);
    const opener = page.getByRole("button", {
        name: "Open navigation",
        exact: true,
    });
    await expect(
        page.getByRole("navigation", { name: "Main navigation" }),
    ).toHaveCount(0);
    await opener.click();
    const navigation = page.getByRole("dialog", {
        name: "Vintrack navigation",
    });
    await expect(navigation).toBeVisible();
    await expect(
        navigation.getByRole("link", { name: "Monitors", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(navigation).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await navigation.getByRole("link", { name: "Guide", exact: true }).click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(navigation).toHaveCount(0);
    await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toContainText("Guide");
});

test("offers a skip link and breadcrumb navigation on monitor detail pages", async ({
    page,
}) => {
    await openMonitors(page);
    await page.keyboard.press("Tab");
    await expect(
        page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#dashboard-content")).toBeFocused();
    await page.goto("/monitors/990701/edit?from=dashboard");
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toContainText("Edit Monitor");
    if ((page.viewportSize()?.width ?? 0) >= 640) {
        await expect(
            crumbs.getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("href", "/monitors/990701");
    }
    await crumbs.getByRole("link", { name: "Monitors", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
});

test("keeps the notification popover within a narrow viewport and restores focus", async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.route("**/api/account", (route) =>
        route.fulfill({ json: { linked: true, domain: "www.vinted.de" } }),
    );
    await page.route("**/api/items/liked", (route) =>
        route.fulfill({ json: { item_ids: [] } }),
    );
    await page.route("**/api/notifications?**", (route) =>
        route.fulfill({
            json: {
                notifications: [
                    {
                        id: "1",
                        body: "A new offer is ready to review.",
                        is_read: false,
                        url: "https://www.vinted.de/inbox",
                    },
                ],
            },
        }),
    );
    await page.goto("/dashboard");
    const bell = page.getByRole("button", {
        name: "Open Vinted notifications",
    });
    await bell.click();
    const popover = page.getByRole("dialog", { name: "Vinted notifications" });
    await expect(popover.getByText("Unread", { exact: true })).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(bell).toBeFocused();
});

for (const theme of ["light", "dark"] as const) {
    test(`keeps monitor controls usable at 320px and 200% text in ${theme}`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 740 });
        await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
            contrast: "more",
        });
        await page.addInitScript(
            (theme) => localStorage.setItem("theme", theme),
            theme,
        );
        await openMonitors(page);
        await page.addStyleTag({ content: "html { font-size: 200%; }" });
        const search = page.getByRole("searchbox", { name: "Search monitors" });
        await search.fill("carhartt");
        await expect(page.getByTestId("monitor-card")).toHaveCount(1);
        const clear = page.getByRole("button", {
            name: "Clear monitor search",
        });
        await clear.scrollIntoViewIfNeeded();
        await expect(clear).toBeInViewport();
        await clear.focus();
        expect(
            await clear.evaluate((node) => getComputedStyle(node).outlineStyle),
        ).toBe("solid");
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
    });
}

test("reports the actual live stream state and its recovery", async ({
    page,
}) => {
    await page.addInitScript(() => {
        Reflect.set(
            window,
            "EventSource",
            class {
                onopen: (() => void) | null = null;
                onerror: (() => void) | null = null;
                constructor() {
                    Reflect.set(window, "__uxStream", this);
                }
                close() {}
            },
        );
    });
    await openMonitors(page);
    await expect(
        page.getByRole("status", { name: "Connecting", exact: true }),
    ).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(
                () => typeof Reflect.get(window, "__uxStream")?.onopen,
            ),
        )
        .toBe("function");
    await page.evaluate(() => Reflect.get(window, "__uxStream").onopen());
    await expect(
        page.getByRole("status", { name: "Live updates", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => Reflect.get(window, "__uxStream").onerror());
    await expect(
        page.getByRole("status", { name: "Reconnecting", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => Reflect.get(window, "__uxStream").onopen());
    await expect(
        page.getByRole("status", { name: "Live updates", exact: true }),
    ).toBeVisible();
});

test("opens the live stream without waiting for a new listing", async ({
    page,
}) => {
    await openMonitors(page);
    await expect(
        page.getByRole("status", { name: "Live updates", exact: true }),
    ).toBeVisible();
});
