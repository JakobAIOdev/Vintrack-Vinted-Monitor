export const RUNTIME_POLICY_KEYS = {
    priceWatch: "policy.price_watch",
    freeProxy: "policy.free_proxy",
    worker: "policy.worker",
} as const;

export type VersionedPolicy = {
    version: 1;
    revision: number;
};

export type PriceWatchPolicy = VersionedPolicy & {
    sharedMinimumSeconds: number;
    personalMinimumSeconds: number;
    sharedMaxRpm: number;
    personalMaxRpmPerProxy: number;
};

export type FreeProxyPolicy = VersionedPolicy & {
    autoImportEnabled: boolean;
    importSource: string;
    importUrl: string;
    maxPoolSize: number;
    failureThreshold: number;
    quarantineMinutes: number;
    minActivePerRegion: number;
    targetActivePerRegion: number;
    maxLatencyMs: number;
    starterRegions: string;
    inventoryLimit: number;
    activeCandidateLimit: number;
    idleCandidateLimit: number;
    readyTarget: number;
    reserveTarget: number;
    idleTarget: number;
    emergencyRecoveryEnabled: boolean;
    adaptivePacingEnabled: boolean;
    adaptiveRegions: string[];
    maxRequestsPerProxySecond: number;
    maxAdmissionDelayMs: number;
};

export type WorkerPolicy = VersionedPolicy & {
    discoveryMode: "off" | "shadow" | "active";
    discoveryAllowFreeActive: boolean;
    enrichSellerInfo: boolean;
    catalogLatencyMetrics: boolean;
    sellerFreshTtlMinutes: number;
    sellerStaleTtlMinutes: number;
};

export const DEFAULT_PRICE_WATCH_POLICY: PriceWatchPolicy = {
    version: 1,
    revision: 1,
    sharedMinimumSeconds: 120,
    personalMinimumSeconds: 30,
    sharedMaxRpm: 30,
    personalMaxRpmPerProxy: 2,
};

export const DEFAULT_WORKER_POLICY: WorkerPolicy = {
    version: 1,
    revision: 1,
    discoveryMode: "off",
    discoveryAllowFreeActive: false,
    enrichSellerInfo: true,
    catalogLatencyMetrics: true,
    sellerFreshTtlMinutes: 30,
    sellerStaleTtlMinutes: 1440,
};

export const DEFAULT_FREE_PROXY_POLICY: FreeProxyPolicy = {
    version: 1,
    revision: 1,
    autoImportEnabled: false,
    importSource: "iplocate_all",
    importUrl:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt",
    maxPoolSize: 5000,
    failureThreshold: 3,
    quarantineMinutes: 30,
    minActivePerRegion: 25,
    targetActivePerRegion: 50,
    maxLatencyMs: 2500,
    starterRegions: "de,fr,it,es,nl,be,at",
    inventoryLimit: 30000,
    activeCandidateLimit: 10000,
    idleCandidateLimit: 5000,
    readyTarget: 50,
    reserveTarget: 50,
    idleTarget: 10,
    emergencyRecoveryEnabled: true,
    adaptivePacingEnabled: false,
    adaptiveRegions: ["de", "fr"],
    maxRequestsPerProxySecond: 0.5,
    maxAdmissionDelayMs: 1500,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePolicyDocument<T extends VersionedPolicy>(
    value: string | null | undefined,
    validate: (candidate: Record<string, unknown>) => T | null,
): T | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed) || parsed.version !== 1) return null;
        return validate(parsed);
    } catch {
        return null;
    }
}

export function parsePriceWatchPolicy(value: string | null | undefined) {
    return parsePolicyDocument(value, (candidate) => {
        const policy = candidate as Partial<PriceWatchPolicy>;
        const numeric = [
            policy.revision,
            policy.sharedMinimumSeconds,
            policy.personalMinimumSeconds,
            policy.sharedMaxRpm,
            policy.personalMaxRpmPerProxy,
        ];
        if (
            !numeric.every(
                (entry) => Number.isInteger(entry) && Number(entry) > 0,
            )
        ) {
            return null;
        }
        return policy as PriceWatchPolicy;
    });
}

export function parseWorkerPolicy(value: string | null | undefined) {
    return parsePolicyDocument(value, (candidate) => {
        const policy = {
            ...DEFAULT_WORKER_POLICY,
            ...candidate,
        } as Partial<WorkerPolicy>;
        if (!Number.isInteger(policy.revision) || Number(policy.revision) < 1)
            return null;

        if (!["off", "shadow", "active"].includes(String(policy.discoveryMode)))
            return null;
        if (
            [
                policy.discoveryAllowFreeActive,
                policy.enrichSellerInfo,
                policy.catalogLatencyMetrics,
            ].some((value) => typeof value !== "boolean")
        )
            return null;
        if (
            !Number.isInteger(policy.sellerFreshTtlMinutes) ||
            !Number.isInteger(policy.sellerStaleTtlMinutes) ||
            Number(policy.sellerFreshTtlMinutes) < 1 ||
            Number(policy.sellerStaleTtlMinutes) <
                Number(policy.sellerFreshTtlMinutes)
        )
            return null;
        return policy as WorkerPolicy;
    });
}

export function parseFreeProxyPolicy(value: string | null | undefined) {
    return parsePolicyDocument(value, (candidate) => {
        const policy = {
            ...DEFAULT_FREE_PROXY_POLICY,
            ...candidate,
        } as Partial<FreeProxyPolicy>;
        const numeric = [
            policy.revision,
            policy.maxPoolSize,
            policy.failureThreshold,
            policy.quarantineMinutes,
            policy.minActivePerRegion,
            policy.targetActivePerRegion,
            policy.maxLatencyMs,
            policy.inventoryLimit,
            policy.activeCandidateLimit,
            policy.idleCandidateLimit,
            policy.readyTarget,
            policy.reserveTarget,
            policy.idleTarget,
        ];
        if (
            !numeric.every(
                (entry) => Number.isInteger(entry) && Number(entry) > 0,
            )
        )
            return null;
        if (
            typeof policy.autoImportEnabled !== "boolean" ||
            typeof policy.emergencyRecoveryEnabled !== "boolean" ||
            typeof policy.adaptivePacingEnabled !== "boolean"
        )
            return null;
        if (
            !Array.isArray(policy.adaptiveRegions) ||
            !policy.adaptiveRegions.every(
                (region) => typeof region === "string" && region.length > 0,
            ) ||
            typeof policy.maxRequestsPerProxySecond !== "number" ||
            !Number.isFinite(policy.maxRequestsPerProxySecond) ||
            policy.maxRequestsPerProxySecond <= 0 ||
            !Number.isInteger(policy.maxAdmissionDelayMs) ||
            Number(policy.maxAdmissionDelayMs) < 0
        )
            return null;
        if (
            typeof policy.importSource !== "string" ||
            typeof policy.importUrl !== "string" ||
            typeof policy.starterRegions !== "string"
        )
            return null;
        return policy as FreeProxyPolicy;
    });
}

export function policyPayload<T extends VersionedPolicy>(
    policy: T,
): Omit<T, "version" | "revision"> {
    const payload = { ...policy };
    delete (payload as Partial<VersionedPolicy>).version;
    delete (payload as Partial<VersionedPolicy>).revision;
    return payload;
}
