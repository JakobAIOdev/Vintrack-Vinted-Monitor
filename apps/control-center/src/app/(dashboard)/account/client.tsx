"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  LinkIcon,
  Unlink,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Heart,
  MessageSquare,
  ShoppingCart,
  Bot,
} from "lucide-react";
import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";
import {
  linkVintedAccount,
  unlinkVintedAccount,
  getAccountStatus,
  refreshVintedSession,
} from "@/actions/account";
import { toast } from "sonner";

export interface AccountStatus {
  linked: boolean;
  status?: string;
  vinted_name?: string;
  vinted_id?: number;
  domain?: string;
  linked_at?: string;
  last_check?: string;
}

export function AccountClient({
  initialStatus,
}: {
  initialStatus: AccountStatus;
}) {
  const [status, setStatus] = useState<AccountStatus>(initialStatus);
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("de");
  const [isPending, startTransition] = useTransition();

  const selectedDomain =
    REGIONS.find((r) => r.code === selectedRegion)?.domain || "vinted.de";

  const handleLink = () => {
    if (!accessToken.trim()) {
      toast.error("Access token is required");
      return;
    }

    startTransition(async () => {
      const result = await linkVintedAccount(
        accessToken.trim(),
        `www.${selectedDomain}`,
        refreshToken.trim() || undefined
      );
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setAccessToken("");
      setRefreshToken("");
      setStatus({
        linked: true,
        status: "active",
        vinted_name: result.vinted_name,
        vinted_id: result.vinted_id,
        domain: result.domain,
        linked_at: new Date().toISOString(),
        last_check: new Date().toISOString(),
      });
      toast.success(`Linked to @${result.vinted_name}`);
    });
  };

  const handleUnlink = () => {
    if (!confirm("Unlink your Vinted account?")) return;

    startTransition(async () => {
      const result = await unlinkVintedAccount();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setStatus({ linked: false });
      toast.success("Account unlinked");
    });
  };

  const handleRefresh = () => {
    startTransition(async () => {
      const result = await refreshVintedSession();
      if (result.error) {
        toast.error("Token refresh failed: " + result.error);
        // Still update status to show current state
        const updated = await getAccountStatus();
        setStatus(updated);
        return;
      }
      toast.success("Token refreshed successfully");
      const updated = await getAccountStatus();
      setStatus(updated);
    });
  };

  return (
    <div className="space-y-6 mx-auto max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Vinted Account</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Link your Vinted account to like items and more, directly from the
          dashboard.
        </p>
      </div>

      {status.linked ? (
        <Card className="border-emerald-200 bg-emerald-50/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">
                    @{status.vinted_name}
                  </CardTitle>
                  <CardDescription>Linked to {status.domain}</CardDescription>
                </div>
              </div>
              <Badge
                variant={
                  status.status === "active" ? "default" : "destructive"
                }
              >
                {status.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Vinted ID</span>
                <p className="font-medium">{status.vinted_id}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Linked</span>
                <p className="font-medium">
                  {status.linked_at
                    ? new Date(status.linked_at).toLocaleDateString()
                    : "—"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Check</span>
                <p className="font-medium">
                  {status.last_check
                    ? new Date(status.last_check).toLocaleString()
                    : "—"}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isPending}
                className="gap-1.5"
              >
                <RefreshCw
                  className={cn("w-3.5 h-3.5", isPending && "animate-spin")}
                />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnlink}
                disabled={isPending}
                className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
              >
                <Unlink className="w-3.5 h-3.5" />
                Unlink Account
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5" />
              Link Vinted Account
            </CardTitle>
            <CardDescription>
              Connect your Vinted account to enable likes and more directly
              from your monitor feed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-800">
                To get your tokens: Open Vinted in your browser → DevTools
                (F12) → Application → Cookies → copy the{" "}
                <code className="bg-amber-100 px-1 rounded text-xs">
                  access_token_web
                </code>{" "}
                and{" "}
                <code className="bg-amber-100 px-1 rounded text-xs">
                  refresh_token_web
                </code>{" "}
                values.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Region</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {REGIONS.slice(0, 12).map((region) => {
                  const isSelected = selectedRegion === region.code;
                  return (
                    <button
                      key={region.code}
                      type="button"
                      onClick={() => setSelectedRegion(region.code)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                        isSelected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                      )}
                    >
                      <span className="text-sm">{region.flag}</span>
                      <span className="truncate">{region.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="access-token">Access Token</Label>
              <Input
                id="access-token"
                type="password"
                placeholder="Paste your access_token_web..."
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="refresh-token">Refresh Token</Label>
              <Input
                id="refresh-token"
                type="password"
                placeholder="Paste your refresh_token_web (recommended)..."
                value={refreshToken}
                onChange={(e) => setRefreshToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Providing the refresh token allows automatic token renewal so your session stays active.
              </p>
            </div>

            <Button
              onClick={handleLink}
              disabled={!accessToken.trim() || isPending}
              className="gap-2"
            >
              {isPending ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <LinkIcon className="w-4 h-4" />
              )}
              Link Account
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            What can you do with a linked account?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                <Heart className="w-4 h-4 text-red-500" />
              </div>
              <div>
                <span className="font-medium text-slate-800">Like items</span>
                <span className="text-muted-foreground ml-1">
                  — directly from the feed
                </span>
              </div>
              <Badge variant="outline" className="ml-auto text-[10px]">
                Available
              </Badge>
            </li>
            <li className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <MessageSquare className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <span className="font-medium text-slate-800">
                  Send offers
                </span>
                <span className="text-muted-foreground ml-1">
                  — price offers to sellers
                </span>
              </div>
              <Badge
                variant="secondary"
                className="ml-auto text-[10px] bg-amber-100 text-amber-700"
              >
                Coming Soon
              </Badge>
            </li>

            <li className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
                <ShoppingCart className="w-4 h-4 text-emerald-500" />
              </div>
              <div>
                <span className="font-medium text-slate-800">
                  One-click buy
                </span>
                <span className="text-muted-foreground ml-1">
                  — from monitor feed
                </span>
              </div>
              <Badge
                variant="secondary"
                className="ml-auto text-[10px] bg-amber-100 text-amber-700"
              >
                Coming Soon
              </Badge>
            </li>
            <li className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-purple-500" />
              </div>
              <div>
                <span className="font-medium text-slate-800">Auto-buy</span>
                <span className="text-muted-foreground ml-1">
                  — rules with price thresholds
                </span>
              </div>
              <Badge
                variant="secondary"
                className="ml-auto text-[10px] bg-amber-100 text-amber-700"
              >
                Coming Soon
              </Badge>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
