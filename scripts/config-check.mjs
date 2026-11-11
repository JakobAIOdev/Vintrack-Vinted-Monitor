#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PAIRS = [
    ["AUTH_DISCORD_ID", "AUTH_DISCORD_SECRET"],
    ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"],
    ["AUTH_OIDC_CLIENT_ID", "AUTH_OIDC_CLIENT_SECRET", "AUTH_OIDC_ISSUER"],
];
const NUMERIC_KEYS = [
    "CLIENT_POOL_SIZE",
    "FREE_PROXY_CLIENT_POOL_SIZE",
    "PRICE_WATCH_WORKERS",
    "PRICE_WATCH_TIMEOUT_MS",
    "ALERT_WORKERS",
    "ALERT_DELIVERY_WORKERS",
    "ENRICHMENT_WORKERS",
    "SELLER_CLIENT_POOL_SIZE",
    "FREE_PROXY_HEALTH_CONCURRENCY",
    "FREE_PROXY_HEALTH_PER_REGION_CONCURRENCY",
];
const LEGACY_ORIGINS = ["APP_PUBLIC_URL", "DASHBOARD_URL"];
// Values shipped in .env.example that must be replaced before the stack works.
const PLACEHOLDERS = {
    AUTH_SECRET: "your_random_secret_here",
    VINTED_SESSION_ENCRYPTION_KEY: "your_random_session_encryption_key_here",
    AUTH_DISCORD_ID: "your_discord_client_id",
    AUTH_DISCORD_SECRET: "your_discord_client_secret",
};

function normalizeOrigin(raw) {
    try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (url.username || url.password || url.search || url.hash) return null;
        if (url.pathname !== "/" && url.pathname !== "") return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function checkConfigText(text) {
    const errors = [];
    const warnings = [];
    const entries = new Map();
    const linesByKey = new Map();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const [, key, value] = match;
        const lines = linesByKey.get(key) ?? [];
        lines.push(index + 1);
        linesByKey.set(key, lines);
        entries.set(key, value.trim());
    }

    for (const [key, lines] of linesByKey) {
        if (lines.length > 1) errors.push(`duplicate key ${key} on lines ${lines.join(", ")}`);
    }

    const canonicalRaw = entries.get("AUTH_URL") ?? "";
    const canonical = canonicalRaw ? normalizeOrigin(canonicalRaw) : null;
    if (canonicalRaw && !canonical) errors.push("AUTH_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
    for (const key of LEGACY_ORIGINS) {
        const raw = entries.get(key) ?? "";
        if (!raw) continue;
        warnings.push(`${key} is deprecated; use AUTH_URL`);
        const origin = normalizeOrigin(raw);
        if (!origin) errors.push(`${key} is not a valid HTTP(S) origin`);
        if (canonical && origin && canonical !== origin) errors.push(`${key} conflicts with AUTH_URL`);
    }

    for (const pair of PAIRS) {
        const present = pair.filter((key) => Boolean(entries.get(key)));
        if (present.length > 0 && present.length < pair.length) {
            errors.push(`credential group is incomplete: ${pair.filter((key) => !entries.get(key)).join(", ")}`);
        }
    }

    for (const key of NUMERIC_KEYS) {
        const raw = entries.get(key);
        if (raw && (!/^\d+$/.test(raw) || Number(raw) <= 0)) errors.push(`${key} must be a positive integer`);
    }

    for (const key of ["AUTH_SECRET", "VINTED_SESSION_ENCRYPTION_KEY"]) {
        if (entries.get(key) === PLACEHOLDERS[key]) errors.push(`${key} still has its template value; run make init to generate it`);
    }

    // Exactly one login provider signs members in: complete OIDC settings
    // replace Discord, otherwise Discord must be configured.
    const oidcConfigured = PAIRS[2].every((key) => Boolean(entries.get(key)));
    const discordConfigured = ["AUTH_DISCORD_ID", "AUTH_DISCORD_SECRET"].every(
        (key) => Boolean(entries.get(key)) && entries.get(key) !== PLACEHOLDERS[key],
    );
    if (!oidcConfigured && !discordConfigured) {
        // The mock development stack signs in automatically, so this is only
        // a blocker for a live stack.
        warnings.push("no login provider is configured; make up and make local need AUTH_DISCORD_ID and AUTH_DISCORD_SECRET, or the AUTH_OIDC_* settings");
    }

    // Caddy serves VINTRACK_SITE_ADDRESS, members open AUTH_URL. When both
    // name a public host they have to be the same one.
    const siteAddress = entries.get("VINTRACK_SITE_ADDRESS") ?? "";
    if (canonical && siteAddress) {
        const authHost = new URL(canonical).hostname.toLowerCase();
        const siteHost = siteAddress.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "").toLowerCase();
        const local = (host) => host === "localhost" || host === "127.0.0.1";
        if (/[/?#]/.test(siteAddress.replace(/^https?:\/\//i, ""))) {
            errors.push("VINTRACK_SITE_ADDRESS must be a hostname without a path");
        } else if (!local(authHost) && authHost !== siteHost) {
            errors.push("VINTRACK_SITE_ADDRESS does not match the AUTH_URL hostname; Caddy would serve a different site than members open");
        }
    }

    // The Telegram webhook rejects every update without a secret, and Telegram
    // only accepts these characters in one.
    const telegramSecret = entries.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
    if (entries.get("TELEGRAM_BOT_TOKEN") && !telegramSecret) {
        errors.push("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set; run make init to generate it");
    }
    if (telegramSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(telegramSecret)) {
        errors.push("TELEGRAM_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and - (1-256 characters)");
    }

    const production = ["APP_ENV", "NODE_ENV", "ENVIRONMENT"].some(
        (key) => entries.get(key)?.toLowerCase() === "production",
    );
    if (production) {
        for (const key of ["AUTH_URL", "AUTH_SECRET", "VINTED_SESSION_ENCRYPTION_KEY"]) {
            if (!entries.get(key)) errors.push(`${key} is required in production`);
        }
        if (canonical) {
            const url = new URL(canonical);
            const host = url.hostname.toLowerCase();
            const unsafeHost = host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
            const temporaryTunnel = [".trycloudflare.com", ".ngrok.app", ".ngrok-free.app", ".ngrok-free.dev"].some((suffix) => host.endsWith(suffix));
            if (url.protocol !== "https:" || unsafeHost || temporaryTunnel) errors.push("AUTH_URL must use a non-local, stable HTTPS origin in production");
        }
    }

    return { errors, warnings };
}

export function formatConfigResult(result) {
    return [
        ...result.errors.map((message) => `ERROR ${message}`),
        ...result.warnings.map((message) => `WARN ${message}`),
        result.errors.length === 0
            ? `Config check passed (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`
            : `Config check failed (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`,
    ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const path = resolve(process.argv[2] ?? ".env");
    try {
        const result = checkConfigText(readFileSync(path, "utf8"));
        console.log(formatConfigResult(result));
        process.exitCode = result.errors.length === 0 ? 0 : 1;
    } catch (error) {
        console.error(`ERROR cannot read config file ${path.split("/").at(-1)}`);
        process.exitCode = 1;
    }
}
