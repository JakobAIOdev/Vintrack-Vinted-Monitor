import { expect, test } from "@playwright/test";

const autoPreferences = {
    shipping: "home",
    payment: "paypal",
    autoCheckout: { warningVersion: 1, currency: "EUR", maxTotalMinor: 3000 },
};

const target = {
    riskConsentVersion: 1,
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

for (const auto of [false, true]) {
    test(`risk warning blocks ${auto ? "auto-checkout" : "normal checkout"} until explicitly accepted`, async ({
        page,
    }) => {
        let accepted = false;
        let preparations = 0;
        let saves = 0;
        const currentTarget = () => ({
            ...target,
            preferences: auto ? autoPreferences : undefined,
            riskConsentVersion: accepted ? 1 : null,
        });
        await page.route("**/api/checkout/17/123", (route) => {
            if (route.request().method() === "POST") {
                preparations++;
                expect(accepted).toBe(true);
                return route.fulfill({
                    json: {
                        checkoutUrl:
                            "https://www.vinted.de/checkout?purchase_id=synthetic",
                    },
                });
            }
            return route.fulfill(
                accepted
                    ? { json: currentTarget() }
                    : {
                          status: 403,
                          json: {
                              code: "CHECKOUT_CONSENT_REQUIRED",
                              target: currentTarget(),
                          },
                      },
            );
        });
        await page.route("**/api/checkout/consent", async (route) => {
            expect(route.request().postDataJSON()).toEqual({
                version: 1,
                accepted: true,
            });
            saves++;
            accepted = true;
            await route.fulfill({ json: { accepted: true, version: 1 } });
        });
        await page.route("https://www.vinted.de/**", (route) =>
            route.fulfill({
                contentType: "text/html",
                body: "<h1>Synthetic Vinted checkout</h1>",
            }),
        );
        if (
            process.env.E2E_CHECKOUT_RISK_SCREENSHOT === "true" &&
            test.info().project.name === "chromium"
        )
            await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("/checkout/17/123");
        const dialog = page.getByRole("dialog", {
            name: "Before you use checkout",
        });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/permanently banned/)).toBeVisible();
        await expect(dialog.getByText(/Use at your own risk/)).toBeVisible();
        if (auto)
            await expect(
                dialog.getByText(/Your saved auto-checkout mode is enabled/),
            ).toBeVisible();
        const accept = dialog.getByRole("button", {
            name: "Accept risks and continue",
        });
        await expect(accept).toBeDisabled();
        expect(preparations).toBe(0);
        expect(saves).toBe(0);
        if (!auto && process.env.E2E_CHECKOUT_RISK_SCREENSHOT === "true")
            await page.screenshot({
                animations: "disabled",
                path: `../../docs/screenshots/checkout-risk-${test.info().project.name}.png`,
            });
        await dialog.getByRole("checkbox").check();
        await accept.click();
        await expect(page).toHaveURL(
            "https://www.vinted.de/checkout?purchase_id=synthetic",
        );
        expect(saves).toBe(1);
        expect(preparations).toBe(1);
        // Persisted server consent skips the warning on the next link; there is
        // no additional consent-status request on the normal fast path.
        await page.goto("/checkout/17/123");
        await expect(page).toHaveURL(
            "https://www.vinted.de/checkout?purchase_id=synthetic",
        );
        expect(saves).toBe(1);
        expect(preparations).toBe(2);
    });
}

test("cancelling or failing to save consent never prepares a checkout", async ({
    page,
}) => {
    let preparations = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        if (route.request().method() === "POST") preparations++;
        return route.fulfill({
            status: 403,
            json: {
                code: "CHECKOUT_CONSENT_REQUIRED",
                target: { ...target, riskConsentVersion: null },
            },
        });
    });
    await page.route("**/api/checkout/consent", (route) =>
        route.fulfill({
            status: 503,
            json: { error: "Acceptance could not be saved." },
        }),
    );
    await page.goto("/checkout/17/123");
    const dialog = page.getByRole("dialog", {
        name: "Before you use checkout",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog
        .getByRole("button", { name: "Accept risks and continue" })
        .click();
    await expect(dialog.getByRole("alert")).toHaveText(
        "Acceptance could not be saved.",
    );
    expect(preparations).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
        page.getByRole("alert").filter({ hasText: "Checkout cancelled" }),
    ).toBeVisible();
    expect(preparations).toBe(0);
});

test("unaccepted users cannot run an extension preflight or consume a payment claim", async ({
    page,
}) => {
    let extensionRequests = 0;
    let claims = 0;
    await page.exposeFunction("checkoutRequestProbe", () => {
        extensionRequests++;
    });
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            if (event.data?.type === "VINTRACK_EXTENSION_PING")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 5,
                        },
                    },
                    window.location.origin,
                );
            if (event.data?.type === "VINTRACK_EXTENSION_BUY")
                void (
                    window as unknown as {
                        checkoutRequestProbe: () => Promise<void>;
                    }
                ).checkoutRequestProbe();
        });
    });
    await page.route("**/api/checkout/17/123", (route) => {
        if (route.request().method() === "POST") claims++;
        return route.fulfill({
            status: 403,
            json: {
                code: "CHECKOUT_CONSENT_REQUIRED",
                target: {
                    ...target,
                    riskConsentVersion: null,
                    preferences: autoPreferences,
                },
            },
        });
    });
    await page.route("**/api/checkout/consent", (route) =>
        route.fulfill({
            status: 503,
            json: { error: "Acceptance could not be saved." },
        }),
    );
    await page.goto("/checkout/17/123");
    const dialog = page.getByRole("dialog", {
        name: "Before you use checkout",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog
        .getByRole("button", { name: "Accept risks and continue" })
        .click();
    await expect(dialog.getByRole("alert")).toHaveText(
        "Acceptance could not be saved.",
    );
    expect(extensionRequests).toBe(0);
    expect(claims).toBe(0);
});

test("auto-checkout refuses protocol 3 before requesting a payment authorization", async ({
    page,
}) => {
    let posts = 0;
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (
                event.source === window &&
                event.data?.type === "VINTRACK_EXTENSION_PING"
            )
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 3,
                        },
                    },
                    window.location.origin,
                );
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") posts++;
        await route.fulfill({
            json: { ...target, preferences: autoPreferences },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("alert").filter({ hasText: "version 0.2.6" }),
    ).toBeVisible();
    expect(posts).toBe(0);
});

test("PayPal auto-checkout requires shared authorization and cannot replay after a second click", async ({
    page,
}) => {
    let authorizations = 0;
    let starts = 0;
    await page.exposeFunction("autoCheckoutTestStarted", (limit: number) => {
        expect(limit).toBe(3000);
        starts++;
    });
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            if (event.data?.type === "VINTRACK_EXTENSION_PING")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 5,
                        },
                    },
                    window.location.origin,
                );
            if (event.data?.type === "VINTRACK_EXTENSION_BUY") {
                if (event.data.payload.readinessOnly) {
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_BUY_RESULT",
                            payload: {
                                requestId: event.data.payload.requestId,
                                ok: true,
                                ready: true,
                            },
                        },
                        window.location.origin,
                    );
                    return;
                }
                void (
                    window as unknown as {
                        autoCheckoutTestStarted(limit: number): Promise<void>;
                    }
                ).autoCheckoutTestStarted(
                    event.data.payload.preferences.autoCheckout.maxTotalMinor,
                );
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_BUY_RESULT",
                        payload: {
                            requestId: event.data.payload.requestId,
                            ok: true,
                            status: "paypal_redirect_ready",
                            checkoutUrl:
                                "https://www.vinted.de/checkout?purchase_id=synthetic",
                            paymentUrl:
                                "https://www.paypal.com/checkoutnow?token=synthetic",
                            autoCheckoutReason:
                                "Continue in PayPal to complete the payment.",
                        },
                    },
                    window.location.origin,
                );
            }
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                json: { ...target, preferences: autoPreferences },
            });
            return;
        }
        expect(route.request().headers()["x-vintrack-checkout-mode"]).toBe(
            "browser",
        );
        expect(
            route.request().headers()["x-vintrack-checkout-preferences"],
        ).toBe("home:paypal:auto:1:EUR:3000");
        authorizations++;
        await route.fulfill(
            authorizations === 1
                ? { json: { browserPaymentAuthorized: true } }
                : {
                      status: 409,
                      json: {
                          error: "Auto-checkout was already attempted. Check Vinted.",
                      },
                  },
        );
    });
    await page.route("**/api/items/checkout-links", (route) =>
        route.fulfill({ json: { ok: true } }),
    );
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("status").filter({ hasText: "Continue in PayPal" }),
    ).toBeVisible();
    expect(starts).toBe(1);
    await page.getByRole("button", { name: "Reopen checkout" }).click();
    await expect(
        page.getByRole("alert").filter({ hasText: "already attempted" }),
    ).toBeVisible();
    expect(authorizations).toBe(2);
    expect(starts).toBe(1);
});

test("server auto-checkout opens only the verified PayPal redirect", async ({
    page,
}) => {
    let starts = 0;
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                json: { ...target, preferences: autoPreferences },
            });
            return;
        }
        starts++;
        await route.fulfill({
            json: {
                status: "paypal_redirect_ready",
                checkoutUrl:
                    "https://www.vinted.de/checkout?purchase_id=synthetic",
                paymentUrl:
                    "https://www.paypal.com/checkoutnow?token=synthetic",
            },
        });
    });
    await page.route("https://www.paypal.com/**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<h1>Synthetic PayPal confirmation</h1>",
        }),
    );
    await page.goto("/checkout/17/123");
    await expect(page).toHaveURL(
        "https://www.paypal.com/checkoutnow?token=synthetic",
    );
    expect(starts).toBe(1);
});

test("disconnected auto-checkout receivers do not consume server payment authorization", async ({
    page,
}) => {
    let authorizations = 0;
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            if (event.data?.type === "VINTRACK_EXTENSION_PING")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 5,
                        },
                    },
                    window.location.origin,
                );
            if (event.data?.type === "VINTRACK_EXTENSION_BUY") {
                if (!event.data.payload.readinessOnly)
                    throw new Error("checkout must not run");
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_BUY_RESULT",
                        payload: {
                            requestId: event.data.payload.requestId,
                            ok: false,
                            code: "checkout_tab_reload_required",
                            error: "The Vinted tab is disconnected. Reload Vinted once.",
                        },
                    },
                    window.location.origin,
                );
            }
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") authorizations++;
        await route.fulfill({
            json: { ...target, preferences: autoPreferences },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("alert").filter({ hasText: "Reload Vinted once" }),
    ).toBeVisible();
    expect(authorizations).toBe(0);
});

test("slow checkout history does not keep a completed handoff waiting", async ({
    page,
}) => {
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            if (event.data?.type === "VINTRACK_EXTENSION_PING")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 5,
                        },
                    },
                    window.location.origin,
                );
            if (event.data?.type === "VINTRACK_EXTENSION_BUY")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_BUY_RESULT",
                        payload: {
                            requestId: event.data.payload.requestId,
                            ok: true,
                            checkoutUrl:
                                "https://www.vinted.de/checkout?purchase_id=synthetic",
                        },
                    },
                    window.location.origin,
                );
        });
    });
    await page.route("**/api/checkout/17/123", (route) =>
        route.fulfill({ json: target }),
    );
    let releaseHistory!: () => void;
    const historyWait = new Promise<void>((resolve) => {
        releaseHistory = resolve;
    });
    await page.route("**/api/items/checkout-links", async (route) => {
        await historyWait;
        await route.fulfill({ json: { status: "stored" } });
    });
    try {
        await page.goto("/checkout/17/123");
        await expect(page.getByRole("status")).toContainText(
            "Checkout is open",
            { timeout: 5000 },
        );
    } finally {
        releaseHistory();
    }
});

test("opening a notification link prepares and opens checkout without another click", async ({
    page,
}) => {
    let preparations = 0;
    let targetLoads = 0;
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
            targetLoads++;
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
    expect(targetLoads).toBe(1);
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

test("an old extension cannot start a new payment preference or silently fall back", async ({
    page,
}) => {
    let mutations = 0;
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (
                event.source !== window ||
                event.data?.type !== "VINTRACK_EXTENSION_PING"
            )
                return;
            window.postMessage(
                {
                    type: "VINTRACK_EXTENSION_READY",
                    payload: { configured: true, checkoutPrepareVersion: 2 },
                },
                window.location.origin,
            );
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() !== "GET") mutations++;
        await route.fulfill({
            json: {
                ...target,
                preferences: { shipping: "home", payment: "google_pay" },
            },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(
        page.getByRole("alert").filter({ hasText: "Update or reload" }),
    ).toBeVisible();
    expect(mutations).toBe(0);
});

test("protocol 3 forwards the regional payment preference without preparing twice", async ({
    page,
}) => {
    let preparations = 0;
    let provider = "";
    await page.exposeFunction("checkoutTestProvider", (value: string) => {
        provider = value;
    });
    await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            if (event.data?.type === "VINTRACK_EXTENSION_PING")
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_READY",
                        payload: {
                            configured: true,
                            checkoutPrepareVersion: 3,
                        },
                    },
                    window.location.origin,
                );
            if (event.data?.type === "VINTRACK_EXTENSION_BUY") {
                if (event.data.payload.readinessOnly) {
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_BUY_RESULT",
                            payload: {
                                requestId: event.data.payload.requestId,
                                ok: true,
                                ready: true,
                            },
                        },
                        window.location.origin,
                    );
                    return;
                }
                void (
                    window as unknown as {
                        checkoutTestProvider(value: string): Promise<void>;
                    }
                ).checkoutTestProvider(event.data.payload.preferences.payment);
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_BUY_RESULT",
                        payload: {
                            requestId: event.data.payload.requestId,
                            ok: true,
                            status: "checkout_prepared",
                            checkoutUrl:
                                "https://www.vinted.de/checkout?purchase_id=synthetic",
                        },
                    },
                    window.location.origin,
                );
            }
        });
    });
    await page.route("**/api/checkout/17/123", async (route) => {
        if (route.request().method() === "POST") preparations++;
        await route.fulfill({
            json: {
                ...target,
                preferences: { shipping: "home", payment: "google_pay" },
            },
        });
    });
    await page.route("**/api/items/checkout-links", (route) =>
        route.fulfill({ json: { ok: true } }),
    );
    await page.goto("/checkout/17/123");
    await expect(
        page
            .getByRole("status")
            .filter({ hasText: "Checkout is open in your Vinted tab" }),
    ).toBeVisible();
    expect(provider).toBe("google_pay");
    expect(preparations).toBe(0);
});

for (const protocol of [5, 6]) {
    test(`card auto-checkout ${protocol === 6 ? "uses shared authorization and cannot repeat payment" : "blocks older extensions before consuming authorization"}`, async ({
        page,
    }) => {
        const preferences = {
            shipping: "home",
            payment: "card",
            autoCheckout: {
                warningVersion: 2,
                currency: "EUR",
                maxTotalMinor: 3000,
            },
        };
        let authorizations = 0;
        let starts = 0;
        await page.exposeFunction("cardCheckoutStarted", () => {
            starts++;
        });
        await page.addInitScript((version) => {
            window.addEventListener("message", (event) => {
                if (event.source !== window) return;
                if (event.data?.type === "VINTRACK_EXTENSION_PING")
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_READY",
                            payload: {
                                configured: true,
                                checkoutPrepareVersion: version,
                            },
                        },
                        window.location.origin,
                    );
                if (event.data?.type === "VINTRACK_EXTENSION_BUY") {
                    const payload = event.data.payload;
                    if (!payload.readinessOnly) {
                        void (
                            window as unknown as {
                                cardCheckoutStarted(): Promise<void>;
                            }
                        ).cardCheckoutStarted();
                    }
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_BUY_RESULT",
                            payload: payload.readinessOnly
                                ? {
                                      requestId: payload.requestId,
                                      ok: true,
                                      ready: true,
                                  }
                                : {
                                      requestId: payload.requestId,
                                      ok: true,
                                      status: "card_authentication_required",
                                      checkoutUrl:
                                          "https://www.vinted.de/checkout?purchase_id=synthetic&after_payment_redirect=true",
                                      autoCheckoutReason:
                                          "Continue in Vinted to complete card authentication. Do not pay again.",
                                  },
                        },
                        window.location.origin,
                    );
                }
            });
        }, protocol);
        await page.route("**/api/checkout/17/123", (route) => {
            if (route.request().method() === "GET")
                return route.fulfill({ json: { ...target, preferences } });
            expect(
                route.request().headers()["x-vintrack-checkout-preferences"],
            ).toBe("home:card:auto:2:EUR:3000");
            authorizations++;
            return route.fulfill(
                authorizations === 1
                    ? { json: { browserPaymentAuthorized: true } }
                    : {
                          status: 409,
                          json: {
                              error: "Auto-checkout was already attempted. Check Vinted.",
                          },
                      },
            );
        });
        await page.route("**/api/items/checkout-links", (route) =>
            route.fulfill({ json: { ok: true } }),
        );
        await page.goto("/checkout/17/123");
        if (protocol === 5) {
            await expect(
                page
                    .getByRole("alert")
                    .filter({ hasText: "version 0.3.1 or later" }),
            ).toBeVisible();
            expect(starts).toBe(0);
            expect(authorizations).toBe(0);
        } else {
            await expect(
                page
                    .getByRole("status")
                    .filter({ hasText: "card authentication" }),
            ).toBeVisible();
            expect(starts).toBe(1);
            await page.getByRole("button", { name: "Reopen checkout" }).click();
            await expect(
                page
                    .getByRole("alert")
                    .filter({ hasText: "already attempted" }),
            ).toBeVisible();
            expect(starts).toBe(1);
            expect(authorizations).toBe(2);
        }
    });
}

test("an opted-out account never starts checkout through an existing notification link", async ({
    page,
}) => {
    let posts = 0;
    await page.route("**/api/checkout/17/123", (route) => {
        if (route.request().method() === "POST") posts++;
        return route.fulfill({
            status: 403,
            json: {
                code: "FEATURE_UNAVAILABLE",
                reason: "user_disabled",
                error: "Enable the checkout module in Account before using checkout.",
            },
        });
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Enable the checkout module in Account before using checkout.",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
        0,
    );
    expect(posts).toBe(0);
});

test("a hidden handoff checks current access only when opened after opting out", async ({
    page,
}) => {
    let gets = 0;
    let posts = 0;
    let enabled = true;
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
    await page.route("**/api/checkout/17/123", (route) => {
        if (route.request().method() === "POST") posts++;
        else gets++;
        return route.fulfill(
            enabled
                ? { json: target }
                : {
                      status: 403,
                      json: {
                          code: "FEATURE_UNAVAILABLE",
                          reason: "user_disabled",
                          error: "Enable the checkout module in Account before using checkout.",
                      },
                  },
        );
    });
    await page.goto("/checkout/17/123");
    await expect(page.getByText("Waiting for this tab to open…")).toBeVisible();
    expect(gets).toBe(0);
    enabled = false;
    await page.evaluate(() =>
        document.dispatchEvent(new Event("activate-checkout-test")),
    );
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Enable the checkout module in Account before using checkout.",
    );
    expect(gets).toBe(1);
    expect(posts).toBe(0);
});
