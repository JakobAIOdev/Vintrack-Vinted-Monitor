import test from "node:test";
import assert from "node:assert/strict";
import {
    buildExtensionInlineIndex,
    INLINE_INDEX_FIND_LIMIT,
} from "../../src/lib/extension-inline-index.ts";

const now = new Date("2026-11-12T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

test("inline index keeps the newest find per listing and only used monitors", () => {
    const index = buildExtensionInlineIndex({
        now,
        monitors: [
            { id: 1, name: "Nike search" },
            { id: 2, name: "Carhartt jackets" },
            { id: 3, name: "Unused monitor" },
        ],
        finds: [
            {
                id: BigInt(100),
                monitor_id: 1,
                found_at: at("2026-11-12T10:00:00Z"),
            },
            {
                id: BigInt(100),
                monitor_id: 2,
                found_at: at("2026-11-12T11:00:00Z"),
            },
            {
                id: BigInt(200),
                monitor_id: 1,
                found_at: at("2026-11-12T09:00:00Z"),
            },
            // A monitor that no longer belongs to the member is never exposed.
            {
                id: BigInt(300),
                monitor_id: 99,
                found_at: at("2026-11-12T11:30:00Z"),
            },
        ],
        watches: [],
    });

    assert.equal(index.generatedAt, now.toISOString());
    assert.deepEqual(index.finds, [
        ["100", 2, Date.parse("2026-11-12T11:00:00Z") / 1000],
        ["200", 1, Date.parse("2026-11-12T09:00:00Z") / 1000],
    ]);
    assert.deepEqual(index.monitors, [
        { id: 1, name: "Nike search" },
        { id: 2, name: "Carhartt jackets" },
    ]);
});

test("inline index bounds finds and tolerates a missing timestamp", () => {
    const finds = Array.from(
        { length: INLINE_INDEX_FIND_LIMIT + 25 },
        (_, i) => ({
            id: BigInt(i + 1),
            monitor_id: 1,
            found_at: i === 0 ? null : new Date(now.getTime() - i * 1000),
        }),
    );
    const index = buildExtensionInlineIndex({
        now,
        monitors: [{ id: 1, name: "Nike search" }],
        finds,
        watches: [],
    });

    assert.equal(index.finds.length, INLINE_INDEX_FIND_LIMIT);
    assert.equal(index.finds[0][0], "2");
    assert.ok(!index.finds.some(([itemId]) => itemId === "1"));
});

test("inline index serializes Price Watch prices without losing precision", () => {
    const index = buildExtensionInlineIndex({
        now,
        monitors: [],
        finds: [],
        watches: [
            {
                id: BigInt(7),
                status: "active",
                state: { key: "watching", label: "Watching" },
                initial_price_minor: BigInt(2000),
                target: {
                    item_id: BigInt("10779900494"),
                    region: "de",
                    current_price_minor: BigInt(1800),
                    currency_code: "EUR",
                },
                schedule: {
                    current_price_minor: BigInt(1500),
                    currency_code: null,
                    availability: "active",
                },
            },
            {
                id: BigInt(8),
                status: "stopped",
                state: { key: "sold", label: "Sold" },
                initial_price_minor: null,
                target: {
                    item_id: BigInt(42),
                    region: "fr",
                    current_price_minor: null,
                    currency_code: null,
                },
                schedule: {
                    current_price_minor: null,
                    currency_code: null,
                    availability: "unavailable",
                },
            },
        ],
    });

    assert.deepEqual(index.watches, [
        {
            id: "7",
            itemId: "10779900494",
            region: "de",
            status: "active",
            stateKey: "watching",
            stateLabel: "Watching",
            availability: "active",
            initialPriceMinor: "2000",
            currentPriceMinor: "1500",
            currencyCode: "EUR",
        },
        {
            id: "8",
            itemId: "42",
            region: "fr",
            status: "stopped",
            stateKey: "sold",
            stateLabel: "Sold",
            availability: "unavailable",
            initialPriceMinor: null,
            currentPriceMinor: null,
            currencyCode: null,
        },
    ]);
});
