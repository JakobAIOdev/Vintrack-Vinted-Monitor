import test from "node:test";
import assert from "node:assert/strict";
import { buildDeploymentConfigDiagnostics } from "../../src/lib/deployment-config.ts";

test("does not require service-owned secrets in the Control Center", () => {
    const diagnostics = buildDeploymentConfigDiagnostics({
        NODE_ENV: "production",
        AUTH_URL: "https://vintrack.example",
        AUTH_SECRET: "configured",
        VINTED_SESSION_ENCRYPTION_KEY: "owned-by-vinted-service",
    });

    assert.equal(diagnostics.status, "healthy");
    assert.deepEqual(diagnostics.missing, []);
    assert.equal(diagnostics.configuredSecrets, 1);
});

test("reports required and incomplete Control Center credentials", () => {
    const diagnostics = buildDeploymentConfigDiagnostics({
        NODE_ENV: "production",
        AUTH_GITHUB_ID: "configured",
    });

    assert.equal(diagnostics.status, "attention");
    assert.deepEqual(diagnostics.missing, [
        "AUTH_URL",
        "AUTH_SECRET",
        "AUTH_GITHUB_SECRET",
    ]);
});

test("marks conflicting legacy origins as attention", () => {
    const diagnostics = buildDeploymentConfigDiagnostics({
        NODE_ENV: "production",
        AUTH_URL: "https://vintrack.example",
        APP_PUBLIC_URL: "https://legacy.example",
        AUTH_SECRET: "configured",
    });

    assert.equal(diagnostics.status, "attention");
    assert.equal(diagnostics.originConflict, true);
    assert.deepEqual(diagnostics.missing, []);
});
