import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    MemberBrandLimitError,
    upsertVerifiedMemberBrand,
} from "../../src/lib/member-brands.server";
import { parsePriceWatchUrl } from "../../src/lib/price-watch";
import { parseVintedSearchUrl } from "../../src/lib/vinted-url";

const db = new PrismaClient();

test.afterAll(async () => {
    await db.$disconnect();
});

test.describe("Vinted search URL import", () => {
    test("parses supported regional catalog filters and ignores noise", () => {
        const result = parseVintedSearchUrl(
            "https://www.vinted.fr/catalog?search_text=nike%20air&price_from=10&price_to=80&catalog[]=257&catalog_ids[]=183&brand_ids[]=53&brand_ids[]=53&color_ids[]=1&status_ids[]=2&size_ids[]=208&material_ids[]=12&utm_source=e2e",
        );

        expect(result).toEqual({
            ok: true,
            value: {
                region: "fr",
                query: "nike air",
                priceMin: "10",
                priceMax: "80",
                catalogIds: ["257", "183"],
                brandIds: ["53"],
                colorIds: ["1"],
                statusIds: ["2"],
                sizeIds: ["208"],
                videoGamePlatformIds: [],
                extraParams: "material_ids%5B%5D=12",
                importedFields: [
                    "region",
                    "search",
                    "price",
                    "categories",
                    "brands",
                    "colors",
                    "conditions",
                    "sizes",
                ],
                preservedParameterNames: ["material_ids[]"],
                ignoredMetadataNames: ["utm_source"],
                ignoredValueCount: 0,
            },
        });
    });

    test("normalizes platform searches and rejects unsafe URLs", () => {
        const platformResult = parseVintedSearchUrl(
            "vinted.de/catalog?catalog[]=257&platform_ids[]=1277&video_game_platform_ids[]=1278",
        );
        expect(platformResult).toMatchObject({
            ok: true,
            value: {
                region: "de",
                catalogIds: ["3002"],
                videoGamePlatformIds: ["1278", "1277"],
            },
        });

        const metadataResult = parseVintedSearchUrl(
            "https://www.vinted.de/catalog?search_text=ps5&search_id=1452073112&order=newest_first&brand_ids[]=272284&brand_ids[]=289223&page=1&time=1787317280",
        );
        expect(metadataResult).toMatchObject({
            ok: true,
            value: {
                query: "ps5",
                brandIds: ["272284", "289223"],
                extraParams: "",
                ignoredMetadataNames: ["search_id", "order", "page", "time"],
                ignoredValueCount: 0,
            },
        });

        expect(
            parseVintedSearchUrl(
                "https://www.vinted.de.evil.example/catalog?brand_ids[]=53",
            ),
        ).toEqual({
            ok: false,
            error: "Use a search URL from a supported Vinted country.",
        });
        expect(
            parseVintedSearchUrl("https://www.vinted.de/items/123-test"),
        ).toEqual({
            ok: false,
            error: "Paste a Vinted catalog search URL, not an item or profile URL.",
        });
        expect(
            parseVintedSearchUrl(
                "https://www.vinted.de/catalog?price_from=100&price_to=10",
            ),
        ).toEqual({
            ok: false,
            error: "The imported minimum price is higher than the maximum price.",
        });
    });
});

test.describe("Price Watch", () => {
    test.setTimeout(60_000);

    test("accepts only canonical regional Vinted item links and has role limits", async () => {
        expect(
            parsePriceWatchUrl(
                "https://www.vinted.fr/items/7090190431-ralph-lauren?referrer=catalog",
            ),
        ).toEqual({
            ok: true,
            value: {
                region: "fr",
                domain: "www.vinted.fr",
                itemId: BigInt("7090190431"),
                canonicalUrl:
                    "https://www.vinted.fr/items/7090190431-ralph-lauren",
            },
        });

        for (const url of [
            "http://www.vinted.de/items/123-test",
            "https://www.vinted.de.evil.example/items/123-test",
            "https://user:pass@www.vinted.de/items/123-test",
            "https://www.vinted.de/catalog?item=123",
        ]) {
            expect(parsePriceWatchUrl(url).ok).toBe(false);
        }

        const roleLimits = await db.monitor_limits.findMany({
            where: { scope: { in: ["role:free", "role:premium"] } },
            select: { scope: true, price_watch_limit: true },
        });
        expect(Object.fromEntries(roleLimits.map((row) => [row.scope, row.price_watch_limit]))).toEqual({
            "role:free": 3,
            "role:premium": 50,
        });
    });

    test("creates, pauses, resumes, edits, and deletes an individual watch", async ({
        page,
    }) => {
        const itemId = BigInt("8999999901");
        await db.price_watch_targets.deleteMany({
            where: { region: "de", item_id: itemId },
        });

        try {
            await page.goto("/price-watches");
            await expect(
                page.getByRole("heading", { name: "Price Watch" }),
            ).toBeVisible();
            await page.getByRole("button", { name: "Add watch" }).click();
            await page
                .getByLabel("Vinted item URL")
                .fill(
                    `https://www.vinted.de/items/${itemId}-e2e-price-watch`,
                );
            await page
                .getByRole("switch", { name: "Notifications" })
                .click();
            await page.getByRole("button", { name: "Start watching" }).click();
            await expect(
                page.getByText("Price Watch created and queued for validation."),
            ).toBeVisible();
            await page.reload();

            await expect(
                page.getByText(`Vinted item ${itemId}`),
            ).toBeVisible();
            await expect(page.getByText("Alerts off")).toBeVisible();

            await page.getByRole("button", { name: "Stop All" }).click();
            await expect(page.getByText("Paused", { exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Start All" }).click();
            await expect(page.getByText(/^(Validating|Retrying)$/)).toBeVisible();

            await page.getByRole("button", { name: "Price Watch actions" }).click();
            await page.getByRole("button", { name: "Pause", exact: true }).click();
            await expect(page.getByText("Paused", { exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Price Watch actions" }).click();
            await page.getByRole("button", { name: "Resume", exact: true }).click();
            await expect(
                page.getByText(/^(Validating|Retrying)$/),
            ).toBeVisible();

            await page.getByRole("button", { name: "Price Watch actions" }).click();
            await page.getByRole("button", { name: "Edit watch" }).click();
            await expect(
                page.getByRole("heading", { name: "Edit Price Watch" }),
            ).toBeVisible();
            await page.getByLabel("Check every").selectOption("300");
            await page.getByRole("button", { name: "Save changes" }).click();
            await expect(
                page.getByRole("heading", { name: "Edit Price Watch" }),
            ).not.toBeVisible();

            await page.getByRole("button", { name: "Price Watch actions" }).click();
            await page.getByRole("button", { name: "Delete", exact: true }).click();
            await page.getByRole("button", { name: "Delete watch" }).click();
            await expect(
                page.getByText(`Vinted item ${itemId}`),
            ).not.toBeVisible();
        } finally {
            await db.price_watch_targets.deleteMany({
                where: { region: "de", item_id: itemId },
            });
        }
    });

    test("offers 30-second polling only through a verified regional proxy group", async ({
        page,
    }) => {
        const itemId = BigInt("8999999902");
        const group = await db.proxy_groups.create({
            data: {
                userId: "e2e-user",
                name: "E2E Fast DE",
                proxies: "http://127.0.0.1:18080",
                proxy_check_status: "completed",
                proxy_check_region: "de",
                proxy_check_total: 1,
                proxy_check_checked: 1,
                proxy_check_working: 1,
                proxy_check_completed_at: new Date(),
            },
        });
        try {
            await page.goto("/price-watches");
            await page.getByRole("button", { name: "Add watch" }).click();
            await page
                .getByLabel("Vinted item URL")
                .fill(`https://www.vinted.de/items/${itemId}-fast-e2e`);

            await expect(page.getByLabel("Check every").locator('option[value="30"]')).toHaveCount(0);
            await page.getByLabel("Connection").selectOption(String(group.id));
            await expect(page.getByLabel("Check every").locator('option[value="30"]')).toHaveCount(1);
            await page.getByLabel("Check every").selectOption("30");
            await page.getByRole("switch", { name: "Notifications" }).click();
            await page.getByRole("button", { name: "Start watching" }).click();

            await expect(page.getByText("30 sec", { exact: true })).toBeVisible();
            await expect(page.getByText("E2E Fast DE", { exact: true })).toBeVisible();
        } finally {
            await db.price_watch_targets.deleteMany({
                where: { region: "de", item_id: itemId },
            });
            await db.proxy_groups.deleteMany({ where: { id: group.id } });
        }
    });
});

test.describe("dashboard monitors", () => {
    test("keeps monitor management on the main dashboard", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(
            page.getByRole("heading", { name: /Welcome back/ }),
        ).toBeVisible();
        await expect(page.getByTestId("monitor-card").first()).toBeVisible();
        await expect(
            page.locator("aside").getByRole("link", {
                name: "Monitors",
                exact: true,
            }),
        ).toHaveCount(0);
    });

    test("personal brand persistence upserts, reactivates, and enforces its active limit", async () => {
        const userId = "e2e-member-brand-persistence";
        await db.user.upsert({
            where: { id: userId },
            create: {
                id: userId,
                email: "e2e-member-brands@vintrack.test",
                name: "E2E Member Brands",
            },
            update: {},
        });

        try {
            const first = await upsertVerifiedMemberBrand(
                db,
                userId,
                {
                    id: "9988101",
                    label: "Initial Label",
                    canonical_url:
                        "https://www.vinted.cz/brand/9988101-initial-label",
                },
                "cz",
            );
            expect(first.active).toBe(true);

            await db.member_brands.update({
                where: {
                    userId_brand_id: {
                        userId,
                        brand_id: BigInt(9988101),
                    },
                },
                data: { active: false },
            });
            const reactivated = await upsertVerifiedMemberBrand(
                db,
                userId,
                {
                    id: "9988101",
                    label: "Canonical Label",
                    canonical_url:
                        "https://www.vinted.cz/brand/9988101-canonical-label",
                },
                "cz",
            );
            expect(reactivated).toMatchObject({
                active: true,
                label: "Canonical Label",
                source_region: "cz",
            });

            await expect(
                upsertVerifiedMemberBrand(
                    db,
                    userId,
                    {
                        id: "9988102",
                        label: "Over Limit",
                        canonical_url:
                            "https://www.vinted.cz/brand/9988102-over-limit",
                    },
                    "cz",
                    1,
                ),
            ).rejects.toThrow(MemberBrandLimitError);
        } finally {
            await db.user.delete({ where: { id: userId } });
        }
    });

    test("personal brand API isolates accounts and keeps soft-deleted labels", async ({
        request,
    }) => {
        const ownBrandId = BigInt(9988001);
        const inactiveBrandId = BigInt(9988002);
        const otherBrandId = BigInt(9988003);
        const ownBrand = {
            label: "E2E Personal Brand",
            canonical_url:
                "https://www.vinted.de/brand/9988001-e2e-personal-brand",
            source_region: "de",
            active: true,
        };

        await db.member_brands.upsert({
            where: {
                userId_brand_id: {
                    userId: "e2e-user",
                    brand_id: ownBrandId,
                },
            },
            create: {
                userId: "e2e-user",
                brand_id: ownBrandId,
                ...ownBrand,
            },
            update: ownBrand,
        });
        await db.member_brands.upsert({
            where: {
                userId_brand_id: {
                    userId: "e2e-user",
                    brand_id: inactiveBrandId,
                },
            },
            create: {
                userId: "e2e-user",
                brand_id: inactiveBrandId,
                ...ownBrand,
                label: "E2E Removed Brand",
                active: false,
            },
            update: { ...ownBrand, label: "E2E Removed Brand", active: false },
        });
        await db.member_brands.upsert({
            where: {
                userId_brand_id: {
                    userId: "e2e-limit-user",
                    brand_id: otherBrandId,
                },
            },
            create: {
                userId: "e2e-limit-user",
                brand_id: otherBrandId,
                ...ownBrand,
                label: "Other Account Brand",
            },
            update: { ...ownBrand, label: "Other Account Brand" },
        });

        try {
            const activeResponse = await request.get(
                "/api/catalog/member-brands",
            );
            expect(activeResponse.ok()).toBe(true);
            const activePayload = (await activeResponse.json()) as {
                brands: Array<{ id: string; active: boolean }>;
            };
            expect(activePayload.brands).toContainEqual(
                expect.objectContaining({ id: ownBrandId.toString() }),
            );
            expect(activePayload.brands).not.toContainEqual(
                expect.objectContaining({ id: inactiveBrandId.toString() }),
            );
            expect(activePayload.brands).not.toContainEqual(
                expect.objectContaining({ id: otherBrandId.toString() }),
            );

            const selectedResponse = await request.get(
                `/api/catalog/member-brands?ids=${inactiveBrandId}`,
            );
            const selectedPayload = (await selectedResponse.json()) as {
                brands: Array<{ id: string; active: boolean }>;
            };
            expect(selectedPayload.brands).toContainEqual(
                expect.objectContaining({
                    id: inactiveBrandId.toString(),
                    active: false,
                }),
            );

            expect(
                (
                    await request.delete(
                        `/api/catalog/member-brands/${otherBrandId}`,
                    )
                ).ok(),
            ).toBe(true);
            await expect(
                db.member_brands.findUniqueOrThrow({
                    where: {
                        userId_brand_id: {
                            userId: "e2e-limit-user",
                            brand_id: otherBrandId,
                        },
                    },
                    select: { active: true },
                }),
            ).resolves.toEqual({ active: true });

            expect(
                (
                    await request.delete(
                        `/api/catalog/member-brands/${ownBrandId}`,
                    )
                ).ok(),
            ).toBe(true);
            await expect(
                db.member_brands.findUniqueOrThrow({
                    where: {
                        userId_brand_id: {
                            userId: "e2e-user",
                            brand_id: ownBrandId,
                        },
                    },
                    select: { active: true },
                }),
            ).resolves.toEqual({ active: false });
        } finally {
            await db.member_brands.deleteMany({
                where: {
                    brand_id: {
                        in: [ownBrandId, inactiveBrandId, otherBrandId],
                    },
                },
            });
        }
    });

    test("adds and removes a verified personal Vinted brand", async ({
        page,
    }) => {
        await page.route("**/api/catalog/brands?**", async (route) => {
            await route.fulfill({ json: { brands: [] } });
        });
        await page.route("**/api/catalog/member-brands**", async (route) => {
            const method = route.request().method();
            if (method === "POST") {
                await route.fulfill({
                    json: {
                        brand: {
                            id: "7654321",
                            label: "Under Native",
                            canonical_url:
                                "https://www.vinted.de/brand/7654321-under-native",
                            source: "personal",
                            active: true,
                        },
                    },
                });
                return;
            }
            if (method === "DELETE") {
                await route.fulfill({ json: { success: true } });
                return;
            }
            await route.fulfill({ json: { brands: [] } });
        });

        await page.goto("/monitors/new");
        await page.getByText("Filters", { exact: true }).click();
        await page.getByLabel("Search brand").fill("Under Native");
        await page.getByTestId("add-verified-brand").click();
        await expect(page.getByText("How to find it:")).toBeVisible();
        await expect(
            page.getByText(/A valid link contains \/brand\//),
        ).toBeVisible();
        await page
            .getByTestId("personal-brand-url")
            .fill("https://www.vinted.de/brand/7654321-under-native");
        await page.getByTestId("verify-personal-brand").click();

        await expect(page.locator('input[name="brand_ids"]')).toHaveValue(
            "7654321",
        );
        await expect(
            page.locator(
                '[data-testid="selected-brand"][data-brand-id="7654321"]',
            ),
        ).toContainText("Under Native");
        await expect(
            page.getByText(
                "Only listings assigned to one of these Vinted brands are included. Listings without a brand are excluded.",
            ),
        ).toBeVisible();

        await page.getByLabel("Search brand").fill("Under Native");
        await page
            .getByRole("button", {
                name: "Remove Under Native from personal brands",
            })
            .click();
        await expect(page.locator('input[name="brand_ids"]')).toHaveValue("");
    });

    test("imports a Vinted search URL into an existing monitor", async ({
        page,
    }) => {
        await page.goto("/monitors/990001/edit");
        await expect(
            page.getByRole("heading", { name: "Edit Monitor" }),
        ).toBeVisible();

        await page
            .getByLabel("Import Vinted search")
            .fill(
                "https://www.vinted.co.uk/catalog?search_text=barbour&price_from=20&price_to=120&catalog[]=123&brand_ids[]=456&color_ids[]=7&status_ids[]=2&size_ids[]=208&material_ids[]=12",
            );
        await page.getByTestId("import-vinted-url").click();

        await expect(page.locator('input[name="region"]')).toHaveValue("uk");
        await expect(page.locator('input[name="query"]')).toHaveValue(
            "barbour",
        );
        await expect(page.locator('input[name="price_min"]')).toHaveValue("20");
        await expect(page.locator('input[name="price_max"]')).toHaveValue(
            "120",
        );
        await expect(page.locator('input[name="catalog_ids"]')).toHaveValue(
            "123",
        );
        await expect(page.locator('input[name="brand_ids"]')).toHaveValue(
            "456",
        );
        await expect(page.locator('input[name="color_ids"]')).toHaveValue("7");
        await expect(page.locator('input[name="status_ids"]')).toHaveValue("2");
        await expect(page.locator('input[name="size_id"]')).toHaveValue("208");
        await expect(
            page.locator('input[name="vinted_extra_params"]'),
        ).toHaveValue("material_ids%5B%5D=12");
    });

    test("renders seeded monitor summary and monitor card", async ({
        page,
    }) => {
        await page.goto("/monitors");

        await expect(page).toHaveTitle(/Vintrack/i);
        await expect(
            page.getByRole("heading", { name: /Welcome back, E2E User/i }),
        ).toBeVisible();
        await expect(
            page.getByTestId("monitor-summary").getByText("1 monitor", {
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            page.getByTestId("monitor-summary").getByText("1 active", {
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            page.getByTestId("monitor-summary").getByText("2 items found", {
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Sponsor Vintrack" }),
        ).toHaveAttribute("href", "https://github.com/sponsors/JakobAIOdev");

        const serverUpgradeBanner = page.getByRole("status").filter({
            hasText:
                "Help keep the free demo fast and accessible with as few limits as possible.",
        });
        await expect(serverUpgradeBanner).toBeVisible();
        await expect(
            serverUpgradeBanner.getByRole("link", {
                name: "Sponsor on GitHub",
            }),
        ).toHaveAttribute("href", "https://github.com/sponsors/JakobAIOdev");
        await serverUpgradeBanner
            .getByRole("button", { name: "Dismiss server upgrade notice" })
            .click();
        await expect(serverUpgradeBanner).toBeHidden();

        const monitorCard = page
            .getByTestId("monitor-card")
            .filter({ hasText: "E2E Mock Feed" })
            .first();

        await expect(monitorCard).toBeVisible();
        await expect(monitorCard.getByText("Running")).toBeVisible();
        await expect(monitorCard.getByText("Server Proxies")).toBeVisible();
        await expect(monitorCard.getByText(/items found/i)).toBeVisible();
        await expect(
            monitorCard.getByText("Seller ≥ 4.5★ · 5+ ratings"),
        ).toBeVisible();
        await expect(
            monitorCard.getByText("Alerts on", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByText("Discord", { exact: true }),
        ).toBeVisible();
        await expect(
            monitorCard.getByRole("link", { name: /View/i }),
        ).toHaveAttribute("href", "/monitors/990001");

        await monitorCard.getByRole("link", { name: /View/i }).click();
        await expect(page.getByText("★ ≥ 4.5 · 5+ ratings")).toBeVisible();
        await page.getByRole("link", { name: "Edit" }).click();

        const editQueryField = page.getByTestId("query-filter-field");
        await expect(editQueryField).toHaveAttribute("data-state", "active");
        await expect(
            editQueryField.getByText("1 search", { exact: true }),
        ).toBeVisible();

        const editAntiKeywordsField = page.getByTestId(
            "anti-keywords-filter-field",
        );
        await expect(editAntiKeywordsField).toHaveAttribute(
            "data-state",
            "inactive",
        );
        await page.getByLabel("Anti Keywords (optional)").fill("fake");
        await page.getByRole("button", { name: "Add anti keyword" }).click();
        await expect(editAntiKeywordsField).toHaveAttribute(
            "data-state",
            "active",
        );
        await expect(
            editAntiKeywordsField.getByText("1 anti keyword", { exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Remove fake" }).click();
        await expect(editAntiKeywordsField).toHaveAttribute(
            "data-state",
            "inactive",
        );

        await page.getByText("Filters", { exact: true }).click();
        const editPriceField = page.getByTestId("price-filter-field");
        await expect(editPriceField).toHaveAttribute("data-state", "active");
        await expect(
            editPriceField.getByText("€12–€22", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("switch", {
                name: "Enable seller quality filter",
            }),
        ).toBeChecked();
        await expect(
            page.locator('input[name="min_seller_rating"]'),
        ).toHaveValue("4.5");
        await expect(
            page.locator('input[name="min_seller_rating_count"]'),
        ).toHaveValue("5");

        await page.getByText("Quiet Hours", { exact: true }).click();
        const editQuietHoursField = page.getByTestId(
            "quiet-hours-filter-field",
        );
        const editQuietHoursSwitch = page.getByRole("switch", {
            name: "Enable daily quiet hours",
        });
        await expect(editQuietHoursField).toHaveAttribute(
            "data-state",
            "inactive",
        );
        await editQuietHoursSwitch.click();
        await expect(editQuietHoursField).toHaveAttribute(
            "data-state",
            "active",
        );
        await editQuietHoursSwitch.click();
        await expect(editQuietHoursField).toHaveAttribute(
            "data-state",
            "inactive",
        );

        await page.getByRole("button", { name: "Save Changes" }).click();
        await expect(page).toHaveURL("/monitors/990001");
        await expect(page.getByText("★ ≥ 4.5 · 5+ ratings")).toBeVisible();
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
        await page.goto("/monitors");
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
        await page.goto("/monitors");

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
        await page.goto("/monitors");

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
