import { db } from "@/lib/db";
import { normalizeMonitorQuery } from "@/lib/monitor-query";
import { parsePriceWatchUrl } from "@/lib/price-watch";
import {
    buildVintedMonitorUrl,
    normalizeVintedExtraParams,
    parseVintedSearchUrl,
    type VintedSearchImport,
} from "@/lib/vinted-url";

function normalizedIds(value: string | null | undefined) {
    return String(value ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .sort((left, right) =>
            left.localeCompare(right, undefined, { numeric: true }),
        )
        .join(",");
}

function normalizedExtraParams(value: string | null | undefined) {
    return [...new URLSearchParams(normalizeVintedExtraParams(value))]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
            leftKey === rightKey
                ? leftValue.localeCompare(rightValue)
                : leftKey.localeCompare(rightKey),
        )
        .map(([key, entry]) => `${key}=${entry}`)
        .join("&");
}

type MonitorFingerprintInput = {
    region: string;
    query: string;
    priceMin: number | null;
    priceMax: number | null;
    sizeIds: string;
    catalogIds: string;
    brandIds: string;
    colorIds: string;
    statusIds: string;
    platformIds: string;
    extraParams: string;
};

function monitorFingerprint(input: MonitorFingerprintInput) {
    return JSON.stringify([
        input.region.trim().toLowerCase(),
        normalizeMonitorQuery(input.query),
        input.priceMin,
        input.priceMax,
        normalizedIds(input.sizeIds),
        normalizedIds(input.catalogIds),
        normalizedIds(input.brandIds),
        normalizedIds(input.colorIds),
        normalizedIds(input.statusIds),
        normalizedIds(input.platformIds),
        normalizedExtraParams(input.extraParams),
    ]);
}

function importFingerprint(value: VintedSearchImport) {
    return monitorFingerprint({
        region: value.region,
        query: value.query,
        priceMin: value.priceMin ? Number(value.priceMin) : null,
        priceMax: value.priceMax ? Number(value.priceMax) : null,
        sizeIds: value.sizeIds.join(","),
        catalogIds: value.catalogIds.join(","),
        brandIds: value.brandIds.join(","),
        colorIds: value.colorIds.join(","),
        statusIds: value.statusIds.join(","),
        platformIds: value.videoGamePlatformIds.join(","),
        extraParams: value.extraParams,
    });
}

export async function inspectExtensionContext(userId: string, rawUrl: string) {
    const catalog = parseVintedSearchUrl(rawUrl);
    if (catalog.ok) {
        const monitors = await db.monitors.findMany({
            where: { userId },
            select: {
                id: true,
                name: true,
                status: true,
                region: true,
                query: true,
                price_min: true,
                price_max: true,
                size_id: true,
                catalog_ids: true,
                brand_ids: true,
                color_ids: true,
                status_ids: true,
                video_game_platform_ids: true,
                vinted_extra_params: true,
            },
        });
        const expected = importFingerprint(catalog.value);
        const matchingMonitor = monitors.find(
            (monitor) =>
                monitorFingerprint({
                    region: monitor.region,
                    query: monitor.query,
                    priceMin: monitor.price_min,
                    priceMax: monitor.price_max,
                    sizeIds: monitor.size_id ?? "",
                    catalogIds: monitor.catalog_ids ?? "",
                    brandIds: monitor.brand_ids ?? "",
                    colorIds: monitor.color_ids ?? "",
                    statusIds: monitor.status_ids ?? "",
                    platformIds: monitor.video_game_platform_ids ?? "",
                    extraParams: monitor.vinted_extra_params ?? "",
                }) === expected,
        );
        const handoffUrl = buildVintedMonitorUrl({
            region: catalog.value.region,
            query: catalog.value.query,
            priceMin: catalog.value.priceMin,
            priceMax: catalog.value.priceMax,
            sizeIds: catalog.value.sizeIds,
            catalogIds: catalog.value.catalogIds,
            brandIds: catalog.value.brandIds,
            colorIds: catalog.value.colorIds,
            statusIds: catalog.value.statusIds,
            videoGamePlatformIds: catalog.value.videoGamePlatformIds,
            extraParams: catalog.value.extraParams,
        });

        return {
            kind: "catalog" as const,
            handoffUrl,
            parsed: catalog.value,
            matchingMonitor: matchingMonitor
                ? {
                      id: matchingMonitor.id,
                      name: matchingMonitor.name,
                      status: matchingMonitor.status ?? "paused",
                  }
                : null,
        };
    }

    const item = parsePriceWatchUrl(rawUrl);
    if (item.ok) {
        const target = await db.price_watch_targets.findUnique({
            where: {
                region_item_id: {
                    region: item.value.region,
                    item_id: item.value.itemId,
                },
            },
            select: {
                watches: {
                    where: { user_id: userId },
                    take: 1,
                    select: { id: true, status: true },
                },
            },
        });
        const watch = target?.watches[0];
        return {
            kind: "item" as const,
            handoffUrl: item.value.canonicalUrl,
            item: {
                itemId: item.value.itemId.toString(),
                region: item.value.region,
                canonicalUrl: item.value.canonicalUrl,
            },
            priceWatch: watch
                ? { id: watch.id.toString(), status: watch.status }
                : null,
        };
    }

    return { kind: "unsupported" as const };
}
