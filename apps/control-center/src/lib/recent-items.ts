export type RecentItemKey = {
    id: bigint;
    monitor_id: number;
};

/**
 * Returns rows in the order of their keys. Rows without a key and keys
 * without a row (for example an item deleted between both queries) are
 * dropped. Items are keyed by (id, monitor_id) because the same listing can be
 * stored once per monitor.
 */
export function orderRowsByKeys<
    Row extends { id: bigint; monitor_id: number },
>(keys: RecentItemKey[], rows: Row[]): Row[] {
    const byKey = new Map(
        rows.map((row) => [`${row.id}:${row.monitor_id}`, row]),
    );
    const ordered: Row[] = [];
    for (const key of keys) {
        const row = byKey.get(`${key.id}:${key.monitor_id}`);
        if (row) ordered.push(row);
    }
    return ordered;
}
