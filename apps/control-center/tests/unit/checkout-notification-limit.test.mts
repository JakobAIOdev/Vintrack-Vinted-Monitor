import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Handler = (...args: unknown[]) => Promise<Response>;

function load(
    sourcePath: string,
    modules: Record<string, unknown>,
    globals: Record<string, unknown> = {},
) {
    const exports: Record<string, Handler> = {};
    const source = ts.transpileModule(
        readFileSync(new URL(sourcePath, import.meta.url), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    vm.runInNewContext(source, {
        exports,
        require: (name: string) => {
            assert.ok(name in modules, `unexpected import ${name}`);
            return modules[name];
        },
        process: { env: {} },
        console,
        URL,
        ...globals,
    });
    return exports;
}

test("browser checkout notifications are capped per member and window", async () => {
    const counts = new Map<string, number>();
    const expiries: [string, number][] = [];
    let failing = false;
    const limiter = load(
        "../../src/lib/checkout-notification-limit.server.ts",
        {
            "server-only": {},
            "@/lib/redis": {
                redisClient: () => ({
                    incr: async (key: string) => {
                        if (failing) throw new Error("redis down");
                        const next = (counts.get(key) ?? 0) + 1;
                        counts.set(key, next);
                        return next;
                    },
                    expire: async (key: string, seconds: number) => {
                        expiries.push([key, seconds]);
                    },
                }),
            },
        },
        { console: { error: () => {} } },
    ) as unknown as {
        allowBrowserCheckoutNotification: (id: string) => Promise<boolean>;
    };

    const results: boolean[] = [];
    for (let i = 0; i < 14; i++)
        results.push(await limiter.allowBrowserCheckoutNotification("a"));
    assert.deepEqual(results.slice(0, 12), Array(12).fill(true));
    assert.deepEqual(results.slice(12), [false, false]);
    // The window starts once, on the first report.
    assert.equal(expiries.length, 1);
    assert.equal(expiries[0][1], 3600);
    // Another member has their own budget.
    assert.equal(await limiter.allowBrowserCheckoutNotification("b"), true);
    // A Redis outage must not drop a genuine purchase notification.
    failing = true;
    assert.equal(await limiter.allowBrowserCheckoutNotification("a"), true);
});
