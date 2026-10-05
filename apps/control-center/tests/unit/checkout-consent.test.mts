import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as consent from "../../src/lib/checkout-consent.ts";

function harness({
    anonymous = false,
    denied = false,
    storageFailure = false,
} = {}) {
    const writes: {
        where: { id: string };
        data: {
            checkout_risk_version: number;
            checkout_risk_accepted_at: Date;
        };
    }[] = [];
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/features.server": {
            guardApiFeature: async () =>
                denied ? Response.json({}, { status: 403 }) : null,
        },
        "@/lib/checkout-consent": consent,
        "@/lib/db": {
            db: {
                user: {
                    update: async (write: (typeof writes)[number]) => {
                        if (storageFailure)
                            throw new Error("synthetic private storage error");
                        writes.push(write);
                    },
                },
            },
        },
        "next/server": { NextResponse: { json: Response.json } },
    };
    const exports: { POST?: (request: Request) => Promise<Response> } = {};
    const source = ts.transpileModule(
        readFileSync(
            new URL(
                "../../src/app/api/checkout/consent/route.ts",
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
    ).outputText;
    vm.runInNewContext(source, {
        exports,
        require: (name: string) => {
            assert.ok(name in modules);
            return modules[name];
        },
        URL,
        Date,
        process: { env: { AUTH_URL: "https://vintrack.example.test" } },
    });
    return {
        writes,
        call: (body: unknown, headers: HeadersInit = {}) =>
            exports.POST!(
                Object.assign(
                    new Request(
                        "https://vintrack.example.test/api/checkout/consent",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                ...headers,
                            },
                            body: JSON.stringify(body),
                        },
                    ),
                    {
                        nextUrl: new URL(
                            "https://vintrack.example.test/api/checkout/consent",
                        ),
                    },
                ),
            ),
    };
}

test("checkout consent requires an authenticated explicit current-version acceptance", async () => {
    for (const body of [
        null,
        {},
        { version: 1, accepted: false },
        { version: "1", accepted: true },
        { version: 0, accepted: true },
        { version: 1, accepted: true, userId: "another-member" },
    ]) {
        const h = harness();
        assert.equal((await h.call(body)).status, 400);
        assert.equal(h.writes.length, 0);
    }
    for (const [options, headers, expected] of [
        [{ anonymous: true }, {}, 401],
        [{ denied: true }, {}, 403],
        [{}, { origin: "https://attacker.example.test" }, 403],
        [{}, { "sec-fetch-site": "cross-site" }, 403],
    ] as const) {
        const h = harness(options);
        assert.equal(
            (await h.call({ version: 1, accepted: true }, headers)).status,
            expected,
        );
        assert.equal(h.writes.length, 0);
    }
});

test("consent records only the signed-in user, current text version and server timestamp", async () => {
    const h = harness();
    const response = await h.call(
        { version: 1, accepted: true },
        { origin: "https://vintrack.example.test" },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, version: 1 });
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].where.id, "synthetic-member");
    assert.equal(h.writes[0].data.checkout_risk_version, 1);
    assert.ok(h.writes[0].data.checkout_risk_accepted_at instanceof Date);
});

test("storage errors never acknowledge acceptance or expose private diagnostics", async () => {
    const h = harness({ storageFailure: true });
    const response = await h.call({ version: 1, accepted: true });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("synthetic private"));
    assert.equal(h.writes.length, 0);
});

test("legacy buy, warmup and saved-link endpoints enforce persisted consent before forwarding", async () => {
    for (const [path, methods] of [
        ["buy", ["POST"]],
        ["buy/warm", ["POST"]],
        ["checkout-links", ["GET", "POST"]],
    ] as const) {
        for (const accepted of [false, true]) {
            let forwards = 0;
            const modules: Record<string, unknown> = {
                "server-only": {},
                "@/auth": {
                    auth: async () => ({ user: { id: "synthetic-member" } }),
                },
                "@/lib/features.server": { guardApiFeature: async () => null },
                "@/lib/checkout-consent": consent,
                "@/lib/db": {
                    db: {
                        user: {
                            findUnique: async ({
                                where,
                            }: {
                                where: { id: string };
                            }) => {
                                assert.equal(where.id, "synthetic-member");
                                return {
                                    checkout_risk_version: accepted ? 1 : 0,
                                    checkout_risk_accepted_at: accepted
                                        ? new Date()
                                        : null,
                                };
                            },
                        },
                    },
                },
                "@/lib/audit": { logAuditEvent: async () => {} },
                "next/server": { NextResponse: { json: Response.json } },
            };
            function load(sourcePath: string) {
                const exports: Record<
                    string,
                    (request: Request) => Promise<Response>
                > = {};
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
                        assert.ok(name in modules);
                        return modules[name];
                    },
                    process: { env: {} },
                    fetch: async () => {
                        forwards++;
                        return Response.json({ links: [] });
                    },
                });
                return exports;
            }
            modules["@/lib/checkout-consent.server"] = load(
                "../../src/lib/checkout-consent.server.ts",
            );
            const route = load(`../../src/app/api/items/${path}/route.ts`);
            for (const method of methods) {
                const response = await route[method](
                    new Request(
                        `https://vintrack.example.test/api/items/${path}`,
                        {
                            method,
                            ...(method === "POST" ? { body: "{}" } : {}),
                        },
                    ),
                );
                assert.equal(response.status, accepted ? 200 : 403);
                if (!accepted)
                    assert.equal(
                        (await response.json()).code,
                        "CHECKOUT_CONSENT_REQUIRED",
                    );
            }
            assert.equal(forwards, accepted ? methods.length : 0);
        }
    }
});
