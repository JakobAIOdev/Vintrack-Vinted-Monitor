import test from "node:test";
import assert from "node:assert/strict";
import {
    isInstanceAccessRestricted,
    isInstanceAccountAllowed,
} from "../../src/lib/auth-access.ts";

test("missing, empty and whitespace-only lists preserve public/demo login", () => {
    for (const environment of [
        {},
        { AUTH_ALLOWED_DISCORD_IDS: "", AUTH_ALLOWED_OIDC_SUBJECTS: "" },
        { AUTH_ALLOWED_DISCORD_IDS: "  ", AUTH_ALLOWED_OIDC_SUBJECTS: "\t" },
    ]) {
        assert.equal(isInstanceAccessRestricted(environment), false);
        for (const provider of ["discord", "oidc"]) {
            assert.equal(
                isInstanceAccountAllowed(
                    {
                        provider,
                        providerAccountId: "any-account",
                    },
                    environment,
                ),
                true,
            );
        }
    }
});

test("Discord allowlist matches complete IDs and tolerates surrounding whitespace", () => {
    const environment = {
        AUTH_ALLOWED_DISCORD_IDS: " 123456789012345678, ,234567890123456789 ",
    };
    assert.equal(isInstanceAccessRestricted(environment), true);
    for (const id of ["123456789012345678", "234567890123456789"]) {
        assert.equal(
            isInstanceAccountAllowed(
                { provider: "discord", providerAccountId: id },
                environment,
            ),
            true,
        );
    }
    for (const id of [
        "12345678901234567",
        "1234567890123456789",
        "",
        "other",
    ]) {
        assert.equal(
            isInstanceAccountAllowed(
                { provider: "discord", providerAccountId: id },
                environment,
            ),
            false,
        );
    }
});

test("restriction cannot be bypassed through another provider or missing identity", () => {
    const environment = { AUTH_ALLOWED_DISCORD_IDS: "123" };
    for (const provider of ["oidc", "github", "credentials"]) {
        assert.equal(
            isInstanceAccountAllowed(
                { provider, providerAccountId: "123" },
                environment,
            ),
            false,
        );
    }
    assert.equal(isInstanceAccountAllowed(null, environment), false);
    assert.equal(isInstanceAccountAllowed(undefined, environment), false);
});

test("OIDC subjects match exactly and remain scoped to their provider", () => {
    const environment = {
        AUTH_ALLOWED_OIDC_SUBJECTS: "Admin,issuer-subject-2",
    };
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "oidc", providerAccountId: "Admin" },
            environment,
        ),
        true,
    );
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "oidc", providerAccountId: "admin" },
            environment,
        ),
        false,
    );
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "discord", providerAccountId: "Admin" },
            environment,
        ),
        false,
    );
});

test("both lists can be configured without permitting other accounts", () => {
    const environment = {
        AUTH_ALLOWED_DISCORD_IDS: "123",
        AUTH_ALLOWED_OIDC_SUBJECTS: "owner",
    };
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "discord", providerAccountId: "123" },
            environment,
        ),
        true,
    );
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "oidc", providerAccountId: "owner" },
            environment,
        ),
        true,
    );
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "oidc", providerAccountId: "123" },
            environment,
        ),
        false,
    );
});

test("separator-only configuration fails closed", () => {
    const environment = { AUTH_ALLOWED_DISCORD_IDS: ", ," };
    assert.equal(isInstanceAccessRestricted(environment), true);
    assert.equal(
        isInstanceAccountAllowed(
            { provider: "discord", providerAccountId: "123" },
            environment,
        ),
        false,
    );
});
