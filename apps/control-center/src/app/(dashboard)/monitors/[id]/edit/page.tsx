"use client";

import { updateMonitor } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryPicker } from "@/components/monitors/category-picker";
import { BrandPicker } from "@/components/monitors/brand-picker";
import { SizePicker } from "@/components/monitors/size-picker";
import { RegionPicker } from "@/components/monitors/region-picker";
import { ColorPicker } from "@/components/monitors/color-picker";
import { ArrowLeft, Save, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

type ProxyGroupOption = {
  id: number;
  name: string;
  proxyCount: number;
};

type MonitorData = {
  id: number;
  query: string;
  price_min: number | null;
  price_max: number | null;
  size_id: string | null;
  catalog_ids: string | null;
  brand_ids: string | null;
  color_ids: string | null;
  region: string;
  discord_webhook: string | null;
  proxy_group_id: number | null;
};

export default function EditMonitorPage() {
  const params = useParams();
  const monitorId = Number(params.id);

  const [monitor, setMonitor] = useState<MonitorData | null>(null);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string>("de");
  const [proxyGroups, setProxyGroups] = useState<ProxyGroupOption[]>([]);
  const [userRole, setUserRole] = useState<string>("free");
  const [selectedProxyGroup, setSelectedProxyGroup] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/monitors/${monitorId}`).then((r) => r.json()),
      fetch("/api/proxy-groups").then((r) => r.json()),
    ])
      .then(([monitorData, proxyData]) => {
        const m = monitorData.monitor;
        if (m) {
          setMonitor(m);
          setSelectedSizes(m.size_id ? m.size_id.split(",").filter(Boolean) : []);
          setSelectedCategories(m.catalog_ids ? m.catalog_ids.split(",").filter(Boolean) : []);
          setSelectedBrands(m.brand_ids ? m.brand_ids.split(",").filter(Boolean) : []);
          setSelectedColors(m.color_ids ? m.color_ids.split(",").filter(Boolean) : []);
          setSelectedRegion(m.region || "de");
          setSelectedProxyGroup(
            m.proxy_group_id ? m.proxy_group_id.toString() : "server"
          );
        }
        setProxyGroups(proxyData.groups || []);
        setUserRole(proxyData.role || "free");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [monitorId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!monitor) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        Monitor not found.
      </div>
    );
  }

  const boundUpdate = updateMonitor.bind(null, monitorId);

  return (
    <div className="space-y-6 mx-auto max-w-4xl">
      <div className="flex items-center gap-3">
        <Link href={`/monitors/${monitorId}`}>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Edit Monitor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Update settings for &quot;{monitor.query}&quot;.
          </p>
        </div>
      </div>

      <Card className="border-slate-200/60">
        <CardContent className="p-6">
          <form action={boundUpdate} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="query" className="text-[13px]">
                Search Query
              </Label>
              <Input
                name="query"
                id="query"
                placeholder="e.g. Nike Dunk Low Grey"
                defaultValue={monitor.query}
                required
              />
              <p className="text-[12px] text-muted-foreground">
                This text will be searched on Vinted exactly as entered.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">Country / Region</Label>
              <RegionPicker
                selected={selectedRegion}
                onChange={setSelectedRegion}
              />
              <input type="hidden" name="region" value={selectedRegion} />
              <p className="text-[12px] text-muted-foreground">
                Select which Vinted country to monitor.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">
                Category Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <CategoryPicker
                selected={selectedCategories}
                onChange={setSelectedCategories}
              />
              <input
                type="hidden"
                name="catalog_ids"
                value={selectedCategories.join(",")}
              />
              <p className="text-[12px] text-muted-foreground">
                Limit results to specific Vinted categories.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="price_min" className="text-[13px]">
                  Min Price
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    €
                  </span>
                  <Input
                    type="number"
                    name="price_min"
                    placeholder="0"
                    defaultValue={monitor.price_min ?? ""}
                    className="pl-7"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="price_max" className="text-[13px]">
                  Max Price
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    €
                  </span>
                  <Input
                    type="number"
                    name="price_max"
                    placeholder="Any"
                    defaultValue={monitor.price_max ?? ""}
                    className="pl-7"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">
                Brand Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <BrandPicker
                selected={selectedBrands}
                onChange={setSelectedBrands}
              />
              <input
                type="hidden"
                name="brand_ids"
                value={selectedBrands.join(",")}
              />
              <p className="text-[12px] text-muted-foreground">
                Limit results to specific brands.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">
                Color Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <ColorPicker
                selected={selectedColors}
                onChange={setSelectedColors}
              />
              <input
                type="hidden"
                name="color_ids"
                value={selectedColors.join(",")}
              />
              <p className="text-[12px] text-muted-foreground">
                Limit results to specific colors.
              </p>
            </div>

            <div className="space-y-2.5">
              <Label className="text-[13px]">
                Size Filter{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <SizePicker
                selected={selectedSizes}
                onChange={setSelectedSizes}
              />
              <input
                type="hidden"
                name="size_id"
                value={selectedSizes.join(",")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="discord_webhook" className="text-[13px]">
                Discord Webhook{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                name="discord_webhook"
                id="discord_webhook"
                placeholder="https://discord.com/api/webhooks/..."
                defaultValue={monitor.discord_webhook ?? ""}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">Proxy Group</Label>
              {loading ? (
                <div className="h-10 bg-slate-50 rounded-md animate-pulse" />
              ) : (
                <>
                  <select
                    name="proxy_group_id"
                    value={selectedProxyGroup}
                    onChange={(e) => setSelectedProxyGroup(e.target.value)}
                    className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1"
                    required={userRole === "free"}
                  >
                    {(userRole === "premium" || userRole === "admin") && (
                      <option value="server">⚡ Server Proxies (Premium)</option>
                    )}
                    {proxyGroups.length === 0 && userRole === "free" && (
                      <option value="" disabled>
                        No proxy groups — create one first
                      </option>
                    )}
                    {proxyGroups.map((g) => (
                      <option key={g.id} value={g.id.toString()}>
                        {g.name} ({g.proxyCount} proxies)
                      </option>
                    ))}
                  </select>
                  {userRole === "free" && proxyGroups.length === 0 && (
                    <p className="text-[12px] text-amber-600">
                      You need to{" "}
                      <Link href="/proxies" className="underline font-medium">
                        create a proxy group
                      </Link>{" "}
                      before using a monitor.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="pt-2">
              <Button type="submit" className="w-full gap-1.5">
                <Save className="w-4 h-4" /> Save Changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
