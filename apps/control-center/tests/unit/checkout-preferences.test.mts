import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";
import * as proxyValidation from "../../src/lib/custom-proxy-validation.ts";

test("GBP pickup settings preserve their exact limit and require card-specific consent", async () => {
    const preferences = {
        shipping: "pickup",
        payment: "card",
        autoCheckout: {
            warningVersion: 2,
            currency: "GBP",
            maxTotalMinor: 1829,
        },
    };
    const h = harness("www.vinted.co.uk");
    assert.equal(
        ((await h.save(preferences)) as { success?: boolean }).success,
        true,
    );
    const write = JSON.parse(JSON.stringify(h.writes[0]));
    assert.deepEqual(write.data.checkout_preferences.preferences, preferences);
    assert.equal(
        checkout.checkoutPreferencesKey(
            preferences as checkout.CheckoutPreferences,
        ),
        "pickup:card:auto:2:GBP:1829",
    );
    assert.notEqual(
        checkout.checkoutPreferencesKey(
            preferences as checkout.CheckoutPreferences,
        ),
        checkout.checkoutPreferencesKey({
            ...preferences,
            autoCheckout: { ...preferences.autoCheckout, currency: "EUR" },
        } as checkout.CheckoutPreferences),
    );
    assert.ok(
        (
            (await h.save({
                ...preferences,
                autoCheckout: {
                    ...preferences.autoCheckout,
                    warningVersion: 1,
                },
            })) as { error?: string }
        ).error,
    );
    assert.ok(
        (
            (await h.save({
                ...preferences,
                autoCheckout: { ...preferences.autoCheckout, currency: "ZZZ" },
            })) as { error?: string }
        ).error,
    );
    assert.ok(
        (
            (await h.save({ ...preferences, point_uuid: "injected" })) as {
                error?: string;
            }
        ).error,
    );
    assert.equal(h.writes.length, 1);
    assert.equal(
        checkout.autoCheckoutAllowed("www.vinted.co.uk", "paypal"),
        false,
    );
});

function harness(
    domain: string,
    anonymous = false,
    denied = false,
    consentDenied = false,
    proxyOwned = true,
) {
    const writes: unknown[] = [];
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/checkout": checkout,
        "@/lib/custom-proxy-validation": proxyValidation,
        "@/lib/checkout-preferences.server": {
            loadCheckoutPreferences: async () =>
                checkout.DEFAULT_CHECKOUT_PREFERENCES,
            loadCheckoutSettings: async () => ({
                preferences: checkout.DEFAULT_CHECKOUT_PREFERENCES,
                riskConsentVersion: 1,
                checkoutTransport: "browser",
            }),
        },
        "@/lib/checkout-consent.server": {
            guardCheckoutConsent: async () =>
                consentDenied ? Response.json({}, { status: 403 }) : null,
        },
        "@/lib/features.server": {
            getFeatureAccessForUser: async () => ({ allowed: !denied }),
        },
        "next/cache": { revalidatePath() {} },
        "@/lib/db": {
            db: {
                vinted_sessions: {
                    async findUnique(query: {
                        where: { userId: string };
                        select: Record<string, boolean>;
                    }) {
                        assert.equal(query.where.userId, "synthetic-member");
                        assert.deepEqual(Object.keys(query.select).sort(), [
                            "domain",
                            "vinted_user_id",
                        ]);
                        return { vinted_user_id: 42n, domain };
                    },
                },
                user: {
                    async updateMany(query: unknown) {
                        writes.push(query);
                        return { count: 1 };
                    },
                },
                proxy_groups: {
                    async findFirst(query: {
                        where: { id: number; userId: string };
                    }) {
                        assert.equal(query.where.userId, "synthetic-member");
                        return proxyOwned && query.where.id === 7
                            ? { proxies: "http://proxy.example.com:8080" }
                            : null;
                    },
                    async findMany(query: {
                        where: { userId: string };
                        select: unknown;
                    }) {
                        assert.equal(query.where.userId, "synthetic-member");
                        assert.deepEqual(
                            JSON.parse(JSON.stringify(query.select)),
                            { id: true, name: true },
                        );
                        return [{ id: 7, name: "My checkout proxy" }];
                    },
                },
            },
        },
    };
    const output = ts.transpileModule(
        readFileSync(
            new URL(
                "../../src/actions/checkout-preferences.ts",
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
    const exports: Record<string, (...args: unknown[]) => Promise<unknown>> =
        {};
    vm.runInNewContext(output, {
        exports,
        require(name: string) {
            assert.ok(name in modules);
            return modules[name];
        },
    });
    return {
        writes,
        save: exports.saveCheckoutPreferences,
        load: exports.getCheckoutPreferenceSettings,
    };
}

test("the separate auto-payment opt-in cannot replace general checkout risk consent", async () => {
    const h = harness("www.vinted.de", false, false, true);
    assert.ok(
        (
            (await h.save({
                shipping: "home",
                payment: "paypal",
                autoCheckout: {
                    warningVersion: 1,
                    currency: "EUR",
                    maxTotalMinor: 3000,
                },
            })) as { error?: string }
        ).error,
    );
    assert.equal(h.writes.length, 0);
});

test("regional payment saves use the caller's linked account, not supplied region data", async () => {
    for (const [domain, payment] of [
        ["www.vinted.de", "klarna"],
        ["www.vinted.be", "bancontact"],
        ["www.vinted.nl", "ideal"],
        ["www.vinted.pl", "blik"],
    ]) {
        const h = harness(domain);
        assert.equal(
            (
                (await h.save({ shipping: "home", payment })) as {
                    success: boolean;
                }
            ).success,
            true,
        );
        assert.equal(h.writes.length, 1);
        const write = JSON.parse(JSON.stringify(h.writes[0]));
        assert.equal(write.where.id, "synthetic-member");
        assert.equal(write.data.checkout_preferences.domain, domain);
        assert.equal(write.data.checkout_preferences.accountId, 42);
        const settings = JSON.parse(JSON.stringify(await h.load()));
        assert.equal(settings.domain, domain);
    }
});

test("foreign-region payment preferences and injected checkout fields cannot be saved", async () => {
    const h = harness("www.vinted.fr");
    for (const preference of [
        { shipping: "home", payment: "paypal" },
        { shipping: "home", payment: "klarna" },
        { shipping: "home", payment: "google_pay", domain: "www.vinted.de" },
        { shipping: "home", payment: "google_pay", card_id: 55 },
    ])
        assert.ok(((await h.save(preference)) as { error?: string }).error);
    assert.equal(h.writes.length, 0);
});

test("anonymous and feature-denied callers cannot save payment preferences", async () => {
    const anonymous = harness("www.vinted.de", true);
    await assert.rejects(
        anonymous.save({ shipping: "home", payment: "paypal" }),
        /Sign in/,
    );
    const denied = harness("www.vinted.de", false, true);
    assert.ok(
        (
            (await denied.save({ shipping: "home", payment: "paypal" })) as {
                error?: string;
            }
        ).error,
    );
    assert.equal(anonymous.writes.length + denied.writes.length, 0);
});

test("auto-checkout requires a supported linked region, warning version and positive price limit", async () => {
    const setting = { warningVersion: 1, currency: "EUR", maxTotalMinor: 3000 };
    const h = harness("www.vinted.de");
    assert.equal(
        (
            (await h.save({
                shipping: "home",
                payment: "paypal",
                autoCheckout: setting,
            })) as { success: boolean }
        ).success,
        true,
    );
    for (const autoCheckout of [
        { ...setting, warningVersion: 0 },
        { ...setting, maxTotalMinor: 0 },
        { ...setting, maxTotalMinor: 100.5 },
        { ...setting, currency: "ZZZ" },
        { ...setting, bypassWallet: true },
    ])
        assert.ok(
            (
                (await h.save({
                    shipping: "home",
                    payment: "paypal",
                    autoCheckout,
                })) as { error?: string }
            ).error,
        );
    assert.ok(
        (
            (await h.save({
                shipping: "home",
                payment: "card",
                autoCheckout: setting,
            })) as { error?: string }
        ).error,
    );
    const foreign = harness("www.vinted.fr");
    assert.ok(
        (
            (await foreign.save({
                shipping: "home",
                payment: "paypal",
                autoCheckout: setting,
            })) as { error?: string }
        ).error,
    );
    assert.equal(h.writes.length, 1);
    assert.equal(foreign.writes.length, 0);
});

test("saved-card auto-checkout requires its own immediate-charge consent and linked region", async () => {
    const preferences = {
        shipping: "home",
        payment: "card",
        autoCheckout: {
            warningVersion: 2,
            currency: "EUR",
            maxTotalMinor: 3000,
        },
    };
    for (const domain of ["www.vinted.de", "www.vinted.fr", "www.vinted.pl"]) {
        const h = harness(domain);
        assert.equal(
            ((await h.save(preferences)) as { success?: boolean }).success,
            true,
        );
        assert.equal(h.writes.length, 1);
    }
    const denied = harness("www.vinted.fr", false, false, true);
    assert.ok(((await denied.save(preferences)) as { error?: string }).error);
    assert.equal(denied.writes.length, 0);
    for (const warningVersion of [0, 1, 3]) {
        const h = harness("www.vinted.fr");
        assert.ok(
            (
                (await h.save({
                    ...preferences,
                    autoCheckout: {
                        ...preferences.autoCheckout,
                        warningVersion,
                    },
                })) as { error?: string }
            ).error,
        );
        assert.equal(h.writes.length, 0);
    }
    assert.equal(
        checkout.autoCheckoutAllowed("www.vinted.fr.evil.test", "card"),
        false,
    );
    assert.equal(
        checkout.isCheckoutPreferences({ ...preferences, payment: "wallet" }),
        false,
    );
});

test("changing checkout transport requires a separate automatic payment opt-in", async () => {
    const h = harness("www.vinted.de");
    const preferences = {
        shipping: "home",
        payment: "card",
        autoCheckout: {
            warningVersion: 2,
            currency: "EUR",
            maxTotalMinor: 3000,
        },
    };
    assert.ok(
        ((await h.save(preferences, "server")) as { error?: string }).error,
    );
    assert.equal(h.writes.length, 0);
    assert.equal(
        (
            (await h.save(
                { shipping: "home", payment: "card" },
                "server",
                7,
            )) as {
                success?: boolean;
            }
        ).success,
        true,
    );
    const write = JSON.parse(JSON.stringify(h.writes[0]));
    assert.equal(write.data.checkout_preferences.transport, "server");
    assert.equal(write.data.checkout_preferences.proxyGroupId, 7);
    assert.equal(
        write.data.checkout_preferences.preferences.autoCheckout,
        undefined,
    );
    assert.ok(
        (
            (await h.save(
                { shipping: "home", payment: "card" },
                "invalid",
            )) as { error?: string }
        ).error,
    );
    assert.equal(h.writes.length, 1);
});

test("request checkout requires an owned proxy and rejects malformed selections", async () => {
    const preferences = { shipping: "home", payment: "card" };
    for (const id of [undefined, null, 0, -1, 1.5, "7", 99]) {
        const h = harness("www.vinted.de");
        assert.ok(
            ((await h.save(preferences, "server", id)) as { error?: string })
                .error,
        );
        assert.equal(h.writes.length, 0);
    }
    const foreign = harness("www.vinted.de", false, false, false, false);
    assert.ok(
        ((await foreign.save(preferences, "server", 7)) as { error?: string })
            .error,
    );
    assert.equal(foreign.writes.length, 0);
    const browser = harness("www.vinted.de");
    assert.equal(
        ((await browser.save(preferences, "browser")) as { success?: boolean })
            .success,
        true,
    );
});

test("checkout settings expose owned group names without credentials", async () => {
    const h = harness("www.vinted.de");
    const settings = JSON.parse(JSON.stringify(await h.load()));
    assert.deepEqual(settings.proxyGroups, [
        { id: 7, name: "My checkout proxy" },
    ]);
    assert.ok(!JSON.stringify(settings).includes("proxy.example.com"));
});
