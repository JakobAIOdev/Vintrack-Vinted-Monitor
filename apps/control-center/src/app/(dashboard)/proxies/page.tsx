import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { ProxiesClient } from "./client";

export default async function ProxiesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const proxyGroups = await db.proxy_groups.findMany({
    where: { userId: session.user.id },
    orderBy: { created_at: "desc" },
    include: {
      _count: { select: { monitors: true } },
    },
  });

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  return (
    <ProxiesClient
      initialGroups={proxyGroups.map((g) => ({
        id: g.id,
        name: g.name,
        proxies: g.proxies,
        monitorCount: g._count.monitors,
        created_at: g.created_at?.toISOString() ?? "",
      }))}
      userRole={user?.role ?? "free"}
    />
  );
}
