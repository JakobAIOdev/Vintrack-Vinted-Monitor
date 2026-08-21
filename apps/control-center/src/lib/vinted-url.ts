import { getRegionDomain, REGIONS } from "@/lib/regions";
import {
    MAX_MONITOR_QUERY_LENGTH,
    parseMonitorQueries,
} from "@/lib/monitor-query";
import { VIDEO_GAME_PLATFORM_CATALOG_ID } from "@/lib/video-game-platforms";

const MAX_VINTED_URL_LENGTH = 12_000;
const MAX_FILTER_STORAGE_LENGTH = 500;
const MAX_IMPORTED_IDS = 100;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_EXTRA_PARAM_COUNT = 50;
const MAX_EXTRA_PARAM_KEY_LENGTH = 64;
const MAX_EXTRA_PARAM_VALUE_LENGTH = 256;
export const MAX_VINTED_EXTRA_PARAMS_LENGTH = 2_000;

const VINTED_SEARCH_PARAM_KEYS = new Set([
    "search_text",
    "price_from",
    "price_to",
    "catalog[]",
    "catalog",
    "catalog_ids[]",
    "catalog_ids",
    "brand_ids[]",
    "brand_ids",
    "color_ids[]",
    "color_ids",
    "status_ids[]",
    "status_ids",
    "size_ids[]",
    "size_ids",
    "video_game_platform_ids[]",
    "video_game_platform_ids",
    "platform_ids[]",
    "platform_ids",
]);

const VINTED_URL_METADATA_PARAM_KEYS = new Set([
    "_",
    "order",
    "page",
    "per_page",
    "search_id",
    "time",
]);

const EXTRA_PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\[\])?$/;
const SENSITIVE_EXTRA_PARAM_PATTERN =
    /(auth|bearer|cookie|credential|csrf|password|redirect|session|token|url)/i;

function isUrlMetadataParam(key: string) {
    return (
        VINTED_URL_METADATA_PARAM_KEYS.has(key) ||
        key.startsWith("utm_") ||
        key === "fbclid" ||
        key === "gclid"
    );
}

const REGION_BY_VINTED_HOST = new Map(
    REGIONS.map((region) => [region.domain.toLowerCase(), region.code]),
);

export type VintedSearchImport = {
    region: string;
    query: string;
    priceMin: string;
    priceMax: string;
    sizeIds: string[];
    catalogIds: string[];
    brandIds: string[];
    colorIds: string[];
    statusIds: string[];
    videoGamePlatformIds: string[];
    extraParams: string;
    importedFields: string[];
    preservedParameterNames: string[];
    ignoredMetadataNames: string[];
    ignoredValueCount: number;
};

export type ParseVintedSearchUrlResult =
    | { ok: true; value: VintedSearchImport }
    | { ok: false; error: string };

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
    extraParams?: string | null;
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

function normalizeVintedHost(hostname: string) {
    return hostname
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "");
}

function normalizeUrlInput(value: string) {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("//")) return `https:${trimmed}`;
    return `https://${trimmed}`;
}

function readNumericIds(params: URLSearchParams, keys: string[]) {
    const ids: string[] = [];
    const seen = new Set<string>();
    let ignoredValueCount = 0;

    const values = keys.flatMap((key) => params.getAll(key));
    for (const value of values.flatMap((entry) => entry.split(","))) {
        const normalized = value.trim();
        if (!/^[1-9]\d*$/.test(normalized)) {
            if (normalized) ignoredValueCount += 1;
            continue;
        }
        if (seen.has(normalized)) continue;

        const nextStorageLength =
            ids.reduce((length, id) => length + id.length, 0) +
            normalized.length +
            ids.length;
        if (
            ids.length >= MAX_IMPORTED_IDS ||
            nextStorageLength > MAX_FILTER_STORAGE_LENGTH
        ) {
            ignoredValueCount += 1;
            continue;
        }

        seen.add(normalized);
        ids.push(normalized);
    }

    return { ids, ignoredValueCount };
}

function readPrice(params: URLSearchParams, key: string) {
    const rawValue = params.get(key)?.trim() ?? "";
    if (!rawValue) return { value: "", ignoredValueCount: 0 };
    if (!/^\d+$/.test(rawValue)) {
        return { value: "", ignoredValueCount: 1 };
    }

    const numericValue = Number(rawValue);
    if (
        !Number.isSafeInteger(numericValue) ||
        numericValue < 0 ||
        numericValue > MAX_DATABASE_INTEGER
    ) {
        return { value: "", ignoredValueCount: 1 };
    }

    return { value: String(numericValue), ignoredValueCount: 0 };
}

function collectExtraParams(params: URLSearchParams) {
    const extraParams = new URLSearchParams();
    const preservedParameterNames = new Set<string>();
    const ignoredMetadataNames = new Set<string>();
    let ignoredValueCount = 0;
    let acceptedCount = 0;

    for (const [rawKey, rawValue] of params.entries()) {
        const key = rawKey.trim().toLowerCase();
        if (VINTED_SEARCH_PARAM_KEYS.has(key)) continue;
        if (isUrlMetadataParam(key)) {
            ignoredMetadataNames.add(key);
            continue;
        }

        const value = rawValue.trim();
        if (
            !EXTRA_PARAM_KEY_PATTERN.test(key) ||
            SENSITIVE_EXTRA_PARAM_PATTERN.test(key) ||
            key.length > MAX_EXTRA_PARAM_KEY_LENGTH ||
            !value ||
            value.length > MAX_EXTRA_PARAM_VALUE_LENGTH ||
            acceptedCount >= MAX_EXTRA_PARAM_COUNT
        ) {
            ignoredValueCount += 1;
            continue;
        }

        const candidate = new URLSearchParams(extraParams);
        candidate.append(key, value);
        if (candidate.toString().length > MAX_VINTED_EXTRA_PARAMS_LENGTH) {
            ignoredValueCount += 1;
            continue;
        }

        extraParams.append(key, value);
        acceptedCount += 1;
        preservedParameterNames.add(key);
    }

    return {
        extraParams: extraParams.toString(),
        preservedParameterNames: [...preservedParameterNames],
        ignoredMetadataNames: [...ignoredMetadataNames],
        ignoredValueCount,
    };
}

export function normalizeVintedExtraParams(rawValue: unknown) {
    if (typeof rawValue !== "string") return "";
    const normalized = rawValue.trim().replace(/^\?/, "");
    if (!normalized || normalized.length > MAX_VINTED_URL_LENGTH) return "";
    return collectExtraParams(new URLSearchParams(normalized)).extraParams;
}

export function parseVintedSearchUrl(
    rawUrl: string,
): ParseVintedSearchUrlResult {
    const trimmedUrl = rawUrl.trim();
    if (!trimmedUrl) {
        return { ok: false, error: "Paste a Vinted search URL first." };
    }
    if (trimmedUrl.length > MAX_VINTED_URL_LENGTH) {
        return { ok: false, error: "The Vinted URL is too long." };
    }

    let url: URL;
    try {
        url = new URL(normalizeUrlInput(trimmedUrl));
    } catch {
        return { ok: false, error: "This is not a valid URL." };
    }

    if (url.protocol !== "https:") {
        return { ok: false, error: "Use an HTTPS Vinted search URL." };
    }

    const region = REGION_BY_VINTED_HOST.get(normalizeVintedHost(url.hostname));
    if (!region) {
        return {
            ok: false,
            error: "Use a search URL from a supported Vinted country.",
        };
    }

    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
        normalizedPath !== "/catalog" &&
        normalizedPath !== "/api/v2/catalog/items"
    ) {
        return {
            ok: false,
            error: "Paste a Vinted catalog search URL, not an item or profile URL.",
        };
    }

    const query = url.searchParams.get("search_text")?.trim() ?? "";
    if (query.length > MAX_MONITOR_QUERY_LENGTH) {
        return {
            ok: false,
            error: `The imported search text exceeds ${MAX_MONITOR_QUERY_LENGTH} characters.`,
        };
    }

    const priceMin = readPrice(url.searchParams, "price_from");
    const priceMax = readPrice(url.searchParams, "price_to");
    if (
        priceMin.value &&
        priceMax.value &&
        Number(priceMin.value) > Number(priceMax.value)
    ) {
        return {
            ok: false,
            error: "The imported minimum price is higher than the maximum price.",
        };
    }

    const sizes = readNumericIds(url.searchParams, ["size_ids[]", "size_ids"]);
    const catalogs = readNumericIds(url.searchParams, [
        "catalog[]",
        "catalog",
        "catalog_ids[]",
        "catalog_ids",
    ]);
    const brands = readNumericIds(url.searchParams, [
        "brand_ids[]",
        "brand_ids",
    ]);
    const colors = readNumericIds(url.searchParams, [
        "color_ids[]",
        "color_ids",
    ]);
    const statuses = readNumericIds(url.searchParams, [
        "status_ids[]",
        "status_ids",
    ]);
    const platforms = readNumericIds(url.searchParams, [
        "video_game_platform_ids[]",
        "video_game_platform_ids",
        "platform_ids[]",
        "platform_ids",
    ]);
    const extras = collectExtraParams(url.searchParams);

    const catalogIds = platforms.ids.length
        ? [VIDEO_GAME_PLATFORM_CATALOG_ID]
        : catalogs.ids;
    const importedFields = [
        "region",
        ...(query ? ["search"] : []),
        ...(priceMin.value || priceMax.value ? ["price"] : []),
        ...(catalogIds.length ? ["categories"] : []),
        ...(brands.ids.length ? ["brands"] : []),
        ...(colors.ids.length ? ["colors"] : []),
        ...(statuses.ids.length ? ["conditions"] : []),
        ...(sizes.ids.length ? ["sizes"] : []),
        ...(platforms.ids.length ? ["platforms"] : []),
    ];

    return {
        ok: true,
        value: {
            region,
            query,
            priceMin: priceMin.value,
            priceMax: priceMax.value,
            sizeIds: sizes.ids,
            catalogIds,
            brandIds: brands.ids,
            colorIds: colors.ids,
            statusIds: statuses.ids,
            videoGamePlatformIds: platforms.ids,
            extraParams: extras.extraParams,
            importedFields,
            preservedParameterNames: extras.preservedParameterNames,
            ignoredMetadataNames: extras.ignoredMetadataNames,
            ignoredValueCount:
                priceMin.ignoredValueCount +
                priceMax.ignoredValueCount +
                sizes.ignoredValueCount +
                catalogs.ignoredValueCount +
                brands.ignoredValueCount +
                colors.ignoredValueCount +
                statuses.ignoredValueCount +
                platforms.ignoredValueCount +
                extras.ignoredValueCount,
        },
    };
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
    extraParams,
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
    appendList(params, "video_game_platform_ids[]", videoGamePlatformIds);

    const normalizedExtraParams = normalizeVintedExtraParams(extraParams);
    for (const [key, value] of new URLSearchParams(normalizedExtraParams)) {
        params.append(key, value);
    }

    const queryString = params.toString();
    const basePath = `https://${domain}/catalog`;

    return queryString ? `${basePath}?${queryString}` : basePath;
}
