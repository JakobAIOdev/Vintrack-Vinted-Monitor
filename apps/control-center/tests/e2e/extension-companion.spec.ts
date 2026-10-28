import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const companionScript = resolve(
    process.cwd(),
    "../vintrack-browser-sync-extension/companion.js",
);
const companionStyle = resolve(
    process.cwd(),
    "../vintrack-browser-sync-extension/companion.css",
);

test("refreshes the feed only while its tab is active", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 600 });
    await page.setContent(
        '<main id="companion" style="width:420px;height:600px"></main>',
    );
    await page.addStyleTag({ path: companionStyle });
    await page.evaluate(() => {
        Object.defineProperty(navigator, "userAgentData", {
            configurable: true,
            value: { platform: "macOS" },
        });

        let nextTimerId = 1;
        const timers = new Map<number, { delay: number }>();
        const feedRequests: number[] = [];
        Object.assign(window, {
            __vintrackTest: { timers, feedRequests },
            setInterval: (_callback: TimerHandler, delay?: number) => {
                const id = nextTimerId++;
                timers.set(id, { delay: Number(delay) });
                return id;
            },
            clearInterval: (id: number) => timers.delete(id),
            chrome: {
                runtime: {
                    sendMessage: async (message: { type?: string }) => {
                        if (message.type === "VINTRACK_COMPANION_FEED") {
                            feedRequests.push(Date.now());
                            return {
                                ok: true,
                                updatedAt: "2026-08-23T10:00:00.000Z",
                                items: [
                                    {
                                        id: "2",
                                        title: "Fresh live find",
                                        total_price: "24.00 EUR",
                                        monitor_name: "Nike search",
                                        found_at: "2026-08-23T09:59:00.000Z",
                                        url: "https://www.vinted.de/items/2-fresh-live-find",
                                    },
                                ],
                            };
                        }
                        if (message.type === "VINTRACK_COMPANION_STATE") {
                            return {
                                ok: true,
                                configured: true,
                                companionMode: "inline",
                                version: "0.2",
                                theme: "light",
                                overview: {
                                    account: { linked: true },
                                    monitors: { active: 1, total: 1 },
                                    priceWatches: { total: 0 },
                                    recentFeed: [],
                                },
                                context: {
                                    kind: "catalog",
                                    parsed: {
                                        query: "Nike",
                                        region: "de",
                                        priceMin: "20",
                                        priceMax: "80",
                                        catalogIds: ["123"],
                                        brandIds: ["53"],
                                        sizeIds: ["4"],
                                        colorIds: ["1"],
                                        statusIds: ["6"],
                                        videoGamePlatformIds: [],
                                        extraParams: "",
                                    },
                                    matchingMonitor: null,
                                },
                            };
                        }
                        return { ok: true };
                    },
                },
                storage: {
                    onChanged: {
                        addListener: () => undefined,
                        removeListener: () => undefined,
                    },
                },
            },
        });
    });
    await page.addScriptTag({ path: companionScript });
    await page.evaluate(() => {
        const container = document.querySelector("#companion");
        if (!(container instanceof HTMLElement))
            throw new Error("Missing mount");
        window.VintrackCompanion.mount(container, { surface: "popup" });
    });

    const tabs = page.getByRole("tablist", { name: "Companion views" });
    await expect
        .poll(() =>
            page
                .locator('[data-panel="overview"] .vtc-eyebrow')
                .allTextContents(),
        )
        .toEqual(["LINKED ACCOUNT", "ACTIVE VINTED TAB", "QUICK LINKS"]);
    await expect(
        page.getByRole("button", {
            name: "Create monitor for this search",
            exact: true,
        }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
        page.getByRole("button", {
            name: "Create monitor for this search",
            exact: true,
        }),
    ).toHaveCSS("min-height", "44px");

    await tabs.getByRole("tab", { name: "Feed", exact: true }).click();
    await expect(page.getByText("Fresh live find")).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.locator("kbd")).toHaveText("Option + Shift + V");
    await expect
        .poll(() =>
            page.evaluate(() => ({
                requests: window.__vintrackTest.feedRequests.length,
                delays: Array.from(window.__vintrackTest.timers.values()).map(
                    (timer) => timer.delay,
                ),
            })),
        )
        .toEqual({ requests: 1, delays: [12_000] });

    await tabs.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.__vintrackTest.timers.size))
        .toBe(0);
});

declare global {
    interface Window {
        VintrackCompanion: {
            mount: (
                container: HTMLElement,
                options: { surface: "popup" | "drawer"; onClose?: () => void },
            ) => unknown;
        };
        __vintrackTest: {
            timers: Map<number, { delay: number }>;
            feedRequests: number[];
        };
    }
}

test("shows the persisted browser login failure in the linked-account card", async ({
    page,
}) => {
    await page.setContent('<main id="companion"></main>');
    await page.addStyleTag({ path: companionStyle });
    await page.evaluate(() => {
        Object.assign(window, {
            chrome: {
                runtime: {
                    sendMessage: async () => ({
                        ok: true,
                        configured: true,
                        theme: "light",
                        lastSyncStatus: "error",
                        lastSyncNeedsUserAction: true,
                        lastSyncError:
                            "Open Vinted and check your login or security prompt, then sync again.",
                        overview: {
                            account: {
                                available: true,
                                linked: true,
                                vintedName: "Synthetic account",
                                domain: "www.vinted.de",
                            },
                            monitors: { active: 0 },
                            priceWatches: { total: 0 },
                        },
                        context: { kind: "unsupported" },
                    }),
                },
                storage: {
                    onChanged: { addListener() {}, removeListener() {} },
                },
            },
        });
    });
    await page.addScriptTag({ path: companionScript });
    await page.evaluate(() => {
        const container = document.querySelector("#companion");
        if (!(container instanceof HTMLElement))
            throw new Error("Missing mount");
        window.VintrackCompanion.mount(container, { surface: "popup" });
    });
    const account = page.locator(".vtc-account-card");
    await expect(
        account.getByText(
            "Open Vinted and check your login or security prompt, then sync again.",
        ),
    ).toBeVisible();
    await expect(account.locator(".vtc-status")).toHaveText(
        "Browser refresh needed",
    );
    await expect(account.locator(".vtc-status-ok")).toHaveCount(0);
    await expect(
        account.getByRole("button", { name: "Sync linked account now" }),
    ).toBeVisible();
});

interface CompanionFixture {
    state: Record<string, unknown>;
    requests: string[];
    failWatches: boolean;
    delayWatches: boolean;
    failMode: boolean;
    failState: boolean;
    closeCount: number;
    finishWatches?: () => void;
}

declare global {
    interface Window {
        __companionFixture: CompanionFixture;
    }
}

async function mountFixture(
    page: Page,
    options: {
        width?: number;
        theme?: "light" | "dark";
        systemTheme?: "light" | "dark";
        surface?: "popup" | "drawer";
        state?: Record<string, unknown>;
        failWatches?: boolean;
        delayWatches?: boolean;
    } = {},
) {
    await page.setViewportSize({ width: options.width ?? 420, height: 600 });
    await page.emulateMedia({
        colorScheme: options.systemTheme ?? options.theme ?? "light",
    });
    await page.setContent(
        '<style>body{margin:0}</style><main id="companion" style="width:100%;height:100vh"></main>',
    );
    await page.addStyleTag({ path: companionStyle });
    await page.evaluate((options) => {
        window.__companionFixture = {
            state: {
                ok: true,
                configured: true,
                version: "0.4.2",
                theme: options.theme,
                companionMode: "inline",
                overview: {
                    account: {
                        available: true,
                        linked: true,
                        vintedName: "Vintage finder",
                        domain: "www.vinted.de",
                    },
                    monitors: { active: 4, total: 5 },
                    priceWatches: { total: 3 },
                    recentFeed: [],
                },
                context: {
                    kind: "catalog",
                    parsed: {
                        query: "Carhartt Detroit Jacket",
                        region: "de",
                        priceMin: "20",
                        priceMax: "80",
                        brandIds: ["53"],
                        sizeIds: ["4"],
                        colorIds: ["1"],
                        statusIds: ["6"],
                    },
                },
                ...options.state,
            },
            requests: [],
            failWatches: options.failWatches ?? false,
            delayWatches: options.delayWatches ?? false,
            failMode: false,
            failState: false,
            closeCount: 0,
        };
        Object.assign(window, {
            chrome: {
                runtime: {
                    sendMessage: async (message: { type: string }) => {
                        const fixture = window.__companionFixture;
                        fixture.requests.push(message.type);
                        if (message.type === "VINTRACK_COMPANION_STATE") {
                            return fixture.failState
                                ? {
                                      ok: false,
                                      error: "Connection lost. Try refreshing again.",
                                  }
                                : fixture.state;
                        }
                        if (
                            message.type === "VINTRACK_COMPANION_PRICE_WATCHES"
                        ) {
                            if (fixture.delayWatches)
                                await new Promise<void>((resolve) => {
                                    fixture.finishWatches = resolve;
                                });
                            return fixture.failWatches
                                ? {
                                      ok: false,
                                      error: "Connection interrupted. Try again.",
                                  }
                                : { ok: true, items: [] };
                        }
                        if (message.type === "VINTRACK_COMPANION_SET_MODE") {
                            return fixture.failMode
                                ? {
                                      ok: false,
                                      error: "Preference could not save. Try again.",
                                  }
                                : { ok: true };
                        }
                        if (message.type === "VINTRACK_COMPANION_FEED")
                            return {
                                ok: true,
                                items: [
                                    {
                                        id: "2",
                                        title: "Carhartt Detroit Jacket in washed blue",
                                        total_price: "42.00 EUR",
                                        monitor_name: "Workwear finds",
                                        found_at: "2026-10-28T09:59:00Z",
                                        url: "https://www.vinted.de/items/2-jacket",
                                    },
                                ],
                            };
                        return { ok: true };
                    },
                },
                storage: {
                    onChanged: { addListener() {}, removeListener() {} },
                },
            },
        });
    }, options);
    await page.addScriptTag({ path: companionScript });
    await page.evaluate((surface) => {
        const container = document.querySelector("#companion");
        if (!(container instanceof HTMLElement))
            throw new Error("Missing mount");
        window.VintrackCompanion.mount(container, {
            surface,
            onClose: () => {
                window.__companionFixture.closeCount++;
            },
        });
    }, options.surface ?? "popup");
    await expect(page.locator(".vtc-root")).toHaveAttribute(
        "data-loading",
        "false",
    );
}

test("supports keyboard tabs and preserves focus during live feed updates", async ({
    page,
}) => {
    await page.clock.install();
    await mountFixture(page);
    const overview = page.getByRole("tab", { name: "Overview" });
    const feed = page.getByRole("tab", { name: "Feed", exact: true });
    const watches = page.getByRole("tab", { name: "Watches", exact: true });
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(feed).toBeFocused();
    await expect(feed).toHaveAttribute("aria-selected", "true");
    await expect(
        page.getByRole("tabpanel", { name: "Feed", exact: true }),
    ).toBeVisible();
    const item = page.getByRole("link", { name: /Carhartt Detroit Jacket/ });
    await item.focus();
    await page.clock.fastForward(12_000);
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.__companionFixture.requests.filter(
                        (type) => type === "VINTRACK_COMPANION_FEED",
                    ).length,
            ),
        )
        .toBe(2);
    await expect(item).toBeFocused();
    await feed.focus();
    await page.keyboard.press("End");
    await expect(watches).toBeFocused();
    await page.keyboard.press("Home");
    await expect(overview).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(watches).toBeFocused();
    await expect(overview).toHaveAttribute("tabindex", "-1");
});

test("keeps tabs and the close action usable while watches load", async ({
    page,
}) => {
    await mountFixture(page, { surface: "drawer", delayWatches: true });
    await page.getByRole("tab", { name: "Watches", exact: true }).click();
    await expect(
        page.getByRole("tabpanel", { name: "Watches", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(
        page.getByRole("tabpanel", { name: "Overview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.__companionFixture.closeCount))
        .toBe(1);
    await page.evaluate(() => window.__companionFixture.finishWatches?.());
});

test("distinguishes a failed request from empty watches and offers recovery", async ({
    page,
}) => {
    await mountFixture(page, { failWatches: true });
    await page.getByRole("tab", { name: "Watches", exact: true }).click();
    await expect(page.getByText("Price Watches could not load")).toBeVisible();
    await expect(
        page.getByText("No Price Watches", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
        "Connection interrupted",
    );
    await page.evaluate(() => {
        window.__companionFixture.failWatches = false;
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
        page.getByText("No Price Watches", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toBeHidden();
});

test("keeps sync confirmation visible and rolls back a failed preference change", async ({
    page,
}) => {
    await mountFixture(page);
    await page.getByText("Connection actions", { exact: true }).click();
    await page.getByRole("button", { name: "Sync linked account now" }).click();
    await expect(page.getByRole("status")).toHaveText(
        "Browser session synced.",
    );
    await page.evaluate(() => {
        window.__companionFixture.failMode = true;
    });
    const mode = page.getByRole("checkbox", {
        name: "Show actions inside Vinted",
    });
    await mode.click();
    await expect(mode).toBeChecked();
    await expect(page.getByRole("status")).toHaveText(
        "Preference could not save. Try again.",
    );
});

test("preserves the last known state after a failed refresh", async ({
    page,
}) => {
    await mountFixture(page);
    await page.evaluate(() => {
        window.__companionFixture.failState = true;
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Connection lost");
    await expect(
        page.getByText("Vintage finder", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText("Connect Vintrack", { exact: true }),
    ).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
    test(`fits compact widths and 200% text in ${theme} appearance`, async ({
        page,
    }) => {
        await mountFixture(page, { width: 320, theme });
        await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
            contrast: "more",
        });
        await page.addStyleTag({ content: "html { font-size: 200%; }" });
        const content = page.locator(".vtc-content");
        expect(
            await content.evaluate(
                (node) => node.scrollWidth <= node.clientWidth,
            ),
        ).toBe(true);
        const create = page.getByRole("button", {
            name: "Create monitor for this search",
            exact: true,
        });
        await create.scrollIntoViewIfNeeded();
        await expect(create).toBeInViewport();
        await create.focus();
        expect(
            await create.evaluate(
                (node) => getComputedStyle(node).outlineStyle,
            ),
        ).toBe("solid");
        await page.getByText("More destinations", { exact: true }).click();
        await expect(
            page.getByRole("button", { name: "Notifications", exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Feed", exact: true }).click();
        await expect(
            page.getByRole("link", { name: /Carhartt Detroit Jacket/ }),
        ).toBeVisible();
        expect(
            await content.evaluate(
                (node) => node.scrollWidth <= node.clientWidth,
            ),
        ).toBe(true);
    });
}

test("respects an explicit light theme on a dark system and offers a linking next step", async ({
    page,
}) => {
    await mountFixture(page, {
        theme: "light",
        systemTheme: "dark",
        state: { configured: false },
    });
    await expect(
        page.getByRole("button", { name: "Open Vintrack Account" }),
    ).toBeVisible();
    expect(
        await page
            .locator(".vtc-root")
            .evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgb(243, 245, 248)");
});

test("keeps focus inside the real Shadow DOM drawer and restores it on Escape", async ({
    page,
}) => {
    await page.route("https://www.vinted.de/**", async (route) => {
        if (route.request().url().endsWith("companion.css")) {
            await route.fulfill({
                path: companionStyle,
                contentType: "text/css",
            });
        } else if (route.request().url().endsWith("page-bridge.js")) {
            await route.fulfill({
                body: "",
                contentType: "application/javascript",
            });
        } else {
            await route.fulfill({
                body: "<!doctype html><html><body></body></html>",
                contentType: "text/html",
            });
        }
    });
    await page.goto("https://www.vinted.de/catalog");
    await mountFixture(page);
    await page.evaluate(() => {
        const outside = document.createElement("button");
        outside.id = "outside";
        outside.textContent = "Vinted search";
        document.body.prepend(outside);
        const chrome = Reflect.get(window, "chrome");
        chrome.runtime.getURL = (file: string) =>
            `https://www.vinted.de/__extension/${file}`;
        chrome.runtime.onMessage = { addListener() {} };
        const attachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (options) {
            const shadow = attachShadow.call(this, options);
            Reflect.set(window, "__drawerShadow", shadow);
            return shadow;
        };
    });
    await page.addScriptTag({
        path: resolve(
            process.cwd(),
            "../vintrack-browser-sync-extension/content-script.js",
        ),
    });
    await page.locator("#outside").focus();
    await page.keyboard.press("Alt+Shift+KeyV");
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    Reflect.get(window, "__drawerShadow")?.activeElement
                        ?.dataset.action,
            ),
        )
        .toBe("close");
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    Reflect.get(window, "__drawerShadow")?.querySelector(
                        ".vtc-root",
                    )?.dataset.loading,
            ),
        )
        .toBe("false");
    expect(
        await page.evaluate(() =>
            Reflect.get(window, "__drawerShadow")
                .querySelector('[role="dialog"]')
                .getAttribute("aria-modal"),
        ),
    ).toBe("true");
    await page.evaluate(() =>
        Reflect.get(window, "__drawerShadow").querySelector("input").focus(),
    );
    await page.keyboard.press("Tab");
    expect(
        await page.evaluate(
            () =>
                Reflect.get(window, "__drawerShadow").activeElement.dataset
                    .action,
        ),
    ).toBe("refresh");
    await page.keyboard.press("Shift+Tab");
    expect(
        await page.evaluate(
            () => Reflect.get(window, "__drawerShadow").activeElement.type,
        ),
    ).toBe("checkbox");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-vintrack-companion-drawer]")).toHaveCount(
        0,
    );
    await expect(page.locator("#outside")).toBeFocused();
});
