import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getFreeProxyPoolHealth } from "@/lib/free-proxy-health";
import { getMonitorActivationState } from "@/lib/monitor-limits";

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [groups, user, freeProxy, freeProxyUsage] = await Promise.all([
        db.proxy_groups.findMany({
            where: { userId: session.user.id },
            select: {
                id: true,
                name: true,
                proxies: true,
            },
            orderBy: { created_at: "desc" },
        }),
        db.user.findUnique({
            where: { id: session.user.id },
            select: { role: true },
        }),
        getFreeProxyPoolHealth(),
        getMonitorActivationState(session.user.id, "free"),
    ]);

    return NextResponse.json({
        role: user?.role ?? "free",
        groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            proxyCount: g.proxies.split("\n").filter((l) => l.trim()).length,
        })),
        freeProxy: {
            ...freeProxy,
            usage: {
                activeCount: freeProxyUsage.freeProxyActiveCount,
                activeLimit: freeProxyUsage.freeProxyActiveLimit,
                activeSlots: freeProxyUsage.freeProxyActiveSlots,
                limitSource: freeProxyUsage.freeProxyLimitSource,
                limitReached: freeProxyUsage.freeProxyLimitReached,
            },
        },
    });
}
