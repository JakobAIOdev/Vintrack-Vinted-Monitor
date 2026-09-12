import "server-only";

const SECRET_KEYS = [
    "AUTH_SECRET",
    "VINTED_SESSION_ENCRYPTION_KEY",
    "AUTH_DISCORD_SECRET",
    "AUTH_GITHUB_SECRET",
    "AUTH_OIDC_CLIENT_SECRET",
    "TELEGRAM_BOT_TOKEN",
] as const;

function normalizedOrigin(value: string | undefined) {
    if (!value?.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
        )
            return null;
        return url.origin;
    } catch {
        return null;
    }
}

export type DeploymentConfigDiagnostics = ReturnType<
    typeof getDeploymentConfigDiagnostics
>;

export function getDeploymentConfigDiagnostics() {
    const canonical = normalizedOrigin(process.env.AUTH_URL);
    const aliases = ["APP_PUBLIC_URL", "DASHBOARD_URL"]
        .map((key) => ({ key, origin: normalizedOrigin(process.env[key]) }))
        .filter((entry) => entry.origin);
    const source = canonical ? "AUTH_URL" : (aliases[0]?.key ?? null);
    const origin = canonical ?? aliases[0]?.origin ?? null;
    const missing = [
        ...(process.env.NODE_ENV === "production" && !canonical
            ? ["AUTH_URL"]
            : []),
        ...SECRET_KEYS.filter((key) => {
            if (
                [
                    "AUTH_DISCORD_SECRET",
                    "AUTH_GITHUB_SECRET",
                    "AUTH_OIDC_CLIENT_SECRET",
                ].includes(key)
            ) {
                const prefix = key.replace("_SECRET", "_ID");
                return Boolean(process.env[prefix]) && !process.env[key];
            }
            return (
                process.env.NODE_ENV === "production" &&
                !process.env[key] &&
                ["AUTH_SECRET", "VINTED_SESSION_ENCRYPTION_KEY"].includes(key)
            );
        }),
    ];
    return {
        status: missing.length === 0 && origin ? "healthy" : "attention",
        originSource: source,
        usingLegacyOrigin: source !== null && source !== "AUTH_URL",
        originConflict: aliases.some(
            (entry) => canonical && entry.origin !== canonical,
        ),
        missing,
        configuredSecrets: SECRET_KEYS.filter((key) =>
            Boolean(process.env[key]),
        ).length,
        secretSlots: SECRET_KEYS.length,
    };
}

export function assertControlCenterProductionConfig() {
    if (
        process.env.NODE_ENV !== "production" ||
        process.env.NEXT_PHASE === "phase-production-build"
    )
        return;
    const diagnostics = getDeploymentConfigDiagnostics();
    const required = ["AUTH_URL", "AUTH_SECRET"].filter(
        (key) => !process.env[key]?.trim(),
    );
    if (diagnostics.originConflict) required.push("AUTH_URL_CONFLICT");
    if (required.length > 0) {
        throw new Error(
            `Invalid production configuration. Missing or conflicting variables: ${required.join(", ")}`,
        );
    }
}
