import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";

function harness(
    options: {
        anonymous?: boolean;
        denied?: boolean;
        missingItem?: boolean;
        unlinked?: boolean;
        upstreamUrl?: string;
        preferences?: unknown;
        accountDomain?: string;
        upstreamPaymentUrl?: string;
        upstreamStatus?: string;
        browserAuthorized?: boolean;
    } = {},
) {
    const databaseCalls: unknown[] = [];
    const serviceCalls: { url: string; init: RequestInit }[] = [];
    const db = {
        user: {
            async findUnique() {
                return { checkout_preferences: options.preferences };
            },
        },
        items: {
            async findFirst(query: {
                where: {
                    id: bigint;
                    monitor_id: number;
                    monitors: { userId: string };
                };
            }) {
                databaseCalls.push(query);
                // Model a second member's item: the repository must scope both
                // item and monitor to the authenticated member to see any row.
                assert.equal(query.where.monitors.userId, "synthetic-member");
                assert.equal(query.where.monitor_id, 17);
                assert.equal(query.where.id, 123n);
                return options.missingItem
                    ? null
                    : {
                          seller_id: 456n,
                          title: "Synthetic item",
                          price: "25 EUR",
                      };
            },
        },
        vinted_sessions: {
            async findUnique(query: {
                where: { userId: string };
                select: Record<string, boolean>;
            }) {
                assert.equal(query.where.userId, "synthetic-member");
                assert.deepEqual(Object.keys(query.select).sort(), [
                    "domain",
                    "vinted_name",
                    "vinted_user_id",
                ]);
                return options.unlinked
                    ? null
                    : {
                          vinted_user_id: 42n,
                          vinted_name: "synthetic-buyer",
                          domain: options.accountDomain || "www.vinted.de",
                      };
            },
        },
    };
    const modules: Record<string, unknown> = {
        "server-only": {},
        "@/lib/db": { db },
        "@/lib/checkout": checkout,
        "@/auth": {
            auth: async () =>
                options.anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/features.server": {
            guardApiFeature: async () =>
                options.denied
                    ? Response.json(
                          { code: "FEATURE_UNAVAILABLE" },
                          { status: 403 },
                      )
                    : null,
        },
        "next/server": { NextResponse: { json: Response.json } },
    };
    function load(path: string) {
        const output = ts.transpileModule(
            readFileSync(new URL(path, import.meta.url), "utf8"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                },
            },
        ).outputText;
        const exports: Record<
            string,
            (...args: unknown[]) => Promise<Response>
        > = {};
        vm.runInNewContext(output, {
            exports,
            require: (name: string) => {
                assert.ok(name in modules, `Unexpected import ${name}`);
                return modules[name];
            },
            URL,
            AbortSignal,
            process: { env: { AUTH_URL: "https://vintrack.example.test" } },
            fetch: async (url: string, init: RequestInit) => {
                serviceCalls.push({ url, init });
                return Response.json({
                    checkout_url:
                        options.upstreamUrl ||
                        "https://www.vinted.de/checkout?purchase_id=synthetic",
                    status: options.upstreamStatus || "checkout_prepared",
                    payment_url: options.upstreamPaymentUrl,
                    browser_payment_authorized: options.browserAuthorized,
                });
            },
        });
        return exports;
    }
    modules["@/lib/checkout-preferences.server"] = load(
        "../../src/lib/checkout-preferences.server.ts",
    );
    modules["@/lib/checkout.server"] = load("../../src/lib/checkout.server.ts");
    const route = load(
        "../../src/app/api/checkout/[monitorId]/[itemId]/route.ts",
    );
    return {
        databaseCalls,
        serviceCalls,
        async call(method = "GET", headers: HeadersInit = {}, itemId = "123") {
            const request = Object.assign(
                new Request(
                    "https://vintrack.example.test/api/checkout/17/123",
                    { method, headers },
                ),
                {
                    nextUrl: new URL(
                        "http://internal-next:3000/api/checkout/17/123",
                    ),
                },
            );
            return route[method](request, {
                params: Promise.resolve({ monitorId: "17", itemId }),
            });
        },
    };
}

test("anonymous callers, feature denial, foreign items and unlinked accounts never prepare checkout", async () => {
    for (const [options, status] of [
        [{ anonymous: true }, 401],
        [{ denied: true }, 403],
        [{ missingItem: true }, 404],
        [{ unlinked: true }, 409],
    ] as const) {
        for (const method of ["GET", "POST"]) {
            const h = harness(options);
            assert.equal((await h.call(method)).status, status);
            assert.equal(h.serviceCalls.length, 0);
        }
    }
});

test("GET reads only authorized metadata and never calls the Vinted service", async () => {
    const h = harness();
    const response = await h.call();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const data = await response.json();
    assert.equal(data.accountId, 42);
    assert.equal(data.itemUrl, "https://www.vinted.de/items/123");
    assert.equal(h.serviceCalls.length, 0);
});

test("POST uses the authenticated identity and stored seller, including behind an HTTPS proxy", async () => {
    const h = harness();
    const response = await h.call("POST", {
        Origin: "https://vintrack.example.test",
        "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(response.status, 200);
    assert.equal(h.serviceCalls.length, 1);
    const call = h.serviceCalls[0];
    assert.ok(call.url.endsWith("/api/items/checkout/prepare"));
    assert.equal(
        (call.init.headers as Record<string, string>)["X-User-ID"],
        "synthetic-member",
    );
    assert.deepEqual(JSON.parse(call.init.body as string), {
        item_id: 123,
        seller_id: 456,
        account_id: 42,
        domain: "www.vinted.de",
        preferences: { shipping: "home", payment: "wallet" },
    });
});

test("preferences are loaded only for the linked account and region", async () => {
    for (const [accountId, domain, payment] of [
        [42, "www.vinted.de", "paypal"],
        [99, "www.vinted.de", "wallet"],
        [42, "www.vinted.fr", "wallet"],
    ] as const) {
        const h = harness({
            preferences: {
                accountId,
                domain,
                preferences: { shipping: "home", payment: "paypal" },
            },
        });
        const data = await (await h.call()).json();
        assert.equal(data.preferences.payment, payment);
    }
});

test("malformed stored preferences cannot supply arbitrary checkout components", async () => {
    for (const preferences of [
        { shipping: ["home"], payment: "paypal" },
        { shipping: "home", payment: "paypal", paymentToken: "synthetic" },
        { shipping: "pickup", payment: "paypal" },
    ]) {
        const h = harness({
            preferences: {
                accountId: 42,
                domain: "www.vinted.de",
                preferences,
            },
        });
        const data = await (await h.call()).json();
        assert.deepEqual(data.preferences, {
            shipping: "home",
            payment: "wallet",
        });
    }
});

test("a retired regional payment preference resets without changing delivery", async () => {
    const h = harness({
        accountDomain: "www.vinted.fr",
        preferences: {
            accountId: 42,
            domain: "www.vinted.fr",
            preferences: { shipping: "vinted", payment: "paypal" },
        },
    });
    const data = await (await h.call()).json();
    assert.deepEqual(data.preferences, {
        shipping: "vinted",
        payment: "wallet",
    });
    assert.equal(h.serviceCalls.length, 0);
});

test("cross-site requests and invalid IDs fail before any checkout lookup or mutation", async () => {
    const h = harness();
    assert.equal(
        (await h.call("POST", { Origin: "https://evil.test" })).status,
        403,
    );
    assert.equal(
        (await h.call("POST", { "Sec-Fetch-Site": "cross-site" })).status,
        403,
    );
    assert.equal((await h.call("POST", {}, "123junk")).status, 400);
    assert.equal(h.databaseCalls.length, 0);
    assert.equal(h.serviceCalls.length, 0);
});

test("a payment URL or a checkout for a different domain is never returned to the browser", async () => {
    for (const upstreamUrl of [
        "https://evil.test/checkout",
        "https://www.vinted.fr/checkout",
        "https://www.paypal.com/payment",
    ]) {
        const h = harness({ upstreamUrl });
        const response = await h.call("POST");
        assert.equal(response.status, 502);
        assert.equal(
            JSON.stringify(await response.json()).includes(upstreamUrl),
            false,
        );
    }
});

const autoPreferences = {
    shipping: "home",
    payment: "paypal",
    autoCheckout: { warningVersion: 1, maxTotalMinor: 3000, currency: "EUR" },
};
const storedAutoPreferences = {
    accountId: 42,
    domain: "www.vinted.de",
    preferences: autoPreferences,
};

test("browser payment authorization is bound to current saved preferences and linked identity", async () => {
    const h = harness({
        preferences: storedAutoPreferences,
        browserAuthorized: true,
    });
    const headers = {
        "X-Vintrack-Checkout-Mode": "browser",
        "X-Vintrack-Checkout-Account": "42@www.vinted.de",
        "X-Vintrack-Checkout-Preferences": "home:paypal:auto:1:EUR:3000",
    };
    for (const changed of [
        { ...headers, "X-Vintrack-Checkout-Account": "99@www.vinted.de" },
        {
            ...headers,
            "X-Vintrack-Checkout-Preferences": "home:paypal:auto:1:EUR:4000",
        },
    ])
        assert.equal((await h.call("POST", changed)).status, 409);
    assert.equal(h.serviceCalls.length, 0);
    const response = await h.call("POST", headers);
    assert.deepEqual(await response.json(), { browserPaymentAuthorized: true });
    assert.equal(
        JSON.parse(h.serviceCalls[0].init.body as string).browser_prepare_only,
        true,
    );
    const normal = harness();
    assert.equal((await normal.call("POST", headers)).status, 400);
    assert.equal(normal.serviceCalls.length, 0);
});

test("a PayPal redirect is returned only for an enabled auto-checkout and verified destination", async () => {
    const paymentUrl = "https://www.paypal.com/checkoutnow?token=synthetic";
    for (const [preferences, url, status, expected] of [
        [
            storedAutoPreferences,
            paymentUrl,
            "paypal_redirect_ready",
            paymentUrl,
        ],
        [undefined, paymentUrl, "paypal_redirect_ready", undefined],
        [
            storedAutoPreferences,
            paymentUrl,
            "payment_outcome_unknown",
            undefined,
        ],
        [
            storedAutoPreferences,
            "https://www.paypal.com.evil.test/checkoutnow",
            "paypal_redirect_ready",
            undefined,
        ],
    ] as const) {
        const h = harness({
            preferences,
            upstreamPaymentUrl: url,
            upstreamStatus: status,
        });
        const data = await (await h.call("POST")).json();
        assert.equal(data.paymentUrl, expected);
    }
});
