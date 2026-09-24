"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
    ItemCard,
    ItemCardSkeleton,
    type ItemData,
} from "@/components/monitors/item-card";
import { useMonitorLiveContext } from "@/components/monitors/monitor-live-context";
import { capFeedItems, DEFAULT_LIVE_FEED_ITEM_CAP } from "@/lib/live-feed";
import { useMonitorItemStream } from "@/components/monitors/monitor-stream-context";

const MONITOR_LIVE_FEED_ITEM_CAP = DEFAULT_LIVE_FEED_ITEM_CAP;
const MONITOR_FEED_RECONCILE_INTERVAL_MS = 10_000;

export function LiveFeed({ monitorId }: { monitorId: number }) {
    const [items, setItems] = useState<ItemData[]>([]);
    const [loading, setLoading] = useState(true);
    const {
        decrementItemCount,
        ensureItemCountAtLeast,
        incrementItemCount,
    } = useMonitorLiveContext();
    const seenItemIds = useRef<Set<string>>(new Set());

    useEffect(() => {
        let active = true;
        let requestInFlight = false;

        const fetchItems = async () => {
            if (requestInFlight) return;
            requestInFlight = true;
            try {
                const res = await fetch(`/api/monitors/${monitorId}/items`, {
                    cache: "no-store",
                });
                if (res.ok) {
                    const data: ItemData[] = await res.json();
                    if (!active) return;

                    const fetchedItems = capFeedItems(
                        data.map((i) => ({ ...i, isLive: false })),
                        MONITOR_LIVE_FEED_ITEM_CAP,
                    );
                    ensureItemCountAtLeast(fetchedItems.length);
                    setItems((currentItems) => {
                        const currentByID = new Map(
                            currentItems.map((item) => [String(item.id), item]),
                        );
                        const fetchedIDs = new Set(
                            fetchedItems.map((item) => String(item.id)),
                        );
                        const merged: ItemData[] = fetchedItems.map((item) => {
                            const current = currentByID.get(String(item.id));
                            return {
                                ...current,
                                ...item,
                                isLive: current?.isLive ?? false,
                            };
                        });

                        // A live event can arrive just before its Postgres row is
                        // visible. Keep such items until a later reconcile sees
                        // them instead of briefly removing them from the feed.
                        for (const item of currentItems) {
                            if (!fetchedIDs.has(String(item.id))) {
                                merged.push(item);
                            }
                        }

                        const nextItems = capFeedItems(
                            merged.sort(
                                (a, b) =>
                                    Date.parse(b.found_at) -
                                    Date.parse(a.found_at),
                            ),
                            MONITOR_LIVE_FEED_ITEM_CAP,
                        );
                        seenItemIds.current = new Set(
                            nextItems.map((item) => String(item.id)),
                        );
                        return nextItems;
                    });
                }
            } catch (err) {
                console.error("Fetch error", err);
            } finally {
                requestInFlight = false;
                if (active) setLoading(false);
            }
        };
        void fetchItems();
        const reconcileTimer = window.setInterval(
            () => void fetchItems(),
            MONITOR_FEED_RECONCILE_INTERVAL_MS,
        );

        return () => {
            active = false;
            window.clearInterval(reconcileTimer);
        };
    }, [ensureItemCountAtLeast, monitorId]);

    useMonitorItemStream((newItem) => {
        if (newItem.monitor_id !== monitorId) return;

        const newId = String(newItem.id);
        const liveItem: ItemData = {
            ...newItem,
            id: newId,
            isLive: true,
        };
        const isExisting = seenItemIds.current.has(newId);

        if (!isExisting) {
            seenItemIds.current.add(newId);
            incrementItemCount();
        }

        setItems((prev) => {
            const existingIdx = prev.findIndex((i) => String(i.id) === newId);
            if (existingIdx !== -1) {
                const existing = prev[existingIdx];
                const merged = {
                    ...existing,
                    location: newItem.location || existing.location,
                    rating: newItem.rating || existing.rating,
                    seller_id: newItem.seller_id || existing.seller_id,
                    seller_login: newItem.seller_login || existing.seller_login,
                    seller_profile_url:
                        newItem.seller_profile_url ||
                        existing.seller_profile_url,
                    total_price: newItem.total_price || existing.total_price,
                    extra_images: newItem.extra_images || existing.extra_images,
                };
                const updated = [...prev];
                updated[existingIdx] = merged;
                return updated;
            }
            const nextItems = capFeedItems(
                [liveItem, ...prev],
                MONITOR_LIVE_FEED_ITEM_CAP,
            );
            seenItemIds.current = new Set(
                nextItems.map((item) => String(item.id)),
            );
            return nextItems;
        });

        setTimeout(() => {
            setItems((curr) =>
                curr.map((item) =>
                    String(item.id) === newId
                        ? { ...item, isLive: false }
                        : item,
                ),
            );
        }, 10000);
    });

    const handleSellerBanned = (sellerId: string) => {
        setItems((current) => {
            const next = current.filter((item) => item.seller_id !== sellerId);
            decrementItemCount(current.length - next.length);
            seenItemIds.current = new Set(next.map((item) => String(item.id)));
            return next;
        });
    };

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {loading && items.length === 0
                ? [...Array(5)].map((_, i) => <ItemCardSkeleton key={i} />)
                : items.map((item) => (
                      <ItemCard
                          key={item.id}
                          item={item}
                          onSellerBanned={handleSellerBanned}
                      />
                  ))}

            {items.length === 0 && !loading && (
                <div className="border-border bg-card col-span-full flex flex-col items-center justify-center rounded-2xl border-2 border-dashed py-20">
                    <div className="bg-muted mb-4 rounded-xl p-3">
                        <Search className="text-muted-foreground h-6 w-6" />
                    </div>
                    <h3 className="text-foreground text-base font-semibold">
                        No items found yet
                    </h3>
                    <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                        Items will appear here in real-time as the worker finds
                        them.
                    </p>
                </div>
            )}
        </div>
    );
}
