function LoadingBlock({ className = "" }: { className?: string }) {
    return (
        <div className={`bg-muted/60 animate-pulse rounded-md ${className}`} />
    );
}

export default function AdminLoading() {
    return (
        <div
            aria-label="Loading admin panel"
            role="status"
            className="min-w-0 space-y-5"
        >
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-2">
                    <LoadingBlock className="h-5 w-36" />
                    <LoadingBlock className="h-3 w-64 max-w-[70vw]" />
                </div>
                <LoadingBlock className="h-7 w-32" />
            </div>

            <LoadingBlock className="h-8 w-full md:hidden" />
            <div className="border-border/70 hidden flex-wrap gap-0.5 rounded-md border p-0.5 md:flex">
                {Array.from({ length: 7 }).map((_, index) => (
                    <LoadingBlock key={index} className="h-8 min-w-16 flex-1" />
                ))}
            </div>

            <div className="border-border/60 grid overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-5">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div
                        key={index}
                        className="border-border/60 space-y-3 border-b p-4 last:border-b-0 sm:border-r xl:border-b-0"
                    >
                        <LoadingBlock className="h-3 w-20" />
                        <LoadingBlock className="h-7 w-14" />
                        <LoadingBlock className="h-3 w-28" />
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="border-border/60 min-w-0 space-y-4 rounded-lg border p-4">
                    <div className="space-y-2">
                        <LoadingBlock className="h-4 w-32" />
                        <LoadingBlock className="h-3 w-56" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, index) => (
                            <LoadingBlock key={index} className="h-20" />
                        ))}
                    </div>
                    <LoadingBlock className="h-32" />
                </div>
                <div className="border-border/60 min-w-0 space-y-4 rounded-lg border p-4">
                    <LoadingBlock className="h-4 w-28" />
                    {Array.from({ length: 4 }).map((_, index) => (
                        <LoadingBlock key={index} className="h-12" />
                    ))}
                </div>
            </div>
        </div>
    );
}
