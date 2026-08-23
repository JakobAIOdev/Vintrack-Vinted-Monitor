import { expect, test } from "@playwright/test";
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
        globalThis.VintrackCompanion.mount(container, { surface: "popup" });
    });

    const tabs = page.getByRole("navigation", { name: "Companion views" });
    await expect
        .poll(() =>
            page
                .locator('[data-panel="overview"] .vtc-eyebrow')
                .allTextContents(),
        )
        .toEqual(["ACTIVE VINTED TAB", "QUICK LINKS", "LINKED ACCOUNT"]);
    await expect(
        page.getByRole("button", { name: "Dashboard", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
        page
            .locator(".vtc-quick-links")
            .getByRole("button", { name: "Watches", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
        page.getByRole("button", {
            name: "Create monitor for this search",
            exact: true,
        }),
    ).toBeInViewport({ ratio: 1 });

    await tabs.getByRole("button", { name: "Feed", exact: true }).click();
    await expect(page.getByText("Fresh live find")).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.locator("kbd")).toHaveText("Option + Shift + V");
    await expect
        .poll(() =>
            page.evaluate(() => ({
                requests: globalThis.__vintrackTest.feedRequests.length,
                delays: Array.from(
                    globalThis.__vintrackTest.timers.values(),
                ).map((timer) => timer.delay),
            })),
        )
        .toEqual({ requests: 1, delays: [12_000] });

    await tabs.getByRole("button", { name: "Overview", exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => globalThis.__vintrackTest.timers.size))
        .toBe(0);
});

declare global {
    interface Window {
        VintrackCompanion: {
            mount: (
                container: HTMLElement,
                options: { surface: "popup" | "drawer" },
            ) => unknown;
        };
        __vintrackTest: {
            timers: Map<number, { delay: number }>;
            feedRequests: number[];
        };
    }
}
