"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, MapPin, Wallet, Zap } from "lucide-react";
import { shouldShowCheckoutUpdate } from "@/lib/account-updates";
import type { FeatureAccessResult } from "@/lib/features";
import type { MemberAnnouncement } from "@/lib/member-announcement";
import { MemberAnnouncementBanner } from "@/components/announcements/member-announcement-banner";
import { useMonitorMaintenance } from "@/components/maintenance/monitor-maintenance-context";

const checkoutAnnouncement: MemberAnnouncement = {
    enabled: true,
    revision: "checkout-pickup-currencies-v2",
    variant: "info",
    title: "New in checkout: saved pickup points & currency limits",
    message:
        "Use your Vinted pickup point and set a spending limit in your currency. Automatic payment requires a separate opt-in.",
    cta: {
        label: "Explore checkout",
        url: "/account?connection=vinted#checkout-settings",
    },
    dismissible: true,
    audiences: ["free", "premium", "admin"],
    placements: ["monitors", "live_feed", "guide"],
    startsAt: null,
    endsAt: null,
};

export function CheckoutUpdateNotice({
    seenVersion,
    access,
}: {
    seenVersion?: number;
    access: FeatureAccessResult;
}) {
    const pathname = usePathname();
    const { maintenance } = useMonitorMaintenance();
    if (
        maintenance.enabled ||
        !shouldShowCheckoutUpdate(seenVersion, access, pathname)
    )
        return null;
    return (
        <div className="mb-4">
            <MemberAnnouncementBanner announcement={checkoutAnnouncement} />
        </div>
    );
}

export function CheckoutFeatureOverview({ linked }: { linked: boolean }) {
    return (
        <section
            aria-label="What's new in checkout"
            className="flex flex-col gap-4 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:flex-row sm:items-center"
        >
            <div className="min-w-0 flex-1 space-y-2">
                <p className="flex items-center gap-2 text-sm font-semibold">
                    <Zap className="size-4 text-sky-500" aria-hidden="true" />
                    Oneclick & auto-checkout
                </p>
                <p className="text-muted-foreground max-w-2xl text-sm leading-6">
                    Open checkout from dashboard or notification buy links.
                    Choose your saved Vinted pickup point and a limit in your
                    currency. Automatic payment must be enabled separately.
                </p>
                <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span className="inline-flex items-center gap-1.5">
                        <MapPin className="size-3.5" aria-hidden="true" />
                        Saved pickup points
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <Wallet className="size-3.5" aria-hidden="true" />
                        Limits in your currency
                    </span>
                </div>
            </div>
            <Link
                href={
                    linked
                        ? "/account?connection=vinted#checkout-settings"
                        : "/account?connection=vinted#vinted-connection"
                }
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700 sm:self-auto"
            >
                {linked ? "Checkout settings" : "Link Vinted to get started"}
                <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
        </section>
    );
}
