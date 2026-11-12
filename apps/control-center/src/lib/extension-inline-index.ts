// Compact, bounded snapshot the browser extension matches against Vinted
// listings locally. Keeping the match in the browser means the pages a member
// browses are never sent to Vintrack just to draw a badge.

export const INLINE_INDEX_FIND_LIMIT = 1500;
export const INLINE_INDEX_FIND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INLINE_INDEX_WATCH_LIMIT = 500;

export type InlineIndexMonitorRow = { id: number; name: string };

export type InlineIndexFindRow = {
    id: bigint;
    monitor_id: number;
    found_at: Date | null;
};

export type InlineIndexWatchRow = {
    id: bigint;
    status: string;
    /** What the member is told about the watch, e.g. "sold" / "Sold". */
    state: { key: string; label: string };
    initial_price_minor: bigint | null;
    target: {
        item_id: bigint;
        region: string;
        current_price_minor: bigint | null;
        currency_code: string | null;
    };
    schedule: {
        current_price_minor: bigint | null;
        currency_code: string | null;
        availability: string;
    };
};

/** `[itemId, monitorId, foundAtEpochSeconds]`, newest first. */
export type InlineIndexFind = [string, number, number];

export type ExtensionInlineIndex = {
    generatedAt: string;
    monitors: InlineIndexMonitorRow[];
    finds: InlineIndexFind[];
    watches: Array<{
        id: string;
        itemId: string;
        region: string;
        status: string;
        stateKey: string;
        stateLabel: string;
        availability: string;
        initialPriceMinor: string | null;
        currentPriceMinor: string | null;
        currencyCode: string | null;
    }>;
};

export function buildExtensionInlineIndex(input: {
    monitors: InlineIndexMonitorRow[];
    finds: InlineIndexFindRow[];
    watches: InlineIndexWatchRow[];
    now?: Date;
}): ExtensionInlineIndex {
    const monitorNames = new Map(
        input.monitors.map((monitor) => [monitor.id, monitor.name]),
    );
    const newestFirst = [...input.finds].sort(
        (left, right) =>
            (right.found_at?.getTime() ?? 0) - (left.found_at?.getTime() ?? 0),
    );

    const seenItems = new Set<string>();
    const usedMonitors = new Set<number>();
    const finds: InlineIndexFind[] = [];
    for (const row of newestFirst) {
        if (finds.length >= INLINE_INDEX_FIND_LIMIT) break;
        const itemId = row.id.toString();
        // Several monitors can detect the same listing; the newest wins.
        if (seenItems.has(itemId) || !monitorNames.has(row.monitor_id)) {
            continue;
        }
        seenItems.add(itemId);
        usedMonitors.add(row.monitor_id);
        finds.push([
            itemId,
            row.monitor_id,
            Math.floor((row.found_at?.getTime() ?? 0) / 1000),
        ]);
    }

    return {
        generatedAt: (input.now ?? new Date()).toISOString(),
        monitors: input.monitors
            .filter((monitor) => usedMonitors.has(monitor.id))
            .map((monitor) => ({ id: monitor.id, name: monitor.name })),
        finds,
        watches: input.watches
            .slice(0, INLINE_INDEX_WATCH_LIMIT)
            .map((watch) => ({
                id: watch.id.toString(),
                itemId: watch.target.item_id.toString(),
                region: watch.target.region,
                status: watch.status,
                stateKey: watch.state.key,
                stateLabel: watch.state.label,
                availability: watch.schedule.availability,
                initialPriceMinor:
                    watch.initial_price_minor?.toString() ?? null,
                currentPriceMinor:
                    (
                        watch.schedule.current_price_minor ??
                        watch.target.current_price_minor
                    )?.toString() ?? null,
                currencyCode:
                    watch.schedule.currency_code ?? watch.target.currency_code,
            })),
    };
}
