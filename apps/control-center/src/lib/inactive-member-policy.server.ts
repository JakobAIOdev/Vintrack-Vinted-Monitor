import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
    INACTIVE_MEMBER_POLICY_SETTING_KEY,
    INACTIVE_MEMBER_RUNTIME_SETTING_KEY,
    parseInactiveMemberPolicy,
    parseInactiveMemberRuntime,
    type InactiveMemberPolicy,
} from "@/lib/inactive-member-policy";

type Client = Prisma.TransactionClient | typeof db;

export async function getInactiveMemberPolicy(client: Client = db) {
    const row = await client.app_settings.findUnique({
        where: { key: INACTIVE_MEMBER_POLICY_SETTING_KEY },
        select: { value: true },
    });
    return parseInactiveMemberPolicy(row?.value);
}

export async function getInactiveMemberRuntime(client: Client = db) {
    const row = await client.app_settings.findUnique({
        where: { key: INACTIVE_MEMBER_RUNTIME_SETTING_KEY },
        select: { value: true },
    });
    return parseInactiveMemberRuntime(row?.value);
}

export async function countInactivePolicyMatches(
    policy: InactiveMemberPolicy,
    client: Client = db,
) {
    if (!policy.enabled || !policy.enabledAt || policy.roles.length === 0) {
        return { memberCount: 0, monitorCount: 0 };
    }
    const rows = await client.$queryRaw<
        { member_count: bigint; monitor_count: bigint }[]
    >(Prisma.sql`
        SELECT COUNT(DISTINCT u.id)::bigint AS member_count,
               COUNT(m.id)::bigint AS monitor_count
        FROM "User" u
        JOIN monitors m ON m."userId" = u.id
        WHERE m.status = 'active'
          AND u.role IN (${Prisma.join(policy.roles)})
          AND ${policy.monitorScope === "all" ? Prisma.sql`TRUE` : Prisma.sql`m.proxy_source = 'free'`}
          AND GREATEST(
                COALESCE(u.last_dashboard_seen_at, '-infinity'::timestamp),
                COALESCE(u."createdAt", '-infinity'::timestamp),
                ${new Date(policy.enabledAt)}::timestamp
              ) <= NOW() - (${policy.durationDays} * INTERVAL '1 day')
    `);
    return {
        memberCount: Number(rows[0]?.member_count ?? 0),
        monitorCount: Number(rows[0]?.monitor_count ?? 0),
    };
}

export async function isUserInactiveForPolicy(
    userId: string,
    policy: InactiveMemberPolicy,
    client: Client = db,
) {
    if (!policy.enabled || !policy.enabledAt || policy.roles.length === 0) {
        return false;
    }
    const rows = await client.$queryRaw<{ inactive: boolean }[]>(Prisma.sql`
        SELECT EXISTS (
            SELECT 1 FROM "User" u
            WHERE u.id = ${userId}
              AND u.role IN (${Prisma.join(policy.roles)})
              AND GREATEST(
                    COALESCE(u.last_dashboard_seen_at, '-infinity'::timestamp),
                    COALESCE(u."createdAt", '-infinity'::timestamp),
                    ${new Date(policy.enabledAt)}::timestamp
                  ) <= NOW() - (${policy.durationDays} * INTERVAL '1 day')
        ) AS inactive
    `);
    return rows[0]?.inactive === true;
}

export async function getInactiveEligibleMonitorIds(
    policy: InactiveMemberPolicy,
    status: string,
    client: Client = db,
) {
    if (!policy.enabled || !policy.enabledAt || policy.roles.length === 0) {
        return [];
    }
    const rows = await client.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT m.id
        FROM monitors m
        JOIN "User" u ON u.id = m."userId"
        WHERE m.status = ${status}
          AND u.role IN (${Prisma.join(policy.roles)})
          AND ${policy.monitorScope === "all" ? Prisma.sql`TRUE` : Prisma.sql`m.proxy_source = 'free'`}
          AND GREATEST(
                COALESCE(u.last_dashboard_seen_at, '-infinity'::timestamp),
                COALESCE(u."createdAt", '-infinity'::timestamp),
                ${new Date(policy.enabledAt)}::timestamp
              ) <= NOW() - (${policy.durationDays} * INTERVAL '1 day')
    `);
    return rows.map((row) => row.id);
}
