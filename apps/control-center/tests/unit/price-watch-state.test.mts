import test from "node:test";
import assert from "node:assert/strict";
import {
    describePriceWatchState,
    type PriceWatchStateInput,
} from "../../src/lib/price-watch-state.ts";

const base: PriceWatchStateInput = {
    status: "active",
    stoppedReason: null,
    availability: "active",
    lastErrorCode: null,
    armed: true,
};
const key = (input: Partial<PriceWatchStateInput>) =>
    describePriceWatchState({ ...base, ...input }).key;

test("a healthy armed watch is watching", () => {
    assert.deepEqual(describePriceWatchState(base), {
        key: "watching",
        label: "Watching",
        tone: "ok",
        hint: null,
    });
});

test("a stopped watch says why the listing is gone", () => {
    for (const [stoppedReason, expected, label] of [
        ["item_sold", "sold", "Sold"],
        ["item_deleted", "removed", "Removed"],
        ["item_unavailable", "unavailable", "Unavailable"],
    ] as const) {
        const state = describePriceWatchState({
            ...base,
            status: "stopped",
            stoppedReason,
            availability: "unavailable",
            lastErrorCode: stoppedReason,
            armed: false,
        });
        assert.equal(state.key, expected);
        assert.equal(state.label, label);
        assert.match(state.hint ?? "", /stopped watching/);
    }
    assert.equal(key({ status: "stopped", stoppedReason: null }), "stopped");
    assert.equal(key({ status: "stopped", stoppedReason: "other" }), "stopped");
});

test("an unconfirmed sold or removed result is shown as confirming, not as an error", () => {
    for (const lastErrorCode of [
        "item_sold",
        "item_deleted",
        "item_unavailable",
    ]) {
        assert.equal(key({ lastErrorCode }), "confirming");
    }
    assert.equal(key({ lastErrorCode: "network_error" }), "retrying");
    assert.equal(key({ lastErrorCode: "unexpected_redirect" }), "retrying");
});

test("pause wins over everything else and validation over availability", () => {
    assert.equal(
        key({
            status: "paused",
            stoppedReason: "inactive_member",
            lastErrorCode: "item_sold",
        }),
        "paused",
    );
    assert.equal(key({ armed: false }), "validating");
    assert.equal(key({ availability: "pending" }), "validating");
    assert.equal(key({ availability: "reserved", armed: false }), "validating");
});

test("reserved and hidden listings stay watched under their own label", () => {
    assert.equal(key({ availability: "reserved" }), "reserved");
    assert.equal(key({ availability: "hidden" }), "hidden");
    assert.equal(
        describePriceWatchState({ ...base, availability: "reserved" }).tone,
        "warn",
    );
});
