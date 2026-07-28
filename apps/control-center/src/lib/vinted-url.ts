import { getRegionDomain } from "@/lib/regions";
import { parseMonitorQueries } from "@/lib/monitor-query";
import { VIDEO_GAME_PLATFORM_CATALOG_ID } from "@/lib/video-game-platforms";

type BuildVintedMonitorUrlInput = {
    region: string;
    query?: string | null;
    priceMin?: string | number | null;
    priceMax?: string | number | null;
    sizeIds?: string[] | null;
    catalogIds?: string[] | null;
    brandIds?: string[] | null;
    colorIds?: string[] | null;
    statusIds?: string[] | null;
    videoGamePlatformIds?: string[] | null;
    perPage?: string | number | null;
};

function appendList(
    params: URLSearchParams,
    key: string,
    values?: string[] | null,
) {
    if (!values?.length) return;

    for (const value of values) {
        const normalized = value.trim();
        if (normalized) {
            params.append(key, normalized);
        }
    }
}

export function buildVintedMonitorUrl({
    region,
    query,
    priceMin,
    priceMax,
    sizeIds,
    catalogIds,
    brandIds,
    colorIds,
    statusIds,
    videoGamePlatformIds,
    perPage = 20,
}: BuildVintedMonitorUrlInput) {
    const domain = getRegionDomain(region);
    const params = new URLSearchParams();
    const normalizedQuery = parseMonitorQueries(query ?? "")[0] ?? "";
    const normalizedPriceMin =
        typeof priceMin === "number"
            ? String(priceMin)
            : (priceMin?.trim() ?? "");
    const normalizedPriceMax =
        typeof priceMax === "number"
            ? String(priceMax)
            : (priceMax?.trim() ?? "");

    if (normalizedQuery) {
        params.set("search_text", normalizedQuery);
    }

    params.set("order", "newest_first");
    params.set("per_page", String(perPage));

    if (normalizedPriceMin) {
        params.set("price_from", normalizedPriceMin);
    }

    if (normalizedPriceMax) {
        params.set("price_to", normalizedPriceMax);
    }

    const effectiveCatalogIds = videoGamePlatformIds?.length
        ? [VIDEO_GAME_PLATFORM_CATALOG_ID]
        : catalogIds;

    appendList(params, "size_ids[]", sizeIds);
    appendList(params, "catalog[]", effectiveCatalogIds);
    appendList(params, "brand_ids[]", brandIds);
    appendList(params, "color_ids[]", colorIds);
    appendList(params, "status_ids[]", statusIds);
    appendList(
        params,
        "video_game_platform_ids[]",
        videoGamePlatformIds,
    );

    const queryString = params.toString();
    const basePath = `https://${domain}/catalog`;

    return queryString ? `${basePath}?${queryString}` : basePath;
}
