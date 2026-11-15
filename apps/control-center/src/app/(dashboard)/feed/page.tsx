"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, RotateCcw, Search, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ExpandableSearch } from "@/components/expandable-search";
import {
    ItemCard,
    ItemCardSkeleton,
    type ItemData,
} from "@/components/monitors/item-card";
import {
    capFeedItems,
    DEFAULT_LIVE_FEED_ITEM_CAP,
    isFeedItemAfterReset,
    LIVE_FEED_ITEM_CAP_OPTIONS,
    normalizeLiveFeedItemCap,
    normalizeLiveFeedResetAt,
} from "@/lib/live-feed";
import { useMonitorItemStream } from "@/components/monitors/monitor-stream-context";

type FeedSummary = {
    activeMonitors: number;
    totalMonitors: number;
};

const LIVE_FEED_CAP_STORAGE_KEY = "vintrack.liveFeed.itemCap";
const LIVE_FEED_RESET_STORAGE_KEY = "vintrack.liveFeed.resetAt";

export default function FeedPage() {
    const [items, setItems] = useState<ItemData[]>([]);
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState<FeedSummary | null>(null);
    const [feedError, setFeedError] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const [search, setSearch] = useState("");
    const [monitorFilter, setMonitorFilter] = useState("all");
    const [itemCap, setItemCap] = useState(() =>
        typeof window === "undefined"
            ? DEFAULT_LIVE_FEED_ITEM_CAP
            : normalizeLiveFeedItemCap(
                  window.localStorage.getItem(LIVE_FEED_CAP_STORAGE_KEY),
              ),
    );
    const [resetAt, setResetAt] = useState(() =>
        typeof window === "undefined"
            ? null
            : normalizeLiveFeedResetAt(
                  window.localStorage.getItem(LIVE_FEED_RESET_STORAGE_KEY),
              ),
    );
    const resetAtRef = useRef(resetAt);

    useEffect(() => {
        const controller = new AbortController();

        const fetchFeed = async () => {
            try {
                const feedRes = await fetch(`/api/feed?limit=${itemCap}`, {
                    signal: controller.signal,
                });
                if (!feedRes.ok) throw new Error("Feed request failed");
                const data: ItemData[] = await feedRes.json();
                if (!controller.signal.aborted) {
                    setFeedError(false);
                    setItems((current) => {
                        const liveItems = current.filter(
                            (item) =>
                                item.isLive &&
                                isFeedItemAfterReset(item, resetAt),
                        );
                        const liveIds = new Set(
                            liveItems.map((item) => String(item.id)),
                        );
                        return capFeedItems(
                            [
                                ...liveItems,
                                ...data
                                    .filter(
                                        (item) =>
                                            isFeedItemAfterReset(
                                                item,
                                                resetAt,
                                            ) && !liveIds.has(String(item.id)),
                                    )
                                    .map((i) => ({ ...i, isLive: false })),
                            ],
                            itemCap,
                        );
                    });
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    console.error(err);
                    setFeedError(true);
                }
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        };
        void fetchFeed();
        void fetch("/api/monitors/summary", { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) return;
                const data: FeedSummary = await response.json();
                if (!controller.signal.aborted) setSummary(data);
            })
            .catch((err) => {
                if (!controller.signal.aborted) console.error(err);
            });

        return () => controller.abort();
    }, [itemCap, resetAt, retryCount]);

    useMonitorItemStream((newItem) => {
        if (!isFeedItemAfterReset(newItem, resetAtRef.current)) return;

        const newId = String(newItem.id);
        const liveItem: ItemData = {
            ...newItem,
            id: newId,
            isLive: true,
            monitor_name: newItem.monitor_name || null,
        };

        setItems((prev) => {
            const existingIdx = prev.findIndex((i) => String(i.id) === newId);
            if (existingIdx !== -1) {
                const existing = prev[existingIdx];
                const merged = {
                    ...existing,
                    monitor_name: newItem.monitor_name || existing.monitor_name,
                    location: newItem.location || existing.location,
                    rating: newItem.rating || existing.rating,
                    seller_id: newItem.seller_id || existing.seller_id,
                    seller_login: newItem.seller_login || existing.seller_login,
                    seller_profile_url:
                        newItem.seller_profile_url ||
                        existing.seller_profile_url,
                    total_price: newItem.total_price || existing.total_price,
                };
                const updated = [...prev];
                updated[existingIdx] = merged;
                return updated;
            }
            return capFeedItems([liveItem, ...prev], itemCap);
        });

        setTimeout(() => {
            setItems((curr) =>
                curr.map((item) =>
                    String(item.id) === newId
                        ? { ...item, isLive: false }
                        : item,
                ),
            );
        }, 30000);
    });

    const handleItemCapChange = (value: string) => {
        const nextCap = normalizeLiveFeedItemCap(value);
        if (nextCap === itemCap) return;
        setLoading(true);
        setItemCap(nextCap);
        window.localStorage.setItem(LIVE_FEED_CAP_STORAGE_KEY, String(nextCap));
        setItems((current) => capFeedItems(current, nextCap));
    };

    const handleResetFeed = () => {
        const nextResetAt = Date.now();
        resetAtRef.current = nextResetAt;
        setLoading(true);
        setResetAt(nextResetAt);
        setItems([]);
        setSearch("");
        setMonitorFilter("all");
        window.localStorage.setItem(
            LIVE_FEED_RESET_STORAGE_KEY,
            String(nextResetAt),
        );
        toast.success("Live feed reset. New items will appear here.");
    };

    const handleSellerBanned = (sellerId: string) => {
        setItems((current) =>
            current.filter((item) => item.seller_id !== sellerId),
        );
    };

    const activeMonitorCount = summary?.activeMonitors ?? 0;
    const monitorOptions = useMemo(() => {
        const monitors = new Map<number, string>();
        for (const item of items) {
            monitors.set(
                item.monitor_id,
                item.monitor_name || `Monitor #${item.monitor_id}`,
            );
        }
        return [...monitors.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    }, [items]);
    const filteredItems = useMemo(() => {
        const query = search.trim().toLowerCase();
        return items.filter(
            (item) =>
                (monitorFilter === "all" ||
                    String(item.monitor_id) === monitorFilter) &&
                (!query ||
                    [
                        item.title,
                        item.brand,
                        item.size,
                        item.seller_login,
                        item.monitor_name,
                    ].some((value) => value?.toLowerCase().includes(query))),
        );
    }, [items, search, monitorFilter]);
    const hasFilters = search.trim() !== "" || monitorFilter !== "all";
    const hasActiveMonitors = activeMonitorCount > 0;
    const liveBadgeClassName = hasActiveMonitors
        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";

    return (
        <div className="space-y-5">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Live Feed
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Real-time stream across all your monitors.
                    </p>
                </div>
                <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
                    <div
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium ${liveBadgeClassName}`}
                    >
                        {hasActiveMonitors ? (
                            <span className="relative flex h-2 w-2">
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                            </span>
                        ) : (
                            <span className="h-2 w-2 rounded-full bg-amber-500/80" />
                        )}
                        {hasActiveMonitors
                            ? `Live · ${activeMonitorCount} monitor${activeMonitorCount === 1 ? "" : "s"}`
                            : "No monitor active"}
                    </div>
                </div>
            </div>

            <section
                aria-label="Find feed items"
                className="border-border/60 space-y-3 border-b pb-4"
            >
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                        <ExpandableSearch
                            value={search}
                            onChange={setSearch}
                            label="Search feed items"
                            clearLabel="Clear feed search"
                            closeLabel="Close feed search"
                            placeholder="Search items, brands or sellers"
                        />
                        <select
                            aria-label="Filter feed by monitor"
                            value={monitorFilter}
                            onChange={(event) =>
                                setMonitorFilter(event.target.value)
                            }
                            className="border-input bg-card text-foreground hover:border-ring/50 focus-visible:ring-ring h-8 w-44 max-w-full min-w-0 cursor-pointer rounded-md border px-2 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
                        >
                            <option value="all">All monitors</option>
                            {monitorFilter !== "all" &&
                                !monitorOptions.some(
                                    ([id]) => String(id) === monitorFilter,
                                ) && (
                                    <option value={monitorFilter}>
                                        Monitor #{monitorFilter}
                                    </option>
                                )}
                            {monitorOptions.map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ui-icon-turn text-muted-foreground"
                            onClick={handleResetFeed}
                            disabled={loading || items.length === 0}
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reset feed
                        </Button>
                        <label className="relative inline-flex max-w-full min-w-0 items-center">
                            <Settings2
                                aria-hidden="true"
                                className="text-muted-foreground pointer-events-none absolute left-2.5 size-3.5"
                            />
                            <span className="sr-only">
                                Live feed item limit
                            </span>
                            <select
                                aria-label="Live feed item limit"
                                value={itemCap}
                                onChange={(event) =>
                                    handleItemCapChange(event.target.value)
                                }
                                className="border-input bg-card text-foreground hover:border-ring/50 focus-visible:ring-ring h-8 max-w-full min-w-0 cursor-pointer rounded-md border py-1 pl-8 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                            >
                                {LIVE_FEED_ITEM_CAP_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {option} items
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p role="status" className="text-muted-foreground text-xs">
                        {filteredItems.length} of {items.length} items · latest
                        first
                    </p>
                    {hasFilters && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground h-7 px-2 text-xs"
                            onClick={() => {
                                setSearch("");
                                setMonitorFilter("all");
                            }}
                        >
                            Clear filters
                        </Button>
                    )}
                </div>
            </section>

            {feedError && (
                <div
                    role="alert"
                    className="border-destructive/25 bg-destructive/5 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
                >
                    <AlertCircle
                        aria-hidden="true"
                        className="text-destructive size-4 shrink-0"
                    />
                    <p className="min-w-0 flex-1">
                        Couldn’t load feed items. Check your connection and try
                        again.
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => {
                            setLoading(true);
                            setRetryCount((count) => count + 1);
                        }}
                    >
                        {loading ? "Retrying…" : "Retry"}
                    </Button>
                </div>
            )}

            <div
                aria-busy={loading}
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            >
                {loading && items.length === 0
                    ? [...Array(8)].map((_, i) => <ItemCardSkeleton key={i} />)
                    : filteredItems.map((item) => (
                          <ItemCard
                              key={item.id}
                              item={item}
                              showMonitor
                              onSellerBanned={handleSellerBanned}
                          />
                      ))}
            </div>

            {filteredItems.length === 0 && !loading && !feedError && (
                <div className="border-border bg-card flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-12 text-center">
                    <Search
                        aria-hidden="true"
                        className="text-muted-foreground/60 mb-3 size-6"
                    />
                    <h3 className="text-foreground text-base font-semibold">
                        {items.length > 0
                            ? "No matching items"
                            : summary && !hasActiveMonitors
                              ? "Start a monitor to fill your feed"
                              : "Waiting for items..."}
                    </h3>
                    <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                        {items.length > 0
                            ? "Try another search or show items from all monitors."
                            : summary && !hasActiveMonitors
                              ? "Create or start a monitor from your dashboard. New finds will appear here automatically."
                              : "New items will appear here in real-time as your monitors find them."}
                    </p>
                    {hasFilters ? (
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            onClick={() => {
                                setSearch("");
                                setMonitorFilter("all");
                            }}
                        >
                            Clear search and filters
                        </Button>
                    ) : summary && !hasActiveMonitors ? (
                        <Button
                            asChild
                            variant="outline"
                            size="sm"
                            className="mt-4"
                        >
                            <Link href="/dashboard">Manage monitors</Link>
                        </Button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
