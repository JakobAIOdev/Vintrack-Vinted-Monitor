import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { LiveFeed } from "@/components/monitors/live-feed";
import { Button } from "@/components/ui/button";
import { toggleMonitorStatus, deleteMonitor } from "@/actions/monitor";
import { ArrowLeft, PauseCircle, PlayCircle, Trash2, Tag, Globe, Zap } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getCategoryLabels } from "@/lib/categories";
import { getBrandLabels } from "@/lib/brands";
import { getSizeLabels } from "@/lib/sizes";
import { getRegionLabel } from "@/lib/regions";
import { ProxyHealthCard } from "@/components/monitors/proxy-health";

export default async function MonitorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;
  const monitorId = parseInt(resolvedParams.id);

  if (isNaN(monitorId)) return notFound();

  const monitor = await db.monitors.findUnique({
    where: { id: monitorId },
    include: {
      _count: { select: { items: true } },
      proxy_group: { select: { name: true } },
    },
  });

  if (!monitor) return notFound();

  const toggleAction = toggleMonitorStatus.bind(
    null,
    monitor.id,
    monitor.status || "active"
  );
  const deleteAction = deleteMonitor.bind(null, monitor.id);

  return (
    <div className="max-w-350 mx-auto space-y-6 p-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-3">
          <Link href="/dashboard">
            <Button variant="outline" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight">
                {monitor.query}
              </h1>
              <Badge
                variant={
                  monitor.status === "active" ? "default" : "secondary"
                }
                className={`text-[10px] font-medium ${
                  monitor.status === "active"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {monitor.status === "active" ? (
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Running
                  </span>
                ) : (
                  (monitor.status?.charAt(0).toUpperCase() ?? "") +
                  (monitor.status?.slice(1) ?? "Paused")
                )}
              </Badge>
            </div>

            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
              <span>ID: {monitor.id}</span>
              {monitor.price_max && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="flex items-center gap-1">
                    <Tag className="h-3 w-3" /> Max {monitor.price_max}€
                  </span>
                </>
              )}
              <span className="text-slate-300">·</span>
              <span>{monitor._count.items.toLocaleString()} items</span>
              <span className="text-slate-300">·</span>
              <span>{getRegionLabel(monitor.region)}</span>
              <span className="text-slate-300">·</span>
              {monitor.proxy_group ? (
                <span className="flex items-center gap-1">
                  <Globe className="h-3 w-3" /> {monitor.proxy_group.name}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-600">
                  <Zap className="h-3 w-3" /> Server Proxies
                </span>
              )}
            </div>

            {monitor.catalog_ids && (
              <div className="flex flex-wrap gap-1 mt-2">
                {getCategoryLabels(monitor.catalog_ids).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 border border-violet-200"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

            {monitor.brand_ids && (
              <div className="flex flex-wrap gap-1 mt-2">
                {getBrandLabels(monitor.brand_ids).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 border border-blue-200"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

            {monitor.size_id && (
              <div className="flex flex-wrap gap-1 mt-2">
                {getSizeLabels(monitor.size_id).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <form action={toggleAction}>
            <Button
              variant="outline"
              size="sm"
              className={`h-8 text-xs font-medium ${
                monitor.status === "active"
                  ? "text-amber-600 border-amber-200 hover:bg-amber-50"
                  : "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
              }`}
            >
              {monitor.status === "active" ? (
                <>
                  <PauseCircle className="mr-1.5 h-3.5 w-3.5" /> Pause
                </>
              ) : (
                <>
                  <PlayCircle className="mr-1.5 h-3.5 w-3.5" /> Resume
                </>
              )}
            </Button>
          </form>

          <form action={deleteAction}>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs font-medium text-red-500 border-red-200 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </form>
        </div>
      </div>

      {monitor.status === "active" && (
        <ProxyHealthCard monitorId={monitor.id} />
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4">Latest Results</h2>
        <LiveFeed monitorId={monitor.id} />
      </div>
    </div>
  );
}
