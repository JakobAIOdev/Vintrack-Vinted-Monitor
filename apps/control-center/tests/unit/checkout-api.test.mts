import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";
import * as checkoutConsent from "../../src/lib/checkout-consent.ts";

function harness(
    options: {
        anonymous?: boolean;
        itemLookup?: () => Promise<void>;
        accountLookup?: () => void;
        checkoutEnabled?: boolean;
        denied?: boolean;
        missingItem?: boolean;
        unlinked?: boolean;
        upstreamUrl?: string;
        preferences?: unknown;
        transport?: "browser" | "server" | "agent" | null;
        agentJobId?: string;
        accountDomain?: string;
        upstreamPaymentUrl?: string;
        upstreamStatus?: string;
        browserAuthorized?: boolean;
        riskConsentVersion?: number;
        missingConsentDate?: boolean;
        upstreamError?: { status: number; body?: unknown; text?: string };
        upstreamFailure?: boolean;
    } = {},
) {
    const databaseCalls: unknown[] = [];
    const afterTasks: (() => Promise<void>)[] = [];
    const serviceCalls: { url: string; init: RequestInit }[] = [];
    const db = {
        user: {
            async findUnique() {
                return {
                    checkout_enabled: options.checkoutEnabled ?? true,
                    checkout_preferences: {
                        accountId: 42,
                        domain: options.accountDomain || "www.vinted.de",
                        preferences: {
                            shipping: "home",
                            payment: "card",
                            autoCheckout: {
                                warningVersion: 2,
                                maxTotalMinor: 3000,
                                currency: "EUR",
                            },
                        },
                        ...(options.preferences &&
                        typeof options.preferences === "object"
                            ? options.preferences
                            : {}),
                        ...(options.transport === null
                            ? {}
                            : { transport: options.transport ?? "server" }),
                    },
                    checkout_risk_version: options.riskConsentVersion ?? 1,
                    checkout_risk_accepted_at: options.missingConsentDate
                        ? null
                        : new Date("2026-10-05T12:00:00Z"),
                };
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
                if (options.itemLookup) await options.itemLookup();
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
                options.accountLookup?.();
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
        "@/lib/checkout-consent": checkoutConsent,
        "@/lib/checkout-notifications.server": {
            queueCheckoutNotification: async () => {},
        },
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
        "next/server": {
            NextResponse: { json: Response.json },
            after: (task: () => Promise<void>) => afterTasks.push(task),
        },
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
                if (options.upstreamFailure)
                    throw new TypeError("Failed to fetch");
                if (options.upstreamError)
                    return options.upstreamError.text === undefined
                        ? Response.json(options.upstreamError.body, {
                              status: options.upstreamError.status,
                          })
                        : new Response(options.upstreamError.text, {
                              status: options.upstreamError.status,
                          });
                return Response.json({
                    checkout_url:
                        options.upstreamUrl ||
                        "https://www.vinted.de/checkout?purchase_id=synthetic",
                    status: options.upstreamStatus || "checkout_prepared",
                    payment_url: options.upstreamPaymentUrl,
                    browser_payment_authorized: options.browserAuthorized,
                    job_id: options.agentJobId,
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
        afterTasks,
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

test("missing, outdated or undated consent blocks checkout and browser payment claims", async () => {
    for (const options of [
        { riskConsentVersion: 0 },
        { riskConsentVersion: 2 },
        { missingConsentDate: true },
    ]) {
        const h = harness(options);
        const preview = await h.call();
        assert.equal(preview.status, 403);
        const data = await preview.json();
        assert.equal(data.code, "CHECKOUT_CONSENT_REQUIRED");
        assert.equal(data.target.riskConsentVersion, null);
        const checkoutModes: Record<string, string>[] = [
            {},
            { "X-Vintrack-Checkout-Mode": "browser" },
        ];
        for (const headers of checkoutModes) {
            const response = await h.call("POST", headers);
            assert.equal(response.status, 403);
            assert.equal(
                (await response.json()).code,
                "CHECKOUT_CONSENT_REQUIRED",
            );
        }
        assert.equal(h.serviceCalls.length, 0);
    }
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
        preferences: {
            shipping: "home",
            payment: "card",
            autoCheckout: {
                warningVersion: 2,
                maxTotalMinor: 3000,
                currency: "EUR",
            },
        },
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
        { shipping: "nearest", payment: "paypal" },
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
    const normal = harness({
        preferences: { preferences: { shipping: "home", payment: "wallet" } },
    });
    assert.equal((await normal.call("POST", headers)).status, 400);
    assert.equal(normal.serviceCalls.length, 0);
});

test("GBP pickup authorization rejects stale currency or delivery before reserving payment", async () => {
    const preferences = {
        shipping: "pickup",
        payment: "card",
        autoCheckout: {
            warningVersion: 2,
            currency: "GBP",
            maxTotalMinor: 1829,
        },
    };
    const h = harness({
        accountDomain: "www.vinted.co.uk",
        browserAuthorized: true,
        preferences: { accountId: 42, domain: "www.vinted.co.uk", preferences },
    });
    const headers = {
        "X-Vintrack-Checkout-Mode": "browser",
        "X-Vintrack-Checkout-Account": "42@www.vinted.co.uk",
        "X-Vintrack-Checkout-Preferences": "pickup:card:auto:2:GBP:1829",
    };
    for (const key of [
        "pickup:card:auto:2:EUR:1829",
        "home:card:auto:2:GBP:1829",
    ]) {
        assert.equal(
            (
                await h.call("POST", {
                    ...headers,
                    "X-Vintrack-Checkout-Preferences": key,
                })
            ).status,
            409,
        );
    }
    assert.equal(h.serviceCalls.length, 0);
    assert.deepEqual((await (await h.call()).json()).preferences, preferences);
    assert.deepEqual(await (await h.call("POST", headers)).json(), {
        browserPaymentAuthorized: true,
    });
    assert.equal(h.serviceCalls.length, 1);
    assert.deepEqual(
        JSON.parse(h.serviceCalls[0].init.body as string).preferences,
        preferences,
    );
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
            {
                ...storedAutoPreferences,
                preferences: {
                    ...autoPreferences,
                    payment: "card",
                    autoCheckout: {
                        ...autoPreferences.autoCheckout,
                        warningVersion: 2,
                    },
                },
            },
            paymentUrl,
            "paypal_redirect_ready",
            undefined,
        ],
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

test("disabled checkout blocks existing notification links and browser payment claims", async () => {
    const h = harness({
        checkoutEnabled: false,
        preferences: storedAutoPreferences,
    });
    for (const method of ["GET", "POST"]) {
        const response = await h.call(method);
        assert.equal(response.status, 403);
        assert.match(
            (await response.json()).error,
            /Enable the checkout module/,
        );
    }
    assert.equal(h.serviceCalls.length, 0);
});

test("linked-account metadata loads while the authorized item lookup is still pending", async () => {
    let releaseItem!: () => void;
    const itemPending = new Promise<void>((resolve) => {
        releaseItem = resolve;
    });
    let accountStarted = false;
    const h = harness({
        itemLookup: () => itemPending,
        accountLookup: () => {
            accountStarted = true;
        },
    });
    const request = h.call();
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(accountStarted, true);
    } finally {
        releaseItem();
    }
    assert.equal((await request).status, 200);
    assert.equal(h.serviceCalls.length, 0);
});

test("request checkout returns its authoritative target and defers notification work", async () => {
    const h = harness();
    const response = await h.call("POST");
    const data = await response.json();
    assert.equal(data.target.itemId, 123);
    assert.equal(data.target.monitorId, 17);
    assert.equal(data.target.riskConsentVersion, 1);
    assert.equal(data.target.domain, "www.vinted.de");
    assert.equal(h.afterTasks.length, 1);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("consent denial returns a local preview before any checkout request", async () => {
    const h = harness({ missingConsentDate: true });
    const response = await h.call("POST");
    const data = await response.json();
    assert.equal(response.status, 403);
    assert.equal(data.target.itemId, 123);
    assert.equal(data.target.riskConsentVersion, null);
    assert.equal(h.serviceCalls.length, 0);
    assert.equal(h.afterTasks.length, 0);
});

test("validation explicitly stops before payment and never forwards a payment redirect or notification", async () => {
    const h = harness({
        preferences: storedAutoPreferences,
        upstreamPaymentUrl:
            "https://www.paypal.com/checkoutnow?token=synthetic",
        upstreamStatus: "paypal_redirect_ready",
    });
    const response = await h.call("POST", {
        "X-Vintrack-Checkout-Mode": "validate",
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.stoppedBeforePayment, true);
    assert.equal(data.paymentUrl, undefined);
    assert.equal(h.afterTasks.length, 0);
    assert.equal(h.serviceCalls.length, 1);
    assert.equal(
        JSON.parse(h.serviceCalls[0].init.body as string).stop_before_payment,
        true,
    );
});

test("unknown modes cannot silently start full checkout", async () => {
    const h = harness({ preferences: storedAutoPreferences });
    const response = await h.call("POST", {
        "X-Vintrack-Checkout-Mode": "validat",
    });
    assert.equal(response.status, 400);
    assert.equal(h.serviceCalls.length, 0);
});

test("browser remains the selected path without a server mutation", async () => {
    const h = harness({ transport: "browser" });
    const response = await h.call("POST");
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, "browser_checkout_required");
    assert.equal(data.target.checkoutTransport, "browser");
    assert.equal(h.serviceCalls.length, 0);
    assert.equal(h.afterTasks.length, 0);
});

test("request transports require Full checkout before any service call, including validation", async () => {
    for (const transport of ["server", "agent"] as const) {
        for (const headers of [
            {},
            { "X-Vintrack-Checkout-Mode": "validate" },
        ] as Record<string, string>[]) {
            const h = harness({
                transport,
                preferences: {
                    preferences: { shipping: "home", payment: "card" },
                },
            });
            const response = await h.call("POST", headers);
            assert.equal(response.status, 409);
            assert.equal(
                (await response.json()).code,
                "FULL_CHECKOUT_REQUIRED",
            );
            assert.equal(h.serviceCalls.length, 0);
            assert.equal(h.afterTasks.length, 0);
        }
    }
});

test("an HTTP header cannot opt a member into experimental server checkout", async () => {
    for (const mode of ["server", "validate"]) {
        const h = harness({ transport: "browser" });
        const response = await h.call("POST", {
            "X-Vintrack-Checkout-Mode": mode,
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, "SERVER_CHECKOUT_DISABLED");
        assert.equal(h.serviceCalls.length, 0);
    }
});

test("existing accounts without a transport opt-in retain browser checkout", async () => {
    const h = harness({ transport: null });
    const response = await h.call("POST");
    assert.equal((await response.json()).status, "browser_checkout_required");
    assert.equal(h.serviceCalls.length, 0);
});

test("local-agent checkout queues only an authorized job and never prepares on the server", async () => {
    const jobId = "a".repeat(64);
    const h = harness({ transport: "agent", agentJobId: jobId });
    const response = await h.call("POST");
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobId, jobId);
    assert.equal(h.serviceCalls.length, 1);
    assert.match(h.serviceCalls[0].url, /items\/checkout\/agent$/);
    assert.equal(h.afterTasks.length, 0);
    assert.equal(
        JSON.parse(String(h.serviceCalls[0].init.body)).stop_before_payment,
        false,
    );
});

test("agent validation is queued with a mandatory payment stop", async () => {
    const h = harness({ transport: "agent", agentJobId: "b".repeat(64) });
    const response = await h.call("POST", {
        "X-Vintrack-Checkout-Mode": "validate",
    });
    assert.equal(response.status, 202);
    assert.equal(
        JSON.parse(String(h.serviceCalls[0].init.body)).stop_before_payment,
        true,
    );
});

test("every answer of the checkout route is uncacheable, including errors", async () => {
    const noStore = async (
        options: Parameters<typeof harness>[0],
        status: number,
        method = "POST",
        headers: HeadersInit = {},
        itemId = "123",
    ) => {
        const response = await harness(options).call(method, headers, itemId);
        assert.equal(response.status, status);
        assert.equal(
            response.headers.get("cache-control"),
            "private, no-store",
            `${method} ${status} ${JSON.stringify(options)}`,
        );
    };
    for (const method of ["GET", "POST"]) {
        await noStore({ anonymous: true }, 401, method);
        await noStore({ denied: true }, 403, method);
        await noStore({ missingItem: true }, 404, method);
        await noStore({ unlinked: true }, 409, method);
        await noStore({ checkoutEnabled: false }, 403, method);
        await noStore({ missingConsentDate: true }, 403, method);
        await noStore({}, 400, method, {}, "123junk");
    }
    await noStore({}, 403, "POST", { Origin: "https://evil.test" });
    await noStore({}, 400, "POST", { "X-Vintrack-Checkout-Mode": "validat" });
    await noStore({ transport: "browser" }, 403, "POST", {
        "X-Vintrack-Checkout-Mode": "server",
    });
    await noStore({ transport: "browser" }, 200);
    await noStore(
        { preferences: { preferences: { shipping: "home", payment: "card" } } },
        409,
    );
    await noStore({ upstreamUrl: "https://evil.test/checkout" }, 502);
    await noStore({ upstreamFailure: true }, 502);
    await noStore({ upstreamError: { status: 502, text: "<html>" } }, 502);
    await noStore({ upstreamError: { status: 429, body: {} } }, 429);
    await noStore({ transport: "agent", agentJobId: "a".repeat(64) }, 202);
    await noStore({ transport: "agent", agentJobId: "invalid" }, 502);
    await noStore(
        { transport: "agent", upstreamError: { status: 503, body: {} } },
        503,
    );
    await noStore({ transport: "agent" }, 409, "POST", {
        "X-Vintrack-Checkout-Mode": "server",
    });
});

test("a service failure forwards retryable only as a literal true", async () => {
    const error =
        "The proxy gave no answer. Nothing was started at Vinted; you can use this buy link again.";
    const h = harness({
        upstreamError: {
            status: 502,
            body: {
                code: "checkout_network_failed",
                error,
                failed_step: "transaction",
                retryable: true,
            },
        },
    });
    const response = await h.call("POST");
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.error, error);
    assert.equal(data.code, "checkout_network_failed");
    assert.equal(data.failedStep, "transaction");
    assert.equal(data.retryable, true);
    assert.equal(data.target.itemId, 123);
    assert.equal(h.serviceCalls.length, 1);
    assert.equal(h.afterTasks.length, 0);
    for (const retryable of [undefined, false, "true", 1, {}]) {
        const other = harness({
            upstreamError: {
                status: 502,
                body: {
                    code: "vinted_redirected",
                    error: "Vinted redirected the request.",
                    failed_step: "payment",
                    upstream_status: 502,
                    retryable,
                },
            },
        });
        const body = await (await other.call("POST")).json();
        assert.equal("retryable" in body, false);
        assert.equal(body.code, "vinted_redirected");
        assert.equal(body.failedStep, "payment");
        assert.equal(body.upstreamStatus, 502);
    }
});

test("a failed agent enqueue forwards the service code", async () => {
    const h = harness({
        transport: "agent",
        upstreamError: {
            status: 409,
            body: { code: "agent_offline", error: "Start the local agent." },
        },
    });
    const response = await h.call("POST");
    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.code, "agent_offline");
    assert.equal(data.error, "Start the local agent.");
    assert.equal(data.target.itemId, 123);
});

test("the target never exposes the checkout proxy group or the module switch", async () => {
    const stored = {
        proxyGroupId: 7,
        preferences: autoPreferences,
    };
    const targetKeys = [
        "accountId",
        "accountName",
        "checkoutTransport",
        "domain",
        "itemId",
        "itemUrl",
        "monitorId",
        "preferences",
        "price",
        "riskConsentVersion",
        "sellerId",
        "title",
    ];
    const preview = await (
        await harness({ preferences: stored }).call()
    ).json();
    assert.deepEqual(Object.keys(preview).sort(), targetKeys);
    for (const options of [
        { preferences: stored },
        { preferences: stored, transport: "browser" as const },
        { preferences: stored, missingConsentDate: true },
        {
            preferences: stored,
            upstreamError: { status: 502, body: { error: "Synthetic" } },
        },
    ]) {
        const h = harness(options);
        const data = await (await h.call("POST")).json();
        assert.deepEqual(Object.keys(data.target).sort(), targetKeys);
        assert.doesNotMatch(
            JSON.stringify(data),
            /checkoutProxyGroupId|checkoutEnabled|proxyGroupId/,
        );
    }
});

test("a rejected Vinted session is not reported as a Vintrack sign-out", async () => {
    const h = harness({
        upstreamError: {
            status: 401,
            body: {
                code: "invalid_authentication_token",
                error: "Reconnect your Vinted account before preparing checkout.",
                failed_step: "transaction",
            },
        },
    });
    const response = await h.call("POST");
    // 401 is reserved for "not signed in to Vintrack".
    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.code, "invalid_authentication_token");
    assert.equal(data.retryable, undefined);
    assert.equal(data.target.itemId, 123);
    assert.equal(h.serviceCalls.length, 1);
});

test("a lost call to the checkout service is reported as interrupted, never as a plain failure", async () => {
    const h = harness({ upstreamFailure: true });
    const response = await h.call("POST");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const data = await response.json();
    assert.equal(data.code, "checkout_interrupted");
    assert.match(data.error, /purchase may already have been started/);
    assert.equal(data.target.itemId, 123);
    assert.equal(h.afterTasks.length, 0);
});
