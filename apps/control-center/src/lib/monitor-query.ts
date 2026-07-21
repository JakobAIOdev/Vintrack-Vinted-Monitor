export const MAX_MONITOR_QUERY_LENGTH = 4000;
export const MAX_MONITOR_QUERY_ALTERNATIVES = 100;
export const MAX_MONITOR_QUERY_ALTERNATIVE_LENGTH = 255;

export function parseMonitorQueries(value: string) {
    const seen = new Set<string>();

    return value
        .split(/[,\n\r]+/)
        .map((query) => query.trim().replace(/\s+/g, " "))
        .filter((query) => {
            const key = query.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

export function normalizeMonitorQuery(value: FormDataEntryValue | null) {
    return parseMonitorQueries(String(value ?? "")).join(",");
}

export function getMonitorQueryValidationError(query: string) {
    const alternatives = parseMonitorQueries(query);

    if (alternatives.length > MAX_MONITOR_QUERY_ALTERNATIVES) {
        return `Use at most ${MAX_MONITOR_QUERY_ALTERNATIVES} keyword alternatives.`;
    }

    if (
        alternatives.some(
            (alternative) =>
                alternative.length > MAX_MONITOR_QUERY_ALTERNATIVE_LENGTH,
        )
    ) {
        return `Each keyword alternative must be at most ${MAX_MONITOR_QUERY_ALTERNATIVE_LENGTH} characters.`;
    }

    if (query.length > MAX_MONITOR_QUERY_LENGTH) {
        return `Keywords must be at most ${MAX_MONITOR_QUERY_LENGTH} characters in total.`;
    }

    return null;
}
