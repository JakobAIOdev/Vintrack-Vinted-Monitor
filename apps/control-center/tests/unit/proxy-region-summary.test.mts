import test from "node:test";
import assert from "node:assert/strict";
import { summarizeProxyRegions } from "../../src/lib/proxy-region-summary.ts";

test("summarizes ready and tracked proxy regions", () => {
    assert.deepEqual(
        summarizeProxyRegions(
            [
                { region: "de", usable: 52 },
                { region: "fr", usable: 25 },
                { region: "it", usable: 24 },
            ],
            25,
        ),
        { ready: 2, total: 3 },
    );
});

test("normalizes an invalid minimum to at least one usable proxy", () => {
    assert.deepEqual(
        summarizeProxyRegions(
            [
                { region: "de", usable: 1 },
                { region: "fr", usable: 0 },
            ],
            0,
        ),
        { ready: 1, total: 2 },
    );
});
