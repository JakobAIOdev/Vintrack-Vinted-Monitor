import test from "node:test";
import assert from "node:assert/strict";
import {
    parseFreeProxyCanarySnapshot,
    resolveFreeProxyRegionReadiness,
    withRequiredFreeProxyCanaryRegions,
} from "../../src/lib/free-proxy-readiness.ts";

test("UK remains a validation region when admins hide it from starter regions", () => {
    assert.deepEqual(withRequiredFreeProxyCanaryRegions(["de"]), ["de", "uk"]);
});

test("UK readiness depends on the persisted shadow canary", () => {
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

    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            region: "uk",
            featureEnabled: true,
            serving: true,
            servingReason: null,
            canary,
        }),
        { ready: true, reason: null },
    );
});

test("UK remains closed without shadow evidence even when serving is stale-ready", () => {
    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            region: "uk",
            featureEnabled: true,
            serving: true,
            servingReason: null,
            canary: null,
        }),
        { ready: false, reason: "collecting_uk_canary" },
    );
});

test("member runtime metrics are not an input to shadow-canary readiness", () => {
    const canary = parseFreeProxyCanarySnapshot(
        JSON.stringify({
            state: "collecting",
            capacityReady: true,
            canaryPassed: false,
            sampleCount: 199,
            successRate: 100,
            windowMinutes: 29.5,
            readinessReason: "collecting_uk_canary",
        }),
    );

    assert.deepEqual(
        resolveFreeProxyRegionReadiness({
            region: "uk",
            featureEnabled: true,
            serving: false,
            servingReason: null,
            canary,
        }),
        { ready: false, reason: "collecting_uk_canary" },
    );
});
