import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(
    anonymous = false,
    upstream: unknown = { available: true },
    upstreamFetch?: (url: string, init: RequestInit) => Promise<Response>,
) {
    const afterTasks: (() => Promise<void>)[] = [];
    const notifications: unknown[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    class NextResponse extends Response {
        static json = Response.json;
    }
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "next/server": {
            NextResponse,
            after: (task: () => Promise<void>) => afterTasks.push(task),
        },
        "@/lib/checkout-notifications.server": {
            queueCheckoutNotification: async (notice: unknown) => {
                notifications.push(notice);
            },
        },
    };
    const exports: Record<string, (...args: unknown[]) => Promise<Response>> =
        {};
    vm.runInNewContext(
        ts.transpileModule(
            readFileSync(
                new URL(
                    "../../src/app/api/checkout-agent/[...path]/route.ts",
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
            URL,
            Buffer,
            Uint8Array,
            AbortSignal,
            process: { env: { AUTH_URL: "https://vintrack.example.test" } },
            fetch: async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                if (upstreamFetch) return upstreamFetch(url, init);
                return Response.json(upstream);
            },
        },
    );
    return {
        calls,
        afterTasks,
        notifications,
        call: (
            operation: string,
            method = "POST",
            headers: Record<string, string> = {},
            body = "{}",
            signal?: AbortSignal,
        ) => {
            const request = Object.assign(
                new Request(
                    `https://vintrack.example.test/api/checkout-agent/${operation}`,
                    {
                        method,
                        headers,
                        ...(method === "POST" ? { body } : {}),
                        ...(signal ? { signal } : {}),
                    },
                ),
                { nextUrl: new URL("http://internal-next:3000") },
            );
            return exports[method](request, {
                params: Promise.resolve({ path: operation.split("/") }),
            });
        },
    };
}

test("agent public endpoints cannot inherit browser identity, cookies or member headers", async () => {
    const h = harness();
    const token = "a".repeat(64);
    const response = await h.call("next", "POST", {
        authorization: `Bearer ${token}`,
        "X-User-ID": "victim-member",
        cookie: "session=must-not-forward",
    });
    assert.equal(response.status, 200);
    const headers = h.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(headers["X-User-ID"], undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(h.calls[0].init.redirect, "error");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("browser-origin agent calls and missing device credentials are rejected before forwarding", async () => {
    for (const headers of [
        {
            origin: "https://evil.test",
            authorization: `Bearer ${"a".repeat(64)}`,
        },
        {},
    ] as Record<string, string>[]) {
        const h = harness();
        const response = await h.call("next", "POST", headers);
        assert.ok([401, 403].includes(response.status));
        assert.equal(h.calls.length, 0);
    }
});

test("pairing and revocation use the authenticated member and enforce the write origin", async () => {
    const h = harness();
    const response = await h.call("pair-code", "POST", {
        origin: "https://vintrack.example.test",
        "X-User-ID": "victim",
    });
    assert.equal(response.status, 200);
    assert.equal(
        (h.calls[0].init.headers as Record<string, string>)["X-User-ID"],
        "synthetic-member",
    );
    const denied = harness();
    assert.equal(
        (await denied.call("revoke", "POST", { origin: "https://evil.test" }))
            .status,
        403,
    );
    assert.equal(denied.calls.length, 0);
});

test("anonymous callers cannot read agent jobs or issue pairing codes", async () => {
    const h = harness(true);
    assert.equal((await h.call(`jobs/${"a".repeat(64)}`, "GET")).status, 401);
    assert.equal((await h.call("pair-code")).status, 401);
    assert.equal(h.calls.length, 0);
});

test("agent proxy allowlist and request limits reject unrelated paths, writes and oversized data", async () => {
    const h = harness();
    assert.equal((await h.call("../account/status")).status, 404);
    assert.equal((await h.call("status")).status, 405);
    assert.equal(
        (await h.call("pair", "POST", {}, "a".repeat(65 * 1024))).status,
        413,
    );
    assert.equal(h.calls.length, 0);
});

test("completed agent jobs defer the existing notification without forwarding a payment URL", async () => {
    const h = harness(false, {
        state: "complete",
        stopped_before_payment: false,
        result: {
            payment_url: "https://www.paypal.com/checkoutnow?token=private",
        },
        notification: {
            itemId: 123,
            monitorId: 17,
            transactionId: 88,
            purchaseId: "synthetic",
            domain: "www.vinted.de",
            status: "card_payment_confirmed",
            method: "full_checkout",
            payment: "card",
        },
    });
    assert.equal((await h.call(`jobs/${"a".repeat(64)}`, "GET")).status, 200);
    assert.equal(h.afterTasks.length, 1);
    await h.afterTasks[0]();
    assert.equal(h.notifications.length, 1);
    assert.doesNotMatch(
        JSON.stringify(h.notifications),
        /private|payment_url|paymentUrl/,
    );
});

test("an abandoned long poll cancels its upstream request; other device calls do not follow the caller", async () => {
    const token = "a".repeat(64);
    // Resolves only when the proxy aborts the upstream request.
    const pending = (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
            );
        });
    const h = harness(false, {}, pending);
    const agent = new AbortController();
    const poll = h.call(
        "next",
        "POST",
        { authorization: `Bearer ${token}` },
        "null",
        agent.signal,
    );
    while (h.calls.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 1));
    const upstream = h.calls[0].init.signal as AbortSignal;
    assert.equal(upstream.aborted, false);
    agent.abort();
    assert.equal(upstream.aborted, true);
    assert.equal((await poll).status, 503);

    // A checkpoint may report a payment outcome while its agent is stopping.
    // It must reach the coordinator even if the caller goes away.
    const checkpoint = harness();
    const stopping = new AbortController();
    const sent = checkpoint.call(
        "checkpoint",
        "POST",
        { authorization: `Bearer ${token}` },
        "{}",
        stopping.signal,
    );
    assert.equal((await sent).status, 200);
    stopping.abort();
    assert.equal(
        (checkpoint.calls[0].init.signal as AbortSignal).aborted,
        false,
    );
});
