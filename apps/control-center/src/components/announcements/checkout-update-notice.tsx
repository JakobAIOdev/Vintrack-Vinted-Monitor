"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowRight, X } from "lucide-react";
import { shouldShowCheckoutUpdate } from "@/lib/account-updates";
import type { FeatureAccessResult } from "@/lib/features";
import { useMonitorMaintenance } from "@/components/maintenance/monitor-maintenance-context";

const dismissalKey =
    "vintrack:member-announcement:dismissed:checkout-pickup-currencies-v2";

function NewBadge() {
    return (
        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold">
            New
        </span>
    );
}

export function CheckoutUpdateNotice({
    seenVersion,
    access,
}: {
    seenVersion?: number;
    access: FeatureAccessResult;
}) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { maintenance } = useMonitorMaintenance();
    const [preview, setPreview] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [dismissalChecked, setDismissalChecked] = useState(false);

    useEffect(() => {
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            const localPreview =
                ["localhost", "127.0.0.1", "[::1]"].includes(
                    window.location.hostname,
                ) && searchParams.get("previewCheckoutUpdate") === "1";
            setPreview(localPreview);
            try {
                setDismissed(
                    !localPreview && localStorage.getItem(dismissalKey) === "1",
                );
            } catch {
                // The notice remains dismissible when browser storage is unavailable.
            }
            setDismissalChecked(true);
        });
        return () => {
            active = false;
        };
    }, [searchParams]);

    if (
        !dismissalChecked ||
        dismissed ||
        maintenance.enabled ||
        !shouldShowCheckoutUpdate(
            preview ? undefined : seenVersion,
            access,
            pathname,
        )
    )
        return null;
    return (
        <div className="mb-4 flex w-fit max-w-full items-center gap-2">
            <Link
                href="/account?connection=vinted#checkout-settings"
                className="text-muted-foreground hover:text-foreground group inline-flex min-w-0 items-center gap-2 rounded py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                <NewBadge />
                <span>Checkout: saved pickup points &amp; currency limits</span>
                <ArrowRight
                    className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                />
            </Link>
            <button
                type="button"
                aria-label="Dismiss checkout update"
                className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                onClick={() => {
                    setDismissed(true);
                    if (preview) return;
                    try {
                        localStorage.setItem(dismissalKey, "1");
                    } catch {
                        // Dismissal still applies for the current page.
                    }
                }}
            >
                <X className="size-3.5" aria-hidden="true" />
            </button>
        </div>
    );
}

export function CheckoutFeatureShortcut({ linked }: { linked: boolean }) {
    return (
        <Link
            href={
                linked
                    ? "/account?connection=vinted#checkout-settings"
                    : "/account?connection=vinted#vinted-connection"
            }
            className="text-muted-foreground hover:text-foreground group mt-2 inline-flex items-center gap-2 rounded py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
        >
            <NewBadge />
            <span>
                {linked
                    ? "Pickup points & currency limits"
                    : "Link Vinted for pickup points & currency limits"}
            </span>
            <ArrowRight
                className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
            />
        </Link>
    );
}
