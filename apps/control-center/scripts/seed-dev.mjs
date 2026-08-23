import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const adminId = process.env.E2E_TEST_USER_ID ?? "dev-admin";
const regions = ["de", "fr", "it", "es", "nl", "be", "at"];
const seededMonitorIds = [980001, 980002, 980003];
const proxyCountPerRegion = 3;

function minutesAgo(minutes) {
    return new Date(Date.now() - minutes * 60_000);
}

async function upsertUser({ id, name, email, role }) {
    await db.user.upsert({
        where: { id },
        create: {
            id,
            name,
            email,
            role,
            monitor_onboarding_status: "completed",
            last_dashboard_seen_at: minutesAgo(5),
        },
        update: {
            name,
            email,
            role,
            monitor_onboarding_status: "completed",
            last_dashboard_seen_at: minutesAgo(5),
        },
    });
}

async function upsertSetting(key, value) {
    await db.app_settings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
    });
}

async function seedUsers() {
    await upsertUser({
        id: adminId,
        name: "Local Dev Admin",
        email: "admin@vintrack.test",
        role: "admin",
    });
    await upsertUser({
        id: "dev-free-member",
        name: "Dev Free Member",
        email: "free.member@vintrack.test",
        role: "free",
    });
    await upsertUser({
        id: "dev-premium-member",
        name: "Dev Premium Member",
        email: "premium.member@vintrack.test",
        role: "premium",
    });

    const limits = [
        {
            scope: "global",
            active_limit: null,
            free_proxy_active_limit: 5,
            price_watch_limit: 5,
        },
        {
            scope: "role:free",
            active_limit: 5,
            free_proxy_active_limit: 3,
            price_watch_limit: 5,
        },
        {
            scope: "role:premium",
            active_limit: 50,
            free_proxy_active_limit: 10,
            price_watch_limit: 50,
        },
    ];
    for (const limit of limits) {
        await db.monitor_limits.upsert({
            where: { scope: limit.scope },
            create: limit,
            update: limit,
        });
    }
}

async function seedSettings() {
    const settings = {
        free_proxy_enabled: "true",
        free_proxy_auto_import_enabled: "false",
        free_proxy_starter_regions: regions.join(","),
        free_proxy_min_active_per_region: "2",
        free_proxy_target_active_per_region: "3",
        free_proxy_ready_target_active_region: "3",
        free_proxy_reserve_target_active_region: "2",
        free_proxy_idle_region_target: "2",
        free_proxy_max_pool_size: "50",
    };
    for (const [key, value] of Object.entries(settings)) {
        await upsertSetting(key, value);
    }
}

async function seedFreeProxyPools() {
    const candidateWindowToken = BigInt(
        Math.floor(Date.now() / (60 * 60 * 1000)),
    );

    for (const [regionIndex, region] of regions.entries()) {
        for (
            let proxyIndex = 1;
            proxyIndex <= proxyCountPerRegion;
            proxyIndex++
        ) {
            const host = `127.77.${regionIndex + 1}.${proxyIndex}`;
            const port = 18_000 + regionIndex * 10 + proxyIndex;
            const proxyUrl = `http://${host}:${port}`;
            const latencyMs = 90 + regionIndex * 15 + proxyIndex * 12;
            const lastCheckedAt = minutesAgo(proxyIndex);
            const proxy = await db.free_proxies.upsert({
                where: { proxy_url: proxyUrl },
                create: {
                    proxy_url: proxyUrl,
                    protocol: "http",
                    host,
                    port,
                    source: "dev-seed",
                    sources: ["dev-seed"],
                    status: "active",
                    success_count: 20 + proxyIndex,
                    failure_count: proxyIndex - 1,
                    last_checked_at: lastCheckedAt,
                    last_success_at: lastCheckedAt,
                    last_seen_at: lastCheckedAt,
                },
                update: {
                    protocol: "http",
                    host,
                    port,
                    source: "dev-seed",
                    sources: ["dev-seed"],
                    status: "active",
                    success_count: 20 + proxyIndex,
                    failure_count: proxyIndex - 1,
                    last_checked_at: lastCheckedAt,
                    last_success_at: lastCheckedAt,
                    last_failure_at: null,
                    quarantined_until: null,
                    check_claimed_until: null,
                    last_error: null,
                    last_error_code: null,
                    last_error_stage: null,
                    last_seen_at: lastCheckedAt,
                },
            });

            await db.free_proxy_health.upsert({
                where: {
                    proxy_id_region: {
                        proxy_id: proxy.id,
                        region,
                    },
                },
                create: {
                    proxy_id: proxy.id,
                    region,
                    status: "active",
                    success_streak: 8,
                    failure_streak: 0,
                    success_count: 20 + proxyIndex,
                    failure_count: proxyIndex - 1,
                    latency_ms: latencyMs,
                    last_status_code: 200,
                    last_checked_at: lastCheckedAt,
                    last_success_at: lastCheckedAt,
                    next_check_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    candidate_window_token: candidateWindowToken,
                    score: 1000 - latencyMs,
                },
                update: {
                    status: "active",
                    success_streak: 8,
                    failure_streak: 0,
                    success_count: 20 + proxyIndex,
                    failure_count: proxyIndex - 1,
                    latency_ms: latencyMs,
                    last_status_code: 200,
                    last_error: null,
                    last_error_code: null,
                    last_error_stage: null,
                    last_checked_at: lastCheckedAt,
                    last_success_at: lastCheckedAt,
                    last_failure_at: null,
                    next_check_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    candidate_window_token: candidateWindowToken,
                    score: 1000 - latencyMs,
                },
            });
        }
    }
}

async function seedProxyGroup() {
    const proxies = [
        "http://127.88.0.1:19001",
        "http://127.88.0.2:19002",
        "http://127.88.0.3:19003",
    ].join("\n");
    const results = [
        {
            index: 0,
            label: "127.88.0.1:19001",
            status: "working",
            latencyMs: 118,
            errorCode: null,
        },
        {
            index: 1,
            label: "127.88.0.2:19002",
            status: "working",
            latencyMs: 164,
            errorCode: null,
        },
        {
            index: 2,
            label: "127.88.0.3:19003",
            status: "slow",
            latencyMs: 540,
            errorCode: null,
        },
    ];
    const existing = await db.proxy_groups.findFirst({
        where: {
            userId: adminId,
            name: "Dev Synthetic Residential Pool",
        },
    });
    const data = {
        userId: adminId,
        name: "Dev Synthetic Residential Pool",
        proxies,
        bandwidth_rx_bytes: BigInt(64 * 1024 * 1024),
        bandwidth_tx_bytes: BigInt(8 * 1024 * 1024),
        bandwidth_limit_bytes: BigInt(10 * 1024 * 1024 * 1024),
        bandwidth_reset_at: minutesAgo(60),
        proxy_check_status: "completed",
        proxy_check_region: "de",
        proxy_check_total: 3,
        proxy_check_checked: 3,
        proxy_check_working: 2,
        proxy_check_slow: 1,
        proxy_check_failed: 0,
        proxy_check_results: results,
        proxy_check_error: null,
        proxy_check_requested_at: minutesAgo(3),
        proxy_check_started_at: minutesAgo(2),
        proxy_check_completed_at: minutesAgo(1),
    };

    if (existing) {
        return db.proxy_groups.update({
            where: { id: existing.id },
            data,
        });
    }
    return db.proxy_groups.create({ data });
}

async function seedMonitors(proxyGroupId) {
    const monitorRows = [
        {
            id: seededMonitorIds[0],
            userId: adminId,
            name: "Dev Free Pool Monitor",
            query: "nike dunk",
            query_delay_ms: 5000,
            price_min: 10,
            price_max: 80,
            region: "de",
            status: "active",
            proxy_source: "free",
            proxy_group_id: null,
        },
        {
            id: seededMonitorIds[1],
            userId: adminId,
            name: "Dev Personal Pool Monitor",
            query: "carhartt jacket",
            query_delay_ms: 10_000,
            price_min: 20,
            price_max: 150,
            region: "fr",
            status: "paused",
            proxy_source: "group",
            proxy_group_id: proxyGroupId,
        },
        {
            id: seededMonitorIds[2],
            userId: "dev-free-member",
            name: "Dev Member Free Monitor",
            query: "adidas samba",
            query_delay_ms: 7500,
            price_min: 15,
            price_max: 90,
            region: "nl",
            status: "paused",
            proxy_source: "free",
            proxy_group_id: null,
        },
    ];

    for (const monitor of monitorRows) {
        const data = {
            ...monitor,
            title_only: false,
            anti_keywords: "fake,damaged",
            quiet_hours_enabled: false,
            notifications_enabled: false,
            webhook_active: false,
            telegram_active: false,
            discord_webhook: null,
            demo_expires_at: null,
        };
        await db.monitors.upsert({
            where: { id: monitor.id },
            create: data,
            update: data,
        });
    }
}

async function seedFeedItems() {
    const items = [
        {
            id: BigInt(9_800_010_001),
            title: "Dev Nike Dunk Low",
            brand: "Nike",
            price: "42.00 EUR",
            total_price: "47.49 EUR",
            size: "42",
            condition: "Sehr gut",
            location: "🇩🇪 DE",
            rating: "⭐ 4.9 (82)",
            seller_id: BigInt(9_800_101),
            seller_login: "dev_seller_nike",
            seller_profile_url: "https://www.vinted.de/member/9800101",
            url: "https://www.vinted.de/items/9800010001-dev-nike-dunk",
            image_url: "/mock-images/vinted-1.svg",
            extra_images: [
                "/mock-images/vinted-2.svg",
                "/mock-images/vinted-3.svg",
            ],
            found_at: minutesAgo(2),
        },
        {
            id: BigInt(9_800_010_002),
            title: "Dev Carhartt Detroit Jacket",
            brand: "Carhartt",
            price: "68.00 EUR",
            total_price: "74.29 EUR",
            size: "L",
            condition: "Gut",
            location: "🇫🇷 FR",
            rating: "⭐ 5.0 (124)",
            seller_id: BigInt(9_800_102),
            seller_login: "dev_seller_carhartt",
            seller_profile_url: "https://www.vinted.fr/member/9800102",
            url: "https://www.vinted.fr/items/9800010002-dev-carhartt",
            image_url: "/mock-images/vinted-4.svg",
            extra_images: ["/mock-images/vinted-5.svg"],
            found_at: minutesAgo(1),
        },
    ];

    for (const item of items) {
        await db.items.upsert({
            where: {
                id_monitor_id: {
                    id: item.id,
                    monitor_id: seededMonitorIds[0],
                },
            },
            create: {
                ...item,
                monitor_id: seededMonitorIds[0],
            },
            update: item,
        });
    }
}

async function main() {
    await seedUsers();
    await seedSettings();
    await seedFreeProxyPools();
    const proxyGroup = await seedProxyGroup();
    await seedMonitors(proxyGroup.id);
    await seedFeedItems();

    const [users, monitors, proxies, healthRows, proxyGroups] =
        await Promise.all([
            db.user.count({
                where: {
                    id: {
                        in: [adminId, "dev-free-member", "dev-premium-member"],
                    },
                },
            }),
            db.monitors.count({ where: { id: { in: seededMonitorIds } } }),
            db.free_proxies.count({ where: { source: "dev-seed" } }),
            db.free_proxy_health.count({
                where: { proxy: { source: "dev-seed" } },
            }),
            db.proxy_groups.count({
                where: {
                    userId: adminId,
                    name: "Dev Synthetic Residential Pool",
                },
            }),
        ]);

    console.log(
        `Dev seed ready: ${users} users, ${monitors} monitors, ${proxies} synthetic proxies, ${healthRows} regional health rows, ${proxyGroups} personal proxy group.`,
    );
}

main()
    .then(async () => {
        await db.$disconnect();
    })
    .catch(async (error) => {
        console.error(error);
        await db.$disconnect();
        process.exit(1);
    });
