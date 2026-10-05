"use client";

import { memo, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
    ExternalLink,
    ImageOff,
    Heart,
    MessageCircle,
    Send,
    Loader2,
    XIcon,
    ChevronLeft,
    ChevronRight,
    Tag,
    ShoppingCart,
    UserX,
    Images,
    MapPin,
    Clock3,
    UserRound,
} from "lucide-react";
import Link from "next/link";
import { useVintedAccount } from "@/components/account-provider";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openItemCheckout } from "@/lib/open-checkout";
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
    monitor_name?: string | null;
    isLive?: boolean;
    location: string | null;
    rating: string | null;
    seller_id: string | null;
    seller_login?: string | null;
    seller_profile_url?: string | null;
};

interface ItemCardProps {
    item: ItemData;
    showMonitor?: boolean;
    onSellerBanned?: (sellerId: string) => void;
}

function getMonitorLabel(item: ItemData) {
    const name = item.monitor_name?.trim();
    return name
        ? `${name} (${item.monitor_id})`
        : `Monitor #${item.monitor_id}`;
}

function buildSellerProfileUrl(item: ItemData) {
    if (!item.seller_id) return null;
    if (item.seller_profile_url) return item.seller_profile_url;
    let host = "www.vinted.de";
    if (item.url) {
        try {
            host = new URL(item.url).host;
        } catch {}
    }
    const sellerPath = item.seller_login
        ? `${item.seller_id}-${item.seller_login}`
        : item.seller_id;
    return `https://${host}/member/${sellerPath}`;
}

function ItemCardComponent({
    item,
    showMonitor = false,
    onSellerBanned,
}: ItemCardProps) {
    const { linked, likedIds, addLike, removeLike } = useVintedAccount();
    const liked = likedIds.has(Number(item.id));
    const [liking, setLiking] = useState(false);
    const [msgOpen, setMsgOpen] = useState(false);
    const [msgText, setMsgText] = useState("");
    const [sending, setSending] = useState(false);
    const [offerOpen, setOfferOpen] = useState(false);
    const [offerPrice, setOfferPrice] = useState("");
    const [sendingOffer, setSendingOffer] = useState(false);
    const [buying, setBuying] = useState(false);
    const [banningSeller, setBanningSeller] = useState(false);
    const [banDialogOpen, setBanDialogOpen] = useState(false);
    const [selectedImgIndex, setSelectedImgIndex] = useState<number | null>(
        null,
    );

    const allImages = item.image_url
        ? [item.image_url, ...(item.extra_images || [])]
        : [];
    const hasDifferentTotalPrice =
        Boolean(item.total_price) && item.total_price !== item.price;
    const sellerProfileUrl = buildSellerProfileUrl(item);
    const sellerLabel = item.seller_login
        ? `@${item.seller_login}`
        : item.seller_id
          ? `Seller ${item.seller_id}`
          : null;

    const handleNextImage = (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setSelectedImgIndex((prev) =>
            prev === null ? prev : (prev + 1) % allImages.length,
        );
    };

    const handlePrevImage = (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setSelectedImgIndex((prev) =>
            prev === null
                ? prev
                : (prev - 1 + allImages.length) % allImages.length,
        );
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (selectedImgIndex !== null) {
                if (e.key === "ArrowRight") {
                    setSelectedImgIndex((prev) =>
                        prev === null ? prev : (prev + 1) % allImages.length,
                    );
                }
                if (e.key === "ArrowLeft") {
                    setSelectedImgIndex((prev) =>
                        prev === null
                            ? prev
                            : (prev - 1 + allImages.length) % allImages.length,
                    );
                }
                if (e.key === "Escape") setSelectedImgIndex(null);
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selectedImgIndex, allImages.length]);

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
        } catch {
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

    const handleSendOffer = async () => {
        if (!linked) {
            toast.error("Link your Vinted account first (Account tab)");
            return;
        }
        const priceVal = parseFloat(offerPrice);
        if (isNaN(priceVal) || priceVal <= 0) {
            toast.error("Please enter a valid price");
            return;
        }

        // Vinted server-side minimum offer is 60% of the original item price
        const currentPrice = parseFloat(item.price || "0");
        if (!isNaN(currentPrice) && currentPrice > 0) {
            const minPrice = currentPrice * 0.6;
            if (priceVal < minPrice) {
                toast.error(
                    `Offer too low. Minimum allowed is €${minPrice.toFixed(2)}`,
                );
                return;
            }
        }

        setSendingOffer(true);
        try {
            const res = await fetch("/api/offers/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    item_id: Number(item.id),
                    seller_id: Number(item.seller_id),
                    price: priceVal.toString(),
                    currency: "EUR",
                }),
            });
            if (res.ok) {
                toast.success("Offer sent!");
                setOfferOpen(false);
                setOfferPrice("");
            } else {
                const data = await res.json().catch(() => ({}));
                toast.error(data.error || `Offer failed (${res.status})`);
            }
        } catch {
            toast.error("Network error — could not reach server");
        }
        setSendingOffer(false);
    };

    const handleBuy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (buying) return;
        setBuying(true);
        try {
            await openItemCheckout(item.monitor_id, Number(item.id));
            toast.success(
                "Vinted checkout opened. Review the details and confirm your purchase on Vinted.",
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Checkout could not be opened",
            );
        } finally {
            setBuying(false);
        }
    };

    const handleBanSeller = async () => {
        if (!item.seller_id) {
            toast.error("Seller information is missing");
            return;
        }

        setBanningSeller(true);
        try {
            const res = await fetch("/api/seller-bans", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    seller_id: item.seller_id,
                    seller_login: item.seller_login || null,
                    seller_profile_url: sellerProfileUrl,
                    item_url: item.url,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                toast.error(data.error || `Ban failed (${res.status})`);
                return;
            }
            onSellerBanned?.(item.seller_id);
            setBanDialogOpen(false);
            toast.success(`${sellerLabel || "Seller"} banned`);
        } catch {
            toast.error("Network error — could not ban seller");
        } finally {
            setBanningSeller(false);
        }
    };

    return (
        <div
            data-testid="item-card"
            className={`group border-border/70 bg-card hover:border-border relative flex flex-col overflow-hidden rounded-lg border transition-colors ${
                item.isLive
                    ? "animate-in slide-in-from-top-2 fade-in ring-1 ring-emerald-500/50 duration-500"
                    : ""
            }`}
        >
            <div className="bg-muted relative aspect-4/5 overflow-hidden">
                {item.image_url ? (
                    <button
                        type="button"
                        className="block h-full w-full cursor-zoom-in overflow-hidden"
                        onClick={() => setSelectedImgIndex(0)}
                        aria-label={`Open photos for ${item.title || "item"}`}
                    >
                        <img
                            src={item.image_url}
                            alt={item.title || "Item"}
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
                            loading="lazy"
                        />
                    </button>
                ) : (
                    <div className="text-muted-foreground/45 flex h-full w-full items-center justify-center">
                        <ImageOff className="h-8 w-8" />
                    </div>
                )}

                {item.isLive && (
                    <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
                        <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/60 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                        </span>
                        NEW
                    </div>
                )}

                {allImages.length > 1 && (
                    <div className="absolute top-2.5 right-2.5 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
                        <Images className="h-3 w-3" />
                        {allImages.length}
                    </div>
                )}

                <div className="absolute right-2 bottom-2 z-10 flex gap-1 rounded-lg bg-black/55 p-1 opacity-100 backdrop-blur-md transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                    {linked && (
                        <button
                            type="button"
                            onClick={handleLike}
                            disabled={liking}
                            className={cn(
                                "flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-white transition-colors",
                                liked
                                    ? "bg-red-500 text-white"
                                    : "hover:bg-white/15 hover:text-red-300",
                            )}
                            title={liked ? "Unlike" : "Like"}
                            aria-label={liked ? "Unlike item" : "Like item"}
                        >
                            <Heart
                                className={cn(
                                    "h-4 w-4",
                                    liked && "fill-current",
                                )}
                            />
                        </button>
                    )}
                    {linked && item.seller_id && (
                        <>
                            <button
                                type="button"
                                onClick={handleBuy}
                                disabled={buying}
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-white transition-colors hover:bg-white/15 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
                                title="Open Vinted checkout"
                                aria-label="Open Vinted checkout"
                            >
                                {buying ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <ShoppingCart className="h-4 w-4" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setOfferOpen(true);
                                }}
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-white transition-colors hover:bg-white/15 hover:text-emerald-300"
                                title="Make an offer"
                                aria-label="Make an offer"
                            >
                                <Tag className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setMsgOpen(true);
                                }}
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-white transition-colors hover:bg-white/15 hover:text-sky-300"
                                title="Send message to seller"
                                aria-label="Send message to seller"
                            >
                                <MessageCircle className="h-4 w-4" />
                            </button>
                        </>
                    )}
                    {item.seller_id && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                setBanDialogOpen(true);
                            }}
                            disabled={banningSeller}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-white transition-colors hover:bg-red-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                            title="Ban seller"
                            aria-label="Ban seller"
                        >
                            {banningSeller ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <UserX className="h-4 w-4" />
                            )}
                        </button>
                    )}
                </div>
            </div>

            <div className="flex flex-1 flex-col p-3.5">
                <div className="flex min-h-12 items-start justify-between gap-3">
                    <h3
                        className="text-foreground line-clamp-2 min-w-0 text-sm leading-snug font-semibold"
                        title={item.title || ""}
                    >
                        {item.title || "Untitled"}
                    </h3>
                    <div className="shrink-0 text-right">
                        <p className="text-foreground text-base font-bold tabular-nums">
                            {item.price || "—"}
                        </p>
                        {hasDifferentTotalPrice && (
                            <p className="text-muted-foreground text-[10px] tabular-nums">
                                {item.total_price} total
                            </p>
                        )}
                    </div>
                </div>

                <div className="mt-2 flex min-h-12 flex-wrap content-start gap-1.5">
                    {item.brand && (
                        <span className="border-border/60 bg-muted/40 text-foreground flex h-5 max-w-full items-center truncate rounded-md border px-1.5 text-[10px] font-medium">
                            {item.brand}
                        </span>
                    )}
                    {item.size && (
                        <Badge
                            variant="secondary"
                            className="h-5 rounded-md border border-sky-200 bg-sky-50 px-1.5 text-[10px] font-medium text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300"
                        >
                            {item.size}
                        </Badge>
                    )}
                    {item.condition && (
                        <span className="border-border/60 bg-muted/40 text-muted-foreground flex h-5 items-center rounded-md border px-1.5 text-[10px]">
                            {item.condition}
                        </span>
                    )}
                </div>

                <div className="border-border/60 mt-2 space-y-1.5 border-t pt-2">
                    <div className="text-muted-foreground flex min-w-0 items-center gap-3 text-[10px]">
                        {sellerProfileUrl && sellerLabel ? (
                            <a
                                href={sellerProfileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="hover:text-foreground flex min-w-0 items-center gap-1 transition-colors"
                                title={sellerLabel}
                            >
                                <UserRound className="h-3 w-3 shrink-0" />
                                <span className="truncate">{sellerLabel}</span>
                            </a>
                        ) : null}
                        {item.location ? (
                            <span className="flex min-w-0 items-center gap-1">
                                <MapPin className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                    {item.location}
                                </span>
                            </span>
                        ) : null}
                        {item.rating ? (
                            <span className="ml-auto shrink-0 font-medium text-amber-600 dark:text-amber-400">
                                {item.rating}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        {showMonitor ? (
                            <Link
                                href={`/monitors/${item.monitor_id}`}
                                className="z-10 max-w-[calc(100%-4.5rem)] min-w-0"
                            >
                                <span className="text-muted-foreground inline-flex max-w-full truncate text-[11px] font-medium transition-colors duration-200 hover:text-blue-400">
                                    {getMonitorLabel(item)}
                                </span>
                            </Link>
                        ) : (
                            <span />
                        )}

                        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                            <Clock3 className="h-3 w-3" />
                            {timeStr}
                        </span>
                    </div>
                </div>
            </div>

            <a
                href={item.url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="border-border/60 bg-muted/25 text-foreground hover:bg-muted flex h-10 items-center justify-center gap-1.5 border-t text-xs font-medium transition-colors"
            >
                Open listing
                <ExternalLink className="h-3 w-3" />
            </a>

            <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Ban Seller</DialogTitle>
                        <DialogDescription>
                            Hide {sellerLabel || "this seller"} from all your
                            monitor feeds and future alerts. You can unban the
                            seller later in Account.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="border-border/80 bg-muted/35 flex items-center justify-between gap-3 rounded-lg border p-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">
                                {sellerLabel || "Unknown seller"}
                            </p>
                            {item.seller_id ? (
                                <p className="text-muted-foreground mt-0.5 text-xs">
                                    Seller #{item.seller_id}
                                </p>
                            ) : null}
                        </div>
                        {sellerProfileUrl ? (
                            <Button
                                asChild
                                variant="outline"
                                size="sm"
                                className="h-8 shrink-0 gap-1.5"
                            >
                                <a
                                    href={sellerProfileUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Profile
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            </Button>
                        ) : null}
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setBanDialogOpen(false)}
                            disabled={banningSeller}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={handleBanSeller}
                            disabled={banningSeller}
                            className="gap-1.5"
                        >
                            {banningSeller ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <UserX className="h-4 w-4" />
                            )}
                            Ban Seller
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={msgOpen} onOpenChange={setMsgOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Send Message</DialogTitle>
                        <DialogDescription asChild>
                            <div className="text-muted-foreground text-sm">
                                <div className="mb-4 flex gap-5">
                                    {item.image_url ? (
                                        <div className="border-border/80 bg-muted relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border shadow-sm">
                                            <img
                                                src={item.image_url}
                                                alt={
                                                    item.title || "Item preview"
                                                }
                                                className="h-full w-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <div className="border-border/80 bg-muted flex h-24 w-20 shrink-0 items-center justify-center rounded-lg border">
                                            <ImageOff className="text-muted-foreground/45 h-8 w-8" />
                                        </div>
                                    )}
                                    <div className="flex min-w-0 flex-col justify-center gap-1.5 overflow-hidden">
                                        <p className="text-foreground line-clamp-2 leading-snug font-semibold">
                                            {item.title || "this item"}
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                            {item.brand && (
                                                <span className="bg-muted text-muted-foreground flex h-4.5 items-center rounded px-1.5 text-[10px] font-medium">
                                                    {item.brand}
                                                </span>
                                            )}
                                            {item.size && (
                                                <span className="flex h-4.5 items-center rounded border border-blue-100/50 bg-blue-50 px-1.5 text-[10px] font-medium text-blue-600 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400">
                                                    {item.size}
                                                </span>
                                            )}
                                            {item.condition && (
                                                <span className="border-border/70 bg-muted text-muted-foreground flex h-4.5 items-center rounded border px-1.5 text-[10px]">
                                                    {item.condition}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {item.location && (
                                                <span className="bg-muted text-muted-foreground flex h-4.5 items-center rounded px-1.5 text-[10px]">
                                                    {item.location}
                                                </span>
                                            )}
                                            {item.rating && (
                                                <span className="flex h-4.5 items-center rounded border border-amber-200 bg-amber-50 px-1.5 text-[10px] font-medium text-amber-600 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
                                                    ★ {item.rating}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="border-border/70 bg-muted/45 mb-4 flex items-center justify-between rounded-lg border p-2.5">
                                    <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                        Price
                                    </span>
                                    <div className="text-right">
                                        <span className="text-foreground text-base font-bold">
                                            €{item.price || "0.00"}
                                        </span>
                                        {hasDifferentTotalPrice && (
                                            <span className="text-muted-foreground block text-[10px]">
                                                Incl. fees: €{item.total_price}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <p className="text-muted-foreground">
                                    Send a message to the seller of &quot;
                                    {item.title || "this item"}&quot;
                                </p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <textarea
                        value={msgText}
                        onChange={(e) => setMsgText(e.target.value)}
                        placeholder="Write your message..."
                        maxLength={2000}
                        rows={4}
                        className="border-border bg-background placeholder:text-muted-foreground focus:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-offset-1 focus:outline-none"
                    />
                    <DialogFooter>
                        <Button
                            onClick={handleSendMessage}
                            disabled={sending || !msgText.trim()}
                            className="gap-1.5"
                        >
                            {sending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Send className="h-4 w-4" />
                            )}
                            {sending ? "Sending..." : "Send"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={offerOpen} onOpenChange={setOfferOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Make an Offer</DialogTitle>
                        <DialogDescription asChild>
                            <div className="text-muted-foreground text-sm">
                                <div className="mb-3 flex gap-5">
                                    {item.image_url ? (
                                        <div className="border-border/80 bg-muted relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border shadow-sm">
                                            <img
                                                src={item.image_url}
                                                alt={
                                                    item.title || "Item preview"
                                                }
                                                className="h-full w-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <div className="border-border/80 bg-muted flex h-24 w-20 shrink-0 items-center justify-center rounded-lg border">
                                            <ImageOff className="text-muted-foreground/45 h-8 w-8" />
                                        </div>
                                    )}
                                    <div className="flex min-w-0 flex-col justify-center gap-1.5 overflow-hidden">
                                        <p className="text-foreground line-clamp-2 leading-snug font-semibold">
                                            {item.title || "this item"}
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                            {item.brand && (
                                                <span className="bg-muted text-muted-foreground flex h-4.5 items-center rounded px-1.5 text-[10px] font-medium">
                                                    {item.brand}
                                                </span>
                                            )}
                                            {item.size && (
                                                <span className="flex h-4.5 items-center rounded border border-blue-500/20 bg-blue-500/10 px-1.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                                                    {item.size}
                                                </span>
                                            )}
                                            {item.condition && (
                                                <span className="border-border/70 bg-muted text-muted-foreground flex h-4.5 items-center rounded border px-1.5 text-[10px]">
                                                    {item.condition}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {item.location && (
                                                <span className="bg-muted text-muted-foreground flex h-4.5 items-center rounded px-1.5 text-[10px]">
                                                    {item.location}
                                                </span>
                                            )}
                                            {item.rating && (
                                                <span className="flex h-4.5 items-center rounded border border-amber-200/70 bg-amber-50 px-1.5 text-[10px] font-medium text-amber-600 dark:border-amber-500/20 dark:bg-amber-900/20 dark:text-amber-400">
                                                    ★ {item.rating}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="border-border/70 bg-muted/45 flex items-center justify-between rounded-lg border p-2.5">
                                    <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                        Original Price
                                    </span>
                                    <div className="text-right">
                                        <span className="text-foreground text-base font-bold">
                                            €{item.price || "0.00"}
                                        </span>
                                        {hasDifferentTotalPrice && (
                                            <span className="text-muted-foreground block text-[10px]">
                                                Incl. fees: €{item.total_price}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="relative">
                        <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2">
                            €
                        </span>
                        <input
                            type="number"
                            step="0.01"
                            min="1"
                            value={offerPrice}
                            onChange={(e) => setOfferPrice(e.target.value)}
                            placeholder={`e.g. ${(parseFloat(item.price || "0") * 0.9).toFixed(2)}`}
                            className="border-border bg-background placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border py-2 pr-3 pl-8 text-sm focus:ring-2 focus:ring-offset-1 focus:outline-none"
                        />
                    </div>
                    <div className="flex w-full gap-2 pt-1">
                        {[5, 10, 15].map((discount) => {
                            const currentPrice = parseFloat(item.price || "0");
                            if (isNaN(currentPrice) || currentPrice <= 0)
                                return null;
                            const discountedPrice = (
                                currentPrice *
                                (1 - discount / 100)
                            ).toFixed(2);

                            return (
                                <Button
                                    key={discount}
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        setOfferPrice(discountedPrice)
                                    }
                                    className="flex-1 text-xs"
                                >
                                    -{discount}% (€{discountedPrice})
                                </Button>
                            );
                        })}
                    </div>
                    <DialogFooter>
                        <Button
                            onClick={handleSendOffer}
                            disabled={sendingOffer || !offerPrice.trim()}
                            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                        >
                            {sendingOffer ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Tag className="h-4 w-4" />
                            )}
                            {sendingOffer ? "Sending..." : "Send Offer"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={selectedImgIndex !== null}
                onOpenChange={(open) => !open && setSelectedImgIndex(null)}
            >
                <DialogContent
                    showCloseButton={false}
                    className="flex max-h-[90vh] max-w-[90vw] items-center justify-center border-none bg-transparent p-0 shadow-none outline-none"
                >
                    <button
                        onClick={() => setSelectedImgIndex(null)}
                        className="group fixed top-6 right-6 z-60 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-black/20 text-white shadow-2xl backdrop-blur-xl transition-all hover:scale-110 hover:bg-black/40 active:scale-95"
                    >
                        <XIcon className="h-6 w-6 transition-transform group-hover:rotate-90" />
                    </button>

                    {selectedImgIndex !== null && allImages.length > 1 && (
                        <>
                            <button
                                onClick={handlePrevImage}
                                className="fixed top-1/2 left-6 z-60 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-black/20 text-white shadow-2xl backdrop-blur-xl transition-all hover:scale-110 hover:bg-black/40 active:scale-95"
                            >
                                <ChevronLeft className="h-6 w-6 pr-0.5" />
                            </button>
                            <button
                                onClick={handleNextImage}
                                className="fixed top-1/2 right-6 z-60 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-black/20 text-white shadow-2xl backdrop-blur-xl transition-all hover:scale-110 hover:bg-black/40 active:scale-95"
                            >
                                <ChevronRight className="h-6 w-6 pl-0.5" />
                            </button>
                        </>
                    )}

                    {selectedImgIndex !== null && (
                        <img
                            src={allImages[selectedImgIndex]}
                            alt="Preview"
                            className="animate-in zoom-in-95 max-h-[90vh] max-w-full rounded-xl object-contain shadow-[0_0_50px_rgba(0,0,0,0.5)] duration-300"
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

export const ItemCard = memo(
    ItemCardComponent,
    (prevProps, nextProps) =>
        prevProps.showMonitor === nextProps.showMonitor &&
        prevProps.item === nextProps.item,
);

ItemCard.displayName = "ItemCard";

export function ItemCardSkeleton() {
    return (
        <div className="border-border/70 bg-card flex flex-col overflow-hidden rounded-lg border">
            <div className="bg-muted aspect-4/5 animate-pulse" />
            <div className="space-y-3 p-3.5">
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                        <div className="bg-muted h-4 w-32 animate-pulse rounded" />
                        <div className="bg-muted h-4 w-24 animate-pulse rounded" />
                    </div>
                    <div className="bg-muted h-5 w-12 animate-pulse rounded" />
                </div>
                <div className="flex gap-1.5 pt-1">
                    <div className="bg-muted h-5 w-10 animate-pulse rounded" />
                    <div className="bg-muted h-5 w-14 animate-pulse rounded" />
                </div>
                <div className="border-border/60 flex justify-between border-t pt-3">
                    <div className="bg-muted h-3 w-20 animate-pulse rounded" />
                    <div className="bg-muted h-3 w-10 animate-pulse rounded" />
                </div>
            </div>
            <div className="bg-muted/60 h-10 animate-pulse border-t" />
        </div>
    );
}
