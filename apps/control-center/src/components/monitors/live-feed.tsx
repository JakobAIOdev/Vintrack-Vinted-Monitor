"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const res = await fetch(`/api/monitors/${monitorId}/items?t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          setItems(data);
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

  if (loading && items.length === 0) return <div className="p-10 text-center">Lade Feed...</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
         <h2 className="text-xl font-bold">Live Feed ({items.length})</h2>
         <Badge variant="outline" className="animate-pulse bg-green-50 text-green-700">● Live Updates</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {items.map((item) => (
          <div key={item.id} className="bg-white border rounded-lg p-4 shadow-sm flex gap-4 hover:shadow-md transition-shadow animate-in slide-in-from-top-2 duration-300">
            <div className="w-24 h-24 flex-shrink-0 bg-gray-100 rounded-md overflow-hidden border">
              {item.image_url ? (
                <img src={item.image_url} alt="Item" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400"><ImageOff size={20} /></div>
              )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col justify-between">
              <div>
                <h3 className="font-semibold text-lg truncate" title={item.title || ""}>{item.title}</h3>
                <div className="flex gap-2 mt-1 text-sm text-gray-500">
                   {item.size && <Badge variant="secondary">{item.size}</Badge>}
                   {item.condition && <span className="text-xs border px-2 py-0.5 rounded">{item.condition}</span>}
                </div>
              </div>
              
              <div className="flex justify-between items-end mt-2">
                 <div className="text-xl font-bold text-green-600">{item.price}</div>
                 <div className="text-xs text-gray-400">
                    {new Date(item.found_at).toLocaleTimeString()}
                 </div>
              </div>
            </div>

            <div className="flex items-center">
               <a href={item.url || "#"} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" className="gap-2">
                    Kaufen <ExternalLink size={14} />
                  </Button>
               </a>
            </div>
          </div>
        ))}

        {items.length === 0 && (
            <div className="text-center py-20 bg-slate-50 rounded border border-dashed">
                <p className="text-muted-foreground">Warte auf neue Items...</p>
                <p className="text-xs text-gray-400 mt-1">Der Worker scannt im Hintergrund.</p>
            </div>
        )}
      </div>
    </div>
  );
}
