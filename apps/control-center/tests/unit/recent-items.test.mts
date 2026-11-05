import test from "node:test";
import assert from "node:assert/strict";
import { orderRowsByKeys } from "../../src/lib/recent-items.ts";

test("recent items keep the newest-first key order", () => {
    const keys = [
        { id: 3n, monitor_id: 1 },
        { id: 1n, monitor_id: 2 },
        { id: 2n, monitor_id: 1 },
    ];
    const rows = [
        { id: 2n, monitor_id: 1, title: "b" },
        { id: 3n, monitor_id: 1, title: "c" },
        { id: 1n, monitor_id: 2, title: "a" },
    ];
    assert.deepEqual(
        orderRowsByKeys(keys, rows).map((row) => row.title),
        ["c", "a", "b"],
    );
});

test("recent items distinguish the same listing across monitors", () => {
    const keys = [
        { id: 7n, monitor_id: 2 },
        { id: 7n, monitor_id: 1 },
    ];
    const rows = [
        { id: 7n, monitor_id: 1, name: "first" },
        { id: 7n, monitor_id: 2, name: "second" },
    ];
    assert.deepEqual(
        orderRowsByKeys(keys, rows).map((row) => row.name),
        ["second", "first"],
    );
});

test("recent items drop rows deleted between both queries", () => {
    const keys = [
        { id: 1n, monitor_id: 1 },
        { id: 2n, monitor_id: 1 },
    ];
    const rows = [{ id: 2n, monitor_id: 1 }];
    assert.deepEqual(orderRowsByKeys(keys, rows), [{ id: 2n, monitor_id: 1 }]);
});
