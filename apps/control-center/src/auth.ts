import NextAuth from "next-auth";
import { cache } from "react";
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
            const claimed = await db.github_reward_accounts.findUnique({
                where: { github_id: githubId },
                select: { claimed_user_id: true },
            });
            if (
                claimed?.claimed_user_id &&
                user.id &&
                claimed.claimed_user_id !== user.id
            ) {
                return false;
            }
            // GitHub is a reward identity, not a sign-in method. Without an
            // existing Vintrack member behind this flow, Auth.js would create a
            // second, empty account that permanently reserves the GitHub id and
            // locks the member's real account out of linking it.
            const persistedUser = user.id
                ? await db.user.findUnique({
                      where: { id: user.id },
                      select: { id: true },
                  })
                : null;
            if (!persistedUser) return false;
            if (account.access_token) {
                try {
                    await updateGithubStarFromToken({
                        githubId,
                        login:
                            githubProfileString(profile, "login") ||
                            user.name ||
                            account.providerAccountId,
                        accessToken: account.access_token,
                        userId: persistedUser.id,
                        displayName: user.name,
                        avatarUrl:
                            githubProfileString(profile, "avatar_url") ||
                            user.image,
                    });
                    await reconcileUserFreeProxyMonitorLimit(
                        persistedUser.id,
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
                name: "E2E User",
                email: "e2e@vintrack.test",
                image: null,
                role: "admin",
            },
            expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
    }

    return authResult.auth() as Promise<Session | null>;
}

export const auth = cache(getAuthSession);
