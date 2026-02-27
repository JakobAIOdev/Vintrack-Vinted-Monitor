import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { DashboardClient, type Monitor } from "./client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const rawMonitors = await db.monitors.findMany({
    where: { userId: session.user.id },
    orderBy: { created_at: "desc" },
    include: {
      _count: { select: { items: true } },
      proxy_group: { select: { name: true } },
    }
  });

  const monitors: Monitor[] = rawMonitors.map((m) => ({
    id: m.id,
    query: m.query,
    status: m.status ?? "paused", 
    price_max: m.price_max,
    catalog_ids: m.catalog_ids ?? null,
    brand_ids: m.brand_ids ?? null,
    color_ids: m.color_ids ?? null,
    size_id: m.size_id ?? null,
    region: m.region ?? "de",
    discord_webhook: m.discord_webhook ?? null,
    webhook_active: m.webhook_active ?? true, 
    proxy_group_name: m.proxy_group?.name ?? null,
    _count: m._count,
    created_at: m.created_at ? m.created_at.toISOString() : new Date().toISOString()
  }));

  return (
    <DashboardClient 
        initialMonitors={monitors} 
        userName={session.user.name || "User"}
    />
  );
}