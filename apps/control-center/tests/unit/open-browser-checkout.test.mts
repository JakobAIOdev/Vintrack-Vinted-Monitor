import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";

function harness(
    options: { authorize?: boolean; timeout?: boolean; protocol?: number } = {},
) {
    const events: string[] = [];
    const modules: Record<string, unknown> = {
        "@/lib/checkout": checkout,
        "@/lib/vintrack-extension": {
            detectCheckoutExtension: async () => {
                events.push("detect");
                return {
                    state: "ready",
                    protocol: options.protocol ?? 8,
                    automaticPayment: true,
                };
            },
            runBrowserBuyViaExtension: async (
                input: Record<string, unknown>,
            ) => {
                events.push(input.readinessOnly ? "readiness" : "checkout");
                if (input.readinessOnly) return { ok: true, ready: true };
                if (options.timeout) return null;
                return {
                    ok: true,
                    checkoutUrl:
                        "https://www.vinted.de/checkout?purchase_id=synthetic",
                    status: "checkout_review_required",
                };
            },
        },
    };
    const exports: {
        openBrowserCheckout?: (
            target: checkout.CheckoutTarget,
        ) => Promise<unknown>;
    } = {};
    vm.runInNewContext(
        ts.transpileModule(
            readFileSync(
                new URL(
                    "../../src/lib/open-browser-checkout.ts",
                    import.meta.url,
                ),
                "utf8",
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                },
            },
        ).outputText,
        {
            exports,
            require: (name: string) => {
                assert.ok(name in modules);
                return modules[name];
            },
            performance: { now: () => 1 },
            console: { info() {} },
            fetch: async (url: string, init: RequestInit) => {
                if (url === "/api/items/checkout-links") {
                    events.push("history");
                    return Response.json({});
                }
                assert.equal(url, "/api/checkout/17/123");
                assert.equal(
                    (init.headers as Record<string, string>)[
                        "X-Vintrack-Checkout-Mode"
                    ],
                    "browser",
                );
                assert.equal(
                    (init.headers as Record<string, string>)[
                        "X-Vintrack-Checkout-Account"
                    ],
                    "42@www.vinted.de",
                );
                events.push("authorize");
                return Response.json(
                    { browserPaymentAuthorized: options.authorize !== false },
                    { status: options.authorize === false ? 409 : 200 },
                );
            },
        },
    );
    const target: checkout.CheckoutTarget = {
        itemId: 123,
        monitorId: 17,
        sellerId: 456,
        accountId: 42,
        accountName: "synthetic",
        domain: "www.vinted.de",
        itemUrl: "https://www.vinted.de/items/123",
        title: "Synthetic",
        price: null,
        checkoutTransport: "browser",
        riskConsentVersion: 1,
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
    return { events, open: () => exports.openBrowserCheckout!(target) };
}

test("the existing browser path checks readiness and shared payment authorization before checkout", async () => {
    const h = harness();
    await h.open();
    assert.deepEqual(h.events, [
        "detect",
        "readiness",
        "authorize",
        "checkout",
        "history",
    ]);
});

test("a rejected shared claim cannot start browser payment", async () => {
    const h = harness({ authorize: false });
    await assert.rejects(h.open(), /could not be authorized/);
    assert.deepEqual(h.events, ["detect", "readiness", "authorize"]);
});

test("a browser timeout never falls through to the server flow", async () => {
    const h = harness({ timeout: true });
    await assert.rejects(h.open(), /did not respond/);
    assert.deepEqual(h.events, [
        "detect",
        "readiness",
        "authorize",
        "checkout",
    ]);
});

test("old extension protocols cannot submit card payment", async () => {
    const h = harness({ protocol: 5 });
    await assert.rejects(h.open(), /card auto-checkout/);
    assert.deepEqual(h.events, ["detect"]);
});
