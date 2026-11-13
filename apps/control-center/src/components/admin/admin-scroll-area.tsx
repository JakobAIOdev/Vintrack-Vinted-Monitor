import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function AdminScrollArea({
    className,
    ...props
}: ComponentProps<"div"> & { "aria-label": string }) {
    return (
        <div
            role="region"
            tabIndex={0}
            className={cn(
                "focus-visible:ring-ring max-h-[min(32rem,65dvh)] min-h-0 [scrollbar-gutter:stable] overflow-auto overscroll-y-contain focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
                className,
            )}
            {...props}
        />
    );
}
