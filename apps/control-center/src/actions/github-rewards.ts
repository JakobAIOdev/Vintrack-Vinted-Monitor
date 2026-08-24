"use server";

import { auth, githubAuthConfigured, signIn } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import {
    GITHUB_REWARDS_SETTING_KEY,
    resolveFreeProxyLimit,
    validateGithubRewardsPolicy,
    type GithubRewardPromptType,
    type GithubRewardsPolicy,
} from "@/lib/github-rewards";
import {
    GithubStarRecheckError,
    getGithubRewardsPolicy,
    getMemberGithubRewardStatus,
    recheckGithubStarForUser,
} from "@/lib/github-rewards.server";
import {
    reconcileAllRewardEligibleUsers,
    reconcileUserFreeProxyMonitorLimit,
} from "@/lib/free-proxy-limit-reconciliation.server";
import {
    SPONSORSHIPS_QUERY,
    runGithubRewardsSync,
} from "@/lib/github-rewards-sync.server";
import { isIgnorableSponsorsGraphqlError } from "@/lib/github-rewards-graphql";
import { logAuditEvent } from "@/lib/audit";
import {
    getEffectiveMonitorLimits,
    getEffectivePriceWatchLimit,
    getMonitorActivationState,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";
import { enqueueMonitorStatusNotification } from "@/lib/alert-outbox";
import {
    fetchStargazers,
    hasUserStarredRepository,
} from "@/lib/github-api.server";
import { unlinkGithubAccountForUser } from "@/lib/github-account-linking.server";
import {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getMonitorLimits,
    roleLimitScope,
    userLimitScope,
} from "@/lib/monitor-limit-scopes";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "admin") {
        throw new Error("Unauthorized");
    }
    return session.user.id;
}

export async function connectGithubAccount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (!githubAuthConfigured)
        throw new Error("GitHub login is not configured");
    await signIn("github", {
        redirectTo: "/account?connection=github&github=connected",
    });
}

export async function recheckGithubRewards() {
    const session = await auth();
    if (!session?.user?.id) {
        return {
            ok: false as const,
            code: "unauthorized" as const,
            error: "Your session expired. Please sign in again.",
        };
    }
    try {
        const result = await recheckGithubStarForUser(session.user.id);
        await reconcileUserFreeProxyMonitorLimit(
            session.user.id,
            "github-star-recheck",
            session.user.id,
        );
        const status = await getMemberGithubRewardStatus(session.user.id);
        revalidatePath("/account");
        revalidatePath("/dashboard");
        return {
            ok: true as const,
            starred: result.starred,
            changed: result.changed,
            effectiveLimit: status.effectiveLimit,
            limitSource: status.source,
            resumableCount: await countResumableFreeProxyMonitors(
                session.user.id,
            ),
        };
    } catch (error) {
        if (error instanceof GithubStarRecheckError) {
            return {
                ok: false as const,
                code: error.code,
                error: error.message,
            };
        }
        console.error("GitHub star recheck failed", error);
        return {
            ok: false as const,
            code: "github_unavailable" as const,
            error: "GitHub could not verify your star right now. Please try again.",
        };
    }
}

/**
 * How many paused Free Pool monitors the member could start right now. Drives
 * the "start them now" affordance after a reward upgrade — an upgrade raises
 * the limit but deliberately never starts monitors on its own.
 */
async function countResumableFreeProxyMonitors(userId: string) {
    const [state, pausedCount] = await Promise.all([
        getMonitorActivationState(userId, "free"),
        db.monitors.count({
            where: { userId, status: "paused", proxy_source: "free" },
        }),
    ]);
    if (state.maintenanceEnabled) return 0;
    const slots = [state.activeSlots, state.freeProxyActiveSlots]
        .filter((value): value is number => value !== null)
        .reduce((min, value) => Math.min(min, value), pausedCount);
    return Math.max(0, Math.min(slots, pausedCount));
}

export async function resumeFreeProxyMonitorsAfterUpgrade() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;
    const transitionKey = Date.now().toString();

    const started = await withMonitorActivationLock(userId, async (tx) => {
        const state = await getMonitorActivationState(userId, "free", tx);
        if (state.maintenanceEnabled) return [];
        const pausedCount = await tx.monitors.count({
            where: { userId, status: "paused", proxy_source: "free" },
        });
        // A null limit means unlimited, so only a present limit constrains us.
        const capacity = [state.activeSlots, state.freeProxyActiveSlots]
            .filter((value): value is number => value !== null)
            .reduce((min, value) => Math.min(min, value), pausedCount);
        if (capacity <= 0) return [];

        // Monitors the limit reconciliation paused most recently come first so
        // an upgrade restores exactly what the downgrade took away.
        const monitors = await tx.monitors.findMany({
            where: { userId, status: "paused", proxy_source: "free" },
            orderBy: [
                { created_at: { sort: "desc", nulls: "last" } },
                { id: "desc" },
            ],
            take: capacity,
            select: {
                id: true,
                name: true,
                userId: true,
                discord_webhook: true,
                webhook_active: true,
                telegram_active: true,
                notifications_enabled: true,
            },
        });
        if (monitors.length === 0) return [];

        await tx.monitors.updateMany({
            where: { id: { in: monitors.map((monitor) => monitor.id) } },
            data: { status: "active" },
        });
        for (const monitor of monitors) {
            await enqueueMonitorStatusNotification(tx, monitor, {
                kind: "monitor_started",
                title: "Monitor started",
                message: `The monitor ${monitor.name} was started after your Free Proxy Pool limit increased.`,
                idempotencyKey: `reward-resume:${monitor.id}:${transitionKey}`,
            });
        }
        return monitors;
    });

    if (started.length > 0) {
        await logAuditEvent({
            userId,
            action: "member.free_proxy_limit_resumed",
            targetType: "user",
            targetId: userId,
            metadata: {
                memberUserId: userId,
                resumedMonitorIds: started.map((monitor) => monitor.id),
            },
        });
    }
    revalidatePath("/dashboard");
    revalidatePath("/account");
    return {
        startedCount: started.length,
        startedMonitorIds: started.map((monitor) => monitor.id),
    };
}

export async function disconnectGithubAccount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const accounts = await db.account.findMany({
        where: { userId: session.user.id },
        select: { provider: true, providerAccountId: true },
    });
    const github = accounts.find((account) => account.provider === "github");
    if (!github) {
        await unlinkGithubAccountForUser(session.user.id);
        await reconcileUserFreeProxyMonitorLimit(
            session.user.id,
            "github-disconnect",
            session.user.id,
        );
        revalidatePath("/account");
        revalidatePath("/dashboard");
        return { success: true };
    }
    if (!accounts.some((account) => account.provider !== "github")) {
        throw new Error(
            "Connect another login provider before disconnecting GitHub",
        );
    }
    await unlinkGithubAccountForUser(session.user.id);
    await reconcileUserFreeProxyMonitorLimit(
        session.user.id,
        "github-disconnect",
        session.user.id,
    );
    await logAuditEvent({
        userId: session.user.id,
        action: "github.account_disconnected",
        targetType: "github_account",
        targetId: github.providerAccountId,
    });
    revalidatePath("/account");
    revalidatePath("/dashboard");
    return { success: true };
}

export async function recordRewardPrompt(
    promptType: GithubRewardPromptType,
    action: "shown" | "dismissed" | "cta",
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (
        ![
            "star_upgrade",
            "donation_upgrade",
            "hard_limit",
            "announcement",
        ].includes(promptType)
    ) {
        throw new Error("Invalid reward prompt");
    }
    const policy = await getGithubRewardsPolicy();
    const now = new Date();
    await db.member_reward_prompts.upsert({
        where: {
            userId_policy_version_prompt_type: {
                userId: session.user.id,
                policy_version: policy.version,
                prompt_type: promptType,
            },
        },
        create: {
            userId: session.user.id,
            policy_version: policy.version,
            prompt_type: promptType,
            ...(action === "shown" ? { shown_at: now } : {}),
            ...(action === "dismissed" ? { dismissed_at: now } : {}),
            ...(action === "cta" ? { cta_clicked_at: now } : {}),
        },
        update: {
            ...(action === "shown" ? { shown_at: now } : {}),
            ...(action === "dismissed" ? { dismissed_at: now } : {}),
            ...(action === "cta" ? { cta_clicked_at: now } : {}),
        },
    });
    return { success: true };
}

export async function getGithubRewardsAdminState() {
    await requireAdmin();
    const [
        policy,
        linked,
        starred,
        sponsorships,
        unmatched,
        recentSponsorships,
        members,
        recentJobs,
        deliveries,
        prompts,
    ] = await Promise.all([
        getGithubRewardsPolicy(),
        db.account.count({ where: { provider: "github" } }),
        db.github_reward_accounts.count({
            where: { claimed_user_id: { not: null }, star_status: "starred" },
        }),
        db.github_sponsorships.count({ where: { reward_revoked_at: null } }),
        db.github_sponsorships.findMany({
            where: {
                reward_revoked_at: null,
                assigned_user_id: null,
                sponsor: {
                    claimed_user_id: null,
                    account_type: "organization",
                },
            },
            include: { sponsor: true },
            orderBy: { sponsored_at: "desc" },
            take: 50,
        }),
        db.github_sponsorships.findMany({
            include: {
                sponsor: true,
                assigned_user: {
                    select: { id: true, name: true, email: true },
                },
            },
            orderBy: { sponsored_at: "desc" },
            take: 50,
        }),
        db.user.findMany({
            where: { role: { not: "admin" } },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
            },
            orderBy: { createdAt: "desc" },
            take: 500,
        }),
        db.github_reward_jobs.findMany({
            orderBy: { started_at: "desc" },
            take: 10,
        }),
        db.github_webhook_deliveries.findMany({
            orderBy: { received_at: "desc" },
            take: 10,
        }),
        db.member_reward_prompts.groupBy({
            by: ["prompt_type"],
            _count: { _all: true },
        }),
    ]);
    const lastIntegrationTest = await db.app_settings.findUnique({
        where: { key: "github_rewards_last_integration_test" },
        select: { value: true },
    });
    let parsedLastIntegrationTest: unknown = null;
    try {
        parsedLastIntegrationTest = lastIntegrationTest?.value
            ? JSON.parse(lastIntegrationTest.value)
            : null;
    } catch {
        parsedLastIntegrationTest = null;
    }
    const [shownPromptCount, clickedPromptCount] = await Promise.all([
        db.member_reward_prompts.count({ where: { shown_at: { not: null } } }),
        db.member_reward_prompts.count({
            where: { cta_clicked_at: { not: null } },
        }),
    ]);
    return {
        policy,
        counts: {
            linked,
            starred,
            sponsorships,
            unmatched: unmatched.length,
        },
        secretStatus: {
            oauth: githubAuthConfigured,
            repositoryWebhook: Boolean(
                process.env.GITHUB_REPOSITORY_WEBHOOK_SECRET?.trim(),
            ),
            sponsorsWebhook: Boolean(
                process.env.GITHUB_SPONSORS_WEBHOOK_SECRET?.trim(),
            ),
            maintainerToken: Boolean(
                process.env.GITHUB_REWARDS_MAINTAINER_TOKEN?.trim(),
            ),
            syncSecret: Boolean(process.env.GITHUB_REWARDS_SYNC_SECRET?.trim()),
        },
        unmatched: unmatched.map((row) => ({
            id: row.id,
            githubId: row.sponsor_github_id.toString(),
            login: row.sponsor.login,
            accountType: row.sponsor.account_type,
            sponsoredAt: row.sponsored_at.toISOString(),
            isOneTime: row.is_one_time,
            amountCents: row.amount_cents,
        })),
        recentSponsorships: recentSponsorships.map((row) => ({
            id: row.id,
            login: row.sponsor.login,
            accountType: row.sponsor.account_type,
            sponsoredAt: row.sponsored_at.toISOString(),
            isOneTime: row.is_one_time,
            isActive: row.is_active,
            amountCents: row.amount_cents,
            source: row.source,
            assignedUser: row.assigned_user,
            claimedUserId: row.sponsor.claimed_user_id,
            revokedAt: row.reward_revoked_at?.toISOString() ?? null,
            revokeReason: row.revoke_reason,
        })),
        members,
        recentJobs: recentJobs.map((job) => ({
            id: job.id.toString(),
            type: job.job_type,
            status: job.status,
            processed: job.processed,
            changed: job.changed,
            error: job.error,
            startedAt: job.started_at.toISOString(),
            completedAt: job.completed_at?.toISOString() ?? null,
        })),
        deliveries: deliveries.map((delivery) => ({
            id: delivery.delivery_id,
            event: delivery.event,
            action: delivery.action,
            status: delivery.status,
            error: delivery.error,
            receivedAt: delivery.received_at.toISOString(),
        })),
        prompts: Object.fromEntries(
            prompts.map((row) => [row.prompt_type, row._count._all]),
        ),
        promptStats: {
            shown: shownPromptCount,
            clicked: clickedPromptCount,
        },
        lastIntegrationTest: parsedLastIntegrationTest,
    };
}

export type GithubRewardsAdminState = Awaited<
    ReturnType<typeof getGithubRewardsAdminState>
>;

export async function previewGithubRewardsEnforcement(
    input: GithubRewardsPolicy,
) {
    await requireAdmin();
    const policy = validateGithubRewardsPolicy(input);
    // Only members with at least one running Free Pool monitor can ever end up
    // over the projected limit, so the expensive per-member evaluation below
    // never has to walk the full member table.
    const activeFreeCounts = await db.monitors.groupBy({
        by: ["userId"],
        where: { status: "active", proxy_source: "free" },
    });
    const activePriceWatchCounts = await db.price_watches.groupBy({
        by: ["user_id"],
        where: { status: "active" },
    });
    const activeUserIds = Array.from(
        new Set([
            ...activeFreeCounts.map((row) => row.userId),
            ...activePriceWatchCounts.map((row) => row.user_id),
        ]),
    );
    const users = await db.user.findMany({
        where: {
            role: { not: "admin" },
            id: { in: activeUserIds },
        },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { createdAt: "asc" },
    });
    const roleLimits = await getMonitorLimits([
        GLOBAL_MONITOR_LIMIT_SCOPE,
        ...new Set(users.map((user) => roleLimitScope(user.role))),
    ]);
    const affected = [];
    const priceWatchAffected = [];
    for (const user of users) {
        const [
            status,
            current,
            override,
            activeFreeMonitors,
            activePriceWatches,
        ] = await Promise.all([
            getMemberGithubRewardStatus(user.id),
            getEffectiveMonitorLimits(user.id),
            db.monitor_limits.findUnique({
                where: { scope: userLimitScope(user.id) },
                select: {
                    free_proxy_active_limit: true,
                    price_watch_limit: true,
                },
            }),
            db.monitors.findMany({
                where: {
                    userId: user.id,
                    status: "active",
                    proxy_source: "free",
                },
                orderBy: [
                    { created_at: { sort: "desc", nulls: "last" } },
                    { id: "desc" },
                ],
                select: { id: true, name: true, created_at: true },
            }),
            db.price_watches.findMany({
                where: { user_id: user.id, status: "active" },
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                select: {
                    id: true,
                    created_at: true,
                    target: { select: { title: true, item_id: true } },
                },
            }),
        ]);
        const projected = !policy.enforcementEnabled
            ? {
                  limit: current.freeProxyActiveLimit,
                  source: current.freeProxyLimitSource,
              }
            : resolveFreeProxyLimit({
                  userOverride: override?.free_proxy_active_limit,
                  reward: !policy.eligibleRoles.includes(user.role)
                      ? { limit: null, source: "role_exempt" }
                      : status.donated
                        ? { limit: policy.donationLimit, source: "donation" }
                        : status.starred
                          ? { limit: policy.starLimit, source: "github_star" }
                          : {
                                limit: policy.defaultLimit,
                                source: "policy_default",
                            },
                  roleLimit: roleLimits.get(roleLimitScope(user.role))
                      ?.free_proxy_active_limit,
                  globalLimit: roleLimits.get(GLOBAL_MONITOR_LIMIT_SCOPE)
                      ?.free_proxy_active_limit,
              });
        const excess =
            projected.limit === null
                ? 0
                : Math.max(activeFreeMonitors.length - projected.limit, 0);
        if (excess > 0) {
            affected.push({
                userId: user.id,
                member: user.name || user.email || user.id,
                role: user.role,
                currentLimit: current.freeProxyActiveLimit,
                currentSource: current.freeProxyLimitSource,
                projectedLimit: projected.limit,
                projectedSource: projected.source,
                activeFreeCount: activeFreeMonitors.length,
                monitorsToPause: activeFreeMonitors
                    .slice(0, excess)
                    .map((monitor) => ({
                        id: monitor.id,
                        name: monitor.name,
                        createdAt: monitor.created_at?.toISOString() ?? null,
                    })),
            });
        }

        const rolePriceWatchLimit =
            roleLimits.get(roleLimitScope(user.role))?.price_watch_limit ??
            roleLimits.get(GLOBAL_MONITOR_LIMIT_SCOPE)?.price_watch_limit ??
            null;
        const projectedPriceWatchLimit =
            override?.price_watch_limit != null
                ? override.price_watch_limit
                : policy.enforcementEnabled &&
                    policy.priceWatchRewardsEnabled &&
                    policy.eligibleRoles.includes(user.role)
                  ? status.donated
                      ? policy.priceWatchDonationLimit
                      : status.starred
                        ? policy.priceWatchStarLimit
                        : policy.priceWatchDefaultLimit
                  : rolePriceWatchLimit;
        const priceWatchExcess =
            projectedPriceWatchLimit === null
                ? 0
                : Math.max(
                      activePriceWatches.length - projectedPriceWatchLimit,
                      0,
                  );
        if (priceWatchExcess > 0) {
            priceWatchAffected.push({
                userId: user.id,
                member: user.name || user.email || user.id,
                role: user.role,
                projectedLimit: projectedPriceWatchLimit,
                activeCount: activePriceWatches.length,
                watchesToPause: activePriceWatches
                    .slice(0, priceWatchExcess)
                    .map((watch) => ({
                        id: watch.id.toString(),
                        title:
                            watch.target.title ||
                            `Vinted item ${watch.target.item_id.toString()}`,
                        createdAt: watch.created_at.toISOString(),
                    })),
            });
        }
    }
    return {
        affectedMembers: new Set([
            ...affected.map((row) => row.userId),
            ...priceWatchAffected.map((row) => row.userId),
        ]).size,
        monitorsToPause: affected.reduce(
            (total, row) => total + row.monitorsToPause.length,
            0,
        ),
        priceWatchesToPause: priceWatchAffected.reduce(
            (total, row) => total + row.watchesToPause.length,
            0,
        ),
        affected,
        priceWatchAffected,
    };
}

export type GithubRewardsEnforcementPreview = Awaited<
    ReturnType<typeof previewGithubRewardsEnforcement>
>;

/**
 * Determines how the star sync will read star state with the configured token:
 * a repository-wide snapshot (classic tokens) or per-member starred lists
 * (fine-grained tokens, which GitHub refuses on the stargazers endpoint).
 */
async function probeStarSource(
    token: string,
    policy: { repositoryOwner: string; repositoryName: string },
): Promise<{ ok: boolean; mode: "snapshot" | "per_member" | null }> {
    const snapshot = await fetchStargazers(token, policy)
        .then(() => true)
        .catch(() => false);
    if (snapshot) return { ok: true, mode: "snapshot" };
    const perMember = await hasUserStarredRepository(
        token,
        policy.repositoryOwner,
        policy,
    )
        .then(() => true)
        .catch(() => false);
    return { ok: perMember, mode: perMember ? "per_member" : null };
}

export async function testGithubRewardsIntegration() {
    await requireAdmin();
    const policy = await getGithubRewardsPolicy();
    const token = process.env.GITHUB_REWARDS_MAINTAINER_TOKEN?.trim();
    const testedAt = new Date().toISOString();
    if (!token) {
        const result = {
            testedAt,
            oauthConfigured: githubAuthConfigured,
            repository: { ok: false, status: 0 },
            starSource: {
                ok: false,
                mode: null as "snapshot" | "per_member" | null,
            },
            sponsors: { ok: false, status: 0 },
            rateLimitRemaining: null as string | null,
            error: "Maintainer token is missing",
        };
        await db.app_settings.upsert({
            where: { key: "github_rewards_last_integration_test" },
            create: {
                key: "github_rewards_last_integration_test",
                value: JSON.stringify(result),
            },
            update: { value: JSON.stringify(result) },
        });
        return result;
    }
    const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Vintrack-GitHub-Rewards",
    };
    const [repositoryResponse, starSource, sponsorsResponse] =
        await Promise.all([
            fetch(
                `https://api.github.com/repos/${encodeURIComponent(policy.repositoryOwner)}/${encodeURIComponent(policy.repositoryName)}`,
                { headers, cache: "no-store" },
            ),
            // Reading the repository does not imply the token may list its
            // stargazers — fine-grained tokens are always rejected there — so
            // probe both star paths and report which one the sync will use.
            probeStarSource(token, policy),
            fetch("https://api.github.com/graphql", {
                method: "POST",
                headers,
                cache: "no-store",
                body: JSON.stringify({
                    // Probe the same fields as the real sync. A totalCount-only
                    // query can pass even when every full sync would fail.
                    query: SPONSORSHIPS_QUERY,
                    variables: {
                        login: policy.sponsorsLogin,
                        after: null,
                    },
                }),
            }),
        ]);
    const sponsorsPayload = (await sponsorsResponse
        .json()
        .catch(() => null)) as {
        data?: {
            user?: { sponsorshipsAsMaintainer?: unknown } | null;
            organization?: { sponsorshipsAsMaintainer?: unknown } | null;
        };
        errors?: {
            message?: string;
            path?: Array<string | number>;
        }[];
    } | null;
    const sponsorsTargetFound = Boolean(
        sponsorsPayload?.data?.user?.sponsorshipsAsMaintainer ??
        sponsorsPayload?.data?.organization?.sponsorshipsAsMaintainer,
    );
    const unexpectedSponsorsErrors = (sponsorsPayload?.errors ?? []).filter(
        (error) =>
            !isIgnorableSponsorsGraphqlError({
                message: error.message ?? "",
                path: error.path,
            }),
    );
    const sponsorsApiOk =
        sponsorsResponse.ok &&
        sponsorsTargetFound &&
        unexpectedSponsorsErrors.length === 0;
    const result = {
        testedAt,
        oauthConfigured: githubAuthConfigured,
        repository: {
            ok: repositoryResponse.ok && starSource.ok,
            status: repositoryResponse.status,
        },
        starSource,
        sponsors: {
            ok: sponsorsApiOk,
            status: sponsorsResponse.status,
        },
        rateLimitRemaining:
            repositoryResponse.headers.get("x-ratelimit-remaining") ??
            sponsorsResponse.headers.get("x-ratelimit-remaining"),
        error: !starSource.ok
            ? "Star state cannot be read with this token. Check the repository owner/name, and that the token may read public repository data."
            : sponsorsApiOk
              ? null
              : (unexpectedSponsorsErrors[0]?.message?.slice(0, 300) ??
                sponsorsPayload?.errors?.[0]?.message?.slice(0, 300) ??
                "GitHub Sponsors account was not found"),
    };
    await db.app_settings.upsert({
        where: { key: "github_rewards_last_integration_test" },
        create: {
            key: "github_rewards_last_integration_test",
            value: JSON.stringify(result),
        },
        update: { value: JSON.stringify(result) },
    });
    revalidatePath("/admin");
    return result;
}

export async function saveGithubRewardsPolicy(input: GithubRewardsPolicy) {
    const adminUserId = await requireAdmin();
    const policy = validateGithubRewardsPolicy(input);
    const previous = await getGithubRewardsPolicy();
    await db.app_settings.upsert({
        where: { key: GITHUB_REWARDS_SETTING_KEY },
        create: {
            key: GITHUB_REWARDS_SETTING_KEY,
            value: JSON.stringify(policy),
        },
        update: { value: JSON.stringify(policy) },
    });
    const requiresReconciliation =
        policy.enforcementEnabled !== previous.enforcementEnabled ||
        (policy.enforcementEnabled &&
            (policy.defaultLimit < previous.defaultLimit ||
                policy.starLimit < previous.starLimit ||
                policy.donationLimit < previous.donationLimit ||
                policy.priceWatchDefaultLimit <
                    previous.priceWatchDefaultLimit ||
                policy.priceWatchStarLimit < previous.priceWatchStarLimit ||
                policy.priceWatchDonationLimit <
                    previous.priceWatchDonationLimit ||
                policy.priceWatchRewardsEnabled !==
                    previous.priceWatchRewardsEnabled ||
                policy.eligibleRoles.join(",") !==
                    previous.eligibleRoles.join(",")));
    // Reconciliation reads the policy through a transaction client, which
    // bypasses the request-scoped policy cache — it therefore sees the value
    // just written above rather than the one read into `previous`.
    const reconciliation = requiresReconciliation
        ? await reconcileAllRewardEligibleUsers("github-policy-update")
        : { pausedCount: 0, pausedMonitorIds: [] as number[] };
    let pausedPriceWatchCount = 0;
    if (requiresReconciliation) {
        const members = await db.user.findMany({
            where: { role: { not: "admin" } },
            select: { id: true },
        });
        for (const member of members) {
            pausedPriceWatchCount += await db.$transaction(async (tx) => {
                const { priceWatchLimit } = await getEffectivePriceWatchLimit(
                    member.id,
                    tx,
                );
                if (priceWatchLimit === null) return 0;
                const active = await tx.price_watches.findMany({
                    where: { user_id: member.id, status: "active" },
                    orderBy: [{ created_at: "desc" }, { id: "desc" }],
                    select: { id: true },
                });
                const excess = active.slice(
                    0,
                    Math.max(0, active.length - priceWatchLimit),
                );
                if (excess.length === 0) return 0;
                const result = await tx.price_watches.updateMany({
                    where: { id: { in: excess.map((watch) => watch.id) } },
                    data: {
                        status: "paused",
                        stopped_reason: "reward_limit_reduced",
                        armed_at: null,
                    },
                });
                return result.count;
            });
        }
    }
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.github_rewards_policy_updated",
        targetType: "app_setting",
        targetId: GITHUB_REWARDS_SETTING_KEY,
        metadata: {
            version: policy.version,
            enforcementEnabled: policy.enforcementEnabled,
            limits: {
                default: policy.defaultLimit,
                star: policy.starLimit,
                donation: policy.donationLimit,
            },
            pausedCount: reconciliation.pausedCount,
            pausedPriceWatchCount,
        },
    });
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    revalidatePath("/account");
    return {
        success: true,
        policy,
        reconciliation: { ...reconciliation, pausedPriceWatchCount },
    };
}

export async function runGithubRewardsSyncAction() {
    const adminUserId = await requireAdmin();
    try {
        const result = await runGithubRewardsSync("admin");
        await logAuditEvent({
            userId: adminUserId,
            action: "admin.github_rewards_sync_completed",
            targetType: "github_reward_job",
            targetId: result.jobId,
            metadata: result,
        });
        revalidatePath("/admin");
        revalidatePath("/dashboard");
        return { ok: true as const, ...result };
    } catch (error) {
        console.error("[github-rewards] manual sync failed", error);
        const message = error instanceof Error ? error.message : "";
        const safeMessage =
            message === "GITHUB_REWARDS_MAINTAINER_TOKEN is missing" ||
            message === "Resource not accessible by personal access token" ||
            // Keep this in sync with the `label` values passed to githubFetch;
            // an unlisted label silently hides the real cause from the admin.
            /^GitHub (GitHub user|Repository stargazers|User stars|Sponsors GraphQL) API request failed \(\d{3}\)(?:: .+)?$/.test(
                message,
            ) ||
            message.startsWith("A GitHub rewards sync is already running (") ||
            message.startsWith("GitHub star list too long to verify for ") ||
            message === "GitHub stargazer pagination incomplete" ||
            message === "GitHub Sponsors listing was not found" ||
            message === "GitHub Sponsors pagination cursor missing"
                ? message
                : "GitHub rewards sync failed. Check Integration health and the control-center logs.";
        return { ok: false as const, error: safeMessage };
    }
}

export async function assignGithubSponsorship(
    sponsorshipId: string,
    userId: string,
) {
    const adminUserId = await requireAdmin();
    const existing = await db.github_sponsorships.findUnique({
        where: { id: sponsorshipId },
        select: {
            assigned_user_id: true,
            reward_revoked_at: true,
            sponsor: {
                select: { claimed_user_id: true, account_type: true },
            },
        },
    });
    if (!existing) throw new Error("Sponsorship not found");
    if (existing.reward_revoked_at) {
        throw new Error("A revoked sponsorship cannot be assigned");
    }
    if (existing.sponsor.account_type !== "organization") {
        throw new Error(
            "Personal sponsorships are assigned only by verified GitHub linking",
        );
    }
    await db.github_sponsorships.update({
        where: { id: sponsorshipId },
        data: { assigned_user_id: userId },
    });
    await reconcileUserFreeProxyMonitorLimit(
        userId,
        "github-organization-donation",
        adminUserId,
    );
    const previousUserId =
        existing.assigned_user_id ?? existing.sponsor.claimed_user_id;
    if (previousUserId && previousUserId !== userId) {
        await reconcileUserFreeProxyMonitorLimit(
            previousUserId,
            "github-organization-donation-reassigned",
            adminUserId,
        );
    }
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.github_sponsorship_assigned",
        targetType: "github_sponsorship",
        targetId: sponsorshipId,
        metadata: { memberUserId: userId },
    });
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return { success: true };
}

export async function revokeGithubSponsorship(
    sponsorshipId: string,
    reason: string,
) {
    const adminUserId = await requireAdmin();
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("A revoke reason is required");
    const sponsorship = await db.github_sponsorships.update({
        where: { id: sponsorshipId },
        data: {
            reward_revoked_at: new Date(),
            revoke_reason: normalizedReason,
        },
        include: { sponsor: true },
    });
    const userId =
        sponsorship.assigned_user_id ?? sponsorship.sponsor.claimed_user_id;
    if (userId) {
        await reconcileUserFreeProxyMonitorLimit(
            userId,
            "github-sponsorship-revoked",
            adminUserId,
        );
    }
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.github_sponsorship_revoked",
        targetType: "github_sponsorship",
        targetId: sponsorshipId,
        metadata: { memberUserId: userId, reason: normalizedReason },
    });
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return { success: true };
}
