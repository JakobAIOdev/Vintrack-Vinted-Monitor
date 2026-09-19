import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LIVE_FEED_ITEM_CAP,
    isFeedItemAfterReset,
    normalizeLiveFeedItemCap,
    normalizeLiveFeedResetAt,
} from "../../src/lib/live-feed.ts";

test("live feed accepts the expanded item cap options", () => {
    for (const cap of [50, 100, 200, 300, 400, 500]) {
        assert.equal(normalizeLiveFeedItemCap(String(cap)), cap);
    }
});

test("live feed rejects unsupported item caps", () => {
    assert.equal(normalizeLiveFeedItemCap("501"), DEFAULT_LIVE_FEED_ITEM_CAP);
    assert.equal(
        normalizeLiveFeedItemCap("custom"),
        DEFAULT_LIVE_FEED_ITEM_CAP,
    );
});

test("live feed reset timestamps are normalized", () => {
    assert.equal(normalizeLiveFeedResetAt("1720000000000"), 1720000000000);
    assert.equal(normalizeLiveFeedResetAt("invalid"), null);
    assert.equal(normalizeLiveFeedResetAt("0"), null);
    assert.equal(normalizeLiveFeedResetAt(null), null);
});

test("live feed reset keeps only items found afterwards", () => {
    const resetAt = Date.parse("2026-09-19T12:00:00.000Z");

    assert.equal(
        isFeedItemAfterReset({ found_at: "2026-09-19T12:00:00.001Z" }, resetAt),
        true,
    );
    assert.equal(
        isFeedItemAfterReset({ found_at: "2026-09-19T12:00:00.000Z" }, resetAt),
        false,
    );
    assert.equal(
        isFeedItemAfterReset({ found_at: "2026-09-19T11:59:59.999Z" }, resetAt),
        false,
    );
    assert.equal(isFeedItemAfterReset({ found_at: null }, resetAt), false);
});
