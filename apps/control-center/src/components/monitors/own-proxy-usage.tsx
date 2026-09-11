export type OwnProxyUsage = { activeCount: number; activeLimit: number | null };

export function OwnProxyUsageSummary({ usage }: { usage: OwnProxyUsage }) {
    return (
        <div className="border-border/60 bg-card rounded-lg border px-4 py-3 text-sm">
            <span className="font-medium">Own proxies: </span>
            {usage.activeCount} / {usage.activeLimit ?? "Unlimited"} active
            {usage.activeLimit !== null &&
                usage.activeCount >= usage.activeLimit && (
                    <p className="text-muted-foreground mt-1 text-xs">
                        Limit reached. New own proxy monitors are saved paused.
                        Pause another own proxy monitor to free a slot.
                    </p>
                )}
        </div>
    );
}
