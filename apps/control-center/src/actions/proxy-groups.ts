"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { REGIONS } from "@/lib/regions";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

const VALID_SCHEMES = ["http", "https", "socks4", "socks5"];
const BYTES_PER_GB = 1024 * 1024 * 1024;
const MAX_PROXY_CHECK_SIZE = 100;
const PROXY_CHECK_COOLDOWN_MS = 30_000;

export type ProxyCheckResult = {
    index: number;
    label: string;
    status: "working" | "slow" | "failed";
    latencyMs: number | null;
    errorCode: string | null;
};

export type ProxyCheckSnapshot = {
    status: string;
    region: string | null;
    total: number;
    checked: number;
    working: number;
    slow: number;
    failed: number;
    results: ProxyCheckResult[];
    error: string | null;
    requestedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
};

type ProxyCheckRecord = {
    proxy_check_status: string;
    proxy_check_region: string | null;
    proxy_check_total: number;
    proxy_check_checked: number;
    proxy_check_working: number;
    proxy_check_slow: number;
    proxy_check_failed: number;
    proxy_check_results: unknown;
    proxy_check_error: string | null;
    proxy_check_requested_at: Date | null;
    proxy_check_started_at: Date | null;
    proxy_check_completed_at: Date | null;
};

function isProxyCheckResult(value: unknown): value is ProxyCheckResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Record<string, unknown>;
    return (
        typeof result.index === "number" &&
        typeof result.label === "string" &&
        (result.status === "working" ||
            result.status === "slow" ||
            result.status === "failed") &&
        (result.latencyMs === null ||
            typeof result.latencyMs === "number") &&
        (result.errorCode === null || typeof result.errorCode === "string")
    );
}

function serializeProxyCheck(record: ProxyCheckRecord): ProxyCheckSnapshot {
    const results = Array.isArray(record.proxy_check_results)
        ? record.proxy_check_results.filter(isProxyCheckResult)
        : [];

    return {
        status: record.proxy_check_status,
        region: record.proxy_check_region,
        total: record.proxy_check_total,
        checked: record.proxy_check_checked,
        working: record.proxy_check_working,
        slow: record.proxy_check_slow,
        failed: record.proxy_check_failed,
        results,
        error: record.proxy_check_error,
        requestedAt: record.proxy_check_requested_at?.toISOString() ?? null,
        startedAt: record.proxy_check_started_at?.toISOString() ?? null,
        completedAt: record.proxy_check_completed_at?.toISOString() ?? null,
    };
}

function validateProxyLine(line: string): string | null {
    line = line.trim();
    if (!line) return null;

    if (/^(https?|socks[45]):\/\//.test(line)) {
        try {
            const u = new URL(line);
            if (!VALID_SCHEMES.includes(u.protocol.replace(":", "")))
                return null;
            if (!u.hostname || !u.port) return null;
            return line;
        } catch {
            return null;
        }
    }

    const parts = line.split(":");

    if (parts.length >= 4) {
        const pass = parts[parts.length - 1];
        const user = parts[parts.length - 2];
        const port = parts[parts.length - 3];
        const host = parts.slice(0, parts.length - 3).join(":");
        if (!host || !port || !user || !pass) return null;
        if (!/^\d{1,5}$/.test(port)) return null;
        return `http://${user}:${pass}@${host}:${port}`;
    }

    if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
        return `http://${line}`;
    }

    return null;
}

function validateProxies(text: string) {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const line of lines) {
        const normalized = validateProxyLine(line);
        if (normalized) {
            valid.push(normalized);
        } else {
            invalid.push(line.trim());
        }
    }
    return { valid, invalid, total: lines.length };
}

function parseBandwidthLimitBytes(formData: FormData) {
    const rawValue = (
        formData.get("bandwidth_limit_gb") as string | null
    )?.trim();

    if (!rawValue) {
        return null;
    }

    const limitGb = Number(rawValue);
    if (!Number.isFinite(limitGb) || limitGb < 0) {
        throw new Error("Bandwidth limit must be a positive number");
    }

    if (limitGb === 0) {
        return null;
    }

    return BigInt(Math.round(limitGb * BYTES_PER_GB));
}

export async function getProxyGroups() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return db.proxy_groups.findMany({
        where: { userId: session.user.id },
        orderBy: { created_at: "desc" },
        include: {
            _count: { select: { monitors: true } },
        },
    });
}

export async function createProxyGroup(formData: FormData) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const name = (formData.get("name") as string)?.trim();
    const proxies = (formData.get("proxies") as string)?.trim();
    const bandwidthLimitBytes = parseBandwidthLimitBytes(formData);

    if (!name || !proxies) throw new Error("Name and proxies are required");

    const { valid, invalid, total } = validateProxies(proxies);
    if (valid.length === 0)
        throw new Error(
            "No valid proxies found. Use format: host:port:user:pass or http://user:pass@host:port",
        );
    if (invalid.length > 0) {
        console.warn(
            `[proxy-groups] ${invalid.length}/${total} invalid lines skipped for user ${session.user.id}`,
        );
    }

    await db.proxy_groups.create({
        data: {
            userId: session.user.id,
            name,
            proxies: valid.join("\n"),
            bandwidth_limit_bytes: bandwidthLimitBytes,
        },
    });

    revalidatePath("/proxies");
}

export async function deleteProxyGroup(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const [group, user, priceWatchSchedules] = await Promise.all([
        db.proxy_groups.findFirst({
            where: { id, userId },
            include: { _count: { select: { monitors: true } } },
        }),
        db.user.findUnique({
            where: { id: userId },
            select: { role: true },
        }),
        db.price_watch_schedules.findMany({
            where: { proxy_group_id: id, proxy_group: { userId } },
            select: {
                id: true,
                target_id: true,
                _count: { select: { watches: true } },
            },
        }),
    ]);

    if (!group) throw new Error("Not found");

    const canUseServerProxies =
        user?.role === "premium" || user?.role === "admin";
    const affectedMonitorCount = group._count.monitors;
    const affectedPriceWatchCount = priceWatchSchedules.reduce(
        (total, schedule) => total + schedule._count.watches,
        0,
    );

    await db.$transaction(async (tx) => {
        if (affectedMonitorCount > 0) {
            await tx.monitors.updateMany({
                where: { userId, proxy_group_id: id },
                data: {
                    proxy_group_id: null,
                    ...(canUseServerProxies ? {} : { status: "paused" }),
                },
            });
        }

        for (const schedule of priceWatchSchedules) {
            const sharedSchedule = await tx.price_watch_schedules.upsert({
                where: {
                    target_id_transport_key: {
                        target_id: schedule.target_id,
                        transport_key: "shared",
                    },
                },
                create: {
                    target_id: schedule.target_id,
                    transport_key: "shared",
                    transport_kind: "shared",
                },
                update: {},
            });
            await tx.price_watches.updateMany({
                where: { schedule_id: schedule.id },
                data: {
                    schedule_id: sharedSchedule.id,
                    status: "paused",
                    stopped_reason: "proxy_group_deleted",
                    armed_at: null,
                    poll_interval_seconds: 120,
                },
            });
            await tx.price_watch_schedules.delete({
                where: { id: schedule.id },
            });
        }

        await tx.proxy_groups.delete({
            where: { id },
        });
    });

    revalidatePath("/proxies");
    revalidatePath("/monitors");
    revalidatePath("/price-watches");

    return {
        affectedMonitorCount,
        pausedMonitorCount: canUseServerProxies ? 0 : affectedMonitorCount,
        affectedPriceWatchCount,
    };
}

export async function updateProxyGroup(id: number, formData: FormData) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const name = (formData.get("name") as string)?.trim();
    const proxies = (formData.get("proxies") as string)?.trim();
    const bandwidthLimitBytes = parseBandwidthLimitBytes(formData);

    if (!name || !proxies) throw new Error("Name and proxies are required");

    const { valid, invalid, total } = validateProxies(proxies);
    if (valid.length === 0)
        throw new Error(
            "No valid proxies found. Use format: host:port:user:pass or http://user:pass@host:port",
        );
    if (invalid.length > 0) {
        console.warn(
            `[proxy-groups] update ${id}: ${invalid.length}/${total} invalid lines skipped`,
        );
    }

    await db.proxy_groups.update({
        where: { id, userId: session.user.id },
        data: {
            name,
            proxies: valid.join("\n"),
            bandwidth_limit_bytes: bandwidthLimitBytes,
            proxy_check_status: "idle",
            proxy_check_region: null,
            proxy_check_total: 0,
            proxy_check_checked: 0,
            proxy_check_working: 0,
            proxy_check_slow: 0,
            proxy_check_failed: 0,
            proxy_check_results: Prisma.DbNull,
            proxy_check_error: null,
            proxy_check_requested_at: null,
            proxy_check_started_at: null,
            proxy_check_completed_at: null,
        },
    });

    revalidatePath("/proxies");
}

export async function resetProxyGroupBandwidth(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.proxy_groups.update({
        where: { id, userId: session.user.id },
        data: {
            bandwidth_rx_bytes: BigInt(0),
            bandwidth_tx_bytes: BigInt(0),
            bandwidth_reset_at: new Date(),
        },
    });

    revalidatePath("/proxies");
}

export async function startProxyGroupCheck(
    id: number,
    region: string,
): Promise<ProxyCheckSnapshot> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const normalizedRegion = region.trim().toLowerCase();
    if (!REGIONS.some((candidate) => candidate.code === normalizedRegion)) {
        throw new Error("Unsupported Vinted region");
    }

    const snapshot = await db.$transaction(async (tx) => {
        const group = await tx.proxy_groups.findFirst({
            where: { id, userId },
        });
        if (!group) throw new Error("Proxy group not found");

        if (
            group.proxy_check_status === "pending" ||
            group.proxy_check_status === "running"
        ) {
            return serializeProxyCheck(group);
        }

        if (
            group.proxy_check_requested_at &&
            Date.now() - group.proxy_check_requested_at.getTime() <
                PROXY_CHECK_COOLDOWN_MS
        ) {
            throw new Error("Please wait 30 seconds before checking again");
        }

        const otherActiveJob = await tx.proxy_groups.findFirst({
            where: {
                userId,
                id: { not: id },
                proxy_check_status: { in: ["pending", "running"] },
            },
            select: { id: true },
        });
        if (otherActiveJob) {
            throw new Error(
                "Wait for your current proxy check to finish before starting another",
            );
        }

        const total = Math.min(
            MAX_PROXY_CHECK_SIZE,
            group.proxies
                .split("\n")
                .filter((line) => line.trim().length > 0).length,
        );
        const updated = await tx.proxy_groups.update({
            where: { id },
            data: {
                proxy_check_status: "pending",
                proxy_check_region: normalizedRegion,
                proxy_check_total: total,
                proxy_check_checked: 0,
                proxy_check_working: 0,
                proxy_check_slow: 0,
                proxy_check_failed: 0,
                proxy_check_results: Prisma.DbNull,
                proxy_check_error: null,
                proxy_check_requested_at: new Date(),
                proxy_check_started_at: null,
                proxy_check_completed_at: null,
            },
        });
        return serializeProxyCheck(updated);
    });

    revalidatePath("/proxies");
    return snapshot;
}

export async function getProxyGroupCheckStatus(
    id: number,
): Promise<ProxyCheckSnapshot> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const group = await db.proxy_groups.findFirst({
        where: { id, userId: session.user.id },
    });
    if (!group) throw new Error("Proxy group not found");

    return serializeProxyCheck(group);
}
