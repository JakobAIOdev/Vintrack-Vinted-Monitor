"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  PauseCircle,
  PlayCircle,
  Plus,
  StopCircle,
  Webhook,
  Radio,
  Package,
  ArrowRight,
  MoreHorizontal,
  Globe,
  Zap,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  stopAllMonitors,
  toggleMonitor,
  updateMonitorWebhook,
  toggleWebhookStatus,
} from "@/actions/dashboard-actions";
import { getCategoryLabels } from "@/lib/categories";
import { getBrandLabels } from "@/lib/brands";
import { getColorLabels } from "@/lib/colors";
import { getSizeLabels } from "@/lib/sizes";
import { getRegionLabel } from "@/lib/regions";

type MonitorHealth = {
  monitor_id: number;
  total_checks: number;
  total_errors: number;
  consecutive_errors: number;
  last_error?: string;
  updated_at: string;
};

export type Monitor = {
  id: number;
  query: string;
  status: string;
  price_max: number | null;
  catalog_ids: string | null;
  brand_ids: string | null;
  color_ids: string | null;
  size_id: string | null;
  region: string;
  discord_webhook: string | null;
  webhook_active: boolean;
  proxy_group_name: string | null;
  _count: { items: number };
  created_at: string;
};

function hasProxyWarning(h?: MonitorHealth): boolean {
  if (!h) return false;
  if (h.consecutive_errors === -1 || h.consecutive_errors >= 3) return true;
  return false;
}

export function DashboardClient({
  initialMonitors,
  userName,
}: {
  initialMonitors: Monitor[];
  userName: string;
}) {
  const [selectedMonitor, setSelectedMonitor] = useState<Monitor | null>(null);
  const [webhookInput, setWebhookInput] = useState("");
  const [isWebhookOpen, setIsWebhookOpen] = useState(false);
  const [isWebhookActive, setIsWebhookActive] = useState(true);
  const [monitors, setMonitors] = useState<Monitor[]>(initialMonitors);
  const [healthMap, setHealthMap] = useState<Record<number, MonitorHealth>>({});

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/monitors/health");
      if (res.ok) {
        const data = await res.json();
        setHealthMap(data);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const openWebhookDialog = (monitor: Monitor) => {
    setSelectedMonitor(monitor);
    setWebhookInput(monitor.discord_webhook || "");
    setIsWebhookActive(monitor.webhook_active);
    setIsWebhookOpen(true);
  };

  const sortedMonitors = useMemo(() => {
    return [...monitors].sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  }, [monitors]);

  const handleStopAll = async () => {
    setMonitors((prev) => prev.map((m) => ({ ...m, status: "paused" })));
    toast.promise(stopAllMonitors(), {
      loading: "Stopping all monitors...",
      success: "All monitors stopped",
      error: "Failed to stop monitors",
    });
  };

  const handleToggle = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    const actionText = newStatus === "active" ? "Resumed" : "Paused";

    setMonitors((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: newStatus } : m))
    );

    toast.promise(toggleMonitor(id, currentStatus), {
      loading: "Updating...",
      success: `Monitor ${actionText}`,
      error: () => {
        setMonitors((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, status: currentStatus } : m
          )
        );
        return "Failed to update monitor";
      },
    });
  };

  const handleSaveWebhook = async () => {
    if (!selectedMonitor) return;
    setMonitors((prev) =>
      prev.map((m) =>
        m.id === selectedMonitor.id
          ? { ...m, discord_webhook: webhookInput }
          : m
      )
    );
    toast.promise(updateMonitorWebhook(selectedMonitor.id, webhookInput), {
      loading: "Saving...",
      success: () => {
        setIsWebhookOpen(false);
        return "Webhook saved";
      },
      error: "Failed to save webhook",
    });
  };

  const activeCount = monitors.filter((m) => m.status === "active").length;
  const totalItems = monitors.reduce((sum, m) => sum + m._count.items, 0);

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Welcome back, {userName}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage and monitor your Vinted scrapers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopAll}
              className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              <StopCircle className="w-3.5 h-3.5" /> Stop All
            </Button>
          )}
          <Link href="/monitors/new">
            <Button size="sm" className="gap-1.5">
              <Plus className="w-3.5 h-3.5" /> New Monitor
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200/60 px-5 py-4">
          <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
            Total Monitors
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-1">
            {monitors.length}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200/60 px-5 py-4">
          <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
            Active
          </p>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-2xl font-bold text-slate-900">{activeCount}</p>
            {activeCount > 0 && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            )}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200/60 px-5 py-4">
          <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
            Items Found
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-1">
            {totalItems.toLocaleString()}
          </p>
        </div>
      </div>

      {monitors.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
          <div className="bg-slate-100 p-3 rounded-xl mb-4">
            <Radio className="w-6 h-6 text-slate-400" />
          </div>
          <h3 className="text-base font-semibold text-slate-800">
            No monitors yet
          </h3>
          <p className="text-sm text-slate-500 mt-1 mb-4">
            Create your first monitor to start finding deals.
          </p>
          <Link href="/monitors/new">
            <Button size="sm" className="gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Create Monitor
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedMonitors.map((m) => (
            <Card
              key={m.id}
              className="group bg-white border-slate-200/60 hover:border-slate-300 transition-colors overflow-hidden flex flex-col"
            >
              <CardContent className="p-5 flex flex-col flex-1">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0 flex-1">
                    <h3
                      className="font-semibold text-[15px] text-slate-900 truncate"
                      title={m.query}
                    >
                      {m.query}
                    </h3>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge
                        variant={
                          m.status === "active" ? "default" : "secondary"
                        }
                        className={`text-[10px] font-medium ${
                          m.status === "active"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                            : m.status === "error"
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {m.status === "active" ? (
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            Running
                          </span>
                        ) : m.status === "error" ? (
                          <span className="flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            Proxy Error
                          </span>
                        ) : (
                          "Paused"
                        )}
                      </Badge>
                      {m.price_max && (
                        <span className="text-[11px] text-slate-400">
                          Max {m.price_max}€
                        </span>
                      )}
                      {m.region && m.region && (
                        <span className="text-[11px] text-slate-400">
                          {getRegionLabel(m.region)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Link href={`/monitors/${m.id}/edit`}>
                      <button
                        className="text-slate-300 hover:text-slate-500 transition-colors p-1.5 rounded-md hover:bg-slate-50"
                        title="Edit monitor"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </Link>
                    <button
                      onClick={() => openWebhookDialog(m)}
                      className="text-slate-300 hover:text-slate-500 transition-colors p-1.5 rounded-md hover:bg-slate-50"
                      title="Configure webhook"
                    >
                      <Webhook
                        className={`w-3.5 h-3.5 ${
                          m.discord_webhook && m.webhook_active
                            ? "text-indigo-400"
                            : ""
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {(m.catalog_ids || m.brand_ids || m.color_ids || m.size_id) && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {m.catalog_ids &&
                      getCategoryLabels(m.catalog_ids).map((label) => (
                        <span
                          key={`cat-${label}`}
                          className="inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 border border-violet-200"
                        >
                          {label}
                        </span>
                      ))}
                    {m.brand_ids &&
                      getBrandLabels(m.brand_ids).map((label) => (
                        <span
                          key={`brand-${label}`}
                          className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 border border-blue-200"
                        >
                          {label}
                        </span>
                      ))}
                    {m.color_ids &&
                      getColorLabels(m.color_ids).map((label) => (
                        <span
                          key={`color-${label}`}
                          className="inline-flex items-center rounded-md bg-pink-50 px-1.5 py-0.5 text-[10px] font-medium text-pink-700 border border-pink-200"
                        >
                          {label}
                        </span>
                      ))}
                    {m.size_id &&
                      getSizeLabels(m.size_id).map((label) => (
                        <span
                          key={`size-${label}`}
                          className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200"
                        >
                          {label}
                        </span>
                      ))}
                  </div>
                )}

                <div className="flex-1" />

                <div className="flex items-center gap-1.5 text-[13px] text-slate-500 mb-1.5">
                  <Package className="w-3.5 h-3.5 text-slate-400" />
                  <span className="font-medium text-slate-700">
                    {m._count.items.toLocaleString()}
                  </span>
                  items found
                </div>

                <div className="flex items-center gap-1.5 text-[13px] text-slate-500 mb-2">
                  {m.proxy_group_name ? (
                    <>
                      <Globe className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-medium text-slate-700 truncate" title={m.proxy_group_name}>
                        {m.proxy_group_name}
                      </span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                      <span className="font-medium text-amber-600">
                        Server Proxies
                      </span>
                    </>
                  )}
                  {m.status === "active" && hasProxyWarning(healthMap[m.id]) && (
                    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border bg-red-50 text-red-700 border-red-200">
                      <AlertTriangle className="w-3 h-3" />
                      Proxy Warning
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggle(m.id, m.status)}
                    className={`h-8 px-3 text-xs font-medium ${
                      m.status === "active"
                        ? "text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        : "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                    }`}
                  >
                    {m.status === "active" ? (
                      <>
                        <PauseCircle className="w-3.5 h-3.5 mr-1" /> Pause
                      </>
                    ) : (
                      <>
                        <PlayCircle className="w-3.5 h-3.5 mr-1" /> Resume
                      </>
                    )}
                  </Button>
                  <div className="flex-1" />
                  <Link href={`/monitors/${m.id}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-3 text-xs font-medium text-slate-500 hover:text-slate-800 gap-1"
                    >
                      View <ArrowRight className="w-3 h-3" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isWebhookOpen} onOpenChange={setIsWebhookOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discord Webhook</DialogTitle>
            <DialogDescription>
              Configure notifications for{" "}
              <strong>{selectedMonitor?.query}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-4">
            <div className="grid gap-2">
              <Label htmlFor="webhook">Webhook URL</Label>
              <Input
                id="webhook"
                placeholder="https://discord.com/api/webhooks/..."
                value={webhookInput}
                onChange={(e) => setWebhookInput(e.target.value)}
              />
            </div>

            {webhookInput.length > 0 && (
              <div className="flex items-center justify-between space-x-2 border p-3 rounded-lg bg-slate-50">
                <div className="flex flex-col space-y-0.5">
                  <Label
                    htmlFor="active-mode"
                    className="font-medium cursor-pointer text-sm"
                  >
                    Enable Notifications
                  </Label>
                  <span className="text-[12px] text-muted-foreground">
                    Pause notifications without deleting the URL.
                  </span>
                </div>
                <Switch
                  id="active-mode"
                  checked={isWebhookActive}
                  onCheckedChange={async (checked) => {
                    setIsWebhookActive(checked);
                    if (selectedMonitor) {
                      toast.promise(
                        toggleWebhookStatus(selectedMonitor.id, !checked),
                        {
                          success: checked
                            ? "Webhook activated"
                            : "Webhook deactivated",
                          error: "Failed to toggle",
                        }
                      );
                    }
                  }}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsWebhookOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveWebhook}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
