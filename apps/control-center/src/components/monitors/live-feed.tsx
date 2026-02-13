"use client";

import { useEffect, useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ImageOff, Search } from "lucide-react";

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
    const interval = setInterval(fetchItems, 2000);
    return () => clearInterval(interval);
  }, [monitorId]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
        
        {loading && items.length === 0 ? (
            [...Array(5)].map((_, i) => (
                <div key={i} className="h-[300px] bg-slate-100 rounded-xl animate-pulse" />
            ))
        ) : items.map((item) => (
          <div 
            key={item.id} 
            className="group relative bg-white border border-slate-200 rounded-xl overflow-hidden hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col"
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
            </div>

            <div className="p-3 flex flex-col flex-1 gap-2">
                <div className="flex justify-between items-center text-xs text-slate-400">
                    <span className="font-mono">
                        {new Date(item.found_at).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' })}
                    </span>
                    <span className="text-[10px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded uppercase tracking-wider">
                        Found
                    </span>
                </div>

                <h3 className="font-semibold text-sm leading-tight line-clamp-2 text-slate-800 min-h-[2.5rem]" title={item.title || ""}>
                    {item.title || "Untitled Item"}
                </h3>

                <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
                    {item.size && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 h-5 font-normal bg-slate-100 text-slate-600 hover:bg-slate-200 border-0">
                            {item.size}
                        </Badge>
                    )}
                    {item.condition && (
                        <span className="text-[10px] px-1.5 h-5 flex items-center rounded border border-slate-100 text-slate-500 bg-white">
                            {item.condition}
                        </span>
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

        {items.length === 0 && !loading && (
             <div className="col-span-full py-24 flex flex-col items-center justify-center text-center border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
                <div className="bg-white p-4 rounded-full shadow-sm mb-4">
                    <Search className="w-8 h-8 text-slate-300" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Waiting for items...</h3>
                <p className="text-slate-500 text-sm max-w-sm mt-1">
                    Worker is running. New items will appear here automatically.
                </p>
             </div>
        )}
      </div>
    </div>
  );
}
