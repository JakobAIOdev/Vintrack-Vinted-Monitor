export type ProxyRegionCapacity = {
    region: string;
    usable: number;
};

export function summarizeProxyRegions(
    regions: ProxyRegionCapacity[],
    minimumUsable: number,
) {
    const threshold = Math.max(1, Math.floor(minimumUsable));
    return {
        ready: regions.filter((region) => region.usable >= threshold).length,
        total: regions.length,
    };
}
