export type VideoGamePlatform = {
    id: string;
    label: string;
};

export const VIDEO_GAME_PLATFORM_CATALOG_ID = "3002";

export function hasVideoGamePlatformCatalog(catalogIds: string[]) {
    return (
        catalogIds.length === 1 &&
        catalogIds[0] === VIDEO_GAME_PLATFORM_CATALOG_ID
    );
}

// Kept locally so monitor forms and labels remain usable if Vinted's facets
// endpoint is temporarily unavailable. The picker also merges live results.
export const VIDEO_GAME_PLATFORMS: VideoGamePlatform[] = [
    { id: "1259", label: "Asus ROG Ally" },
    { id: "1260", label: "Atari" },
    { id: "1261", label: "Ayaneo" },
    { id: "1262", label: "Commodore" },
    { id: "1263", label: "Lenovo Legion Go" },
    { id: "1264", label: "Nintendo 2DS" },
    { id: "1265", label: "Nintendo 3DS" },
    { id: "1266", label: "Nintendo 64" },
    { id: "1267", label: "Nintendo DS" },
    { id: "1268", label: "Nintendo Entertainment System" },
    { id: "1269", label: "Nintendo Game Boy" },
    { id: "1270", label: "Nintendo Game Boy Advance" },
    { id: "1272", label: "Nintendo GameCube" },
    { id: "1273", label: "Nintendo Switch" },
    { id: "6478", label: "Nintendo Switch 2" },
    { id: "1274", label: "Nintendo Wii" },
    { id: "1275", label: "Nintendo Wii U" },
    { id: "1276", label: "PC & Mac" },
    { id: "1277", label: "PlayStation 1" },
    { id: "1278", label: "PlayStation 2" },
    { id: "1279", label: "PlayStation 3" },
    { id: "1280", label: "PlayStation 4" },
    { id: "1281", label: "PlayStation 5" },
    { id: "8582", label: "PlayStation 5 Pro" },
    { id: "1282", label: "PlayStation Portable" },
    { id: "1283", label: "PlayStation Vita" },
    { id: "8583", label: "PlayStation Portal" },
    { id: "1284", label: "Sega Dreamcast" },
    { id: "1285", label: "Sega Mega Drive" },
    { id: "1286", label: "Steam Deck" },
    { id: "1287", label: "Super Nintendo" },
    { id: "1288", label: "Xbox (Original)" },
    { id: "1289", label: "Xbox 360" },
    { id: "1290", label: "Xbox One" },
    { id: "1291", label: "Xbox Series S & X" },
    { id: "8573", label: "Acer Nitro Blaze 7" },
    { id: "8574", label: "Acer Nitro Blaze 8" },
    { id: "8575", label: "Acer Nitro Blaze 11" },
    { id: "8576", label: "Asus ROG Ally X" },
    { id: "8577", label: "Asus ROG Xbox Ally" },
    { id: "8578", label: "MSI Claw A1M" },
    { id: "8579", label: "MSI Claw 7 AI+" },
    { id: "8580", label: "MSI Claw 8 AI+" },
    { id: "8581", label: "MSI Claw A8" },
    { id: "8584", label: "Xbox Ally X" },
    { id: "8585", label: "Zotac Gaming Zone" },
];

const PLATFORM_BY_ID = new Map(
    VIDEO_GAME_PLATFORMS.map((platform) => [platform.id, platform]),
);

const PLATFORM_ALIASES: Record<string, string[]> = {
    "1264": ["2ds"],
    "1265": ["3ds"],
    "1266": ["n64"],
    "1267": ["nds"],
    "1268": ["nes"],
    "1269": ["gameboy", "gb"],
    "1270": ["gameboyadvance", "gba"],
    "1272": ["gamecube", "ngc"],
    "1273": ["switch"],
    "6478": ["switch2"],
    "1274": ["wii"],
    "1275": ["wiiu"],
    "1277": ["ps1", "psx"],
    "1278": ["ps2"],
    "1279": ["ps3"],
    "1280": ["ps4"],
    "1281": ["ps5"],
    "8582": ["ps5pro"],
    "1282": ["psp"],
    "1283": ["psvita", "vita"],
    "8583": ["psportal"],
    "1287": ["snes"],
    "1288": ["xboxclassic", "originalxbox"],
    "1291": ["xboxseries", "seriesx", "seriess"],
};

function normalizeSearch(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchesVideoGamePlatform(
    platform: VideoGamePlatform,
    query: string,
) {
    const normalizedQuery = normalizeSearch(query);
    if (!normalizedQuery) return true;

    const normalizedLabel = normalizeSearch(platform.label);
    return [
        normalizedLabel,
        normalizedLabel.replace("playstation", "ps"),
        normalizedLabel.replace("nintendo", "n"),
        ...(PLATFORM_ALIASES[platform.id] ?? []),
    ].some((candidate) => candidate.includes(normalizedQuery));
}

export function getVideoGamePlatformLabel(id: string) {
    return PLATFORM_BY_ID.get(id)?.label ?? `Platform #${id}`;
}

export function getVideoGamePlatformLabels(
    ids: string | null | undefined,
): string[] {
    if (!ids) return [];

    return ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map(getVideoGamePlatformLabel);
}
