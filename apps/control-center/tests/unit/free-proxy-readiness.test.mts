import test from "node:test";
import assert from "node:assert/strict";
import {
    parseFreeProxyCanarySnapshot,
    resolveFreeProxyRegionReadiness,
} from "../../src/lib/free-proxy-readiness.ts";

test("UK canary telemetry remains parseable for diagnostics", () => {
    const canary = parseFreeProxyCanarySnapshot(
        JSON.stringify({
            state: "passed",
            capacityReady: true,
            canaryPassed: true,
            sampleCount: 200,
            successRate: 96,
            windowMinutes: 29.5,
            lastProbeAt: "2026-09-22T10:00:00Z",
        }),
    );

    assert.equal(canary?.canaryPassed, true);
    assert.equal(canary?.sampleCount, 200);
});

test("UK readiness uses the same serving snapshot as every region", () => {
    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            featureEnabled: true,
            serving: true,
            servingReason: null,
        }),
        { ready: true, reason: null },
    );
});

test("UK remains ready without shadow evidence when it is serving", () => {
    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            featureEnabled: true,
            serving: true,
            servingReason: null,
        }),
        { ready: true, reason: null },
    );
});

test("a non-serving pool remains unavailable regardless of canary telemetry", () => {
    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            featureEnabled: true,
            serving: false,
            servingReason: null,
        }),
        { ready: false, reason: "awaiting_serving_snapshot" },
    );
});
