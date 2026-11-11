"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
    Eye,
    Heart,
    Layers3,
    RefreshCw,
    Store,
} from "lucide-react";
import { useVintedAccount } from "@/components/account-provider";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type WardrobeItem = {
    id: number;
    title: string;
    is_draft: boolean;
    is_closed: boolean;
    is_reserved: boolean;
    is_hidden: boolean;
    promoted: boolean;
    can_push_up: boolean;
    can_edit: boolean;
    stats_visible: boolean;
    view_count: number;
    favourite_count: number;
    status: string;
    size: string;
    url: string;
    path: string;
    item_closing_action: string | null;
    price: { amount: string; currency_code: string };
    brand?: string;
    photos?: Array<{ url?: string; high_resolution?: { timestamp?: number } }>;
};

type WardrobePagination = {
    current_page: number;
    total_pages: number;
    total_entries: number;
    per_page: number;
};

type WardrobeResponse = {
    items?: WardrobeItem[];
    pagination?: WardrobePagination;
};

function formatMoney(price?: { amount: string; currency_code: string }) {
    if (!price?.amount) return "—";

    const parsed = Number(price.amount);
    if (!Number.isFinite(parsed)) {
        return `${price.amount} ${price.currency_code}`;
    }

    return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: price.currency_code || "EUR",
    }).format(parsed);
}

function getListingState(item: WardrobeItem) {
    if (item.is_draft) return { label: "Draft", variant: "outline" as const };
    if (item.is_closed) {
        const closedLabel =
            item.item_closing_action === "sold" ? "Sold" : "Closed";
        return { label: closedLabel, variant: "secondary" as const };
    }
    if (item.is_reserved) {
        return { label: "Reserved", variant: "secondary" as const };
    }
    if (item.is_hidden) {
        return { label: "Hidden", variant: "outline" as const };
    }
    return { label: "Live", variant: "default" as const };
}

function formatTimeSinceUpload(item: WardrobeItem) {
    const timestamp = item.photos?.[0]?.high_resolution?.timestamp;
    if (!timestamp) return "—";

    const uploadedAt = new Date(timestamp * 1000);
    if (Number.isNaN(uploadedAt.getTime())) return "—";

    const diffMs = Date.now() - uploadedAt.getTime();
    const diffHours = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));

    if (diffHours < 1) {
        return "< 1h";
    }
    if (diffHours < 24) {
        return `${diffHours}h`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return `${diffDays}d`;
    }

    const diffWeeks = Math.floor(diffDays / 7);
    return `${diffWeeks}w`;
}

function openListing(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
}

export function YourListingsClient() {
    const { linked, loading: accountLoading } = useVintedAccount();
    const [items, setItems] = useState<WardrobeItem[]>([]);
    const [pagination, setPagination] = useState<WardrobePagination | null>(
        null,
    );
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);

    const fetchListings = useCallback(async (pageNum: number) => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/items/wardrobe?page=${pageNum}&per_page=20`,
            );
            const data = (await res.json()) as WardrobeResponse & {
                error?: string;
            };

            if (!res.ok) {
                throw new Error(
                    data.error || `Failed to load listings (${res.status})`,
                );
            }

            setItems(data.items || []);
            setPagination(data.pagination || null);
        } catch (error) {
            console.error(error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to load listings",
            );
            setItems([]);
            setPagination(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (linked) {
            fetchListings(page);
        }
    }, [fetchListings, linked, page]);

    const totals = useMemo(() => {
        return items.reduce(
            (acc, item) => {
                acc.views += item.view_count || 0;
                acc.favorites += item.favourite_count || 0;
                if (!item.is_closed && !item.is_hidden && !item.is_draft) {
                    acc.live += 1;
                }
                return acc;
            },
            { views: 0, favorites: 0, live: 0 },
        );
    }, [items]);

    if (accountLoading) {
        return (
            <div className="space-y-6">
                <div className="bg-muted h-10 w-48 animate-pulse rounded-lg" />
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div
                            key={index}
                            className="bg-muted/30 h-32 animate-pulse rounded-xl border"
                        />
                    ))}
                </div>
                <div className="bg-muted/30 h-96 animate-pulse rounded-xl border" />
            </div>
        );
    }

    if (!linked) {
        return (
            <div className="flex h-[60vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                    <Store className="h-8 w-8" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                    Vinted Account Not Linked
                </h2>
                <p className="text-muted-foreground mt-1.5 max-w-sm">
                    Link your Vinted account first to load and manage your own
                    listings.
                </p>
                <Button asChild className="mt-6">
                    <Link href="/account">Go to Account Settings</Link>
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Your Listings
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Track your own Vinted listings and review the core
                        performance metrics in one place.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchListings(page)}
                    disabled={loading}
                    className="h-9 gap-1.5"
                >
                    <RefreshCw
                        className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                    />
                    Refresh Data
                </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="pb-3">
                        <CardDescription>Total Listings</CardDescription>
                        <CardTitle className="text-3xl">
                            {pagination?.total_entries ?? items.length}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Layers3 className="h-4 w-4" />
                        {totals.live} currently live
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-3">
                        <CardDescription>Total Views</CardDescription>
                        <CardTitle className="text-3xl">
                            {totals.views}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Eye className="h-4 w-4" />
                        Views on this page
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-3">
                        <CardDescription>Total Favorites</CardDescription>
                        <CardTitle className="text-3xl">
                            {totals.favorites}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Heart className="h-4 w-4" />
                        Likes on this page
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-3">
                        <CardDescription>Avg. Views</CardDescription>
                        <CardTitle className="text-3xl">
                            {items.length > 0
                                ? Math.round(totals.views / items.length)
                                : 0}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Eye className="h-4 w-4" />
                        Per listing on this page
                    </CardContent>
                </Card>
            </div>

            <Card className="overflow-hidden py-0">
                <CardHeader className="border-b py-5">
                    <CardTitle>Inventory Overview</CardTitle>
                    <CardDescription>
                        Review price, engagement, upload age, and jump straight
                        to the live Vinted listing.
                    </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    {loading && items.length === 0 ? (
                        <div className="space-y-3 p-6">
                            {Array.from({ length: 6 }).map((_, index) => (
                                <div
                                    key={index}
                                    className="bg-muted/40 h-16 animate-pulse rounded-lg"
                                />
                            ))}
                        </div>
                    ) : items.length > 0 ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Listing</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Uploaded</TableHead>
                                    <TableHead>Price</TableHead>
                                    <TableHead>Views</TableHead>
                                    <TableHead>Favorites</TableHead>
                                    <TableHead className="text-right">
                                        Action
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map((item) => {
                                    const state = getListingState(item);
                                    const image = item.photos?.[0]?.url;

                                    return (
                                        <TableRow key={item.id}>
                                            <TableCell className="min-w-[320px]">
                                                <div className="flex items-center gap-3">
                                                    <div className="bg-muted h-14 w-14 overflow-hidden rounded-lg">
                                                        {image ? (
                                                            <Image
                                                                src={image}
                                                                alt={item.title}
                                                                width={56}
                                                                height={56}
                                                                className="h-full w-full object-cover"
                                                            />
                                                        ) : null}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="truncate font-medium">
                                                            {item.title}
                                                        </p>
                                                        <p className="text-muted-foreground truncate text-xs">
                                                            {item.brand ||
                                                                "Unknown brand"}{" "}
                                                            •{" "}
                                                            {item.size ||
                                                                "No size"}{" "}
                                                            •{" "}
                                                            {item.status ||
                                                                "No condition"}
                                                        </p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant={state.variant}
                                                    >
                                                        {state.label}
                                                    </Badge>
                                                    {item.promoted && (
                                                        <Badge variant="outline">
                                                            Promoted
                                                        </Badge>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                {formatTimeSinceUpload(item)}
                                            </TableCell>
                                            <TableCell>
                                                {formatMoney(item.price)}
                                            </TableCell>
                                            <TableCell>
                                                {item.view_count ?? 0}
                                            </TableCell>
                                            <TableCell>
                                                {item.favourite_count ?? 0}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={!item.url}
                                                    onClick={() =>
                                                        openListing(item.url)
                                                    }
                                                >
                                                    <ArrowUpRight className="h-3.5 w-3.5" />
                                                    Open
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    ) : (
                        <div className="flex h-64 flex-col items-center justify-center text-center">
                            <Store className="text-muted-foreground/30 mb-2 h-8 w-8" />
                            <p className="text-muted-foreground font-medium">
                                No listings found
                            </p>
                            <p className="text-muted-foreground/70 text-xs">
                                Your linked Vinted listings will appear here
                                once they are available via the wardrobe API.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {pagination && pagination.total_pages > 1 ? (
                <div className="flex items-center justify-center gap-4">
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                            setPage((current) => Math.max(1, current - 1))
                        }
                        disabled={page === 1 || loading}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm font-medium">
                        Page {page} of {pagination.total_pages}
                    </span>
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                            setPage((current) =>
                                Math.min(pagination.total_pages, current + 1),
                            )
                        }
                        disabled={page === pagination.total_pages || loading}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
