import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";
import * as consent from "../../src/lib/checkout-consent.ts";

const target = {
    itemId: 123,
    monitorId: 17,
    accountId: 42,
    sellerId: 456,
    domain: "www.vinted.de",
    riskConsentVersion: 1,
    checkoutTransport: "server",
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

type Result = {
    message?: string;
    status?: string;
    tone: string;
    checkoutUrl?: string;
    paymentUrl?: string;
    navigating?: boolean;
};
type RunError = Error & {
    status?: number;
    code?: string;
    interrupted?: boolean;
};
const paymentUrl = "https://www.paypal.com/checkoutnow?token=synthetic";
const paypalTarget = {
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
};
const agentQueued = {
    status: 202,
    data: {
        target: { ...target, checkoutTransport: "agent" },
        status: "agent_queued",
        jobId: "a".repeat(64),
    },
};
const interruptedMessage =
    /connection was interrupted while checkout was running\. A purchase may already have been started/;

function harness(
    options: {
        responses?: {
            status?: number;
            data?: unknown;
            body?: string;
            fail?: boolean;
        }[];
        consent?: () => Promise<void>;
        fetchWait?: Promise<void>;
    } = {},
) {
    const calls: RequestInit[] = [];
    const navigations: string[] = [];
    const targets: unknown[] = [];
    const logs: unknown[] = [];
    const browserCalls: unknown[] = [];
    const events: string[] = [];
    const results: Result[] = [];
    const modules: Record<string, unknown> = {
        "@/lib/checkout": checkout,
        "@/lib/open-browser-checkout": {
            openBrowserCheckout: async (target: unknown) => {
                browserCalls.push(target);
                return "Opened browser checkout";
            },
        },
        "@/lib/checkout-consent": consent,
        "@/lib/checkout-consent.client": {
            requestCheckoutConsent:
                options.consent ??
                (() => {
                    throw new Error("unexpected consent");
                }),
        },
    };
    const exports: {
        openItemCheckout?: (...args: unknown[]) => Promise<unknown>;
        runItemCheckout?: (...args: unknown[]) => Promise<Result>;
    } = {};
    vm.runInNewContext(
        ts.transpileModule(
            readFileSync(
                new URL("../../src/lib/open-checkout.ts", import.meta.url),
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
                assert.ok(name in modules, `Unexpected import ${name}`);
                return modules[name];
            },
            AbortSignal,
            performance: { now: () => 1 },
            setTimeout: (callback: () => void) => callback(),
            console: { info: (...args: unknown[]) => logs.push(args) },
            window: {
                location: {
                    assign: (url: string) => {
                        events.push("navigate");
                        navigations.push(url);
                    },
                },
            },
            fetch: async (url: string, init: RequestInit) => {
                assert.ok(
                    url === "/api/checkout/17/123" ||
                        /^\/api\/checkout-agent\/jobs\/[a-f0-9]{64}$/.test(url),
                );
                calls.push(init);
                await options.fetchWait;
                const response = options.responses?.shift() ?? {
                    data: prepared,
                };
                if (response.fail) throw new TypeError("Failed to fetch");
                if (response.body !== undefined)
                    return new Response(response.body, {
                        status: response.status ?? 200,
                    });
                return Response.json(response.data, {
                    status: response.status ?? 200,
                });
            },
        },
    );
    return {
        calls,
        browserCalls,
        navigations,
        targets,
        logs,
        events,
        results,
        run: (validateOnly = false) =>
            exports.runItemCheckout!(17, 123, {
                validateOnly,
                onTargetLoaded: (value: unknown) => targets.push(value),
                onResult: (result: Result) => {
                    events.push("result");
                    results.push(result);
                },
            }),
        open: (validateOnly = false) =>
            exports.openItemCheckout!(
                17,
                123,
                (value: unknown) => targets.push(value),
                validateOnly,
            ),
    };
}

test("checkout prepares with one POST and no extension or preview dependency", async () => {
    const h = harness();
    await h.open();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, "POST");
    assert.equal(h.calls[0].cache, "no-store");
    assert.deepEqual(h.navigations, [checkoutUrl]);
    assert.deepEqual(h.targets, [target]);
    assert.doesNotMatch(
        JSON.stringify(h.logs),
        /synthetic|purchase_id|accountId/,
    );
});

test("concurrent clicks share the same preparation and navigation", async () => {
    let release!: () => void;
    const h = harness({
        fetchWait: new Promise<void>((resolve) => {
            release = resolve;
        }),
    });
    const first = h.open();
    const second = h.open();
    assert.equal(first, second);
    assert.equal(h.calls.length, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(h.navigations.length, 1);
});

test("pending consent cannot prepare until accepted and requires no preview GET", async () => {
    let accept!: () => void;
    let prompted!: () => void;
    const shown = new Promise<void>((resolve) => {
        prompted = resolve;
    });
    const h = harness({
        responses: [
            {
                status: 403,
                data: {
                    code: "CHECKOUT_CONSENT_REQUIRED",
                    target: { ...target, riskConsentVersion: null },
                },
            },
            { data: prepared },
        ],
        consent: () => {
            prompted();
            return new Promise<void>((resolve) => {
                accept = resolve;
            });
        },
    });
    const result = h.open();
    await shown;
    assert.equal(h.calls.length, 1);
    assert.equal(h.navigations.length, 0);
    accept();
    await result;
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every((call) => call.method === "POST"));
    assert.deepEqual(h.navigations, [checkoutUrl]);
});

test("cancelling consent prevents preparation and navigation", async () => {
    const h = harness({
        responses: [
            {
                status: 403,
                data: { code: "CHECKOUT_CONSENT_REQUIRED", target },
            },
        ],
        consent: async () => {
            throw new Error("Checkout cancelled");
        },
    });
    await assert.rejects(h.open(), /cancelled/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.navigations.length, 0);
});

for (const status of [401, 403, 409, 429, 502]) {
    test(`HTTP ${status} never retries or starts a browser fallback`, async () => {
        const h = harness({
            responses: [{ status, data: { error: "Check Vinted" } }],
        });
        await assert.rejects(h.open(), /Check Vinted/);
        assert.equal(h.calls.length, 1);
        assert.equal(h.navigations.length, 0);
    });
}

test("ambiguous transport failure is not retried", async () => {
    const h = harness({
        fetchWait: Promise.reject(new Error("connection lost")),
    });
    await assert.rejects(h.open(), interruptedMessage);
    assert.equal(h.calls.length, 1);
    assert.equal(h.navigations.length, 0);
});

test("a rejected request or an unreadable answer reports an interrupted checkout without a second request", async () => {
    for (const [response, status] of [
        [{ fail: true }, undefined],
        [{ status: 502, body: "<html>Bad gateway</html>" }, 502],
        [{ status: 200, body: "" }, 200],
        [{ status: 200, data: null }, 200],
    ] as const) {
        const h = harness({ responses: [{ ...response }] });
        await assert.rejects(h.run(), (error: RunError) => {
            assert.match(error.message, interruptedMessage);
            assert.equal(error.name, "CheckoutRunError");
            assert.equal(error.interrupted, true);
            assert.equal(error.status, status);
            return true;
        });
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.navigations, []);
        assert.deepEqual(h.results, []);
        assert.deepEqual(h.browserCalls, []);
    }
});

test("a service error keeps its status, code and retryable text", async () => {
    const text =
        "The proxy gave no answer. Nothing was started at Vinted; you can use this buy link again.";
    const h = harness({
        responses: [
            {
                status: 502,
                data: {
                    target,
                    error: text,
                    code: "checkout_network_failed",
                    failedStep: "transaction",
                    retryable: true,
                },
            },
        ],
    });
    await assert.rejects(h.run(), (error: RunError) => {
        assert.equal(error.message, text);
        assert.equal(error.status, 502);
        assert.equal(error.code, "checkout_network_failed");
        assert.notEqual(error.interrupted, true);
        return true;
    });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.targets, [target]);
});

test("an unavailable feature is explained, and a server explanation wins", async () => {
    const denied = harness({
        responses: [{ status: 403, data: { code: "FEATURE_UNAVAILABLE" } }],
    });
    await assert.rejects(denied.run(), (error: RunError) => {
        assert.equal(
            error.message,
            "Checkout is not available for your account on this instance.",
        );
        assert.equal(error.status, 403);
        assert.equal(error.code, "FEATURE_UNAVAILABLE");
        return true;
    });
    const disabled = harness({
        responses: [
            {
                status: 403,
                data: {
                    code: "FEATURE_UNAVAILABLE",
                    error: "Enable the checkout module in Account before using checkout.",
                },
            },
        ],
    });
    await assert.rejects(disabled.run(), /Enable the checkout module/);
    const signedOut = harness({
        responses: [{ status: 401, data: { error: "Sign in to Vintrack" } }],
    });
    await assert.rejects(signedOut.run(), (error: RunError) => {
        assert.equal(error.status, 401);
        return true;
    });
});

test("the PayPal link reaches the page before the automatic navigation", async () => {
    const h = harness({
        responses: [
            {
                data: {
                    ...prepared,
                    target: paypalTarget,
                    status: "paypal_redirect_ready",
                    paymentUrl,
                },
            },
        ],
    });
    const result = await h.run();
    assert.deepEqual(h.events, ["result", "navigate"]);
    assert.deepEqual(h.navigations, [paymentUrl]);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].paymentUrl, paymentUrl);
    assert.equal(h.results[0].status, "paypal_redirect_ready");
    assert.equal(h.results[0].navigating, true);
    assert.equal(h.results[0].tone, "info");
    assert.equal(h.results[0].checkoutUrl, undefined);
    assert.match(String(h.results[0].message), /PayPal/);
    assert.deepEqual({ ...result }, { ...h.results[0] });
});

test("a reopened PayPal checkout returns the same link again without another request", async () => {
    const reason =
        "A PayPal payment was already started for this item. Continue in PayPal to complete it; no second payment request was sent.";
    const h = harness({
        responses: [
            {
                data: {
                    ...prepared,
                    target: paypalTarget,
                    status: "paypal_redirect_ready",
                    paymentUrl,
                    autoCheckoutReason: reason,
                },
            },
        ],
    });
    const result = await h.run();
    assert.equal(result.paymentUrl, paymentUrl);
    assert.equal(result.message, reason);
    assert.equal(result.navigating, true);
    assert.deepEqual(h.navigations, [paymentUrl]);
    assert.equal(h.calls.length, 1);
    const expired = harness({
        responses: [
            {
                data: {
                    ...prepared,
                    target: paypalTarget,
                    status: "checkout_review_required",
                    autoCheckoutReason: "The PayPal link expired.",
                },
            },
        ],
    });
    const stopped = await expired.run();
    assert.equal(stopped.paymentUrl, undefined);
    assert.equal(stopped.checkoutUrl, checkoutUrl);
    assert.equal(stopped.message, "The PayPal link expired.");
    assert.deepEqual(expired.navigations, []);
});

test("card authentication navigates and still hands the Vinted link to the page", async () => {
    const h = harness();
    const result = await h.run();
    assert.deepEqual(h.events, ["result", "navigate"]);
    assert.deepEqual(h.navigations, [checkoutUrl]);
    assert.equal(result.checkoutUrl, checkoutUrl);
    assert.equal(result.paymentUrl, undefined);
    assert.equal(result.navigating, true);
    assert.equal(result.status, "card_authentication_required");
});

test("a stopped Full checkout returns its checkout link without navigating", async () => {
    for (const status of ["checkout_prepared", "checkout_review_required"]) {
        const h = harness({ responses: [{ data: { ...prepared, status } }] });
        const result = await h.run();
        assert.equal(result.checkoutUrl, checkoutUrl);
        assert.equal(result.paymentUrl, undefined);
        assert.equal(result.tone, "warning");
        assert.notEqual(result.navigating, true);
        assert.match(String(result.message), /stopped before payment/);
        assert.deepEqual(h.events, ["result"]);
        assert.deepEqual(h.navigations, []);
        assert.equal(h.calls.length, 1);
    }
});

test("the result tone follows the checkout status", async () => {
    for (const [status, tone] of [
        ["card_payment_confirmed", "success"],
        ["card_payment_pending", "info"],
        ["card_payment_failed", "error"],
        ["payment_outcome_unknown", "error"],
        ["checkout_review_required", "warning"],
        ["checkout_prepared", "warning"],
        ["card_authentication_required", "info"],
    ]) {
        const h = harness({ responses: [{ data: { ...prepared, status } }] });
        const result = await h.run();
        assert.equal(result.tone, tone, status);
        assert.equal(result.status, status);
        assert.deepEqual(h.results, [result]);
    }
    const browser = harness({
        responses: [
            {
                data: {
                    target: {
                        ...target,
                        checkoutTransport: "browser",
                        preferences: { shipping: "home", payment: "wallet" },
                    },
                    status: "browser_checkout_required",
                },
            },
        ],
    });
    const opened = await browser.run();
    assert.equal(opened.tone, "info");
    assert.equal(opened.message, "Opened browser checkout");
    assert.deepEqual(browser.events, ["result"]);
});

test("both entry points share one in-flight checkout", async () => {
    let release!: () => void;
    const h = harness({
        fetchWait: new Promise<void>((resolve) => {
            release = resolve;
        }),
    });
    const run = h.run();
    const message = h.open();
    assert.equal(h.run(), run);
    assert.equal(h.open(), message);
    assert.equal(h.calls.length, 1);
    release();
    const result = await run;
    assert.equal(await message, result.message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.navigations.length, 1);
    assert.equal(h.results.length, 1);
});

test("only opted-in PayPal redirects with a verified status are opened", async () => {
    const autoTarget = paypalTarget;
    const h = harness({
        responses: [
            {
                data: {
                    ...prepared,
                    target: autoTarget,
                    status: "paypal_redirect_ready",
                    paymentUrl,
                },
            },
        ],
    });
    await h.open();
    assert.deepEqual(h.navigations, [paymentUrl]);
    for (const data of [
        {
            ...prepared,
            target: {
                ...target,
                preferences: { shipping: "home", payment: "paypal" },
            },
            paymentUrl,
            status: "paypal_redirect_ready",
        },
        {
            ...prepared,
            target: autoTarget,
            paymentUrl,
            status: "payment_outcome_unknown",
        },
        {
            ...prepared,
            target: autoTarget,
            paymentUrl: "https://evil.test/checkoutnow",
            status: "paypal_redirect_ready",
        },
        { ...prepared, checkoutUrl: "https://evil.test/checkout" },
        { ...prepared, target: { ...target, itemId: 999 } },
        { ...prepared, target: { ...target, riskConsentVersion: null } },
    ]) {
        const invalid = harness({ responses: [{ data }] });
        await assert.rejects(invalid.open());
        assert.equal(invalid.navigations.length, 0);
        assert.equal(invalid.calls.length, 1);
    }
});

for (const status of [
    "card_payment_confirmed",
    "card_payment_pending",
    "card_payment_failed",
    "payment_outcome_unknown",
]) {
    test(`${status} finishes by request without opening a browser checkout`, async () => {
        const h = harness({
            responses: [
                {
                    data: {
                        ...prepared,
                        status,
                        autoCheckoutReason:
                            "Synthetic payment outcome. Do not pay again.",
                    },
                },
            ],
        });
        assert.equal(
            await h.open(),
            "Synthetic payment outcome. Do not pay again.",
        );
        assert.equal(h.calls.length, 1);
        assert.equal(h.navigations.length, 0);
    });
}

test("the explicit browser selection dispatches only the existing browser path", async () => {
    const browserTarget = {
        ...target,
        checkoutTransport: "browser",
        preferences: { shipping: "home", payment: "wallet" },
    };
    const h = harness({
        responses: [
            {
                data: {
                    target: browserTarget,
                    status: "browser_checkout_required",
                },
            },
        ],
    });
    assert.equal(await h.open(), "Opened browser checkout");
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.browserCalls, [browserTarget]);
    assert.deepEqual(h.navigations, []);
});

test("request Full checkout never falls back to a preparation-only browser handoff", async () => {
    for (const status of ["checkout_prepared", "checkout_review_required"]) {
        const h = harness({ responses: [{ data: { ...prepared, status } }] });
        assert.match(
            String(await h.open()),
            /Full checkout stopped before payment/,
        );
        assert.deepEqual(h.navigations, []);
        assert.deepEqual(h.browserCalls, []);
        assert.equal(h.calls.length, 1);
    }
});

test("a stale request response without Full checkout opt-in cannot poll, navigate or invoke the extension", async () => {
    for (const transport of ["server", "agent"]) {
        const h = harness({
            responses: [
                {
                    data: {
                        ...prepared,
                        target: {
                            ...target,
                            checkoutTransport: transport,
                            preferences: { shipping: "home", payment: "card" },
                        },
                        status: "agent_queued",
                        jobId: "a".repeat(64),
                    },
                },
            ],
        });
        await assert.rejects(h.open(), /requires Full checkout/);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.navigations, []);
        assert.deepEqual(h.browserCalls, []);
    }
});

test("a server error cannot dispatch browser checkout", async () => {
    const h = harness({
        responses: [
            { status: 409, data: { error: "Sync server checkout context" } },
        ],
    });
    await assert.rejects(h.open(), /Sync/);
    assert.deepEqual(h.browserCalls, []);
});

test("validation sends the explicit stop mode and never navigates to payment", async () => {
    const h = harness({
        responses: [
            {
                data: {
                    ...prepared,
                    status: "payment_ready",
                    stoppedBeforePayment: true,
                },
            },
        ],
    });
    assert.match(String(await h.open(true)), /before payment/);
    assert.equal(
        (h.calls[0].headers as Record<string, string>)[
            "X-Vintrack-Checkout-Mode"
        ],
        "validate",
    );
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.browserCalls, []);
});

test("validation rejects a response without an explicit payment stop", async () => {
    const h = harness();
    await assert.rejects(h.open(true), /did not confirm a stop/);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.browserCalls, []);
});

test("a local agent result is read without dispatching extension or server preparation", async () => {
    const h = harness({
        responses: [
            {
                status: 202,
                data: {
                    target: { ...target, checkoutTransport: "agent" },
                    status: "agent_queued",
                    jobId: "a".repeat(64),
                },
            },
            {
                data: {
                    state: "complete",
                    result: {
                        checkout_url: checkoutUrl,
                        status: "card_payment_confirmed",
                    },
                },
            },
        ],
    });
    assert.match(String(await h.open()), /confirmed/);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.browserCalls, []);
});

test("an interrupted local job is never resubmitted or redirected", async () => {
    const h = harness({
        responses: [
            {
                status: 202,
                data: {
                    target: { ...target, checkoutTransport: "agent" },
                    status: "agent_queued",
                    jobId: "a".repeat(64),
                },
            },
            { data: { state: "interrupted" } },
        ],
    });
    await assert.rejects(h.open(), /will not be replayed/);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.browserCalls, []);
});

test("validation results never carry a checkout or payment link", async () => {
    for (const status of ["payment_ready", "checkout_review_required"]) {
        const h = harness({
            responses: [
                {
                    data: {
                        ...prepared,
                        status,
                        stoppedBeforePayment: true,
                    },
                },
            ],
        });
        const result = await h.run(true);
        assert.match(String(result.message), /Test finished before payment/);
        assert.equal(result.checkoutUrl, undefined);
        assert.equal(result.paymentUrl, undefined);
        assert.notEqual(result.navigating, true);
        assert.equal(
            result.tone,
            status === "payment_ready" ? "info" : "warning",
        );
        assert.deepEqual(h.navigations, []);
    }
});

test("a single failed job poll does not abort a local agent checkout", async () => {
    const complete = {
        data: {
            state: "complete",
            result: {
                checkout_url: checkoutUrl,
                status: "card_payment_confirmed",
            },
        },
    };
    for (const failed of [
        { fail: true },
        { status: 502, body: "<html>Bad gateway</html>" },
        { status: 503, data: { error: "Agent proxy unavailable" } },
    ]) {
        const h = harness({
            responses: [
                agentQueued,
                failed,
                { data: { state: "running" } },
                failed,
                failed,
                failed,
                failed,
                complete,
            ],
        });
        const result = await h.run();
        assert.equal(result.tone, "success");
        assert.equal(h.calls.length, 8);
        assert.equal(
            h.calls.filter((call) => call.method === "POST").length,
            1,
        );
        assert.deepEqual(h.navigations, []);
    }
});

test("five consecutive failed job polls stop without resubmitting the checkout", async () => {
    const h = harness({
        responses: [
            agentQueued,
            ...Array.from({ length: 5 }, () => ({ fail: true })),
            { data: { state: "complete" } },
        ],
    });
    await assert.rejects(h.run(), (error: RunError) => {
        assert.match(error.message, /Agent result unavailable/);
        assert.equal(error.interrupted, true);
        return true;
    });
    assert.equal(h.calls.length, 6);
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.results, []);
    const missing = harness({
        responses: [
            agentQueued,
            { status: 404, data: { error: "Unknown checkout job" } },
        ],
    });
    await assert.rejects(missing.run(), /Unknown checkout job/);
    assert.equal(missing.calls.length, 2);
});

test("a checkout the server lost track of is reported as interrupted without a second request", async () => {
    const text =
        "The connection to the checkout service was interrupted while checkout was running. A purchase may already have been started; check Vinted before using this link again.";
    const h = harness({
        responses: [
            {
                status: 502,
                data: { target, error: text, code: "checkout_interrupted" },
            },
        ],
    });
    await assert.rejects(h.run(), (error: RunError) => {
        assert.equal(error.message, text);
        assert.equal(error.code, "checkout_interrupted");
        assert.equal(error.interrupted, true);
        return true;
    });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.navigations, []);
});
