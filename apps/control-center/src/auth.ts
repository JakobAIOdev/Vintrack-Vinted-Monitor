import NextAuth from "next-auth";
import { cache } from "react";
import { cookies } from "next/headers";
import type { Session } from "next-auth";
import Discord from "next-auth/providers/discord";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import type { Provider } from "@auth/core/providers";
import type { Adapter } from "@auth/core/adapters";
import {
    oidcClientId,
    oidcClientSecret,
    oidcConfigured,
    oidcIssuer,
    oidcName,
} from "@/lib/auth-provider";
import {
    claimGithubAccountForUser,
    updateGithubStarFromToken,
} from "@/lib/github-rewards.server";
import { prepareGithubAccountLink } from "@/lib/github-account-linking.server";
import { reconcileUserFreeProxyMonitorLimit } from "@/lib/free-proxy-limit-reconciliation.server";

export const githubAuthConfigured = Boolean(
    process.env.AUTH_GITHUB_ID?.trim() &&
    process.env.AUTH_GITHUB_SECRET?.trim(),
);

const primaryProviders: Provider[] = oidcConfigured
    ? [
          {
              id: "oidc",
              name: oidcName,
              type: "oidc",
              issuer: oidcIssuer!,
              clientId: oidcClientId!,
              clientSecret: oidcClientSecret!,
          },
      ]
    : [Discord];
const providers: Provider[] = [
    ...primaryProviders,
    ...(githubAuthConfigured
        ? [
              GitHub({
                  clientId: process.env.AUTH_GITHUB_ID!,
                  clientSecret: process.env.AUTH_GITHUB_SECRET!,
                  allowDangerousEmailAccountLinking: false,
              }),
          ]
        : []),
];

const prismaAdapter = PrismaAdapter(db);

function githubProfileString(profile: unknown, key: string) {
    if (!profile || typeof profile !== "object") return null;
    const value = (profile as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
}

function githubLinkErrorUrl(reason: string) {
    return `/account?connection=github&github=error&reason=${encodeURIComponent(reason)}`;
}

async function signedInUserId() {
    const store = await cookies();
    const sessionToken = store
        .getAll()
        .find((cookie) => cookie.name.endsWith("authjs.session-token"))?.value;
    if (!sessionToken) return null;
    const session = await db.session.findUnique({
        where: { sessionToken },
        select: { userId: true, expires: true },
    });
    if (!session || session.expires.getTime() <= Date.now()) return null;
    return session.userId;
}

const adapter: Adapter = {
    ...prismaAdapter,
    linkAccount(account) {
        if (!prismaAdapter.linkAccount) return;
        if (account.provider !== "github") {
            return prismaAdapter.linkAccount(account);
        }
        const safeAccount = { ...account };
        delete safeAccount.access_token;
        delete safeAccount.refresh_token;
        delete safeAccount.id_token;
        delete safeAccount.session_state;
        return prismaAdapter.linkAccount(safeAccount);
    },
};

const authResult = NextAuth({
    adapter,
    session: {
        strategy: "database",
        maxAge: 180 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
    },
    providers,
    pages: {
        signIn: "/login",
        signOut: "/logout",
        error: "/login",
    },
    callbacks: {
        async signIn({ user, account, profile }) {
            if (
                account?.provider !== "github" ||
                !/^\d+$/.test(account.providerAccountId)
            ) {
                return true;
            }
            const githubId = BigInt(account.providerAccountId);
            // GitHub is a reward identity, not a sign-in method. Without a
            // member already signed in, Auth.js would create a second, empty
            // account that permanently reserves this GitHub id and locks the
            // member's real account out of ever linking it.
            let memberId: string | null = null;
            try {
                memberId = await signedInUserId();
            } catch (error) {
                console.error(
                    "[github-rewards] could not resolve the signed-in member",
                    error,
                );
                return true;
            }
            if (!memberId) return githubLinkErrorUrl("session_missing");
            const preparation = await prepareGithubAccountLink(
                memberId,
                githubId,
            );
            if (!preparation.ok) {
                return githubLinkErrorUrl(preparation.reason);
            }
            if (account.access_token) {
                try {
                    await updateGithubStarFromToken({
                        githubId,
                        login:
                            githubProfileString(profile, "login") ||
                            user.name ||
                            account.providerAccountId,
                        accessToken: account.access_token,
                        userId: memberId,
                        displayName: user.name,
                        avatarUrl:
                            githubProfileString(profile, "avatar_url") ||
                            user.image,
                    });
                    await reconcileUserFreeProxyMonitorLimit(
                        memberId,
                        "github-sign-in",
                        null,
                    );
                } catch (error) {
                    console.error(
                        "[github-rewards] sign-in star check failed",
                        error,
                    );
                }
            }
            return true;
        },
        async session({ session, user }) {
            if (session.user) {
                session.user.id = user.id;
                session.user.role = user.role ?? "free";
            }
            return session;
        },
    },
    events: {
        async linkAccount({ user, account, profile }) {
            if (
                account.provider !== "github" ||
                !/^\d+$/.test(account.providerAccountId)
            ) {
                return;
            }
            if (!user.id) return;
            const userId = user.id;
            const githubId = BigInt(account.providerAccountId);
            const login =
                githubProfileString(profile, "login") ||
                user.name ||
                account.providerAccountId;
            await claimGithubAccountForUser({
                userId,
                githubId,
                login,
                displayName: user.name,
                avatarUrl:
                    githubProfileString(profile, "avatar_url") || user.image,
            });
            if (account.access_token) {
                try {
                    await updateGithubStarFromToken({
                        githubId,
                        login,
                        accessToken: account.access_token,
                        userId,
                        displayName: user.name,
                        avatarUrl:
                            githubProfileString(profile, "avatar_url") ||
                            user.image,
                    });
                } catch (error) {
                    console.error(
                        "[github-rewards] link star check failed",
                        error,
                    );
                }
            }
            await reconcileUserFreeProxyMonitorLimit(
                userId,
                "github-link",
                null,
            );
        },
    },
});

export const { handlers, signIn, signOut } = authResult;

async function getAuthSession(): Promise<Session | null> {
    if (process.env.E2E_TEST_MODE === "true") {
        const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
        return {
            user: {
                id: userId,
                name: process.env.E2E_TEST_USER_NAME ?? "E2E User",
                email: process.env.E2E_TEST_USER_EMAIL ?? "e2e@vintrack.test",
                image: null,
                role: "admin",
            },
            expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
    }

    return authResult.auth() as Promise<Session | null>;
}

export const auth = cache(getAuthSession);
