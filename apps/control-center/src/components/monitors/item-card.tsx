"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ImageOff, Heart, MessageCircle, Send, Loader2, XIcon } from "lucide-react";
import Link from "next/link";
import { useVintedAccount } from "@/components/account-provider";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ItemData = {
  id: string;
  monitor_id: number;
  title: string | null;
  brand?: string | null;
  price: string | null;
  total_price: string | null;
  size: string | null;
  condition: string | null;
  url: string | null;
  image_url: string | null;
  extra_images?: string[] | null;
  found_at: string;
  monitor_name?: string;
  isLive?: boolean;
  location: string | null;
  rating: string | null;
  seller_id: string | null;
};

interface ItemCardProps {
  item: ItemData;
  showMonitor?: boolean;
}

export function ItemCard({ item, showMonitor = false }: ItemCardProps) {
  const { linked, likedIds, addLike, removeLike } = useVintedAccount();
  const liked = likedIds.has(Number(item.id));
  const [liking, setLiking] = useState(false);
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedImg, setSelectedImg] = useState<string | null>(null);

  const timeStr = new Date(item.found_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!linked) {
      toast.error("Link your Vinted account first (Account tab)");
      return;
    }
    setLiking(true);
    try {
      const endpoint = liked ? "/api/items/unlike" : "/api/items/like";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: Number(item.id) }),
      });
      if (res.ok) {
        if (liked) {
          removeLike(Number(item.id));
        } else {
          addLike(Number(item.id));
        }
        toast.success(liked ? "Unliked" : "Liked!");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Like failed (${res.status})`);
      }
    } catch (err) {
      toast.error("Network error — could not reach server");
    }
    setLiking(false);
  };

  const handleSendMessage = async () => {
    if (!linked) {
      toast.error("Link your Vinted account first (Account tab)");
      return;
    }
    if (!msgText.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: Number(item.id),
          seller_id: Number(item.seller_id),
          message: msgText.trim(),
        }),
      });
      if (res.ok) {
        toast.success("Message sent!");
        setMsgOpen(false);
        setMsgText("");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Send failed (${res.status})`);
      }
    } catch {
      toast.error("Network error — could not reach server");
    }
    setSending(false);
  };

  return (
    <div
      className={`group relative bg-white border border-slate-200/80 rounded-xl overflow-hidden transition-all duration-300 flex flex-col hover:shadow-md hover:border-slate-300 ${
        item.isLive
          ? "animate-in fade-in slide-in-from-top-2 duration-500 ring-2 ring-emerald-500/30 shadow-emerald-100 shadow-md"
          : ""
      }`}
    >
      <div className="relative aspect-4/5 bg-slate-100 overflow-hidden">
        {item.image_url ? (
          item.extra_images && item.extra_images.length > 0 ? (
            <div className="w-full h-full flexgap-0.5">
              <div
                className="flex-2 h-full overflow-hidden cursor-pointer"
                onClick={() => setSelectedImg(item.image_url)}
              >
                <img
                  src={item.image_url}
                  alt={item.title || "Item"}
                  className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                  loading="lazy"
                />
              </div>
              <div className="flex-1 h-full flex flex-col gap-0.5">
                {item.extra_images.slice(0, 2).map((img, idx) => (
                  <div
                    key={idx}
                    className="flex-1 overflow-hidden bg-slate-200 cursor-pointer"
                    onClick={() => setSelectedImg(img)}
                  >
                    <img
                      src={img}
                      alt={`${item.title} ${idx + 1}`}
                      className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                      loading="lazy"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              className="w-full h-full cursor-pointer"
              onClick={() => setSelectedImg(item.image_url)}
            >
              <img
                src={item.image_url}
                alt={item.title || "Item"}
                className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                loading="lazy"
              />
            </div>
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300">
            <ImageOff className="w-8 h-8" />
          </div>
        )}

        <div className="absolute bottom-2.5 right-2.5 flex flex-col items-end gap-1">
          <span className="bg-white/95 backdrop-blur-sm shadow-sm text-slate-900 font-bold px-2.5 py-1 rounded-lg text-sm">
            {item.price}
          </span>
          {item.total_price && (
            <span className="bg-slate-900/70 backdrop-blur-sm text-white/90 text-[12px] font-medium px-2 py-1 rounded-md">
              {item.total_price} inkl.
            </span>
          )}
        </div>

        {item.isLive && (
          <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 bg-emerald-500 text-white text-[10px] font-semibold px-2 py-1 rounded-md shadow-lg">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
            </span>
            NEW
          </div>
        )}

        <div className="absolute top-2.5 right-2.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          {linked && (
            <button
              onClick={handleLike}
              disabled={liking}
              className={`w-7 h-7 rounded-full flex items-center justify-center shadow-md transition-colors ${
                liked
                  ? "bg-red-500 text-white"
                  : "bg-white/90 text-slate-600 hover:text-red-500 hover:bg-white"
              }`}
              title={liked ? "Unlike" : "Like"}
            >
              <Heart className={`w-3.5 h-3.5 ${liked ? "fill-current" : ""}`} />
            </button>
          )}
          {linked && item.seller_id && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setMsgOpen(true);
              }}
              className="w-7 h-7 rounded-full flex items-center justify-center shadow-md bg-white/90 text-slate-600 hover:text-blue-500 hover:bg-white transition-colors"
              title="Send message to seller"
            >
              <MessageCircle className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="p-3.5 flex flex-col flex-1 gap-2">
        <div className="flex justify-between items-center">
          {showMonitor ? (
            <Link
              href={`/monitors/${item.monitor_id}`}
              className="hover:underline z-10"
            >
              <span className="text-[11px] font-medium text-slate-400 hover:text-blue-600 transition-colors truncate max-w-35 block">
                {item.monitor_name || `Monitor #${item.monitor_id}`}
              </span>
            </Link>
          ) : (
            <span className="text-[11px] font-mono text-slate-400">
              {timeStr}
            </span>
          )}
          {showMonitor && (
            <span className="text-[11px] font-mono text-slate-400">
              {timeStr}
            </span>
          )}
        </div>

        <h3
          className="font-semibold text-[13px] leading-snug line-clamp-2 text-slate-800 min-h-10"
          title={item.title || ""}
        >
          {item.title || "Untitled"}
        </h3>

        <div className="flex flex-wrap gap-1.5 mt-auto pt-1">
          {item.brand && (
            <span className="text-[10px] px-1.5 h-5 flex items-center rounded bg-slate-50 text-slate-500 font-medium">
              {item.brand}
            </span>
          )}
          {item.size && (
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 h-5 font-normal bg-slate-100 text-slate-600 border-0"
            >
              {item.size}
            </Badge>
          )}
          {item.location && (
            <span className="text-[10px] px-1.5 h-5 flex items-center rounded bg-slate-50 text-slate-500">
              {item.location}
            </span>
          )}
          {item.rating && (
            <span className="text-[10px] px-1.5 h-5 flex items-center rounded bg-amber-50 text-amber-700 font-medium">
              {item.rating}
            </span>
          )}
          {item.condition && (
            <span className="text-[10px] px-1.5 h-5 flex items-center rounded bg-slate-50 text-slate-500">
              {item.condition}
            </span>
          )}
        </div>
      </div>

      <a
        href={item.url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 bg-slate-900 text-white py-2.5 text-xs font-medium tracking-wide hover:bg-slate-800 transition-colors"
      >
        View on Vinted
        <ExternalLink className="w-3 h-3" />
      </a>

      <Dialog open={msgOpen} onOpenChange={setMsgOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Message</DialogTitle>
            <DialogDescription>
              Send a message to the seller of &quot;{item.title || "this item"}&quot;
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={msgText}
            onChange={(e) => setMsgText(e.target.value)}
            placeholder="Write your message..."
            maxLength={2000}
            rows={4}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 resize-none"
          />
          <DialogFooter>
            <Button
              onClick={handleSendMessage}
              disabled={sending || !msgText.trim()}
              className="gap-1.5"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              {sending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedImg} onOpenChange={(open) => !open && setSelectedImg(null)}>
        <DialogContent showCloseButton={false} className="max-w-[90vw] max-h-[90vh] p-0 border-none bg-transparent shadow-none flex items-center justify-center outline-none">
          <button 
            onClick={() => setSelectedImg(null)}
            className="fixed top-6 right-6 z-60 w-12 h-12 rounded-full bg-black/20 backdrop-blur-xl border border-white/10 text-white flex items-center justify-center hover:bg-black/40 transition-all hover:scale-110 active:scale-95 shadow-2xl group"
          >
            <XIcon className="w-6 h-6 transition-transform group-hover:rotate-90" />
          </button>
          {selectedImg && (
            <img
              src={selectedImg}
              alt="Preview"
              className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] animate-in zoom-in-95 duration-300"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ItemCardSkeleton() {
  return (
    <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden flex flex-col">
      <div className="aspect-4/5 bg-slate-100 animate-pulse" />
      <div className="p-3.5 space-y-2.5">
        <div className="h-3 bg-slate-100 rounded animate-pulse w-1/3" />
        <div className="h-4 bg-slate-100 rounded animate-pulse w-3/4" />
        <div className="h-4 bg-slate-100 rounded animate-pulse w-1/2" />
        <div className="flex gap-1.5 pt-1">
          <div className="h-5 w-10 bg-slate-100 rounded animate-pulse" />
          <div className="h-5 w-14 bg-slate-100 rounded animate-pulse" />
        </div>
      </div>
      <div className="h-10 bg-slate-200 animate-pulse" />
    </div>
  );
}
