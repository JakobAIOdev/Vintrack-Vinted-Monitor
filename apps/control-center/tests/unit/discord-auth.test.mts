import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import Discord from "next-auth/providers/discord";
import { validateAuthResponse, skipStateCheck } from "oauth4webapi";
import type { NextAuthConfig } from "next-auth";

function discordProvider() {
    let config: NextAuthConfig | undefined;
    const modules: Record<string, unknown> = {
        "next-auth": {
            default: (value: NextAuthConfig) => {
                config = value;
                return {};
            },
        },
        react: { cache: (value: unknown) => value },
        "next/headers": {},
        "next-auth/providers/discord": { default: Discord },
        "next-auth/providers/github": {},
        "@auth/prisma-adapter": { PrismaAdapter: () => ({}) },
        "@/lib/db": { db: {} },
        "@/lib/auth-provider": { oidcConfigured: false },
        "@/lib/github-rewards.server": {},
        "@/lib/github-account-linking.server": {},
        "@/lib/free-proxy-limit-reconciliation.server": {},
        "@/lib/deployment-config.server": {
            assertControlCenterProductionConfig: () => {},
        },
    };
    const output = ts.transpileModule(
        readFileSync(new URL("../../src/auth.ts", import.meta.url), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    vm.runInNewContext(output, {
        exports: {},
        process: { env: {} },
        require: (name: string) => {
            assert.ok(name in modules, `Unexpected import ${name}`);
            return modules[name];
        },
    });
    const entry = config!.providers[0];
    const provider = typeof entry === "function" ? entry() : entry;
    assert.equal(provider.id, "discord");
    assert.ok(provider.type === "oauth" || provider.type === "oidc");
    return { ...provider, ...provider.options };
}

test("Discord callback accepts its published issuer", () => {
    const provider = discordProvider();
    const callback = new URLSearchParams({
        code: "synthetic-authorization-code",
        iss: "https://discord.com",
    });

    const result = validateAuthResponse(
        { issuer: provider.issuer ?? "https://authjs.dev" },
        { client_id: "synthetic-client" },
        callback,
        skipStateCheck,
    );

    assert.equal(result.get("code"), "synthetic-authorization-code");
});

test("Discord callback still rejects a different issuer", () => {
    const provider = discordProvider();

    assert.throws(
        () =>
            validateAuthResponse(
                { issuer: provider.issuer ?? "https://authjs.dev" },
                { client_id: "synthetic-client" },
                new URLSearchParams({
                    code: "synthetic-code",
                    iss: "https://other.example",
                }),
                skipStateCheck,
            ),
        /unexpected "iss" \(issuer\) response parameter value/,
    );
});
