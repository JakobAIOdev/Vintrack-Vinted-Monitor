import { isIP } from "node:net";

const MAX_CUSTOM_PROXY_HOST_LENGTH = 253;
const HOSTNAME_PATTERN =
    /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;
const VALID_SCHEMES = new Set(["http", "https", "socks4", "socks5"]);

function parseIPv4Octets(host: string): number[] | null {
    const octets = host.split(".");
    if (octets.length !== 4) return null;
    const parts: number[] = [];
    for (const octet of octets) {
        // Reject ambiguous leading-zero/octal and oversized representations.
        if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
        const value = Number(octet);
        if (value > 255) return null;
        parts.push(value);
    }
    return parts;
}

function isPrivateOrReservedIPv4(parts: number[]): boolean {
    const [a, b, c, d] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    // Non-global special-purpose ranges, including documentation/benchmarks.
    // https://www.iana.org/assignments/iana-ipv4-special-registry/
    if (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
}

function isPrivateOrReservedIPv6(host: string): boolean {
    // Called with a valid, canonical IPv6 literal. URL canonicalization turns
    // dotted IPv4-mapped addresses into two hexadecimal words.
    if (host === "::" || host === "::1") return true;
    const firstWord = Number.parseInt(host.split(":")[0] || "0", 16);
    if ((firstWord & 0xffc0) === 0xfe80) return true; // link-local
    if ((firstWord & 0xfe00) === 0xfc00) return true; // unique-local
    if ((firstWord & 0xff00) === 0xff00) return true; // multicast
    if (host.startsWith("2001:db8:")) return true; // documentation
    if (host.startsWith("::ffff:")) {
        const [high, low] = host
            .slice("::ffff:".length)
            .split(":")
            .map((word) => Number.parseInt(word, 16));
        return isPrivateOrReservedIPv4([
            high >> 8,
            high & 255,
            low >> 8,
            low & 255,
        ]);
    }
    return false;
}

/**
 * Static proxy-host syntax and literal-address validation. This does not
 * resolve DNS: a valid hostname can still resolve to an internal address.
 * Complete SSRF protection also requires checks at connection time.
 * IPv6 is returned without brackets; URL serialization adds them explicitly.
 */
export function validateCustomProxyHost(rawHost: string): string | null {
    let host = (rawHost || "").trim().toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    // A DNS root dot does not change the address or bypass the suffix checks.
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!host || host.length > MAX_CUSTOM_PROXY_HOST_LENGTH) return null;

    if (host.includes(":")) {
        if (host.includes("%") || isIP(host) !== 6) return null;
        const canonical = new URL(`http://[${host}]`).hostname.slice(1, -1);
        return isPrivateOrReservedIPv6(canonical) ? null : canonical;
    }

    if (/^\d+(\.\d+){3}$/.test(host)) {
        const octets = parseIPv4Octets(host);
        if (!octets || isPrivateOrReservedIPv4(octets)) return null;
        return octets.join(".");
    }

    // Single-label names can resolve via the server's internal DNS search path.
    // A numeric final label also catches abbreviated/hexadecimal IPv4 aliases.
    if (!HOSTNAME_PATTERN.test(host) || !host.includes(".")) return null;
    if (/^\d+$/.test(host.split(".").at(-1)!)) return null;
    if (host.endsWith(".localhost") || host.endsWith(".local")) return null;
    if (host.endsWith(".internal") || host.endsWith(".home.arpa")) return null;
    // WHATWG URLs accept additional numeric IPv4 forms (including mixed hex
    // octets). Never let an apparent hostname serialize as a different IP.
    try {
        if (new URL(`http://${host}`).hostname !== host) return null;
    } catch {
        return null;
    }
    return host;
}

export function validateCustomProxyPort(rawPort: string): number | null {
    const trimmed = (rawPort || "").trim();
    if (!/^\d{1,5}$/.test(trimmed)) return null;
    const port = Number(trimmed);
    return port >= 1 && port <= 65535 ? port : null;
}

export function isBlockedProxyHostname(rawHostname: string): boolean {
    return validateCustomProxyHost(rawHostname) === null;
}

function serializeProxy(
    scheme: string,
    rawHost: string,
    rawPort: string,
    credentials = "",
): string | null {
    const host = validateCustomProxyHost(rawHost);
    const port = validateCustomProxyPort(rawPort);
    if (!host || !port) return null;
    const authorityHost = host.includes(":") ? `[${host}]` : host;
    // Keep explicit default ports: URL.toString() removes :80/:443, but the
    // worker requires a port in the stored URL.
    return `${scheme}://${credentials}${authorityHost}:${port}`;
}

/** Normalize every supported list format through the same host/port checks. */
export function validateProxyLine(rawLine: string): string | null {
    const line = rawLine.trim();
    if (!line) return null;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        if (/[\\\u0000-\u0020\u007f]/.test(line)) return null;
        const match = line.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)\/?$/i);
        if (!match) return null;
        const scheme = match[1].toLowerCase();
        if (!VALID_SCHEMES.has(scheme)) return null;
        try {
            const url = new URL(line);
            const authority = match[2].slice(match[2].lastIndexOf("@") + 1);
            const endpoint = authority.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
            if (!endpoint) return null;
            // The Go worker rejects malformed percent escapes; do not save them.
            decodeURIComponent(url.username);
            decodeURIComponent(url.password);
            const credentials =
                url.username || url.password
                    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
                    : "";
            return serializeProxy(
                scheme,
                endpoint[1],
                endpoint[2],
                credentials,
            );
        } catch {
            return null;
        }
    }

    // Bracket IPv6 hosts to keep the port and credentials unambiguous. Split
    // credentials from the left so a password can itself contain colons.
    const match = line.match(/^(\[[^\]]+\]|[^:]+):([^:]+)(?::([^:]+):(.*))?$/);
    if (!match) return null;
    const [, host, port, username, password] = match;
    if (username !== undefined && !password) return null;
    try {
        const credentials =
            username === undefined
                ? ""
                : `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
        return serializeProxy("http", host, port, credentials);
    } catch {
        return null;
    }
}
