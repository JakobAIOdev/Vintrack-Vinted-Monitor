import test from "node:test";
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
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

test("telegram webhook rejects updates without a configured, matching secret", async () => {
    let lookups = 0;
    const env: Record<string, string | undefined> = {};
    const route = load(
        "../../src/app/api/telegram/webhook/route.ts",
        {
            "node:crypto": { createHash, timingSafeEqual },
            "next/server": { NextResponse },
            "@/lib/db": {
                db: {
                    telegram_connect_codes: {
                        findFirst: async () => {
                            lookups++;
                            return null;
                        },
                    },
                },
            },
            "@/lib/telegram": {
                escapeTelegramHTML: (value: string) => value,
                sendTelegramMessage: async () => {},
            },
        },
        { process: { env } },
    );
    const update = (secret?: string) =>
        new Request("https://vintrack.test/api/telegram/webhook", {
            method: "POST",
            headers: secret
                ? { "x-telegram-bot-api-secret-token": secret }
                : {},
            body: JSON.stringify({
                message: {
                    text: "/start VT-0000000000000000",
                    chat: { id: 1 },
                },
            }),
        });

    assert.equal((await route.POST(update("anything"))).status, 503);
    env.TELEGRAM_WEBHOOK_SECRET = "   ";
    assert.equal((await route.POST(update("   "))).status, 503);
    env.TELEGRAM_WEBHOOK_SECRET = "synthetic-secret";
    assert.equal((await route.POST(update())).status, 401);
    assert.equal((await route.POST(update("synthetic-secre"))).status, 401);
    assert.equal(lookups, 0);
    assert.equal((await route.POST(update("synthetic-secret"))).status, 200);
    assert.equal(lookups, 1);
});
