const CONTROL_CENTER_SECRET_KEYS = [
    "AUTH_SECRET",
    "AUTH_DISCORD_SECRET",
    "AUTH_GITHUB_SECRET",
    "AUTH_OIDC_CLIENT_SECRET",
    "TELEGRAM_BOT_TOKEN",
] as const;

const OPTIONAL_CREDENTIAL_PAIRS = [
    ["AUTH_DISCORD_ID", "AUTH_DISCORD_SECRET"],
    ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"],
    ["AUTH_OIDC_CLIENT_ID", "AUTH_OIDC_CLIENT_SECRET"],
] as const;

type DeploymentEnvironment = Record<string, string | undefined>;

function hasValue(value: string | undefined) {
    return Boolean(value?.trim());
}

function normalizedOrigin(value: string | undefined) {
    const candidate = value?.trim();
    if (!candidate) return null;
    try {
        const url = new URL(candidate);
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

export function buildDeploymentConfigDiagnostics(
    environment: DeploymentEnvironment,
) {
    const canonical = normalizedOrigin(environment.AUTH_URL);
    const aliases = ["APP_PUBLIC_URL", "DASHBOARD_URL"]
        .map((key) => ({ key, origin: normalizedOrigin(environment[key]) }))
        .filter(
            (entry): entry is { key: string; origin: string } =>
                entry.origin !== null,
        );
    const source = canonical ? "AUTH_URL" : (aliases[0]?.key ?? null);
    const origin = canonical ?? aliases[0]?.origin ?? null;
    const originConflict = aliases.some(
        (entry) => canonical !== null && entry.origin !== canonical,
    );
    const missing = [
        ...(environment.NODE_ENV === "production" && !canonical
            ? ["AUTH_URL"]
            : []),
        ...(environment.NODE_ENV === "production" &&
        !hasValue(environment.AUTH_SECRET)
            ? ["AUTH_SECRET"]
            : []),
        ...OPTIONAL_CREDENTIAL_PAIRS.flatMap(([idKey, secretKey]) =>
            hasValue(environment[idKey]) && !hasValue(environment[secretKey])
                ? [secretKey]
                : [],
        ),
    ];

    return {
        status:
            missing.length === 0 && origin && !originConflict
                ? ("healthy" as const)
                : ("attention" as const),
        originSource: source,
        usingLegacyOrigin: source !== null && source !== "AUTH_URL",
        originConflict,
        missing,
        configuredSecrets: CONTROL_CENTER_SECRET_KEYS.filter((key) =>
            hasValue(environment[key]),
        ).length,
    };
}

export type DeploymentConfigDiagnostics = ReturnType<
    typeof buildDeploymentConfigDiagnostics
>;
