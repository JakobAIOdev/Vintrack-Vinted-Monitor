export const MAX_MONITOR_ANTI_KEYWORDS_LENGTH = 10000;
export const MAX_MONITOR_ANTI_KEYWORDS_COUNT = 500;
export const MAX_MONITOR_ANTI_KEYWORD_LENGTH = 255;

export function parseMonitorAntiKeywords(value: string) {
    const seen = new Set<string>();

    return value
        .split(/[,\n\r]+/)
        .map((keyword) => keyword.trim().replace(/\s+/g, " "))
        .filter((keyword) => {
            const key = keyword.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

export function normalizeMonitorAntiKeywords(value: FormDataEntryValue | null) {
    const normalized = parseMonitorAntiKeywords(String(value ?? "")).join(",");
    return normalized || null;
}

export function getMonitorAntiKeywordsValidationError(
    antiKeywords: string | null,
) {
    const keywords = parseMonitorAntiKeywords(antiKeywords ?? "");

    if (keywords.length > MAX_MONITOR_ANTI_KEYWORDS_COUNT) {
        return `Use at most ${MAX_MONITOR_ANTI_KEYWORDS_COUNT} anti keywords.`;
    }

    if (
        keywords.some(
            (keyword) => keyword.length > MAX_MONITOR_ANTI_KEYWORD_LENGTH,
        )
    ) {
        return `Each anti keyword must be at most ${MAX_MONITOR_ANTI_KEYWORD_LENGTH} characters.`;
    }

    if ((antiKeywords?.length ?? 0) > MAX_MONITOR_ANTI_KEYWORDS_LENGTH) {
        return `Anti keywords must be at most ${MAX_MONITOR_ANTI_KEYWORDS_LENGTH} characters in total.`;
    }

    return null;
}
