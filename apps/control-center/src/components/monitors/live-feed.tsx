"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { ItemCard, ItemCardSkeleton, type ItemData } from "@/components/monitors/item-card";

export function LiveFeed({ monitorId }: { monitorId: number }) {
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const res = await fetch(`/api/monitors/${monitorId}/items`);
        if (res.ok) {
          const data: ItemData[] = await res.json();
          setItems(data.map((i) => ({ ...i, isLive: false })));
        }
      } catch (err) {
        console.error("Fetch error", err);
      } finally {
        setLoading(false);
      }
    };
    fetchItems();
  }, [monitorId]);

  useEffect(() => {
    const eventSource = new EventSource("/api/stream");

    eventSource.onmessage = (event) => {
      try {
        const newItem: ItemData = JSON.parse(event.data);

        if (newItem.monitor_id === monitorId) {
          const liveItem: ItemData = { ...newItem, id: String(newItem.id), isLive: true };

          setItems((prev) => {
            if (prev.some((i) => String(i.id) === String(newItem.id))) return prev;
            return [liveItem, ...prev];
          });

          setTimeout(() => {
            setItems((curr) =>
              curr.map((item) =>
                String(item.id) === String(newItem.id) ? { ...item, isLive: false } : item
              )
            );
          }, 10000);
        }
      } catch (e) {
        console.error("SSE Parse Error", e);
      }
    };

    return () => eventSource.close();
  }, [monitorId]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
      {loading && items.length === 0
        ? [...Array(5)].map((_, i) => <ItemCardSkeleton key={i} />)
        : items.map((item) => <ItemCard key={item.id} item={item} />)}

      {items.length === 0 && !loading && (
        <div className="col-span-full flex flex-col items-center justify-center py-20 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
          <div className="bg-slate-100 p-3 rounded-xl mb-4">
            <Search className="w-6 h-6 text-slate-400" />
          </div>
          <h3 className="text-base font-semibold text-slate-800">
            Waiting for items...
          </h3>
          <p className="text-sm text-slate-500 mt-1 max-w-sm text-center">
            Items will appear here in real-time as the worker finds them.
          </p>
        </div>
      )}
    </div>
  );
}
