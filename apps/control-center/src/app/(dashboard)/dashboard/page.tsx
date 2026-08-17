import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCategoryLabelsForRegion } from "@/lib/categories.server";
import { getSizeLabelsForRegion } from "@/lib/sizes.server";
import { redirect } from "next/navigation";
import {
    DashboardClient,
    type FreePoolUsageSummary,
    type Monitor,
} from "./client";
import { getBannedSellerIds, visibleSellerWhere } from "@/lib/seller-bans";
import { getFreeProxyPoolHealth } from "@/lib/free-proxy-health";
import { normalizeMonitorOnboardingStatus } from "@/lib/monitor-presets";
import { normalizeNotificationMessageStyle } from "@/lib/notification-message-style";
import { getMemberGithubRewardStatus } from "@/lib/github-rewards.server";
import { GithubRewardStatusCard } from "@/components/github-reward-status-card";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
    const session = await auth();
    if (!session?.user) redirect("/login");

    const [
        rawMonitors,
        userSettings,
        bannedSellerIds,
        githubRewards,
        recentLimitPauses,
    ] = await Promise.all([
        db.monitors.findMany({
            where: { userId: session.user.id },
            orderBy: { created_at: "desc" },
            include: {
                proxy_group: { select: { name: true } },
            },
        }),
        db.user.findUnique({
            where: { id: session.user.id },
            select: {
                dedupe_monitor_alerts: true,
                telegram_message_style: true,
                discord_message_style: true,
                monitor_onboarding_status: true,
            },
        }),
        getBannedSellerIds(session.user.id),
        getMemberGithubRewardStatus(session.user.id),
        db.audit_events.findMany({
            where: {
                action: "member.free_proxy_limit_reconciled",
                target_type: "user",
                target_id: session.user.id,
            },
            orderBy: { created_at: "desc" },
            take: 1,
            select: { metadata: true },
        }),
    ]);
    const usedBrandIds = [
        ...new Set(
            rawMonitors.flatMap((monitor) =>
                (monitor.brand_ids || "")
                    .split(",")
                    .filter((id) => /^\d+$/.test(id)),
            ),
        ),
    ].map((id) => BigInt(id));
    const [memberBrands, visibleCounts] = await Promise.all([
        db.member_brands.findMany({
            where: {
                userId: session.user.id,
                brand_id: { in: usedBrandIds },
            },
            select: { brand_id: true, label: true },
        }),
        db.items.groupBy({
            by: ["monitor_id"],
            where: {
                monitor_id: { in: rawMonitors.map((monitor) => monitor.id) },
                ...visibleSellerWhere(bannedSellerIds),
            },
            _count: { _all: true },
        }),
    ]);
    const memberBrandLabels = Object.fromEntries(
        memberBrands.map((brand) => [brand.brand_id.toString(), brand.label]),
    );
    const visibleCountByMonitor = new Map(
        visibleCounts.map((row) => [row.monitor_id, row._count._all]),
    );

    const monitors: Monitor[] = await Promise.all(
        rawMonitors.map(async (m) => ({
            id: m.id,
            name: m.name,
            query: m.query,
            query_delay_ms: m.query_delay_ms,
            quiet_hours_enabled: m.quiet_hours_enabled,
            quiet_hours_start_minute: m.quiet_hours_start_minute,
            quiet_hours_end_minute: m.quiet_hours_end_minute,
            quiet_hours_mode: m.quiet_hours_mode === "slow" ? "slow" : "pause",
            quiet_hours_delay_ms: m.quiet_hours_delay_ms,
            quiet_hours_timezone: m.quiet_hours_timezone,
            status: m.status ?? "paused",
            price_max: m.price_max,
            catalog_ids: m.catalog_ids ?? null,
            category_labels: await getCategoryLabelsForRegion(
                m.catalog_ids,
                m.region ?? "de",
            ),
            brand_ids: m.brand_ids ?? null,
            color_ids: m.color_ids ?? null,
            status_ids: m.status_ids ?? null,
            video_game_platform_ids: m.video_game_platform_ids ?? null,
            size_id: m.size_id ?? null,
            size_labels: await getSizeLabelsForRegion(
                m.size_id,
                m.region ?? "de",
            ),
            region: m.region ?? "de",
            allowed_countries: m.allowed_countries ?? null,
            min_seller_rating: m.min_seller_rating ?? null,
            min_seller_rating_count: m.min_seller_rating_count ?? null,
            discord_webhook: m.discord_webhook ?? null,
            webhook_active: m.webhook_active ?? true,
            telegram_active: m.telegram_active ?? false,
            notifications_enabled: m.notifications_enabled ?? true,
            proxy_source: m.proxy_source ?? "server",
            proxy_group_name: m.proxy_group?.name ?? null,
            demo_expires_at: m.demo_expires_at?.toISOString() ?? null,
            _count: { items: visibleCountByMonitor.get(m.id) ?? 0 },
            created_at: m.created_at
                ? m.created_at.toISOString()
                : new Date().toISOString(),
        })),
    );

    const onboardingStatus = normalizeMonitorOnboardingStatus(
        userSettings?.monitor_onboarding_status,
    );
    const quickStartEligible =
        monitors.length === 0 &&
        (onboardingStatus === "pending" || onboardingStatus === "dismissed");
    const freeProxyHealth = quickStartEligible
        ? await getFreeProxyPoolHealth()
        : null;
    const quickStartPool = freeProxyHealth
        ? {
              enabled: freeProxyHealth.enabled,
              minActivePerRegion: freeProxyHealth.minActivePerRegion,
              regions: Object.fromEntries(
                  Object.entries(freeProxyHealth.regions).map(
                      ([code, health]) => [
                          code,
                          { healthy: health.healthy, usable: health.usable },
                      ],
                  ),
              ),
          }
        : null;

    const promptRecord = githubRewards.prompt
        ? await db.member_reward_prompts.findUnique({
              where: {
                  userId_policy_version_prompt_type: {
                      userId: session.user.id,
                      policy_version: githubRewards.policy.version,
                      prompt_type: githubRewards.prompt.type,
                  },
              },
              select: { shown_at: true },
          })
        : null;
    const announcementRecord = githubRewards.policy.announcementEnabled
        ? await db.member_reward_prompts.findUnique({
              where: {
                  userId_policy_version_prompt_type: {
                      userId: session.user.id,
                      policy_version: githubRewards.policy.version,
                      prompt_type: "announcement",
                  },
              },
              select: { shown_at: true },
          })
        : null;
    const pauseMetadata = recentLimitPauses[0]?.metadata;
    const pausedIds =
        pauseMetadata &&
        typeof pauseMetadata === "object" &&
        !Array.isArray(pauseMetadata) &&
        Array.isArray(pauseMetadata.pausedMonitorIds)
            ? pauseMetadata.pausedMonitorIds.filter(
                  (id): id is number => typeof id === "number",
              )
            : [];
    const pausedMonitors = rawMonitors
        .filter(
            (monitor) =>
                pausedIds.includes(monitor.id) && monitor.status === "paused",
        )
        .map((monitor) => ({ id: monitor.id, name: monitor.name }));
    const freePoolUsage: FreePoolUsageSummary | null =
        githubRewards.policy.enforcementEnabled &&
        githubRewards.effectiveLimit !== null &&
        githubRewards.source !== "role_exempt"
            ? {
                  activeCount: githubRewards.freeProxyActiveCount,
                  limit: githubRewards.effectiveLimit,
                  tier:
                      githubRewards.source === "donation"
                          ? "Supporter"
                          : githubRewards.source === "github_star"
                            ? "GitHub Star"
                            : githubRewards.source === "user_override"
                              ? "Admin limit"
                              : "Default",
                  limitReached: githubRewards.limitReached,
              }
            : null;

    return (
        <div className="space-y-5">
            <GithubRewardStatusCard
                status={githubRewards}
                placement="dashboard"
                showPrompt={Boolean(
                    githubRewards.prompt && !promptRecord?.shown_at,
                )}
                showAnnouncement={Boolean(
                    githubRewards.policy.announcementEnabled &&
                    !githubRewards.prompt &&
                    !announcementRecord?.shown_at,
                )}
                pausedMonitors={pausedMonitors}
            />
            <DashboardClient
                initialMonitors={monitors}
                userName={session.user.name || "User"}
                initialDedupeMonitorAlerts={
                    userSettings?.dedupe_monitor_alerts ?? false
                }
                initialTelegramMessageStyle={normalizeNotificationMessageStyle(
                    userSettings?.telegram_message_style,
                )}
                initialDiscordMessageStyle={normalizeNotificationMessageStyle(
                    userSettings?.discord_message_style,
                )}
                quickStartEligible={quickStartEligible}
                initialQuickStartOpen={
                    quickStartEligible && onboardingStatus === "pending"
                }
                quickStartPool={quickStartPool}
                initialNow={new Date().toISOString()}
                memberBrandLabels={memberBrandLabels}
                freePoolUsage={freePoolUsage}
            />
        </div>
    );
}
