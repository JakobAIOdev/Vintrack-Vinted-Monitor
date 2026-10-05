import { expect, test } from "@playwright/test";

const target = {
    itemId: 123,
    monitorId: 17,
    sellerId: 456,
    accountId: 42,
    accountName: "test_buyer",
    domain: "www.vinted.de",
    itemUrl: "https://www.vinted.de/items/123",
    title: "Vintage Nike jacket",
    price: "25.00 EUR",
};

test("opening a notification link prepares and opens checkout without another click", async ({
    page,
}) => {
    let preparations = 0;
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") {
            preparations++;
            if (
                process.env.E2E_CHECKOUT_SCREENSHOT === "true" &&
                test.info().project.name === "chromium"
            ) {
                await page.screenshot({
                    path: "../../docs/screenshots/checkout-handoff.png",
                    fullPage: true,
                });
            }
            await route.fulfill({
                json: {
                    status: "checkout_prepared",
                    checkoutUrl:
                        "https://www.vinted.de/checkout?purchase_id=synthetic",
                },
            });
        } else {
            await route.fulfill({ json: target });
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
    await expect(page).toHaveURL(
        "https://www.vinted.de/checkout?purchase_id=synthetic",
    );
    expect(preparations).toBe(1);
});

test("a hidden notification tab waits for activation before preparing checkout", async ({
    page,
}) => {
    let preparations = 0;
    await page.addInitScript(() => {
        let visibility = "hidden";
        Object.defineProperty(document, "visibilityState", {
            get: () => visibility,
        });
        document.addEventListener("activate-checkout-test", () => {
            visibility = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({ json: target });
            return;
        }
        preparations++;
        await route.fulfill({
            json: {
                checkoutUrl:
                    "https://www.vinted.de/checkout?purchase_id=synthetic",
            },
        });
    });
    await page.route("https://www.vinted.de/**", (route) =>
        route.fulfill({ body: "Synthetic checkout" }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByText("Waiting for this tab to open…")).toBeVisible();
    expect(preparations).toBe(0);
    await page.evaluate(() =>
        document.dispatchEvent(new Event("activate-checkout-test")),
    );
    await expect(page).toHaveURL(
        "https://www.vinted.de/checkout?purchase_id=synthetic",
    );
    expect(preparations).toBe(1);
});

test("a preparation failure shows recovery without automatically replaying checkout", async ({
    page,
}) => {
    let preparations = 0;
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({ json: target });
            return;
        }
        preparations++;
        await route.fulfill({
            status: 502,
            json: { error: "Continue in Vinted before trying again." },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("alert").filter({ hasText: "Continue in Vinted" }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeEnabled();
    expect(preparations).toBe(1);
    await retry.click();
    await expect(retry).toBeEnabled();
    expect(preparations).toBe(2);
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
        page.getByRole("button", { name: /checkout|try again/i }),
    ).toHaveCount(0);
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
