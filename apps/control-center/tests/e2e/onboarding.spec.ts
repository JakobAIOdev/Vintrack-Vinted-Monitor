import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
    MONITOR_MAINTENANCE_SETTING_KEY,
} from "../../src/lib/monitor-maintenance";

const db = new PrismaClient();

function getOverLimitSizeIds() {
    const snapshot = JSON.parse(
        readFileSync(
            path.resolve(process.cwd(), "data/vinted-sizes/de/groups.json"),
            "utf8",
        ),
    ) as { groups: Array<{ sizes: Array<{ id: number }> }> };

    return snapshot.groups
        .flatMap((group) => group.sizes)
        .slice(0, 101)
        .map((size) => String(size.id))
        .join(",");
}

test.afterAll(async () => db.$disconnect());

test.describe("first monitor onboarding", () => {
    test.describe.configure({ mode: "serial" });

    test("blocks quick start and manual creation during maintenance", async ({
        page,
    }) => {
        const previous = await db.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
        });
        try {
            const now = new Date().toISOString();
            await db.app_settings.upsert({
                where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                create: {
                    key: MONITOR_MAINTENANCE_SETTING_KEY,
                    value: JSON.stringify({
                        enabled: true,
                        revision: `onboarding-maintenance-${Date.now()}`,
                        message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
                        estimatedEndAt: null,
                        enabledAt: now,
                        enabledBy: "e2e-user",
                        updatedAt: now,
                    }),
                },
                update: {
                    value: JSON.stringify({
                        enabled: true,
                        revision: `onboarding-maintenance-${Date.now()}`,
                        message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
                        estimatedEndAt: null,
                        enabledAt: now,
                        enabledBy: "e2e-user",
                        updatedAt: now,
                    }),
                },
            });

            await page.goto("/monitors");
            const quickStart = page.getByTestId("first-monitor-quick-start");
            await expect(quickStart).toBeVisible();
            await quickStart
                .getByTestId("monitor-preset-nike-dunk-low")
                .click();
            await expect(
                quickStart.getByTestId("start-preset-monitor"),
            ).toBeDisabled();
            await expect(
                quickStart.getByTestId("start-preset-monitor"),
            ).toHaveAttribute(
                "title",
                "Monitor creation is paused during maintenance",
            );
            await expect(
                quickStart.getByRole("button", { name: "Set up manually" }),
            ).toBeDisabled();
            expect(
                await db.monitors.count({ where: { userId: "e2e-user" } }),
            ).toBe(0);

            await page.goto("/monitors/new");
            await expect(
                page.getByTestId("monitor-creation-maintenance"),
            ).toBeVisible();
        } finally {
            if (previous) {
                await db.app_settings.upsert({
                    where: { key: previous.key },
                    create: previous,
                    update: { value: previous.value },
                });
            } else {
                await db.app_settings.deleteMany({
                    where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                });
            }
        }
    });

    test("blocks a stale preset dialog after maintenance starts", async ({
        page,
    }) => {
        const previous = await db.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
        });
        try {
            await db.app_settings.deleteMany({
                where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            });
            await page.goto("/monitors");
            const quickStart = page.getByTestId("first-monitor-quick-start");
            await quickStart
                .getByTestId("monitor-preset-nike-dunk-low")
                .click();
            const startPreset = quickStart.getByTestId("start-preset-monitor");
            await expect(startPreset).toBeEnabled();

            const now = new Date().toISOString();
            await db.app_settings.create({
                data: {
                    key: MONITOR_MAINTENANCE_SETTING_KEY,
                    value: JSON.stringify({
                        enabled: true,
                        revision: `stale-preset-${Date.now()}`,
                        message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
                        estimatedEndAt: null,
                        enabledAt: now,
                        enabledBy: "e2e-user",
                        updatedAt: now,
                    }),
                },
            });

            await startPreset.click();
            await expect(
                page.getByText(
                    "Monitor creation is paused while Vintrack is undergoing maintenance.",
                ),
            ).toBeVisible();
            expect(
                await db.monitors.count({ where: { userId: "e2e-user" } }),
            ).toBe(0);
            expect(
                await db.user.findUniqueOrThrow({
                    where: { id: "e2e-user" },
                    select: { monitor_onboarding_status: true },
                }),
            ).toEqual({ monitor_onboarding_status: "pending" });
        } finally {
            if (previous) {
                await db.app_settings.upsert({
                    where: { key: previous.key },
                    create: previous,
                    update: { value: previous.value },
                });
            } else {
                await db.app_settings.deleteMany({
                    where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                });
            }
        }
    });

    test("dismisses, reopens, creates a preset monitor, and keeps presets in Create", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/monitors");

        const quickStart = page.getByTestId("first-monitor-quick-start");
        await expect(quickStart).toBeVisible();
        await expect(
            quickStart.getByRole("heading", {
                name: "Start your first monitor",
            }),
        ).toBeVisible();
        await expect(
            quickStart.getByRole("combobox", { name: "Quick start region" }),
        ).toHaveValue("de");

        const dismissalResponse = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().includes("/dashboard"),
        );
        await quickStart.getByRole("button", { name: "Close" }).click();
        await dismissalResponse;
        await expect(quickStart).toBeHidden();

        await page.reload();
        await expect(quickStart).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Quick start" }),
        ).toBeVisible();

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByRole("button", { name: "Quick start" }).click();
        await quickStart.getByTestId("monitor-preset-nike-dunk-low").click();
        await expect(
            quickStart.getByTestId("start-preset-monitor"),
        ).toContainText("Start Nike Dunk Low");
        await quickStart.getByTestId("start-preset-monitor").click();

        await expect(page).toHaveURL(/\/monitors\/\d+$/);
        await expect(
            page.getByRole("heading", { name: "Nike Dunk Low" }),
        ).toBeVisible();
        await expect(page.getByText("Keywords: Dunk Low")).toBeVisible();
        await expect(page.getByText("Free Proxy Pool")).toBeVisible();
        const demoLease = page.getByTestId("demo-monitor-lease");
        await expect(demoLease).toBeVisible();
        await expect(demoLease.getByText("Demo monitor")).toBeVisible();
        await expect(
            demoLease.getByRole("button", { name: "+30 min" }),
        ).toBeVisible();
        await demoLease.getByRole("button", { name: "Keep running" }).click();
        await expect(demoLease).toBeHidden();
        await page.reload();
        await expect(page.getByTestId("demo-monitor-lease")).toBeHidden();
        await expect(
            page.getByText("Schuhe · 39", { exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "Edit" }).click();
        await expect(page).toHaveURL(/\/monitors\/\d+\/edit$/);
        await page.getByText("Filters", { exact: true }).click();
        const editSizeField = page.getByTestId("size-filter-field");
        await expect(editSizeField.getByText("10/100 selected")).toBeVisible();
        await expect(
            editSizeField
                .getByTestId("selected-size-chips")
                .getByText("Schuhe · 39", { exact: true }),
        ).toBeVisible();

        await page.goto("/monitors/new");
        await expect(page.getByTestId("monitor-preset-carhartt")).toBeVisible();

        const deSizesResponse = await page
            .context()
            .request.get("/api/sizes?region=de");
        expect(deSizesResponse.status()).toBe(200);
        const deSizes = (await deSizesResponse.json()) as {
            maxSelected: number;
            sections: Array<{
                key: string;
                groups: Array<{ id: number; label: string }>;
            }>;
        };
        expect(deSizes.maxSelected).toBe(100);
        expect(deSizes.sections).toHaveLength(6);
        expect(
            deSizes.sections
                .find((section) => section.key === "men")
                ?.groups.find((group) => group.id === 74)?.label,
        ).toBe("Hemden für Herren");

        const fallbackSizesResponse = await page
            .context()
            .request.get("/api/sizes?region=unsupported");
        expect(fallbackSizesResponse.status()).toBe(200);
        const fallbackSizes = (await fallbackSizesResponse.json()) as {
            sections: Array<{
                key: string;
                groups: Array<{ id: number; label: string }>;
            }>;
        };
        expect(
            fallbackSizes.sections
                .find((section) => section.key === "men")
                ?.groups.find((group) => group.id === 74)?.label,
        ).toBe("Men's shirts");

        await expect(page.getByTestId("query-filter-field")).toHaveAttribute(
            "data-state",
            "inactive",
        );
        await expect(
            page.getByTestId("anti-keywords-filter-field"),
        ).toHaveAttribute("data-state", "inactive");
        await page.getByTestId("monitor-preset-levis-501").click();
        await expect(page.getByLabel("Monitor Name")).toHaveValue("Levi's 501");
        await expect(
            page.getByRole("textbox", {
                name: "Search Queries (optional)",
                exact: true,
            }),
        ).toHaveValue("501");
        await expect(page.locator('input[name="anti_keywords"]')).toHaveValue(
            "fake,replica,replika,defekt,beschädigt",
        );
        await expect(page.locator('input[name="catalog_ids"]')).toHaveValue(
            "183,257",
        );
        await expect(page.locator('input[name="brand_ids"]')).toHaveValue("10");
        await expect(page.locator('input[name="color_ids"]')).toHaveValue(
            "9,27,1,3",
        );
        await expect(page.locator('input[name="status_ids"]')).toHaveValue(
            "6,1,2",
        );
        await expect(page.locator('input[name="size_id"]')).toHaveValue(
            "1634,1635,1636,1637,1638,1639,1640,1641,1642",
        );
        await expect(
            page.locator('input[name="allowed_countries"]'),
        ).toHaveValue("de");
        await expect(page.locator('input[name="price_min"]')).toHaveValue("10");
        await expect(page.locator('input[name="price_max"]')).toHaveValue(
            "100",
        );

        const queryField = page.getByTestId("query-filter-field");
        await expect(queryField).toHaveAttribute("data-state", "active");
        await expect(
            queryField.getByText("1 search", { exact: true }),
        ).toBeVisible();

        const titleOnlyField = page.getByTestId("title-only-filter-field");
        const titleOnlySwitch = page.getByRole("switch", {
            name: "Match title only",
        });
        await expect(titleOnlyField).toHaveAttribute("data-state", "inactive");
        await titleOnlySwitch.click();
        await expect(titleOnlyField).toHaveAttribute("data-state", "active");
        await expect(
            titleOnlyField.getByText("Titles only", { exact: true }),
        ).toBeVisible();
        await titleOnlySwitch.click();
        await expect(titleOnlyField).toHaveAttribute("data-state", "inactive");

        const antiKeywordsField = page.getByTestId(
            "anti-keywords-filter-field",
        );
        await expect(antiKeywordsField).toHaveAttribute("data-state", "active");
        await expect(
            antiKeywordsField.getByText("5 anti keywords", { exact: true }),
        ).toBeVisible();

        await page.getByText("Filters", { exact: true }).click();
        await expect(page.getByText("7 active", { exact: true })).toBeVisible();

        const activeFilterExpectations = [
            ["location-filter-field", "1 country"],
            ["category-filter-field", "2 categories"],
            ["brand-filter-field", "1 brand"],
            ["color-filter-field", "4 colors"],
            ["condition-filter-field", "3 conditions"],
            ["size-filter-field", "9 sizes"],
        ] as const;
        for (const [testId, summary] of activeFilterExpectations) {
            const field = page.getByTestId(testId);
            await expect(field).toHaveAttribute("data-state", "active");
            await expect(
                field.getByText(summary, { exact: true }),
            ).toBeVisible();
        }

        const sizeField = page.getByTestId("size-filter-field");
        await expect(sizeField.getByText("9/100 selected")).toBeVisible();
        await expect(
            sizeField.getByRole("button", { name: "Size group" }),
        ).toContainText("Hosen für Herren");
        await sizeField.getByRole("button", { name: "Size group" }).click();
        await sizeField
            .getByRole("button", { name: "Hemden für Herren", exact: true })
            .click();
        await sizeField
            .getByRole("button", {
                name: "Hemden für Herren: 35 | DE 42",
                exact: true,
            })
            .click();
        await expect(page.locator('input[name="size_id"]')).toHaveValue(
            "1634,1635,1636,1637,1638,1639,1640,1641,1642,1527",
        );
        await expect(
            sizeField.getByText("Hemden für Herren · 35 | DE 42", {
                exact: true,
            }),
        ).toBeVisible();

        await page
            .getByTestId("region-picker")
            .getByRole("button", { name: /United Kingdom/ })
            .click();
        await expect(
            sizeField.getByText("Men's shirts · 13.5 in | 35 cm", {
                exact: true,
            }),
        ).toBeVisible();
        await page
            .getByTestId("region-picker")
            .getByRole("button", { name: /Germany/ })
            .click();
        await expect(
            sizeField.getByText("Hemden für Herren · 35 | DE 42", {
                exact: true,
            }),
        ).toBeVisible();
        await sizeField
            .getByRole("button", { name: "Remove 35 | DE 42" })
            .click();
        await expect(page.locator('input[name="size_id"]')).toHaveValue(
            "1634,1635,1636,1637,1638,1639,1640,1641,1642",
        );

        const priceField = page.getByTestId("price-filter-field");
        const minPrice = page.locator('input[name="price_min"]');
        const maxPrice = page.locator('input[name="price_max"]');
        await expect(priceField).toHaveAttribute("data-state", "active");
        await expect(
            priceField.getByText("10–100 EUR", { exact: true }),
        ).toBeVisible();
        await minPrice.fill("");
        await expect(
            priceField.getByText("Up to 100 EUR", { exact: true }),
        ).toBeVisible();
        await maxPrice.fill("");
        await expect(priceField).toHaveAttribute("data-state", "inactive");
        await minPrice.fill("25");
        await expect(
            priceField.getByText("From 25 EUR", { exact: true }),
        ).toBeVisible();
        await maxPrice.fill("80");
        await expect(
            priceField.getByText("25–80 EUR", { exact: true }),
        ).toBeVisible();
        await page
            .getByTestId("region-picker")
            .getByRole("button", { name: /Poland/ })
            .click();
        await expect(minPrice).toHaveValue("25");
        await expect(maxPrice).toHaveValue("80");
        await expect(
            priceField.getByText("25–80 PLN", { exact: true }),
        ).toBeVisible();
        await expect(
            priceField.getByText(/selected Vinted market's currency \(PLN\)/),
        ).toBeVisible();

        await page
            .getByTestId("region-picker")
            .getByRole("button", { name: /Germany/ })
            .click();
        await expect(
            priceField.getByText("25–80 EUR", { exact: true }),
        ).toBeVisible();

        await minPrice.fill("");
        await maxPrice.fill("");
        await expect(priceField).toHaveAttribute("data-state", "inactive");

        const sellerQuality = page.getByTestId("seller-quality-filter");
        await sellerQuality
            .getByRole("switch", { name: "Enable seller quality filter" })
            .click();
        await expect(
            page.locator('input[name="min_seller_rating"]'),
        ).toHaveValue("4.5");
        await expect(
            page.locator('input[name="min_seller_rating_count"]'),
        ).toHaveValue("5");
        await sellerQuality.getByRole("button", { name: "4.9" }).click();
        await sellerQuality.getByRole("button", { name: "10+" }).click();
        await expect(
            page.locator('input[name="min_seller_rating"]'),
        ).toHaveValue("4.9");
        await expect(
            page.locator('input[name="min_seller_rating_count"]'),
        ).toHaveValue("10");

        await page.getByText("Quiet Hours", { exact: true }).click();
        const quietHoursField = page.getByTestId("quiet-hours-filter-field");
        const quietHoursSwitch = page.getByRole("switch", {
            name: "Enable daily quiet hours",
        });
        await expect(quietHoursField).toHaveAttribute("data-state", "inactive");
        await quietHoursSwitch.click();
        await expect(quietHoursField).toHaveAttribute("data-state", "active");
        await expect(
            quietHoursField.getByText("Paused 00:00–07:00", { exact: true }),
        ).toBeVisible();
        await quietHoursSwitch.click();
        await expect(quietHoursField).toHaveAttribute("data-state", "inactive");
    });

    test("imports all supported Vinted search filters into a new monitor", async ({
        page,
    }) => {
        await page.goto("/monitors/new");
        await expect(page.getByLabel("Import Vinted search")).toBeVisible();

        await page
            .getByLabel("Import Vinted search")
            .fill(
                "https://www.vinted.fr/catalog?search_text=playstation&price_from=12&price_to=85&catalog[]=257&brand_ids[]=53&color_ids[]=1&status_ids[]=2&size_ids[]=208&video_game_platform_ids[]=1277&material_ids[]=12&utm_source=e2e",
            );
        await page.getByTestId("import-vinted-url").click();

        await expect(page.locator('input[name="region"]')).toHaveValue("fr");
        await expect(page.locator('input[name="query"]')).toHaveValue(
            "playstation",
        );
        await expect(page.locator('input[name="price_min"]')).toHaveValue("12");
        await expect(page.locator('input[name="price_max"]')).toHaveValue("85");
        await expect(page.locator('input[name="catalog_ids"]')).toHaveValue(
            "3002",
        );
        await expect(page.locator('input[name="brand_ids"]')).toHaveValue("53");
        await expect(page.locator('input[name="color_ids"]')).toHaveValue("1");
        await expect(page.locator('input[name="status_ids"]')).toHaveValue("2");
        await expect(page.locator('input[name="size_id"]')).toHaveValue("208");
        await expect(
            page.locator('input[name="video_game_platform_ids"]'),
        ).toHaveValue("1277");
        await expect(
            page.locator('input[name="vinted_extra_params"]'),
        ).toHaveValue("material_ids%5B%5D=12");
        await expect(page.getByTestId("vinted-extra-params")).toContainText(
            "material_ids[]=12",
        );
        await expect(
            page.getByTestId("vinted-url-import-summary"),
        ).toContainText("1 additional filter preserved");
        await expect(
            page.getByTestId("vinted-url-import-summary"),
        ).toContainText("1 URL metadata field skipped");

        await page.getByLabel("Monitor Name").fill("Imported extra filters");
        const createButton = page.getByRole("button", {
            name: "Create Monitor",
        });
        await expect(createButton).toBeEnabled();
        await createButton.click();
        await expect(page).toHaveURL(/\/monitors\/\d+$/);

        const monitorId = Number(page.url().match(/\/monitors\/(\d+)$/)?.[1]);
        expect(Number.isInteger(monitorId)).toBe(true);
        await expect(
            db.monitors.findUniqueOrThrow({
                where: { id: monitorId },
                select: { vinted_extra_params: true },
            }),
        ).resolves.toEqual({
            vinted_extra_params: "material_ids%5B%5D=12",
        });
        await db.monitors.delete({ where: { id: monitorId } });
    });

    test("rejects more than 100 size filters before monitor creation", async ({
        page,
    }) => {
        await page.goto("/monitors/new");
        await expect(page.getByLabel("Monitor Name")).toBeVisible();
        await page.getByLabel("Monitor Name").fill("Too many sizes");

        await page.locator('input[name="size_id"]').evaluate((input, value) => {
            const element = input as HTMLInputElement;
            element.value = value;
            element.setAttribute("value", value);
        }, getOverLimitSizeIds());
        await page.getByLabel("Monitor Name").evaluate((input) => {
            (input as HTMLInputElement).form?.requestSubmit();
        });

        await expect(
            page.getByText("Choose no more than 100 sizes per monitor."),
        ).toBeVisible();
        await expect(page).toHaveURL(/\/monitors\/new$/);
    });
});
