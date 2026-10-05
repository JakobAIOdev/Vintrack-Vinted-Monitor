import { expect, test } from "@playwright/test";

test("a notification preview only reads the target; an explicit click prepares checkout", async ({
    page,
}) => {
    let preparations = 0;
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") {
            preparations++;
            await route.fulfill({
                json: {
                    status: "checkout_prepared",
                    checkoutUrl:
                        "https://www.vinted.de/checkout?purchase_id=synthetic",
                },
            });
        } else {
            await route.fulfill({
                json: {
                    itemId: 123,
                    monitorId: 17,
                    sellerId: 456,
                    accountId: 42,
                    accountName: "test_buyer",
                    domain: "www.vinted.de",
                    itemUrl: "https://www.vinted.de/items/123",
                    title: "Vintage Nike jacket",
                    price: "25.00 EUR",
                },
            });
        }
    });
    // All external navigation is a synthetic fixture; no Vinted traffic.
    await page.route("https://www.vinted.de/**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<h1>Synthetic Vinted checkout</h1>",
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByText("Vintage Nike jacket")).toBeVisible();
    await expect(page.getByText("Linked account: @test_buyer")).toBeVisible();
    expect(preparations).toBe(0);
    if (
        process.env.E2E_CHECKOUT_SCREENSHOT === "true" &&
        test.info().project.name === "chromium"
    ) {
        await page.screenshot({
            path: "../../docs/screenshots/checkout-handoff.png",
            fullPage: true,
        });
    }
    await page
        .getByRole("button", { name: "Open checkout", exact: true })
        .click();
    await expect(page).toHaveURL(
        "https://www.vinted.de/checkout?purchase_id=synthetic",
    );
    expect(preparations).toBe(1);
});

test("an unlinked or unauthorized member cannot start checkout", async ({
    page,
}) => {
    let preparations = 0;
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") preparations++;
        await route.fulfill({
            status: 401,
            json: { error: "Sign in to Vintrack to open checkout." },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("alert").filter({ hasText: "Sign in" }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Open checkout", exact: true }),
    ).toBeDisabled();
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveAttribute("href", "/login?returnTo=%2Fcheckout%2F17%2F123");
    expect(preparations).toBe(0);
});

test("checkout APIs reject an anonymous caller", async ({ request }) => {
    test.skip(
        process.env.E2E_TEST_MODE === "true",
        "Requires actual unauthenticated auth handling",
    );
    for (const method of ["get", "post"] as const) {
        const response = await request[method]("/api/checkout/17/123");
        expect(response.status()).toBe(401);
    }
});
