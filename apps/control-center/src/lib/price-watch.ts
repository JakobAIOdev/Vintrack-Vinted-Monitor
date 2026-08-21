import { REGIONS } from "@/lib/regions";

const MAX_PRICE_WATCH_URL_LENGTH = 2_048;
const ITEM_PATH_PATTERN = /^\/items\/([1-9]\d*)(?:-[^/]*)?\/?$/;
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const ZERO_BIGINT = BigInt(0);

const REGION_BY_HOST = new Map(
    REGIONS.map((region) => [region.domain.toLowerCase(), region]),
);

export type ParsedPriceWatchUrl = {
    itemId: bigint;
    region: string;
    domain: string;
    canonicalUrl: string;
};

export type ParsePriceWatchUrlResult =
    | { ok: true; value: ParsedPriceWatchUrl }
    | { ok: false; error: string };

function normalizeHost(hostname: string) {
    return hostname
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "");
}

export function parsePriceWatchUrl(input: string): ParsePriceWatchUrlResult {
    const rawUrl = input.trim();
    if (!rawUrl) {
        return { ok: false, error: "Enter a Vinted item URL." };
    }
    if (rawUrl.length > MAX_PRICE_WATCH_URL_LENGTH) {
        return { ok: false, error: "The Vinted item URL is too long." };
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, error: "Enter a valid Vinted item URL." };
    }
    if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port
    ) {
        return {
            ok: false,
            error: "Use a secure Vinted item URL without credentials or a custom port.",
        };
    }

    const host = normalizeHost(parsed.hostname);
    const region = REGION_BY_HOST.get(host);
    if (!region) {
        return {
            ok: false,
            error: "This Vinted regional domain is not supported.",
        };
    }

    const match = ITEM_PATH_PATTERN.exec(parsed.pathname);
    if (!match) {
        return {
            ok: false,
            error: "Use a direct Vinted item link, for example /items/123-item-name.",
        };
    }

    let itemId: bigint;
    try {
        itemId = BigInt(match[1]);
    } catch {
        return { ok: false, error: "The Vinted item ID is invalid." };
    }
    if (itemId <= ZERO_BIGINT || itemId > MAX_POSTGRES_BIGINT) {
        return { ok: false, error: "The Vinted item ID is out of range." };
    }

    const path = parsed.pathname.replace(/\/$/, "");
    return {
        ok: true,
        value: {
            itemId,
            region: region.code,
            domain: `www.${region.domain}`,
            canonicalUrl: `https://www.${region.domain}${path}`,
        },
    };
}

export function serializePriceMinor(value: bigint | null) {
    return value === null ? null : value.toString();
}
