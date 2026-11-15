import { Radar } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function MonitorsLoading() {
    return (
        <div
            role="status"
            aria-label="Loading your monitors"
            className="space-y-4"
        >
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-2">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-4 w-64 max-w-[75vw]" />
                </div>
                <Skeleton className="h-8 w-32" />
            </div>
            <div className="bg-card overflow-hidden rounded-xl border">
                <div className="flex flex-wrap gap-x-6 gap-y-3 px-4 py-3">
                    {Array.from({ length: 4 }, (_, index) => (
                        <Skeleton key={index} className="h-5 w-24" />
                    ))}
                </div>
                <div className="text-muted-foreground flex items-center gap-2 border-t px-5 py-3 text-xs">
                    <Radar
                        aria-hidden="true"
                        className="text-primary size-4 motion-safe:animate-pulse"
                    />
                    Getting your searches ready…
                </div>
            </div>
            <div
                className="flex flex-wrap justify-between gap-3"
                aria-hidden="true"
            >
                <Skeleton className="size-8" />
                <Skeleton className="h-8 w-64" />
            </div>
            <div
                className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3"
                aria-hidden="true"
            >
                {Array.from({ length: 6 }, (_, index) => (
                    <div
                        key={index}
                        className="bg-card space-y-5 rounded-lg border p-4"
                    >
                        <div className="flex justify-between gap-4">
                            <Skeleton className="h-5 w-40" />
                            <Skeleton className="h-5 w-14" />
                        </div>
                        <Skeleton className="h-4 w-3/4" />
                        <div className="flex gap-2">
                            <Skeleton className="h-6 w-20" />
                            <Skeleton className="h-6 w-16" />
                        </div>
                        <div className="flex justify-between border-t pt-4">
                            <Skeleton className="h-8 w-20" />
                            <Skeleton className="h-8 w-28" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
