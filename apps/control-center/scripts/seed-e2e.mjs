import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
const monitorName = "E2E Mock Feed";
const onboardingMode = process.env.E2E_ONBOARDING === "true";

const items = [
    {
        id: BigInt(990001),
        title: "E2E Nike Dunk Low Retro",
        brand: "Nike",
        price: "19.00 EUR",
        total_price: "24.49 EUR",
        size: "42",
        condition: "Sehr gut",
        location: "🇩🇪 DE",
        rating: "⭐ 4.9 (58)",
        seller_id: BigInt(880001),
        seller_login: "e2e_seller_one",
        seller_profile_url:
            "https://www.vinted.de/member/880001-e2e_seller_one",
        url: "https://www.vinted.de/items/990001-nike-dunk-low-retro",
        image_url: "/mock-images/vinted-1.svg",
        extra_images: [
            "/mock-images/vinted-2.svg",
            "/mock-images/vinted-3.svg",
        ],
        found_at: new Date(Date.now() - 60_000),
    },
    {
        id: BigInt(990002),
        title: "E2E Carhartt Detroit Jacket",
        brand: "Carhartt",
        price: "18.00 EUR",
        total_price: null,
        size: "L",
        condition: "Gut",
        location: "🇫🇷 FR",
        rating: "⭐ 5.0 (124)",
        seller_id: BigInt(880002),
        seller_login: "e2e_seller_two",
        seller_profile_url:
            "https://www.vinted.de/member/880002-e2e_seller_two",
        url: "https://www.vinted.de/items/990002-carhartt-detroit-jacket",
        image_url: "/mock-images/vinted-4.svg",
        extra_images: ["/mock-images/vinted-5.svg"],
        found_at: new Date(Date.now() - 30_000),
    },
];

async function main() {
    await db.user.upsert({
        where: { id: userId },
        create: {
            id: userId,
            name: "E2E User",
            email: "e2e@vintrack.test",
            role: onboardingMode ? "free" : "admin",
            monitor_onboarding_status: onboardingMode ? "pending" : "completed",
            telegram_message_style: "rich",
            discord_message_style: "rich",
        },
        update: {
            name: "E2E User",
            email: "e2e@vintrack.test",
            role: onboardingMode ? "free" : "admin",
            monitor_onboarding_status: onboardingMode ? "pending" : "completed",
            telegram_message_style: "rich",
            discord_message_style: "rich",
        },
    });

    if (onboardingMode) {
        await db.monitors.deleteMany({ where: { userId } });
        return;
    }

    await db.monitors.deleteMany({
        where: { userId, id: { not: 990001 } },
    });

    const monitor = await db.monitors.upsert({
        where: { id: 990001 },
        create: {
            id: 990001,
            userId,
            name: monitorName,
            query: "mock",
            query_delay_ms: 1500,
            price_min: 12,
            price_max: 22,
            size_id: "211,212",
            catalog_ids: "2309,1918",
            brand_ids: "112202",
            region: "de",
            min_seller_rating: 4.5,
            min_seller_rating_count: 5,
            status: "active",
            demo_expires_at: null,
            discord_webhook:
                "https://discord.com/api/webhooks/12345678901234567/e2e_test_token",
            webhook_active: true,
            telegram_active: false,
            notifications_enabled: true,
        },
        update: {
            userId,
            name: monitorName,
            query: "mock",
            query_delay_ms: 1500,
            quiet_hours_enabled: false,
            quiet_hours_start_minute: 0,
            quiet_hours_end_minute: 420,
            quiet_hours_mode: "pause",
            quiet_hours_delay_ms: 60000,
            quiet_hours_timezone: "Europe/Berlin",
            min_seller_rating: 4.5,
            min_seller_rating_count: 5,
            status: "active",
            demo_expires_at: null,
            discord_webhook:
                "https://discord.com/api/webhooks/12345678901234567/e2e_test_token",
            webhook_active: true,
            telegram_active: false,
            notifications_enabled: true,
        },
    });

    const limitUserId = "e2e-limit-user";
    await db.user.upsert({
        where: { id: limitUserId },
        create: {
            id: limitUserId,
            name: "E2E Limit User",
            email: "e2e-limit@vintrack.test",
            role: "free",
            monitor_onboarding_status: "completed",
        },
        update: {
            name: "E2E Limit User",
            email: "e2e-limit@vintrack.test",
            role: "free",
            monitor_onboarding_status: "completed",
        },
    });
    await db.monitor_limits.deleteMany({
        where: { scope: `user:${limitUserId}` },
    });
    for (const offset of [1, 2, 3]) {
        const data = {
            userId: limitUserId,
            name: `E2E Free Limit ${offset}`,
            query: `limit-${offset}`,
            region: "de",
            status: "active",
            proxy_source: "free",
            notifications_enabled: false,
            webhook_active: false,
            telegram_active: false,
            created_at: new Date(`2026-01-0${offset}T12:00:00.000Z`),
        };
        await db.monitors.upsert({
            where: { id: 990100 + offset },
            create: {
                id: 990100 + offset,
                ...data,
            },
            update: data,
        });
    }

    for (const item of items) {
        await db.items.upsert({
            where: {
                id_monitor_id: {
                    id: item.id,
                    monitor_id: monitor.id,
                },
            },
            create: {
                ...item,
                monitor_id: monitor.id,
            },
            update: {
                ...item,
                monitor_id: monitor.id,
            },
        });
    }
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
