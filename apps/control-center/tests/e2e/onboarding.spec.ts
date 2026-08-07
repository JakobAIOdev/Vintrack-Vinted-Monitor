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

        await page.getByText("Filters", { exact: true }).click();
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
    });
});
