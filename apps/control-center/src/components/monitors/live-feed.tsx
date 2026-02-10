"use client";

import { useEffect, useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, ImageOff } from "lucide-react";

type Item = {
  id: string;
  title: string | null;
  price: string | null;
  size: string | null;
  condition: string | null;
  url: string | null;
  image_url: string | null;
  found_at: string;
};

export function LiveFeed({ monitorId }: { monitorId: number }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  
  const lastDataRef = useRef<string>("");

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const res = await fetch(`/api/monitors/${monitorId}/items?t=${Date.now()}`);
        if (res.ok) {
          const data: Item[] = await res.json();
          const dataString = JSON.stringify(data);
          
          if (dataString !== lastDataRef.current) {
             setItems(data);
             lastDataRef.current = dataString;
          }
        }
      } catch (err) {
        console.error("Polling error", err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
    const interval = setInterval(fetchItems, 1000);
    return () => clearInterval(interval);
  }, [monitorId]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border">
         <h2 className="font-semibold flex items-center gap-2">
            Live Feed <Badge variant="secondary" className="rounded-full px-2">{items.length}</Badge>
         </h2>
         <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
            </span>
            <span className="text-xs font-mono text-green-700 font-bold uppercase">Connected</span>
         </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {loading && items.length === 0 ? (
            [...Array(4)].map((_, i) => (
                <div key={i} className="h-64 bg-slate-100 rounded-xl animate-pulse" />
            ))
        ) : items.map((item) => (
          <div 
            key={item.id} 
            className="group relative bg-white border border-slate-200 rounded-xl overflow-hidden hover:shadow-lg transition-all duration-300 flex flex-col"
          >

            <div className="relative aspect-square bg-slate-100 overflow-hidden">
              {item.image_url ? (
                <img 
                    src={item.image_url} 
                    alt="Item" 
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
                    loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-300"><ImageOff size={24} /></div>
              )}
              
              <div className="absolute bottom-2 right-2 bg-white/90 backdrop-blur shadow-sm text-slate-900 font-bold px-2 py-0.5 rounded text-sm border">
                  {item.price}
              </div>
            </div>

            <div className="p-3 flex flex-col flex-1 gap-1.5">
              <h3 className="font-semibold text-sm leading-tight line-clamp-2 text-slate-900" title={item.title || ""}>
                  {item.title || "Untitled Item"}
              </h3>
              
              <div className="flex flex-wrap gap-1 mt-auto">
                 {item.size && <Badge variant="secondary" className="text-[10px] px-1.5 h-5 font-normal border-0 bg-slate-100">{item.size}</Badge>}
                 {item.condition && <span className="text-[10px] px-1.5 h-5 flex items-center rounded border border-slate-100 text-slate-500 bg-white">{item.condition}</span>}
              </div>

              <div className="text-[10px] text-gray-400 font-mono text-right mt-1">
                 {new Date(item.found_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}
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

        {items.length === 0 && !loading && (
            <div className="col-span-full text-center py-24 bg-slate-50/50 rounded-xl border-2 border-dashed">
                <p className="text-muted-foreground font-medium">Waiting for new items...</p>
                <div className="flex justify-center mt-4 mb-2">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-400"></div>
                </div>
                <p className="text-xs text-gray-400">Worker is scanning in background.</p>
            </div>
        )}
      </div>
    </div>
  );
}
