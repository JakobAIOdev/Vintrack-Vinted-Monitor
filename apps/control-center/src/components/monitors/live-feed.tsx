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

export function LiveFeed({ monitorId }: { monitorId: number }) {
    const [items, setItems] = useState<ItemData[]>([]);
    const [loading, setLoading] = useState(true);
    const { decrementItemCount, incrementItemCount } = useMonitorLiveContext();
    const seenItemIds = useRef<Set<string>>(new Set());

    useEffect(() => {
        const fetchItems = async () => {
            try {
                const res = await fetch(`/api/monitors/${monitorId}/items`);
                if (res.ok) {
                    const data: ItemData[] = await res.json();
                    const cappedItems = capFeedItems(
                        data.map((i) => ({ ...i, isLive: false })),
                        MONITOR_LIVE_FEED_ITEM_CAP,
                    );
                    seenItemIds.current = new Set(
                        cappedItems.map((item) => String(item.id)),
                    );
                    setItems(cappedItems);
                }
            } catch (err) {
                console.error("Fetch error", err);
            } finally {
                setLoading(false);
            }
        };
        fetchItems();
    }, [incrementItemCount, monitorId]);

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
