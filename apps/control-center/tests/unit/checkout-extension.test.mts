import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";
import * as consent from "../../src/lib/checkout-consent.ts";

function compile(path: string, globals: Record<string, unknown> = {}) {
    const exports: Record<string, (...args: unknown[]) => Promise<unknown>> =
        {};
    const code = ts.transpileModule(
        readFileSync(new URL(path, import.meta.url), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    vm.runInNewContext(code, { exports, ...globals });
    return exports;
}

function receiver() {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const listeners = new Set<(event: unknown) => void>();
    const posts: { type: string; requestId: string }[] = [];
    const window = {
        location: { origin: "https://vintrack.test" },
        setTimeout(fn: () => void, delay: number) {
            const key = ++id;
            timers.set(key, { at: now + delay, fn });
            return key;
        },
        clearTimeout(key: number) {
            timers.delete(key);
        },
        addEventListener(_type: string, listener: (event: unknown) => void) {
            listeners.add(listener);
        },
        removeEventListener(_type: string, listener: (event: unknown) => void) {
            listeners.delete(listener);
        },
        postMessage(
            message: { type: string; requestId: string },
            origin: string,
        ) {
            assert.equal(origin, window.location.origin);
            posts.push(message);
        },
    };
    const extension = compile("../../src/lib/vintrack-extension.ts", {
        window,
    });
    return {
        detect: () => extension.detectCheckoutExtension(),
        posts,
        timers,
        listeners,
        reply(
            payload: Record<string, unknown>,
            overrides: Record<string, unknown> = {},
        ) {
            for (const listener of listeners)
                listener({
                    source: window,
                    origin: window.location.origin,
                    data: { type: "VINTRACK_EXTENSION_READY", payload },
                    ...overrides,
                });
        },
        advance(ms: number) {
            const until = now + ms;
            while (true) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].fn();
            }
            now = until;
        },
    };
}

test("cold mobile receiver responding after 900ms is accepted and all resources are cleaned", async () => {
    const h = receiver();
    const result = h.detect();
    h.advance(900);
    assert.equal(h.posts.length, 2);
    assert.equal(h.posts[0].requestId, h.posts[1].requestId);
    h.reply({
        requestId: h.posts[0].requestId,
        configured: true,
        checkoutPrepareVersion: 8,
        checkoutCapabilities: { prepare: true, automaticPayment: false },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await result)), {
        state: "ready",
        protocol: 8,
        automaticPayment: false,
    });
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
    h.advance(10_000);
    assert.equal(h.posts.length, 2);
});

test("foreign origins, sources, and unrelated probe replies cannot satisfy detection", async () => {
    const h = receiver();
    const result = h.detect();
    const payload = { configured: true, checkoutPrepareVersion: 8 };
    h.reply(payload, { source: {} });
    h.reply(payload, { origin: "https://foreign.test" });
    h.reply({ ...payload, requestId: "another-probe" });
    h.advance(2999);
    assert.equal(h.listeners.size, 1);
    assert.equal(h.posts.length, 3);
    h.advance(1);
    assert.equal(((await result) as { state: string }).state, "unavailable");
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
});

for (const [payload, expected] of [
    [{ configured: false, checkoutPrepareVersion: 8 }, "unconfigured"],
    [{ configured: true, checkoutPrepareVersion: 1 }, "outdated"],
    [{ configured: true, checkoutPrepareVersion: "8" }, "outdated"],
    [
        {
            configured: true,
            checkoutPrepareVersion: 8,
            checkoutCapabilities: { prepare: false },
        },
        "outdated",
    ],
    [{ configured: true, checkoutPrepareVersion: 8 }, "ready"],
] as const) {
    test(`capability result ${JSON.stringify(payload)} is ${expected}`, async () => {
        const h = receiver();
        const result = h.detect();
        h.reply(payload);
        assert.equal(((await result) as { state: string }).state, expected);
        assert.equal(h.listeners.size, 0);
        assert.equal(h.timers.size, 0);
    });
}

for (const state of [
    "unavailable",
    "unconfigured",
    "outdated",
    "mobile-auto",
] as const) {
    test(`${state} detection never mutates server checkout or dispatches browser commands`, async () => {
        const calls: RequestInit[] = [];
        let commands = 0;
        const modules: Record<string, unknown> = {
            "@/lib/checkout": checkout,
            "@/lib/checkout-consent": consent,
            "@/lib/checkout-consent.client": {
                requestCheckoutConsent: () => {
                    throw new Error("unexpected consent");
                },
            },
            "@/lib/vintrack-extension": {
                detectCheckoutExtension: async () => ({
                    state: state === "mobile-auto" ? "ready" : state,
                    protocol: 8,
                    automaticPayment: false,
                }),
                runBrowserBuyViaExtension: () => {
                    commands++;
                    throw new Error("unexpected checkout");
                },
            },
        };
        const client = compile("../../src/lib/open-checkout.ts", {
            require: (name: string) => {
                assert.ok(name in modules, name);
                return modules[name];
            },
            performance: { now: () => 0 },
            fetch: async (_url: string, init: RequestInit) => {
                calls.push(init);
                return {
                    ok: true,
                    json: async () => ({
                        riskConsentVersion: 1,
                        preferences:
                            state === "mobile-auto"
                                ? {
                                      shipping: "home",
                                      payment: "paypal",
                                      autoCheckout: {
                                          currency: "EUR",
                                          warningVersion: 1,
                                          maxTotalMinor: 3000,
                                      },
                                  }
                                : undefined,
                    }),
                };
            },
        });
        await assert.rejects(
            client.openItemCheckout(17, 123),
            /extension|mobile preview/,
        );
        assert.equal(calls.length, 1);
        assert.ok(calls.every((call) => !call.method || call.method === "GET"));
        assert.equal(commands, 0);
        await assert.rejects(client.openItemCheckout(17, 123));
        assert.equal(calls.length, 2);
    });
}
