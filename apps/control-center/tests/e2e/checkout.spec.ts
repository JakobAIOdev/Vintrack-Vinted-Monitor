import { expect, test, type Page } from "@playwright/test";

const target = {
    riskConsentVersion: 1,
    checkoutTransport: "server",
    itemId: 123,
    monitorId: 17,
    sellerId: 456,
    accountId: 42,
    accountName: "test_buyer",
    domain: "www.vinted.de",
    itemUrl: "https://www.vinted.de/items/123",
    title: "Vintage Nike jacket",
    price: "25.00 EUR",
    preferences: {
        shipping: "home",
        payment: "card",
        autoCheckout: {
            warningVersion: 2,
            currency: "EUR",
            maxTotalMinor: 3000,
        },
    },
};
const checkoutUrl = "https://www.vinted.de/checkout?purchase_id=synthetic";
const prepared = {
    target,
    checkoutUrl,
    status: "card_authentication_required",
};

for (const transport of ["server", "agent"]) {
    test(`${transport} request checkout without Full checkout consent cannot fall back or poll a job`, async ({
        page,
    }) => {
        let upstream = 0;
        let jobPolls = 0;
        await page.route("https://www.vinted.de/**", (route) => {
            upstream++;
            return route.abort();
        });
        await page.route("**/api/checkout-agent/jobs/*", (route) => {
            jobPolls++;
            return route.abort();
        });
        await page.route("**/api/checkout/17/123", (route) =>
            route.fulfill({
                json: {
                    ...prepared,
                    target: {
                        ...target,
                        checkoutTransport: transport,
                        preferences: { shipping: "home", payment: "card" },
                    },
                    status: "agent_queued",
                    jobId: "a".repeat(64),
                },
            }),
        );
        await page.goto("/checkout/17/123");
        await expect(page.getByRole("main").getByRole("alert")).toContainText(
            "requires Full checkout",
        );
        expect(upstream).toBe(0);
        expect(jobPolls).toBe(0);
    });
}

test("an incomplete Full checkout stays in Vintrack and explains why no payment started", async ({
    page,
}) => {
    let upstream = 0;
    await page.route("https://www.vinted.de/**", (route) => {
        upstream++;
        return route.abort();
    });
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({
            json: {
                ...prepared,
                status: "checkout_review_required",
                autoCheckoutReason:
                    "Saved delivery could not be verified. No automatic payment was started.",
            },
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("status")).toContainText(
        "No automatic payment was started",
    );
    await expect(
        page.getByRole("link", { name: "Finish this checkout in Vinted" }),
    ).toHaveAttribute("href", checkoutUrl);
    await expect(
        page.getByRole("link", { name: "Pay with PayPal" }),
    ).toHaveCount(0);
    expect(page.url()).toContain("/checkout/17/123");
    expect(upstream).toBe(0);
});

async function mockDestination(page: Page) {
    await page.route("https://www.vinted.de/checkout?**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<main>Synthetic Vinted checkout</main>",
        }),
    );
    await page.route("https://www.paypal.com/checkoutnow?**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<main>Synthetic PayPal approval</main>",
        }),
    );
}
async function hideUntilActivated(page: Page) {
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
}

test("notification checkout needs one POST with no extension, preview GET or popup", async ({
    page,
}) => {
    let posts = 0;
    let extensionMessages = 0;
    await page.exposeFunction(
        "unexpectedExtensionMessage",
        () => extensionMessages++,
    );
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.data?.type?.startsWith("VINTRACK_EXTENSION_"))
                void (
                    window as unknown as {
                        unexpectedExtensionMessage(): Promise<void>;
                    }
                ).unexpectedExtensionMessage();
        });
    });
    await mockDestination(page);
    await page.route("**/api/checkout/17/123", (route) => {
        expect(route.request().method()).toBe("POST");
        posts++;
        return route.fulfill({ json: prepared });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main")).toHaveText(
        "Synthetic Vinted checkout",
    );
    expect(posts).toBe(1);
    expect(extensionMessages).toBe(0);
    expect(page.context().pages()).toHaveLength(1);
});

test("a running checkout says that the page must stay open and a payment may start", async ({
    page,
}) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        await held;
        return route.fulfill({
            json: {
                ...prepared,
                status: "card_payment_pending",
                autoCheckoutReason:
                    "Your card payment is processing. Check Vinted; do not pay again.",
            },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("heading", { name: "Working on your checkout" }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
        "Keep this page open. If automatic payment is enabled, a payment may be started now.",
    );
    await expect(page.getByText("Loading your item")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
    release();
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
});

test("a hidden notification waits for activation before any checkout request", async ({
    page,
}) => {
    let posts = 0;
    await hideUntilActivated(page);
    await mockDestination(page);
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({ json: prepared });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByText("Waiting for this tab to open…")).toBeVisible();
    expect(posts).toBe(0);
    await page.evaluate(() =>
        document.dispatchEvent(new Event("activate-checkout-test")),
    );
    await expect(page.getByRole("main")).toHaveText(
        "Synthetic Vinted checkout",
    );
    expect(posts).toBe(1);
});

for (const status of [409, 429, 502]) {
    test(`upstream ${status} shows recovery without an automatic retry`, async ({
        page,
    }) => {
        let posts = 0;
        await page.route("**/api/checkout/17/123", (route) => {
            posts++;
            return route.fulfill({
                status,
                json: {
                    target,
                    error: "Continue in Vinted before trying again.",
                },
            });
        });
        await page.goto("/checkout/17/123");
        await expect(page.getByRole("main").getByRole("alert")).toHaveText(
            "Continue in Vinted before trying again.",
        );
        expect(posts).toBe(1);
        await page.getByRole("button", { name: "Try again" }).click();
        await expect(
            page.getByRole("button", { name: "Try again" }),
        ).toBeEnabled();
        expect(posts).toBe(2);
    });
}

test("an unauthorized caller sees a return link without an automatic retry", async ({
    page,
}) => {
    let attempts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        attempts++;
        return route.fulfill({
            status: 401,
            json: { error: "Sign in to Vintrack to open checkout." },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Sign in",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
        0,
    );
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveAttribute("href", "/login?returnTo=%2Fcheckout%2F17%2F123");
    await expect(page.getByRole("main")).toContainText(
        "This browser is not signed in to Vintrack. If the link opened inside Discord or Telegram, sign in here once or use the app's option to open the link in your browser.",
    );
    expect(attempts).toBe(1);
});

test("signing in from a test link returns to the test, not to a purchase", async ({
    page,
}) => {
    await page.route("**/api/checkout/17/123", (route) => {
        expect(route.request().headers()["x-vintrack-checkout-mode"]).toBe(
            "validate",
        );
        return route.fulfill({
            status: 401,
            json: { error: "Sign in to Vintrack to open checkout." },
        });
    });
    await page.goto("/checkout/17/123?validate=1");
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveAttribute(
        "href",
        "/login?returnTo=%2Fcheckout%2F17%2F123%3Fvalidate%3D1",
    );
});

test("a malformed test flag never starts a checkout", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({ json: prepared });
    });
    for (const query of [
        "?validate=2",
        "?validate=",
        "?validate=1&validate=1",
    ]) {
        const response = await page.goto(`/checkout/17/123${query}`);
        expect(response?.status()).toBe(404);
        await expect(
            page.getByRole("heading", { name: "Working on your checkout" }),
        ).toHaveCount(0);
    }
    expect(posts).toBe(0);
});

test("an error without a loaded item can still be tried again, without a sign-in link", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({
            status: 404,
            json: { error: "Item not found in your monitors." },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Item not found in your monitors.",
    );
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveCount(0);
    expect(posts).toBe(1);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(posts).toBe(2);
});

test("a dropped connection warns that a purchase may have started and never retries by itself", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.abort("connectionreset");
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "The connection was interrupted while checkout was running. A purchase may already have been started; check Vinted before using this link again.",
    );
    await expect(
        page.getByRole("heading", { name: "Checkout was interrupted" }),
    ).toBeVisible();
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(posts).toBe(1);
});

test("checkout APIs reject an anonymous caller", async ({ request }) => {
    test.skip(
        process.env.E2E_TEST_MODE === "true",
        "Requires actual unauthenticated auth handling",
    );
    for (const method of ["get", "post"] as const)
        expect((await request[method]("/api/checkout/17/123")).status()).toBe(
            401,
        );
});

test("a disabled module blocks existing notification links", async ({
    page,
}) => {
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({
            status: 403,
            json: {
                code: "FEATURE_UNAVAILABLE",
                error: "Enable the checkout module in Account before using checkout.",
            },
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Enable the checkout module",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveCount(0);
});

test("a feature that is switched off for the member is explained in plain words", async ({
    page,
}) => {
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({
            status: 403,
            json: {
                code: "FEATURE_UNAVAILABLE",
                feature: "checkout_links",
                reason: "role_disabled",
            },
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Checkout is not available for your account on this instance.",
    );
    await expect(
        page.getByRole("link", { name: "Sign in to Vintrack" }),
    ).toHaveCount(0);
});

for (const mode of ["paypal", "card"] as const) {
    test(`saved ${mode} auto-checkout uses the service without extension authorization`, async ({
        page,
    }) => {
        let posts = 0;
        await mockDestination(page);
        await page.route("**/api/checkout/17/123", (route) => {
            posts++;
            expect(
                route.request().headers()["x-vintrack-checkout-mode"],
            ).toBeUndefined();
            return route.fulfill({
                json: {
                    ...prepared,
                    target: {
                        ...target,
                        preferences: {
                            ...target.preferences,
                            payment: mode,
                            autoCheckout: {
                                warningVersion: mode === "card" ? 2 : 1,
                                currency: "EUR",
                                maxTotalMinor: 3000,
                            },
                        },
                    },
                    status:
                        mode === "card"
                            ? "card_authentication_required"
                            : "paypal_redirect_ready",
                    ...(mode === "paypal"
                        ? {
                              paymentUrl:
                                  "https://www.paypal.com/checkoutnow?token=synthetic",
                          }
                        : {}),
                },
            });
        });
        await page.goto("/checkout/17/123");
        await expect(page.getByRole("main")).toHaveText(
            mode === "paypal"
                ? "Synthetic PayPal approval"
                : "Synthetic Vinted checkout",
        );
        expect(posts).toBe(1);
    });
}

test("an invalid redirect stays in Vintrack without retrying", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({
            json: { ...prepared, checkoutUrl: "https://evil.test/checkout" },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "valid checkout link",
    );
    expect(posts).toBe(1);
    expect(page.url()).toContain("/checkout/17/123");
});

test("consent must be accepted before a second POST can prepare checkout", async ({
    page,
}) => {
    let posts = 0;
    let accepted = false;
    await mockDestination(page);
    await page.route("**/api/checkout/consent", (route) => {
        expect(route.request().method()).toBe("POST");
        accepted = true;
        return route.fulfill({ json: { accepted: true } });
    });
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        expect(route.request().method()).toBe("POST");
        return route.fulfill(
            accepted
                ? { json: prepared }
                : {
                      status: 403,
                      json: {
                          code: "CHECKOUT_CONSENT_REQUIRED",
                          target: { ...target, riskConsentVersion: null },
                      },
                  },
        );
    });
    await page.goto("/checkout/17/123");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(posts).toBe(1);
    await dialog.getByRole("checkbox").check();
    await dialog
        .getByRole("button", { name: "Accept risks and continue" })
        .click();
    await expect(page.getByRole("main")).toHaveText(
        "Synthetic Vinted checkout",
    );
    expect(posts).toBe(2);
});

for (const status of [
    "card_payment_confirmed",
    "card_payment_pending",
    "card_payment_failed",
    "payment_outcome_unknown",
]) {
    test(`${status} shows its result without a Vinted navigation or repeated payment`, async ({
        page,
    }) => {
        let posts = 0;
        let externalRequests = 0;
        await page.route("https://www.vinted.de/**", (route) => {
            externalRequests++;
            return route.abort();
        });
        await page.route("**/api/checkout/17/123", (route) => {
            posts++;
            return route.fulfill({
                json: {
                    ...prepared,
                    status,
                    autoCheckoutReason:
                        status === "card_payment_confirmed"
                            ? "Vinted confirmed your card payment. Check your order; do not pay again."
                            : "Check the payment outcome in Vinted; do not pay again.",
                },
            });
        });
        await page.goto("/checkout/17/123");
        await expect(
            page.getByRole("heading", { name: "Checkout result" }),
        ).toBeVisible();
        await expect(page.getByRole("main").getByRole("status")).toContainText(
            "do not pay again",
        );
        expect(posts).toBe(1);
        expect(externalRequests).toBe(0);
        expect(page.url()).toContain("/checkout/17/123");
        await expect(
            page.getByRole("link", { name: /PayPal|in Vinted/ }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Check result" }),
        ).toHaveCount(0);
        const refresh = page.getByRole("button", { name: "Refresh status" });
        // A final card result has nothing left to refresh.
        if (
            ["card_payment_confirmed", "card_payment_failed"].includes(status)
        ) {
            await expect(refresh).toHaveCount(0);
            expect(posts).toBe(1);
            return;
        }
        await refresh.click();
        await expect(refresh).toBeEnabled();
        expect(posts).toBe(2);
        expect(externalRequests).toBe(0);
    });
}

const paypalUrl = "https://www.paypal.com/checkoutnow?token=synthetic";
const paypalPrepared = {
    ...prepared,
    target: {
        ...target,
        preferences: {
            shipping: "home",
            payment: "paypal",
            autoCheckout: {
                warningVersion: 1,
                currency: "EUR",
                maxTotalMinor: 3000,
            },
        },
    },
    status: "paypal_redirect_ready",
    paymentUrl: paypalUrl,
};

test("a PayPal result keeps a Pay with PayPal link on the page when the automatic navigation does not happen", async ({
    page,
}) => {
    let posts = 0;
    let paypalRequests = 0;
    // A cancelled navigation leaves the current document in place, like an
    // in-app browser that does not follow the automatic navigation.
    await page.route("https://www.paypal.com/**", (route) => {
        paypalRequests++;
        return route.abort("aborted");
    });
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({ json: paypalPrepared });
    });
    // The automatic navigation can begin before this document's load
    // event, so only wait for the document itself.
    await page.goto("/checkout/17/123", { waitUntil: "commit" });
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
    const link = page.getByRole("link", { name: "Pay with PayPal" });
    await expect(link).toHaveAttribute("href", paypalUrl);
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).not.toHaveAttribute("target", /.*/);
    await expect(page.getByRole("main")).toContainText(
        "Your order is reserved once PayPal confirms the payment.",
    );
    await expect.poll(() => paypalRequests).toBe(1);
    expect(page.url()).toContain("/checkout/17/123");
    expect(posts).toBe(1);
});

test("a reopened PayPal checkout shows the same PayPal link and the service explanation", async ({
    page,
}) => {
    await page.route("https://www.paypal.com/**", (route) =>
        route.abort("aborted"),
    );
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({
            json: {
                ...paypalPrepared,
                autoCheckoutReason:
                    "A PayPal payment was already started for this item. Continue in PayPal to complete it; no second payment request was sent.",
            },
        }),
    );
    // The automatic navigation can begin before this document's load
    // event, so only wait for the document itself.
    await page.goto("/checkout/17/123", { waitUntil: "commit" });
    await expect(page.getByRole("main").getByRole("status")).toContainText(
        "no second payment request was sent",
    );
    await expect(
        page.getByRole("link", { name: "Pay with PayPal" }),
    ).toHaveAttribute("href", paypalUrl);
});

test("an unverified payment destination is never rendered as a link", async ({
    page,
}) => {
    let external = 0;
    await page.route("https://evil.test/**", (route) => {
        external++;
        return route.abort();
    });
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({
            json: {
                ...paypalPrepared,
                paymentUrl: "https://evil.test/checkoutnow?token=synthetic",
            },
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "payment destination could not be verified",
    );
    await expect(
        page.getByRole("link", { name: "Pay with PayPal" }),
    ).toHaveCount(0);
    expect(external).toBe(0);
});

test("card authentication keeps a Continue in Vinted link on the page", async ({
    page,
}) => {
    let posts = 0;
    await page.route("https://www.vinted.de/checkout?**", (route) =>
        route.abort("aborted"),
    );
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({ json: prepared });
    });
    // The automatic navigation can begin before this document's load
    // event, so only wait for the document itself.
    await page.goto("/checkout/17/123", { waitUntil: "commit" });
    await expect(
        page.getByRole("link", { name: "Continue in Vinted" }),
    ).toHaveAttribute("href", checkoutUrl);
    expect(posts).toBe(1);
});

test("a reload does not start checkout again by itself", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({
            json: {
                ...prepared,
                status: "card_payment_pending",
                autoCheckoutReason:
                    "Your card payment is processing. Check Vinted; do not pay again.",
            },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
    expect(posts).toBe(1);
    await page.reload();
    const buy = page.getByRole("button", { name: "Buy now" });
    await expect(buy).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
        "Nothing was started automatically. Use the button to start this checkout.",
    );
    expect(posts).toBe(1);
    // Opening the same link again in this tab is not a fresh open either.
    await page.goto("/checkout/17/123");
    await expect(buy).toBeVisible();
    expect(posts).toBe(1);
    await buy.click();
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
    expect(posts).toBe(2);
});

test("a reloaded test link offers Run test instead of running by itself", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        expect(route.request().headers()["x-vintrack-checkout-mode"]).toBe(
            "validate",
        );
        return route.fulfill({
            json: {
                ...prepared,
                status: "payment_ready",
                stoppedBeforePayment: true,
            },
        });
    });
    await page.goto("/checkout/17/123?validate=1");
    await expect(page.getByRole("status")).toContainText(
        "Test finished before payment",
    );
    await page.reload();
    await expect(
        page.getByRole("button", { name: "Run test", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy now" })).toHaveCount(0);
    expect(posts).toBe(1);
    await page.getByRole("button", { name: "Run test", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
        "Test finished before payment",
    );
    expect(posts).toBe(2);
});

test("server validation is visible and cannot navigate or pay", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        expect(route.request().headers()["x-vintrack-checkout-mode"]).toBe(
            "validate",
        );
        posts++;
        return route.fulfill({
            json: {
                ...prepared,
                status: "payment_ready",
                stoppedBeforePayment: true,
            },
        });
    });
    await page.goto("/checkout/17/123?validate=1");
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
        "Test finished before payment",
    );
    expect(page.url()).toContain("?validate=1");
    expect(posts).toBe(1);
    expect(page.context().pages()).toHaveLength(1);
});

test("the current browser method is still available and a missing extension sends no Vinted requests", async ({
    page,
}) => {
    let posts = 0;
    let upstreamRequests = 0;
    await page.route("https://www.vinted.de/**", (route) => {
        upstreamRequests++;
        return route.abort();
    });
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({
            json: {
                target: {
                    ...target,
                    checkoutTransport: "browser",
                    preferences: { shipping: "home", payment: "wallet" },
                },
                status: "browser_checkout_required",
            },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "connected Vintrack extension",
        { timeout: 15_000 },
    );
    expect(upstreamRequests).toBe(0);
    expect(posts).toBe(1);
});

test("local-agent checkout polls the job and shows a confirmed payment without browser execution", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        posts++;
        return route.fulfill({
            status: 202,
            json: {
                target: { ...target, checkoutTransport: "agent" },
                status: "agent_queued",
                jobId: "a".repeat(64),
            },
        });
    });
    await page.route("**/api/checkout-agent/jobs/*", (route) =>
        route.fulfill({
            json: {
                state: "complete",
                result: {
                    checkout_url: checkoutUrl,
                    status: "card_payment_confirmed",
                },
            },
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("heading", { name: "Checkout result" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
        "confirmed your card payment",
    );
    expect(posts).toBe(1);
    expect(page.context().pages()).toHaveLength(1);
});

test("local-agent validation stays in Vintrack and reports no payment request", async ({
    page,
}) => {
    await page.route("**/api/checkout/17/123", (route) => {
        expect(route.request().headers()["x-vintrack-checkout-mode"]).toBe(
            "validate",
        );
        return route.fulfill({
            status: 202,
            json: {
                target: { ...target, checkoutTransport: "agent" },
                status: "agent_queued",
                jobId: "b".repeat(64),
            },
        });
    });
    await page.route("**/api/checkout-agent/jobs/*", (route) =>
        route.fulfill({
            json: {
                state: "complete",
                stopped_before_payment: true,
                result: { checkout_url: checkoutUrl, status: "payment_ready" },
            },
        }),
    );
    await page.goto("/checkout/17/123?validate=1");
    await expect(page.getByRole("status")).toContainText(
        "Test finished before payment",
    );
    expect(page.url()).toContain("?validate=1");
});
