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

class NextResponse extends Response {
    static json = Response.json;
}

test("conversation route forwards only numeric ids to the account service", async () => {
    const forwarded: string[] = [];
    const route = load(
        "../../src/app/api/messages/conversations/[id]/route.ts",
        {
            "@/auth": {
                auth: async () => ({ user: { id: "synthetic-member" } }),
            },
            "@/lib/features.server": { guardApiFeature: async () => null },
            "next/server": { NextResponse },
        },
        {
            fetch: async (url: string) => {
                forwarded.push(url);
                return Response.json({ ok: true });
            },
        },
    );
    const call = (id: string) =>
        route.GET(
            { nextUrl: { searchParams: new URLSearchParams("page=2") } },
            { params: Promise.resolve({ id }) },
        );

    for (const id of [
        "../../items/checkout-links",
        "12/../../account/info",
        "12?x=1",
        "",
        "abc",
        "1".repeat(21),
    ])
        assert.equal((await call(id)).status, 400, `id ${JSON.stringify(id)}`);
    assert.equal(forwarded.length, 0);

    assert.equal((await call("12345")).status, 200);
    assert.deepEqual(forwarded, [
        "http://localhost:4000/api/messages/conversations/12345?page=2",
    ]);
});
