import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as crypto from "node:crypto";
import { NextResponse } from "next/server.js";
import type { NextAuthConfig } from "next-auth";
import type * as Auth from "../../src/auth";
import type * as AccessServer from "../../src/lib/auth-access.server";
import type * as ExtensionAuth from "../../src/lib/extension-auth.server";
import * as access from "../../src/lib/auth-access.ts";

function harness(environment: Record<string, string | undefined> = {}) {
    const accounts = new Map<string, access.AuthIdentity[]>([
        ["owner", [{ provider: "discord", providerAccountId: "123" }]],
        ["other", [{ provider: "discord", providerAccountId: "456" }]],
        ["oidc-owner", [{ provider: "oidc", providerAccountId: "owner-sub" }]],
        ["github-only", [{ provider: "github", providerAccountId: "123" }]],
    ]);
    let identityQueries = 0;
    let linkedUser = "owner";
    let extensionUpdates = 0;
    let config: NextAuthConfig | undefined;
    const token = "a".repeat(32);
    const session = (userId: string) => ({
        sessionToken: "synthetic-session",
        userId,
        expires: new Date(Date.now() + 60000),
    });
    const db = {
        account: {
            findMany: async ({ where }: { where: { userId: string } }) => {
                identityQueries++;
                return accounts.get(where.userId) ?? [];
            },
        },
        session: { findUnique: async () => session(linkedUser) },
        $queryRaw: async () => [
            {
                userId: linkedUser,
                token_hash: crypto
                    .createHash("sha256")
                    .update(token)
                    .digest("hex"),
            },
        ],
        $executeRaw: async () => {
            extensionUpdates++;
        },
    };
    const policy = {
        isInstanceAccessRestricted: () =>
            access.isInstanceAccessRestricted(environment),
        isInstanceAccountAllowed: (account: access.AuthIdentity | null) =>
            access.isInstanceAccountAllowed(account, environment),
    };
    const modules: Record<string, unknown> = {
        "server-only": {},
        "@/lib/db": { db },
        "@/lib/auth-access": policy,
        "next-auth": {
            default: (value: NextAuthConfig) => {
                config = value;
                return { auth: async () => null };
            },
        },
        react: { cache: (fn: unknown) => fn },
        "next/headers": {
            cookies: async () => ({
                getAll: () => [
                    {
                        name: "authjs.session-token",
                        value: "synthetic-session",
                    },
                ],
            }),
        },
        "next-auth/providers/discord": { default: () => ({ id: "discord" }) },
        "next-auth/providers/github": { default: () => ({ id: "github" }) },
        "@auth/prisma-adapter": {
            PrismaAdapter: () => ({
                getSessionAndUser: async (userId: string) => ({
                    session: session(userId),
                    user: {
                        id: userId,
                        email: null,
                        emailVerified: null,
                        role: "admin",
                    },
                }),
            }),
        },
        "@/lib/auth-provider": { oidcConfigured: false },
        "@/lib/github-rewards.server": {},
        "@/lib/github-account-linking.server": {
            prepareGithubAccountLink: async () => ({ ok: true }),
        },
        "@/lib/free-proxy-limit-reconciliation.server": {},
        "@/lib/deployment-config.server": {
            assertControlCenterProductionConfig: () => {},
        },
        "node:crypto": crypto,
        "next/server": { NextResponse },
    };
    function load<T>(path: string): T {
        const exports = {};
        const output = ts.transpileModule(
            readFileSync(new URL(path, import.meta.url), "utf8"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                },
            },
        ).outputText;
        vm.runInNewContext(output, {
            exports,
            process: { env: environment },
            Buffer,
            console,
            require: (name: string) => {
                assert.ok(name in modules, `Unexpected import ${name}`);
                return modules[name];
            },
        });
        return exports as T;
    }
    const accessServer = load<typeof AccessServer>(
        "../../src/lib/auth-access.server.ts",
    );
    modules["@/lib/auth-access.server"] = accessServer;
    const auth = load<typeof Auth>("../../src/auth.ts");
    const extension = load<typeof ExtensionAuth>(
        "../../src/lib/extension-auth.server.ts",
    );
    return {
        auth,
        accessServer,
        config: config!,
        accounts,
        identityQueries: () => identityQueries,
        extensionUpdates: () => extensionUpdates,
        setUser: (userId: string) => {
            linkedUser = userId;
        },
        extensionRequest: () =>
            extension.authenticateExtensionRequest(
                new Request("https://vintrack.example/api/extension", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            ),
        signIn: (provider: string, providerAccountId: string) =>
            config!.callbacks!.signIn!({
                user: { id: "synthetic-user" },
                account: { provider, providerAccountId, type: "oauth" },
                profile: {},
            }),
    };
}

test("default production login, sessions and extension tokens need no additional database queries", async () => {
    const h = harness({
        NODE_ENV: "production",
        AUTH_ALLOWED_DISCORD_IDS: "",
        AUTH_ALLOWED_OIDC_SUBJECTS: "",
    });
    assert.equal(await h.signIn("discord", "any-user"), true);
    assert.equal(await h.signIn("oidc", "any-user"), true);
    assert.ok(await h.config.adapter!.getSessionAndUser!("other"));
    h.setUser("other");
    assert.equal((await h.extensionRequest()).ok, true);
    assert.equal(h.identityQueries(), 0);
});

test("new logins require a listed primary identity", async () => {
    const h = harness({ AUTH_ALLOWED_DISCORD_IDS: "123" });
    assert.equal(await h.signIn("discord", "123"), true);
    assert.equal(await h.signIn("discord", "456"), false);
    assert.equal(await h.signIn("oidc", "123"), false);
});

test("existing sessions are rechecked and admin role cannot bypass restriction", async () => {
    const h = harness({ AUTH_ALLOWED_DISCORD_IDS: "123" });
    assert.ok(await h.config.adapter!.getSessionAndUser!("owner"));
    assert.equal(await h.config.adapter!.getSessionAndUser!("other"), null);
    assert.equal(
        await h.config.adapter!.getSessionAndUser!("github-only"),
        null,
    );
    h.accounts.set("owner", []);
    assert.equal(await h.config.adapter!.getSessionAndUser!("owner"), null);
});

test("existing OIDC sessions are allowed by exact subject", async () => {
    const h = harness({ AUTH_ALLOWED_OIDC_SUBJECTS: "owner-sub" });
    assert.equal(await h.signIn("oidc", "owner-sub"), true);
    assert.ok(await h.config.adapter!.getSessionAndUser!("oidc-owner"));
    assert.equal(await h.config.adapter!.getSessionAndUser!("owner"), null);
});

test("GitHub linking requires an allowed existing user", async () => {
    const h = harness({ AUTH_ALLOWED_DISCORD_IDS: "123" });
    assert.equal(await h.signIn("github", "789"), true);
    h.setUser("other");
    assert.match(String(await h.signIn("github", "789")), /session_missing/);
});

test("excluded users cannot use previously issued extension tokens", async () => {
    const h = harness({ AUTH_ALLOWED_DISCORD_IDS: "123" });
    assert.equal((await h.extensionRequest()).ok, true);
    assert.equal(h.extensionUpdates(), 1);
    h.setUser("other");
    const result = await h.extensionRequest();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
    assert.equal(h.extensionUpdates(), 1);
});

test("demo authentication is unchanged without a configured allowlist", async () => {
    const h = harness({
        E2E_TEST_MODE: "true",
        E2E_TEST_USER_ID: "demo-user",
        AUTH_ALLOWED_DISCORD_IDS: "",
        AUTH_ALLOWED_OIDC_SUBJECTS: "",
    });
    assert.equal((await h.auth.auth())?.user?.id, "demo-user");
    assert.equal(h.identityQueries(), 0);
});

test("demo authentication cannot bypass an explicitly configured allowlist", async () => {
    const h = harness({
        E2E_TEST_MODE: "true",
        AUTH_ALLOWED_DISCORD_IDS: "123",
    });
    assert.equal(await h.auth.auth(), null);
});
