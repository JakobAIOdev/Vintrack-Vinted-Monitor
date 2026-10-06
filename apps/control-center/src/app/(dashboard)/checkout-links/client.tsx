"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
    Copy,
    ExternalLink,
    Link2,
    RefreshCw,
    ShoppingCart,
} from "lucide-react";
import { useVintedAccount } from "@/components/account-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CHECKOUT_CONSENT_REQUIRED } from "@/lib/checkout-consent";
import { requestCheckoutConsent } from "@/lib/checkout-consent.client";

type CheckoutLinkEntry = {
    item_id: number;
    seller_id: number;
    transaction_id: number;
    purchase_id?: string;
    checkout_url?: string;
    payment_url?: string;
    domain?: string;
    status: string;
    created_at: string;
};

function formatTimestamp(value: string) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return parsed.toLocaleString();
}

export function CheckoutLinksClient() {
    const { linked, loading: accountLoading } = useVintedAccount();
    const [links, setLinks] = useState<CheckoutLinkEntry[]>([]);
    const [loading, setLoading] = useState(true);

    const loadLinks = useCallback(async () => {
        setLoading(true);
        try {
            let res = await fetch("/api/items/checkout-links", {
                cache: "no-store",
            });
            if (
                res.status === 403 &&
                (
                    await res
                        .clone()
                        .json()
                        .catch(() => null)
                )?.code === CHECKOUT_CONSENT_REQUIRED
            ) {
                await requestCheckoutConsent();
                res = await fetch("/api/items/checkout-links", {
                    cache: "no-store",
                });
            }
            if (!res.ok) {
                throw new Error(
                    `Failed to fetch checkout links: ${res.status}`,
                );
            }
            const data = await res.json();
            setLinks(Array.isArray(data.links) ? data.links : []);
        } catch (error) {
            console.error(error);
            toast.error("Failed to load checkout links");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (linked) {
            void loadLinks();
        } else {
            setLinks([]);
            setLoading(false);
        }
    }, [linked, loadLinks]);

    const copyLink = async (value: string, label: string) => {
        try {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
        } catch {
            toast.error(`Failed to copy ${label.toLowerCase()}`);
        }
    };

    if (accountLoading) {
        return (
            <div className="space-y-4">
                <div className="bg-muted h-10 w-56 animate-pulse rounded-lg" />
                <div className="grid gap-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div
                            key={index}
                            className="bg-muted/50 h-40 animate-pulse rounded-xl"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (!linked) {
        return (
            <div className="flex h-[60vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                    <Link2 className="h-8 w-8" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight">
                    Vinted Account Not Linked
                </h2>
                <p className="text-muted-foreground mt-1.5 max-w-sm">
                    Link your Vinted account first. Saved checkout and payment
                    links will show up here after a buy attempt.
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
                    <h1 className="text-2xl font-bold tracking-tight">
                        Checkout Links
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Recent checkout URLs saved from your buy attempts.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadLinks()}
                    disabled={loading}
                    className="h-9 gap-1.5"
                >
                    <RefreshCw
                        className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                    />
                    Refresh
                </Button>
            </div>

            {links.length > 0 ? (
                <div className="grid gap-4">
                    {links.map((entry, index) => (
                        <Card
                            key={`${entry.purchase_id || entry.transaction_id || entry.item_id}-${index}`}
                        >
                            <CardHeader className="gap-3">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="space-y-1">
                                        <CardTitle className="text-base">
                                            Item #{entry.item_id}
                                        </CardTitle>
                                        <p className="text-muted-foreground text-sm">
                                            {formatTimestamp(entry.created_at)}
                                            {entry.domain
                                                ? ` • ${entry.domain}`
                                                : ""}
                                        </p>
                                    </div>
                                    <Badge
                                        variant="outline"
                                        className="w-fit uppercase"
                                    >
                                        {entry.status.replaceAll("_", " ")}
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid gap-3 text-sm sm:grid-cols-3">
                                    <div className="border-border/70 bg-muted/30 rounded-md border p-3">
                                        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                            Purchase ID
                                        </span>
                                        <p className="mt-1 font-medium break-all">
                                            {entry.purchase_id || "—"}
                                        </p>
                                    </div>
                                    <div className="border-border/70 bg-muted/30 rounded-md border p-3">
                                        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                            Transaction
                                        </span>
                                        <p className="mt-1 font-medium">
                                            {entry.transaction_id || "—"}
                                        </p>
                                    </div>
                                    <div className="border-border/70 bg-muted/30 rounded-md border p-3">
                                        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                            Seller
                                        </span>
                                        <p className="mt-1 font-medium">
                                            {entry.seller_id || "—"}
                                        </p>
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    {entry.payment_url ? (
                                        <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/50 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                                            <div className="mb-2 flex items-center gap-2">
                                                <ShoppingCart className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                                <span className="text-sm font-medium">
                                                    Payment URL
                                                </span>
                                            </div>
                                            <p className="text-muted-foreground text-xs break-all">
                                                {entry.payment_url}
                                            </p>
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <Button
                                                    asChild
                                                    size="sm"
                                                    className="gap-1.5"
                                                >
                                                    <a
                                                        href={entry.payment_url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                        Open Payment
                                                    </a>
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="gap-1.5"
                                                    onClick={() =>
                                                        void copyLink(
                                                            entry.payment_url!,
                                                            "Payment URL",
                                                        )
                                                    }
                                                >
                                                    <Copy className="h-3.5 w-3.5" />
                                                    Copy
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}

                                    {entry.checkout_url ? (
                                        <div className="border-border/70 bg-background rounded-lg border p-3">
                                            <div className="mb-2 flex items-center gap-2">
                                                <Link2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                                                <span className="text-sm font-medium">
                                                    Checkout URL
                                                </span>
                                            </div>
                                            <p className="text-muted-foreground text-xs break-all">
                                                {entry.checkout_url}
                                            </p>
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <Button
                                                    asChild
                                                    variant="outline"
                                                    size="sm"
                                                    className="gap-1.5"
                                                >
                                                    <a
                                                        href={
                                                            entry.checkout_url
                                                        }
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                        Open Checkout
                                                    </a>
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="gap-1.5"
                                                    onClick={() =>
                                                        void copyLink(
                                                            entry.checkout_url!,
                                                            "Checkout URL",
                                                        )
                                                    }
                                                >
                                                    <Copy className="h-3.5 w-3.5" />
                                                    Copy
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : (
                <div className="border-border/70 bg-muted/20 flex h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
                    <Link2 className="text-muted-foreground/30 mb-2 h-8 w-8" />
                    <p className="text-muted-foreground font-medium">
                        No checkout links saved yet
                    </p>
                    <p className="text-muted-foreground/60 text-xs">
                        After a buy attempt, the latest checkout URLs will
                        appear here.
                    </p>
                </div>
            )}
        </div>
    );
}
