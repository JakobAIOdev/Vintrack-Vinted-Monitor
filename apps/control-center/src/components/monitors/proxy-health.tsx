"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle } from "lucide-react";

type MonitorHealth = {
  monitor_id: number;
  total_checks: number;
  total_errors: number;
  consecutive_errors: number;
  last_error?: string;
  updated_at: string;
};

export function ProxyHealthCard({ monitorId }: { monitorId: number }) {
  const [health, setHealth] = useState<MonitorHealth | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/monitors/health");
      if (res.ok) {
        const data = await res.json();
        setHealth(data[monitorId] || null);
      }
    } catch {}
  }, [monitorId]);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (!health) return null;

  const hasWarning =
    health.consecutive_errors === -1 || health.consecutive_errors >= 3;

  if (!hasWarning) return null;

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-red-700" />
        <p className="text-[13px] font-semibold text-red-800">
          Proxy Warning
        </p>
      </div>
      <p className="text-[12px] text-red-700">
        Your proxies are producing errors. If this continues, the monitor will
        be stopped automatically. Check your proxy group settings.
      </p>
    </div>
  );
}
