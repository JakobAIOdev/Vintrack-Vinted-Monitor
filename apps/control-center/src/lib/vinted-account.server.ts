const VINTED_SERVICE_URL =
    process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export type ExtensionAccountStatus = {
    available: boolean;
    linked: boolean;
    status?: string;
    vintedName?: string;
    domain?: string;
    browserLinked?: boolean;
    lastBrowserSync?: string;
    lastValidAt?: string;
    requiresBrowserReauth?: boolean;
    error?: string;
};

export async function getExtensionAccountStatus(
    userId: string,
): Promise<ExtensionAccountStatus> {
    try {
        const response = await fetch(
            `${VINTED_SERVICE_URL}/api/account/status`,
            {
                headers: {
                    Accept: "application/json",
                    "X-User-ID": userId,
                },
                cache: "no-store",
                signal: AbortSignal.timeout(8_000),
            },
        );
        const data = (await response.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        if (!response.ok || !data) {
            return {
                available: false,
                linked: false,
                error: `Account status unavailable (${response.status})`,
            };
        }

        return {
            available: true,
            linked: data.linked === true,
            status: typeof data.status === "string" ? data.status : undefined,
            vintedName:
                typeof data.vinted_name === "string"
                    ? data.vinted_name
                    : undefined,
            domain: typeof data.domain === "string" ? data.domain : undefined,
            browserLinked: data.browser_linked === true,
            lastBrowserSync:
                typeof data.last_browser_sync === "string"
                    ? data.last_browser_sync
                    : undefined,
            lastValidAt:
                typeof data.last_valid_at === "string"
                    ? data.last_valid_at
                    : undefined,
            requiresBrowserReauth: data.requires_browser_reauth === true,
        };
    } catch {
        return {
            available: false,
            linked: false,
            error: "Vinted account service unavailable",
        };
    }
}
