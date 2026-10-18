type AccessEnvironment = Record<string, string | undefined>;

export type AuthIdentity = {
    provider: string;
    providerAccountId: string;
};

export function isInstanceAccessRestricted(
    environment: AccessEnvironment = process.env,
) {
    return Boolean(
        environment.AUTH_ALLOWED_DISCORD_IDS?.trim() ||
        environment.AUTH_ALLOWED_OIDC_SUBJECTS?.trim(),
    );
}

export function isInstanceAccountAllowed(
    account: AuthIdentity | null | undefined,
    environment: AccessEnvironment = process.env,
) {
    if (!isInstanceAccessRestricted(environment)) return true;
    if (!account?.providerAccountId) return false;

    const entries =
        account.provider === "discord"
            ? environment.AUTH_ALLOWED_DISCORD_IDS
            : account.provider === "oidc"
              ? environment.AUTH_ALLOWED_OIDC_SUBJECTS
              : undefined;

    return Boolean(
        entries
            ?.split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .includes(account.providerAccountId),
    );
}
