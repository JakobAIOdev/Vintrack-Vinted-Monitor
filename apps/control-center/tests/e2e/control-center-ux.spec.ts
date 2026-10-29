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
        page.getByRole("heading", { name: /Welcome back/ }),
    ).toBeVisible();
}

test("opens monitor sections from shortcuts and reveals invalid required fields", async ({
    page,
}) => {
    await page.goto("/monitors/new");
    const create = page.getByRole("button", {
        name: "Create Monitor",
        exact: true,
    });
    await expect(create).toBeEnabled();
    const shortcuts = page.getByRole("navigation", {
        name: "Monitor setup sections",
    });
    await shortcuts.getByRole("link", { name: "Filters", exact: true }).click();
    await expect(page.locator("#monitor-filters")).toHaveAttribute("open", "");
    await expect(page.locator("#monitor-filters > summary")).toBeFocused();
    await shortcuts.getByRole("link", { name: "Preview", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Copy preview URL" }),
    ).toBeVisible();
    await page.locator("#monitor-basics > summary").click();
    await expect(page.locator("#monitor-basics")).not.toHaveAttribute(
        "open",
        "",
    );
    await create.click();
    await expect(page.locator("#monitor-basics")).toHaveAttribute("open", "");
    await expect(
        page.getByLabel("Monitor Name", { exact: true }),
    ).toBeFocused();
});

test("recovers proxy settings without losing a new monitor draft", async ({
    page,
}) => {
    await page.route("**/api/proxy-groups", (route) =>
        route.fulfill({ status: 503, json: { error: "Unavailable" } }),
    );
    await page.goto("/monitors/new");
    await page
        .getByLabel("Monitor Name", { exact: true })
        .fill("My saved draft");
    await expect(
        page
            .getByRole("alert")
            .filter({ hasText: "Proxy settings couldn’t be loaded" }),
    ).toBeVisible();
    const create = page.getByRole("button", {
        name: "Create Monitor",
        exact: true,
    });
    await expect(create).toBeDisabled();
    await page.unroute("**/api/proxy-groups");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(create).toBeEnabled();
    await expect(page.getByLabel("Monitor Name", { exact: true })).toHaveValue(
        "My saved draft",
    );
});

test("shows monitor creation progress and preserves a draft after a failed submission", async ({
    page,
}) => {
    let submissions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route("**/monitors/new", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        submissions++;
        await gate;
        await route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "Synthetic service unavailable",
        });
    });
    await page.goto("/monitors/new");
    const name = page.getByLabel("Monitor Name", { exact: true });
    await name.fill("Keep this monitor draft");
    await page.locator('input[name="query_delay_ms"]').fill("2000");
    const create = page.getByRole("button", {
        name: "Create Monitor",
        exact: true,
    });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(
        page.getByRole("button", { name: "Creating…", exact: true }),
    ).toBeDisabled();
    await name.press("Enter");
    release();
    await expect(page.locator("form").getByRole("alert")).toBeVisible();
    await expect(create).toBeEnabled();
    await expect(name).toHaveValue("Keep this monitor draft");
    await expect(page.locator('input[name="query_delay_ms"]')).toHaveValue(
        "2000",
    );
    expect(submissions).toBe(1);
});

test("offers admin navigation links and clears member search with focus restored", async ({
    page,
    isMobile,
}) => {
    await page.goto("/admin/members");
    const search = page.getByRole("searchbox", {
        name: "Search members",
        exact: true,
    });
    await search.fill("member-that-does-not-exist");
    await expect(
        page.getByText("0 matching users", { exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Clear member search", exact: true })
        .click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    if (isMobile) {
        await page
            .getByRole("combobox", { name: "Admin section" })
            .selectOption("operations");
    } else {
        const navigation = page.getByRole("navigation", {
            name: "Admin sections",
        });
        await expect(
            navigation.getByRole("link", { name: "Members", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        const operations = navigation.getByRole("link", {
            name: "Operations",
            exact: true,
        });
        await expect(operations).toHaveAttribute("href", "/admin/operations");
        await operations.focus();
        await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(/\/admin\/operations$/);
    await page
        .getByRole("group", { name: "Admin views" })
        .getByRole("button", { name: "Logs", exact: true })
        .click();
    await expect(
        page
            .getByRole("group", { name: "Admin views" })
            .getByRole("button", { name: "Logs", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/members$/);
});

test("keeps new monitor and admin overview within a narrow viewport with enlarged text", async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 844 });
    for (const path of [
        "/monitors/new",
        "/admin/overview",
        "/admin/operations",
        "/admin/features",
    ]) {
        await page.goto(path);
        await expect(
            page.getByRole("heading", {
                level: 1,
                name: path === "/monitors/new" ? "Create Monitor" : "Admin Panel",
                exact: true,
            }),
        ).toBeVisible();
        // Measure the final layout, not a frame during button size transitions.
        await page.addStyleTag({
            content: "*, *::before, *::after { transition: none !important; }",
        });
        if (path === "/monitors/new") {
            await expect(
                page.getByRole("button", {
                    name: "Create Monitor",
                    exact: true,
                }),
            ).toBeEnabled();
        } else if (path === "/admin/overview") {
            await expect(
                page.getByText("Loading overview...", { exact: true }),
            ).toBeHidden();
        }
        for (const dark of [false, true]) {
            await page.evaluate((dark) => {
                document.documentElement.style.fontSize = "200%";
                document.documentElement.classList.toggle("dark", dark);
            }, dark);
            await expect
                .poll(
                    () =>
                        page.evaluate(
                            () =>
                                document.documentElement.scrollWidth <=
                                innerWidth,
                        ),
                    { message: `No horizontal overflow on ${path}` },
                )
                .toBe(true);
            if (path === "/admin/features") {
                const dependency = page
                    .getByText("Requires Vinted Account", { exact: true })
                    .first();
                const bounds = await dependency.boundingBox();
                expect(bounds).not.toBeNull();
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
            }
        }
    }
});

test("keeps account navigation compact and browser status readable in both themes", async ({
    page,
}) => {
    await page.goto("/account");
    const connections = page.getByRole("navigation", {
        name: "Account connections",
    });
    await expect(connections.getByRole("link")).toHaveCount(2);
    for (const link of await connections.getByRole("link").all()) {
        expect((await link.boundingBox())!.height).toBeLessThanOrEqual(36);
    }
    await page.evaluate(() =>
        window.postMessage(
            {
                type: "VINTRACK_EXTENSION_READY",
                payload: {
                    installed: true,
                    configured: true,
                    version: "0.4.2",
                },
            },
            window.location.origin,
        ),
    );
    await expect(page.getByText("v0.4.2", { exact: true })).toBeVisible();
    const fallback = page
        .locator("summary")
        .filter({ hasText: "Manual token link" });
    await fallback.focus();
    await page.keyboard.press("Enter");
    await expect(
        page.getByLabel("Access Token", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Link Account", exact: true }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 844 });
    for (const dark of [false, true]) {
        await page.evaluate((dark) => {
            document.documentElement.style.fontSize = "200%";
            document.documentElement.classList.toggle("dark", dark);
        }, dark);
        await expect
            .poll(() =>
                page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            )
            .toBe(true);
    }
});

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
        navigation.getByRole("link", { name: "Dashboard", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(navigation).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await navigation.getByRole("link", { name: "Guide", exact: true }).click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(navigation).toHaveCount(0);
    await expect(
        page.getByRole("heading", { name: /Guide/ }).first(),
    ).toBeVisible();
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
    if ((page.viewportSize()?.width ?? 0) < 640) {
        await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "Vintrack navigation" })
            .getByRole("link", { name: "Dashboard", exact: true })
            .click();
        await expect(page).toHaveURL(/\/dashboard$/);
        return;
    }
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

test("restores the compact topbar, original palette and working light mode toggle", async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
        if (!localStorage.getItem("theme"))
            localStorage.setItem("theme", "dark");
    });
    await openMonitors(page);
    const theme = page
        .locator("header")
        .getByRole("button", { name: "Toggle color theme" });
    await expect(theme).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await theme.click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
        await page
            .locator(".dashboard-shell")
            .evaluate((node) =>
                getComputedStyle(node).getPropertyValue("--primary").trim(),
            ),
    ).toBe(
        await page
            .locator("html")
            .evaluate((node) =>
                getComputedStyle(node).getPropertyValue("--primary").trim(),
            ),
    );
    expect((await page.locator("header").boundingBox())?.height).toBe(48);
    expect((await theme.boundingBox())?.height).toBe(32);
    expect(
        (
            await page
                .getByRole("searchbox", { name: "Search monitors" })
                .boundingBox()
        )?.height,
    ).toBe(32);
    const filters = page.getByRole("group", {
        name: "Filter monitors by status",
    });
    for (const button of await filters.getByRole("button").all()) {
        expect((await button.boundingBox())?.height).toBeLessThanOrEqual(32);
    }
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await theme.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
});
