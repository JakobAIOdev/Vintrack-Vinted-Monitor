import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
    claimGithubAccountForUser,
    getGithubRewardsPolicy,
} from "@/lib/github-rewards.server";
import { reconcileUserFreeProxyMonitorLimit } from "@/lib/free-proxy-limit-reconciliation.server";
import {
    fetchStargazers,
    githubFetch,
    hasUserStarredRepository,
} from "@/lib/github-api.server";
import { isIgnorableSponsorsGraphqlError } from "@/lib/github-rewards-graphql";

type SponsorshipNode = {
    id: string;
    createdAt: string;
    isActive: boolean;
    isOneTimePayment: boolean;
    paymentSource?: string | null;
    privacyLevel?: string | null;
    sponsorEntity?: {
        databaseId?: number | null;
        login?: string;
        name?: string | null;
        avatarUrl?: string | null;
        __typename?: string;
    } | null;
    tier?: {
        name?: string;
        monthlyPriceInCents?: number;
    } | null;
};

type SponsorshipConnection = {
    // GitHub returns null for an individual sponsorship when a fine-grained
    // token may list the connection but may not read that sponsor record.
    nodes: Array<SponsorshipNode | null>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
};

type SponsorsGraphqlResponse = {
    data?: {
        user?: { sponsorshipsAsMaintainer?: SponsorshipConnection };
        organization?: { sponsorshipsAsMaintainer?: SponsorshipConnection };
    };
    errors?: { message: string; path?: Array<string | number> }[];
};

export const SPONSORSHIPS_QUERY = `
query VintrackSponsorships($login: String!, $after: String) {
  user(login: $login) {
    sponsorshipsAsMaintainer(first: 100, after: $after, activeOnly: false, includePrivate: true) {
      nodes {
        id createdAt isActive isOneTimePayment paymentSource privacyLevel
        sponsorEntity {
          __typename
          ... on User { databaseId login name avatarUrl }
          ... on Organization { databaseId login name avatarUrl }
        }
        tier { name monthlyPriceInCents }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  organization(login: $login) {
    sponsorshipsAsMaintainer(first: 100, after: $after, activeOnly: false, includePrivate: true) {
      nodes {
        id createdAt isActive isOneTimePayment paymentSource privacyLevel
        sponsorEntity {
          __typename
          ... on User { databaseId login name avatarUrl }
          ... on Organization { databaseId login name avatarUrl }
        }
        tier { name monthlyPriceInCents }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function syncStars(token: string, syncStartedAt: Date) {
    const policy = await getGithubRewardsPolicy();
    const affectedUsers = new Set<string>();
    // Fast path: one repository-wide snapshot covers every member. It is
    // unavailable for fine-grained tokens, in which case each member's own
    // public starred list is checked instead.
    const stargazers = await fetchStargazers(token, policy).catch((error) => {
        console.warn(
            "[github-rewards] stargazer snapshot unavailable, falling back to per-member checks",
            error instanceof Error ? error.message : error,
        );
        return null;
    });
    const accounts = await db.github_reward_accounts.findMany({
        where: { claimed_user_id: { not: null } },
        select: {
            github_id: true,
            claimed_user_id: true,
            star_status: true,
            login: true,
        },
        orderBy: { github_id: "asc" },
    });
    let processed = 0;
    let changed = 0;
    let failed = 0;

    for (const account of accounts) {
        try {
            const key = account.github_id.toString();
            // The snapshot carries the current login for free, so renames stay
            // reflected without an extra request per member.
            const login = stargazers?.get(key);
            const starred = stargazers
                ? stargazers.has(key)
                : await hasUserStarredRepository(
                      token,
                      account.login,
                      policy,
                  );
            const starStatus = starred ? "starred" : "unstarred";
            // The guard keeps a newer webhook event from being overwritten by
            // this snapshot.
            const update = await db.github_reward_accounts.updateMany({
                where: {
                    github_id: account.github_id,
                    OR: [
                        { star_event_at: null },
                        { star_event_at: { lte: syncStartedAt } },
                    ],
                },
                data: {
                    star_status: starStatus,
                    ...(login && login !== account.login ? { login } : {}),
                    ...(account.star_status !== starStatus
                        ? { star_changed_at: syncStartedAt }
                        : {}),
                    star_verified_at: syncStartedAt,
                    star_event_at: syncStartedAt,
                },
            });
            if (update.count > 0 && account.claimed_user_id) {
                affectedUsers.add(account.claimed_user_id);
                if (account.star_status !== starStatus) changed += 1;
            }
            processed += 1;
        } catch (error) {
            // One broken member must never abort the whole snapshot, which
            // would mark the job failed and trigger the hour-long backoff.
            failed += 1;
            console.error(
                `[github-rewards] star sync failed for ${account.github_id}`,
                error,
            );
        }
    }

    return { processed, changed, failed, affectedUsers };
}

async function syncSponsorships(token: string, syncStartedAt: Date) {
    const policy = await getGithubRewardsPolicy();
    const affectedUsers = new Set<string>();
    let processed = 0;
    let failed = 0;
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
        const response: SponsorsGraphqlResponse =
            await githubFetch<SponsorsGraphqlResponse>(
                "Sponsors GraphQL",
                "https://api.github.com/graphql",
                token,
                {
                    method: "POST",
                    body: JSON.stringify({
                        query: SPONSORSHIPS_QUERY,
                        variables: {
                            login: policy.sponsorsLogin,
                            after: cursor,
                        },
                    }),
                },
            );
        const connection =
            response.data?.user?.sponsorshipsAsMaintainer ??
            response.data?.organization?.sponsorshipsAsMaintainer;
        const unexpectedErrors = (response.errors ?? []).filter(
            (error) => !isIgnorableSponsorsGraphqlError(error),
        );
        if (unexpectedErrors.length) {
            throw new Error(
                unexpectedErrors.map((error) => error.message).join("; "),
            );
        }
        if (!connection) {
            throw new Error(
                response.errors?.map((error) => error.message).join("; ") ||
                    "GitHub Sponsors listing was not found",
            );
        }
        for (const node of connection.nodes) {
            if (!node) {
                failed += 1;
                console.warn(
                    "[github-rewards] skipped sponsorship hidden from the maintainer token",
                );
                continue;
            }
            const sponsor = node.sponsorEntity;
            if (!sponsor?.databaseId || !sponsor.login) continue;
            try {
            const githubId = BigInt(sponsor.databaseId);
            const authAccount = await db.account.findUnique({
                where: {
                    provider_providerAccountId: {
                        provider: "github",
                        providerAccountId: String(sponsor.databaseId),
                    },
                },
                select: { userId: true },
            });
            if (sponsor.__typename !== "Organization" && authAccount?.userId) {
                try {
                    await claimGithubAccountForUser({
                        userId: authAccount.userId,
                        githubId,
                        login: sponsor.login,
                        displayName: sponsor.name,
                        avatarUrl: sponsor.avatarUrl,
                    });
                } catch (error) {
                    // The GitHub identity already belongs to a different
                    // member. Record the sponsorship unassigned so it surfaces
                    // in the admin review queue instead of aborting the sync.
                    console.error(
                        `[github-rewards] could not claim sponsor ${sponsor.login}`,
                        error,
                    );
                }
            }
            const account = await db.github_reward_accounts.upsert({
                where: { github_id: githubId },
                create: {
                    github_id: githubId,
                    login: sponsor.login,
                    display_name: sponsor.name ?? null,
                    avatar_url: sponsor.avatarUrl ?? null,
                    account_type:
                        sponsor.__typename === "Organization"
                            ? "organization"
                            : "user",
                    claimed_user_id: null,
                },
                update: {
                    login: sponsor.login,
                    display_name: sponsor.name ?? null,
                    avatar_url: sponsor.avatarUrl ?? null,
                },
            });
            await db.github_sponsorships.upsert({
                where: { id: node.id },
                create: {
                    id: node.id,
                    sponsor_github_id: githubId,
                    sponsorable_login: policy.sponsorsLogin,
                    is_one_time: node.isOneTimePayment,
                    is_active: node.isActive,
                    tier_name: node.tier?.name ?? null,
                    amount_cents: node.tier?.monthlyPriceInCents ?? null,
                    payment_source: node.paymentSource ?? null,
                    privacy_level: node.privacyLevel ?? null,
                    source: "graphql_sync",
                    sponsored_at: new Date(node.createdAt),
                    last_seen_at: syncStartedAt,
                    last_verified_at: syncStartedAt,
                },
                update: {
                    is_active: node.isActive,
                    tier_name: node.tier?.name ?? null,
                    amount_cents: node.tier?.monthlyPriceInCents ?? null,
                    payment_source: node.paymentSource ?? null,
                    privacy_level: node.privacyLevel ?? null,
                    source: "graphql_sync",
                    verification_status: "verified",
                    last_seen_at: syncStartedAt,
                    last_verified_at: syncStartedAt,
                },
            });
            if (account.claimed_user_id)
                affectedUsers.add(account.claimed_user_id);
            processed += 1;
            } catch (error) {
                failed += 1;
                console.error(
                    `[github-rewards] sponsorship sync failed for ${sponsor.login}`,
                    error,
                );
            }
        }
        if (!connection.pageInfo.hasNextPage) break;
        cursor = connection.pageInfo.endCursor ?? null;
        if (!cursor)
            throw new Error("GitHub Sponsors pagination cursor missing");
    }
    return { processed, failed, affectedUsers };
}

export async function runGithubRewardsSync(trigger: "admin" | "scheduler") {
    const token = process.env.GITHUB_REWARDS_MAINTAINER_TOKEN?.trim();
    if (!token) throw new Error("GITHUB_REWARDS_MAINTAINER_TOKEN is missing");
    const syncStartedAt = new Date();
    const job = await db.$transaction(async (tx) => {
        await tx.$queryRaw<{ lock_result: string | null }[]>`
            SELECT pg_advisory_xact_lock(
                hashtext('github-rewards-sync')
            )::text AS lock_result
        `;
        const activeJob = await tx.github_reward_jobs.findFirst({
            where: {
                status: "running",
                started_at: {
                    gte: new Date(syncStartedAt.getTime() - 60 * 60 * 1000),
                },
            },
            orderBy: { started_at: "desc" },
            select: { id: true },
        });
        if (activeJob) {
            throw new Error(
                `A GitHub rewards sync is already running (${activeJob.id})`,
            );
        }
        await tx.github_reward_jobs.updateMany({
            where: {
                status: "running",
                started_at: {
                    lt: new Date(syncStartedAt.getTime() - 60 * 60 * 1000),
                },
            },
            data: {
                status: "failed",
                failed: 1,
                error: "Sync lease expired after one hour",
                completed_at: syncStartedAt,
            },
        });
        return tx.github_reward_jobs.create({
            data: {
                job_type: "full_sync",
                metadata: {
                    trigger,
                    syncStartedAt: syncStartedAt.toISOString(),
                },
            },
        });
    });
    try {
        const [stars, sponsorships] = await Promise.all([
            syncStars(token, syncStartedAt),
            syncSponsorships(token, syncStartedAt),
        ]);
        const affectedUsers = new Set([
            ...stars.affectedUsers,
            ...sponsorships.affectedUsers,
        ]);
        let paused = 0;
        let failed = stars.failed + sponsorships.failed;
        for (const userId of affectedUsers) {
            try {
                const monitors = await reconcileUserFreeProxyMonitorLimit(
                    userId,
                    "github-full-sync",
                    null,
                );
                paused += monitors.length;
            } catch (error) {
                failed += 1;
                console.error(
                    `[github-rewards] reconciliation failed for ${userId}`,
                    error,
                );
            }
        }
        const result = {
            jobId: job.id.toString(),
            trigger,
            stars: stars.processed,
            unstarred: stars.changed,
            sponsorships: sponsorships.processed,
            affectedUsers: affectedUsers.size,
            paused,
            failed,
        };
        const metadata: Prisma.InputJsonObject = result;
        await db.github_reward_jobs.update({
            where: { id: job.id },
            data: {
                // Per-member failures are recorded but do not fail the job:
                // a failed job blocks the scheduler for an hour.
                status: "completed",
                processed: stars.processed + sponsorships.processed,
                changed: stars.changed,
                failed,
                metadata,
                completed_at: new Date(),
            },
        });
        return result;
    } catch (error) {
        await db.github_reward_jobs.update({
            where: { id: job.id },
            data: {
                status: "failed",
                failed: 1,
                error:
                    error instanceof Error
                        ? error.message.slice(0, 4000)
                        : String(error).slice(0, 4000),
                completed_at: new Date(),
            },
        });
        throw error;
    }
}
