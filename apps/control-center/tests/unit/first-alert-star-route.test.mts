import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server.js";
import type { POST } from "../../src/app/api/github-rewards/first-alert/route";

function route(anonymous = false) {
    const calls: { userId: string; action: string }[] = [];
    const modules: Record<string, unknown> = {
        "next/server": { NextResponse },
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "signed-in-member" } },
        },
        "@/lib/first-alert-star.server": {
            claimFirstAlertStarPrompt: async (userId: string) => {
                calls.push({ userId, action: "claim" });
                return { prompt: null, retry: false };
            },
            recordFirstAlertStarAction: async (
                userId: string,
                action: string,
            ) => {
                calls.push({ userId, action });
            },
        },
    };
    const source = ts.transpileModule(
        readFileSync(
            new URL(
                "../../src/app/api/github-rewards/first-alert/route.ts",
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
    const exports = {} as { POST: typeof POST };
    vm.runInNewContext(source, {
        exports,
        URL,
        process: { env: { AUTH_URL: "https://vintrack.test" } },
        require: (name: string) => {
            assert.ok(name in modules, name);
            return modules[name];
        },
    });
    const request = (body: unknown, origin = "https://vintrack.test") =>
        new Request("http://internal:3000/api/github-rewards/first-alert", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: origin },
            body: JSON.stringify(body),
        });
    return { post: exports.POST, calls, request };
}

test("anonymous and foreign-origin requests cannot consume another member's prompt", async () => {
    const anonymous = route(true);
    assert.equal(
        (await anonymous.post(anonymous.request({ action: "claim" }))).status,
        401,
    );
    assert.equal(anonymous.calls.length, 0);
    const foreign = route();
    assert.equal(
        (
            await foreign.post(
                foreign.request(
                    { action: "dismissed" },
                    "https://foreign.test",
                ),
            )
        ).status,
        403,
    );
    assert.equal(foreign.calls.length, 0);
});

test("reverse-proxied requests use the configured origin and the authenticated member", async () => {
    const h = route();
    for (const action of ["claim", "dismissed", "cta"]) {
        assert.equal(
            (await h.post(h.request({ action, userId: "another-member" })))
                .status,
            200,
        );
    }
    assert.deepEqual(
        h.calls,
        ["claim", "dismissed", "cta"].map((action) => ({
            userId: "signed-in-member",
            action,
        })),
    );
    assert.equal((await h.post(h.request({ action: "reset" }))).status, 400);
    assert.equal(h.calls.length, 3);
});
