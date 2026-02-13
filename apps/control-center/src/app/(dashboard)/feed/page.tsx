"use client";

import { useEffect, useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ImageOff, Search } from "lucide-react";
import Link from "next/link";

type Item = {
  id: string;
  monitor_id: number;
  title: string | null;
  price: string | null;
  size: string | null;
  condition: string | null;
  url: string | null;
  image_url: string | null;
  found_at: string;
  monitor_name?: string;
  isLive?: boolean;
};

export default function FeedPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const res = await fetch("/api/feed");
        if (res.ok) {
          const data: Item[] = await res.json();
          const historic = data.map(i => ({ ...i, isLive: false }));
          setItems(historic);
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
        const newItem: Item = JSON.parse(event.data);
        const liveItem = { 
            ...newItem, 
            isLive: true,
            monitor_name: newItem.monitor_name || `Monitor #${newItem.monitor_id}` 
        };

        setItems((prev) => {
          if (prev.some((i) => i.id === newItem.id)) return prev;
    
          return [liveItem, ...prev];
        });
    
        setTimeout(() => {
            setItems(currentItems => 
                currentItems.map(item => 
                    item.id === newItem.id ? { ...item, isLive: false } : item
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
    <div className="p-8 space-y-6 max-w-400 mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
         <div>
            <h1 className="text-3xl font-bold flex items-center gap-2 tracking-tight">
                Live Feed
            </h1>
            <p className="text-muted-foreground mt-1">
                Real-time stream of all items found by your monitors.
            </p>
         </div>
         <div className="flex items-center gap-2 bg-blue-50 px-3 py-1 rounded-full border border-blue-100 animate-pulse">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
            </span>
            <span className="font-mono text-xs font-bold text-blue-600 uppercase tracking-wider">WebSocket Live</span>
         </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
        {loading && items.length === 0 ? (
            [...Array(8)].map((_, i) => (
                <div key={i} className="h-75 bg-slate-100 rounded-xl animate-pulse" />
            ))
        ) : items.map((item) => (
          <div 
            key={item.id} 
            className={`group relative bg-white border border-slate-200 rounded-xl overflow-hidden hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col ${item.isLive ? 'animate-in fade-in zoom-in duration-500 ring-2 ring-red-500/20' : ''}`}
          >
            <div className="relative aspect-square bg-slate-50 overflow-hidden">
                {item.image_url ? (
                    <img 
                        src={item.image_url} 
                        alt={item.title || "Item"} 
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
                        loading="lazy" 
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-300">
                        <ImageOff className="w-10 h-10" />
                    </div>
                )}
                
                <div className="absolute bottom-2 right-2 bg-white/95 backdrop-blur-sm shadow-sm text-slate-900 font-bold px-2 py-1 rounded-lg text-sm border">
                    {item.price}
                </div>
                {item.isLive && (
                   <div className="absolute top-2 left-2 z-10 bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-lg animate-pulse uppercase tracking-wider">
                     LIVE NEW
                   </div>
                )}
            </div>

            <div className="p-3 flex flex-col flex-1 gap-2">
                <div className="flex justify-between items-center">
                    <Link href={`/monitors/${item.monitor_id}`} className="hover:underline z-10">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1 hover:text-blue-500 transition-colors">
                            <Search className="w-3 h-3" /> 
                            {item.monitor_name || `Monitor #${item.monitor_id}`}
                        </span>
                    </Link>
                    <span className="text-[10px] text-slate-400 font-mono">
                        {new Date(item.found_at).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' })}
                    </span>
                </div>

                <h3 className="font-semibold text-sm leading-tight line-clamp-2 text-slate-800 min-h-10" title={item.title || ""}>
                    {item.title || "Untitled"}
                </h3>

                <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
                    {item.size && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 h-5 font-normal bg-slate-100 text-slate-600 hover:bg-slate-200 border-0">
                            {item.size}
                        </Badge>
                    )}
                </div>
            </div>

            <a 
                href={item.url || "#"} 
                target="_blank" 
                rel="noopener noreferrer"
                className="block bg-slate-900 text-white text-center py-2.5 text-xs font-semibold uppercase tracking-wide hover:bg-blue-600 transition-colors"
            >
                View on Vinted <ExternalLink className="inline-block w-3 h-3 mb-0.5 ml-1" />
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
