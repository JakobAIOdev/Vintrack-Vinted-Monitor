import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
    return (
        <div
            aria-hidden="true"
            className={cn("ui-skeleton rounded-md", className)}
            {...props}
        />
    );
}
