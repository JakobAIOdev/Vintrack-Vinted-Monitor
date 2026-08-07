import { expect, test } from "@playwright/test";

test.describe("first monitor onboarding", () => {
    test("dismisses, reopens, creates a preset monitor, and keeps presets in Create", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/dashboard");

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

        await page.goto("/monitors/new");
        await expect(page.getByTestId("monitor-preset-carhartt")).toBeVisible();
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

        const priceField = page.getByTestId("price-filter-field");
        const minPrice = page.locator('input[name="price_min"]');
        const maxPrice = page.locator('input[name="price_max"]');
        await expect(priceField).toHaveAttribute("data-state", "active");
        await expect(
            priceField.getByText("€10–€100", { exact: true }),
        ).toBeVisible();
        await minPrice.fill("");
        await expect(
            priceField.getByText("Up to €100", { exact: true }),
        ).toBeVisible();
        await maxPrice.fill("");
        await expect(priceField).toHaveAttribute("data-state", "inactive");
        await minPrice.fill("25");
        await expect(
            priceField.getByText("From €25", { exact: true }),
        ).toBeVisible();
        await maxPrice.fill("80");
        await expect(
            priceField.getByText("€25–€80", { exact: true }),
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
});
