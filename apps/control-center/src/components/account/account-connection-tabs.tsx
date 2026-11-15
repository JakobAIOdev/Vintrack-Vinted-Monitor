"use client";

import Link, { useLinkStatus } from "next/link";
import {
    CheckCircle2,
    Github,
    Link2,
    Loader2,
    ShoppingBag,
} from "lucide-react";
import { cn } from "@/lib/utils";

function ConnectionIcon({ connection }: { connection: "vinted" | "github" }) {
    const { pending } = useLinkStatus();
    const Icon = pending
        ? Loader2
        : connection === "vinted"
          ? ShoppingBag
          : Github;

    return (
        <Icon
            aria-hidden="true"
            className={cn("size-4 shrink-0", pending && "animate-spin")}
        />
    );
}

export function AccountConnectionTabs({
    active,
    vintedLinked,
    githubConnected,
}: {
    active: "vinted" | "github";
    vintedLinked: boolean;
    githubConnected: boolean;
}) {
    const connections = [
        {
            id: "vinted",
            label: "Vinted",
            accessibleLabel: "Vinted",
            status: vintedLinked ? "Linked" : "Not linked",
        },
        {
            id: "github",
            label: "GitHub",
            accessibleLabel: "GitHub Rewards",
            status: githubConnected ? "Connected" : "Not connected",
        },
    ] as const;
    const current = connections[active === "vinted" ? 0 : 1];
    const connected = active === "vinted" ? vintedLinked : githubConnected;
    const StatusIcon = connected ? CheckCircle2 : Link2;

    return (
        <div className="space-y-2">
            <nav
                aria-label="Account connections"
                data-active={active}
                className="account-connection-tabs border-border/70 bg-muted/60 relative isolate grid w-full max-w-[22rem] grid-cols-2 rounded-xl border p-1"
            >
                <span
                    aria-hidden="true"
                    className="account-connection-indicator bg-primary border-primary pointer-events-none absolute inset-y-1 left-1 rounded-lg border shadow-sm"
                />
                {connections.map((connection) => (
                    <Link
                        key={connection.id}
                        href={`/account?connection=${connection.id}`}
                        scroll={false}
                        aria-label={`${connection.accessibleLabel}, ${connection.status}`}
                        aria-current={
                            active === connection.id ? "page" : undefined
                        }
                        className={cn(
                            "account-connection-link relative z-10 flex min-h-8 min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-1 text-[13px] transition-colors duration-200",
                            active === connection.id
                                ? "text-primary-foreground font-semibold"
                                : "text-muted-foreground hover:text-foreground font-medium",
                        )}
                    >
                        <ConnectionIcon connection={connection.id} />
                        <span>{connection.label}</span>
                    </Link>
                ))}
            </nav>
            <p
                role="status"
                className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs"
            >
                <StatusIcon aria-hidden="true" className="size-3.5 shrink-0" />
                {current.label} · {current.status}
            </p>
        </div>
    );
}
