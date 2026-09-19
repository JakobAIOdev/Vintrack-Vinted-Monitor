export const DEFAULT_LIVE_FEED_ITEM_CAP = 100;
export const LIVE_FEED_ITEM_CAP_OPTIONS = [
    50, 100, 200, 300, 400, 500,
] as const;

export function capFeedItems<T>(items: T[], cap = DEFAULT_LIVE_FEED_ITEM_CAP) {
    return items.length > cap ? items.slice(0, cap) : items;
}

export function normalizeLiveFeedItemCap(
    value: string | null | undefined,
    fallback = DEFAULT_LIVE_FEED_ITEM_CAP,
) {
    const parsed = Number(value);
    return LIVE_FEED_ITEM_CAP_OPTIONS.includes(
        parsed as (typeof LIVE_FEED_ITEM_CAP_OPTIONS)[number],
    )
        ? parsed
        : fallback;
}

export function normalizeLiveFeedResetAt(
    value: string | null | undefined,
): number | null {
    if (!value) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isFeedItemAfterReset(
    item: { found_at?: string | null },
    resetAt: number | null,
) {
    if (resetAt === null) return true;

    const foundAt = Date.parse(item.found_at ?? "");
    return Number.isFinite(foundAt) && foundAt > resetAt;
}
