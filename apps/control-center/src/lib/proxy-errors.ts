export type ProxyErrorDetails = {
    code: string;
    title: string;
    description: string;
    action: string | null;
};

const PROXY_ERROR_DETAILS: Record<string, Omit<ProxyErrorDetails, "code">> = {
    vinted_access_denied: {
        title: "Vinted blocked this proxy",
        description:
            "Vinted rejected the proxy with HTTP 403. Vintrack is temporarily avoiding this endpoint.",
        action: "Replace or remove the proxy if the problem continues.",
    },
    proxy_auth_failed: {
        title: "Proxy authentication failed",
        description:
            "The proxy returned HTTP 407 and did not accept the configured credentials.",
        action: "Check the username, password, or Webshare IP authorization.",
    },
    vinted_rate_limited: {
        title: "Proxy temporarily rate-limited",
        description:
            "Vinted returned HTTP 429. Vintrack is cooling down this endpoint before retrying.",
        action: null,
    },
    vinted_session_rejected: {
        title: "Vinted rejected the proxy session",
        description:
            "The session still returned HTTP 401 after Vintrack refreshed its Vinted cookies.",
        action: "Replace the proxy if repeated retries do not recover.",
    },
    proxy_timeout: {
        title: "Proxy timed out",
        description:
            "The request did not finish within Vintrack's configured timeout.",
        action: "Check the proxy latency if this happens repeatedly.",
    },
    proxy_network_error: {
        title: "Proxy connection failed",
        description:
            "Vintrack could not complete the network request through this proxy.",
        action: "Check that the proxy is online and reachable from the server.",
    },
    no_valid_proxies: {
        title: "No valid proxy configured",
        description:
            "Vintrack could not parse any usable endpoint from the selected proxy group.",
        action: "Check the proxy format and save the group again.",
    },
    proxy_pool_waiting: {
        title: "Waiting for a healthy proxy",
        description:
            "Every configured proxy is temporarily unavailable. Vintrack will retry automatically.",
        action: null,
    },
    invalid_response: {
        title: "Invalid response from Vinted",
        description:
            "The request succeeded at the network layer but returned data Vintrack could not decode.",
        action: null,
    },
    vinted_server_error: {
        title: "Vinted is temporarily unavailable",
        description:
            "Vinted returned a server error. The proxy is not being quarantined for this response.",
        action: null,
    },
    catalog_http_error: {
        title: "Vinted request failed",
        description:
            "The latest catalog request returned an unexpected HTTP response.",
        action: null,
    },
};

export function inferProxyErrorCode(
    message?: string | null,
    statusCode?: number | null,
) {
    if (statusCode === 401) return "vinted_session_rejected";
    if (statusCode === 403) return "vinted_access_denied";
    if (statusCode === 407) return "proxy_auth_failed";
    if (statusCode === 429) return "vinted_rate_limited";
    if (statusCode && statusCode >= 500) return "vinted_server_error";

    const normalized = message?.toLowerCase() ?? "";
    if (/\b407\b/.test(normalized)) return "proxy_auth_failed";
    if (/\b403\b/.test(normalized)) return "vinted_access_denied";
    if (/\b429\b/.test(normalized)) return "vinted_rate_limited";
    if (/\b401\b/.test(normalized)) return "vinted_session_rejected";
    if (normalized.includes("no valid proxies"))
        return "no_valid_proxies";
    if (
        normalized.includes("temporarily unavailable") ||
        normalized.includes("no healthy catalog client")
    ) {
        return "proxy_pool_waiting";
    }
    if (
        normalized.includes("deadline exceeded") ||
        normalized.includes("timed out") ||
        normalized.includes("timeout")
    ) {
        return "proxy_timeout";
    }
    if (normalized.includes("json decode")) return "invalid_response";
    if (
        normalized.includes("connection") ||
        normalized.includes("proxyconnect") ||
        normalized.includes("dial ") ||
        normalized.includes("unexpected eof")
    ) {
        return "proxy_network_error";
    }
    return "catalog_http_error";
}

export function getProxyErrorDetails(
    code?: string | null,
    message?: string | null,
    statusCode?: number | null,
): ProxyErrorDetails {
    const resolvedCode =
        code && PROXY_ERROR_DETAILS[code]
            ? code
            : inferProxyErrorCode(message, statusCode);
    const details =
        PROXY_ERROR_DETAILS[resolvedCode] ??
        PROXY_ERROR_DETAILS.catalog_http_error;
    return { code: resolvedCode, ...details };
}
