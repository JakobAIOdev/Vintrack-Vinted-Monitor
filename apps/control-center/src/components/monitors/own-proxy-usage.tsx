export type OwnProxyUsage = { activeCount: number; activeLimit: number | null };

export function OwnProxyUsageSummary({
    usage,
    appearance = "card",
}: {
    usage: OwnProxyUsage;
    appearance?: "card" | "inline";
}) {
    const limitReached =
        usage.activeLimit !== null && usage.activeCount >= usage.activeLimit;

    if (appearance === "inline") {
        return (
            <div
                className={`flex items-center gap-1.5 text-sm ${
                    limitReached
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-muted-foreground"
                }`}
            >
                <span className="text-foreground font-medium">
                    Own proxies:
                </span>
                <span>
                    {usage.activeCount} / {usage.activeLimit ?? "Unlimited"}{" "}
                    active
                </span>
                {limitReached ? (
                    <span className="text-xs">
                        · Limit reached. New own proxy monitors are saved
                        paused.
                    </span>
                ) : null}
            </div>
        );
    }

    return (
        <div className="border-border/60 bg-card rounded-lg border px-4 py-3 text-sm">
            <span className="font-medium">Own proxies: </span>
            {usage.activeCount} / {usage.activeLimit ?? "Unlimited"} active
            {limitReached ? (
                <p className="text-muted-foreground mt-1 text-xs">
                    Limit reached. New own proxy monitors are saved paused.
                    Pause another own proxy monitor to free a slot.
                </p>
            ) : null}
        </div>
    );
}
