import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as checkout from "../../src/lib/checkout.ts";

function harness(domain: string, anonymous = false, denied = false) {
    const writes: unknown[] = [];
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/checkout": checkout,
        "@/lib/checkout-preferences.server": {
            loadCheckoutPreferences: async () =>
                checkout.DEFAULT_CHECKOUT_PREFERENCES,
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
                    async update(query: unknown) {
                        writes.push(query);
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
