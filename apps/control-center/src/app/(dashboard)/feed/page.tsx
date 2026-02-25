"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { ItemCard, ItemCardSkeleton, type ItemData } from "@/components/monitors/item-card";

export default function FeedPage() {
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const res = await fetch("/api/feed");
        if (res.ok) {
          const data: ItemData[] = await res.json();
          setItems(data.map((i) => ({ ...i, isLive: false })));
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchFeed();
  }, []);

  useEffect(() => {
    const eventSource = new EventSource("/api/stream");

    eventSource.onmessage = (event) => {
      try {
        const newItem: ItemData = JSON.parse(event.data);
        const liveItem: ItemData = {
          ...newItem,
          isLive: true,
          monitor_name:
            newItem.monitor_name || `Monitor #${newItem.monitor_id}`,
        };

        setItems((prev) => {
          const newId = String(newItem.id);
          if (prev.some((i) => String(i.id) === newId)) return prev;
          return [{ ...liveItem, id: newId }, ...prev];
        });

        setTimeout(() => {
          setItems((curr) =>
            curr.map((item) =>
              String(item.id) === String(newItem.id) ? { ...item, isLive: false } : item
            )
          );
        }, 30000);
      } catch (e) {
        console.error("SSE Error", e);
      }
    };

    return () => eventSource.close();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Feed</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Real-time stream across all your monitors.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-emerald-600 font-medium bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-100">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        {loading && items.length === 0
          ? [...Array(8)].map((_, i) => <ItemCardSkeleton key={i} />)
          : items.map((item) => (
              <ItemCard key={item.id} item={item} showMonitor />
            ))}
      </div>

      {items.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
          <div className="bg-slate-100 p-3 rounded-xl mb-4">
            <Search className="w-6 h-6 text-slate-400" />
          </div>
          <h3 className="text-base font-semibold text-slate-800">
            Waiting for items...
          </h3>
          <p className="text-sm text-slate-500 mt-1 max-w-sm text-center">
            New items will appear here in real-time as your monitors find them.
          </p>
        </div>
      )}
    </div>
  );
}
