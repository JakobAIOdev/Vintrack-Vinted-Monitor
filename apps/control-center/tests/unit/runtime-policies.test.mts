import assert from "node:assert/strict";
import test from "node:test";

import {
    parseFreeProxyPolicy,
    parseWorkerPolicy,
} from "../../src/lib/runtime-policies.ts";

test("old worker policy documents receive seller TTL defaults", () => {
    const policy = parseWorkerPolicy(
        JSON.stringify({
            version: 1,
            revision: 7,
            discoveryMode: "off",
            discoveryAllowFreeActive: false,
            enrichSellerInfo: true,
            catalogLatencyMetrics: true,
        }),
    );
    assert.equal(policy?.sellerFreshTtlMinutes, 30);
    assert.equal(policy?.sellerStaleTtlMinutes, 1440);
});

test("old free proxy policy documents receive disabled canary defaults", () => {
    const policy = parseFreeProxyPolicy(
        JSON.stringify({
            version: 1,
            revision: 4,
            autoImportEnabled: false,
            importSource: "custom",
            importUrl: "https://example.test/proxies.txt",
            maxPoolSize: 5000,
            failureThreshold: 3,
            quarantineMinutes: 30,
            minActivePerRegion: 25,
            targetActivePerRegion: 50,
            maxLatencyMs: 2500,
            starterRegions: "de,fr",
            inventoryLimit: 30000,
            activeCandidateLimit: 10000,
            idleCandidateLimit: 5000,
            readyTarget: 50,
            reserveTarget: 50,
            idleTarget: 10,
            emergencyRecoveryEnabled: true,
        }),
    );
    assert.equal(policy?.adaptivePacingEnabled, false);
    assert.deepEqual(policy?.adaptiveRegions, ["de", "fr"]);
    assert.equal(policy?.maxRequestsPerProxySecond, 0.5);
    assert.equal(policy?.maxAdmissionDelayMs, 1500);
});

test("new policy documents retain explicit adaptive and TTL values", () => {
    const worker = parseWorkerPolicy(
        JSON.stringify({
            version: 1,
            revision: 8,
            discoveryMode: "shadow",
            discoveryAllowFreeActive: false,
            enrichSellerInfo: true,
            catalogLatencyMetrics: true,
            sellerFreshTtlMinutes: 20,
            sellerStaleTtlMinutes: 720,
        }),
    );
    assert.equal(worker?.sellerFreshTtlMinutes, 20);
    assert.equal(worker?.sellerStaleTtlMinutes, 720);
});
