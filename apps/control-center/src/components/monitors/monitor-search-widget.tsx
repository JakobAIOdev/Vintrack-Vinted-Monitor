"use client";

import type { ReactNode } from "react";
import { ExpandableSearch } from "@/components/expandable-search";
import { cn } from "@/lib/utils";

type MonitorScope = "all" | "active" | "paused";

export function MonitorSearchWidget({
    query,
    onQueryChange,
    scope,
    onScopeChange,
    totalCount,
    activeCount,
    pausedCount,
    children,
}: {
    query: string;
    onQueryChange: (query: string) => void;
    scope: MonitorScope;
    onScopeChange: (scope: MonitorScope) => void;
    totalCount: number;
    activeCount: number;
    pausedCount: number;
    children: ReactNode;
}) {
    return (
        <section aria-label="Find monitors" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <ExpandableSearch
                    value={query}
                    onChange={onQueryChange}
                    label="Search monitors"
                    clearLabel="Clear monitor search"
                    closeLabel="Close monitor search"
                    placeholder="Search by name, query or region"
                />
                <div
                    role="group"
                    aria-label="Filter monitors by status"
                    className="border-border/60 bg-muted/30 flex flex-wrap gap-0.5 rounded-lg border p-0.5 sm:shrink-0"
                >
                    {(
                        [
                            ["all", "All", totalCount],
                            ["active", "Active", activeCount],
                            ["paused", "Paused", pausedCount],
                        ] as const
                    ).map(([value, label, count]) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={scope === value}
                            onClick={() => onScopeChange(value)}
                            className={cn(
                                "ui-action flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-200",
                                scope === value
                                    ? "bg-primary text-primary-foreground shadow-xs"
                                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                        >
                            {label}
                            <span className="text-xs tabular-nums">
                                {count}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
            {children}
        </section>
    );
}
