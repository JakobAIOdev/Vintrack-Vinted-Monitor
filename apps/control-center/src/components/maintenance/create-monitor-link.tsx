"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useMonitorMaintenance } from "@/components/maintenance/monitor-maintenance-context";

export const MONITOR_CREATION_MAINTENANCE_TITLE =
    "Monitor creation is paused during maintenance";

export function CreateMonitorLink({
    children,
    className,
    onClick,
}: {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
}) {
    const { maintenance } = useMonitorMaintenance();

    if (maintenance.enabled) {
        return (
            <span
                aria-disabled="true"
                title={MONITOR_CREATION_MAINTENANCE_TITLE}
                data-maintenance-disabled="true"
                className={cn("cursor-not-allowed opacity-50", className)}
            >
                {children}
            </span>
        );
    }

    return (
        <Link href="/monitors/new" className={className} onClick={onClick}>
            {children}
        </Link>
    );
}
