import { expect, test } from "@playwright/test";

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
        await expect(preview).toHaveAttribute("src", "/mock-images/vinted-1.svg");

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

        await expect(
            page.getByText("E2E Nike Dunk Low Retro"),
        ).toBeVisible();
        await expect(
            page.getByText("E2E Carhartt Detroit Jacket"),
        ).not.toBeVisible();

        const unbanRes = await request.delete("/api/seller-bans/880002");
        expect(unbanRes.ok()).toBeTruthy();
    });
});
