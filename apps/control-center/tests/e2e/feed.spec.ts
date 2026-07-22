import { expect, test, type Page } from "@playwright/test";

async function installBrowserAlertMocks(page: Page) {
    await page.addInitScript(() => {
        type AlertTestWindow = typeof window & {
            __vintrackOscillatorStarts: number;
            __emitVintrackItem: (item: Record<string, unknown>) => void;
        };

        const testWindow = window as AlertTestWindow;
        testWindow.__vintrackOscillatorStarts = 0;

        const audioParam = {
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
        };

        class MockAudioContext {
            state = "running";
            currentTime = 0;
            destination = {};

            createGain() {
                return {
                    gain: audioParam,
                    connect: () => undefined,
                    disconnect: () => undefined,
                };
            }

            createOscillator() {
                return {
                    type: "sine",
                    frequency: audioParam,
                    connect: () => undefined,
                    start: () => {
                        testWindow.__vintrackOscillatorStarts += 1;
                    },
                    stop: () => undefined,
                };
            }

            resume() {
                this.state = "running";
                return Promise.resolve();
            }

            close() {
                this.state = "closed";
                return Promise.resolve();
            }
        }

        Object.defineProperty(window, "AudioContext", {
            configurable: true,
            value: MockAudioContext,
        });

        const eventSources: MockEventSource[] = [];

        class MockEventSource {
            onmessage: ((event: MessageEvent<string>) => void) | null = null;
            closed = false;

            constructor(public readonly url: string) {
                eventSources.push(this);
            }

            close() {
                this.closed = true;
            }
        }

        Object.defineProperty(window, "EventSource", {
            configurable: true,
            value: MockEventSource,
        });

        testWindow.__emitVintrackItem = (item) => {
            const event = {
                data: JSON.stringify(item),
            } as MessageEvent<string>;
            for (const source of eventSources) {
                if (!source.closed) source.onmessage?.(event);
            }
        };
    });
}

test.describe("dashboard feed", () => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true",
        "dashboard feed e2e requires E2E_TEST_MODE and seeded database",
    );

    test("renders seeded mock Vinted items with listing metadata", async ({
        page,
    }) => {
        await page.goto("/feed");

        await expect(page).toHaveTitle(/Vintrack/i);
        await expect(
            page.getByRole("heading", { name: "Live Feed" }),
        ).toBeVisible();
        await expect(page.getByText("Live · 1 monitor")).toBeVisible();

        const nikeCard = page
            .getByTestId("item-card")
            .filter({ hasText: "E2E Nike Dunk Low Retro" })
            .first();

        await expect(nikeCard).toBeVisible();
        await expect(nikeCard.getByText("Nike", { exact: true })).toBeVisible();
        await expect(nikeCard.getByText("42", { exact: true })).toBeVisible();
        await expect(nikeCard.getByText("🇩🇪 DE")).toBeVisible();
        await expect(nikeCard.getByText("⭐ 4.9 (58)")).toBeVisible();
        await expect(nikeCard.getByText("@e2e_seller_one")).toBeVisible();
        await expect(
            nikeCard.locator(
                'a[href="https://www.vinted.de/member/880001-e2e_seller_one"]',
            ),
        ).toBeVisible();
        await expect(nikeCard.getByText("19.00 EUR")).toBeVisible();
        await expect(nikeCard.getByText("24.49 EUR total")).toBeVisible();
        await expect(nikeCard.getByText("E2E Mock Feed")).toBeVisible();

        await expect(
            nikeCard.locator('img[src="/mock-images/vinted-1.svg"]').first(),
        ).toBeVisible();
    });

    test("requests the selected item limit", async ({ page }) => {
        await page.goto("/feed");

        const feedResponse = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
                url.pathname === "/api/feed" &&
                url.searchParams.get("limit") === "200"
            );
        });

        await page
            .getByRole("combobox", { name: "Live feed item limit" })
            .selectOption("200");

        expect((await feedResponse).ok()).toBe(true);
    });

    test("opens and closes the item image preview", async ({ page }) => {
        await page.goto("/feed");

        const nikeCard = page
            .getByTestId("item-card")
            .filter({ hasText: "E2E Nike Dunk Low Retro" })
            .first();

        await nikeCard.locator('img[src="/mock-images/vinted-1.svg"]').click();

        const preview = page.locator('img[alt="Preview"]');
        await expect(preview).toBeVisible();
        await expect(preview).toHaveAttribute(
            "src",
            "/mock-images/vinted-1.svg",
        );

        await page.keyboard.press("Escape");
        await expect(preview).toBeHidden();
    });

    test("hides items from banned sellers", async ({ page, request }) => {
        const banRes = await request.post("/api/seller-bans", {
            data: {
                seller_id: "880002",
                seller_login: "e2e_seller_two",
                seller_profile_url:
                    "https://www.vinted.de/member/880002-e2e_seller_two",
            },
        });
        expect(banRes.ok()).toBeTruthy();

        await page.goto("/feed");

        await expect(page.getByText("E2E Nike Dunk Low Retro")).toBeVisible();
        await expect(
            page.getByText("E2E Carhartt Detroit Jacket"),
        ).not.toBeVisible();

        const unbanRes = await request.delete("/api/seller-bans/880002");
        expect(unbanRes.ok()).toBeTruthy();
    });

    test("plays and persists one browser sound for an item burst", async ({
        page,
    }) => {
        await installBrowserAlertMocks(page);
        await page.goto("/feed");

        await expect(page.getByText("E2E Nike Dunk Low Retro")).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (
                        window as typeof window & {
                            __vintrackOscillatorStarts: number;
                        }
                    ).__vintrackOscillatorStarts,
            ),
        ).toBe(0);

        await page
            .getByRole("button", { name: "Enable item alert sound" })
            .click();
        await expect(
            page.getByRole("button", { name: "Disable item alert sound" }),
        ).toHaveAttribute("aria-pressed", "true");

        const previewStarts = await page.evaluate(
            () =>
                (
                    window as typeof window & {
                        __vintrackOscillatorStarts: number;
                    }
                ).__vintrackOscillatorStarts,
        );
        expect(previewStarts).toBe(4);
        expect(
            await page.evaluate(() =>
                localStorage.getItem("vintrack.browserAlerts.enabled"),
            ),
        ).toBe("true");

        await page.evaluate(() => {
            const emit = (
                window as typeof window & {
                    __emitVintrackItem: (item: Record<string, unknown>) => void;
                }
            ).__emitVintrackItem;
            const baseItem = {
                monitor_id: 910001,
                brand: "Test Brand",
                price: "20.00 EUR",
                total_price: "23.70 EUR",
                size: "M",
                condition: "Very good",
                url: "https://www.vinted.de/items/9999001",
                image_url: "/mock-images/vinted-1.svg",
                extra_images: null,
                found_at: new Date().toISOString(),
                monitor_name: "E2E Mock Feed",
                location: "DE",
                rating: "5.0",
                seller_id: "990001",
                seller_login: "sound_test",
                seller_profile_url: null,
            };

            emit({
                ...baseItem,
                id: "9999001",
                title: "Sound Test Item One",
            });
            emit({
                ...baseItem,
                id: "9999002",
                title: "Sound Test Item Two",
                url: "https://www.vinted.de/items/9999002",
            });
        });

        await expect(page.getByText("Sound Test Item One")).toBeVisible();
        await expect(page.getByText("Sound Test Item Two")).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        (
                            window as typeof window & {
                                __vintrackOscillatorStarts: number;
                            }
                        ).__vintrackOscillatorStarts,
                ),
            )
            .toBe(previewStarts + 4);

        await page.reload();
        await expect(
            page.getByRole("button", { name: "Disable item alert sound" }),
        ).toHaveAttribute("aria-pressed", "true");

        await page
            .getByRole("button", { name: "Disable item alert sound" })
            .click();
        expect(
            await page.evaluate(() =>
                localStorage.getItem("vintrack.browserAlerts.enabled"),
            ),
        ).toBe("false");
    });
});
