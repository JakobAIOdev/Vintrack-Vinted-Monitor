"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

type ActiveFilterFieldProps = {
    active: boolean;
    summary: string;
    children: ReactNode;
    testId?: string;
};

export function formatFilterCount(
    count: number,
    singular: string,
    plural = `${singular}s`,
) {
    return `${count} ${count === 1 ? singular : plural}`;
}

export function formatPriceFilterSummary(
    priceMin: string,
    priceMax: string,
    currencyCode: string,
) {
    const min = priceMin.trim();
    const max = priceMax.trim();

    if (min && max) return `${min}–${max} ${currencyCode}`;
    if (min) return `From ${min} ${currencyCode}`;
    if (max) return `Up to ${max} ${currencyCode}`;
    return "";
}

export function ActiveFilterField({
    active,
    summary,
    children,
    testId,
}: ActiveFilterFieldProps) {
    return (
        <div
            data-testid={testId}
            data-state={active ? "active" : "inactive"}
            className={cn(
                "rounded-xl border p-3 transition-[border-color,background-color,box-shadow] duration-200 sm:p-4",
                active
                    ? "border-violet-400/35 bg-violet-500/[0.045] shadow-[0_8px_24px_-20px_rgba(124,58,237,0.9)] dark:border-violet-400/30 dark:bg-violet-400/[0.055]"
                    : "hover:border-border/50 hover:bg-muted/10 border-transparent bg-transparent shadow-none",
            )}
        >
            <div
                className={cn(
                    "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out",
                    active
                        ? "mb-3 grid-rows-[1fr] opacity-100"
                        : "mb-0 grid-rows-[0fr] opacity-0",
                )}
                aria-hidden={!active}
            >
                <div className="overflow-hidden">
                    <div className="flex min-h-7 items-center justify-between gap-3 rounded-lg border border-violet-400/20 bg-violet-500/[0.045] px-2.5 py-1 text-[11px] font-semibold text-violet-600 shadow-sm dark:text-violet-300">
                        <span className="inline-flex items-center gap-1.5 tracking-[0.08em] uppercase">
                            <CheckCircle2 className="size-3.5" /> Active
                        </span>
                        <span className="text-foreground min-w-0 truncate text-right tracking-normal normal-case">
                            {summary}
                        </span>
                    </div>
                </div>
            </div>
            {children}
        </div>
    );
}
