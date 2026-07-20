"use client";

import { useEffect, useState } from "react";
import { Search, Settings2 } from "lucide-react";
import {
    ItemCard,
    ItemCardSkeleton,
    type ItemData,
} from "@/components/monitors/item-card";
import {
    capFeedItems,
    DEFAULT_LIVE_FEED_ITEM_CAP,
    LIVE_FEED_ITEM_CAP_OPTIONS,
    normalizeLiveFeedItemCap,
} from "@/lib/live-feed";

type FeedSummary = {
    activeMonitors: number;
    totalMonitors: number;
};

const LIVE_FEED_CAP_STORAGE_KEY = "vintrack.liveFeed.itemCap";

export default function FeedPage() {
    const [items, setItems] = useState<ItemData[]>([]);
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState<FeedSummary | null>(null);
    const [itemCap, setItemCap] = useState(() =>
        typeof window === "undefined"
            ? DEFAULT_LIVE_FEED_ITEM_CAP
            : normalizeLiveFeedItemCap(
                  window.localStorage.getItem(LIVE_FEED_CAP_STORAGE_KEY),
              ),
    );

    useEffect(() => {
        const fetchFeed = async () => {
            try {
                const [feedRes, summaryRes] = await Promise.all([
                    fetch(`/api/feed?limit=${itemCap}`),
                    fetch("/api/monitors/summary"),
                ]);

                if (feedRes.ok) {
                    const data: ItemData[] = await feedRes.json();
                    setItems(
                        capFeedItems(
                            data.map((i) => ({ ...i, isLive: false })),
                            itemCap,
                        ),
                    );
                }

                if (summaryRes.ok) {
                    const data: FeedSummary = await summaryRes.json();
                    setSummary(data);
                }
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchFeed();
    }, [itemCap]);

    useEffect(() => {
        const eventSource = new EventSource("/api/stream");

        eventSource.onmessage = (event) => {
            try {
                const newItem: ItemData = JSON.parse(event.data);
                const liveItem: ItemData = {
                    ...newItem,
                    isLive: true,
                    monitor_name: newItem.monitor_name || null,
                };

                setItems((prev) => {
                    const newId = String(newItem.id);
                    const existingIdx = prev.findIndex(
                        (i) => String(i.id) === newId,
                    );
                    if (existingIdx !== -1) {
                        const existing = prev[existingIdx];
                        const merged = {
                            ...existing,
                            monitor_name:
                                newItem.monitor_name || existing.monitor_name,
                            location: newItem.location || existing.location,
                            rating: newItem.rating || existing.rating,
                            seller_id: newItem.seller_id || existing.seller_id,
                            seller_login:
                                newItem.seller_login || existing.seller_login,
                            seller_profile_url:
                                newItem.seller_profile_url ||
                                existing.seller_profile_url,
                            total_price:
                                newItem.total_price || existing.total_price,
                        };
                        const updated = [...prev];
                        updated[existingIdx] = merged;
                        return updated;
                    }
                    return capFeedItems(
                        [{ ...liveItem, id: newId }, ...prev],
                        itemCap,
                    );
                });

                setTimeout(() => {
                    setItems((curr) =>
                        curr.map((item) =>
                            String(item.id) === String(newItem.id)
                                ? { ...item, isLive: false }
                                : item,
                        ),
                    );
                }, 30000);
            } catch (e) {
                console.error("SSE Error", e);
            }
        };

        return () => eventSource.close();
    }, [itemCap]);

    const handleItemCapChange = (value: string) => {
        const nextCap = normalizeLiveFeedItemCap(value);
        setItemCap(nextCap);
        window.localStorage.setItem(LIVE_FEED_CAP_STORAGE_KEY, String(nextCap));
        setItems((current) => capFeedItems(current, nextCap));
    };

    const handleSellerBanned = (sellerId: string) => {
        setItems((current) =>
            current.filter((item) => item.seller_id !== sellerId),
        );
    };

    const activeMonitorCount = summary?.activeMonitors ?? 0;
    const hasActiveMonitors = activeMonitorCount > 0;
    const liveBadgeClassName = hasActiveMonitors
        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";

    return (
        <div className="space-y-6">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                        Live Feed
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Real-time stream across all your monitors.
                    </p>
                </div>
                <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
                    <label className="border-input bg-background text-muted-foreground inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs shadow-xs">
                        <Settings2 className="h-3.5 w-3.5" />
                        <span className="sr-only">Live feed item limit</span>
                        <select
                            aria-label="Live feed item limit"
                            value={itemCap}
                            onChange={(event) =>
                                handleItemCapChange(event.target.value)
                            }
                            className="text-foreground h-6 cursor-pointer rounded-md bg-transparent pr-1 text-xs font-medium outline-none"
                        >
                            {LIVE_FEED_ITEM_CAP_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {option} items
                                </option>
                            ))}
                        </select>
                    </label>
                    <div
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium ${liveBadgeClassName}`}
                    >
                        {hasActiveMonitors ? (
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {loading && items.length === 0
                    ? [...Array(8)].map((_, i) => <ItemCardSkeleton key={i} />)
                    : items.map((item) => (
                          <ItemCard
                              key={item.id}
                              item={item}
                              showMonitor
                              onSellerBanned={handleSellerBanned}
                          />
                      ))}
            </div>

            {items.length === 0 && !loading && (
                <div className="border-border/80 bg-card/75 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed py-20 shadow-sm backdrop-blur">
                    <div className="bg-muted mb-4 rounded-xl p-3">
                        <Search className="text-muted-foreground h-6 w-6" />
                    </div>
                    <h3 className="text-foreground text-base font-semibold">
                        Waiting for items...
                    </h3>
                    <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                        New items will appear here in real-time as your monitors
                        find them.
                    </p>
                </div>
            )}
        </div>
    );
}
