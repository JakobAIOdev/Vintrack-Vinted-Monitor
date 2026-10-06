import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as features from "../../src/lib/features.ts";
import * as checkout from "../../src/lib/checkout.ts";

function harness({
    enabled = false,
    denied = false,
    accepted = true,
    anonymous = false,
    userLookup = undefined as (() => Promise<void>) | undefined,
    policyLookup = undefined as (() => void) | undefined,
} = {}) {
    const writes: unknown[] = [];
    const user = { role: "free", checkout_enabled: enabled };
    const modules: Record<string, unknown> = {
        "server-only": {},
        react: { cache: (fn: unknown) => fn },
        "@/lib/features": features,
        "@/lib/checkout": checkout,
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "next/cache": { revalidatePath() {} },
        "@/lib/checkout-consent.server": {
            guardCheckoutConsent: async () =>
                accepted ? null : Response.json({}, { status: 403 }),
        },
        "@/lib/checkout-preferences.server": {
            loadCheckoutSettings: async () => ({}),
            loadCheckoutPreferences: async () =>
                checkout.DEFAULT_CHECKOUT_PREFERENCES,
        },
    };
    const db = {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                assert.equal(where.id, "synthetic-member");
                if (userLookup) await userLookup();
                return user;
            },
            updateMany: async (query: {
                where: { id: string; checkout_enabled: boolean };
            }) => {
                assert.equal(query.where.id, "synthetic-member");
                if (user.checkout_enabled !== query.where.checkout_enabled)
                    return { count: 0 };
                writes.push(query);
                return { count: 1 };
            },
        },
        vinted_sessions: {
            findUnique: async () => ({
                vinted_user_id: 42n,
                domain: "www.vinted.de",
            }),
        },
        feature_policies: {
            findMany: async () => {
                policyLookup?.();
                return features.FEATURE_KEYS.map((feature) => ({
                    feature,
                    enabled: !denied || feature !== "checkout_links",
                    free_enabled: true,
                    premium_enabled: true,
                    admin_enabled: true,
                    revision: 1,
                    updated_at: new Date(),
                }));
            },
        },
        $transaction: async (fn: (tx: unknown) => Promise<void>) =>
            fn({
                user: {
                    update: async (query: {
                        where: { id: string };
                        data: { checkout_enabled: boolean };
                    }) => {
                        assert.equal(query.where.id, "synthetic-member");
                        user.checkout_enabled = query.data.checkout_enabled;
                        writes.push(query);
                    },
                },
                $executeRaw: async (
                    strings: TemplateStringsArray,
                    id: string,
                ) => {
                    assert.equal(id, "synthetic-member");
                    assert.match(strings.join("?"), /preferences,autoCheckout/);
                    writes.push("disarmed auto-checkout");
                },
            }),
    };
    modules["@/lib/db"] = { db };
    function load(path: string) {
        const exports: Record<
            string,
            (...args: unknown[]) => Promise<unknown>
        > = {};
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
            require: (name: string) => {
                assert.ok(name in modules, `Unexpected import ${name}`);
                return modules[name];
            },
            Response,
        });
        return exports;
    }
    const access = load("../../src/lib/features.server.ts");
    modules["@/lib/features.server"] = access;
    const actions = load("../../src/actions/checkout-preferences.ts");
    return { writes, user, access, actions };
}

test("personal checkout off denies all checkout routes while consent remains reachable under admin policy", async () => {
    const h = harness();
    for (const feature of ["checkout_links", "offers"]) {
        const response = (await h.access.guardApiFeature(
            "synthetic-member",
            feature,
        )) as Response | null;
        assert.equal(
            response?.status ?? 200,
            feature === "checkout_links" ? 403 : 200,
        );
        if (response)
            assert.equal((await response.json()).reason, "user_disabled");
    }
    assert.equal(
        await h.access.guardApiFeature(
            "synthetic-member",
            "checkout_links",
            true,
        ),
        null,
    );
    const capabilities = (await h.access.getFeatureCapabilities(
        "free",
        false,
    )) as Record<string, { allowed: boolean }>;
    assert.equal(capabilities.checkout_links.allowed, false);
    assert.equal(capabilities.offers.allowed, true);
    for (const enabled of [false, true]) {
        const denied = harness({ enabled, denied: true });
        assert.equal(
            (
                (await denied.access.guardApiFeature(
                    "synthetic-member",
                    "checkout_links",
                    true,
                )) as Response
            ).status,
            403,
        );
    }
});

test("enabling checkout requires authentication, consent and admin access", async () => {
    for (const options of [
        { anonymous: true },
        { accepted: false },
        { denied: true },
    ]) {
        const h = harness(options);
        const result = (await h.actions
            .setCheckoutModuleEnabled(true)
            .catch(() => ({ error: "Sign in" }))) as { error?: string };
        assert.ok(result.error);
        assert.equal(h.writes.length, 0);
        assert.equal(h.user.checkout_enabled, false);
    }
    const h = harness();
    assert.ok(
        (
            (await h.actions.setCheckoutModuleEnabled("true")) as {
                error?: string;
            }
        ).error,
    );
    assert.equal(h.writes.length, 0);
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(await h.actions.setCheckoutModuleEnabled(true)),
        ),
        { success: true },
    );
    assert.equal(h.user.checkout_enabled, true);
    assert.equal(h.writes[1], "disarmed auto-checkout");
});

test("disabling stays available without admin access or consent and disarms saved auto-payment", async () => {
    const h = harness({ enabled: true, denied: true, accepted: false });
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(await h.actions.setCheckoutModuleEnabled(false)),
        ),
        { success: true },
    );
    assert.equal(h.user.checkout_enabled, false);
    assert.equal(h.writes[1], "disarmed auto-checkout");
});

test("payment preferences cannot rearm a module disabled while settings were being saved", async () => {
    const h = harness({ enabled: true });
    // Model the off transition occurring just after the authorization query.
    const original = h.access.getFeatureAccessForUser;
    h.access.getFeatureAccessForUser = async (...args) => {
        const result = await original(...args);
        h.user.checkout_enabled = false;
        return result;
    };
    const result = (await h.actions.saveCheckoutPreferences({
        shipping: "home",
        payment: "wallet",
    })) as { error?: string };
    assert.ok(result.error);
    assert.equal(h.writes.length, 0);
});

test("feature policies load while the member lookup is pending", async () => {
    let releaseUser!: () => void;
    const userPending = new Promise<void>((resolve) => {
        releaseUser = resolve;
    });
    let policyStarted = false;
    const h = harness({
        userLookup: () => userPending,
        policyLookup: () => {
            policyStarted = true;
        },
    });
    const access = h.access.guardApiFeature(
        "synthetic-member",
        "checkout_links",
    );
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(policyStarted, true);
    } finally {
        releaseUser();
    }
    assert.equal(((await access) as Response).status, 403);
});
