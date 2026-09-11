export const OWN_PROXY_LIMIT_SETTING_KEY = "own_proxy_active_limit";
export const DEFAULT_OWN_PROXY_ACTIVE_LIMIT = 10;

export function parseOwnProxyLimit(value: string | null | undefined): number {
    if (value == null || value.trim() === "")
        return DEFAULT_OWN_PROXY_ACTIVE_LIMIT;
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= 0
        ? limit
        : DEFAULT_OWN_PROXY_ACTIVE_LIMIT;
}

export function resolveOwnProxyLimit(
    role: string,
    donated: boolean,
    limit: number,
): number | null {
    return role === "admin" || role === "premium" || donated ? null : limit;
}
