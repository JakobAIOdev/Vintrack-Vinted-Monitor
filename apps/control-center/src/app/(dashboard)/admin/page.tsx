import { auth } from "@/auth";
import { getOwnProxyLimit } from "@/lib/own-proxy-limit.server";
import { DEFAULT_OWN_PROXY_ACTIVE_LIMIT } from "@/lib/own-proxy-limit";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AdminClient } from "./client";
import {
    getFreeProxyAdminState,
    getMonitorMaintenanceAdminState,
    getInactiveMemberPolicyAdminState,
    getPriceWatchPollingAdminState,
    getWorkerPolicyAdminState,
} from "@/actions/admin";
import {
    DEFAULT_FREE_PROXY_ACTIVE_LIMIT,
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getMonitorLimits,
    roleLimitScope,
} from "@/lib/monitor-limits";
import { getMemberAnnouncement } from "@/lib/member-announcement.server";
import { DEFAULT_MEMBER_ANNOUNCEMENT } from "@/lib/member-announcement";
import { getGithubRewardsAdminState } from "@/actions/github-rewards";
import { DEFAULT_GITHUB_REWARDS_POLICY } from "@/lib/github-rewards";
import { getFeaturePoliciesAdminState } from "@/actions/admin-features";
import { getDeploymentConfigDiagnostics } from "@/lib/deployment-config.server";
import { DEFAULT_MONITOR_MAINTENANCE } from "@/lib/monitor-maintenance";
import { DEFAULT_INACTIVE_MEMBER_POLICY } from "@/lib/inactive-member-policy";
import {
    DEFAULT_FREE_PROXY_POLICY,
    DEFAULT_PRICE_WATCH_POLICY,
    DEFAULT_WORKER_POLICY,
} from "@/lib/runtime-policies";
import {
    FEATURE_DEFINITIONS,
    FEATURE_KEYS,
    defaultFeaturePolicy,
} from "@/lib/features";
import {
    ADMIN_SECTION_ROUTES,
    isAdminSection,
    type AdminSection,
} from "@/lib/admin-sections";

export const dynamic = "force-dynamic";

const EMPTY_FREE_PROXY_STATE: Awaited<
    ReturnType<typeof getFreeProxyAdminState>
> = {
    settings: { ...DEFAULT_FREE_PROXY_POLICY, enabled: false },
    degradationReason: null,
    maintainerRuntime: null,
    runtimeMetrics: [],
    counts: { active: 0, pending: 0, quarantined: 0, disabled: 0, total: 0 },
    regions: [],
    sourceDiagnostics: [],
    recent: [],
};

const EMPTY_MAINTENANCE_STATE: Awaited<
    ReturnType<typeof getMonitorMaintenanceAdminState>
> = {
    maintenance: DEFAULT_MONITOR_MAINTENANCE,
    runtime: null,
    status: "off",
    activeMonitorCount: 0,
    maintenancePausedCount: 0,
};

const EMPTY_INACTIVE_POLICY_STATE: Awaited<
    ReturnType<typeof getInactiveMemberPolicyAdminState>
> = {
    policy: DEFAULT_INACTIVE_MEMBER_POLICY,
    runtime: null,
    status: "disabled",
    preview: { memberCount: 0, monitorCount: 0, priceWatchCount: 0 },
    inactivityPausedCount: 0,
    inactivityPausedPriceWatchCount: 0,
};

const EMPTY_PRICE_WATCH_STATE: Awaited<
    ReturnType<typeof getPriceWatchPollingAdminState>
> = {
    intervalMinutes: 5,
    minMinutes: 2,
    maxMinutes: 60,
    uniqueActiveTargets: 0,
    enabled: false,
    sharedMinimumSeconds: DEFAULT_PRICE_WATCH_POLICY.sharedMinimumSeconds,
    personalMinimumSeconds: DEFAULT_PRICE_WATCH_POLICY.personalMinimumSeconds,
    sharedMaxRpm: DEFAULT_PRICE_WATCH_POLICY.sharedMaxRpm,
    personalMaxRpmPerProxy: DEFAULT_PRICE_WATCH_POLICY.personalMaxRpmPerProxy,
    activeWatches: 0,
    sharedSchedules: 0,
    personalSchedules: 0,
    expectedRpm: 0,
    checks24h: 0,
    successfulChecks24h: 0,
    accessDenied24h: 0,
    rateLimited24h: 0,
    serverErrors24h: 0,
    averageDurationMs: null,
    p50DurationMs: null,
    p95DurationMs: null,
    queueLagSeconds: 0,
    trafficBytes24h: 0,
    alertSuccessRate24h: null,
    problems: [],
    proxyProblems: [],
    publicUrlHealth: { ok: true, origin: null, source: null, error: null },
};

const EMPTY_FEATURE_POLICY_STATE: Awaited<
    ReturnType<typeof getFeaturePoliciesAdminState>
> = {
    definitions: FEATURE_DEFINITIONS,
    policies: FEATURE_KEYS.map(defaultFeaturePolicy),
};

const EMPTY_GITHUB_REWARDS_STATE: Awaited<
    ReturnType<typeof getGithubRewardsAdminState>
> = {
    policy: DEFAULT_GITHUB_REWARDS_POLICY,
    counts: { linked: 0, starred: 0, sponsorships: 0, unmatched: 0 },
    secretStatus: {
        oauth: false,
        repositoryWebhook: false,
        sponsorsWebhook: false,
        maintainerToken: false,
        syncSecret: false,
    },
    unmatched: [],
    recentSponsorships: [],
    members: [],
    recentJobs: [],
    deliveries: [],
    prompts: {},
    promptStats: { shown: 0, clicked: 0 },
    lastIntegrationTest: null,
};

export default async function AdminPage({
    searchParams,
}: {
    searchParams?: Promise<{ tab?: string }>;
}) {
    const tab = (await searchParams)?.tab;
    if (isAdminSection(tab)) redirect(ADMIN_SECTION_ROUTES[tab]);
    return renderAdminSection("overview");
}

export async function renderAdminSection(initialTab: AdminSection) {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");

    if (session.user.role !== "admin") redirect("/dashboard");

    const roles = ["free", "premium"];
    const isMemberArea = ["users", "insights", "roles"].includes(initialTab);
    const isOperationsArea = ["monitors", "price_watch", "logs"].includes(
        initialTab,
    );
    const isFeaturesArea = initialTab === "features";
    const isIntegrationsArea = initialTab === "rewards";
    const isCommunicationArea = initialTab === "announcements";
    const isSystemArea = initialTab === "settings";
    const [
        limits,
        freeProxyState,
        serverProxyRows,
        memberAnnouncement,
        monitorMaintenanceState,
        inactiveMemberPolicyState,
        githubRewardsState,
        priceWatchPollingState,
        featurePolicyState,
        workerPolicyState,
        ownProxyLimit,
    ] = await Promise.all([
        isMemberArea
            ? getMonitorLimits([
                  GLOBAL_MONITOR_LIMIT_SCOPE,
                  ...roles.map(roleLimitScope),
              ])
            : Promise.resolve(new Map()),
        isSystemArea
            ? getFreeProxyAdminState()
            : Promise.resolve(EMPTY_FREE_PROXY_STATE),
        isSystemArea
            ? db.$queryRaw<{ value: string }[]>`
                  SELECT value FROM app_settings WHERE key = ${"server_proxies"}
              `.catch((error) => {
                  console.error("[admin] failed to load server proxies", error);
                  return [];
              })
            : Promise.resolve([]),
        isCommunicationArea
            ? getMemberAnnouncement()
            : Promise.resolve(DEFAULT_MEMBER_ANNOUNCEMENT),
        isOperationsArea
            ? getMonitorMaintenanceAdminState()
            : Promise.resolve(EMPTY_MAINTENANCE_STATE),
        isOperationsArea
            ? getInactiveMemberPolicyAdminState()
            : Promise.resolve(EMPTY_INACTIVE_POLICY_STATE),
        isIntegrationsArea
            ? getGithubRewardsAdminState()
            : Promise.resolve(EMPTY_GITHUB_REWARDS_STATE),
        isOperationsArea
            ? getPriceWatchPollingAdminState()
            : Promise.resolve(EMPTY_PRICE_WATCH_STATE),
        isFeaturesArea
            ? getFeaturePoliciesAdminState()
            : Promise.resolve(EMPTY_FEATURE_POLICY_STATE),
        isSystemArea
            ? getWorkerPolicyAdminState()
            : Promise.resolve(DEFAULT_WORKER_POLICY),
        isMemberArea
            ? getOwnProxyLimit()
            : Promise.resolve(DEFAULT_OWN_PROXY_ACTIVE_LIMIT),
    ]);

    return (
        <AdminClient
            users={[]}
            logs={[]}
            initialTab={initialTab}
            currentUserId={session.user.id}
            serverProxies={serverProxyRows[0]?.value ?? ""}
            memberAnnouncement={memberAnnouncement}
            initialMonitorMaintenanceState={monitorMaintenanceState}
            initialInactiveMemberPolicyState={inactiveMemberPolicyState}
            freeProxyState={freeProxyState}
            initialGithubRewardsState={githubRewardsState}
            initialPriceWatchPollingState={priceWatchPollingState}
            initialFeaturePolicyState={featurePolicyState}
            initialWorkerPolicy={workerPolicyState}
            configDiagnostics={getDeploymentConfigDiagnostics()}
            initialOwnProxyLimit={ownProxyLimit}
            monitorLimits={{
                global:
                    limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)?.active_limit ??
                    null,
                roles: Object.fromEntries(
                    roles.map((role) => [
                        role,
                        limits.get(roleLimitScope(role))?.active_limit ?? null,
                    ]),
                ),
                users: {},
                freeProxyGlobal:
                    limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)
                        ?.free_proxy_active_limit ??
                    DEFAULT_FREE_PROXY_ACTIVE_LIMIT,
                freeProxyRoles: Object.fromEntries(
                    roles.map((role) => [
                        role,
                        limits.get(roleLimitScope(role))
                            ?.free_proxy_active_limit ?? null,
                    ]),
                ),
                freeProxyUsers: {},
                priceWatchGlobal:
                    limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)?.price_watch_limit ??
                    3,
                priceWatchRoles: Object.fromEntries(
                    roles.map((role) => [
                        role,
                        limits.get(roleLimitScope(role))?.price_watch_limit ??
                            (role === "premium" ? 50 : null),
                    ]),
                ),
                priceWatchUsers: {},
            }}
        />
    );
}
