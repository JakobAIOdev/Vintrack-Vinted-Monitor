import test from "node:test";
import assert from "node:assert/strict";
import {
    FEATURE_KEYS,
    USER_ROLES,
    defaultFeaturePolicy,
    resolveFeatureAccess,
    type FeatureKey,
    type FeaturePolicy,
} from "../../src/lib/features.ts";

function policies(
    overrides: Partial<Record<FeatureKey, Partial<FeaturePolicy>>> = {},
) {
    return new Map(
        FEATURE_KEYS.map((feature) => {
            const base = { ...defaultFeaturePolicy(feature), enabled: true };
            const override = overrides[feature] ?? {};
            return [
                feature,
                {
                    ...base,
                    ...override,
                    roles: { ...base.roles, ...override.roles },
                },
            ] as const;
        }),
    );
}

test("every optional feature supports global denial for every fixed role", () => {
    for (const feature of FEATURE_KEYS) {
        const state = policies({ [feature]: { enabled: false } });
        for (const role of USER_ROLES) {
            assert.deepEqual(resolveFeatureAccess(feature, role, state), {
                allowed: false,
                feature,
                reason: "disabled",
            });
        }
    }
});

test("role policy denies only the selected role", () => {
    for (const feature of FEATURE_KEYS) {
        const state = policies({
            [feature]: { roles: { free: false, premium: true, admin: true } },
        });
        assert.equal(
            resolveFeatureAccess(feature, "free", state).allowed,
            false,
        );
        assert.equal(
            resolveFeatureAccess(feature, "premium", state).allowed,
            true,
        );
        assert.equal(
            resolveFeatureAccess(feature, "admin", state).allowed,
            true,
        );
    }
});

test("unknown roles never receive optional feature access", () => {
    for (const feature of FEATURE_KEYS) {
        const access = resolveFeatureAccess(feature, "operator", policies());
        assert.equal(access.allowed, false);
        if (!access.allowed) assert.equal(access.reason, "role_denied");
    }
});

test("linked-account children retain policy but inherit parent denial", () => {
    const state = policies({ vinted_account: { enabled: false } });
    for (const feature of [
        "your_listings",
        "liked_items",
        "chats",
        "offers",
        "checkout_links",
    ] as const) {
        assert.equal(state.get(feature)?.enabled, true);
        const access = resolveFeatureAccess(feature, "premium", state);
        assert.deepEqual(access, {
            allowed: false,
            feature,
            reason: "dependency_disabled",
            dependency: "vinted_account",
        });
    }
});

test("enabled policies allow all fixed roles when dependencies are enabled", () => {
    const state = policies();
    for (const feature of FEATURE_KEYS) {
        for (const role of USER_ROLES) {
            assert.equal(
                resolveFeatureAccess(feature, role, state).allowed,
                true,
            );
        }
    }
});
