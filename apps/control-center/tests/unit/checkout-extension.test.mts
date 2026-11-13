import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

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

test("cold extension receiver responding after 900ms is accepted and all resources are cleaned", async () => {
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

for (const accepted of [false, true]) {
    test(`checkout context consent ${accepted ? "dispatches only the approved metadata" : "cancellation reads and sends nothing"}`, async () => {
        const messages: unknown[] = [];
        const client = compile("../../src/lib/vintrack-extension.ts", {
            window: {
                location: { origin: "https://vintrack.example.test" },
                postMessage: (message: unknown, origin: string) => {
                    assert.equal(origin, "https://vintrack.example.test");
                    messages.push(JSON.parse(JSON.stringify(message)));
                },
            },
        });
        assert.equal(
            await client.requestCheckoutContextSync("www.vinted.de", accepted),
            accepted,
        );
        assert.deepEqual(
            messages,
            accepted
                ? [
                      {
                          type: "VINTRACK_EXTENSION_MANUAL_SYNC",
                          payload: {
                              preferredDomain: "www.vinted.de",
                              includeCheckoutContext: true,
                              checkoutContextConsent: 2,
                          },
                      },
                  ]
                : [],
        );
    });
}

function revokeBridge() {
    const timers = new Map<number, () => void>();
    const listeners = new Set<(event: unknown) => void>();
    const posts: unknown[] = [];
    let id = 0;
    const window = {
        location: { origin: "https://vintrack.example.test" },
        setTimeout(fn: () => void, delay: number) {
            assert.equal(delay, 5000);
            timers.set(++id, fn);
            return id;
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
        postMessage(message: unknown, origin: string) {
            assert.equal(origin, window.location.origin);
            posts.push(JSON.parse(JSON.stringify(message)));
        },
    };
    const client = compile("../../src/lib/vintrack-extension.ts", { window });
    return {
        revoke: () => client.revokeCheckoutContextSync() as Promise<boolean>,
        posts,
        timers,
        listeners,
        reply(
            payload: Record<string, unknown>,
            overrides: Record<string, unknown> = {},
        ) {
            for (const listener of [...listeners])
                listener({
                    source: window,
                    origin: window.location.origin,
                    data: {
                        type: "VINTRACK_EXTENSION_REVOKE_CHECKOUT_CONTEXT_RESULT",
                        payload,
                    },
                    ...overrides,
                });
        },
    };
}

test("background checkout context flag is read only from an explicit boolean", () => {
    const client = compile(
        "../../src/lib/vintrack-extension.ts",
    ) as unknown as {
        readCheckoutContextBackgroundSync(payload: unknown): boolean | null;
    };
    for (const [payload, expected] of [
        [{ checkoutContextBackgroundSync: true }, true],
        [{ checkoutContextBackgroundSync: false }, false],
        [{ checkoutContextBackgroundSync: "true" }, null],
        [{ checkoutContextBackgroundSync: 1 }, null],
        [{ configured: true }, null],
        [null, null],
        [undefined, null],
    ] as const) {
        assert.equal(
            client.readCheckoutContextBackgroundSync(payload),
            expected,
            JSON.stringify(payload),
        );
    }
});

test("checkout context revoke sends one bare message and resolves once the extension confirms", async () => {
    const h = revokeBridge();
    const result = h.revoke();
    assert.deepEqual(h.posts, [
        { type: "VINTRACK_EXTENSION_REVOKE_CHECKOUT_CONTEXT" },
    ]);
    const confirmed = { ok: true, checkoutContextBackgroundSync: false };
    h.reply(confirmed, { source: {} });
    h.reply(confirmed, { origin: "https://foreign.test" });
    assert.equal(h.listeners.size, 1);
    h.reply(confirmed);
    assert.equal(await result, true);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
});

for (const [name, payload] of [
    ["an unauthorized reply", { ok: false, error: "Unauthorized" }],
    [
        "a reply that still reports background sync",
        { ok: true, checkoutContextBackgroundSync: true },
    ],
    ["a reply without the status flag", { ok: true }],
] as const) {
    test(`checkout context revoke is not confirmed by ${name}`, async () => {
        const h = revokeBridge();
        const result = h.revoke();
        h.reply(payload);
        assert.equal(await result, false);
        assert.equal(h.listeners.size, 0);
        assert.equal(h.timers.size, 0);
    });
}

test("checkout context revoke gives up without an extension reply or a window", async () => {
    const h = revokeBridge();
    const result = h.revoke();
    assert.equal(h.timers.size, 1);
    for (const expire of [...h.timers.values()]) expire();
    assert.equal(await result, false);
    assert.equal(h.listeners.size, 0);

    const server = compile("../../src/lib/vintrack-extension.ts");
    assert.equal(await server.revokeCheckoutContextSync(), false);
});
