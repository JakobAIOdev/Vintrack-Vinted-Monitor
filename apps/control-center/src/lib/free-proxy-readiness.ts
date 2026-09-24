export type FreeProxyCanarySnapshot = {
    state: "building" | "collecting" | "passed" | "failed";
    capacityReady: boolean;
    canaryPassed: boolean;
    sampleCount: number;
    successRate: number | null;
    windowMinutes: number;
    readinessReason: string | null;
    lastProbeAt: Date | null;
};

export function withRequiredFreeProxyCanaryRegions(regions: string[]) {
    return Array.from(new Set([...regions, "uk"]));
}

export function parseFreeProxyCanarySnapshot(
    value: string | null | undefined,
): FreeProxyCanarySnapshot | null {
    if (!value) return null;

    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const state = parsed.state;
        if (
            state !== "building" &&
            state !== "collecting" &&
            state !== "passed" &&
            state !== "failed"
        ) {
            return null;
        }
        const successRate = Number(parsed.successRate);
        const lastProbeAt =
            typeof parsed.lastProbeAt === "string"
                ? new Date(parsed.lastProbeAt)
                : null;

        return {
            state,
            capacityReady: parsed.capacityReady === true,
            canaryPassed: parsed.canaryPassed === true,
            sampleCount: Math.max(0, Number(parsed.sampleCount) || 0),
            successRate: Number.isFinite(successRate) ? successRate : null,
            windowMinutes: Math.max(0, Number(parsed.windowMinutes) || 0),
            readinessReason:
                typeof parsed.readinessReason === "string" &&
                parsed.readinessReason
                    ? parsed.readinessReason
                    : null,
            lastProbeAt:
                lastProbeAt && !Number.isNaN(lastProbeAt.getTime())
                    ? lastProbeAt
                    : null,
        };
    } catch {
        return null;
    }
}

export function resolveFreeProxyRegionReadiness({
    featureEnabled,
    serving,
    servingReason,
}: {
    featureEnabled: boolean;
    serving: boolean;
    servingReason: string | null;
}) {
    if (!featureEnabled) {
        return { ready: false, reason: "disabled" };
    }
    if (!serving) {
        return {
            ready: false,
            reason: servingReason ?? "awaiting_serving_snapshot",
        };
    }
    return { ready: true, reason: null };
}
